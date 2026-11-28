import type { Context, Next } from 'hono';
import type { AppEnv, Env, Principal } from '../env';
import { epoch, mkdirp, resolvePath } from './tree';
import { HttpError, now, safeEqual, sha256Hex } from './util';

/** 调用方可用这个头把本次请求的根目录收窄到令牌根下的某个子目录 (如 HX-AIOA 的网盘只看 /drive) */
export const SCOPE_HEADER = 'X-Drive-Scope';

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

/**
 * 令牌 -> 身份, 按令牌哈希在 isolate 内缓存 60 秒 (#23): 普通令牌 / WebDAV Basic 不再每个请求查一次 D1。
 * 吊销语义和 tokenAlive 一致: 本 isolate 内 forgetToken 立即失效, 其他 isolate 最多 60 秒。只缓存有效令牌。
 */
const TTL = 60_000;
const principalCache = new Map<string, { at: number; p: Principal; exp: number | null }>();

export async function resolvePrincipal(env: Env, token: string | null): Promise<Principal | null> {
  if (!token) return null;
  if (env.ADMIN_TOKEN && safeEqual(token, env.ADMIN_TOKEN)) {
    return { id: 'admin', scopes: new Set(['read', 'write', 'admin']), rootId: 'root' };
  }
  const hash = await sha256Hex(token);
  const t = now();
  const hit = principalCache.get(hash);
  if (hit && t - hit.at < TTL) return hit.exp && hit.exp < t ? null : hit.p;
  const row = await env.DB.prepare('SELECT id, scopes, root_id, expires_at FROM tokens WHERE token_hash = ?')
    .bind(hash)
    .first<{ id: string; scopes: string; root_id: string; expires_at: number | null}>();
  if (!row) return null;
  if (row.expires_at && row.expires_at < t) return null;
  const p: Principal = { id: row.id, scopes: new Set(row.scopes.split(',').map((s) => s.trim())), rootId: row.root_id };
  if (principalCache.size > 1000) principalCache.clear();
  principalCache.set(hash, { at: t, p, exp: row.expires_at });
  return p;
}

/** 中间件: 要求某个权限; 不传 scope 时只要令牌有效 */
export function requireScope(scope?: 'read' | 'write' | 'admin' | 'stats') {
  return async (c: Context<AppEnv>, next: Next) => {
    let p = c.get('principal');
    if (!p) {
      const found = await resolvePrincipal(c.env, extractToken(c.req.raw));
      if (!found) {
        const basic = c.req.path.startsWith('/dav');
        throw new HttpError(401, 'unauthorized', basic ? { 'WWW-Authenticate': 'Basic realm="HX-CF-Drive"' } : undefined);
      }
      p = await narrowScope(c.env, found, c.req.header(SCOPE_HEADER));
      c.set('principal', p);
    }
    if (scope && !p.scopes.has(scope) && !p.scopes.has('admin')) throw new HttpError(403, `missing scope: ${scope}`);
    await next();
  };
}

/**
 * 按 X-Drive-Scope 收窄根目录: 路径相对令牌根, 不存在时有写权限就建出来。
 * 之后 list, search, 回收站, 分享列表等都按新根隔离, 和令牌本身的根目录一样。
 */
/** (令牌, 根, 权限, scope) -> 收窄后的根。本 isolate 内移动/删除/恢复过节点就作废 (epoch), 别的 isolate 最多滞后 60 秒 */
const scopeCache = new Map<string, { at: number; rootId: string; epoch: number }>();

export async function narrowScope(env: Env, p: Principal, scope: string | undefined): Promise<Principal> {
  if (!scope || scope === '/') return p;
  // 同一令牌同一 scope 的解析结果缓存 60 秒 (AIOA 网盘每个请求都带这个头, 以前每次都走一遍路径)
  const key = `${p.id}\0${p.rootId}\0${[...p.scopes].sort().join(',')}\0${scope}`;
  const hit = scopeCache.get(key);
  if (hit && hit.epoch === epoch() && now() - hit.at < TTL) return { ...p, rootId: hit.rootId };
  const e = epoch();
  if (!scope.startsWith('/')) throw new HttpError(400, 'bad scope');
  try {
    decodeURIComponent(scope);
  } catch {
    throw new HttpError(400, 'bad scope');
  }
  let node = await resolvePath(env, p.rootId, scope);
  if (!node && (p.scopes.has('write') || p.scopes.has('admin'))) node = await mkdirp(env, p.rootId, scope);
  if (!node) throw new HttpError(404, 'scope not found');
  if (node.kind !== 'dir') throw new HttpError(409, 'scope is not a dir');
  if (scopeCache.size > 1000) scopeCache.clear();
  scopeCache.set(key, { at: now(), rootId: node.id, epoch: e });
  return { ...p, rootId: node.id };
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
/** 测试用: 清掉身份与 scope 缓存 */
export function clearAuthCaches(): void {
  principalCache.clear();
  scopeCache.clear();
  aliveCache.clear();
}

/** 吊销令牌: 本 isolate 内的三种缓存立即清掉 */
export function forgetToken(tid: string): void {
  aliveCache.delete(tid);
  for (const [k, v] of principalCache) if (v.p.id === tid) principalCache.delete(k);
  for (const k of scopeCache.keys()) if (k.startsWith(`${tid}\0`)) scopeCache.delete(k);
}
