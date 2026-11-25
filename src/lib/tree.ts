import type { Env, Principal } from '../env';
import { HttpError, newId, now, splitPath, validName } from './util';

export interface NodeRow {
  id: string;
  parent_id: string | null;
  name: string;
  kind: 'dir' | 'file';
  size: number;
  mime: string | null;
  blob_id: string | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

/**
 * 按 ID 取节点, 要求自身和所有祖先都没被删除 (删除目录只标记顶层)。
 * 一条递归 CTE 向上走, 遇到已删除的祖先就停, 行读约等于深度。
 * 走到顶的节点 parent_id 必须为空 (即 root), 否则说明中间某级已被清理。
 */
export async function getNode(env: Env, id: string): Promise<NodeRow | null> {
  if (id === 'root') return env.DB.prepare('SELECT * FROM nodes WHERE id = ? AND deleted_at IS NULL').bind(id).first<NodeRow>();
  // 只扫一遍祖先链, 判断放在 JS 里做 (CTE 被子查询引用多次会重复计算, 行读翻好几倍)
  const r = await env.DB.prepare(
    `WITH RECURSIVE up(depth, ${COLS}) AS (
       SELECT 0, ${COLS} FROM nodes WHERE id = ?
       UNION ALL
       SELECT up.depth + 1, ${nCols} FROM nodes n JOIN up ON n.id = up.parent_id
       WHERE up.deleted_at IS NULL AND up.depth < 64
     ) SELECT * FROM up`,
  )
    .bind(id)
    .all<NodeRow & { depth: number }>();
  const chain = r.results;
  if (!chain.length || chain.some((x) => x.deleted_at !== null) || chain[chain.length - 1].parent_id !== null) return null;
  const { depth: _d, ...node } = chain[0];
  return node;
}

/** 读路径用的节点缓存 60 秒: 播放器反复 Range, 热门图片反复访问时 D1 零读。本 isolate 内删除或移动会立即失效 */
const nodeCache = new Map<string, { at: number; n: NodeRow }>();
export async function getNodeCached(env: Env, id: string): Promise<NodeRow | null> {
  const hit = nodeCache.get(id);
  if (hit && Date.now() - hit.at < 60_000) return hit.n;
  const n = await getNode(env, id);
  if (!n) return null;
  if (nodeCache.size > 5000) nodeCache.clear();
  nodeCache.set(id, { at: Date.now(), n });
  return n;
}
export function forgetNode(id: string): void {
  nodeCache.delete(id);
}

export async function childByName(env: Env, parentId: string, name: string): Promise<NodeRow | null> {
  return env.DB.prepare('SELECT * FROM nodes WHERE parent_id = ? AND name = ? AND deleted_at IS NULL')
    .bind(parentId, name)
    .first<NodeRow>();
}

export async function listChildren(env: Env, parentId: string): Promise<NodeRow[]> {
  const r = await env.DB.prepare(
    'SELECT * FROM nodes WHERE parent_id = ? AND deleted_at IS NULL',
)
    .bind(parentId)
    .all<NodeRow>();
  // 排序放在 JS 里做, SQL 不建临时 B 树, 少算一倍行读
  return r.results.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }): a.kind < b.kind ? -1 : 1));
}

const COLS = 'id, parent_id, name, kind, size, mime, blob_id, created_at, updated_at, deleted_at';
const nCols = COLS.split(', ').map((x) => 'n.' + x).join(', ');

/** 已知路径 (从 root 解析出来的节点), 省掉一次 pathOf */
const knownPath = new WeakMap<NodeRow, string>();

/** 一条递归 CTE 沿路径走到底, 返回 [根, 第 1 级, ...], 走不下去就提前结束。查询 1 次, 行读约等于深度 */
export async function walkPath(env: Env, rootId: string, segs: string[]): Promise<NodeRow[]> {
  const r = await env.DB.prepare(
    // 段名用 json_extract 取标量, 这样能走 (parent_id, name) 唯一索引, 每级只读 1 行
    `WITH RECURSIVE walk(depth, ${COLS}) AS (
       SELECT 0, ${COLS} FROM nodes WHERE id = ?1 AND deleted_at IS NULL
       UNION ALL
       SELECT walk.depth + 1, ${nCols} FROM walk
         JOIN nodes n ON n.parent_id = walk.id AND n.name = json_extract(?2, '$[' || walk.depth || ']') AND n.deleted_at IS NULL
       WHERE walk.kind = 'dir' AND walk.depth < json_array_length(?2)
     ) SELECT * FROM walk`,
  )
    .bind(rootId, JSON.stringify(segs))
    .all<NodeRow & { depth: number }>();
  return r.results;
}

/** 按路径解析节点 (相对 principal 的根)。不存在返回 null */
export async function resolvePath(env: Env, rootId: string, path: string): Promise<NodeRow | null> {
  const segs = splitPath(path);
  const chain = await walkPath(env, rootId, segs);
  if (chain.length !== segs.length + 1) return null;
  const node = chain[chain.length - 1];
  if (rootId === 'root') knownPath.set(node, '/' + segs.join('/'));
  return node;
}

/** 有现成路径就直接用, 否则查一次 */
export async function pathFor(env: Env, node: NodeRow): Promise<string> {
  return knownPath.get(node) ?? pathOf(env, node.id);
}

/**
 * 批量求路径: 从这些节点的父目录往上走, UNION 去重, 同一目录只读一次。
 * 返回 id -> { path, ancestors }, ancestors 含自身。
 */
export async function pathsOf(env: Env, nodes: NodeRow[]): Promise<Map<string, { path: string; ancestors: Set<string>; dead: boolean }>> {
  const out = new Map<string, { path: string; ancestors: Set<string>; dead: boolean }>();
  if (nodes.length === 0) return out;
  const starts = [...new Set(nodes.map((n) => n.parent_id).filter((x): x is string => !!x))];
  const dirs = new Map<string, { parent: string | null; name: string; deleted: boolean }>();
  if (starts.length) {
    const r = await env.DB.prepare(
      `WITH RECURSIVE anc(id) AS (
         SELECT value FROM json_each(?)
         UNION
         SELECT n.parent_id FROM nodes n JOIN anc ON n.id = anc.id WHERE n.parent_id IS NOT NULL
       ) SELECT n.id, n.parent_id, n.name, n.deleted_at FROM anc JOIN nodes n ON n.id = anc.id`,
    )
      .bind(JSON.stringify(starts))
      .all<{ id: string; parent_id: string | null; name: string; deleted_at: number | null }>();
    for (const d of r.results) dirs.set(d.id, { parent: d.parent_id, name: d.name, deleted: d.deleted_at !== null });
  }
  for (const n of nodes) {
    const names = [n.name];
    const ancestors = new Set([n.id]);
    let dead = false;
    for (let cur = n.parent_id, guard = 0; cur && guard < 64; guard++) {
      ancestors.add(cur);
      const d = dirs.get(cur);
      // 祖先已删除或已被清理 (断链): 这个节点不可见
      if (!d || d.deleted) { dead = true; break; }
      if (d.name) names.push(d.name);
      cur = d.parent;
    }
    out.set(n.id, { path: '/' + names.filter(Boolean).reverse().join('/'), ancestors, dead });
  }
  return out;
}

/** 节点是否位于 ancestorId 之下 (含自身)。用递归 CTE 一次查完 */
export async function isWithin(env: Env, nodeId: string, ancestorId: string): Promise<boolean> {
  if (ancestorId === 'root' || nodeId === ancestorId) return true;
  const r = await env.DB.prepare(
    `WITH RECURSIVE up(id, parent_id, depth) AS (
       SELECT id, parent_id, 0 FROM nodes WHERE id = ?
       UNION ALL
       SELECT n.id, n.parent_id, up.depth + 1 FROM nodes n JOIN up ON n.id = up.parent_id WHERE up.depth < 64
) SELECT 1 AS hit FROM up WHERE id = ? LIMIT 1`,
)
    .bind(nodeId, ancestorId)
    .first<{ hit: number }>();
  return !!r;
}

export async function assertAccess(env: Env, p: Principal, nodeId: string): Promise<void> {
  if (!(await isWithin(env, nodeId, p.rootId))) throw new HttpError(403, 'outside token root');
}

/** 节点的完整路径 (相对 root)  */
export async function pathOf(env: Env, nodeId: string): Promise<string> {
  const r = await env.DB.prepare(
    `WITH RECURSIVE up(id, parent_id, name, depth) AS (
       SELECT id, parent_id, name, 0 FROM nodes WHERE id = ?
       UNION ALL
       SELECT n.id, n.parent_id, n.name, up.depth + 1 FROM nodes n JOIN up ON n.id = up.parent_id WHERE up.depth < 64
) SELECT name FROM up ORDER BY depth DESC`,
)
    .bind(nodeId)
    .all<{ name: string }>();
  return '/' + r.results.map((x) => x.name).filter(Boolean).join('/');
}

export async function mkdir(env: Env, parentId: string, name: string): Promise<NodeRow> {
  if (!validName(name)) throw new HttpError(400, 'invalid name');
  const parent = await getNode(env, parentId);
  if (!parent || parent.kind !== 'dir') throw new HttpError(404, 'parent not found');
  const exist = await childByName(env, parentId, name);
  if (exist) {
    if (exist.kind === 'dir') return exist;
    throw new HttpError(409, 'a file with that name exists');
  }
  const t = now();
  const row: NodeRow = {
    id: newId(), parent_id: parentId, name, kind: 'dir', size: 0, mime: null, blob_id: null,
    created_at: t, updated_at: t, deleted_at: null,
  };
  await env.DB.prepare('INSERT INTO nodes (id, parent_id, name, kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(row.id, parentId, name, 'dir', t, t)
    .run();
  return row;
}

/** mkdir -p: 一次查询找到已存在的最深一级, 缺的目录一个 batch 建完 */
export async function mkdirp(env: Env, rootId: string, path: string): Promise<NodeRow> {
  const segs = splitPath(path);
  for (const seg of segs) if (!validName(seg)) throw new HttpError(400, 'invalid name');
  const chain = await walkPath(env, rootId, segs);
  if (chain.length === 0) throw new HttpError(404, 'root not found');
  let cur = chain[chain.length - 1];
  if (cur.kind !== 'dir') throw new HttpError(409, 'a file with that name exists');
  const rest = segs.slice(chain.length - 1);
  if (rest.length === 0) return cur;
  const t = now();
  const stmts: D1PreparedStatement[] = [];
  for (const name of rest) {
    const row: NodeRow = {
      id: newId(), parent_id: cur.id, name, kind: 'dir', size: 0, mime: null, blob_id: null,
      created_at: t, updated_at: t, deleted_at: null,
    };
    stmts.push(env.DB.prepare('INSERT INTO nodes (id, parent_id, name, kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').bind(row.id, row.parent_id, name, 'dir', t, t));
    cur = row;
  }
  try {
    await env.DB.batch(stmts);
  } catch (e) {
    // 并发建了同名目录 (唯一索引冲突): 重新走一遍, 走得通就用现成的
    const again = await resolvePath(env, rootId, path);
    if (again?.kind === 'dir') return again;
    if (again) throw new HttpError(409, 'a file with that name exists');
    throw e;
  }
  return cur;
}

/** 移动/重命名。目标重名时报 409, 除非 overwrite */
export async function moveNode(env: Env, id: string, newParentId: string, newName: string, overwrite = false): Promise<void> {
  if (id === 'root') throw new HttpError(400, 'cannot move root');
  if (!validName(newName)) throw new HttpError(400, 'invalid name');
  const node = await getNode(env, id);
  if (!node) throw new HttpError(404, 'not found');
  const parent = await getNode(env, newParentId);
  if (!parent || parent.kind !== 'dir') throw new HttpError(404, 'target dir not found');
  if (node.kind === 'dir' && (await isWithin(env, newParentId, id))) throw new HttpError(400, 'cannot move a dir into itself');
  const clash = await childByName(env, newParentId, newName);
  if (clash && clash.id !== id) {
    if (!overwrite) throw new HttpError(409, 'target exists');
    await trashNode(env, clash.id);
  }
  forgetNode(id);
  await env.DB.prepare('UPDATE nodes SET parent_id = ?, name = ?, updated_at = ? WHERE id = ?')
    .bind(newParentId, newName, now(), id)
    .run();
}

/** 放进回收站: 只标记这一个节点, 子孙因祖先已删除而不可见。写入 O(1) */
export async function trashNode(env: Env, id: string): Promise<number> {
  if (id === 'root') throw new HttpError(400, 'cannot delete root');
  forgetNode(id);
  const r = await env.DB.prepare('UPDATE nodes SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL').bind(now(), id).run();
  return r.meta.changes ?? 0;
}

/** 从回收站恢复: 子孙本来就没动, 只清顶层标记; 原位置重名则加后缀, 原父目录不在了就放回根 */
export async function restoreNode(env: Env, id: string, fallbackId = 'root'): Promise<void> {
  const node = await env.DB.prepare('SELECT * FROM nodes WHERE id = ?').bind(id).first<NodeRow>();
  // deleted_at = 1 是已提交彻底删除, 不能再恢复
  if (!node || !node.deleted_at || node.deleted_at <= 1) throw new HttpError(404, 'not in trash');
  const parent = node.parent_id ? await getNode(env, node.parent_id) : null;
  // 原父目录不在了: 放回调用者的根目录 (受限令牌放回 'root' 就再也看不到了)
  const parentId = parent && (fallbackId === 'root' || (await isWithin(env, parent.id, fallbackId))) ? parent.id : fallbackId;
  let name = node.name;
  if (await childByName(env, parentId, name)) name = `${name} (restored ${new Date().toISOString().slice(0, 19)})`;
  await env.DB.prepare('UPDATE nodes SET parent_id = ?, name = ?, deleted_at = NULL WHERE id = ?').bind(parentId, name, id).run();
}

export function publicNode(n: NodeRow) {
  return {
    id: n.id,
    name: n.name,
    kind: n.kind,
    size: n.size,
    mime: n.mime,
    parentId: n.parent_id,
    createdAt: n.created_at,
    updatedAt: n.updated_at,
  };
}
