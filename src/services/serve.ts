/**
 * 读取文件: HEAD, Range, TG 分片流式拼接
 * - 分片清单一行 JSON, 并缓存在 isolate 内存里: 热文件 D1 零读
 * - 单次响应能拼多少片由子请求预算动态决定 (冷分片 2 次: getFile + 下载; 热分片 1 次)
 * - 字节由 FixedLengthStream 原生搬运, JS 不碰数据
 */
import type { Env } from '../env';
import { num } from '../env';
import { allBots, type BotRow, cachedPath, fetchChunkRange, markDead, rebindFileId, TgFatal, usableBots } from '../drivers/tg';
import { mapToChunks, parseRange, type ByteRange } from '../lib/range';
import type { NodeRow } from '../lib/tree';
import { HttpError, now } from '../lib/util';
import type { ChunkRef } from './upload';

export interface ServeOptions {
  /** 是否允许边缘缓存 (永久签名直链的小文件, 需绑定自定义域名才生效)  */
  edgeCache?: boolean;
  /** attachment 下载而不是 inline 预览 */
  download?: boolean;
  waitUntil?: (p: Promise<unknown>) => void;
}

interface BlobInfo { id: string; size: number; chunkSize: number; refs: ChunkRef[] }

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
  const b: BlobInfo = { id, size: row.size, chunkSize: row.chunk_size, refs: JSON.parse(row.manifest) };
  if (blobCache.size > 5000) blobCache.clear();
  blobCache.set(id, { at: now(), b });
  return b;
}

export function forgetBlob(id: string) { blobCache.delete(id); }

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
  };
  // 304 与 HEAD 都不需要读 blob
  if (req.headers.get('If-None-Match') === etag) return new Response(null, { status: 304, headers: base });

  let range: ByteRange | null;
  try {
    range = parseRange(req.headers.get('Range'), node.size);
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
  const pump = (async () => {
    try {
      for (const sl of slices) {
        const src = await openChunk(env, bots, blob, sl.idx, sl.from, sl.to);
        await src.pipeTo(writable, { preventClose: true });
      }
      await writable.close();
    } catch (e) {
      await writable.abort(e).catch(() => {});
    }
  })();
  waitUntil?.(pump);
  return readable;
}

/** 打开一个分片; 上传它的 Bot 失效时换 Bot 重新绑定 file_id 并更新清单 */
async function openChunk(env: Env, bots: BotRow[], blob: BlobInfo, idx: number, from: number, to: number) {
  const ch = blob.refs[idx];
  if (!ch) throw new HttpError(500, `chunk ${idx} missing in manifest`);
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
      // 整个清单是一行, 换绑只写 1 行
      await env.DB.prepare('UPDATE blobs SET manifest = ? WHERE id = ?').bind(JSON.stringify(blob.refs), blob.id).run();
      return await fetchChunkRange(alt, fid, from, to, ch.s);
    } catch {
      /* 试下一个 */
    }
  }
  throw new HttpError(502, `chunk ${idx} unreachable: no bot can read it`);
}
