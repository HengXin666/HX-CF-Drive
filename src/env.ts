import type { ChannelLimiter } from './do/limiter';

export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  LIMITER: DurableObjectNamespace<ChannelLimiter>;
  ASSETS: Fetcher;

  ADMIN_TOKEN: string;
  SIGNING_KEY: string;
  BOT_TOKENS?: string;

  CHUNK_SIZE: string;
  MAX_CHUNKS_PER_RESPONSE: string;
  CHANNEL_RATE_PER_MIN: string;
  ROUTE_VIDEO_TO: string;
  ROUTE_R2_MIN_BYTES: string;
  TRASH_DAYS: string;
  R2_PUBLIC_BASE?: string;
  TG_API_BASE?: string;
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
