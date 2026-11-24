/**
 * 孤儿消息清扫 (#7): 上传了分片但没有 commit 的消息, D1 里没有记录, 只能按 message id 区间找出来删。
 *
 * 做法 (消息 id 水位, 上传热路径零写入):
 * - 每轮维护给每个频道发一条探针消息, 它的 message_id 就是当前水位, 记进 channels.sweep.k。
 * - 取 ≥ SAFE_AGE 之前记录的最新水位 T: 上传凭证 24 小时过期, 之后不可能再 commit 出引用 (s, T] 的 blob。
 * - (s, T] 里没被任何 blob 的 manifest 引用的 id 都是孤儿 (含探针本身), 用 deleteMessages 批量删, 推进 s。
 * - 引用判断在 D1 里用 json_each 做 (整行清单和 blob_parts 分段清单都算), 只扫 created_at ≥ 记录 s 时的时间的 blob, Worker 不解析 manifest。
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

export interface Sweep { s: number; t: number; k: [number, number][] }
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

/**
 * 清扫所有 active 频道。tgBudget 是可用的 TG 子请求数, 返回用掉的数量在 stats 里。
 */
export async function sweepOrphans(env: Env, tgBudget: number): Promise<SweepStats> {
  const out: SweepStats = { probes: 0, swept: 0, sweepCalls: 0 };
  if (env.ORPHAN_SWEEP === '0' || tgBudget <= 0) return out;
  const bot = (await allBots(env)).find((b) => b.status === 'active');
  if (!bot) return out;
  const chans = (await env.DB.prepare("SELECT id, sweep FROM channels WHERE status = 'active'").all<{ id: string; sweep: string | null }>()).results;
  for (const ch of chans) {
    if (tgBudget <= 0) break;
    try {
      tgBudget = await sweepChannel(env, bot, ch.id, parseSweep(ch.sweep), tgBudget, out);
    } catch (e) {
      if (e instanceof TgFatal) { await markDead(env, bot.id, e.message); break; }
      if (e instanceof TgRateLimit) break;
      console.error('sweep channel failed', ch.id, e);
    }
  }
  return out;
}

async function sweepChannel(env: Env, bot: BotRow, chan: string, sw: Sweep | null, budget: number, out: SweepStats): Promise<number> {
  const t = now();
  // 1. 探针: 拿到当前最大 message id 作为新水位
  budget--;
  out.probes++;
  const probe = await tgCall<{ message_id: number }>(bot.token, 'sendMessage', { chat_id: chan, text: 'hxd sweep probe', disable_notification: true });
  if (!sw) {
    // 第一次: 从探针之前开始, 探针自己下一轮会被清掉
    sw = { s: probe.message_id - 1, t, k: [] };
  }
  sw.k.push([probe.message_id, t]);

  // 2. 清扫 (s, T]
  const target = pickTarget(sw, t);
  if (target !== null) {
    const hi = Math.min(target, sw.s + MAX_IDS_PER_ROUND);
    const used = new Set(
      (await env.DB.prepare(
        `SELECT DISTINCT m FROM (
           SELECT json_extract(j.value, '$.m') AS m, json_extract(j.value, '$.c') AS c
           FROM blobs b, json_each(b.manifest) j
           WHERE b.created_at >= ?1 AND json_type(b.manifest) = 'array'
           UNION ALL
           SELECT json_extract(j.value, '$.m'), json_extract(j.value, '$.c')
           FROM blobs b JOIN blob_parts p ON p.blob_id = b.id, json_each(p.refs) j
           WHERE b.created_at >= ?1
         ) WHERE c = ?2 AND m > ?3 AND m <= ?4`,
      ).bind(sw.t, chan, sw.s, hi).all<{ m: number }>()).results.map((r) => r.m),
    );
    const orphans: number[] = [];
    for (let id = sw.s + 1; id <= hi; id++) if (!used.has(id)) orphans.push(id);
    let reached = sw.s;
    let i = 0;
    for (; i < orphans.length && budget > 0; i += DELETE_BATCH) {
      const part = orphans.slice(i, i + DELETE_BATCH);
      budget--;
      out.sweepCalls++;
      // 超过 48 小时或已不存在的返回 false, 同样视为处理过
      await deleteMessages(bot, chan, part);
      out.swept += part.length;
      reached = part[part.length - 1];
    }
    // 全部处理完就推进到 hi, 否则推进到最后删过的 id (中间被引用的 id 不需要处理)
    const next = i >= orphans.length ? hi : reached;
    if (next > sw.s) {
      sw.s = next;
      sw.t = latestAtOrBefore(sw, next) ?? sw.t;
    }
  }
  sw.k = sw.k.filter(([id]) => id > sw!.s).slice(-64);
  await env.DB.prepare('UPDATE channels SET sweep = ? WHERE id = ?').bind(JSON.stringify(sw), chan).run();
  return budget;
}

/**
 * 推进 s 之后, 新的 "t" 取不晚于 s 的那个水位的记录时间:
 * id > s 的消息一定发在该水位记录之后, 引用它们的 blob 的 created_at 也一定更晚。
 */
function latestAtOrBefore(sw: Sweep, s: number): number | null {
  let best: [number, number] | null = null;
  for (const w of sw.k) if (w[0] <= s && (!best || w[0] > best[0])) best = w;
  return best ? best[1] : null;
}
