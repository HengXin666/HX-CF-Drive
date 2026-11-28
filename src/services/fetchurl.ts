/**
 * URL 远程上传 (#22 P2-9): Worker 去 fetch 远程地址, 按分片大小流式切开写进 TG, 内容不落地、不缓冲。
 *
 * 有界设计 (CF 免费计划: 每请求 50 个子请求, CPU 10 ms):
 * - 一次请求最多写 FETCH_CHUNKS 片 (1 次远程 fetch + 每片 1 次 sendDocument)。
 * - 文件更大时第一次请求返回 { done: false, ticket, receipts, next }, 客户端用 POST /uploads/fetch
 *   带 Range 继续拉后面的分片, 最后照常 /uploads/commit。和普通分片上传一样无服务端状态, 中断后从 next 接着来。
 * - 远程不支持 Range 时只能一次拉完, 超过 FETCH_CHUNKS 片返回 413。
 * - 没有 Content-Length 的响应 (chunked) 先读进内存, 最多 1 片 (19 MiB)。
 * D1: 和普通上传相同 (init 只读, commit 约 4 行写), 续传的请求 D1 零读写。
 */
import type { Env, Principal } from '../env';
import { chunkSizeOf } from '../env';
import { type NodeRow } from '../lib/tree';
import { HttpError } from '../lib/util';
import {
  chunkCountOf, commitUpload, expectedChunkSize, initUpload, type InitInput, openTicket, putChunk, takeBytes, type Ticket,
} from './upload';

/** 一次请求最多写几片 (≈ 57 MiB) */
export const FETCH_CHUNKS = 3;
const UA = 'HX-CF-Drive/0.4 (+https://github.com/HengXin666/HX-CF-Drive)';

export function checkUrl(raw: unknown): URL {
  let u: URL;
  try { u = new URL(String(raw ?? '')); } catch { throw new HttpError(400, 'bad url'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new HttpError(400, 'only http(s) urls');
  if (u.username || u.password) throw new HttpError(400, 'credentials in url not allowed');
  return u;
}

/** 文件名: 显式给的 > Content-Disposition > URL 最后一段 > download */
export function nameFrom(u: URL, cd: string | null, given?: string): string {
  if (given?.trim()) return given.trim();
  const m = cd && (/filename\*\s*=\s*UTF-8''([^;]+)/i.exec(cd) ?? /filename\s*=\s*"?([^";]+)"?/i.exec(cd));
  let n = '';
  try { n = decodeURIComponent(m ? m[1] : u.pathname.split('/').pop() ?? ''); } catch { n = m ? m[1] : ''; }
  n = n.replace(/[\\/\x00-\x1f]/g, '_').trim().slice(0, 200);
  return n && n !== '.' && n !== '..' ? n : 'download';
}

async function remote(u: URL, range?: string): Promise<Response> {
  const r = await fetch(u.toString(), { headers: { 'User-Agent': UA, 'Accept-Encoding': 'identity', ...(range ? { Range: range } : {}) }, redirect: 'follow' });
  if (!r.ok) { await r.body?.cancel().catch(() => {}); throw new HttpError(502, `remote responded ${r.status}`); }
  return r;
}

/** 把 reader 里的 [from, to) 片依次写进 TG, 返回回执 */
async function pump(env: Env, t: Ticket, reader: ReadableStreamDefaultReader<Uint8Array>, from: number, to: number): Promise<string[]> {
  const carry = { buf: null as Uint8Array | null };
  const out: string[] = [];
  for (let i = from; i < to; i++) {
    const len = expectedChunkSize(t.z, t.k, i);
    out.push(await putChunk(env, t, i, takeBytes(reader, carry, len), len));
  }
  return out;
}

export type FetchResult =
  | { done: true; node: NodeRow }
  | { done: false; ticket: string; chunkSize: number; chunkCount: number; receipts: string[]; next: number };

/** 第一次请求: 拉远程, 能一次写完就直接 commit, 否则写前 FETCH_CHUNKS 片并返回票据 */
export async function fetchStart(env: Env, p: Principal, url: URL, inp: Omit<InitInput, 'size' | 'name'> & { name?: string }): Promise<FetchResult> {
  const r = await remote(url);
  const k = chunkSizeOf(env);
  const name = nameFrom(url, r.headers.get('Content-Disposition'), inp.name);
  const mime = inp.mime ?? r.headers.get('Content-Type') ?? undefined;
  let size = Number(r.headers.get('Content-Length'));
  let body: ReadableStream<Uint8Array> = r.body ?? new ReadableStream({ start: (c) => c.close() });
  if (!r.headers.has('Content-Length') || !Number.isFinite(size) || r.headers.has('Content-Encoding')) {
    // 长度未知 (chunked 或压缩传输): 读进内存, 最多 1 片
    const buf = await readCapped(body, k);
    size = buf.length;
    body = new Response(buf).body!;
  }
  const ranges = /bytes/i.test(r.headers.get('Accept-Ranges') ?? '');
  const count = chunkCountOf(size, k);
  if (count > FETCH_CHUNKS && !ranges) {
    await body.cancel().catch(() => {});
    throw new HttpError(413, `remote does not support Range; url upload without Range is limited to ${FETCH_CHUNKS * k} bytes`);
  }
  const init = await initUpload(env, p, { ...inp, name, size, mime });
  if (init.done) { await body.cancel().catch(() => {}); return { done: true, node: init.node }; }
  const t = await openTicket(env, p, init.ticket);
  const reader = body.getReader();
  const n = Math.min(count, FETCH_CHUNKS);
  const receipts = await pump(env, t, reader, 0, n);
  await reader.cancel().catch(() => {});
  if (n === count) return { done: true, node: await commitUpload(env, t, receipts) };
  return { done: false, ticket: init.ticket, chunkSize: init.chunkSize, chunkCount: count, receipts, next: n };
}

/** 续传: 用 Range 拉 [from, from + FETCH_CHUNKS) 片 */
export async function fetchMore(env: Env, p: Principal, sealed: string, url: URL, from: number): Promise<{ receipts: string[]; next: number | null }> {
  const t = await openTicket(env, p, sealed);
  const count = chunkCountOf(t.z, t.k);
  if (!Number.isInteger(from) || from < 0 || from >= count) throw new HttpError(400, 'from out of range');
  const to = Math.min(count, from + FETCH_CHUNKS);
  const start = from * t.k;
  const end = Math.min(t.z, to * t.k) - 1;
  const r = await remote(url, `bytes=${start}-${end}`);
  const cr = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(r.headers.get('Content-Range') ?? '');
  if (r.status !== 206 || !cr || Number(cr[1]) !== start || (cr[3] !== '*' && Number(cr[3]) !== t.z)) {
    await r.body?.cancel().catch(() => {});
    throw new HttpError(502, 'remote ignored Range or changed size');
  }
  const reader = r.body!.getReader();
  const receipts = await pump(env, t, reader, from, to);
  await reader.cancel().catch(() => {});
  return { receipts, next: to < count ? to : null };
}

async function readCapped(s: ReadableStream<Uint8Array>, max: number): Promise<Uint8Array> {
  const reader = s.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > max) { await reader.cancel().catch(() => {}); throw new HttpError(413, `remote has no Content-Length; limited to ${max} bytes`); }
    parts.push(value);
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const x of parts) { out.set(x, o); o += x.length; }
  return out;
}
