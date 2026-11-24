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
  /** 对外地址 (如 https://drive.example.com)。生成直链/分享链接时优先用它, 经 Service Binding 调用时返回的链接也能在公网打开 */
  PUBLIC_URL?: string;
  /** 1 (默认) = 维护时清扫频道里没被任何文件引用的消息 (放弃的上传)。多个部署共用一个频道时必须设为 0 */
  ORPHAN_SWEEP?: string;
  /** 本地实测: 响应头 X-D1-Rows */
  D1_METER?: string;
}

/** 当前请求的身份 */
export interface Principal {
  id: string;           // 'admin' 或 token id
  scopes: Set<string>;  // read / write / admin
  rootId: string;       // 可访问的根目录
}

/** 对外链接的 origin: 设置了 PUBLIC_URL 就用它, 否则用请求自身的 origin */
export function publicOrigin(env: Env, reqUrl: string): string {
  const u = env.PUBLIC_URL?.trim();
  return u ? u.replace(/\/+$/, '') : new URL(reqUrl).origin;
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
