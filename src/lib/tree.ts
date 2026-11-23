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

export async function getNode(env: Env, id: string): Promise<NodeRow | null> {
  return env.DB.prepare('SELECT * FROM nodes WHERE id = ? AND deleted_at IS NULL').bind(id).first<NodeRow>();
}

export async function childByName(env: Env, parentId: string, name: string): Promise<NodeRow | null> {
  return env.DB.prepare('SELECT * FROM nodes WHERE parent_id = ? AND name = ? AND deleted_at IS NULL')
    .bind(parentId, name)
    .first<NodeRow>();
}

export async function listChildren(env: Env, parentId: string): Promise<NodeRow[]> {
  const r = await env.DB.prepare(
    'SELECT * FROM nodes WHERE parent_id = ? AND deleted_at IS NULL ORDER BY kind ASC, name COLLATE NOCASE ASC',
)
    .bind(parentId)
    .all<NodeRow>();
  return r.results;
}

/** 按路径解析节点 (相对 principal 的根)。不存在返回 null */
export async function resolvePath(env: Env, rootId: string, path: string): Promise<NodeRow | null> {
  let cur = await getNode(env, rootId);
  for (const seg of splitPath(path)) {
    if (!cur || cur.kind !== 'dir') return null;
    cur = await childByName(env, cur.id, seg);
  }
  return cur;
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

/** mkdir -p: 按路径逐级创建 */
export async function mkdirp(env: Env, rootId: string, path: string): Promise<NodeRow> {
  let cur = await getNode(env, rootId);
  if (!cur) throw new HttpError(404, 'root not found');
  for (const seg of splitPath(path)) cur = await mkdir(env, cur.id, seg);
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
  await env.DB.prepare('UPDATE nodes SET parent_id = ?, name = ?, updated_at = ? WHERE id = ?')
    .bind(newParentId, newName, now(), id)
    .run();
}

/** 放进回收站: 目录连同子孙一起标记 */
export async function trashNode(env: Env, id: string): Promise<number> {
  if (id === 'root') throw new HttpError(400, 'cannot delete root');
  const t = now();
  const r = await env.DB.prepare(
    `WITH RECURSIVE sub(id) AS (
       SELECT id FROM nodes WHERE id = ?
       UNION ALL
       SELECT n.id FROM nodes n JOIN sub ON n.parent_id = sub.id WHERE n.deleted_at IS NULL
) UPDATE nodes SET deleted_at = ? WHERE id IN (SELECT id FROM sub) AND deleted_at IS NULL`,
)
    .bind(id, t)
    .run();
  return r.meta.changes ?? 0;
}

/** 从回收站恢复 (只恢复同一次删除的子树); 若原位置重名则加后缀 */
export async function restoreNode(env: Env, id: string): Promise<void> {
  const node = await env.DB.prepare('SELECT * FROM nodes WHERE id = ?').bind(id).first<NodeRow>();
  if (!node || !node.deleted_at) throw new HttpError(404, 'not in trash');
  const parent = node.parent_id ? await getNode(env, node.parent_id): null;
  const parentId = parent ? parent.id : 'root';
  let name = node.name;
  if (await childByName(env, parentId, name)) name = `${name} (restored ${new Date().toISOString().slice(0, 19)})`;
  const stamp = node.deleted_at;
  await env.DB.batch([
    env.DB.prepare('UPDATE nodes SET parent_id = ?, name = ?, deleted_at = NULL WHERE id = ?').bind(parentId, name, id),
    env.DB.prepare(
      `WITH RECURSIVE sub(id) AS (
         SELECT id FROM nodes WHERE parent_id = ?
         UNION ALL
         SELECT n.id FROM nodes n JOIN sub ON n.parent_id = sub.id
) UPDATE nodes SET deleted_at = NULL WHERE id IN (SELECT id FROM sub) AND deleted_at = ?`,
).bind(id, stamp),
  ]);
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
