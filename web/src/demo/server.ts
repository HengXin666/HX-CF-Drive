// 模拟 REST API v1: 路由与返回结构对齐 src/routes/api.ts, 数据落在浏览器本地
import { delData, getData, newId, now, putData, save, sha256Hex, state } from './db';
import { BASE, fileLink, json, serveNode, servePublicFile, serveShare, shareLink } from './serve';
import {
  children, claimName, copy, getNode, HttpError, insert, maintenance, mkdirp, move, pathOf, publicNode, purge, resolvePath, restore, ROOT, trash, trashList,
} from './tree';

type Scope = 'read' | 'write' | 'admin' | 'stats';
interface Ctx { req: Request; url: URL; scopes: Scope[]; body: () => Promise<Record<string, unknown>> }
type Handler = (c: Ctx, m: RegExpMatchArray) => Promise<Response> | Response;

const CHUNK = 2 * 1024 * 1024; // 演示用 2 MiB 分片, 小文件也能看到分片进度 (真实部署为 19 MiB)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const jitter = () => sleep(120 + Math.random() * 260);

const routes: [string, RegExp, Scope, Handler][] = [];
const on = (method: string, path: string, scope: Scope, h: Handler) => routes.push([method, new RegExp(`^${path}$`), scope, h]);

const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);

/** 通过 id 或 path 定位节点 */
function locate(id?: unknown, path?: unknown) {
  const n = str(id) ? getNode(id as string) : resolvePath(str(path) ?? '/');
  if (!n) throw new HttpError(404, 'not found');
  return n;
}

// ---------------- 目录 ----------------

on('GET', '/fs/list', 'read', ({ url }) => {
  const n = locate(url.searchParams.get('id'), url.searchParams.get('path'));
  if (n.kind !== 'dir') return json(200, { node: publicNode(n), children: [] });
  return json(200, { node: publicNode(n), path: pathOf(n), children: children(n.id).map(publicNode) });
});

on('GET', '/fs/stat', 'read', ({ url }) => {
  const n = locate(url.searchParams.get('id'), url.searchParams.get('path'));
  return json(200, { node: publicNode(n), path: pathOf(n) });
});

on('POST', '/fs/mkdir', 'write', async (c) => json(200, { node: publicNode(mkdirp(String((await c.body()).path ?? '/'))) }));

on('POST', '/fs/move', 'write', async (c) => {
  const b = await c.body();
  const n = locate(b.id, b.path);
  const to = b.toParentId || b.toPath ? locate(b.toParentId, b.toPath) : getNode(n.parentId ?? '');
  if (!to) throw new HttpError(404, 'target not found');
  return json(200, { node: publicNode(move(n.id, to.id, str(b.name) ?? n.name, !!b.overwrite)) });
});

on('POST', '/fs/copy', 'write', async (c) => {
  const b = await c.body();
  const src = locate(b.id, b.path);
  const dst = locate(b.toParentId, b.toPath);
  return json(200, { node: publicNode(copy(src, dst.id, str(b.name) ?? src.name)) });
});

on('POST', '/fs/delete', 'write', async (c) => {
  const b = await c.body();
  return json(200, { trashed: trash(locate(b.id, b.path).id) });
});

on('GET', '/fs/trash', 'write', () => json(200, { items: trashList() }));

on('POST', '/fs/restore', 'write', async (c) => {
  restore(String((await c.body()).id ?? ''));
  return json(200, { ok: true });
});

on('POST', '/fs/purge', 'write', async (c) => {
  const id = String((await c.body()).id ?? '');
  if (!trashList().some((n) => n.id === id)) throw new HttpError(404, 'not in trash');
  return json(200, await purge([id]));
});

on('POST', '/fs/trash/empty', 'write', async () => json(200, await purge(null)));

on('GET', '/fs/search', 'read', ({ url }) => {
  const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
  if (!q) throw new HttpError(400, 'q required');
  const limit = Math.min(Number(url.searchParams.get('limit')) || 50, 200);
  const items = Object.values(state().nodes)
    .filter((n) => n.id !== ROOT && getNode(n.id) && n.name.toLowerCase().includes(q))
    .filter((n) => { for (let p = getNode(n.parentId ?? ''); p; p = getNode(p.parentId ?? '')) if (p.id === ROOT) return true; return false; })
    .slice(0, limit)
    .map((n) => ({ ...publicNode(n), path: pathOf(n) }));
  return json(200, { items });
});

on('POST', '/fs/link', 'read', async (c) => {
  const b = await c.body();
  const n = locate(b.id, b.path);
  if (n.kind !== 'file') throw new HttpError(400, 'not a file');
  return json(200, { url: fileLink(n, Number(b.expiresIn) || 0) });
});

// 批量签直链 (#22), 同 /fs/links
on('POST', '/fs/links', 'read', async (c) => {
  const b = await c.body();
  const ids = [...new Set((Array.isArray(b.ids) ? b.ids : []).map(String))];
  if (ids.length > 200) throw new HttpError(413, 'too many ids (max 200)');
  const items = [];
  const missing: string[] = [];
  for (const id of ids) {
    const n = getNode(id);
    if (!n || n.kind !== 'file') { missing.push(id); continue; }
    items.push({ id, name: n.name, mime: n.mime, url: fileLink(n, Number(b.expiresIn) || 0) });
  }
  return json(200, { items, missing });
});

on('(GET|HEAD)', '/files/([^/]+)/content', 'read', (c, m) => {
  const n = getNode(decodeURIComponent(m[1]));
  if (!n) throw new HttpError(404, 'not found');
  return serveNode(n, c.req, c.url.searchParams.get('download') === '1');
});

// ---------------- 上传 ----------------

/** 落一个文件节点: 内容按 sha256 去重 */
async function putFile(parentId: string, name: string, data: Blob, mime: string | null, overwrite: boolean) {
  claimName(parentId, name, overwrite);
  const id = await sha256Hex(data);
  if (!state().blobs[id]) {
    await putData(id, data);
    state().blobs[id] = { id, size: data.size, refs: 0 };
  }
  return insert({ parentId, name, kind: 'file', size: data.size, mime, blobId: id });
}

on('POST', '/uploads', 'write', async (c) => {
  const b = await c.body();
  const name = String(b.name ?? '');
  const size = Number(b.size) || 0;
  const parent = str(b.parentId) ? locate(b.parentId) : b.mkdirs === false ? locate(null, b.path) : mkdirp(str(b.path) ?? '/');
  const mime = str(b.mime) ?? null;
  claimName(parent.id, name, !!b.overwrite);
  // 秒传: 已有相同 sha256 的数据块就直接建节点
  const hit = str(b.sha256) ? state().blobs[String(b.sha256).toLowerCase()] : undefined;
  if (size === 0 || (hit && hit.size === size)) {
    const node = size === 0 ? await putFile(parent.id, name, new Blob([]), mime, !!b.overwrite)
      : insert({ parentId: parent.id, name, kind: 'file', size, mime, blobId: hit!.id });
    return json(200, { done: true, node: publicNode(node), url: fileLink(node) });
  }
  const ticket = `t_${newId(24)}`;
  const chunkCount = Math.max(1, Math.ceil(size / CHUNK));
  state().tickets[ticket] = { ticket, parentId: parent.id, name, size, mime, overwrite: !!b.overwrite, chunkSize: CHUNK, chunkCount };
  return json(200, { done: false, ticket, chunkSize: CHUNK, chunkCount });
});

on('PUT', '/uploads/chunk', 'write', async ({ req, url }) => {
  const t = state().tickets[url.searchParams.get('ticket') ?? ''];
  if (!t) throw new HttpError(403, 'bad ticket');
  const i = Number(url.searchParams.get('i'));
  if (!Number.isInteger(i) || i < 0 || i >= t.chunkCount) throw new HttpError(400, 'bad chunk index');
  const data = await req.blob();
  const want = Math.min(t.chunkSize, t.size - i * t.chunkSize);
  if (data.size !== want) throw new HttpError(400, `chunk ${i} size ${data.size}, expected ${want}`);
  await sleep(Math.min(2500, data.size / (12 * 1024))); // 约 12 MB/s 的上行
  await putData(`chunk:${t.ticket}:${i}`, data);
  return json(200, { receipt: `${t.ticket}.${i}.${data.size}` });
});

// 分批提交: 演示站里聚合回执就是 "f.<组号>.<片号,片号...>"
on('POST', '/uploads/fold', 'write', async (c) => {
  const b = await c.body();
  const t = state().tickets[String(b.ticket ?? '')];
  if (!t) throw new HttpError(403, 'bad ticket');
  const idx = (Array.isArray(b.receipts) ? b.receipts : []).map((r) => Number(String(r).split('.')[1]));
  const groups = new Set(idx.map((i) => Math.floor(i / 256)));
  if (groups.size !== 1) throw new HttpError(400, 'receipts span more than one group');
  const g = [...groups][0];
  const size = Math.min(256, t.chunkCount - g * 256);
  if (new Set(idx).size !== size) throw new HttpError(400, 'missing chunks in group');
  return json(200, { fold: `f.${g}.${idx.join(',')}` });
});

on('POST', '/uploads/commit', 'write', async (c) => {
  const b = await c.body();
  const t = state().tickets[String(b.ticket ?? '')];
  if (!t) throw new HttpError(403, 'bad ticket');
  const folded = (Array.isArray(b.folds) ? b.folds : []).flatMap((f) => String(f).split('.')[2]?.split(',').map(Number) ?? []);
  const got = new Set([...folded, ...(Array.isArray(b.receipts) ? b.receipts : []).map((r) => Number(String(r).split('.')[1]))]);
  const missing = Array.from({ length: t.chunkCount }, (_, i) => i).filter((i) => !got.has(i));
  if (missing.length) throw new HttpError(400, `missing chunks: ${missing.join(',')}`);
  const parts: Blob[] = [];
  for (let i = 0; i < t.chunkCount; i++) {
    const p = await getData(`chunk:${t.ticket}:${i}`);
    if (!p) throw new HttpError(400, `missing chunks: ${i}`);
    parts.push(p);
  }
  const node = await putFile(t.parentId, t.name, new Blob(parts, { type: t.mime ?? '' }), t.mime, t.overwrite);
  for (let i = 0; i < t.chunkCount; i++) await delData(`chunk:${t.ticket}:${i}`);
  delete state().tickets[t.ticket];
  return json(200, { node: publicNode(node), url: fileLink(node) });
});

// 一次性上传: multipart 字段 file (可多个), 或原始 body + ?name=
on('POST', '/upload', 'write', async ({ req, url }) => {
  const parent = mkdirp(url.searchParams.get('path') ?? '/');
  const overwrite = url.searchParams.get('overwrite') === '1';
  const rename = (n: string) => (url.searchParams.get('rename') === '1'
    ? `${new Date().toISOString().slice(0, 10)}-${newId(8)}${n.lastIndexOf('.') > 0 ? n.slice(n.lastIndexOf('.')) : ''}` : n);
  const files: { name: string; data: Blob; mime: string | null }[] = [];
  if ((req.headers.get('Content-Type') ?? '').startsWith('multipart/form-data')) {
    for (const [, v] of (await req.formData()).entries()) if (typeof v !== 'string') files.push({ name: rename(v.name), data: v, mime: v.type || null });
  } else {
    const name = url.searchParams.get('name');
    if (!name) throw new HttpError(400, 'raw upload needs ?name= and Content-Length');
    files.push({ name: rename(name), data: await req.blob(), mime: req.headers.get('Content-Type') });
  }
  if (!files.length) throw new HttpError(400, 'no file');
  const results = [];
  for (const f of files) {
    const node = await putFile(parent.id, f.name, f.data, f.mime, overwrite);
    results.push({ node: publicNode(node), url: fileLink(node) });
  }
  return json(200, { success: true, url: results[0].url, data: results[0], files: results });
});

// ---------------- 分享 ----------------

on('POST', '/shares', 'read', async (c) => {
  const b = await c.body();
  const n = locate(b.id, b.path);
  const id = newId(10);
  state().shares.unshift({ id, nodeId: n.id, password: str(b.password) ?? null, expiresAt: Number(b.expiresIn) ? now() + Number(b.expiresIn) * 1000 : null, createdAt: now() });
  return json(200, { id, url: shareLink(id) });
});

on('GET', '/shares', 'read', () => json(200, {
  items: state().shares.flatMap((s) => {
    const n = state().nodes[s.nodeId];
    return n ? [{ id: s.id, node_id: s.nodeId, name: n.name, expires_at: s.expiresAt, created_at: s.createdAt, has_password: s.password ? 1 : 0 }] : [];
  }),
}));

on('DELETE', '/shares/([^/]+)', 'write', (_c, m) => {
  state().shares = state().shares.filter((s) => s.id !== m[1]);
  return json(200, { ok: true });
});

// ---------------- 管理 ----------------

on('GET', '/admin/stats', 'admin', () => {
  const s = state();
  const alive = Object.values(s.nodes).filter((n) => n.deletedAt === null && n.id !== ROOT);
  const blobs = Object.values(s.blobs);
  return json(200, {
    nodes: (['dir', 'file'] as const).map((kind) => ({ kind, n: alive.filter((n) => n.kind === kind).length })),
    blobs: { n: blobs.length, bytes: blobs.reduce((a, b) => a + b.size, 0) },
    snapshotAt: now(),
    bots: s.bots,
    channels: s.channels,
  });
});

// 演示层的 /me: 返回当前令牌的权限 (scope 写 read, 只要令牌有效)
on('GET', '/me', 'read', ({ scopes }) => json(200, { scopes, rootId: ROOT }));

// 演示数据没有真实分片清单: 按 blob id 哈希把分片分给 Bot 和频道, 只为让拓扑图有东西可看
on('GET', '/admin/topology', 'admin', (c) => {
  const s = state();
  const h = (x: string) => [...x].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) >>> 0, 0);
  const bots = s.bots.filter((b) => b.status === 'active');
  const usage = new Map<string, { c: string; b: string; n: number; bytes: number }>();
  for (const blob of Object.values(s.blobs)) {
    if (!bots.length || !s.channels.length) break;
    const ch = s.channels[h(blob.id) % s.channels.length].id;
    const n = Math.max(1, Math.ceil(blob.size / (19 * 1024 * 1024)));
    for (let i = 0; i < n; i++) {
      const b = bots[h(blob.id + i) % bots.length].id;
      const u = usage.get(`${b}|${ch}`) ?? { c: ch, b, n: 0, bytes: 0 };
      u.n++;
      u.bytes += i < n - 1 ? 19 * 1024 * 1024 : blob.size - (n - 1) * 19 * 1024 * 1024;
      usage.set(`${b}|${ch}`, u);
    }
  }
  const perms: Record<string, string> = {};
  if (c.url.searchParams.get('check') === '1') for (const b of bots) for (const ch of s.channels) if (ch.status !== 'dead') perms[`${b.id}|${ch.id}`] = 'ok';
  // 和服务端一致 (#23): 只在 usage=1 / fresh=1 时给分片统计
  const want = c.url.searchParams.get('usage') === '1' || c.url.searchParams.get('fresh') === '1';
  return json(200, { at: want ? now() : null, bots: s.bots, channels: s.channels, usage: want ? [...usage.values()] : null, perms });
});

const adminCheck = () => Object.fromEntries(state().channels.filter((c) => c.status === 'active').map((c) => [c.id, 'ok']));

on('POST', '/admin/bots', 'admin', async (c) => {
  const token = String((await c.body()).token ?? '');
  if (!/^\d{5,}:[\w-]{10,}$/.test(token)) throw new HttpError(400, 'telegram: Unauthorized (演示模式只校验格式, 形如 123456789:ABCdef...)');
  const id = token.split(':')[0];
  const username = `demo_${id.slice(-4)}_bot`;
  state().bots = [...state().bots.filter((b) => b.id !== id), { id, username, status: 'active', last_error: null }];
  return json(200, { id, username, channels: adminCheck() });
});

on('DELETE', '/admin/bots/([^/]+)', 'admin', ({ url }, m) => {
  const s = state();
  if (url.searchParams.get('force') === '1') s.bots = s.bots.filter((b) => b.id !== m[1]);
  else s.bots.forEach((b) => { if (b.id === m[1]) b.status = 'dead'; });
  return json(200, { ok: true });
});

on('POST', '/admin/channels', 'admin', async (c) => {
  const id = String((await c.body()).id ?? '');
  if (!/^-100\d+$/.test(id)) throw new HttpError(400, 'channel id must look like -100xxxxxxxxxx');
  const s = state();
  if (!s.bots.length) throw new HttpError(400, 'add a bot first');
  const title = `演示频道 ${id.slice(-4)}`;
  s.channels = [...s.channels.filter((x) => x.id !== id), { id, title, status: 'active' }];
  return json(200, { id, title, bots: Object.fromEntries(s.bots.filter((b) => b.status === 'active').map((b) => [b.username ?? b.id, 'ok'])) });
});

on('PATCH', '/admin/channels/([^/]+)', 'admin', async (c, m) => {
  const status = String((await c.body()).status ?? '');
  state().channels.forEach((x) => { if (x.id === decodeURIComponent(m[1])) x.status = status; });
  return json(200, { ok: true });
});

on('POST', '/admin/tokens', 'admin', async (c) => {
  const b = await c.body();
  const scopes = (Array.isArray(b.scopes) ? b.scopes : ['read']).filter((s) => ['read', 'write', 'admin', 'stats'].includes(String(s))).map(String);
  const root = str(b.rootPath) ? mkdirp(String(b.rootPath)) : getNode(ROOT)!;
  const token = `hxd_${newId(32)}`;
  const id = newId();
  state().tokens.unshift({ id, name: String(b.name ?? ''), scopes: scopes.join(','), root_id: root.id, expires_at: Number(b.expiresIn) ? now() + Number(b.expiresIn) * 1000 : null, created_at: now(), token });
  return json(200, { id, token, scopes, root: str(b.rootPath) ?? '/', note: 'token is shown only once' });
});

on('GET', '/admin/tokens', 'admin', () => json(200, { items: state().tokens.map(({ token: _t, ...r }) => r) }));

on('DELETE', '/admin/tokens/([^/]+)', 'admin', (_c, m) => {
  state().tokens = state().tokens.filter((t) => t.id !== m[1]);
  return json(200, { ok: true });
});

on('POST', '/admin/maintenance', 'admin', async () => json(200, await maintenance()));

// ---------------- 入口 ----------------

/** 任意非空令牌都能进; 后台签发的令牌按它自己的权限 */
function scopesOf(req: Request, _url: URL): Scope[] {
  const tok = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '') || '';
  if (!tok) throw new HttpError(401, 'unauthorized');
  const t = state().tokens.find((x) => x.token === tok);
  if (t?.expires_at && t.expires_at < now()) throw new HttpError(401, 'unauthorized');
  return t ? (t.scopes.split(',') as Scope[]) : ['read', 'write', 'admin'];
}

const has = (scopes: Scope[], need: Scope) => scopes.includes('admin') || scopes.includes(need) || (need === 'read' && scopes.includes('write'));

/** 判断地址是否归演示层处理: 同源且路径 (去掉站点子路径后) 以 /api/v1/, /f/, /s/ 开头 */
export function route(href: string): { kind: string; rest: string } | null {
  const url = new URL(href, location.href);
  if (url.origin !== location.origin) return null;
  const p = url.pathname.startsWith(BASE) ? '/' + url.pathname.slice(BASE.length) : url.pathname;
  const kind = /^\/(api\/v1|f|s)\//.exec(p)?.[1];
  return kind ? { kind, rest: p.slice(kind.length + 2) } : null;
}

/** 处理一个已确认归演示层的请求 */
export async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const { kind, rest } = route(req.url)!;
  try {
    await jitter();
    if (kind === 'f') return await servePublicFile(rest, url, req);
    if (kind === 's') return await serveShare(rest, url, req);
    const sub = '/' + rest;
    for (const [method, re, scope, h] of routes) {
      const m = sub.match(re);
      if (!m || !new RegExp(`^${method}$`).test(req.method)) continue;
      const scopes = scopesOf(req, url);
      if (!has(scopes, scope)) throw new HttpError(403, `scope ${scope} required`);
      const res = await h({ req, url, scopes, body: () => req.json().catch(() => ({})) }, m);
      if (req.method !== 'GET' && req.method !== 'HEAD') await save();
      return res;
    }
    throw new HttpError(404, 'not found');
  } catch (e) {
    if (e instanceof HttpError) return json(e.status, { error: e.message }, e.headers);
    return json(500, { error: (e as Error).message || 'internal error' });
  }
}
