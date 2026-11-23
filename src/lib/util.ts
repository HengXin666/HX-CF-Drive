const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** 随机 base62 id */
export function newId(len = 16): string {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let s = '';
  for (const b of bytes) s += B62[b % 62];
  return s;
}

export const now = () => Date.now();

export function b64url(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function sha256Hex(text: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 常量时间比较 */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

/** 文件名校验: 不允许空, . .., 斜杠, 控制字符 */
export function validName(name: string): boolean {
  if (!name || name === '.' || name === '..' || name.length > 255) return false;
  return !/[\/\\\x00-\x1f]/.test(name);
}

/** 拆分路径为段, 忽略空段 */
export function splitPath(path: string): string[] {
  return path
    .split('/')
    .filter((s) => s.length > 0)
    .map((s) => decodeURIComponent(s));
}

export function guessMime(name: string): string {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  const map: Record<string, string> = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
    avif: 'image/avif', svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon',
    mp4: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska', mov: 'video/quicktime', m4v: 'video/x-m4v',
    mp3: 'audio/mpeg', flac: 'audio/flac', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4',
    pdf: 'application/pdf', zip: 'application/zip', json: 'application/json', txt: 'text/plain; charset=utf-8',
    md: 'text/markdown; charset=utf-8', html: 'text/html; charset=utf-8', css: 'text/css', js: 'text/javascript',
  };
  return map[ext] ?? 'application/octet-stream';
}

export class HttpError extends Error {
  constructor(public status: number, message: string, public headers?: Record<string, string>) {
    super(message);
  }
}
