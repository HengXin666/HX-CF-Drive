/**
 * 硬删除: 回收站超期节点 → blob 引用减一 → 引用归零的 blob 删 TG 消息, 删行。
 * 维护接口和 "彻底删除" 共用。TG 删除用 deleteMessages, 每次最多 100 条, 跨 blob 按频道打包。
 * Free 计划单次调用 50 个子请求, 50 次 D1 查询, 两者分开预算。
 */
import type { Env } from '../env';
import { num } from '../env';
import { allBots, type BotRow, DELETE_BATCH, deleteMessages, markDead, TgFatal, TgRateLimit } from '../drivers/tg';
import { now } from '../lib/util';
import { forgetBlob, parseManifest } from './serve';
import type { ChunkRef } from './upload';

export interface PurgeStats { nodes: number; blobs: number; tgDeletes: number; tgCalls: number; tgExpired: number; tgFailed: number }

/**
 * TG 只允许 Bot 删除 48 小时内的消息, 而 deleteMessages 一批里只要混进一条删不掉的, 整批都会失败。
 * blob 的 created_at 是 commit 时间, 分片最早可能在它之前 24 小时 (上传凭证有效期) 发出:
 * - commit 不到 23 小时: 分片一定还能删, 放进 "确定能删" 的批次
 * - 23 到 47 小时: 可能能删, 单独成批, 失败了不连累前一类
 * - 超过 47 小时: 一定删不掉, 不再浪费子请求, 只删 D1 记录并计入 tgExpired (字节留在频道, 不占 CF 额度)
 */
const SURE_MS = 23 * 3600_000;
const MAYBE_MS = 47 * 3600_000;
type Age = 0 | 1 | 2;
const ageOf = (createdAt: number, t: number): Age => (t - createdAt < SURE_MS ? 0 : t - createdAt < MAYBE_MS ? 1 : 2);

/** 回收站超期的截止时间。deleted_at = 1 表示 "彻底删除", 一定早于它 */
export function trashCutoff(env: Env): number {
  return now() - num(env.TRASH_DAYS, 7) * 86400_000;
}

/**
 * 硬删超期节点。删除目录时只标记了顶层, 清理到目录时给直接子项标上同样的时间戳,
 * 同一轮里继续往下清。每轮最多 maxNodes 个节点, 最多 passes 次查询 + 批量写。
 */
export async function purgeNodes(env: Env, maxNodes: number, passes = 8): Promise<number> {
  const cutoff = trashCutoff(env);
  let done = 0;
  for (let pass = 0; pass < passes && done < maxNodes; pass++) {
    const expired = await env.DB.prepare('SELECT id, kind, blob_id, deleted_at FROM nodes WHERE deleted_at IS NOT NULL AND deleted_at < ? LIMIT ?')
      .bind(cutoff, Math.min(200, maxNodes - done))
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
    done += expired.results.length;
  }
  return done;
}

/** 每个频道选一个能删消息的 Bot: 优先 active */
function deleter(bots: BotRow[]): BotRow | undefined {
  return bots.find((b) => b.status === 'active');
}

/** 一个清理单元: 整行清单 (part = null) 或分段清单的一段 */
interface Unit { blob: string; part: number | null; refs: ChunkRef[]; age: Age }

/**
 * 清理引用归零的 blob。tgBudget 是本次可用的 TG 子请求数。
 * 单元是整行清单, 或分段清单 (blob_parts) 的一段。先在内存里按频道把消息 id 打包成若干次 deleteMessages,
 * 预算放得下的单元整个删行; 第一个单元就放不下时只删一部分, 剩余清单写回。
 * 分段 blob 的所有段删完后才删 blobs 行。
 */
export async function purgeBlobs(env: Env, tgBudget: number, out: PurgeStats): Promise<void> {
  const bot = deleter(await allBots(env));
  if (!bot) return;
  for (let round = 0; round < 4 && tgBudget > 0; round++) {
    const rows = (await env.DB.prepare('SELECT id, manifest, created_at FROM blobs WHERE ref_count <= 0 LIMIT 100').all<{ id: string; manifest: string; created_at: number }>()).results;
    const t = now();
    const ageById = new Map(rows.map((r) => [r.id, ageOf(r.created_at, t)]));
    if (!rows.length) return;
    const units: Unit[] = [];
    const parted: string[] = [];
    for (const row of rows) {
      const m = parseManifest(row.manifest);
      if (m.parts) parted.push(row.id);
      else units.push({ blob: row.id, part: null, refs: m.refs, age: ageById.get(row.id)! });
    }
    if (parted.length) {
      const segs = (await env.DB.prepare('SELECT blob_id, idx, refs FROM blob_parts WHERE blob_id IN (SELECT value FROM json_each(?)) ORDER BY blob_id, idx LIMIT 200')
        .bind(JSON.stringify(parted)).all<{ blob_id: string; idx: number; refs: string }>()).results;
      for (const sg of segs) units.push({ blob: sg.blob_id, part: sg.idx, refs: JSON.parse(sg.refs) as ChunkRef[], age: ageById.get(sg.blob_id)! });
    }

    const perChan = new Map<string, number[]>();
    const calls = () => [...perChan.values()].reduce((a, l) => a + Math.ceil(l.length / DELETE_BATCH), 0);
    const whole: Unit[] = [];
    let partial: { u: Unit; left: ChunkRef[] } | null = null;
    // 键是 "年龄类别|频道", 不同类别不混在一批里
    for (const u of units) {
      if (u.age === 2) { whole.push(u); out.tgExpired += u.refs.length; continue; }
      const snapshot = new Map([...perChan].map(([k, v]) => [k, v.length]));
      for (const r of u.refs) {
        const key = `${u.age}|${r.c}`;
        let l = perChan.get(key);
        if (!l) perChan.set(key, (l = []));
        l.push(r.m);
      }
      if (calls() <= tgBudget) { whole.push(u); continue; }
      // 放不下: 退回本单元加入前的状态
      for (const [k, l] of perChan) l.length = snapshot.get(k) ?? 0;
      if (whole.length === 0) {
        // 第一个就放不下 (超大单元): 按顺序加到预算用完为止, 其余写回
        let k = 0;
        for (; k < u.refs.length; k++) {
          const r = u.refs[k];
          const key = `${u.age}|${r.c}`;
          let l = perChan.get(key);
          if (!l) perChan.set(key, (l = []));
          l.push(r.m);
          if (calls() > tgBudget) { l.pop(); break; }
        }
        partial = { u, left: u.refs.slice(k) };
      }
      break;
    }
    // 执行删除。限流或令牌失效: 本轮不删任何行, 下次重来 (已删的消息 TG 会跳过)
    try {
      for (const [key, ids] of perChan) {
        const chan = key.slice(key.indexOf('|') + 1);
        for (let i = 0; i < ids.length; i += DELETE_BATCH) {
          const part = ids.slice(i, i + DELETE_BATCH);
          tgBudget--;
          out.tgCalls++;
          if (await deleteMessages(bot, chan, part)) out.tgDeletes += part.length;
          else out.tgFailed += part.length; // 删不掉 (无权限或已超 48 小时): 计数, 让维护结果看得见留在频道里的量
        }
      }
    } catch (e) {
      if (e instanceof TgFatal) await markDead(env, bot.id, e.message);
      else if (!(e instanceof TgRateLimit)) throw e;
      return;
    }
    const stmts = whole.map((u) => u.part === null
      ? env.DB.prepare('DELETE FROM blobs WHERE id = ?').bind(u.blob)
      : env.DB.prepare('DELETE FROM blob_parts WHERE blob_id = ? AND idx = ?').bind(u.blob, u.part));
    if (partial) {
      const { u, left } = partial;
      stmts.push(u.part === null
        ? env.DB.prepare('UPDATE blobs SET manifest = ? WHERE id = ?').bind(JSON.stringify(left), u.blob)
        : env.DB.prepare('UPDATE blob_parts SET refs = ? WHERE blob_id = ? AND idx = ?').bind(JSON.stringify(left), u.blob, u.part));
    }
    // 段全部删完的分段 blob: 删 blobs 行
    if (parted.length) {
      stmts.push(env.DB.prepare('DELETE FROM blobs WHERE id IN (SELECT value FROM json_each(?)) AND NOT EXISTS (SELECT 1 FROM blob_parts p WHERE p.blob_id = blobs.id)')
        .bind(JSON.stringify(parted)));
    }
    let deleted = 0;
    if (stmts.length) {
      const res = await env.DB.batch(stmts);
      for (let i = 0; i < whole.length; i++) if (whole[i].part === null) deleted += res[i].meta.changes ?? 0;
      if (parted.length) deleted += res[res.length - 1].meta.changes ?? 0;
    }
    for (const id of new Set(units.map((u) => u.blob))) forgetBlob(id);
    out.blobs += deleted;
    if (partial || whole.length < units.length) return;
  }
}

/** 剩余工作量 (各最多数到 1000, 走部分索引, 没有积压时几乎零读) */
export async function backlog(env: Env): Promise<{ leftNodes: number; leftBlobs: number }> {
  const r = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM (SELECT 1 FROM nodes WHERE deleted_at IS NOT NULL AND deleted_at < ?1 LIMIT 1000)) AS n,
            (SELECT COUNT(*) FROM (SELECT 1 FROM blobs WHERE ref_count <= 0 LIMIT 1000)) AS b`,
  ).bind(trashCutoff(env)).first<{ n: number; b: number }>();
  return { leftNodes: r?.n ?? 0, leftBlobs: r?.b ?? 0 };
}

/** 一次完整的硬删除: 节点 + blob + 剩余量 */
export async function purgeAll(env: Env, tgBudget: number, maxNodes = 400): Promise<PurgeStats & { leftNodes: number; leftBlobs: number; more: number }> {
  const out: PurgeStats = { nodes: 0, blobs: 0, tgDeletes: 0, tgCalls: 0, tgExpired: 0, tgFailed: 0 };
  out.nodes = await purgeNodes(env, maxNodes);
  await purgeBlobs(env, tgBudget, out);
  const left = await backlog(env);
  return { ...out, ...left, more: left.leftNodes || left.leftBlobs ? 1 : 0 };
}
