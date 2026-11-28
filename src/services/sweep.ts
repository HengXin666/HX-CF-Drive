/**
 * 孤儿消息清扫 (#7): 上传了分片但没有 commit 的消息, D1 里没有记录, 只能按 message id 区间找出来删。
 *
 * 做法 (消息 id 水位, 上传热路径零写入):
 * - 每轮维护给每个频道发一条探针消息, 它的 message_id 就是当前水位, 记进 channels.sweep.k。
 * - 取 ≥ SAFE_AGE 之前记录的最新水位 T: 上传凭证 24 小时过期, 之后不可能再 commit 出引用 (s, T] 的 blob。
 * - (s, T] 里没被任何 blob 的 manifest 引用的 id 都是孤儿 (含探针本身), 用 deleteMessages 批量删, 推进 s。
 * - 引用判断在 D1 里用 json_each 做 (整行清单和 blob_parts 分段清单都算), Worker 不解析 manifest。
 * - 只看 "记录水位 s 之后才 commit 的 blob" (#23): 每个水位同时记下当时 blobs 的 MAX(rowid), 之后 commit 的 blob rowid 一定更大,
 *   用 `rowid > r` 走主键范围扫描, 读行与新 blob 数成正比, 不再每轮全表扫 (blobs.created_at 没有索引, 加索引会让每次上传多写 1 行)。
 *   所有频道共用一条查询, 在 JS 里按频道分组。
 * - rowid 复用: blobs 不用 AUTOINCREMENT, 删掉当前最大 rowid 的行后新行可能拿到更小的 rowid。
 *   purge 删 blob 时把删后的 MAX(rowid) 记进 counters.blob_rowid_low (只在变小时写, 不在上传路径),
 *   清扫时把所有水位的 r 压到不超过它, 再清掉这个计数, 保证不会漏看新 blob。
 *
 * 限制:
 * - TG 只允许 Bot 删除 48 小时内的消息, 所以维护至少每 6 小时一次; 超过 48 小时的删除会失败, 照样推进 s。
 * - 频道必须只给本部署用。多个部署共用一个频道时设 ORPHAN_SWEEP=0, 否则会删掉别的部署的消息。
 * - 第一次清扫从第一条探针开始, 之前遗留的孤儿不处理 (多半已超过 48 小时, 删不掉)。
 */
import type { Env } from '../env';
import { allBots, type BotRow, DELETE_BATCH, deleteMessages, markDead, tgCall, TgFatal, TgRateLimit } from '../drivers/tg';
import { now } from '../lib/util';

/** 上传凭证有效期 24 小时 + 1 小时余量 */
export const SAFE_AGE = 25 * 3600_000;
/** 每个频道每轮最多处理的 id 数, 防止一次扫太多 */
const MAX_IDS_PER_ROUND = 20_000;
/** purge 记录的 "删除后 blobs 的最小 MAX(rowid)" */
export const ROWID_LOW = 'blob_rowid_low';

/** 水位记录: [message id, 记录时间, 当时 blobs 的 MAX(rowid)]; 旧数据没有第 3 项 */
export type Mark = [number, number, number?];
/** s: 已清扫到的 message id; t / r: 记录 s 所在水位时的时间 / MAX(rowid) (r 缺省时退回按 created_at 扫) */
export interface Sweep { s: number; t: number; r?: number; k: Mark[] }
export interface SweepStats { probes: number; swept: number; sweepCalls: number }

export function parseSweep(raw: string | null): Sweep | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Sweep;
    return Number.isInteger(v.s) && Array.isArray(v.k) ? v : null;
  } catch {
    return null;
  }
}

/** 选出本轮可以清扫到的水位: ≥ SAFE_AGE 之前记录的最新一个 */
export function pickTarget(sw: Sweep, t: number): number | null {
  let best: number | null = null;
  for (const [id, at] of sw.k) if (at <= t - SAFE_AGE && id > sw.s && (best === null || id > best)) best = id;
  return best;
}

/** 把所有记下的 rowid 压到不超过 low (purge 删掉过最大 rowid 的行, 之后的新行可能复用更小的 rowid) */
export function applyLow(sw: Sweep, low: number | null): void {
  if (low === null) return;
  if (sw.r !== undefined) sw.r = Math.min(sw.r, low);
  for (const k of sw.k) if (k[2] !== undefined) k[2] = Math.min(k[2], low);
}

/**
 * 推进 s 之后, 新的 t / r 取不晚于 s 的那个水位的记录:
 * id > s 的消息一定发在该水位记录之后, 引用它们的 blob 的 created_at 更晚, rowid 也更大。
 */
export function advance(sw: Sweep, next: number): void {
  let best: Mark | null = null;
  for (const w of sw.k) if (w[0] <= next && (!best || w[0] > best[0])) best = w;
  sw.s = next;
  if (best) { sw.t = best[1]; sw.r = best[2]; }
  sw.k = sw.k.filter(([id]) => id > sw.s).slice(-64);
}

interface Plan { id: string; sw: Sweep; hi: number | null }

/**
 * 清扫所有 active 频道。tgBudget 是可用的 TG 子请求数, 返回用掉的数量在 stats 里。
 * D1: 1 次读 MAX(rowid) 与 low, 1 次查新 blob 引用的消息 (所有频道共用), 每频道写 1 行。
 */
export async function sweepOrphans(env: Env, tgBudget: number): Promise<SweepStats> {
  const out: SweepStats = { probes: 0, swept: 0, sweepCalls: 0 };
  if (env.ORPHAN_SWEEP === '0' || tgBudget <= 0) return out;
  const bot = (await allBots(env)).find((b) => b.status === 'active');
  if (!bot) return out;
  const [chans, meta] = await env.DB.batch([
    env.DB.prepare('SELECT id, status, sweep FROM channels'),
    env.DB.prepare(`SELECT (SELECT MAX(rowid) FROM blobs) AS mx, (SELECT n FROM counters WHERE name = '${ROWID_LOW}') AS low`),
  ]);
  const all = chans.results as { id: string; status: string; sweep: string | null }[];
  const rows = all.filter((c) => c.status === 'active');
  const m = (meta.results[0] ?? {}) as { mx: number | null; low: number | null };
  const mx = m.mx ?? 0;
  const low = m.low ?? null;
  const t = now();

  // 1. 每个频道发探针, 记水位, 算出本轮清扫区间
  const plans: Plan[] = [];
  let complete = true;
  for (const ch of rows) {
    if (tgBudget <= 0) { complete = false; break; }
    try {
      tgBudget--;
      out.probes++;
      const probe = await tgCall<{ message_id: number }>(bot.token, 'sendMessage', { chat_id: ch.id, text: 'hxd sweep probe', disable_notification: true });
      // 第一次: 从探针之前开始, 探针自己下一轮会被清掉
      const sw = parseSweep(ch.sweep) ?? { s: probe.message_id - 1, t, r: mx, k: [] };
      applyLow(sw, low);
      sw.k.push([probe.message_id, t, mx]);
      const target = pickTarget(sw, t);
      plans.push({ id: ch.id, sw, hi: target === null ? null : Math.min(target, sw.s + MAX_IDS_PER_ROUND) });
    } catch (e) {
      complete = false;
      if (e instanceof TgFatal) { await markDead(env, bot.id, e.message); break; }
      if (e instanceof TgRateLimit) break;
      console.error('sweep probe failed', ch.id, e);
    }
  }

  // 2. 一条查询拿到所有频道里被新 blob 引用的消息 id
  const due = plans.filter((p) => p.hi !== null);
  const used = new Map<string, Set<number>>();
  if (due.length) {
    const minS = Math.min(...due.map((p) => p.sw.s));
    const legacy = due.some((p) => p.sw.r === undefined);
    // 旧水位没有 rowid 时退回按 created_at 过滤 (全表), 有 rowid 后走主键范围
    const cond = legacy ? 'b.created_at >= ?1' : 'b.rowid > ?1';
    const bound = legacy ? Math.min(...due.map((p) => p.sw.t)) : Math.min(...due.map((p) => p.sw.r!));
    const r = await env.DB.prepare(
      `SELECT DISTINCT c, m FROM (
         SELECT json_extract(j.value, '$.c') AS c, json_extract(j.value, '$.m') AS m
         FROM blobs b, json_each(b.manifest) j
         WHERE ${cond} AND json_type(b.manifest) = 'array'
         UNION ALL
         SELECT json_extract(j.value, '$.c'), json_extract(j.value, '$.m')
         FROM blobs b JOIN blob_parts p ON p.blob_id = b.id, json_each(p.refs) j
         WHERE ${cond}
       ) WHERE m > ?2`,
    ).bind(bound, minS).all<{ c: string | number; m: number }>();
    for (const x of r.results) {
      const c = String(x.c);
      let set = used.get(c);
      if (!set) used.set(c, (set = new Set()));
      set.add(x.m);
    }
  }

  // 3. 逐频道删孤儿, 推进水位, 写回 (每频道 1 行)
  const writes: D1PreparedStatement[] = [];
  for (const p of plans) {
    const sw = p.sw;
    if (p.hi !== null) {
      const hi = p.hi;
      const ref = used.get(p.id) ?? new Set<number>();
      const orphans: number[] = [];
      for (let id = sw.s + 1; id <= hi; id++) if (!ref.has(id)) orphans.push(id);
      let reached = sw.s;
      let i = 0;
      try {
        for (; i < orphans.length && tgBudget > 0; i += DELETE_BATCH) {
          const part = orphans.slice(i, i + DELETE_BATCH);
          tgBudget--;
          out.sweepCalls++;
          // 超过 48 小时或已不存在的返回 false, 同样视为处理过
          await deleteMessages(bot, p.id, part);
          out.swept += part.length;
          reached = part[part.length - 1];
        }
      } catch (e) {
        if (e instanceof TgFatal) await markDead(env, bot.id, e.message);
        else if (!(e instanceof TgRateLimit)) console.error('sweep channel failed', p.id, e);
        tgBudget = 0;
        i = -1;
      }
      // 全部处理完就推进到 hi, 否则推进到最后删过的 id (中间被引用的 id 不需要处理)
      const next = i >= orphans.length ? hi : reached;
      if (next > sw.s) advance(sw, next);
    }
    sw.k = sw.k.filter(([id]) => id > sw.s).slice(-64);
    writes.push(env.DB.prepare('UPDATE channels SET sweep = ? WHERE id = ?').bind(JSON.stringify(sw), p.id));
  }
  // 不清扫的频道 (只读, 停用) 也要压一下: 以后恢复写入时, 它旧水位里的 rowid 不能比复用后的新行大
  if (low !== null) {
    for (const ch of all) {
      const sw = ch.status === 'active' ? null : parseSweep(ch.sweep);
      if (!sw) continue;
      applyLow(sw, low);
      writes.push(env.DB.prepare('UPDATE channels SET sweep = ? WHERE id = ?').bind(JSON.stringify(sw), ch.id));
    }
  }
  // 所有频道的水位都压过 low 并写回了, 才能清掉它; purge 期间改过 low 时 (n 对不上) 留着下轮再用
  if (complete && low !== null) writes.push(env.DB.prepare(`DELETE FROM counters WHERE name = '${ROWID_LOW}' AND n = ?`).bind(low));
  if (writes.length) await env.DB.batch(writes);
  return out;
}
