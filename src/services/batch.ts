/**
 * 批量操作 (#22): 多项 move / copy / delete / restore / rename 在一个 D1 batch (事务) 里写完。
 * 免费计划每次调用最多 50 条 D1 查询, 逐项调用单个接口的写法 (每项 3~7 条) 几十项就会超; 这里不论多少项都是固定几条:
 * 读节点 1 条 + 祖先链 1 条 (+ 目标目录同名检查 1 条) + 写入 batch 1 次。
 * 校验不过的项 (不存在, 越权, 同名, 移进自身) 放进 failed, 其余照常执行; 写入失败整体回滚。
 */
import type { Env, Principal } from '../env';
import { copyPlan, COPY_MAX } from '../routes/api';
import { forgetNode, getNodeWithAncestors, type NodeRow } from '../lib/tree';
import { HttpError, now, validName } from '../lib/util';

export const BATCH_MAX = 500;
/** 一次批量复制最多几个目录 (每个目录读子树 1 条查询) */
export const COPY_DIRS_MAX = 30;
export type BatchOp = 'move' | 'copy' | 'delete' | 'restore' | 'rename';
export interface BatchReq { op: BatchOp; ids?: string[]; items?: { id: string; name: string }[]; toParentId?: string; overwrite?: boolean }
export interface BatchRes { ok: number; failed: { id: string; error: string }[]; nodes?: NodeRow[] }

interface Up { parent: string | null; deleted: number | null }

/** 从这些 id 一路往上, 读出整条祖先链 (含已删除的), 1 条递归 CTE, 同一目录只读一次 */
async function upChains(env: Env, ids: string[]): Promise<Map<string, Up>> {
  const out = new Map<string, Up>();
  if (!ids.length) return out;
  const r = await env.DB.prepare(
    `WITH RECURSIVE anc(id) AS (
       SELECT value FROM json_each(?)
       UNION
       SELECT n.parent_id FROM nodes n JOIN anc ON n.id = anc.id WHERE n.parent_id IS NOT NULL
     ) SELECT n.id, n.parent_id, n.deleted_at FROM anc JOIN nodes n ON n.id = anc.id`,
  ).bind(JSON.stringify([...new Set(ids)])).all<{ id: string; parent_id: string | null; deleted_at: number | null }>();
  for (const x of r.results) out.set(x.id, { parent: x.parent_id, deleted: x.deleted_at });
  return out;
}

/** 沿链往上: 祖先集合 (含自身), 链上 (不含自身) 有没有已删除的, 能否走到 root */
function walk(m: Map<string, Up>, id: string): { anc: Set<string>; alive: boolean } {
  const anc = new Set<string>();
  let alive = true;
  let cur: string | null = id;
  for (let guard = 0; cur && guard < 64; guard++) {
    anc.add(cur);
    const u = m.get(cur);
    if (!u) return { anc, alive: false };
    if (cur !== id && u.deleted !== null) alive = false;
    if (cur === 'root') return { anc, alive };
    cur = u.parent;
  }
  return { anc, alive: false };
}

const inRoot = (p: Principal, anc: Set<string>) => p.rootId === 'root' || anc.has(p.rootId);

export async function runBatch(env: Env, p: Principal, b: BatchReq): Promise<BatchRes> {
  const failed: BatchRes['failed'] = [];
  const fail = (id: string, error: string) => failed.push({ id, error });
  const list = b.op === 'rename' ? (b.items ?? []).map((x) => x.id) : (b.ids ?? []);
  const ids = [...new Set(list.filter((x) => typeof x === 'string' && x))];
  if (ids.length > BATCH_MAX) throw new HttpError(413, `too many items (max ${BATCH_MAX})`);
  if (!ids.length) return { ok: 0, failed };
  if (ids.includes('root')) throw new HttpError(400, 'cannot touch root');

  const restoring = b.op === 'restore';
  const rows = (await env.DB.prepare(
    `SELECT * FROM nodes WHERE id IN (SELECT value FROM json_each(?)) AND ${restoring ? 'deleted_at > 1' : 'deleted_at IS NULL'}`,
  ).bind(JSON.stringify(ids)).all<NodeRow>()).results;
  const byId = new Map(rows.map((n) => [n.id, n]));
  const target = b.op === 'move' || b.op === 'copy' ? b.toParentId ?? '' : '';
  const chains = await upChains(env, [...rows.map((n) => n.id), ...(target ? [target] : [])]);

  // 每项先校验存在与权限
  const ok: NodeRow[] = [];
  for (const id of ids) {
    const n = byId.get(id);
    if (!n) { fail(id, restoring ? 'not in trash' : 'not found'); continue; }
    const w = walk(chains, id);
    // 回收站里的项目自己是删除状态, 不看 alive; 其他操作要求整条链都没删
    if (!inRoot(p, w.anc) || (!restoring && !w.alive)) { fail(id, inRoot(p, w.anc) ? 'not found' : 'outside token root'); continue; }
    ok.push(n);
  }
  const t = now();

  if (b.op === 'delete') {
    if (ok.length) {
      await env.DB.prepare('UPDATE nodes SET deleted_at = ?1 WHERE id IN (SELECT value FROM json_each(?2)) AND deleted_at IS NULL').bind(t, JSON.stringify(ok.map((n) => n.id))).run();
      for (const n of ok) forgetNode(n.id);
    }
    return { ok: ok.length, failed };
  }

  if (b.op === 'rename') {
    const want = new Map((b.items ?? []).map((x) => [x.id, String(x.name ?? '').trim()]));
    const plan: [string, string][] = [];
    for (const n of ok) {
      const name = want.get(n.id)!;
      if (!validName(name)) { fail(n.id, 'invalid name'); continue; }
      if (name !== n.name) plan.push([n.id, name]);
    }
    const clash = await clashes(env, plan.map(([id, name]) => [byId.get(id)!.parent_id!, name]));
    const renamed = new Set(plan.map(([id]) => id));
    const seen = new Set<string>();
    const go: [string, string][] = [];
    for (const [id, name] of plan) {
      const k = `${byId.get(id)!.parent_id}\0${name}`;
      const other = clash.get(k);
      // 同名的是另一个不在本批里改名的节点, 或本批里两项改成同一个名字
      if ((other && !renamed.has(other)) || seen.has(k)) { fail(id, 'target exists'); continue; }
      seen.add(k);
      go.push([id, name]);
    }
    if (go.length) {
      try {
        await env.DB.prepare(
          `UPDATE nodes SET name = j.name, updated_at = ?2
           FROM (SELECT json_extract(value, '$[0]') AS id, json_extract(value, '$[1]') AS name FROM json_each(?1)) AS j
           WHERE nodes.id = j.id`,
        ).bind(JSON.stringify(go), t).run();
      } catch (e) {
        // 互换名字 (a→b, b→a) 在一条 UPDATE 里会撞唯一索引
        if (/UNIQUE/i.test(String(e))) throw new HttpError(409, 'name conflict inside batch (swap names in two steps)');
        throw e;
      }
      for (const [id] of go) forgetNode(id);
    }
    return { ok: go.length, failed };
  }

  if (b.op === 'restore') {
    // 原父目录还在 (且在令牌根下) 就回原处, 否则放回令牌根; 同名时加后缀, 和单个恢复一致
    const plan = ok.map((n) => {
      const parent = n.parent_id ?? 'root';
      const w = walk(chains, parent);
      const alive = chains.get(parent)?.deleted === null && w.alive;
      return { n, parent: alive && inRoot(p, w.anc) ? parent : p.rootId };
    });
    const clash = await clashes(env, plan.map((x) => [x.parent, x.n.name]));
    const stamp = new Date(t).toISOString().slice(0, 19);
    const seen = new Set<string>();
    const go: [string, string, string][] = [];
    for (const { n, parent } of plan) {
      let name = n.name;
      let k = `${parent}\0${name}`;
      for (let i = 1; clash.has(k) || seen.has(k); i++) {
        name = `${n.name} (restored ${stamp}${i > 1 ? ` ${i}` : ''})`;
        k = `${parent}\0${name}`;
      }
      seen.add(k);
      go.push([n.id, parent, name]);
    }
    if (go.length) {
      await env.DB.prepare(
        `UPDATE nodes SET parent_id = j.p, name = j.name, deleted_at = NULL, expires_at = NULL
         FROM (SELECT json_extract(value, '$[0]') AS id, json_extract(value, '$[1]') AS p, json_extract(value, '$[2]') AS name FROM json_each(?1)) AS j
         WHERE nodes.id = j.id AND nodes.deleted_at > 1`,
      ).bind(JSON.stringify(go)).run();
      for (const [id] of go) forgetNode(id);
    }
    return { ok: go.length, failed };
  }

  // move / copy: 目标目录要存在, 在令牌根下
  const tw = walk(chains, target);
  const tn = await getNodeWithAncestors(env, target);
  if (!tn || tn.node.kind !== 'dir' || !inRoot(p, tw.anc)) throw new HttpError(404, 'target dir not found');
  const clash = await clashes(env, ok.map((n) => [target, n.name]));
  const seen = new Set<string>();
  const go: NodeRow[] = [];
  const trashFirst: string[] = [];
  for (const n of ok) {
    if (b.op === 'move' && n.parent_id === target) { fail(n.id, 'already there'); continue; }
    if (n.kind === 'dir' && tw.anc.has(n.id)) { fail(n.id, `cannot ${b.op} a dir into itself`); continue; }
    const k = n.name;
    const other = clash.get(`${target}\0${k}`);
    if (seen.has(k)) { fail(n.id, 'target exists'); continue; }
    if (other && other !== n.id) {
      if (!b.overwrite || b.op === 'copy') { fail(n.id, 'target exists'); continue; }
      trashFirst.push(other);
    }
    seen.add(k);
    go.push(n);
  }
  if (!go.length) return { ok: 0, failed };
  const stmts: D1PreparedStatement[] = [];
  if (trashFirst.length) stmts.push(env.DB.prepare('UPDATE nodes SET deleted_at = ?1 WHERE id IN (SELECT value FROM json_each(?2)) AND deleted_at IS NULL').bind(t, JSON.stringify(trashFirst)));
  let made: NodeRow[] = [];
  if (b.op === 'move') {
    stmts.push(env.DB.prepare('UPDATE nodes SET parent_id = ?1, updated_at = ?2 WHERE id IN (SELECT value FROM json_each(?3))').bind(target, t, JSON.stringify(go.map((n) => n.id))));
  } else {
    // 每个目录要读一次子树 (1 条查询), 免费计划每次调用最多 50 条查询
    if (go.filter((n) => n.kind === 'dir').length > COPY_DIRS_MAX) throw new HttpError(413, `copy at most ${COPY_DIRS_MAX} dirs per batch`);
    let budget = COPY_MAX;
    for (const n of go) {
      const plan = await copyPlan(env, n, target, n.name, budget);
      budget -= plan.count;
      stmts.push(...plan.stmts);
      made.push(plan.node);
    }
  }
  try {
    await env.DB.batch(stmts);
  } catch (e) {
    if (/UNIQUE/i.test(String(e))) throw new HttpError(409, 'target exists');
    throw e;
  }
  for (const n of go) forgetNode(n.id);
  for (const id of trashFirst) forgetNode(id);
  if (b.op === 'move') made = go.map((n) => ({ ...n, parent_id: target, updated_at: t }));
  return { ok: go.length, failed, nodes: made };
}

/** (父目录, 名字) 对里已经被未删除节点占用的: 1 条查询。返回 `${parent}\0${name}` -> 占用者 id */
async function clashes(env: Env, pairs: [string, string][]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!pairs.length) return out;
  const r = await env.DB.prepare(
    `SELECT n.id, n.parent_id, n.name FROM json_each(?) j
     JOIN nodes n ON n.parent_id = json_extract(j.value, '$[0]') AND n.name = json_extract(j.value, '$[1]') AND n.deleted_at IS NULL`,
  ).bind(JSON.stringify(pairs)).all<{ id: string; parent_id: string; name: string }>();
  for (const x of r.results) out.set(`${x.parent_id}\0${x.name}`, x.id);
  return out;
}
