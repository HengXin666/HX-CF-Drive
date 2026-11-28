/**
 * Telegram Bot API 驱动
 * - 上传: sendDocument, 请求体流式拼成 multipart, Worker 不缓冲, 不复制字节
 * - 下载: getFile (≤20MB) 拿 file_path, 再从 /file/bot<token>/<path> 拉取
 * - file_path 和 Bot 冷却状态都放在 isolate 内存里, 不消耗 KV/D1/Cache API
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
  status: 'active' | 'dead';
}

interface TgResp<T> { ok: boolean; result?: T; description?: string; error_code?: number; parameters?: { retry_after?: number } }

async function parseTg<T>(res: Response, method: string): Promise<T> {
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

export async function tgCall<T>(token: string, method: string, body?: Record<string, unknown>): Promise<T> {
  const init: RequestInit = { method: 'POST' };
  if (body) {
    init.body = JSON.stringify(body);
    init.headers = { 'Content-Type': 'application/json' };
  }
  return parseTg<T>(await fetch(`${API}/bot${token}/${method}`, init), method);
}

// ---------- Bot 池 ----------

let botCache: { at: number; bots: BotRow[] } | null = null;
/** botId -> 冷却到期时间。只在内存里, 不写 D1 */
const cooldown = new Map<string, number>();

export function invalidateBotCache() { botCache = null; }

/** 所有 Bot (含失效的, 下载时也可能需要)。isolate 内缓存 5 分钟 */
export async function allBots(env: Env): Promise<BotRow[]> {
  if (botCache && now() - botCache.at < 300_000) return botCache.bots;
  const r = await env.DB.prepare('SELECT id, token, username, status FROM bots').all<BotRow>();
  botCache = { at: now(), bots: r.results };
  return r.results;
}

export async function usableBots(env: Env): Promise<BotRow[]> {
  const t = now();
  return (await allBots(env)).filter((b) => b.status === 'active' && (cooldown.get(b.id) ?? 0) <= t);
}

export function coolDown(botId: string, ms: number) {
  cooldown.set(botId, now() + ms);
}

/** 按 key 稳定地选一个可用 Bot, 把发送均匀打散到多个 Bot */
export function pickBot(bots: BotRow[], key: string): BotRow {
  return bots[hash(key) % bots.length];
}

export async function markDead(env: Env, botId: string, err: string) {
  await env.DB.prepare("UPDATE bots SET status = 'dead', last_error = ? WHERE id = ?").bind(err.slice(0, 300), botId).run();
  invalidateBotCache();
}

/** 把 BOT_TOKENS 环境变量里的 Bot 写进 D1 (幂等, INSERT OR IGNORE 已存在时不算写行)  */
export async function seedBotsFromEnv(env: Env): Promise<number> {
  const list = (env.BOT_TOKENS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!list.length) return 0;
  const known = new Set((await allBots(env)).map((b) => b.id));
  let added = 0;
  for (const token of list) {
    const id = token.split(':')[0];
    if (known.has(id)) continue;
    await env.DB.prepare('INSERT OR IGNORE INTO bots (id, token, created_at) VALUES (?, ?, ?)').bind(id, token, now()).run();
    added++;
  }
  if (added) invalidateBotCache();
  await fillUsernames(env);
  return added;
}

/** 从环境变量导入的 Bot 只有 id, 补上用户名 (后台显示用)。每次最多补 10 个, 失败的下次再试 */
export async function fillUsernames(env: Env): Promise<number> {
  const missing = (await allBots(env)).filter((b) => !b.username && b.status === 'active').slice(0, 10);
  let n = 0;
  for (const b of missing) {
    try {
      const me = await tgCall<{ username: string }>(b.token, 'getMe');
      await env.DB.prepare('UPDATE bots SET username = ? WHERE id = ?').bind(me.username, b.id).run();
      n++;
    } catch { /* 下次维护再试 */ }
  }
  if (n) invalidateBotCache();
  return n;
}

// ---------- 频道 ----------

let chanCache: { at: number; ids: string[] } | null = null;

export function invalidateChannelCache() { chanCache = null; }

export async function activeChannels(env: Env): Promise<string[]> {
  if (chanCache && now() - chanCache.at < 300_000) return chanCache.ids;
  const r = await env.DB.prepare("SELECT id FROM channels WHERE status = 'active' ORDER BY created_at").all<{ id: string }>();
  chanCache = { at: now(), ids: r.results.map((x) => x.id) };
  return chanCache.ids;
}

export function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

/** 按 blobId 哈希选频道, 把写入均匀打散 */
export function pickChannel(channels: string[], blobId: string): string {
  return channels[hash(blobId) % channels.length];
}

// ---------- 上传 ----------

interface TgMessage { message_id: number; document?: { file_id: string; file_size?: number } }

/** 构造 multipart 的头尾。中间的文件内容由调用方以流的形式接上 */
export function multipartFrame(boundary: string, fields: Record<string, string>, filename: string) {
  let head = '';
  for (const [k, v] of Object.entries(fields)) {
    head += `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`;
  }
  head += `--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`;
  const enc = new TextEncoder();
  return { head: enc.encode(head), tail: enc.encode(`\r\n--${boundary}--\r\n`) };
}

/**
 * 流式发送一个分片。body 必须恰好 size 字节。
 * workerd 下用 FixedLengthStream: 字节由运行时原生搬运, 并自动带 Content-Length
 */
export async function sendChunkStream(bot: BotRow, channelId: string, body: ReadableStream<Uint8Array>, size: number, filename: string) {
  const boundary = `hxd${crypto.randomUUID().replace(/-/g, '')}`;
  const { head, tail } = multipartFrame(boundary, {
    chat_id: channelId,
    disable_notification: 'true',
    // 用 document 发送, 禁止 Telegram 识别成媒体再压缩
    disable_content_type_detection: 'true',
  }, filename);
  const total = head.length + size + tail.length;
  const FLS = (globalThis as { FixedLengthStream?: new (n: number) => TransformStream<Uint8Array, Uint8Array> }).FixedLengthStream;
  const { readable, writable } = FLS ? new FLS(total) : new TransformStream<Uint8Array, Uint8Array>();
  const pump = (async () => {
    const w = writable.getWriter();
    await w.write(head);
    w.releaseLock();
    await body.pipeTo(writable, { preventClose: true });
    const w2 = writable.getWriter();
    await w2.write(tail);
    await w2.close();
  })();
  const sending = fetch(`${API}/bot${bot.token}/sendDocument`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, ...(FLS ? {} : { 'Content-Length': String(total) }) },
    body: readable,
    // node 测试环境需要 duplex
    ...({ duplex: 'half' } as object),
  });
  const [res] = await Promise.all([sending, pump]);
  const msg = await parseTg<TgMessage>(res, 'sendDocument');
  if (!msg.document?.file_id) throw new Error('telegram returned no document');
  return { messageId: msg.message_id, fileId: msg.document.file_id };
}

// ---------- 下载 ----------

/** file_path 内存缓存 (官方保证至少 1 小时有效, 这里用 50 分钟)  */
const pathCache = new Map<string, { path: string; at: number }>();
const PATH_TTL = 50 * 60_000;

export function cachedPath(botId: string, fileId: string): string | null {
  const hit = pathCache.get(`${botId}:${fileId}`);
  return hit && now() - hit.at < PATH_TTL ? hit.path : null;
}

export async function filePath(bot: BotRow, fileId: string): Promise<string> {
  const hit = cachedPath(bot.id, fileId);
  if (hit) return hit;
  const f = await tgCall<{ file_path?: string }>(bot.token, 'getFile', { file_id: fileId });
  if (!f.file_path) throw new Error('telegram getFile returned no path');
  if (pathCache.size > 20_000) pathCache.clear();
  pathCache.set(`${bot.id}:${fileId}`, { path: f.file_path, at: now() });
  return f.file_path;
}

/** 拉取分片的 [from, to] 字节 (闭区间)。返回可读流 */
export async function fetchChunkRange(bot: BotRow, fileId: string, from: number, to: number, fullSize: number): Promise<ReadableStream<Uint8Array>> {
  const path = await filePath(bot, fileId);
  const whole = from === 0 && to === fullSize - 1;
  const res = await fetch(`${API}/file/bot${bot.token}/${path}`, whole ? {} : { headers: { Range: `bytes=${from}-${to}` } });
  if (res.status === 401 || res.status === 403) throw new TgFatal(`file fetch ${res.status}`);
  if (!res.ok || !res.body) {
    console.error('telegram file fetch', res.status);
    throw new HttpError(502, 'telegram file fetch failed');
  }
  if (whole || res.status === 206) return res.body;
  // 服务端不支持 Range 时手动裁剪
  return res.body.pipeThrough(sliceStream(from, to - from + 1));
}

/** 跳过 skip 字节, 只输出 take 字节。只切视图, 不复制 */
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

/** deleteMessages 单次上限 */
export const DELETE_BATCH = 100;

/**
 * 批量删除消息 (一次最多 100 条, 1 个子请求)。不存在的消息 TG 会跳过。
 * 限流和 401 (令牌失效) 原样抛出; 其他失败 (超过 48 小时不能删, 无删除权限等) 返回 false, 由调用方当作已处理。
 */
export async function deleteMessages(bot: BotRow, channelId: string, ids: number[]): Promise<boolean> {
  if (!ids.length) return true;
  try {
    await tgCall(bot.token, 'deleteMessages', { chat_id: channelId, message_ids: ids });
    return true;
  } catch (e) {
    if (e instanceof TgRateLimit || (e instanceof TgFatal && e.message.startsWith('401'))) throw e;
    return false;
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
