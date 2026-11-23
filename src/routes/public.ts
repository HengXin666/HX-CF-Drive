/** 无需令牌的公开访问: 签名直链 /f/:id 和分享链接 /s/:id */
import { Hono } from 'hono';
import type { AppEnv, Env } from '../env';
import { verifyLink } from '../lib/sign';
import { getNode, listChildren, type NodeRow, publicNode, resolvePath } from '../lib/tree';
import { HttpError, sha256Hex } from '../lib/util';
import { serveNode } from '../services/serve';

export const pub = new Hono<AppEnv>();

/** 签名直链的节点缓存 60 秒: 热门图片反复访问时 D1 零读 */
const nodeCache = new Map<string, { at: number; n: NodeRow }>();
async function cachedNode(env: Env, id: string): Promise<NodeRow> {
  const hit = nodeCache.get(id);
  if (hit && Date.now() - hit.at < 60_000) return hit.n;
  const n = await getNode(env, id);
  if (!n) throw new HttpError(404, 'not found');
  if (nodeCache.size > 5000) nodeCache.clear();
  nodeCache.set(id, { at: Date.now(), n });
  return n;
}

// /f/:id 或 /f/:id/文件名 (文件名仅用于美观和扩展名识别)
pub.on(['GET', 'HEAD'], ['/f/:id', '/f/:id/:name'], async (c) => {
  const id = c.req.param('id');
  const exp = Number(c.req.query('e') ?? 'x');
  const sig = c.req.query('s') ?? '';
  if (!Number.isFinite(exp) || !(await verifyLink(c.env.SIGNING_KEY, id, exp, sig))) throw new HttpError(403, 'bad or expired signature');
  const node = await cachedNode(c.env, id);
  return serveNode(c.env, node, c.req.raw, {
    edgeCache: exp === 0,
    download: c.req.query('download') === '1',
    waitUntil: (p) => c.executionCtx.waitUntil(p),
  });
});

// 分享: 文件直接下载; 目录返回 JSON 列表, ?path= 访问子项
pub.on(['GET', 'HEAD'], '/s/:id', async (c) => {
  const share = await c.env.DB.prepare('SELECT * FROM shares WHERE id = ?')
    .bind(c.req.param('id'))
    .first<{ id: string; node_id: string; password_hash: string | null; expires_at: number | null }>();
  if (!share || (share.expires_at && share.expires_at < Date.now())) throw new HttpError(404, 'share not found or expired');
  if (share.password_hash) {
    const pw = c.req.query('p') ?? c.req.header('X-Share-Password') ?? '';
    if ((await sha256Hex(`${share.id}:${pw}`)) !== share.password_hash) throw new HttpError(401, 'password required');
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
