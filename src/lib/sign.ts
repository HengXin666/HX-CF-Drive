import { b64url, safeEqual } from './util';

async function hmac(key: string, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(msg));
  return b64url(sig).slice(0, 32);
}

/** 生成签名直链参数。exp 为 Unix 秒, 0 表示永久 */
export async function signLink(key: string, nodeId: string, exp: number): Promise<string> {
  const s = await hmac(key, `${nodeId}.${exp}`);
  return `e=${exp}&s=${s}`;
}

export async function verifyLink(key: string, nodeId: string, exp: number, sig: string, nowSec = Math.floor(Date.now() / 1000)): Promise<boolean> {
  if (exp !== 0 && exp < nowSec) return false;
  const expect = await hmac(key, `${nodeId}.${exp}`);
  return safeEqual(expect, sig);
}
