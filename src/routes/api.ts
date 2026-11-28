/** REST API v1。所有接口需要 Authorization: Bearer <token> */
import { Hono, type Context } from 'hono';
import type { AppEnv, Env } from '../env';
import { num, publicOrigin } from '../env';
import { activeChannels, allBots, invalidateBotCache, invalidateChannelCache, tgCall } from '../drivers/tg';
import { forgetToken, requireScope } from '../lib/auth';
import { signLink } from '../lib/sign';
import {
  assertAccess, getNode, getNodeAccessCached, getNodeWithAncestors, listChildren, listChildrenPage, mkdirp, moveNode, type NodeRow, pathFor, pathsOf, publicNode, resolvePath, trashNode,
  pathsOfIds, subtree,
} from '../lib/tree';
import { HttpError, newId, now, sha256Hex } from '../lib/util';
import { runMaintenance } from '../services/maintenance';
import { cachedStats, invalidateStats, liveUsage, putStats, STAT_KEYS, usageFromCounters } from '../services/stats';
import { ensureParts, IMMUTABLE, loadBlob, serveNode } from '../services/serve';
import { commitUpload, foldReceipts, initUpload, openTicket, openTicketBare, putChunk, uploadStream } from '../services/upload';
import { trash } from './trash';

export const api = new Hono<AppEnv>();

type C = Context<AppEnv>;

/** 通过 id 或 path 定位节点, 并检查令牌范围 */
async function locate(c: C, id?: string | null, path?: string | null): Promise<NodeRow> {
  const p = c.get('principal');
  if (!id) {
    // 从令牌根解析的路径天然在根之下, 不用再查祖先
    const node = await resolvePath(c.env, p.rootId, path ?? '/');
    if (!node) throw new HttpError(404, 'not found');
    return node;
  }
  // getNode 本来就读出了整条祖先链, 权限直接查这个集合 (以前再发一次 isWithin)
  const a = await getNodeWithAncestors(c.env, id);
  if (!a) throw new HttpError(404, 'not found');
  await assertAccess(c.env, p, a.node.id, a.ancestors);
  return a.node;
}

/**
 * 签名直链。有过期时间的链接带上内容版本 v (不参与签名): 内容没变时 /f 按剩余有效期给浏览器缓存, 覆盖上传后 v 对不上就不缓存。
 * 永久直链不带 v, 保持地址稳定 (用户会拿去贴到别处)。
 */
export async function fileLink(env: Env, origin: string, node: NodeRow, expiresInSec = 0, tid = 'admin'): Promise<string> {
  const exp = expiresInSec > 0 ? Math.floor(Date.now() / 1000) + expiresInSec : 0;
  const v = exp && node.blob_id ? `&v=${encodeURIComponent(node.blob_id)}` : '';
  return `${origin}/f/${node.id}/${encodeURIComponent(node.name)}?${await signLink(env.SIGNING_KEY, node.id, exp, tid)}${v}`;
}

/** 当前令牌签的直链 */
const linkFor = (c: C, node: NodeRow, expiresInSec = 0) => fileLink(c.env, publicOrigin(c.env, c.req.url), node, expiresInSec, c.get('principal').id);

// ---------------- 目录 ----------------

/**
 * 列目录。不带 limit: 全部子项, 目录在前按名字排序 (原行为)。
 * 带 limit (1~1000): 分页, 按名字字节序, ?after=<上一页的 next> 取下一页, 每页只读 limit + 1 行。
 */
api.get('/fs/list', requireScope('read'), async (c) => {
  const node = await locate(c, c.req.query('id'), c.req.query('path'));
  if (node.kind !== 'dir') return c.json({ node: publicNode(node), children: [] });
  const limit = c.req.query('limit');
  if (limit !== undefined) {
    const n = Math.min(Math.max(Math.floor(Number(limit)) || 0, 1), 1000);
    const page = await listChildrenPage(c.env, node.id, n, c.req.query('after') ?? '');
    return c.json({ node: publicNode(node), path: await pathFor(c.env, node), children: page.items.map(publicNode), next: page.next });
  }
  const children = await listChildren(c.env, node.id);
  return c.json({ node: publicNode(node), path: await pathFor(c.env, node), children: children.map(publicNode) });
});

api.get('/fs/stat', requireScope('read'), async (c) => {
  const node = await locate(c, c.req.query('id'), c.req.query('path'));
  return c.json({ node: publicNode(node), path: await pathFor(c.env, node) });
});

api.post('/fs/mkdir', requireScope('write'), async (c) => {
  const { path } = await c.req.json<{ path: string }>();
  const p = c.get('principal');
  const node = await mkdirp(c.env, p.rootId, path);
  return c.json({ node: publicNode(node) });
});

api.post('/fs/move', requireScope('write'), async (c) => {
  const b = await c.req.json<{ id?: string; path?: string; toParentId?: string; toPath?: string; name?: string; overwrite?: boolean }>();
  const node = await locate(c, b.id, b.path);
  const target = b.toParentId || b.toPath ? await locate(c, b.toParentId, b.toPath): await getNode(c.env, node.parent_id!);
  if (!target) throw new HttpError(404, 'target not found');
  await moveNode(c.env, node.id, target.id, b.name ?? node.name, !!b.overwrite);
  return c.json({ node: publicNode((await getNode(c.env, node.id))!) });
});

api.post('/fs/copy', requireScope('write'), async (c) => {
  const b = await c.req.json<{ id?: string; path?: string; toParentId?: string; toPath?: string; name?: string }>();
  const src = await locate(c, b.id, b.path);
  const dst = await locate(c, b.toParentId, b.toPath);
  const node = await copyTree(c.env, src, dst.id, b.name ?? src.name);
  return c.json({ node: publicNode(node) });
});

/** 复制只复制元数据并增加 blob 引用, 不复制实际数据。最多 COPY_MAX 个节点 */
export const COPY_MAX = 2000;
/** 每条 INSERT 带多少行 (整批作为一个 JSON 参数, 不受 D1 每条 100 个绑定参数的限制) */
const COPY_ROWS_PER_STMT = 200;

/**
 * 一次读出整棵子树, 在内存里生成新 id 与父子映射, 再用一个 batch (事务) 写完 (#23):
 * - 节点每 200 行一条 INSERT ... SELECT FROM json_each(?)
 * - 引用计数按 blob 聚合成一条 UPDATE
 * 复制 2000 个节点约 12 次查询 (原来每个节点 1 次 batch + 每个目录 1 次 list, 串行, 会超出单次调用的查询数上限)。
 * batch 是事务, 中途失败整体回滚, 不会留下半棵树。
 */
export async function copyTree(env: Env, src: NodeRow, parentId: string, name: string): Promise<NodeRow> {
  const rows = src.kind === 'dir' ? await subtree(env, src.id, COPY_MAX + 1) : [src];
  if (rows.length > COPY_MAX) throw new HttpError(413, `copy too large (max ${COPY_MAX} nodes)`);
  const t = now();
  const ids = new Map<string, string>();
  for (const n of rows) ids.set(n.id, newId());
  const refs = new Map<string, number>();
  const values = rows.map((n) => {
    if (n.blob_id) refs.set(n.blob_id, (refs.get(n.blob_id) ?? 0) + 1);
    const top = n.id === src.id;
    return [ids.get(n.id), top ? parentId : ids.get(n.parent_id!), top ? name : n.name, n.kind, n.size, n.mime, n.blob_id];
  });
  const stmts: D1PreparedStatement[] = [];
  for (let i = 0; i < values.length; i += COPY_ROWS_PER_STMT) {
    stmts.push(env.DB.prepare(
      `INSERT INTO nodes (id, parent_id, name, kind, size, mime, blob_id, created_at, updated_at)
       SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'), json_extract(value, '$[3]'),
              json_extract(value, '$[4]'), json_extract(value, '$[5]'), json_extract(value, '$[6]'), ?2, ?2
       FROM json_each(?1)`,
    ).bind(JSON.stringify(values.slice(i, i + COPY_ROWS_PER_STMT)), t));
  }
  if (refs.size) {
    stmts.push(env.DB.prepare(
      `UPDATE blobs SET ref_count = ref_count + j.n
       FROM (SELECT json_extract(value, '$[0]') AS id, json_extract(value, '$[1]') AS n FROM json_each(?1)) AS j
       WHERE blobs.id = j.id`,
    ).bind(JSON.stringify([...refs])));
  }
  try {
    await env.DB.batch(stmts);
  } catch (e) {
    // 只有顶层可能重名 (子项都挂在新 id 下)
    if (/UNIQUE/i.test(String(e))) throw new HttpError(409, 'target exists');
    throw e;
  }
  return { ...src, id: ids.get(src.id)!, parent_id: parentId, name, created_at: t, updated_at: t, deleted_at: null };
}

api.post('/fs/delete', requireScope('write'), async (c) => {
  const b = await c.req.json<{ id?: string; path?: string }>();
  const node = await locate(c, b.id, b.path);
  const n = await trashNode(c.env, node.id);
  return c.json({ trashed: n });
});

// 回收站: 列表, 恢复, 彻底删除, 清空
api.route('/fs', trash);

/** 模糊搜索会扫全表 (读行数 ≈ 文件总数), 按令牌限频。计数在 isolate 内存里, 不耗额度 */
const searchHits = new Map<string, number[]>();
function searchAllowed(who: string, perMin: number): boolean {
  const t = now();
  const list = (searchHits.get(who) ?? []).filter((x) => t - x < 60_000);
  if (list.length >= perMin) return false;
  list.push(t);
  searchHits.set(who, list);
  return true;
}

api.get('/fs/search', requireScope('read'), async (c) => {
  if (!searchAllowed(c.get('principal').id, num(c.env.SEARCH_PER_MIN, 6))) throw new HttpError(429, 'search rate limited', { 'Retry-After': '10' });
  const q = (c.req.query('q') ?? '').trim();
  if (q.length < 1) throw new HttpError(400, 'q required');
  const limit = Math.min(num(c.req.query('limit'), 50), 200);
  const like = `%${q.replace(/[%_\\]/g, (m) => '\\' + m)}%`;
  // 受限令牌只在自己的子树里搜: 先全表 LIMIT 再过滤会被别人的文件挤掉, 一条结果都拿不到
  const r = c.get('principal').rootId === 'root'
    ? await c.env.DB.prepare("SELECT * FROM nodes WHERE deleted_at IS NULL AND name LIKE ? ESCAPE '\\' LIMIT ?").bind(like, limit).all<NodeRow>()
    : await c.env.DB.prepare(
      `WITH RECURSIVE sub(id) AS (
         SELECT ?1 UNION ALL SELECT n.id FROM nodes n JOIN sub ON n.parent_id = sub.id WHERE n.deleted_at IS NULL AND n.kind = 'dir' LIMIT 20000
       ) SELECT n.* FROM nodes n JOIN sub ON n.parent_id = sub.id WHERE n.deleted_at IS NULL AND n.name LIKE ?2 ESCAPE '\\' LIMIT ?3`,
    ).bind(c.get('principal').rootId, like, limit).all<NodeRow>();
  // 路径和权限一次批量查完, 不再每条结果查一次
  const p = c.get('principal');
  const paths = await pathsOf(c.env, r.results);
  const items = [];
  for (const n of r.results) {
    if (items.length >= limit) break;
    const e = paths.get(n.id);
    if (!e || e.dead || (p.rootId !== 'root' && !e.ancestors.has(p.rootId))) continue;
    items.push({ ...publicNode(n), path: e.path });
  }
  return c.json({ items });
});

api.post('/fs/link', requireScope('read'), async (c) => {
  const b = await c.req.json<{ id?: string; path?: string; expiresIn?: number }>();
  const node = await locate(c, b.id, b.path);
  if (node.kind !== 'file') throw new HttpError(400, 'not a file');
  return c.json({ url: await linkFor(c, node, b.expiresIn ?? 0) });
});

/**
 * 分片清单 (只读): 每片的 Bot, TG file_id, 大小。持有对应 Bot 令牌的客户端 (如 AIOA 主人的手机) 可以直接从 TG 并发拉取,
 * 字节不经过 Worker。file_id 只对上传它的 Bot 有效, 没有 Bot 令牌拿到也下不了, 所以和读内容同权限 (read, 只限自己的子树)。
 */
api.get('/fs/manifest', requireScope('read'), async (c) => {
  const node = await locate(c, c.req.query('id'), c.req.query('path'));
  if (node.kind !== 'file' || !node.blob_id) throw new HttpError(400, 'not a file');
  const b = await loadBlob(c.env, node.blob_id);
  const count = Math.max(1, Math.ceil(b.size / b.chunkSize));
  await ensureParts(c.env, b, 0, count - 1);
  const chunks = [];
  for (let i = 0; i < count && b.size > 0; i++) {
    const r = b.refs[i];
    if (!r) throw new HttpError(500, 'manifest incomplete');
    chunks.push({ bot: r.b, fileId: r.f, size: r.s });
  }
  return c.json({ id: node.id, size: b.size, chunkSize: b.chunkSize, chunks });
});

// ---------------- 读取内容 ----------------

api.on(['GET', 'HEAD'], '/files/:id/content', requireScope('read'), async (c) => {
  const a = await getNodeAccessCached(c.env, c.req.param('id')!);
  if (!a) throw new HttpError(404, 'not found');
  await assertAccess(c.env, c.get('principal'), a.node.id, a.ancestors);
  const node = a.node;
  // ?v= 是当前版本: 同一个 URL 的内容永远不变, 浏览器可以一直用缓存 (覆盖上传后版本变了, URL 跟着变)
  const fresh = !!node.blob_id && c.req.query('v') === node.blob_id;
  return serveNode(c.env, node, c.req.raw, {
    download: c.req.query('download') === '1',
    cacheControl: fresh ? IMMUTABLE : undefined,
    waitUntil: (p) => c.executionCtx.waitUntil(p),
  });
});

// ---------------- 上传 ----------------

/** 第 1 步: 申请上传。带 sha256 时可能直接秒传完成 */
api.post('/uploads', requireScope('write'), async (c) => {
  const b = await c.req.json<{ parentId?: string; path?: string; name: string; size: number; mime?: string; sha256?: string; overwrite?: boolean; mkdirs?: boolean }>();
  const p = c.get('principal');
  let parent: NodeRow;
  if (b.parentId) parent = await locate(c, b.parentId);
  else if (b.mkdirs !== false) parent = await mkdirp(c.env, p.rootId, b.path ?? '/');
  else parent = await locate(c, null, b.path ?? '/');
  const r = await initUpload(c.env, p, { parentId: parent.id, parent, name: b.name, size: b.size, mime: b.mime, sha256: b.sha256, overwrite: b.overwrite });
  if (r.done) return c.json({ done: true, node: publicNode(r.node), url: await linkFor(c, r.node) });
  // chunkUrl: 公网分片地址, 只凭票据就能传 (v0.4); 调用方据此判断能否让客户端直传
  return c.json({ ...r, chunkUrl: `${publicOrigin(c.env, c.req.url)}/api/v1/uploads/chunk` });
});

/**
 * 第 2 步: 上传分片, 请求体是原始字节。?ticket=...&i=序号。返回回执, 客户端自己保存。
 * 带令牌时校验令牌与票据属于同一令牌; 不带 Authorization 时只凭票据 (v0.4, 见 openTicketBare)。
 */
// 只要带了 Authorization (哪怕是空的或格式不对) 就按令牌校验, 坏令牌照样 401, 不退回只凭票据
api.put('/uploads/chunk', async (c, next) => (c.req.raw.headers.has('Authorization') ? requireScope('write')(c, next) : next()), async (c) => {
  const sealed = c.req.query('ticket') ?? '';
  const p = c.get('principal');
  const t = p ? await openTicket(c.env, p, sealed) : await openTicketBare(c.env, sealed);
  const len = Number(c.req.header('Content-Length'));
  if (!Number.isFinite(len) || !c.req.raw.body) throw new HttpError(411, 'Content-Length required');
  const receipt = await putChunk(c.env, t, Number(c.req.query('i')), c.req.raw.body, len);
  return c.json({ receipt });
});

/**
 * 可选: 大文件每凑满一组 256 片 (按 256 对齐, 最后一组可以不足), 把这组回执换成一个聚合回执 { ticket, receipts } → { fold }。
 * commit 时交聚合回执, 验签只要一次 HMAC, 避免几千片在一次请求里验签超时。
 */
api.post('/uploads/fold', requireScope('write'), async (c) => {
  const b = await c.req.json<{ ticket: string; receipts: string[] }>();
  const t = await openTicket(c.env, c.get('principal'), b.ticket);
  return c.json({ fold: await foldReceipts(c.env, t, b.receipts ?? []) });
});

/** 第 3 步: 提交 { ticket, receipts: [...], folds?: [...] }。folds 覆盖的组不需要再给零散回执 */
api.post('/uploads/commit', requireScope('write'), async (c) => {
  const b = await c.req.json<{ ticket: string; receipts?: string[]; folds?: string[] }>();
  const t = await openTicket(c.env, c.get('principal'), b.ticket);
  const node = await commitUpload(c.env, t, b.receipts ?? [], b.folds ?? []);
  return c.json({ node: publicNode(node), url: await linkFor(c, node) });
});

/**
 * 一次性上传 (≤ 100MB, 图床/PicGo/ShareX 用)
 * - multipart/form-data: 字段 file (可多个字段名为 file), 可选 path
 * - 其他 Content-Type: 原始 body, 必须带 ?name= 和 Content-Length
 */
api.post('/upload', requireScope('write'), async (c) => {
  const p = c.get('principal');
  const path = c.req.query('path') ?? '/';
  const ct = c.req.header('Content-Type') ?? '';
  const overwrite = c.req.query('overwrite') === '1';
  const parent = await mkdirp(c.env, p.rootId, path);
  const results = [];
  if (ct.startsWith('multipart/form-data')) {
    const form = await c.req.formData();
    for (const [, v] of form.entries()) {
      if (typeof v === 'string') continue;
      const f = v as File;
      const name = c.req.query('rename') === '1' ? renameRandom(f.name): f.name;
      const node = await uploadStream(c.env, p, { parentId: parent.id, parent, name, size: f.size, mime: f.type || undefined, overwrite }, f.stream());
      results.push({ node: publicNode(node), url: await linkFor(c, node) });
    }
  } else {
    const name = c.req.query('name');
    const len = Number(c.req.header('Content-Length'));
    if (!name || !Number.isFinite(len)) throw new HttpError(400, 'raw upload needs ?name= and Content-Length');
    const node = await uploadStream(c.env, p, { parentId: parent.id, parent, name, size: len, mime: ct || undefined, overwrite }, c.req.raw.body ?? new ReadableStream({ start: (ctl) => ctl.close() }));
    results.push({ node: publicNode(node), url: await linkFor(c, node) });
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
  await c.env.DB.prepare('INSERT INTO shares (id, node_id, password_hash, expires_at, created_at, token_id) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, node.id, b.password ? await sha256Hex(`${id}:${b.password}`): null, b.expiresIn ? now() + b.expiresIn * 1000 : null, now(), c.get('principal').id)
    .run();
  return c.json({ id, url: `${publicOrigin(c.env, c.req.url)}/s/${id}` });
});

/** 分享列表按令牌范围隔离: 受限令牌只看得到自己根目录下的分享 (分享 id 就是公开访问凭证, 不能泄露给别的令牌) */
api.get('/shares', requireScope('read'), async (c) => {
  const p = c.get('principal');
  if (p.rootId === 'root') {
    const r = await c.env.DB.prepare(
      'SELECT s.id, s.node_id, s.expires_at, s.created_at, n.name, (s.password_hash IS NOT NULL) AS has_password FROM shares s JOIN nodes n ON n.id = s.node_id ORDER BY s.created_at DESC LIMIT 200',
    ).all();
    return c.json({ items: r.results });
  }
  const r = await c.env.DB.prepare(
    `WITH RECURSIVE sub(id) AS (
       SELECT ?1 UNION ALL SELECT n.id FROM nodes n JOIN sub ON n.parent_id = sub.id WHERE n.deleted_at IS NULL LIMIT 20000
     ) SELECT s.id, s.node_id, s.expires_at, s.created_at, n.name, (s.password_hash IS NOT NULL) AS has_password
       FROM shares s JOIN sub ON sub.id = s.node_id JOIN nodes n ON n.id = s.node_id ORDER BY s.created_at DESC LIMIT 200`,
  ).bind(p.rootId).all();
  return c.json({ items: r.results });
});

api.delete('/shares/:id', requireScope('write'), async (c) => {
  const s = await c.env.DB.prepare('SELECT node_id FROM shares WHERE id = ?').bind(c.req.param('id')).first<{ node_id: string }>();
  if (!s) throw new HttpError(404, 'share not found');
  await assertAccess(c.env, c.get('principal'), s.node_id);
  await c.env.DB.prepare('DELETE FROM shares WHERE id = ?').bind(c.req.param('id')).run();
  return c.json({ ok: true });
});

// ---------------- 管理 ----------------

/** 用量与健康。`stats` scope 只读这一个接口, 给别的服务 (如 AIOA 额度页) 用, 不必发管理员令牌。
 * 节点数和总字节数读维护任务写的快照 (见 services/stats.ts), 不再每次全表扫描 */
api.get('/admin/stats', requireScope('stats'), async (c) => {
  const isAdmin = c.get('principal').scopes.has('admin');
  const hit = cachedStats(isAdmin);
  if (hit) return c.json(hit);
  const [bots, channels, counters] = await c.env.DB.batch([
    c.env.DB.prepare('SELECT id, username, status, last_error FROM bots'),
    c.env.DB.prepare('SELECT * FROM channels'),
    c.env.DB.prepare('SELECT name, n FROM counters'),
  ]);
  const all = Object.fromEntries((counters.results as { name: string; n: number }[]).map((r) => [r.name, r.n]));
  const usage = usageFromCounters(all) ?? (await liveUsage(c.env));
  const body = {
    nodes: usage.nodes,
    blobs: usage.blobs,
    /** 统计时间 (毫秒)。最多滞后一个维护周期 (6 小时) */
    snapshotAt: usage.at,
    // Bot 的报错和频道细节只给管理员
    bots: isAdmin ? bots.results : (bots.results as { status: string }[]).map((b) => ({ status: b.status })),
    channels: isAdmin ? channels.results : channels.results.length,
    counters: Object.fromEntries(Object.entries(all).filter(([k]) => !(STAT_KEYS as readonly string[]).includes(k))),
  };
  putStats(isAdmin, body);
  return c.json(body);
});

/** 当前令牌的权限与根目录。前端据此决定要不要请求管理接口 (不是管理员就不发, 省一个必然 403 的请求) */
api.get('/me', requireScope(), (c) => {
  const p = c.get('principal');
  return c.json({ scopes: [...p.scopes], rootId: p.rootId });
});

api.post('/admin/bots', requireScope('admin'), async (c) => {
  const { token } = await c.req.json<{ token: string }>();
  const me = await tgCall<{ id: number; username: string; is_bot: boolean }>(token, 'getMe');
  await c.env.DB.prepare('INSERT OR REPLACE INTO bots (id, token, username, status, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(String(me.id), token, me.username, 'active', now())
    .run();
  invalidateBotCache();
  invalidateStats();
  // 检查它在每个频道里是不是管理员
  const check: Record<string, string> = {};
  for (const ch of await activeChannels(c.env)) check[ch] = await adminStatus(token, ch, me.id);
  return c.json({ id: String(me.id), username: me.username, channels: check });
});

api.delete('/admin/bots/:id', requireScope('admin'), async (c) => {
  // 默认只标记 dead: 它上传的分片读取时会自动换 Bot 重绑。?force=1 才真正删除
  const sql = c.req.query('force') === '1' ? 'DELETE FROM bots WHERE id = ?' : "UPDATE bots SET status = 'dead' WHERE id = ?";
  await c.env.DB.prepare(sql).bind(c.req.param('id')).run();
  invalidateBotCache();
  invalidateStats();
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
  invalidateChannelCache();
  invalidateStats();
  return c.json({ id, title: chat.title, bots: check });
});

api.patch('/admin/channels/:id', requireScope('admin'), async (c) => {
  const { status } = await c.req.json<{ status: 'active' | 'readonly' | 'dead' }>();
  await c.env.DB.prepare('UPDATE channels SET status = ? WHERE id = ?').bind(status, c.req.param('id')).run();
  invalidateChannelCache();
  invalidateStats();
  return c.json({ ok: true });
});

/**
 * Bot 与频道的拓扑 (后台 SVG 图用)。
 * 上传时 Bot 和频道各自按哈希从池里选, 任何可用 Bot 都可能写任何 active 频道, 所以连线就是 Bot 池 x 频道池;
 * 这里补上每条线实际存了多少分片 (从清单里数), 以及 ?check=1 时每对的管理员权限。
 * 分片统计扫全部清单, isolate 内缓存 10 分钟; 权限检查每对 1 次 getChatMember, 受 SUBREQ_BUDGET 限制, 超出的标为 unchecked。
 */
type Usage = { c: string; b: string; n: number; bytes: number };
let topoCache: { at: number; usage: Usage[] } | null = null;

api.get('/admin/topology', requireScope('admin'), async (c) => {
  const [bots, channels] = await c.env.DB.batch([
    c.env.DB.prepare('SELECT id, token, username, status FROM bots ORDER BY created_at'),
    c.env.DB.prepare('SELECT id, title, status FROM channels ORDER BY created_at'),
  ]);
  const fresh = c.req.query('fresh') === '1';
  if (fresh || !topoCache || now() - topoCache.at > 600_000) {
    // 整份清单 (数组) 在 blobs.manifest, 分段清单在 blob_parts.refs; 两处的元素都是 {c,m,b,f,s}
    const r = await c.env.DB.prepare(
      `SELECT json_extract(j.value, '$.c') AS c, json_extract(j.value, '$.b') AS b, COUNT(*) AS n, SUM(json_extract(j.value, '$.s')) AS bytes
       FROM (SELECT manifest AS m FROM blobs WHERE json_type(manifest) = 'array' UNION ALL SELECT refs AS m FROM blob_parts) t, json_each(t.m) j
       GROUP BY 1, 2`,
    ).all<Usage>();
    topoCache = { at: now(), usage: r.results.map((u) => ({ c: String(u.c), b: String(u.b), n: u.n, bytes: u.bytes ?? 0 })) };
  }
  const botRows = bots.results as { id: string; token: string; username: string | null; status: string }[];
  const chanRows = channels.results as { id: string; title: string | null; status: string }[];
  const perms: Record<string, string> = {};
  if (c.req.query('check') === '1') {
    let budget = num(c.env.SUBREQ_BUDGET, 48);
    const jobs: Promise<void>[] = [];
    for (const b of botRows.filter((x) => x.status === 'active')) {
      for (const ch of chanRows.filter((x) => x.status !== 'dead')) {
        const k = `${b.id}|${ch.id}`;
        if (budget-- <= 0) { perms[k] = 'unchecked'; continue; }
        jobs.push(adminStatus(b.token, ch.id, Number(b.id)).then((s) => { perms[k] = s; }));
      }
    }
    await Promise.all(jobs);
  }
  return c.json({
    at: topoCache.at,
    bots: botRows.map(({ token: _t, ...b }) => b),
    channels: chanRows,
    usage: topoCache.usage,
    perms,
  });
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
  const scopes = (b.scopes ?? ['read']).filter((s) => ['read', 'write', 'admin', 'stats'].includes(s));
  const root = b.rootPath ? await mkdirp(c.env, 'root', b.rootPath): await getNode(c.env, 'root');
  const plain = `hxd_${newId(32)}`;
  const id = newId();
  await c.env.DB.prepare('INSERT INTO tokens (id, name, token_hash, scopes, root_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(id, b.name, await sha256Hex(plain), scopes.join(','), root!.id, b.expiresIn ? now() + b.expiresIn * 1000 : null, now())
    .run();
  return c.json({ id, token: plain, scopes, root: b.rootPath ?? '/', note: 'token is shown only once' });
});

api.get('/admin/tokens', requireScope('admin'), async (c) => {
  const r = await c.env.DB.prepare('SELECT id, name, scopes, root_id, expires_at, created_at FROM tokens ORDER BY created_at DESC').all<{ root_id: string }>();
  // 带上根目录的路径: 前端删除或移出某个令牌的根目录时据此提醒 (持有令牌的服务会找不到文件)
  // 所有根目录的路径一条递归 CTE 批量求 (#23, 原来每个令牌一次 pathOf)
  const paths = await pathsOfIds(c.env, r.results.map((t) => t.root_id));
  const items = r.results.map((t) => ({ ...t, root_path: paths.get(t.root_id) ?? '/' }));
  return c.json({ items });
});

/** 吊销令牌: 它签的直链随之失效 (见 tokenAlive), 它建的分享一并删除 */
api.delete('/admin/tokens/:id', requireScope('admin'), async (c) => {
  const id = c.req.param('id')!;
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM tokens WHERE id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM shares WHERE token_id = ?').bind(id),
  ]);
  forgetToken(id);
  return c.json({ ok: true });
});

api.post('/admin/maintenance', requireScope('admin'), async (c) => c.json(await runMaintenance(c.env, { sweep: c.req.query('sweep') !== '0' })));


