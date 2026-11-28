/**
 * 无状态分片上传: init → chunk × N → commit
 * - init: 校验 + 秒传判断, 返回签名的上传凭证。D1 只读不写
 * - chunk: 请求体流式转发给 TG, 返回签名的分片回执。D1 零读写
 * - fold (可选, 大文件): 每凑满一组 PART_SIZE 片, 把回执换成一个签名的聚合回执, 分摊 commit 的验签 CPU
 * - commit: 验签回执和聚合回执, 一次批量写入 blob + node (约 4 行, 含索引); 超过 PART_SIZE 片时清单拆进 blob_parts
 * 上传进度由客户端保存回执来记录, 断点续传只需重传缺的分片。
 */
import type { Env, Principal } from '../env';
import { chunkSizeOf } from '../env';
import {
  activeChannels, coolDown, markDead, pickBot, pickChannel, sendChunkStream, TgFatal, TgRateLimit, usableBots,
} from '../drivers/tg';
import { tokenAlive } from '../lib/auth';
import { openJson, sealJson } from '../lib/sign';
import { assertAccess, childByName, getNode, type NodeRow, trashNode } from '../lib/tree';
import { cleanMime, HttpError, newId, now, validName } from '../lib/util';

/** 分片清单中的一项 */
export interface ChunkRef { c: string; m: number; b: string; f: string; s: number }

/** 上传凭证 (签名后交给客户端)  */
export interface Ticket {
  u: string; p: string; n: string; z: number; t: string; h: string | null; o: 0 | 1;
  id: string; k: number; c: string; x: number;
}

interface Receipt extends ChunkRef { id: string; i: number }

/** 聚合回执: 第 g 组 (分片 [g*PART_SIZE, ...)) 的清单 JSON 文本, 验签后不用解析 */
interface Fold { id: string; g: number; r: string }

/** 分段大小: 一组/一段 256 片 (约 4.75 GiB), 每段清单约 36 KB */
export const PART_SIZE = 256;

export function partCountOf(chunkCount: number): number {
  return Math.ceil(chunkCount / PART_SIZE);
}

export interface InitInput {
  parentId: string;
  /** 调用方已解析并校验过权限的父目录, 传了就省两次查询 */
  parent?: NodeRow;
  name: string;
  size: number;
  mime?: string;
  sha256?: string;
  overwrite?: boolean;
}

export type InitResult =
  | { done: true; node: NodeRow }
  | { done: false; ticket: string; chunkSize: number; chunkCount: number };

const TICKET = 'up';
const RECEIPT = 'rc';
const FOLD = 'fd';

export function chunkCountOf(size: number, chunkSize: number): number {
  return Math.max(1, Math.ceil(size / chunkSize));
}

export function expectedChunkSize(size: number, chunkSize: number, idx: number): number {
  const n = chunkCountOf(size, chunkSize);
  return idx < n - 1 ? chunkSize : size - chunkSize * (n - 1);
}

export async function initUpload(env: Env, p: Principal, inp: InitInput): Promise<InitResult> {
  if (!validName(inp.name)) throw new HttpError(400, 'invalid name');
  if (!Number.isInteger(inp.size) || inp.size < 0) throw new HttpError(400, 'invalid size');
  const parent = inp.parent ?? (await getNode(env, inp.parentId));
  if (!parent || parent.kind !== 'dir') throw new HttpError(404, 'parent not found');
  if (!inp.parent) await assertAccess(env, p, parent.id);
  const existing = await childByName(env, parent.id, inp.name);
  if (existing && (existing.kind === 'dir' || !inp.overwrite)) throw new HttpError(409, 'target exists');

  const mime = cleanMime(inp.mime, inp.name);
  const sha = inp.sha256 && /^[0-9a-f]{64}$/i.test(inp.sha256) ? inp.sha256.toLowerCase(): null;

  // 秒传: 同哈希同大小的 blob 已存在就直接引用 (走唯一索引, 读 1 行)
  // 空文件: 所有空文件共用一个清单为空的 blob, 不发 TG
  if (inp.size === 0) {
    await env.DB.prepare("INSERT OR IGNORE INTO blobs (id, size, sha256, chunk_size, manifest, ref_count, created_at) VALUES ('empty', 0, NULL, 0, '[]', 0, ?)").bind(now()).run();
    return { done: true, node: await linkNode(env, parent.id, inp.name, 0, mime, 'empty', existing) };
  }

  // 秒传按上传者隔离 (哈希由客户端声明, 服务端不重算): 只认自己登记的 blob 和管理员登记的 blob,
  // 别的令牌声明一个假哈希最多污染它自己的空间, 见 #8 与 v0.3.1 评审
  if (sha) {
    const blob = await findDedup(env, p, sha, inp.size);
    if (blob) {
      const node = await linkNode(env, parent.id, inp.name, inp.size, mime, blob, existing);
      return { done: true, node };
    }
  }

  const channels = await activeChannels(env);
  if (!channels.length || !(await usableBots(env)).length) throw new HttpError(503, 'no usable bot or channel', { 'Retry-After': '60' });
  const chunkSize = chunkSizeOf(env);
  const blobId = newId(20);
  const t: Ticket = {
    u: p.id, p: parent.id, n: inp.name, z: inp.size, t: mime, h: sha, o: inp.overwrite ? 1 : 0,
    id: blobId, k: chunkSize, c: pickChannel(channels, blobId), x: Math.floor(now() / 1000) + 24 * 3600,
  };
  return { done: false, ticket: await sealJson(env.SIGNING_KEY, TICKET, t), chunkSize, chunkCount: chunkCountOf(inp.size, chunkSize) };
}

/**
 * 找可秒传的 blob。ref_count > 0: 引用归零的 blob 可能正在被清理, 不能再挂上。
 * 自己登记的直接用; 管理员登记的, 受限令牌还要求它在自己根目录下有引用 (否则等于知道哈希就能读别人的文件)。
 */
async function findDedup(env: Env, p: Principal, sha: string, size: number): Promise<string | null> {
  const rows = (await env.DB.prepare(
    "SELECT id, owner FROM blobs WHERE sha256 = ?1 AND size = ?2 AND ref_count > 0 AND owner IN (?3, 'admin')",
  ).bind(sha, size, p.id).all<{ id: string; owner: string }>()).results;
  const own = rows.find((r) => r.owner === p.id);
  if (own) return own.id;
  const adm = rows.find((r) => r.owner === 'admin');
  if (!adm) return null;
  if (p.rootId === 'root' || (await blobVisible(env, p.rootId, adm.id))) return adm.id;
  return null;
}

/** 秒传时可见子树的上限: 超过按不可见处理, 走正常上传 */
const VISIBLE_SCAN_LIMIT = 5000;

/**
 * blob 是否已被 rootId 子树内未删除的节点引用。
 * 向下递归只走未删除的子项 (命中 idx_nodes_parent_name 部分索引), 最多 VISIBLE_SCAN_LIMIT 行。
 */
export async function blobVisible(env: Env, rootId: string, blobId: string): Promise<boolean> {
  const r = await env.DB.prepare(
    `WITH RECURSIVE sub(id, blob_id) AS (
       SELECT id, blob_id FROM nodes WHERE id = ?1 AND deleted_at IS NULL
       UNION ALL
       SELECT n.id, n.blob_id FROM nodes n JOIN sub ON n.parent_id = sub.id WHERE n.deleted_at IS NULL
       LIMIT ${VISIBLE_SCAN_LIMIT}
     ) SELECT COUNT(*) AS total, SUM(blob_id = ?2) AS hit FROM sub`,
  ).bind(rootId, blobId).first<{ total: number; hit: number | null }>();
  if (!r || r.total >= VISIBLE_SCAN_LIMIT) return false;
  return (r.hit ?? 0) > 0;
}

export async function openTicket(env: Env, p: Principal, sealed: string): Promise<Ticket> {
  const t = await verifyTicket(env, sealed);
  if (t.u !== p.id) throw new HttpError(403, 'ticket belongs to another token');
  return t;
}

async function verifyTicket(env: Env, sealed: string): Promise<Ticket> {
  const t = await openJson<Ticket>(env.SIGNING_KEY, TICKET, sealed);
  if (!t || t.x < now() / 1000) throw new HttpError(400, 'bad or expired upload ticket');
  return t;
}

/**
 * 只凭票据传分片 (不带 Authorization): 票据本身是 HMAC 签过的 24 小时凭证, 只能往这一个上传里写字节,
 * 不能 commit (commit 仍要令牌)。签发它的令牌被吊销或过期后立即作废 (tokenAlive 60 秒缓存)。
 * 给手机这类不该持有 Drive 令牌的客户端直传用, 见 docs/INTEGRATION.md。
 */
export async function openTicketBare(env: Env, sealed: string): Promise<Ticket> {
  const t = await verifyTicket(env, sealed);
  if (!(await tokenAlive(env, t.u))) throw new HttpError(403, 'ticket token revoked');
  return t;
}

/**
 * 上传一个分片, 只尝试一次: 遇到 TG 限流直接回 429 + Retry-After, 由客户端重试 (下次会换 Bot)。
 * 不在 Worker 里等待或缓冲, 请求体流式直通 TG。
 */
export async function putChunk(env: Env, t: Ticket, idx: number, body: ReadableStream<Uint8Array>, len: number): Promise<string> {
  const count = chunkCountOf(t.z, t.k);
  if (!Number.isInteger(idx) || idx < 0 || idx >= count) throw new HttpError(400, 'chunk index out of range');
  const want = expectedChunkSize(t.z, t.k, idx);
  if (len !== want) throw new HttpError(400, `chunk ${idx} must be ${want} bytes, got ${len}`);
  const bots = await usableBots(env);
  if (!bots.length) throw new HttpError(429, 'all bots cooling down', { 'Retry-After': '30' });
  const bot = pickBot(bots, `${t.id}:${idx}`);
  try {
    const r = await sendChunkStream(bot, t.c, body, want, `${t.id}.${String(idx).padStart(5, '0')}.bin`);
    const rc: Receipt = { id: t.id, i: idx, c: t.c, m: r.messageId, b: bot.id, f: r.fileId, s: want };
    return sealJson(env.SIGNING_KEY, RECEIPT, rc);
  } catch (e) {
    if (e instanceof TgRateLimit) {
      coolDown(bot.id, Math.ceil(e.retryAfterSec * 1200));
      const others = bots.length > 1 ? 1 : e.retryAfterSec;
      throw new HttpError(429, 'telegram rate limited', { 'Retry-After': String(others) });
    }
    if (e instanceof TgFatal) {
      await markDead(env, bot.id, e.message);
      throw new HttpError(503, 'bot revoked, retry', { 'Retry-After': '1' });
    }
    coolDown(bot.id, 30_000);
    // 上游原始错误只记日志
    console.error('telegram upload failed', bot.id, e);
    throw new HttpError(502, 'telegram upload failed, retry', { 'Retry-After': '5' });
  }
}

/**
 * 把一组回执折叠成聚合回执 (#12)。必须是完整的一组: 第 g 组的全部分片, 最后一组可以不足 PART_SIZE。
 * 每次只验一组 (最多 256 次 HMAC), 把 commit 的 CPU 摊到上传过程中。
 */
export async function foldReceipts(env: Env, t: Ticket, receipts: string[]): Promise<string> {
  const count = chunkCountOf(t.z, t.k);
  if (!Array.isArray(receipts) || !receipts.length || receipts.length > PART_SIZE) throw new HttpError(400, 'fold needs 1..256 receipts');
  let g = -1;
  const refs: (ChunkRef | undefined)[] = [];
  for (const s of receipts) {
    const r = await openJson<Receipt>(env.SIGNING_KEY, RECEIPT, s);
    if (!r || r.id !== t.id || r.i < 0 || r.i >= count) throw new HttpError(400, 'bad receipt');
    const rg = Math.floor(r.i / PART_SIZE);
    if (g === -1) g = rg;
    if (rg !== g) throw new HttpError(400, 'receipts span more than one group');
    refs[r.i - g * PART_SIZE] = { c: r.c, m: r.m, b: r.b, f: r.f, s: r.s };
  }
  const size = Math.min(PART_SIZE, count - g * PART_SIZE);
  const missing: number[] = [];
  for (let i = 0; i < size && missing.length < 50; i++) if (!refs[i]) missing.push(g * PART_SIZE + i);
  if (missing.length) throw new HttpError(400, `missing chunks: ${missing.join(',')}`);
  const f: Fold = { id: t.id, g, r: JSON.stringify(refs.slice(0, size)) };
  return sealJson(env.SIGNING_KEY, FOLD, f);
}

/**
 * 验签回执和聚合回执, 写入 blob + node。回执不全时返回缺失的分片号。
 * 聚合回执只验一次 HMAC, 不解析里面的清单; 零散回执按组拼成清单文本。
 */
export async function commitUpload(env: Env, t: Ticket, receipts: string[], folds: string[] = []): Promise<NodeRow> {
  const count = chunkCountOf(t.z, t.k);
  const parts = partCountOf(count);
  const texts: (string | undefined)[] = new Array(parts);
  for (const s of folds) {
    const f = await openJson<Fold>(env.SIGNING_KEY, FOLD, s);
    if (!f || f.id !== t.id || !Number.isInteger(f.g) || f.g < 0 || f.g >= parts) throw new HttpError(400, 'bad fold');
    texts[f.g] = f.r;
  }
  const loose = new Map<number, (ChunkRef | undefined)[]>();
  for (const s of receipts) {
    const r = await openJson<Receipt>(env.SIGNING_KEY, RECEIPT, s);
    if (!r || r.id !== t.id || r.i < 0 || r.i >= count) throw new HttpError(400, 'bad receipt');
    const g = Math.floor(r.i / PART_SIZE);
    if (texts[g] !== undefined) continue; // 这一组已经折叠过
    let l = loose.get(g);
    if (!l) loose.set(g, (l = []));
    l[r.i - g * PART_SIZE] = { c: r.c, m: r.m, b: r.b, f: r.f, s: r.s };
  }
  const missing: number[] = [];
  for (let g = 0; g < parts && missing.length < 50; g++) {
    if (texts[g] !== undefined) continue;
    const l = loose.get(g) ?? [];
    const size = Math.min(PART_SIZE, count - g * PART_SIZE);
    for (let i = 0; i < size && missing.length < 50; i++) if (!l[i]) missing.push(g * PART_SIZE + i);
    if (!missing.length) texts[g] = JSON.stringify(l.slice(0, size));
  }
  if (missing.length) throw new HttpError(400, `missing chunks: ${missing.join(',')}`);

  const existing = await childByName(env, t.p, t.n);
  if (existing && (existing.kind === 'dir' || !t.o)) throw new HttpError(409, 'target exists');
  if (existing) await trashNode(env, existing.id);

  // ≤ 1 段: 清单一行, 和以前一样; 多段: blobs.manifest 只存段数, 每段一行进 blob_parts
  const manifest = parts === 1 ? (texts[0] as string) : JSON.stringify({ parts });
  const partStmts = parts === 1 ? [] : texts.map((txt, g) =>
    env.DB.prepare('INSERT INTO blob_parts (blob_id, idx, refs) VALUES (?, ?, ?)').bind(t.id, g, txt as string));
  const id = newId();
  const ts = now();
  const nodeStmt = env.DB.prepare(
    `INSERT INTO nodes (id, parent_id, name, kind, size, mime, blob_id, created_at, updated_at) VALUES (?, ?, ?, 'file', ?, ?, ?, ?, ?)`,
).bind(id, t.p, t.n, t.z, t.t, t.id, ts, ts);
  const blobSql = 'INSERT INTO blobs (id, size, sha256, chunk_size, manifest, ref_count, created_at, owner) VALUES (?, ?, ?, ?, ?, 1, ?, ?)';
  const owner = t.h ? t.u : null;
  try {
    await env.DB.batch([env.DB.prepare(blobSql).bind(t.id, t.z, t.h, t.k, manifest, ts, owner), ...partStmts, nodeStmt]);
  } catch (e) {
    // 同一张凭证提交两次: blob 主键已存在
    if (/blobs\.id/i.test(String(e))) throw new HttpError(409, 'upload already committed');
    // 同一上传者并发上传了同一内容, 撞了哈希唯一索引: 放弃哈希, 照样可用
    if (!t.h || !/UNIQUE/i.test(String(e))) throw e;
    await env.DB.batch([env.DB.prepare(blobSql).bind(t.id, t.z, null, t.k, manifest, ts, null), ...partStmts, nodeStmt]);
  }
  return { id, parent_id: t.p, name: t.n, kind: 'file', size: t.z, mime: t.t, blob_id: t.id, created_at: ts, updated_at: ts, deleted_at: null };
}

/** 秒传或复制时: 新建节点并给 blob 加引用 */
async function linkNode(env: Env, parentId: string, name: string, size: number, mime: string, blobId: string, existing: NodeRow | null): Promise<NodeRow> {
  if (existing) await trashNode(env, existing.id);
  const t = now();
  const id = newId();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO nodes (id, parent_id, name, kind, size, mime, blob_id, created_at, updated_at) VALUES (?, ?, ?, 'file', ?, ?, ?, ?, ?)`)
      .bind(id, parentId, name, size, mime, blobId, t, t),
    env.DB.prepare('UPDATE blobs SET ref_count = ref_count + 1 WHERE id = ?').bind(blobId),
  ]);
  return { id, parent_id: parentId, name, kind: 'file', size, mime, blob_id: blobId, created_at: t, updated_at: t, deleted_at: null };
}

/**
 * 服务端一次性上传 (表单, 原始 body, WebDAV PUT)。
 * 流按分片大小切成子流依次直通 TG, 只切视图不复制字节。
 * 限流时无法重放已消费的流, 直接把 429 返回给客户端。
 */
export async function uploadStream(env: Env, p: Principal, inp: InitInput, stream: ReadableStream<Uint8Array>): Promise<NodeRow> {
  const init = await initUpload(env, p, inp);
  if (init.done) {
    await stream.cancel().catch(() => {});
    return init.node;
  }
  const t = await openTicket(env, p, init.ticket);
  const receipts: string[] = [];
  const reader = stream.getReader();
  const carry = { buf: null as Uint8Array | null };
  for (let i = 0; i < init.chunkCount; i++) {
    const len = expectedChunkSize(t.z, t.k, i);
    receipts.push(await putChunk(env, t, i, takeBytes(reader, carry, len), len));
  }
  reader.releaseLock();
  return commitUpload(env, t, receipts);
}

/** 从 reader 里取恰好 n 字节作为一个子流; 多读的部分留在 carry 里给下一个子流 */
export function takeBytes(
  reader: ReadableStreamDefaultReader<Uint8Array>, carry: { buf: Uint8Array | null }, n: number,
): ReadableStream<Uint8Array> {
  let left = n;
  return new ReadableStream<Uint8Array>({
    async pull(ctl) {
      if (left <= 0) return ctl.close();
      let piece = carry.buf;
      carry.buf = null;
      if (!piece) {
        const { done, value } = await reader.read();
        if (done) return ctl.error(new HttpError(400, 'body shorter than declared size'));
        piece = value;
      }
      if (piece.length > left) {
        carry.buf = piece.subarray(left);
        piece = piece.subarray(0, left);
      }
      left -= piece.length;
      ctl.enqueue(piece);
      if (left <= 0) ctl.close();
    },
  });
}
