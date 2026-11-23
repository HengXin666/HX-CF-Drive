/**
 * 定时维护 (默认每 15 分钟)。免费计划单次调用 50 个子请求, 这里把 TG 调用控制在 ~30 次以内。
 * 1. 从 BOT_TOKENS 补种 Bot; 冷却到期 / 失效 Bot 探活
 * 2. 过期上传会话 → 中止
 * 3. 回收站超期 → 硬删除节点, blob 引用归零 → 标记 purging
 * 4. purging 的 blob → 删 R2 对象 / 删 TG 消息
 * 5. 审计日志保留 30 天
 */
import type { Env } from '../env';
import { num } from '../env';
import { r2Key } from '../drivers/r2';
import { allBots, deleteMessage, markBot, seedBotsFromEnv, tgCall } from '../drivers/tg';
import { now } from '../lib/util';
import { abortUpload, type SessionRow } from './upload';

const TG_BUDGET = 30;

export async function runMaintenance(env: Env): Promise<Record<string, number>> {
  const out: Record<string, number> = { seeded: 0, probed: 0, sessions: 0, nodes: 0, blobs: 0, tgDeletes: 0 };
  let budget = TG_BUDGET;
  const t = now();

  out.seeded = await seedBotsFromEnv(env);

  // 1. 探活: 冷却已到期的, 以及每小时一次检查 dead 的
  for (const b of await allBots(env)) {
    if (budget <= 0) break;
    const due = (b.status === 'cooldown' && b.retry_until <= t) || (b.status === 'dead' && b.retry_until <= t);
    if (!due) continue;
    budget--;
    out.probed++;
    try {
      const me = await tgCall<{ username: string }>(b.token, 'getMe');
      await env.DB.prepare('UPDATE bots SET username = ? WHERE id = ?').bind(me.username, b.id).run();
      await markBot(env, b.id, 'active');
      await env.LIMITER.get(env.LIMITER.idFromName('global')).clear(b.id);
    } catch (e) {
      await markBot(env, b.id, b.status, t + 3600_000, String(e));
    }
  }

  // 2. 过期上传会话
  const stale = await env.DB.prepare('SELECT * FROM upload_sessions WHERE expires_at < ? LIMIT 20').bind(t).all<SessionRow>();
  for (const s of stale.results) {
    await abortUpload(env, s);
    out.sessions++;
  }

  // 3. 回收站超期: 只处理文件节点的 blob 引用, 然后整批硬删除
  const cutoff = t - num(env.TRASH_DAYS, 7) * 86400_000;
  const expired = await env.DB.prepare('SELECT id, blob_id FROM nodes WHERE deleted_at IS NOT NULL AND deleted_at < ? LIMIT 200')
    .bind(cutoff)
    .all<{ id: string; blob_id: string | null }>();
  if (expired.results.length) {
    const stmts = [];
    for (const n of expired.results) {
      if (n.blob_id) {
        stmts.push(env.DB.prepare('UPDATE blobs SET ref_count = ref_count - 1 WHERE id = ?').bind(n.blob_id));
        stmts.push(env.DB.prepare("UPDATE blobs SET status = 'purging' WHERE id = ? AND ref_count <= 0").bind(n.blob_id));
      }
      stmts.push(env.DB.prepare('DELETE FROM shares WHERE node_id = ?').bind(n.id));
      stmts.push(env.DB.prepare('DELETE FROM nodes WHERE id = ?').bind(n.id));
    }
    await env.DB.batch(stmts);
    out.nodes = expired.results.length;
  }

  // 4. 清理 purging 的 blob
  const purging = await env.DB.prepare("SELECT id, driver FROM blobs WHERE status = 'purging' LIMIT 10").all<{ id: string; driver: string }>();
  const bots = new Map((await allBots(env)).map((b) => [b.id, b]));
  for (const b of purging.results) {
    if (b.driver === 'r2') {
      await env.BUCKET.delete(r2Key(b.id));
      await env.DB.batch([
        env.DB.prepare('DELETE FROM chunks WHERE blob_id = ?').bind(b.id),
        env.DB.prepare('DELETE FROM blobs WHERE id = ?').bind(b.id),
      ]);
      out.blobs++;
      continue;
    }
    const chunks = await env.DB.prepare('SELECT idx, channel_id, message_id, bot_id FROM chunks WHERE blob_id = ? LIMIT ?')
      .bind(b.id, Math.max(budget, 0))
      .all<{ idx: number; channel_id: string; message_id: number; bot_id: string }>();
    for (const c of chunks.results) {
      if (budget <= 0) break;
      const bot = bots.get(c.bot_id) ?? [...bots.values()].find((x) => x.status === 'active');
      budget--;
      try {
        if (bot) await deleteMessage(bot, c.channel_id, c.message_id);
      } catch {
        /* 删不掉就留在频道里, 不影响一致性 */
      }
      await env.DB.prepare('DELETE FROM chunks WHERE blob_id = ? AND idx = ?').bind(b.id, c.idx).run();
      out.tgDeletes++;
    }
    const left = await env.DB.prepare('SELECT COUNT(*) AS n FROM chunks WHERE blob_id = ?').bind(b.id).first<{ n: number }>();
    if (!left || left.n === 0) {
      await env.DB.prepare('DELETE FROM blobs WHERE id = ?').bind(b.id).run();
      out.blobs++;
    }
    if (budget <= 0) break;
  }

  // 5. 审计日志保留 30 天
  await env.DB.prepare('DELETE FROM audit_log WHERE at < ?').bind(t - 30 * 86400_000).run();
  return out;
}
