/** HMAC 签名: 直链, 上传凭证, 分片回执。全部用 crypto.subtle (原生代码, 几乎不占 JS CPU) */
import { b64url, safeEqual } from './util';

const keyCache = new Map<string, Promise<CryptoKey>>();

function hmacKey(key: string): Promise<CryptoKey> {
  let k = keyCache.get(key);
  if (!k) {
    k = crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    keyCache.set(key, k);
  }
  return k;
}

async function hmac(key: string, msg: string): Promise<string> {
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(key), new TextEncoder().encode(msg));
  return b64url(sig).slice(0, 32);
}

/** 签名内容: 管理员签的直链不带令牌 (与旧链接兼容); 普通令牌签的带上令牌 id, 吊销令牌即作废它签过的所有直链 */
const linkMsg = (nodeId: string, exp: number, tid: string) => (tid === 'admin' ? `${nodeId}.${exp}` : `${nodeId}.${exp}.${tid}`);

/** 生成签名直链参数。exp 为 Unix 秒, 0 表示永久; tid 是签发令牌的 id */
export async function signLink(key: string, nodeId: string, exp: number, tid = 'admin'): Promise<string> {
  const s = await hmac(key, linkMsg(nodeId, exp, tid));
  return tid === 'admin' ? `e=${exp}&s=${s}` : `e=${exp}&t=${encodeURIComponent(tid)}&s=${s}`;
}

export async function verifyLink(key: string, nodeId: string, exp: number, sig: string, nowSec = Math.floor(Date.now() / 1000), tid = 'admin'): Promise<boolean> {
  if (exp !== 0 && exp < nowSec) return false;
  const expect = await hmac(key, linkMsg(nodeId, exp, tid));
  return safeEqual(expect, sig);
}

function b64urlText(s: string): string {
  return b64url(new TextEncoder().encode(s));
}

function fromB64url(s: string): string {
  const pad = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** 把对象签成 "载荷.签名" 字符串。purpose 防止不同用途的签名互相冒用 */
export async function sealJson(key: string, purpose: string, obj: unknown): Promise<string> {
  const body = b64urlText(JSON.stringify(obj));
  return `${body}.${await hmac(key, `${purpose}:${body}`)}`;
}

/** 验签并解出对象; 失败返回 null */
export async function openJson<T>(key: string, purpose: string, sealed: string): Promise<T | null> {
  const dot = sealed.lastIndexOf('.');
  if (dot <= 0) return null;
  const body = sealed.slice(0, dot);
  if (!safeEqual(await hmac(key, `${purpose}:${body}`), sealed.slice(dot + 1))) return null;
  try {
    return JSON.parse(fromB64url(body)) as T;
  } catch {
    return null;
  }
}
