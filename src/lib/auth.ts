import type { Context, Next } from 'hono';
import type { AppEnv, Env, Principal } from '../env';
import { HttpError, now, safeEqual, sha256Hex } from './util';

/** 从 Authorization: Bearer / Basic (WebDAV, 密码即令牌) / ?token= 中取令牌 */
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
  const q = new URL(req.url).searchParams.get('token');
  return q || null;
}

export async function resolvePrincipal(env: Env, token: string | null): Promise<Principal | null> {
  if (!token) return null;
  if (env.ADMIN_TOKEN && safeEqual(token, env.ADMIN_TOKEN)) {
    return { id: 'admin', scopes: new Set(['read', 'write', 'admin']), rootId: 'root' };
  }
  const hash = await sha256Hex(token);
  const row = await env.DB.prepare('SELECT id, scopes, root_id, expires_at, last_used_at FROM tokens WHERE token_hash = ?')
    .bind(hash)
    .first<{ id: string; scopes: string; root_id: string; expires_at: number | null; last_used_at: number | null }>();
  if (!row) return null;
  if (row.expires_at && row.expires_at < now()) return null;
  // last_used_at 每小时最多写一次, 节省 D1 写入
  if (!row.last_used_at || now() - row.last_used_at > 3600_000) {
    await env.DB.prepare('UPDATE tokens SET last_used_at = ? WHERE id = ?').bind(now(), row.id).run();
  }
  return { id: row.id, scopes: new Set(row.scopes.split(',').map((s) => s.trim())), rootId: row.root_id };
}

/** 中间件: 要求某个权限 */
export function requireScope(scope: 'read' | 'write' | 'admin') {
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
