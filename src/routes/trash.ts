/** 回收站: 列表, 恢复, 彻底删除, 清空。全部按令牌根目录隔离 */
import { Hono, type Context } from 'hono';
import type { AppEnv } from '../env';
import { requireScope } from '../lib/auth';
import { assertAccess, type NodeRow, publicNode, restoreNode } from '../lib/tree';
import { HttpError } from '../lib/util';
import { purgeAll } from '../services/purge';

export const trash = new Hono<AppEnv>();
type C = Context<AppEnv>;

/** 彻底删除时请求内可用的 TG 子请求数, 其余留给维护 */
const PURGE_TG_BUDGET = 40;

/** 回收站顶层项目: 父目录没删, 或者父目录是另一次删除的。deleted_at = 1 是已提交彻底删除, 不再列出 */
async function trashItems(c: C): Promise<NodeRow[]> {
  const p = c.get('principal');
  if (p.rootId === 'root') {
    return (await c.env.DB.prepare(
      `SELECT n.* FROM nodes n LEFT JOIN nodes p ON p.id = n.parent_id
       WHERE n.deleted_at > 1 AND (p.deleted_at IS NULL OR p.deleted_at <> n.deleted_at)
       ORDER BY n.deleted_at DESC LIMIT 200`,
    ).all<NodeRow>()).results;
  }
  // 受限令牌: 在自己子树的目录里找 (含已删除的目录), 不能先全局 LIMIT 再过滤, 否则别人的回收站一多就看不到自己的
  return (await c.env.DB.prepare(
    `WITH RECURSIVE sub(id, del) AS (
       SELECT id, deleted_at FROM nodes WHERE id = ?1
       UNION ALL SELECT n.id, n.deleted_at FROM nodes n JOIN sub ON n.parent_id = sub.id WHERE n.kind = 'dir' AND (n.deleted_at IS NULL OR n.deleted_at > 1) LIMIT 20000
     ) SELECT n.* FROM nodes n JOIN sub ON n.parent_id = sub.id
       WHERE n.deleted_at > 1 AND (sub.del IS NULL OR sub.del <> n.deleted_at)
       ORDER BY n.deleted_at DESC LIMIT 200`,
  ).bind(p.rootId).all<NodeRow>()).results;
}

trash.get('/trash', requireScope('write'), async (c) => {
  const items = await trashItems(c);
  return c.json({ items: items.map((n) => ({ ...publicNode(n), deletedAt: n.deleted_at })) });
});

trash.post('/restore', requireScope('write'), async (c) => {
  const { id } = await c.req.json<{ id: string }>();
  await assertAccess(c.env, c.get('principal'), id);
  await restoreNode(c.env, id, c.get('principal').rootId);
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
