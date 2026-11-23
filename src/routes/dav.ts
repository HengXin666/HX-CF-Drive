/**
 * WebDAV (RFC 4918 子集), 挂在 /dav。认证: Basic, 用户名随意, 密码填 API 令牌。
 * 支持: OPTIONS PROPFIND PROPPATCH GET HEAD PUT MKCOL DELETE MOVE COPY LOCK UNLOCK
 * 客户端: rclone (vendor=other), RaiDrive, Windows 资源管理器, macOS Finder, Infuse, OpenList WebDAV 驱动
 */
import { Hono, type Context } from 'hono';
import type { AppEnv } from '../env';
import { requireScope } from '../lib/auth';
import {
  assertAccess, childByName, listChildren, mkdir, moveNode, type NodeRow, resolvePath, trashNode,
} from '../lib/tree';
import { HttpError, newId, splitPath } from '../lib/util';
import { serveNode } from '../services/serve';
import { uploadStream } from '../services/upload';
import { copyTree } from './api';

export const dav = new Hono<AppEnv>();
type C = Context<AppEnv>;

const PREFIX = '/dav';
const rel = (c: C) => decodeURIComponent(new URL(c.req.url).pathname.slice(PREFIX.length) || '/');

function esc(s: string) {
  return s.replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[m]!));
}

function hrefOf(path: string, isDir: boolean) {
  const enc = splitPath(path).map(encodeURIComponent).join('/');
  return `${PREFIX}/${enc}${isDir && enc ? '/' : ''}`;
}

function propXml(n: NodeRow, path: string) {
  const isDir = n.kind === 'dir';
  return `<D:response><D:href>${esc(hrefOf(path, isDir))}</D:href><D:propstat><D:prop>
<D:displayname>${esc(n.name || '/')}</D:displayname>
<D:resourcetype>${isDir ? '<D:collection/>' : ''}</D:resourcetype>
${isDir ? '' : `<D:getcontentlength>${n.size}</D:getcontentlength><D:getcontenttype>${esc(n.mime ?? 'application/octet-stream')}</D:getcontenttype><D:getetag>"${n.blob_id}"</D:getetag>`}
<D:getlastmodified>${new Date(n.updated_at).toUTCString()}</D:getlastmodified>
<D:creationdate>${new Date(n.created_at).toISOString()}</D:creationdate>
<D:supportedlock><D:lockentry><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockentry></D:supportedlock>
</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
}

async function nodeAt(c: C, path: string) {
  const p = c.get('principal');
  return resolvePath(c.env, p.rootId, path);
}

function parentAndName(path: string) {
  const segs = splitPath(path);
  const name = segs.pop() ?? '';
  return { parent: '/' + segs.join('/'), name };
}

/** Destination 头 → 相对路径 */
function destPath(c: C): string {
  const d = c.req.header('Destination');
  if (!d) throw new HttpError(400, 'Destination header required');
  const p = new URL(d, c.req.url).pathname;
  if (!p.startsWith(PREFIX)) throw new HttpError(502, 'Destination outside /dav');
  return decodeURIComponent(p.slice(PREFIX.length) || '/');
}

dav.options('/*', (c) =>
  c.body(null, 200, { DAV: '1, 2', Allow: 'OPTIONS, PROPFIND, PROPPATCH, GET, HEAD, PUT, MKCOL, DELETE, MOVE, COPY, LOCK, UNLOCK', 'MS-Author-Via': 'DAV' }),
);

dav.on('PROPFIND', '/*', requireScope('read'), async (c) => {
  const path = rel(c);
  const node = await nodeAt(c, path);
  if (!node) return c.body(null, 404);
  const depth = c.req.header('Depth') ?? '1';
  const parts = [propXml(node, path)];
  if (node.kind === 'dir' && depth !== '0') {
    const base = path.endsWith('/') ? path : path + '/';
    for (const ch of await listChildren(c.env, node.id)) parts.push(propXml(ch, base + ch.name));
  }
  return c.body(`<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus xmlns:D="DAV:">${parts.join('')}</D:multistatus>`, 207, {
    'Content-Type': 'application/xml; charset=utf-8',
  });
});

dav.on('PROPPATCH', '/*', requireScope('write'), async (c) => {
  const path = rel(c);
  return c.body(
    `<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus xmlns:D="DAV:"><D:response><D:href>${esc(hrefOf(path, false))}</D:href><D:propstat><D:prop/><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>`,
    207,
    { 'Content-Type': 'application/xml; charset=utf-8' },
);
});

dav.on(['GET', 'HEAD'], '/*', requireScope('read'), async (c) => {
  const node = await nodeAt(c, rel(c));
  if (!node) return c.body(null, 404);
  if (node.kind === 'dir') {
    const items = await listChildren(c.env, node.id);
    const html = `<!doctype html><meta charset="utf-8"><h3>${esc(rel(c))}</h3><ul>${items
      .map((i) => `<li><a href="${encodeURIComponent(i.name)}${i.kind === 'dir' ? '/' : ''}">${esc(i.name)}${i.kind === 'dir' ? '/' : ''}</a></li>`)
      .join('')}</ul>`;
    return c.html(html);
  }
  return serveNode(c.env, node, c.req.raw, { waitUntil: (p) => c.executionCtx.waitUntil(p) });
});

dav.put('/*', requireScope('write'), async (c) => {
  const p = c.get('principal');
  const { parent, name } = parentAndName(rel(c));
  const dir = await resolvePath(c.env, p.rootId, parent);
  if (!dir || dir.kind !== 'dir') return c.body(null, 409);
  await assertAccess(c.env, p, dir.id);
  const len = Number(c.req.header('Content-Length') ?? NaN);
  if (!Number.isFinite(len)) return c.body('Content-Length required (chunked PUT not supported)', 411);
  const existed = !!(await childByName(c.env, dir.id, name));
  const body = c.req.raw.body ?? new ReadableStream({ start: (ctl) => ctl.close() });
  await uploadStream(c.env, p, { parentId: dir.id, name, size: len, mime: c.req.header('Content-Type') || undefined, overwrite: true }, body);
  return c.body(null, existed ? 204 : 201);
});

dav.on('MKCOL', '/*', requireScope('write'), async (c) => {
  const p = c.get('principal');
  const { parent, name } = parentAndName(rel(c));
  const dir = await resolvePath(c.env, p.rootId, parent);
  if (!dir || dir.kind !== 'dir') return c.body(null, 409);
  if (await childByName(c.env, dir.id, name)) return c.body(null, 405);
  await mkdir(c.env, dir.id, name);
  return c.body(null, 201);
});

dav.delete('/*', requireScope('write'), async (c) => {
  const node = await nodeAt(c, rel(c));
  if (!node) return c.body(null, 404);
  if (node.id === c.get('principal').rootId) return c.body(null, 403);
  await trashNode(c.env, node.id);
  return c.body(null, 204);
});

async function moveOrCopy(c: C, copy: boolean) {
  const p = c.get('principal');
  const src = await nodeAt(c, rel(c));
  if (!src) return c.body(null, 404);
  const { parent, name } = parentAndName(destPath(c));
  const dir = await resolvePath(c.env, p.rootId, parent);
  if (!dir || dir.kind !== 'dir') return c.body(null, 409);
  const overwrite = (c.req.header('Overwrite') ?? 'T').toUpperCase() !== 'F';
  const clash = await childByName(c.env, dir.id, name);
  if (clash && !overwrite) return c.body(null, 412);
  if (copy) {
    if (clash) await trashNode(c.env, clash.id);
    await copyTree(c.env, src, dir.id, name);
  } else {
    await moveNode(c.env, src.id, dir.id, name, overwrite);
  }
  return c.body(null, clash ? 204 : 201);
}

dav.on('MOVE', '/*', requireScope('write'), (c) => moveOrCopy(c, false));
dav.on('COPY', '/*', requireScope('write'), (c) => moveOrCopy(c, true));

// 假锁: Windows / Finder 写文件前一定会 LOCK, 不支持就拒绝写入
dav.on('LOCK', '/*', requireScope('write'), (c) => {
  const token = `opaquelocktoken:${newId(24)}`;
  return c.body(
    `<?xml version="1.0" encoding="utf-8"?>\n<D:prop xmlns:D="DAV:"><D:lockdiscovery><D:activelock><D:locktype><D:write/></D:locktype><D:lockscope><D:exclusive/></D:lockscope><D:depth>infinity</D:depth><D:timeout>Second-3600</D:timeout><D:locktoken><D:href>${token}</D:href></D:locktoken></D:activelock></D:lockdiscovery></D:prop>`,
    200,
    { 'Content-Type': 'application/xml; charset=utf-8', 'Lock-Token': `<${token}>` },
);
});
dav.on('UNLOCK', '/*', requireScope('write'), (c) => c.body(null, 204));

