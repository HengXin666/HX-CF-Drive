// 文件内容读取 (支持 Range), 签名直链 /f/ 和分享链接 /s/
import { type DNode, getData, now, state } from './db';
import { children, getNode, HttpError, publicNode, resolvePath } from './tree';

export const BASE = import.meta.env.BASE_URL;

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } });
}

// 演示签名: 不涉及任何密钥, 只用来模拟 e/s 参数和过期校验
function sig(id: string, exp: number): string {
  let h = 0x811c9dc5;
  for (const c of `${id}:${exp}:hx-demo`) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193) >>> 0;
  return h.toString(36);
}

export function fileLink(n: DNode, expiresInSec = 0): string {
  const exp = expiresInSec > 0 ? Math.floor(now() / 1000) + expiresInSec : 0;
  return `${location.origin}${BASE}f/${n.id}/${encodeURIComponent(n.name)}?e=${exp}&s=${sig(n.id, exp)}`;
}

export const shareLink = (id: string) => `${location.origin}${BASE}s/${id}`;

/** 按节点返回内容, 处理 Range 和 ?download=1 */
export async function serveNode(n: DNode, req: Request, download: boolean): Promise<Response> {
  if (n.kind !== 'file') throw new HttpError(400, 'not a file');
  if (n.expiresAt && n.expiresAt < now()) throw new HttpError(410, 'expired');
  const blob = n.blobId ? state().blobs[n.blobId] : null;
  if (blob?.virtual) throw new HttpError(404, '演示占位文件: 只有元数据, 没有实际内容');
  const data = (n.blobId && (await getData(n.blobId))) || new Blob([]);
  const headers: Record<string, string> = {
    'Content-Type': n.mime ?? 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(n.name)}`,
  };
  const size = data.size;
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get('Range') ?? '');
  if (m && size > 0) {
    let start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
    let end = m[1] && m[2] ? Number(m[2]) : size - 1;
    end = Math.min(end, size - 1);
    start = Math.min(start, size);
    if (start > end) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    const part = data.slice(start, end + 1);
    return new Response(req.method === 'HEAD' ? null : part, {
      status: 206, headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(part.size) },
    });
  }
  return new Response(req.method === 'HEAD' ? null : data, { status: 200, headers: { ...headers, 'Content-Length': String(size) } });
}

/** /f/:id 或 /f/:id/:name */
export async function servePublicFile(rest: string, url: URL, req: Request): Promise<Response> {
  const id = rest.split('/')[0];
  const exp = Number(url.searchParams.get('e') ?? 'x');
  const ok = Number.isFinite(exp) && url.searchParams.get('s') === sig(id, exp) && (exp === 0 || exp * 1000 > now());
  if (!ok) throw new HttpError(403, 'bad or expired signature');
  const n = getNode(id);
  if (!n) throw new HttpError(404, 'not found');
  return serveNode(n, req, url.searchParams.get('download') === '1');
}

/** /s/:id: 文件直接返回内容; 目录返回 JSON 列表, ?path= 访问子项 */
export async function serveShare(rest: string, url: URL, req: Request): Promise<Response> {
  const sh = state().shares.find((s) => s.id === rest.split('/')[0]);
  if (!sh || (sh.expiresAt && sh.expiresAt < now())) throw new HttpError(404, 'share not found or expired');
  if (sh.disabled) throw new HttpError(410, 'share disabled');
  if (sh.password && (url.searchParams.get('p') ?? req.headers.get('X-Share-Password') ?? '') !== sh.password) {
    throw new HttpError(401, 'password required');
  }
  const root = getNode(sh.nodeId);
  if (!root) throw new HttpError(404, 'shared item removed');
  const sub = url.searchParams.get('path');
  const n = sub ? resolvePath(sub, root.id) : root;
  if (!n) throw new HttpError(404, 'not found');
  if (n.kind === 'dir') return json(200, { node: publicNode(n), children: children(n.id).map(publicNode) });
  return serveNode(n, req, url.searchParams.get('download') === '1');
}
