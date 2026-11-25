/**
 * 读取文件: HEAD, Range, TG 分片流式拼接
 * - 分片清单一行 JSON (大文件按 256 片分段存 blob_parts, 按 Range 只读用到的段), 缓存在 isolate 内存里: 热文件 D1 零读
 * - 单次响应能拼多少片由子请求预算动态决定 (冷分片 2 次: getFile + 下载; 热分片 1 次)
 * - 字节由 FixedLengthStream 原生搬运, JS 不碰数据
 */
import type { Env } from '../env';
import { num } from '../env';
import { allBots, type BotRow, cachedPath, fetchChunkRange, markDead, rebindFileId, TgFatal, usableBots } from '../drivers/tg';
import { mapToChunks, parseRange, type ByteRange } from '../lib/range';
import type { NodeRow } from '../lib/tree';
import { HttpError, now } from '../lib/util';
import { type ChunkRef, PART_SIZE } from './upload';

/**
 * 用户上传的内容和网页前端同源, 不加限制时上传一个 html / svg 就能读走 localStorage 里的令牌。
 * sandbox 让文档落到唯一 origin, 脚本不能执行也读不到本站存储; 图片, 视频, 音频照常内联显示。
 */
const CSP_CONTENT = "sandbox; default-src 'none'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'unsafe-inline'; font-src 'self' data:";
const CSP_PDF = "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; object-src 'self'";
export const SAFE_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': CSP_CONTENT,
  'Referrer-Policy': 'no-referrer',
};

export interface ServeOptions {
  /** 是否允许边缘缓存 (永久签名直链的小文件, 需绑定自定义域名才生效)  */
  edgeCache?: boolean;
  /** attachment 下载而不是 inline 预览 */
  download?: boolean;
  waitUntil?: (p: Promise<unknown>) => void;
}

/**
 * parts = 0: 清单整行在 blobs.manifest, refs 一次读全。
 * parts > 0: 清单分段在 blob_parts, refs 是稀疏数组, loaded 记录已读入的段, 用 ensureParts 按需补读。
 */
export interface BlobInfo { id: string; size: number; chunkSize: number; parts: number; refs: ChunkRef[]; loaded: Set<number> }

/** 解析 blobs.manifest: 数组是整份清单, {"parts":N} 是分段清单 */
export function parseManifest(raw: string): { parts: number; refs: ChunkRef[] } {
  const v = JSON.parse(raw) as ChunkRef[] | { parts: number };
  return Array.isArray(v) ? { parts: 0, refs: v } : { parts: v.parts, refs: [] };
}

const blobCache = new Map<string, { at: number; b: BlobInfo }>();
const BLOB_TTL = 30 * 60_000;
const SMALL = 25 * 1024 * 1024;

export async function loadBlob(env: Env, id: string): Promise<BlobInfo> {
  const hit = blobCache.get(id);
  if (hit && now() - hit.at < BLOB_TTL) return hit.b;
  const row = await env.DB.prepare('SELECT size, chunk_size, manifest FROM blobs WHERE id = ?')
    .bind(id)
    .first<{ size: number; chunk_size: number; manifest: string }>();
  if (!row) throw new HttpError(404, 'content missing');
  const m = parseManifest(row.manifest);
  const b: BlobInfo = { id, size: row.size, chunkSize: row.chunk_size, parts: m.parts, refs: m.refs, loaded: new Set() };
  if (blobCache.size > 5000) blobCache.clear();
  blobCache.set(id, { at: now(), b });
  return b;
}

export function forgetBlob(id: string) { blobCache.delete(id); }

/** 分段清单: 读入覆盖分片 [fromIdx, toIdx] 的段 (已读过的跳过), 一次查询 */
export async function ensureParts(env: Env, b: BlobInfo, fromIdx: number, toIdx: number): Promise<void> {
  if (!b.parts) return;
  const lo = Math.max(0, Math.floor(fromIdx / PART_SIZE));
  const hi = Math.min(b.parts - 1, Math.floor(toIdx / PART_SIZE));
  let need = false;
  for (let g = lo; g <= hi; g++) if (!b.loaded.has(g)) need = true;
  if (!need) return;
  const rows = (await env.DB.prepare('SELECT idx, refs FROM blob_parts WHERE blob_id = ? AND idx BETWEEN ? AND ?')
    .bind(b.id, lo, hi).all<{ idx: number; refs: string }>()).results;
  for (const r of rows) {
    const refs = JSON.parse(r.refs) as ChunkRef[];
    for (let i = 0; i < refs.length; i++) b.refs[r.idx * PART_SIZE + i] = refs[i];
    b.loaded.add(r.idx);
  }
}

/**
 * 在子请求预算内, 从 r.start 起最多能拼到哪个字节。
 * 返回截断后的区间; end 小于原区间说明需要客户端继续用 Range 拉后面的
 */
export function fitBudget(r: ByteRange, chunkSize: number, budget: number, isWarm: (idx: number) => boolean): ByteRange {
  let left = budget;
  let end = r.start - 1;
  for (const sl of mapToChunks(r, chunkSize)) {
    const cost = isWarm(sl.idx) ? 1 : 2;
    if (cost > left) break;
    left -= cost;
    end = sl.idx * chunkSize + sl.to;
  }
  if (end < r.start) throw new HttpError(503, 'subrequest budget too small');
  return { start: r.start, end };
}

export async function serveNode(env: Env, node: NodeRow, req: Request, opt: ServeOptions = {}): Promise<Response> {
  if (node.kind !== 'file' || !node.blob_id) throw new HttpError(400, 'not a file');
  const etag = `"${node.blob_id}"`;
  const base: Record<string, string> = {
    'Content-Type': node.mime ?? 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    ETag: etag,
    'Last-Modified': new Date(node.updated_at).toUTCString(),
    'Content-Disposition': `${opt.download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(node.name)}`,
    'Cache-Control': opt.edgeCache ? 'public, max-age=86400' : 'private, max-age=0',
    ...SAFE_HEADERS,
  };
  // PDF 内置查看器在 CSP sandbox 下无法打开, 只给它去掉 sandbox (PDF 里的脚本本身就跑在查看器沙箱里, 碰不到本站)
  if (node.mime?.startsWith('application/pdf')) base['Content-Security-Policy'] = CSP_PDF;
  // 304 与 HEAD 都不需要读 blob
  if (req.headers.get('If-None-Match') === etag) return new Response(null, { status: 304, headers: base });
  // 空文件: 不碰 blob 和 TG, Range 一律忽略
  if (node.size === 0) return new Response(req.method === 'HEAD' ? null : '', { status: 200, headers: { ...base, 'Content-Length': '0' } });

  let range: ByteRange | null;
  // If-Range 和当前 ETag 不一致: 内容变了, 忽略 Range 返回整个文件 (断点续传的客户端据此从头开始)
  const ifRange = req.headers.get('If-Range');
  const rangeHeader = ifRange && ifRange !== etag ? null : req.headers.get('Range');
  try {
    range = parseRange(rangeHeader, node.size);
  } catch {
    return new Response(null, { status: 416, headers: { ...base, 'Content-Range': `bytes */${node.size}` } });
  }

  const useCache = opt.edgeCache && env.EDGE_CACHE === '1' && !range && node.size <= SMALL && req.method === 'GET';
  const cacheKey = new Request(new URL(`/__cache/${node.blob_id}`, req.url).toString());
  let budget = num(env.SUBREQ_BUDGET, 48);
  if (useCache) {
    budget -= 2;
    const hit = await caches.default.match(cacheKey);
    if (hit) return new Response(hit.body, { status: 200, headers: { ...base, 'Content-Length': String(node.size), 'X-Cache': 'HIT' } });
  }

  if (req.method === 'HEAD' && !range) {
    return new Response(null, { status: 200, headers: { ...base, 'Content-Length': String(node.size) } });
  }

  const blob = await loadBlob(env, node.blob_id);
  const want = range ?? { start: 0, end: blob.size - 1 };
  // 分段清单: 一次响应最多拼 budget 片, 只读这些片所在的段
  const firstIdx = Math.floor(want.start / blob.chunkSize);
  await ensureParts(env, blob, firstIdx, Math.min(firstIdx + budget, Math.floor(want.end / blob.chunkSize)));
  const r = fitBudget(want, blob.chunkSize, budget, (i) => !!cachedPath(blob.refs[i].b, blob.refs[i].f));
  // 没带 Range 但一次拼不完: 按 206 返回前面一段, 播放器和下载器会接着用 Range 拉
  const status = range || r.end !== want.end ? 206 : 200;
  const headers: Record<string, string> = { ...base, 'Content-Length': String(r.end - r.start + 1) };
  if (status === 206) headers['Content-Range'] = `bytes ${r.start}-${r.end}/${blob.size}`;
  if (req.method === 'HEAD') return new Response(null, { status, headers });

  const body = await tgStream(env, blob, r, opt.waitUntil);
  if (useCache && status === 200) {
    const [a, b] = body.tee();
    const put = caches.default.put(cacheKey, new Response(b, { headers: { ...headers, 'Cache-Control': 'public, max-age=86400' } }));
    opt.waitUntil ? opt.waitUntil(put): put.catch(() => {});
    return new Response(a, { status, headers: { ...headers, 'X-Cache': 'MISS' } });
  }
  return new Response(body, { status, headers });
}

async function tgStream(env: Env, blob: BlobInfo, r: ByteRange, waitUntil?: (p: Promise<unknown>) => void): Promise<ReadableStream<Uint8Array>> {
  const slices = mapToChunks(r, blob.chunkSize);
  const bots = await allBots(env);
  const FLS = (globalThis as { FixedLengthStream?: new (n: number) => TransformStream<Uint8Array, Uint8Array> }).FixedLengthStream;
  const { readable, writable } = FLS ? new FLS(r.end - r.start + 1) : new TransformStream<Uint8Array, Uint8Array>();
  // 预取下一片: 当前片在往外送时, 下一片的 getFile 与连接已经建好, 片与片之间不再串行等一个 TG 往返。
  // 同时最多 2 个 TG 连接 (Workers 允许 6 个), 子请求总数不变
  const open = (i: number) => {
    const sl = slices[i];
    const p = openChunk(env, bots, blob, sl.idx, sl.from, sl.to);
    p.catch(() => {}); // 失败在轮到它时再抛, 避免未处理的拒绝
    return p;
  };
  const pump = (async () => {
    let next = slices.length ? open(0) : null;
    try {
      for (let i = 0; i < slices.length; i++) {
        const src = await next!;
        next = i + 1 < slices.length ? open(i + 1) : null;
        await src.pipeTo(writable, { preventClose: true });
      }
      await writable.close();
    } catch (e) {
      // 客户端断开或某片失败: 取消已经打开的下一片, 不白白下载
      if (next) next.then((s) => s.cancel()).catch(() => {});
      await writable.abort(e).catch(() => {});
    }
  })();
  waitUntil?.(pump);
  return readable;
}

/** 打开一个分片; 上传它的 Bot 失效时换 Bot 重新绑定 file_id 并更新清单 */
async function openChunk(env: Env, bots: BotRow[], blob: BlobInfo, idx: number, from: number, to: number) {
  const ch = blob.refs[idx];
  if (!ch) { console.error('chunk missing in manifest', idx); throw new HttpError(500, 'internal error'); }
  const owner = bots.find((b) => b.id === ch.b);
  if (owner && owner.status !== 'dead') {
    try {
      return await fetchChunkRange(owner, ch.f, from, to, ch.s);
    } catch (e) {
      if (!(e instanceof TgFatal) && !/401|403|Unauthorized|Forbidden/i.test(String(e))) throw e;
      await markDead(env, owner.id, String(e));
    }
  }
  for (const alt of await usableBots(env)) {
    if (alt.id === ch.b) continue;
    try {
      const fid = await rebindFileId(alt, ch.c, ch.m);
      blob.refs[idx] = { ...ch, b: alt.id, f: fid };
      // 整个清单是一行 (或分段时只写所在的那一段), 换绑只写 1 行
      if (blob.parts) {
        const g = Math.floor(idx / PART_SIZE);
        const seg = blob.refs.slice(g * PART_SIZE, Math.min((g + 1) * PART_SIZE, blob.refs.length));
        await env.DB.prepare('UPDATE blob_parts SET refs = ? WHERE blob_id = ? AND idx = ?').bind(JSON.stringify(seg), blob.id, g).run();
      } else {
        await env.DB.prepare('UPDATE blobs SET manifest = ? WHERE id = ?').bind(JSON.stringify(blob.refs), blob.id).run();
      }
      return await fetchChunkRange(alt, fid, from, to, ch.s);
    } catch {
      /* 试下一个 */
    }
  }
  throw new HttpError(502, `chunk ${idx} unreachable: no bot can read it`);
}
