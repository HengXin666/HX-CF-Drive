/** 无需令牌的公开访问: 签名直链 /f/:id 和分享链接 /s/:id */
import { Hono, type Context } from 'hono';
import type { AppEnv, Env } from '../env';
import { verifyLink } from '../lib/sign';
import { tokenAlive } from '../lib/auth';
import { getNode, getNodeCached, listChildren, type NodeRow, publicNode, resolvePath } from '../lib/tree';
import { HttpError, sha256Hex } from '../lib/util';
import { serveNode } from '../services/serve';
import { dirPage, errorPage, filePage, passwordPage, wantsHtml } from './sharePage';

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

// 分享: 文件直接下载; 目录返回 JSON 列表, ?path= 访问子项。浏览器 (Accept: text/html) 打开时给页面, 见 sharePage.ts
pub.on(['GET', 'HEAD'], '/s/:id', async (c) => {
  const html = wantsHtml(c.req.raw, c.req.query());
  try {
    return await openShare(c, html);
  } catch (e) {
    if (!html || !(e instanceof HttpError)) throw e;
    const id = c.req.param('id');
    const pw = c.req.header('X-Share-Password') ?? c.req.query('p') ?? '';
    if (e.status === 401) return page(passwordPage(id, { wrong: !!pw }), 401);
    if (e.status === 429) return page(passwordPage(id, { locked: Number(e.headers?.['Retry-After'] ?? 60) }), 429, e.headers);
    if (e.status === 404) return page(errorPage('分享不存在', '链接可能已过期, 被撤销, 或文件已被删除。'), 404);
    return page(errorPage('打不开这个分享', e.message), e.status);
  }
});

// 页面不执行脚本, 不加载外部资源; 链接里可能带 ?p=, 不发 Referer, 不缓存
const PAGE_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};

function page(body: string, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { ...PAGE_HEADERS, ...extra } });
}

async function openShare(c: Context<AppEnv>, html: boolean): Promise<Response> {
  const share = await c.env.DB.prepare('SELECT * FROM shares WHERE id = ?')
    .bind(c.req.param('id'))
    .first<{ id: string; node_id: string; password_hash: string | null; expires_at: number | null; fails: number; locked_until: number | null }>();
  if (!share || (share.expires_at && share.expires_at < Date.now())) throw new HttpError(404, 'share not found or expired');
  const pw = c.req.header('X-Share-Password') ?? c.req.query('p') ?? '';
  if (share.password_hash) {
    const t = Date.now();
    if (share.locked_until && share.locked_until > t) {
      throw new HttpError(429, 'too many wrong passwords, try later', { 'Retry-After': String(Math.ceil((share.locked_until - t) / 1000)) });
    }
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
  const ctx = { id: share.id, pw: share.password_hash ? pw : '' };
  if (node.kind === 'dir') {
    const children = await listChildren(c.env, node.id);
    if (html) return page(dirPage(ctx, root, sub ?? '', children));
    return c.json({ node: publicNode(node), children: children.map(publicNode) });
  }
  if (html) return page(filePage(ctx, node, sub));
  return serveNode(c.env, node, c.req.raw, {
    download: c.req.query('download') === '1',
    waitUntil: (p) => c.executionCtx.waitUntil(p),
  });
}
