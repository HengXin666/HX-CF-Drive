/**
 * 定时维护 (默认每天一次)。免费计划单次调用 50 个子请求, TG 调用控制在 40 次以内。
 * 1. 从 BOT_TOKENS 补种 Bot; dead Bot 探活
 * 2. 回收站超期 → 硬删除节点, blob 引用减一
 * 3. 引用归零的 blob → 删 TG 消息, 删行
 * 没有活干时只有几次空查询, D1 读写接近零。
 */
import type { Env } from '../env';
import { num } from '../env';
import { allBots, deleteMessage, invalidateBotCache, seedBotsFromEnv, tgCall } from '../drivers/tg';
import { now } from '../lib/util';
import { forgetBlob } from './serve';
import type { ChunkRef } from './upload';

const TG_BUDGET = 40;

export async function runMaintenance(env: Env): Promise<Record<string, number>> {
  const out: Record<string, number> = { seeded: 0, revived: 0, nodes: 0, blobs: 0, tgDeletes: 0 };
  let budget = TG_BUDGET;

  out.seeded = await seedBotsFromEnv(env);

  // 1. dead Bot 探活 (token 被撤销的会一直失败, 最多试 3 个)
  for (const b of (await allBots(env)).filter((x) => x.status === 'dead').slice(0, 3)) {
    budget--;
    try {
      const me = await tgCall<{ username: string }>(b.token, 'getMe');
      await env.DB.prepare("UPDATE bots SET status = 'active', username = ?, last_error = NULL WHERE id = ?").bind(me.username, b.id).run();
      out.revived++;
    } catch {
      /* 继续保持 dead */
    }
  }
  if (out.revived) invalidateBotCache();

  // 2. 回收站超期。删除目录时只标记了顶层, 清理到目录时给直接子项标上同样的时间戳,
  //    同一轮里继续往下清, 每轮最多 200 个节点, 清不完下次接着来
  const cutoff = now() - num(env.TRASH_DAYS, 7) * 86400_000;
  for (let pass = 0; pass < 8 && out.nodes < 200; pass++) {
    const expired = await env.DB.prepare('SELECT id, kind, blob_id, deleted_at FROM nodes WHERE deleted_at IS NOT NULL AND deleted_at < ? LIMIT ?')
      .bind(cutoff, 200 - out.nodes)
      .all<{ id: string; kind: string; blob_id: string | null; deleted_at: number }>();
    if (!expired.results.length) break;
    const stmts = [];
    for (const n of expired.results) {
      if (n.kind === 'dir') stmts.push(env.DB.prepare('UPDATE nodes SET deleted_at = ? WHERE parent_id = ? AND deleted_at IS NULL').bind(n.deleted_at, n.id));
      if (n.blob_id) stmts.push(env.DB.prepare('UPDATE blobs SET ref_count = ref_count - 1 WHERE id = ?').bind(n.blob_id));
      stmts.push(env.DB.prepare('DELETE FROM shares WHERE node_id = ?').bind(n.id));
      stmts.push(env.DB.prepare('DELETE FROM nodes WHERE id = ?').bind(n.id));
    }
    await env.DB.batch(stmts);
    out.nodes += expired.results.length;
  }

  // 3. 清理引用归零的 blob
  const orphans = await env.DB.prepare('SELECT id, manifest FROM blobs WHERE ref_count <= 0 LIMIT 5').all<{ id: string; manifest: string }>();
  const bots = await allBots(env);
  const byId = new Map(bots.map((b) => [b.id, b]));
  const fallback = bots.find((b) => b.status === 'active');
  for (const row of orphans.results) {
    const refs: ChunkRef[] = JSON.parse(row.manifest);
    const left: ChunkRef[] = [];
    for (const ch of refs) {
      if (budget <= 0) {
        left.push(ch);
        continue;
      }
      budget--;
      const bot = byId.get(ch.b) ?? fallback;
      try {
        if (bot) await deleteMessage(bot, ch.c, ch.m);
        out.tgDeletes++;
      } catch {
        // 删不掉 (Bot 没有删除权限等) 就留在频道里, 不影响一致性
      }
    }
    forgetBlob(row.id);
    if (left.length) {
      await env.DB.prepare('UPDATE blobs SET manifest = ? WHERE id = ?').bind(JSON.stringify(left), row.id).run();
      break;
    }
    await env.DB.prepare('DELETE FROM blobs WHERE id = ?').bind(row.id).run();
    out.blobs++;
  }
  return out;
}
