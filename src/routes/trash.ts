/** 回收站: 列表, 恢复, 彻底删除, 清空。全部按令牌根目录隔离 */
import { Hono, type Context } from 'hono';
import type { AppEnv } from '../env';
import { requireScope } from '../lib/auth';
import { assertAccess, type NodeRow, pathsOf, publicNode, restoreNode } from '../lib/tree';
import { HttpError } from '../lib/util';
import { purgeAll } from '../services/purge';

export const trash = new Hono<AppEnv>();
type C = Context<AppEnv>;

/** 彻底删除时请求内可用的 TG 子请求数, 其余留给维护 */
const PURGE_TG_BUDGET = 40;

/** 回收站顶层项目: 父目录没删, 或者父目录是另一次删除的。deleted_at = 1 是已提交彻底删除, 不再列出 */
async function trashItems(c: C): Promise<NodeRow[]> {
  const r = await c.env.DB.prepare(
    `SELECT n.* FROM nodes n LEFT JOIN nodes p ON p.id = n.parent_id
     WHERE n.deleted_at > 1 AND (p.deleted_at IS NULL OR p.deleted_at <> n.deleted_at)
     ORDER BY n.deleted_at DESC LIMIT 200`,
  ).all<NodeRow>();
  const p = c.get('principal');
  if (p.rootId === 'root') return r.results;
  // 受限令牌只看自己根下的
  const paths = await pathsOf(c.env, r.results);
  return r.results.filter((n) => paths.get(n.id)?.ancestors.has(p.rootId));
}

trash.get('/trash', requireScope('write'), async (c) => {
  const items = await trashItems(c);
  return c.json({ items: items.map((n) => ({ ...publicNode(n), deletedAt: n.deleted_at })) });
});

trash.post('/restore', requireScope('write'), async (c) => {
  const { id } = await c.req.json<{ id: string }>();
  await assertAccess(c.env, c.get('principal'), id);
  await restoreNode(c.env, id);
  return c.json({ ok: true });
});

/** 彻底删除一个回收站项目 (目录连同子项)。当场清理, 清不完的由维护接着做 */
trash.post('/purge', requireScope('write'), async (c) => {
  const { id } = await c.req.json<{ id: string }>();
  if (!id || id === 'root') throw new HttpError(400, 'bad id');
  await assertAccess(c.env, c.get('principal'), id);
  const r = await c.env.DB.prepare('UPDATE nodes SET deleted_at = 1 WHERE id = ? AND deleted_at > 1').bind(id).run();
  if (!r.meta.changes) throw new HttpError(404, 'not in trash');
  return c.json(await purgeAll(c.env, PURGE_TG_BUDGET));
});

/** 清空回收站。管理员和根令牌清全部, 受限令牌只清自己根下的 */
trash.post('/trash/empty', requireScope('write'), async (c) => {
  const p = c.get('principal');
  if (p.rootId === 'root') {
    await c.env.DB.prepare('UPDATE nodes SET deleted_at = 1 WHERE deleted_at > 1').run();
  } else {
    const ids = (await trashItems(c)).map((n) => n.id);
    if (ids.length) await c.env.DB.prepare('UPDATE nodes SET deleted_at = 1 WHERE id IN (SELECT value FROM json_each(?)) AND deleted_at > 1').bind(JSON.stringify(ids)).run();
  }
  return c.json(await purgeAll(c.env, PURGE_TG_BUDGET));
});
