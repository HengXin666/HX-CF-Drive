import type { Context, Next } from 'hono';
import type { AppEnv, Env, Principal } from '../env';
import { HttpError, now, safeEqual, sha256Hex } from './util';

/**
 * 从 Authorization: Bearer 或 Basic (WebDAV, 密码即令牌) 中取令牌。
 * 不接受 ?token=: URL 会进浏览器历史, 代理日志和 Referer。
 * 不需要令牌的访问用签名直链 /f/ 或分享链接 /s/。
 */
export function extractToken(req: Request): string | null {
  const h = req.headers.get('Authorization');
  if (h?.startsWith('Bearer ')) return h.slice(7).trim();
  if (h?.startsWith('Basic ')) {
    try {
      const raw = atob(h.slice(6).trim());
      const i = raw.indexOf(':');
      return i >= 0 ? raw.slice(i + 1): raw;
    } catch {
      return null;
    }
  }
  return null;
}

export async function resolvePrincipal(env: Env, token: string | null): Promise<Principal | null> {
  if (!token) return null;
  if (env.ADMIN_TOKEN && safeEqual(token, env.ADMIN_TOKEN)) {
    return { id: 'admin', scopes: new Set(['read', 'write', 'admin']), rootId: 'root' };
  }
  const hash = await sha256Hex(token);
  const row = await env.DB.prepare('SELECT id, scopes, root_id, expires_at FROM tokens WHERE token_hash = ?')
    .bind(hash)
    .first<{ id: string; scopes: string; root_id: string; expires_at: number | null}>();
  if (!row) return null;
  if (row.expires_at && row.expires_at < now()) return null;
  return { id: row.id, scopes: new Set(row.scopes.split(',').map((s) => s.trim())), rootId: row.root_id };
}

/** 中间件: 要求某个权限 */
export function requireScope(scope: 'read' | 'write' | 'admin' | 'stats') {
  return async (c: Context<AppEnv>, next: Next) => {
    let p = c.get('principal');
    if (!p) {
      const found = await resolvePrincipal(c.env, extractToken(c.req.raw));
      if (!found) {
        const basic = c.req.path.startsWith('/dav');
        throw new HttpError(401, 'unauthorized', basic ? { 'WWW-Authenticate': 'Basic realm="HX-CF-Drive"' } : undefined);
      }
      p = found;
      c.set('principal', p);
    }
    if (!p.scopes.has(scope) && !p.scopes.has('admin')) throw new HttpError(403, `missing scope: ${scope}`);
    await next();
  };
}

/** 令牌是否仍然有效 (直链校验用)。isolate 内缓存 60 秒, 吊销后最多 60 秒内失效 */
const aliveCache = new Map<string, { at: number; ok: boolean }>();
export async function tokenAlive(env: Env, tid: string): Promise<boolean> {
  if (tid === 'admin') return true;
  const hit = aliveCache.get(tid);
  if (hit && now() - hit.at < 60_000) return hit.ok;
  const row = await env.DB.prepare('SELECT expires_at FROM tokens WHERE id = ?').bind(tid).first<{ expires_at: number | null }>();
  const ok = !!row && !(row.expires_at && row.expires_at < now());
  if (aliveCache.size > 1000) aliveCache.clear();
  aliveCache.set(tid, { at: now(), ok });
  return ok;
}
export function forgetToken(tid: string): void {
  aliveCache.delete(tid);
}
