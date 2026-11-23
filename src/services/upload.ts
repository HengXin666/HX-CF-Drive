/** 分片上传: init → putChunk × N → complete。WebDAV PUT 与表单上传也复用这里 */
import type { Env, Principal } from '../env';
import { num } from '../env';
import { r2Abort, r2Complete, r2CreateMultipart, r2PutPart, r2PutWhole } from '../drivers/r2';
import {
  activeChannels, botById, markBot, pickChannel, sendChunk, TgFatal, TgRateLimit, usableBots,
} from '../drivers/tg';
import { chooseDriver, type Driver } from '../lib/route';
import { assertAccess, childByName, getNode, type NodeRow, trashNode } from '../lib/tree';
import { guessMime, HttpError, newId, now, validName } from '../lib/util';

export interface InitInput {
  parentId: string;
  name: string;
  size: number;
  mime?: string;
  sha256?: string;
  backend?: string;
  overwrite?: boolean;
}

export interface SessionRow {
  id: string; parent_id: string; name: string; size: number; mime: string | null; sha256: string | null;
  blob_id: string; driver: Driver; chunk_size: number; chunk_count: number; r2_upload_id: string | null;
  received: number; overwrite: number; created_by: string | null; expires_at: number;
}

export type InitResult =
  | { done: true; node: NodeRow }
  | { done: false; uploadId: string; driver: Driver; chunkSize: number; chunkCount: number };

export async function initUpload(env: Env, p: Principal, inp: InitInput): Promise<InitResult> {
  if (!validName(inp.name)) throw new HttpError(400, 'invalid name');
  if (!Number.isInteger(inp.size) || inp.size < 0) throw new HttpError(400, 'invalid size');
  const parent = await getNode(env, inp.parentId);
  if (!parent || parent.kind !== 'dir') throw new HttpError(404, 'parent not found');
  await assertAccess(env, p, parent.id);
  const existing = await childByName(env, parent.id, inp.name);
  if (existing && (existing.kind === 'dir' || !inp.overwrite)) throw new HttpError(409, 'target exists');

  const mime = inp.mime || guessMime(inp.name);
  const sha = inp.sha256 && /^[0-9a-f]{64}$/i.test(inp.sha256) ? inp.sha256.toLowerCase(): null;

  // 秒传: 同哈希同大小的 blob 已存在就直接引用
  if (sha) {
    const blob = await env.DB.prepare("SELECT id FROM blobs WHERE sha256 = ? AND size = ? AND status = 'ready'")
      .bind(sha, inp.size)
      .first<{ id: string }>();
    if (blob) {
      const node = await commitNode(env, p, parent.id, inp.name, inp.size, mime, blob.id, existing, true);
      return { done: true, node };
    }
  }

  const bots = await usableBots(env);
  const channels = await activeChannels(env);
  const driver = chooseDriver(mime, inp.size, {
    videoTo: env.ROUTE_VIDEO_TO === 'tg' ? 'tg' : 'r2',
    r2MinBytes: num(env.ROUTE_R2_MIN_BYTES, 200 * 1024 * 1024),
    hasBots: bots.length > 0 && channels.length > 0,
  }, inp.size === 0 ? 'r2' : inp.backend);
  const chunkSize = num(env.CHUNK_SIZE, 16 * 1024 * 1024);
  if (driver === 'tg' && chunkSize > 19 * 1024 * 1024) throw new HttpError(500, 'CHUNK_SIZE too large for Telegram getFile (20MB)');
  const chunkCount = Math.max(1, Math.ceil(inp.size / chunkSize));
  const blobId = newId(20);
  const channelId = driver === 'tg' ? pickChannel(channels, blobId): null;
  const uploadId = driver === 'r2' && chunkCount > 1 ? await r2CreateMultipart(env, blobId, mime): null;
  const sessionId = newId(24);
  const t = now();

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO blobs (id, driver, size, sha256, chunk_size, chunk_count, r2_key, channel_id, ref_count, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'uploading', ?)`,
).bind(blobId, driver, inp.size, sha, chunkSize, chunkCount, driver === 'r2' ? `b/${blobId}` : null, channelId, t),
    env.DB.prepare(
      `INSERT INTO upload_sessions (id, parent_id, name, size, mime, sha256, blob_id, driver, chunk_size, chunk_count,
         r2_upload_id, overwrite, created_by, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
).bind(sessionId, parent.id, inp.name, inp.size, mime, sha, blobId, driver, chunkSize, chunkCount, uploadId,
      inp.overwrite ? 1 : 0, p.id, t + 24 * 3600_000),
  ]);
  return { done: false, uploadId: sessionId, driver, chunkSize, chunkCount };
}

export async function getSession(env: Env, id: string): Promise<SessionRow> {
  const s = await env.DB.prepare('SELECT * FROM upload_sessions WHERE id = ?').bind(id).first<SessionRow>();
  if (!s || s.expires_at < now()) throw new HttpError(404, 'upload session not found or expired');
  return s;
}

export function expectedChunkSize(s: SessionRow, idx: number): number {
  if (idx < s.chunk_count - 1) return s.chunk_size;
  return s.size - s.chunk_size * (s.chunk_count - 1);
}

export async function receivedIndexes(env: Env, blobId: string): Promise<number[]> {
  const r = await env.DB.prepare('SELECT idx FROM chunks WHERE blob_id = ? ORDER BY idx').bind(blobId).all<{ idx: number }>();
  return r.results.map((x) => x.idx);
}

/**
 * 上传一个分片。幂等: 已收到的分片直接返回。
 * @param maxWaitMs 限速时最多等待多久, 超过抛 429 (带 Retry-After)
 */
export async function putChunk(env: Env, s: SessionRow, idx: number, body: ArrayBuffer, maxWaitMs = 20_000): Promise<void> {
  if (!Number.isInteger(idx) || idx < 0 || idx >= s.chunk_count) throw new HttpError(400, 'chunk index out of range');
  const want = expectedChunkSize(s, idx);
  if (body.byteLength !== want) throw new HttpError(400, `chunk ${idx} must be ${want} bytes, got ${body.byteLength}`);
  const dup = await env.DB.prepare('SELECT 1 AS x FROM chunks WHERE blob_id = ? AND idx = ?').bind(s.blob_id, idx).first();
  if (dup) return;

  if (s.driver === 'r2') {
    if (s.chunk_count === 1) {
      await r2PutWhole(env, s.blob_id, body, s.mime ?? 'application/octet-stream');
      await insertChunk(env, s.blob_id, idx, want, 'r2', 1, 'r2', 'whole');
    } else {
      const etag = await r2PutPart(env, s.blob_id, s.r2_upload_id!, idx, body);
      await insertChunk(env, s.blob_id, idx, want, 'r2', idx + 1, 'r2', etag);
    }
    return;
  }

  const blob = await env.DB.prepare('SELECT channel_id FROM blobs WHERE id = ?').bind(s.blob_id).first<{ channel_id: string }>();
  if (!blob) throw new HttpError(404, 'blob missing');
  const limiter = env.LIMITER.get(env.LIMITER.idFromName('global'));
  const rate = num(env.CHANNEL_RATE_PER_MIN, 15);

  for (let attempt = 0; attempt < 3; attempt++) {
    const bots = await usableBots(env);
    if (bots.length === 0) throw new HttpError(503, 'no usable bot', { 'Retry-After': '60' });
    const slot = await limiter.acquire(blob.channel_id, bots.map((b) => b.id), rate, maxWaitMs);
    if (!slot.ok) {
      throw new HttpError(429, 'rate limited, retry later', { 'Retry-After': String(Math.ceil(slot.waitMs / 1000)) });
    }
    if (slot.waitMs > 0) await new Promise((r) => setTimeout(r, slot.waitMs));
    const bot = (await botById(env, slot.botId!))!;
    try {
      const { messageId, fileId } = await sendChunk(bot, blob.channel_id, body, `${s.blob_id}.${String(idx).padStart(5, '0')}.bin`);
      await insertChunk(env, s.blob_id, idx, want, blob.channel_id, messageId, bot.id, fileId);
      await env.DB.prepare('UPDATE channels SET msg_count = msg_count + 1 WHERE id = ?').bind(blob.channel_id).run();
      return;
    } catch (e) {
      if (e instanceof TgRateLimit) {
        // 严格服从 retry_after, 再多加 20% 余量
        const ms = Math.ceil(e.retryAfterSec * 1200);
        await limiter.penalize(bot.id, ms);
        await markBot(env, bot.id, 'cooldown', now() + ms, e.message);
        continue;
      }
      if (e instanceof TgFatal) {
        await limiter.penalize(bot.id, 24 * 3600_000);
        await markBot(env, bot.id, 'dead', 0, e.message);
        continue;
      }
      await limiter.penalize(bot.id, 60_000);
      throw new HttpError(502, `telegram upload failed: ${(e as Error).message}`);
    }
  }
  throw new HttpError(429, 'all bots rate limited, retry later', { 'Retry-After': '30' });
}

async function insertChunk(env: Env, blobId: string, idx: number, size: number, channelId: string, messageId: number, botId: string, fileId: string) {
  await env.DB.prepare(
    'INSERT OR IGNORE INTO chunks (blob_id, idx, size, channel_id, message_id, bot_id, file_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
).bind(blobId, idx, size, channelId, messageId, botId, fileId).run();
}

export async function completeUpload(env: Env, p: Principal, s: SessionRow): Promise<NodeRow> {
  const got = await receivedIndexes(env, s.blob_id);
  if (got.length !== s.chunk_count) {
    const have = new Set(got);
    const missing = [];
    for (let i = 0; i < s.chunk_count && missing.length < 50; i++) if (!have.has(i)) missing.push(i);
    throw new HttpError(400, `missing chunks: ${missing.join(',')}`);
  }
  if (s.driver === 'r2' && s.chunk_count > 1) {
    const parts = await env.DB.prepare('SELECT message_id AS partNumber, file_id AS etag FROM chunks WHERE blob_id = ?')
      .bind(s.blob_id)
      .all<{ partNumber: number; etag: string }>();
    await r2Complete(env, s.blob_id, s.r2_upload_id!, parts.results);
  }
  try {
    await env.DB.prepare("UPDATE blobs SET status = 'ready' WHERE id = ?").bind(s.blob_id).run();
  } catch {
    // 并发上传同一哈希撞了唯一索引: 放弃哈希, 照样可用
    await env.DB.prepare("UPDATE blobs SET status = 'ready', sha256 = NULL WHERE id = ?").bind(s.blob_id).run();
  }
  const existing = await childByName(env, s.parent_id, s.name);
  if (existing && (existing.kind === 'dir' || !s.overwrite)) throw new HttpError(409, 'target exists');
  const node = await commitNode(env, p, s.parent_id, s.name, s.size, s.mime ?? 'application/octet-stream', s.blob_id, existing, false);
  await env.DB.prepare('DELETE FROM upload_sessions WHERE id = ?').bind(s.id).run();
  return node;
}

async function commitNode(
  env: Env, p: Principal, parentId: string, name: string, size: number, mime: string, blobId: string,
  existing: NodeRow | null, dedup: boolean,
): Promise<NodeRow> {
  if (existing) await trashNode(env, existing.id);
  const t = now();
  const id = newId();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO nodes (id, parent_id, name, kind, size, mime, blob_id, created_at, updated_at)
       VALUES (?, ?, ?, 'file', ?, ?, ?, ?, ?)`,
).bind(id, parentId, name, size, mime, blobId, t, t),
    env.DB.prepare('UPDATE blobs SET ref_count = ref_count + 1 WHERE id = ?').bind(blobId),
    env.DB.prepare('INSERT INTO audit_log (actor, action, node_id, detail, at) VALUES (?, ?, ?, ?, ?)')
      .bind(p.id, dedup ? 'upload.dedup' : 'upload', id, name, t),
  ]);
  return { id, parent_id: parentId, name, kind: 'file', size, mime, blob_id: blobId, created_at: t, updated_at: t, deleted_at: null };
}

export async function abortUpload(env: Env, s: SessionRow): Promise<void> {
  if (s.driver === 'r2' && s.r2_upload_id) await r2Abort(env, s.blob_id, s.r2_upload_id);
  // TG 上已经发出去的分片交给定时任务删除
  await env.DB.batch([
    env.DB.prepare("UPDATE blobs SET status = 'purging' WHERE id = ? AND ref_count = 0").bind(s.blob_id),
    env.DB.prepare('DELETE FROM upload_sessions WHERE id = ?').bind(s.id),
  ]);
}

/** 把一个流按分片大小切开, 依次上传。用于 WebDAV PUT 和原始 body 上传 */
export async function uploadStream(env: Env, p: Principal, inp: InitInput, stream: ReadableStream<Uint8Array>): Promise<NodeRow> {
  const init = await initUpload(env, p, inp);
  if (init.done) {
    await stream.cancel().catch(() => {});
    return init.node;
  }
  const s = await getSession(env, init.uploadId);
  let idx = 0;
  try {
    for await (const piece of chunked(stream, s.chunk_size)) {
      // 服务端顺序上传, 允许等待更久 (墙钟时间不计 CPU)
      await putChunk(env, s, idx++, piece, 60_000);
    }
    if (inp.size === 0) await putChunk(env, s, 0, new ArrayBuffer(0));
    return await completeUpload(env, p, s);
  } catch (e) {
    await abortUpload(env, s).catch(() => {});
    throw e;
  }
}

/** 流切片: 每次产出恰好 size 字节 (最后一块可能更小)  */
export async function* chunked(stream: ReadableStream<Uint8Array>, size: number): AsyncGenerator<ArrayBuffer> {
  const reader = stream.getReader();
  let buf = new Uint8Array(size);
  let fill = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    let off = 0;
    while (off < value.length) {
      const n = Math.min(size - fill, value.length - off);
      buf.set(value.subarray(off, off + n), fill);
      fill += n;
      off += n;
      if (fill === size) {
        yield buf.buffer;
        buf = new Uint8Array(size);
        fill = 0;
      }
    }
  }
  if (fill > 0) yield buf.slice(0, fill).buffer;
}
