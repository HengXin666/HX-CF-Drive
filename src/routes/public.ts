/** 无需令牌的公开访问: 签名直链 /f/:id 和分享链接 /s/:id */
import { Hono } from 'hono';
import type { AppEnv, Env } from '../env';
import { verifyLink } from '../lib/sign';
import { tokenAlive } from '../lib/auth';
import { getNode, getNodeCached, listChildren, type NodeRow, publicNode, resolvePath } from '../lib/tree';
import { HttpError, sha256Hex } from '../lib/util';
import { serveNode } from '../services/serve';

export const pub = new Hono<AppEnv>();

async function cachedNode(env: Env, id: string): Promise<NodeRow> {
  const n = await getNodeCached(env, id);
  if (!n) throw new HttpError(404, 'not found');
  return n;
}

// /f/:id 或 /f/:id/文件名 (文件名仅用于美观和扩展名识别)
pub.on(['GET', 'HEAD'], ['/f/:id', '/f/:id/:name'], async (c) => {
  const id = c.req.param('id');
  const exp = Number(c.req.query('e') ?? 'x');
  const sig = c.req.query('s') ?? '';
  const tid = c.req.query('t') || 'admin';
  if (!Number.isFinite(exp) || !(await verifyLink(c.env.SIGNING_KEY, id, exp, sig, undefined, tid))) throw new HttpError(403, 'bad or expired signature');
  if (!(await tokenAlive(c.env, tid))) throw new HttpError(403, 'link revoked');
  const node = await cachedNode(c.env, id);
  return serveNode(c.env, node, c.req.raw, {
    edgeCache: exp === 0,
    download: c.req.query('download') === '1',
    waitUntil: (p) => c.executionCtx.waitUntil(p),
  });
});

const SHARE_MAX_FAILS = 10;
const SHARE_LOCK_MS = 15 * 60_000;

// 分享: 文件直接下载; 目录返回 JSON 列表, ?path= 访问子项
pub.on(['GET', 'HEAD'], '/s/:id', async (c) => {
  const share = await c.env.DB.prepare('SELECT * FROM shares WHERE id = ?')
    .bind(c.req.param('id'))
    .first<{ id: string; node_id: string; password_hash: string | null; expires_at: number | null; fails: number; locked_until: number | null }>();
  if (!share || (share.expires_at && share.expires_at < Date.now())) throw new HttpError(404, 'share not found or expired');
  if (share.password_hash) {
    const t = Date.now();
    if (share.locked_until && share.locked_until > t) {
      c.header('Retry-After', String(Math.ceil((share.locked_until - t) / 1000)));
      throw new HttpError(429, 'too many wrong passwords, try later');
    }
    const pw = c.req.header('X-Share-Password') ?? c.req.query('p') ?? '';
    if ((await sha256Hex(`${share.id}:${pw}`)) !== share.password_hash) {
      // 没带密码 (第一次打开) 不计数; 带错了才计数, 满 SHARE_MAX_FAILS 次锁 SHARE_LOCK_MS, 状态在 D1 里, 多 isolate 也绕不过
      if (pw) {
        const lock = share.fails + 1 >= SHARE_MAX_FAILS;
        await c.env.DB.prepare('UPDATE shares SET fails = ?, locked_until = ? WHERE id = ?')
          .bind(lock ? 0 : share.fails + 1, lock ? t + SHARE_LOCK_MS : share.locked_until, share.id).run();
      }
      throw new HttpError(401, 'password required');
    }
    if (share.fails) await c.env.DB.prepare('UPDATE shares SET fails = 0 WHERE id = ?').bind(share.id).run();
  }
  const root = await getNode(c.env, share.node_id);
  if (!root) throw new HttpError(404, 'shared item removed');
  const sub = c.req.query('path');
  const node = sub ? await resolvePath(c.env, root.id, sub): root;
  if (!node) throw new HttpError(404, 'not found');
  if (node.kind === 'dir') {
    return c.json({ node: publicNode(node), children: (await listChildren(c.env, node.id)).map(publicNode) });
  }
  return serveNode(c.env, node, c.req.raw, {
    download: c.req.query('download') === '1',
    waitUntil: (p) => c.executionCtx.waitUntil(p),
  });
});
