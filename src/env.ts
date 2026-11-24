export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;

  ADMIN_TOKEN: string;
  SIGNING_KEY: string;
  BOT_TOKENS?: string;

  CHUNK_SIZE: string;
  SUBREQ_BUDGET: string;
  SEARCH_PER_MIN: string;
  TRASH_DAYS: string;
  EDGE_CACHE?: string;
  TG_API_BASE?: string;
  /** 本地实测: 响应头 X-D1-Rows */
  D1_METER?: string;
}

/** 当前请求的身份 */
export interface Principal {
  id: string;           // 'admin' 或 token id
  scopes: Set<string>;  // read / write / admin
  rootId: string;       // 可访问的根目录
}

export type AppEnv = { Bindings: Env; Variables: { principal: Principal } };

export function num(v: string | undefined, d: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
}

/** TG getFile 上限 20MB, 分片取 19MiB 留余量 */
export const MAX_TG_CHUNK = 19 * 1024 * 1024;

export function chunkSizeOf(env: Env): number {
  return Math.min(num(env.CHUNK_SIZE, MAX_TG_CHUNK), MAX_TG_CHUNK);
}
