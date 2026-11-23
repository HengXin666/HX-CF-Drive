/**
 * Telegram Bot API 驱动
 * - 上传: sendDocument (≤50MB), 我们固定 16MB 分片
 * - 下载: getFile (≤20MB) 拿 file_path, 再从 /file/bot<token>/<path> 拉取
 * - file_id 只对上传它的 Bot 有效; Bot 失效时用 forwardMessage 让别的 Bot 重新拿 file_id
 */
import type { Env } from '../env';
import { HttpError, now } from '../lib/util';

let API = 'https://api.telegram.org';

/** 测试或自建 Bot API Server 时可以覆盖 (环境变量 TG_API_BASE)  */
export function setTgApiBase(base?: string) {
  if (base) API = base.replace(/\/$/, '');
}

export class TgRateLimit extends Error {
  constructor(public retryAfterSec: number, msg: string) { super(msg); }
}
export class TgFatal extends Error {}

export interface BotRow {
  id: string;
  token: string;
  username: string | null;
  status: 'active' | 'cooldown' | 'dead';
  fail_count: number;
  retry_until: number;
}

interface TgResp<T> { ok: boolean; result?: T; description?: string; error_code?: number; parameters?: { retry_after?: number } }

export async function tgCall<T>(token: string, method: string, body?: Record<string, unknown> | FormData): Promise<T> {
  const init: RequestInit = { method: 'POST' };
  if (body instanceof FormData) init.body = body;
  else if (body) {
    init.body = JSON.stringify(body);
    init.headers = { 'Content-Type': 'application/json' };
  }
  const res = await fetch(`${API}/bot${token}/${method}`, init);
  let data: TgResp<T>;
  try {
    data = (await res.json()) as TgResp<T>;
  } catch {
    throw new Error(`telegram ${method} http ${res.status}`);
  }
  if (data.ok) return data.result as T;
  const code = data.error_code ?? res.status;
  if (code === 429) throw new TgRateLimit(data.parameters?.retry_after ?? 30, data.description ?? 'Too Many Requests');
  if (code === 401 || code === 403) throw new TgFatal(`${code} ${data.description}`);
  throw new Error(`telegram ${method} ${code} ${data.description}`);
}

// ---------- Bot 池 ----------

let botCache: { at: number; bots: BotRow[] } | null = null;

export function invalidateBotCache() { botCache = null; }

/** 所有 Bot (含冷却和失效的, 下载时也需要它们的 token)  */
export async function allBots(env: Env): Promise<BotRow[]> {
  if (botCache && now() - botCache.at < 60_000) return botCache.bots;
  const r = await env.DB.prepare('SELECT id, token, username, status, fail_count, retry_until FROM bots').all<BotRow>();
  botCache = { at: now(), bots: r.results };
  return r.results;
}

export async function usableBots(env: Env): Promise<BotRow[]> {
  const t = now();
  return (await allBots(env)).filter((b) => b.status === 'active' || (b.status === 'cooldown' && b.retry_until <= t));
}

export async function botById(env: Env, id: string): Promise<BotRow | undefined> {
  return (await allBots(env)).find((b) => b.id === id);
}

export async function markBot(env: Env, botId: string, status: 'active' | 'cooldown' | 'dead', retryUntil = 0, err?: string) {
  await env.DB.prepare(
    `UPDATE bots SET status = ?, retry_until = ?, last_error = COALESCE(?, last_error),
       fail_count = CASE WHEN ? = 'active' THEN 0 ELSE fail_count + 1 END WHERE id = ?`,
)
    .bind(status, retryUntil, err ?? null, status, botId)
    .run();
  invalidateBotCache();
}

/** 把 BOT_TOKENS 环境变量里的 Bot 写进 D1 (幂等)  */
export async function seedBotsFromEnv(env: Env): Promise<number> {
  const list = (env.BOT_TOKENS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  let added = 0;
  for (const token of list) {
    const id = token.split(':')[0];
    const r = await env.DB.prepare('INSERT OR IGNORE INTO bots (id, token, created_at) VALUES (?, ?, ?)').bind(id, token, now()).run();
    added += r.meta.changes ?? 0;
  }
  if (added) invalidateBotCache();
  return added;
}

// ---------- 频道 ----------

export async function activeChannels(env: Env): Promise<string[]> {
  const r = await env.DB.prepare("SELECT id FROM channels WHERE status = 'active' ORDER BY created_at").all<{ id: string }>();
  return r.results.map((x) => x.id);
}

/** 按 blobId 哈希选频道, 把写入均匀打散 */
export function pickChannel(channels: string[], blobId: string): string {
  let h = 0;
  for (let i = 0; i < blobId.length; i++) h = (h * 31 + blobId.charCodeAt(i)) >>> 0;
  return channels[h % channels.length];
}

// ---------- 上传 / 下载 ----------

interface TgMessage { message_id: number; document?: { file_id: string; file_size?: number } }

export async function sendChunk(bot: BotRow, channelId: string, data: ArrayBuffer | Blob, filename: string) {
  const form = new FormData();
  form.append('chat_id', channelId);
  form.append('disable_notification', 'true');
  // 用 document 发送, 禁止 Telegram 识别成媒体再压缩
  form.append('disable_content_type_detection', 'true');
  form.append('document', data instanceof Blob ? data : new Blob([data], { type: 'application/octet-stream' }), filename);
  const msg = await tgCall<TgMessage>(bot.token, 'sendDocument', form);
  if (!msg.document?.file_id) throw new Error('telegram returned no document');
  return { messageId: msg.message_id, fileId: msg.document.file_id };
}

/** getFile 结果缓存 50 分钟 (file_path 至少有效 1 小时)。用 Cache API, 不消耗 KV 额度 */
export async function filePath(bot: BotRow, fileId: string): Promise<string> {
  const cache = caches.default;
  const key = new Request(`https://tg-path.internal/${bot.id}/${encodeURIComponent(fileId)}`);
  const hit = await cache.match(key);
  if (hit) return hit.text();
  const f = await tgCall<{ file_path?: string }>(bot.token, 'getFile', { file_id: fileId });
  if (!f.file_path) throw new Error('telegram getFile returned no path');
  await cache.put(key, new Response(f.file_path, { headers: { 'Cache-Control': 'max-age=3000' } }));
  return f.file_path;
}

/** 拉取分片的 [from, to] 字节 (闭区间)。返回可读流 */
export async function fetchChunkRange(bot: BotRow, fileId: string, from: number, to: number, fullSize: number): Promise<ReadableStream<Uint8Array>> {
  const path = await filePath(bot, fileId);
  const whole = from === 0 && to === fullSize - 1;
  const res = await fetch(`${API}/file/bot${bot.token}/${path}`, whole ? {} : { headers: { Range: `bytes=${from}-${to}` } });
  if (!res.ok || !res.body) throw new HttpError(502, `telegram file fetch ${res.status}`);
  if (whole || res.status === 206) return res.body;
  // 服务端不支持 Range 时手动裁剪
  return res.body.pipeThrough(sliceStream(from, to - from + 1));
}

/** 跳过 skip 字节, 只输出 take 字节 */
export function sliceStream(skip: number, take: number): TransformStream<Uint8Array, Uint8Array> {
  let pos = 0;
  const end = skip + take;
  return new TransformStream({
    transform(chunk, ctl) {
      const s = Math.max(skip - pos, 0);
      const e = Math.min(end - pos, chunk.length);
      if (e > s) ctl.enqueue(chunk.subarray(s, e));
      pos += chunk.length;
      if (pos >= end) ctl.terminate();
    },
  });
}

export async function deleteMessage(bot: BotRow, channelId: string, messageId: number): Promise<void> {
  try {
    await tgCall(bot.token, 'deleteMessage', { chat_id: channelId, message_id: messageId });
  } catch (e) {
    // 消息已不存在也算成功
    if (!(e instanceof Error) || !/message to delete not found|MESSAGE_ID_INVALID/i.test(e.message)) throw e;
  }
}

/**
 * Bot 失效后, 用另一个 Bot 把原消息转发到同一频道, 拿到它自己的 file_id, 再删掉转发出来的消息。
 * 要求新 Bot 也是该频道管理员。
 */
export async function rebindFileId(newBot: BotRow, channelId: string, messageId: number): Promise<string> {
  const fwd = await tgCall<TgMessage>(newBot.token, 'forwardMessage', {
    chat_id: channelId, from_chat_id: channelId, message_id: messageId, disable_notification: true,
  });
  if (!fwd.document?.file_id) throw new Error('forwarded message has no document');
  await deleteMessage(newBot, channelId, fwd.message_id).catch(() => {});
  return fwd.document.file_id;
}
