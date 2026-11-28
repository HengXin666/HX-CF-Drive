/**
 * 定时维护。免费计划单次调用 50 个子请求, TG 调用控制在 40 次以内。
 * 1. 从 BOT_TOKENS 补种 Bot; dead Bot 探活
 * 2. 回收站超期 → 硬删除节点, blob 引用减一
 * 3. 引用归零的 blob → deleteMessages 批量删 TG 消息, 删行
 * 4. 孤儿消息清扫: 上传了但没 commit 的分片 (见 sweep.ts), 用剩下的 TG 预算
 * 5. 重算用量快照 (见 stats.ts): 每轮一次全表扫描, /admin/stats 只读快照
 * 返回 more=1 表示还有积压, 调用方可以接着调 (maintenance.yml 会循环)。
 * 没有活干时只有几次空查询, D1 读写接近零。
 */
import type { Env } from '../env';
import { allBots, invalidateBotCache, seedBotsFromEnv, tgCall } from '../drivers/tg';
import { purgeAll } from './purge';
import { snapshotUsage } from './stats';
import { sweepOrphans } from './sweep';

const TG_BUDGET = 40;

export async function runMaintenance(env: Env, opts: { sweep?: boolean } = {}): Promise<Record<string, number>> {
  let budget = TG_BUDGET;
  const seeded = await seedBotsFromEnv(env);

  // 1. dead Bot 探活 (token 被撤销的会一直失败, 最多试 3 个)
  let revived = 0;
  for (const b of (await allBots(env)).filter((x) => x.status === 'dead').slice(0, 3)) {
    budget--;
    try {
      const me = await tgCall<{ username: string }>(b.token, 'getMe');
      await env.DB.prepare("UPDATE bots SET status = 'active', username = ?, last_error = NULL WHERE id = ?").bind(me.username, b.id).run();
      revived++;
    } catch {
      /* 继续保持 dead */
    }
  }
  if (revived) invalidateBotCache();

  // 2, 3. 硬删除
  // 留 2 个给孤儿清扫的探针, 保证每轮都能记下水位
  const r = await purgeAll(env, Math.max(budget - 2, 1), 300);
  budget -= r.tgCalls;

  // 4. 孤儿消息清扫
  // 循环调用时只有第一次清扫 (?sweep=0), 免得一轮发很多条探针
  const s = opts.sweep === false ? {} : await sweepOrphans(env, budget);

  // 5. 用量快照: 循环调用 (?sweep=0) 时不重复算
  if (opts.sweep !== false) await snapshotUsage(env);
  return { seeded, revived, ...r, ...s };
}
