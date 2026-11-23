/** 读取文件: 支持 HEAD, Range, R2 公开直链, TG 分片流式拼接, 小文件边缘缓存 */
import type { Env } from '../env';
import { num } from '../env';
import { r2Key } from '../drivers/r2';
import { allBots, type BotRow, fetchChunkRange, markBot, rebindFileId, usableBots } from '../drivers/tg';
import { clampRange, mapToChunks, parseRange, type ByteRange } from '../lib/range';
import type { NodeRow } from '../lib/tree';
import { HttpError } from '../lib/util';

interface BlobRow { id: string; driver: 'r2' | 'tg'; size: number; chunk_size: number; chunk_count: number; r2_key: string | null; status: string }
interface ChunkRow { idx: number; size: number; channel_id: string; message_id: number; bot_id: string; file_id: string }

export interface ServeOptions {
  /** 是否允许重定向到 R2 公开域名 (签名直链/分享链接可以, API 读取不行)  */
  allowPublicRedirect?: boolean;
  /** 是否允许边缘缓存 (公开访问的小文件)  */
  edgeCache?: boolean;
  /** attachment 下载而不是 inline 预览 */
  download?: boolean;
  waitUntil?: (p: Promise<unknown>) => void;
}

const SMALL = 25 * 1024 * 1024;

export async function serveNode(env: Env, node: NodeRow, req: Request, opt: ServeOptions = {}): Promise<Response> {
  if (node.kind !== 'file' || !node.blob_id) throw new HttpError(400, 'not a file');
  const blob = await env.DB.prepare('SELECT * FROM blobs WHERE id = ?').bind(node.blob_id).first<BlobRow>();
  if (!blob || blob.status !== 'ready') throw new HttpError(404, 'content missing');

  const etag = `"${blob.id}"`;
  const base: Record<string, string> = {
    'Content-Type': node.mime ?? 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    ETag: etag,
    'Last-Modified': new Date(node.updated_at).toUTCString(),
    'Content-Disposition': `${opt.download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(node.name)}`,
    'Cache-Control': opt.edgeCache ? 'public, max-age=86400' : 'private, max-age=0',
  };
  if (req.headers.get('If-None-Match') === etag) return new Response(null, { status: 304, headers: base });

  if (blob.driver === 'r2' && opt.allowPublicRedirect && env.R2_PUBLIC_BASE) {
    return Response.redirect(`${env.R2_PUBLIC_BASE.replace(/\/$/, '')}/${r2Key(blob.id)}`, 302);
  }

  let range: ByteRange | null;
  try {
    range = parseRange(req.headers.get('Range'), blob.size);
  } catch {
    return new Response(null, { status: 416, headers: { ...base, 'Content-Range': `bytes */${blob.size}` } });
  }

  // 小文件, 无 Range, 允许缓存: 先查边缘缓存
  const cacheable = opt.edgeCache && !range && blob.size <= SMALL && req.method === 'GET';
  const cacheKey = new Request(new URL(`/__cache/${blob.id}`, req.url).toString());
  if (cacheable) {
    const hit = await caches.default.match(cacheKey);
    if (hit) return new Response(hit.body, { status: 200, headers: { ...base, 'Content-Length': String(blob.size), 'X-Cache': 'HIT' } });
  }

  if (blob.size === 0) return new Response(req.method === 'HEAD' ? null : '', { status: 200, headers: { ...base, 'Content-Length': '0' } });

  // TG 后端单次响应最多拉 MAX_CHUNKS 片; 没带 Range 的大文件也按 206 分段返回
  let status = range ? 206 : 200;
  if (blob.driver === 'tg') {
    const maxChunks = num(env.MAX_CHUNKS_PER_RESPONSE, 20);
    const want = range ?? { start: 0, end: blob.size - 1 };
    const clamped = clampRange(want, blob.chunk_size, maxChunks);
    if (clamped.end !== want.end) status = 206;
    range = status === 206 ? clamped : null;
  }
  const r = range ?? { start: 0, end: blob.size - 1 };
  const headers: Record<string, string> = { ...base, 'Content-Length': String(r.end - r.start + 1) };
  if (status === 206) headers['Content-Range'] = `bytes ${r.start}-${r.end}/${blob.size}`;
  if (req.method === 'HEAD') return new Response(null, { status, headers });

  let body: ReadableStream<Uint8Array>;
  if (blob.driver === 'r2') {
    const obj = await env.BUCKET.get(blob.r2_key!, range ? { range: { offset: r.start, length: r.end - r.start + 1 } } : undefined);
    if (!obj) throw new HttpError(404, 'r2 object missing');
    body = obj.body;
  } else {
    body = await tgStream(env, blob, r, opt.waitUntil);
  }

  if (cacheable && status === 200) {
    // 小文件整块读入后写缓存 (≤25MB, 避免 tee 双流在部分运行时下丢数据)
    const buf = await new Response(body).arrayBuffer();
    const put = caches.default.put(cacheKey, new Response(buf, { headers: { ...headers, 'Cache-Control': 'public, max-age=86400' } }));
    opt.waitUntil ? opt.waitUntil(put): put.catch(() => {});
    return new Response(buf, { status, headers: { ...headers, 'X-Cache': 'MISS' } });
  }
  return new Response(body, { status, headers });
}

async function tgStream(env: Env, blob: BlobRow, r: ByteRange, waitUntil?: (p: Promise<unknown>) => void): Promise<ReadableStream<Uint8Array>> {
  const slices = mapToChunks(r, blob.chunk_size);
  const rows = await env.DB.prepare('SELECT idx, size, channel_id, message_id, bot_id, file_id FROM chunks WHERE blob_id = ? AND idx BETWEEN ? AND ? ORDER BY idx')
    .bind(blob.id, slices[0].idx, slices[slices.length - 1].idx)
    .all<ChunkRow>();
  const byIdx = new Map(rows.results.map((c) => [c.idx, c]));
  const bots = await allBots(env);

  // FixedLengthStream 是运行时原生流, 搬运字节不占 JS CPU, 且自带 Content-Length
  const { readable, writable } = new FixedLengthStream(r.end - r.start + 1);
  const pump = (async () => {
    try {
      for (const sl of slices) {
        const ch = byIdx.get(sl.idx);
        if (!ch) throw new Error(`chunk ${sl.idx} missing`);
        const src = await openChunk(env, bots, blob.id, ch, sl.from, sl.to);
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

/** 打开一个分片; 上传它的 Bot 失效时自动换 Bot 重新绑定 file_id */
async function openChunk(env: Env, bots: BotRow[], blobId: string, ch: ChunkRow, from: number, to: number) {
  const owner = bots.find((b) => b.id === ch.bot_id);
  if (owner && owner.status !== 'dead') {
    try {
      return await fetchChunkRange(owner, ch.file_id, from, to, ch.size);
    } catch (e) {
      if (!/401|403|Unauthorized|Forbidden/i.test(String(e))) throw e;
      await markBot(env, owner.id, 'dead', 0, String(e));
    }
  }
  for (const alt of await usableBots(env)) {
    if (alt.id === ch.bot_id) continue;
    try {
      const fid = await rebindFileId(alt, ch.channel_id, ch.message_id);
      await env.DB.prepare('UPDATE chunks SET bot_id = ?, file_id = ? WHERE blob_id = ? AND idx = ?').bind(alt.id, fid, blobId, ch.idx).run();
      return await fetchChunkRange(alt, fid, from, to, ch.size);
    } catch {
      /* 试下一个 */
    }
  }
  throw new HttpError(502, `chunk ${ch.idx} unreachable: no bot can read it`);
}
