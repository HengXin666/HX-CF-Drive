/**
 * 用量统计 (#23 第 1 项)。
 * 节点数与 blob 总量要全表扫 nodes + blobs (读行 ≈ 存活节点数 + blob 数), 不能每次打开页面都扫:
 * - 定时维护每轮 (每 6 小时) 重算一次, 写进 counters 的 stat_* 几行; 值没变的行不写 (ON CONFLICT ... WHERE)
 * - /admin/stats 只读快照, 读行只剩 bots + channels + counters 几行; isolate 内再缓存 30 秒
 * - 还没有快照 (刚部署, 维护还没跑过) 时现算一次, 只缓存在 isolate 内存里 5 分钟, 读路径不写 D1
 */
import type { Env } from '../env';
import { now } from '../lib/util';

export interface Usage { nodes: { kind: string; n: number }[]; blobs: { n: number; bytes: number }; at: number }

export const STAT_KEYS = ['stat_files', 'stat_dirs', 'stat_blobs', 'stat_bytes', 'stat_at'] as const;

/** 全表扫描算用量: 只在维护时, 或还没有快照时调用 */
export async function computeUsage(env: Env): Promise<Usage> {
  const [nodes, blobs] = await env.DB.batch([
    env.DB.prepare('SELECT kind, COUNT(*) AS n FROM nodes WHERE deleted_at IS NULL GROUP BY kind'),
    env.DB.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(size),0) AS bytes FROM blobs'),
  ]);
  const b = (blobs.results[0] ?? { n: 0, bytes: 0 }) as { n: number; bytes: number };
  return { nodes: nodes.results as { kind: string; n: number }[], blobs: { n: b.n, bytes: b.bytes }, at: now() };
}

/** 维护时重算并写快照。值没变的计数不产生写行, stat_at 每轮 1 行 */
export async function snapshotUsage(env: Env): Promise<Usage> {
  const u = await computeUsage(env);
  const n = (k: string) => u.nodes.find((x) => x.kind === k)?.n ?? 0;
  const vals: [string, number][] = [
    ['stat_files', n('file')], ['stat_dirs', n('dir')], ['stat_blobs', u.blobs.n], ['stat_bytes', u.blobs.bytes], ['stat_at', u.at],
  ];
  await env.DB.batch(vals.map(([k, v]) => env.DB.prepare(
    'INSERT INTO counters (name, n) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET n = excluded.n WHERE counters.n <> excluded.n',
  ).bind(k, v)));
  invalidateStats();
  return u;
}

/** 从 counters 行里取出快照; 没有快照返回 null */
export function usageFromCounters(c: Record<string, number>): Usage | null {
  if (!c.stat_at) return null;
  return {
    nodes: [{ kind: 'dir', n: c.stat_dirs ?? 0 }, { kind: 'file', n: c.stat_files ?? 0 }],
    blobs: { n: c.stat_blobs ?? 0, bytes: c.stat_bytes ?? 0 },
    at: c.stat_at,
  };
}

let liveCache: { at: number; u: Usage } | null = null;
/** 没有快照时的兜底: 现算, isolate 内缓存 5 分钟 */
export async function liveUsage(env: Env): Promise<Usage> {
  if (liveCache && now() - liveCache.at < 300_000) return liveCache.u;
  const u = await computeUsage(env);
  liveCache = { at: now(), u };
  return u;
}

/** 整个 stats 响应的 isolate 缓存 (30 秒)。Bot, 频道变更和维护后清掉 */
let statsCache: { at: number; body: unknown; admin: boolean } | null = null;
export function cachedStats(admin: boolean): unknown | null {
  return statsCache && statsCache.admin === admin && now() - statsCache.at < 30_000 ? statsCache.body : null;
}
export function putStats(admin: boolean, body: unknown): void {
  statsCache = { at: now(), body, admin };
}
export function invalidateStats(): void {
  statsCache = null;
  liveCache = null;
}
