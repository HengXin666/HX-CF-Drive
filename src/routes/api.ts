/** REST API v1。所有接口需要 Authorization: Bearer <token> */
import { Hono, type Context } from 'hono';
import type { AppEnv, Env, Principal } from '../env';
import { num } from '../env';
import { r2Key } from '../drivers/r2';
import { activeChannels, allBots, invalidateBotCache, tgCall } from '../drivers/tg';
import { requireScope } from '../lib/auth';
import { signLink } from '../lib/sign';
import {
  assertAccess, getNode, isWithin, listChildren, mkdirp, moveNode, type NodeRow, pathOf, publicNode, resolvePath, restoreNode, trashNode,
} from '../lib/tree';
import { HttpError, newId, now, sha256Hex } from '../lib/util';
import { runMaintenance } from '../services/maintenance';
import { serveNode } from '../services/serve';
import {
  abortUpload, completeUpload, getSession, initUpload, putChunk, receivedIndexes, uploadStream,
} from '../services/upload';

export const api = new Hono<AppEnv>();

type C = Context<AppEnv>;

/** 通过 id 或 path 定位节点, 并检查令牌范围 */
async function locate(c: C, id?: string | null, path?: string | null): Promise<NodeRow> {
  const p = c.get('principal');
  let node: NodeRow | null = null;
  if (id) node = await getNode(c.env, id);
  else node = await resolvePath(c.env, p.rootId, path ?? '/');
  if (!node) throw new HttpError(404, 'not found');
  await assertAccess(c.env, p, node.id);
  return node;
}

async function audit(env: Env, p: Principal, action: string, nodeId: string | null, detail = '') {
  await env.DB.prepare('INSERT INTO audit_log (actor, action, node_id, detail, at) VALUES (?, ?, ?, ?, ?)')
    .bind(p.id, action, nodeId, detail, now())
    .run();
}

export async function fileLink(env: Env, origin: string, node: NodeRow, expiresInSec = 0): Promise<string> {
  // R2 文件 + 配了公开域名: 直接给 R2 地址, 完全不经过 Worker
  if (env.R2_PUBLIC_BASE && node.blob_id && expiresInSec === 0) {
    const b = await env.DB.prepare('SELECT driver FROM blobs WHERE id = ?').bind(node.blob_id).first<{ driver: string }>();
    if (b?.driver === 'r2') return `${env.R2_PUBLIC_BASE.replace(/\/$/, '')}/${r2Key(node.blob_id)}`;
  }
  const exp = expiresInSec > 0 ? Math.floor(Date.now() / 1000) + expiresInSec : 0;
  return `${origin}/f/${node.id}/${encodeURIComponent(node.name)}?${await signLink(env.SIGNING_KEY, node.id, exp)}`;
}

// ---------------- 目录 ----------------

api.get('/fs/list', requireScope('read'), async (c) => {
  const node = await locate(c, c.req.query('id'), c.req.query('path'));
  if (node.kind !== 'dir') return c.json({ node: publicNode(node), children: [] });
  const children = await listChildren(c.env, node.id);
  return c.json({ node: publicNode(node), path: await pathOf(c.env, node.id), children: children.map(publicNode) });
});

api.get('/fs/stat', requireScope('read'), async (c) => {
  const node = await locate(c, c.req.query('id'), c.req.query('path'));
  return c.json({ node: publicNode(node), path: await pathOf(c.env, node.id) });
});

api.post('/fs/mkdir', requireScope('write'), async (c) => {
  const { path } = await c.req.json<{ path: string }>();
  const p = c.get('principal');
  const node = await mkdirp(c.env, p.rootId, path);
  await audit(c.env, p, 'mkdir', node.id, path);
  return c.json({ node: publicNode(node) });
});

api.post('/fs/move', requireScope('write'), async (c) => {
  const b = await c.req.json<{ id?: string; path?: string; toParentId?: string; toPath?: string; name?: string; overwrite?: boolean }>();
  const node = await locate(c, b.id, b.path);
  const target = b.toParentId || b.toPath ? await locate(c, b.toParentId, b.toPath): await getNode(c.env, node.parent_id!);
  if (!target) throw new HttpError(404, 'target not found');
  await moveNode(c.env, node.id, target.id, b.name ?? node.name, !!b.overwrite);
  await audit(c.env, c.get('principal'), 'move', node.id, `${target.id}/${b.name ?? node.name}`);
  return c.json({ node: publicNode((await getNode(c.env, node.id))!) });
});

api.post('/fs/copy', requireScope('write'), async (c) => {
  const b = await c.req.json<{ id?: string; path?: string; toParentId?: string; toPath?: string; name?: string }>();
  const src = await locate(c, b.id, b.path);
  const dst = await locate(c, b.toParentId, b.toPath);
  const node = await copyTree(c.env, src, dst.id, b.name ?? src.name);
  await audit(c.env, c.get('principal'), 'copy', node.id, src.id);
  return c.json({ node: publicNode(node) });
});

/** 复制只复制元数据并增加 blob 引用, 不复制实际数据。最多 2000 个节点 */
export async function copyTree(env: Env, src: NodeRow, parentId: string, name: string): Promise<NodeRow> {
  let budget = 2000;
  const t = now();
  const walk = async (n: NodeRow, pid: string, nm: string): Promise<NodeRow> => {
    if (--budget < 0) throw new HttpError(413, 'copy too large (max 2000 nodes)');
    const id = newId();
    const stmts = [
      env.DB.prepare('INSERT INTO nodes (id, parent_id, name, kind, size, mime, blob_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(id, pid, nm, n.kind, n.size, n.mime, n.blob_id, t, t),
    ];
    if (n.blob_id) stmts.push(env.DB.prepare('UPDATE blobs SET ref_count = ref_count + 1 WHERE id = ?').bind(n.blob_id));
    await env.DB.batch(stmts);
    if (n.kind === 'dir') for (const ch of await listChildren(env, n.id)) await walk(ch, id, ch.name);
    return { ...n, id, parent_id: pid, name: nm, created_at: t, updated_at: t };
  };
  return walk(src, parentId, name);
}

api.post('/fs/delete', requireScope('write'), async (c) => {
  const b = await c.req.json<{ id?: string; path?: string }>();
  const node = await locate(c, b.id, b.path);
  const n = await trashNode(c.env, node.id);
  await audit(c.env, c.get('principal'), 'delete', node.id, node.name);
  return c.json({ trashed: n });
});

api.get('/fs/trash', requireScope('write'), async (c) => {
  const r = await c.env.DB.prepare(
    `SELECT n.* FROM nodes n LEFT JOIN nodes p ON p.id = n.parent_id
     WHERE n.deleted_at IS NOT NULL AND (p.deleted_at IS NULL OR p.deleted_at <> n.deleted_at)
     ORDER BY n.deleted_at DESC LIMIT 200`,
).all<NodeRow>();
  return c.json({ items: r.results.map((n) => ({ ...publicNode(n), deletedAt: n.deleted_at })) });
});

api.post('/fs/restore', requireScope('write'), async (c) => {
  const { id } = await c.req.json<{ id: string }>();
  await restoreNode(c.env, id);
  await audit(c.env, c.get('principal'), 'restore', id);
  return c.json({ ok: true });
});

api.get('/fs/search', requireScope('read'), async (c) => {
  const q = (c.req.query('q') ?? '').trim();
  if (q.length < 1) throw new HttpError(400, 'q required');
  const limit = Math.min(num(c.req.query('limit'), 50), 200);
  const like = `%${q.replace(/[%_\\]/g, (m) => '\\' + m)}%`;
  const r = await c.env.DB.prepare("SELECT * FROM nodes WHERE deleted_at IS NULL AND name LIKE ? ESCAPE '\\' LIMIT ?")
    .bind(like, limit * 2)
    .all<NodeRow>();
  const p = c.get('principal');
  const items = [];
  for (const n of r.results) {
    if (items.length >= limit) break;
    if (p.rootId !== 'root' && !(await isWithin(c.env, n.id, p.rootId))) continue;
    items.push({ ...publicNode(n), path: await pathOf(c.env, n.id) });
  }
  return c.json({ items });
});

api.post('/fs/link', requireScope('read'), async (c) => {
  const b = await c.req.json<{ id?: string; path?: string; expiresIn?: number }>();
  const node = await locate(c, b.id, b.path);
  if (node.kind !== 'file') throw new HttpError(400, 'not a file');
  return c.json({ url: await fileLink(c.env, new URL(c.req.url).origin, node, b.expiresIn ?? 0) });
});

// ---------------- 读取内容 ----------------

api.on(['GET', 'HEAD'], '/files/:id/content', requireScope('read'), async (c) => {
  const node = await locate(c, c.req.param('id'));
  return serveNode(c.env, node, c.req.raw, { download: c.req.query('download') === '1', waitUntil: (p) => c.executionCtx.waitUntil(p) });
});

// ---------------- 上传 ----------------

api.post('/uploads', requireScope('write'), async (c) => {
  const b = await c.req.json<{ parentId?: string; path?: string; name: string; size: number; mime?: string; sha256?: string; backend?: string; overwrite?: boolean; mkdirs?: boolean }>();
  const p = c.get('principal');
  let parent: NodeRow;
  if (b.parentId) parent = await locate(c, b.parentId);
  else if (b.mkdirs !== false) parent = await mkdirp(c.env, p.rootId, b.path ?? '/');
  else parent = await locate(c, null, b.path ?? '/');
  const r = await initUpload(c.env, p, { parentId: parent.id, name: b.name, size: b.size, mime: b.mime, sha256: b.sha256, backend: b.backend, overwrite: b.overwrite });
  if (r.done) return c.json({ done: true, node: publicNode(r.node), url: await fileLink(c.env, new URL(c.req.url).origin, r.node) });
  return c.json(r);
});

api.get('/uploads/:id', requireScope('write'), async (c) => {
  const s = await getSession(c.env, c.req.param('id')!);
  return c.json({ uploadId: s.id, driver: s.driver, chunkSize: s.chunk_size, chunkCount: s.chunk_count, received: await receivedIndexes(c.env, s.blob_id) });
});

api.put('/uploads/:id/:idx', requireScope('write'), async (c) => {
  const s = await getSession(c.env, c.req.param('id')!);
  const body = await c.req.arrayBuffer();
  await putChunk(c.env, s, Number(c.req.param('idx')), body);
  return c.json({ ok: true });
});

api.post('/uploads/:id/complete', requireScope('write'), async (c) => {
  const s = await getSession(c.env, c.req.param('id')!);
  const node = await completeUpload(c.env, c.get('principal'), s);
  return c.json({ node: publicNode(node), url: await fileLink(c.env, new URL(c.req.url).origin, node) });
});

api.delete('/uploads/:id', requireScope('write'), async (c) => {
  await abortUpload(c.env, await getSession(c.env, c.req.param('id')!));
  return c.json({ ok: true });
});

/**
 * 一次性上传 (≤ 100MB, 图床/PicGo/ShareX 用)
 * - multipart/form-data: 字段 file (可多个字段名为 file), 可选 path
 * - 其他 Content-Type: 原始 body, 必须带 ?name= 和 Content-Length
 */
api.post('/upload', requireScope('write'), async (c) => {
  const p = c.get('principal');
  const origin = new URL(c.req.url).origin;
  const path = c.req.query('path') ?? '/';
  const ct = c.req.header('Content-Type') ?? '';
  const overwrite = c.req.query('overwrite') === '1';
  const backend = c.req.query('backend');
  const parent = await mkdirp(c.env, p.rootId, path);
  const results = [];
  if (ct.startsWith('multipart/form-data')) {
    const form = await c.req.formData();
    for (const [, v] of form.entries()) {
      if (typeof v === 'string') continue;
      const f = v as File;
      const name = c.req.query('rename') === '1' ? renameRandom(f.name): f.name;
      const node = await uploadStream(c.env, p, { parentId: parent.id, name, size: f.size, mime: f.type || undefined, overwrite, backend }, f.stream());
      results.push({ node: publicNode(node), url: await fileLink(c.env, origin, node) });
    }
  } else {
    const name = c.req.query('name');
    const len = Number(c.req.header('Content-Length'));
    if (!name || !Number.isFinite(len)) throw new HttpError(400, 'raw upload needs ?name= and Content-Length');
    const node = await uploadStream(c.env, p, { parentId: parent.id, name, size: len, mime: ct || undefined, overwrite, backend }, c.req.raw.body!);
    results.push({ node: publicNode(node), url: await fileLink(c.env, origin, node) });
  }
  if (results.length === 0) throw new HttpError(400, 'no file');
  // 兼容 PicGo 自定义 Web 图床插件: 取 data.url / url
  return c.json({ success: true, url: results[0].url, data: results[0], files: results });
});

function renameRandom(name: string): string {
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot): '';
  return `${new Date().toISOString().slice(0, 10)}-${newId(8)}${ext}`;
}

// ---------------- 分享 ----------------

api.post('/shares', requireScope('read'), async (c) => {
  const b = await c.req.json<{ id?: string; path?: string; password?: string; expiresIn?: number }>();
  const node = await locate(c, b.id, b.path);
  const id = newId(10);
  await c.env.DB.prepare('INSERT INTO shares (id, node_id, password_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(id, node.id, b.password ? await sha256Hex(`${id}:${b.password}`): null, b.expiresIn ? now() + b.expiresIn * 1000 : null, now())
    .run();
  return c.json({ id, url: `${new URL(c.req.url).origin}/s/${id}` });
});

api.get('/shares', requireScope('read'), async (c) => {
  const r = await c.env.DB.prepare(
    'SELECT s.id, s.node_id, s.expires_at, s.download_count, s.created_at, n.name, (s.password_hash IS NOT NULL) AS has_password FROM shares s JOIN nodes n ON n.id = s.node_id ORDER BY s.created_at DESC LIMIT 200',
).all();
  return c.json({ items: r.results });
});

api.delete('/shares/:id', requireScope('write'), async (c) => {
  await c.env.DB.prepare('DELETE FROM shares WHERE id = ?').bind(c.req.param('id')).run();
  return c.json({ ok: true });
});

// ---------------- 管理 ----------------

api.get('/admin/stats', requireScope('admin'), async (c) => {
  const [nodes, blobs, chunks, bots, channels] = await c.env.DB.batch([
    c.env.DB.prepare("SELECT kind, COUNT(*) AS n FROM nodes WHERE deleted_at IS NULL GROUP BY kind"),
    c.env.DB.prepare("SELECT driver, COUNT(*) AS n, COALESCE(SUM(size),0) AS bytes FROM blobs WHERE status = 'ready' GROUP BY driver"),
    c.env.DB.prepare('SELECT COUNT(*) AS n FROM chunks'),
    c.env.DB.prepare('SELECT id, username, status, fail_count, retry_until, last_error FROM bots'),
    c.env.DB.prepare('SELECT * FROM channels'),
  ]);
  const limiter = await c.env.LIMITER.get(c.env.LIMITER.idFromName('global')).snapshot();
  return c.json({ nodes: nodes.results, blobs: blobs.results, chunks: chunks.results[0], bots: bots.results, channels: channels.results, limiter });
});

api.post('/admin/bots', requireScope('admin'), async (c) => {
  const { token } = await c.req.json<{ token: string }>();
  const me = await tgCall<{ id: number; username: string; is_bot: boolean }>(token, 'getMe');
  await c.env.DB.prepare('INSERT OR REPLACE INTO bots (id, token, username, status, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(String(me.id), token, me.username, 'active', now())
    .run();
  invalidateBotCache();
  // 检查它在每个频道里是不是管理员
  const check: Record<string, string> = {};
  for (const ch of await activeChannels(c.env)) check[ch] = await adminStatus(token, ch, me.id);
  return c.json({ id: String(me.id), username: me.username, channels: check });
});

api.delete('/admin/bots/:id', requireScope('admin'), async (c) => {
  const used = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM chunks WHERE bot_id = ?').bind(c.req.param('id')).first<{ n: number }>();
  if (used && used.n > 0 && c.req.query('force') !== '1') {
    // 仍有分片绑在这个 Bot 上: 改为 dead, 读取时会自动换 Bot 重绑
    await c.env.DB.prepare("UPDATE bots SET status = 'dead' WHERE id = ?").bind(c.req.param('id')).run();
    invalidateBotCache();
    return c.json({ ok: true, note: `bot still owns ${used.n} chunks; marked dead instead of deleting. Use ?force=1 to delete.` });
  }
  await c.env.DB.prepare('DELETE FROM bots WHERE id = ?').bind(c.req.param('id')).run();
  invalidateBotCache();
  return c.json({ ok: true });
});

api.post('/admin/channels', requireScope('admin'), async (c) => {
  const { id } = await c.req.json<{ id: string }>();
  if (!/^-100\d+$/.test(id)) throw new HttpError(400, 'channel id must look like -100xxxxxxxxxx');
  const bots = await allBots(c.env);
  if (bots.length === 0) throw new HttpError(400, 'add a bot first');
  const chat = await tgCall<{ title?: string; type: string }>(bots[0].token, 'getChat', { chat_id: id });
  if (chat.type !== 'channel') throw new HttpError(400, `chat type is ${chat.type}, expected channel`);
  const check: Record<string, string> = {};
  for (const b of bots) check[b.username ?? b.id] = await adminStatus(b.token, id, Number(b.id));
  await c.env.DB.prepare('INSERT OR REPLACE INTO channels (id, title, status, created_at) VALUES (?, ?, ?, ?)').bind(id, chat.title ?? '', 'active', now()).run();
  return c.json({ id, title: chat.title, bots: check });
});

api.patch('/admin/channels/:id', requireScope('admin'), async (c) => {
  const { status } = await c.req.json<{ status: 'active' | 'readonly' | 'dead' }>();
  await c.env.DB.prepare('UPDATE channels SET status = ? WHERE id = ?').bind(status, c.req.param('id')).run();
  return c.json({ ok: true });
});

async function adminStatus(token: string, chatId: string, botId: number): Promise<string> {
  try {
    const m = await tgCall<{ status: string; can_post_messages?: boolean; can_delete_messages?: boolean }>(token, 'getChatMember', { chat_id: chatId, user_id: botId });
    if (m.status !== 'administrator' && m.status !== 'creator') return `NOT ADMIN (${m.status})`;
    if (m.can_post_messages === false) return 'admin but cannot post';
    if (m.can_delete_messages === false) return 'ok (cannot delete: trash purge will leave messages)';
    return 'ok';
  } catch (e) {
    return `error: ${(e as Error).message}`;
  }
}

api.post('/admin/tokens', requireScope('admin'), async (c) => {
  const b = await c.req.json<{ name: string; scopes?: string[]; rootPath?: string; expiresIn?: number }>();
  const scopes = (b.scopes ?? ['read']).filter((s) => ['read', 'write', 'admin'].includes(s));
  const root = b.rootPath ? await mkdirp(c.env, 'root', b.rootPath): await getNode(c.env, 'root');
  const plain = `hxd_${newId(32)}`;
  const id = newId();
  await c.env.DB.prepare('INSERT INTO tokens (id, name, token_hash, scopes, root_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(id, b.name, await sha256Hex(plain), scopes.join(','), root!.id, b.expiresIn ? now() + b.expiresIn * 1000 : null, now())
    .run();
  return c.json({ id, token: plain, scopes, root: b.rootPath ?? '/', note: 'token is shown only once' });
});

api.get('/admin/tokens', requireScope('admin'), async (c) => {
  const r = await c.env.DB.prepare('SELECT id, name, scopes, root_id, expires_at, created_at, last_used_at FROM tokens ORDER BY created_at DESC').all();
  return c.json({ items: r.results });
});

api.delete('/admin/tokens/:id', requireScope('admin'), async (c) => {
  await c.env.DB.prepare('DELETE FROM tokens WHERE id = ?').bind(c.req.param('id')).run();
  return c.json({ ok: true });
});

api.post('/admin/maintenance', requireScope('admin'), async (c) => c.json(await runMaintenance(c.env)));

api.get('/admin/audit', requireScope('admin'), async (c) => {
  const r = await c.env.DB.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').bind(Math.min(num(c.req.query('limit'), 100), 500)).all();
  return c.json({ items: r.results });
});

