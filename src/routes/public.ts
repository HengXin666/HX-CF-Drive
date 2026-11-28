/** 无需令牌的公开访问: 签名直链 /f/:id 和分享链接 /s/:id */
import { Hono, type Context } from 'hono';
import { getCookie } from 'hono/cookie';
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
// 分享页输对密码后发的 Cookie: 只对这个分享的路径有效, 1 天; 值是 HMAC, 改了密码或撤销分享即失效
const SHARE_COOKIE_SEC = 86_400;

interface ShareRow { id: string; node_id: string; password_hash: string | null; expires_at: number | null; fails: number; locked_until: number | null }

async function loadShare(env: Env, id: string): Promise<ShareRow> {
  const share = await env.DB.prepare('SELECT * FROM shares WHERE id = ?').bind(id).first<ShareRow>();
  if (!share || (share.expires_at && share.expires_at < Date.now())) throw new HttpError(404, 'share not found or expired');
  return share;
}

const cookieName = (id: string) => `hxs_${id}`;
const sharePath = (id: string) => `/s/${encodeURIComponent(id)}`;
const cookieValue = async (env: Env, share: ShareRow) => (await sha256Hex(`${env.SIGNING_KEY}:share:${share.id}:${share.password_hash}`)).slice(0, 32);

/** 校验密码; 错了计数, 满 SHARE_MAX_FAILS 次锁 SHARE_LOCK_MS (状态在 D1, 多 isolate 也绕不过)。没带密码 (第一次打开) 不计数 */
async function checkPassword(env: Env, share: ShareRow, pw: string): Promise<void> {
  const t = Date.now();
  if (share.locked_until && share.locked_until > t) {
    throw new HttpError(429, 'too many wrong passwords, try later', { 'Retry-After': String(Math.ceil((share.locked_until - t) / 1000)) });
  }
  if ((await sha256Hex(`${share.id}:${pw}`)) !== share.password_hash) {
    if (pw) {
      const lock = share.fails + 1 >= SHARE_MAX_FAILS;
      await env.DB.prepare('UPDATE shares SET fails = ?, locked_until = ? WHERE id = ?')
        .bind(lock ? 0 : share.fails + 1, lock ? t + SHARE_LOCK_MS : share.locked_until, share.id).run();
    }
    throw new HttpError(401, 'password required');
  }
  if (share.fails) await env.DB.prepare('UPDATE shares SET fails = 0 WHERE id = ?').bind(share.id).run();
}

// 页面不执行脚本, 不加载外部资源, 不发 Referer, 不缓存
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

function errorAsPage(e: HttpError, id: string, path: string, pwGiven: boolean): Response {
  if (e.status === 401) return page(passwordPage(id, path, { wrong: pwGiven }), 401);
  if (e.status === 429) return page(passwordPage(id, path, { locked: Number(e.headers?.['Retry-After'] ?? 60) }), 429, e.headers);
  if (e.status === 404) return page(errorPage('分享不存在', '链接可能已过期, 被撤销, 或文件已被删除。'), 404);
  return page(errorPage('打不开这个分享', e.message), e.status);
}

// 分享: 文件直接下载; 目录返回 JSON 列表, ?path= 访问子项。浏览器 (Accept: text/html) 打开时给页面, 见 sharePage.ts
pub.on(['GET', 'HEAD'], '/s/:id', async (c) => {
  const html = wantsHtml(c.req.raw, c.req.query());
  try {
    return await openShare(c, html);
  } catch (e) {
    if (!html || !(e instanceof HttpError)) throw e;
    return errorAsPage(e, c.req.param('id'), c.req.query('path') ?? '', !!(c.req.header('X-Share-Password') ?? c.req.query('p')));
  }
});

/** 分享页的密码表单: 密码只在请求体里, 对了发 Cookie 并跳回 (地址栏和历史里没有密码) */
pub.post('/s/:id', async (c) => {
  const id = c.req.param('id');
  const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
  const pw = typeof form.p === 'string' ? form.p : '';
  const path = typeof form.path === 'string' ? form.path : '';
  try {
    const share = await loadShare(c.env, id);
    if (share.password_hash) await checkPassword(c.env, share, pw);
    const back = `${sharePath(id)}${path ? `?${new URLSearchParams({ path })}` : ''}`;
    const cookie = share.password_hash
      ? `${cookieName(id)}=${await cookieValue(c.env, share)}; Path=${sharePath(id)}; Max-Age=${SHARE_COOKIE_SEC}; HttpOnly; Secure; SameSite=Lax`
      : '';
    return new Response(null, { status: 303, headers: { Location: back, 'Cache-Control': 'no-store', ...(cookie ? { 'Set-Cookie': cookie } : {}) } });
  } catch (e) {
    if (!(e instanceof HttpError)) throw e;
    return errorAsPage(e, id, path, !!pw);
  }
});

async function openShare(c: Context<AppEnv>, html: boolean): Promise<Response> {
  const share = await loadShare(c.env, c.req.param('id') ?? '');
  if (share.password_hash) {
    const pw = c.req.header('X-Share-Password') ?? c.req.query('p') ?? '';
    const passed = !pw && getCookie(c, cookieName(share.id)) === (await cookieValue(c.env, share));
    if (!passed) await checkPassword(c.env, share, pw);
  }
  const root = await getNode(c.env, share.node_id);
  if (!root) throw new HttpError(404, 'shared item removed');
  const sub = c.req.query('path');
  const node = sub ? await resolvePath(c.env, root.id, sub): root;
  if (!node) throw new HttpError(404, 'not found');
  if (node.kind === 'dir') {
    const children = await listChildren(c.env, node.id);
    if (html) return page(dirPage(share.id, root, sub ?? '', children));
    return c.json({ node: publicNode(node), children: children.map(publicNode) });
  }
  if (html) return page(filePage(share.id, node, sub));
  return serveNode(c.env, node, c.req.raw, {
    download: c.req.query('download') === '1',
    waitUntil: (p) => c.executionCtx.waitUntil(p),
  });
}
