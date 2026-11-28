// 图片原图缓存 (#20): 列表里加载过的原图, 预览和下载直接复用, 不再请求。
// 两层: 内存里的 object URL (按字节 LRU), 浏览器 Cache Storage (刷新页面后仍在, 也按字节 LRU)。
// 取图走 GET /api/v1/files/:id/content (带 Bearer), 不签直链, 每张图只花 1 个 Workers 请求, 命中缓存 0 个。
import { useEffect, useState } from 'react';
import { auth, type Node } from './api';

const PREF = 'hxd_imgprev';
const INDEX = 'hxd_imgcache';
const STORE = 'hxd-img-v1';
const MEM_CAP = 200 * 1024 * 1024;
const DISK_CAP = 500 * 1024 * 1024;
const PARALLEL = 6;

export interface ImgPrefs { on: boolean; maxMB: number }
export const prefs = {
  get(): ImgPrefs {
    try { return { on: false, maxMB: 5, ...JSON.parse(localStorage.getItem(PREF) ?? '{}') }; } catch { return { on: false, maxMB: 5 }; }
  },
  set(p: ImgPrefs) {
    localStorage.setItem(PREF, JSON.stringify(p));
    listeners.forEach((f) => f(p));
  },
};
const listeners = new Set<(p: ImgPrefs) => void>();
export function usePrefs(): [ImgPrefs, (p: ImgPrefs) => void] {
  const [p, setP] = useState(prefs.get);
  useEffect(() => { listeners.add(setP); return () => { listeners.delete(setP); }; }, []);
  return [p, prefs.set];
}

/** 内容变了 (覆盖上传) 大小或时间会变, key 跟着变 */
const keyOf = (n: Node) => `${n.id}:${n.size}:${n.updatedAt}`;
export const isImage = (n: Node) => n.kind === 'file' && !!n.mime?.startsWith('image/');
/** 列表里该不该自动加载 */
export const wantsPreview = (n: Node, p: ImgPrefs) => p.on && isImage(n) && n.size > 0 && n.size <= p.maxMB * 1024 * 1024;

// ---------- 内存层 ----------
const mem = new Map<string, { url: string; size: number }>(); // Map 保持插入顺序, 头部最旧
let memBytes = 0;
function memPut(k: string, b: Blob): string {
  const url = URL.createObjectURL(b);
  mem.set(k, { url, size: b.size });
  memBytes += b.size;
  while (memBytes > MEM_CAP && mem.size > 1) {
    const [old, v] = mem.entries().next().value as [string, { url: string; size: number }];
    mem.delete(old);
    memBytes -= v.size;
    // 正在显示的 <img> 已解码, revoke 不影响它; 再次需要时从磁盘层取回
    URL.revokeObjectURL(v.url);
  }
  return url;
}
function memGet(k: string): string | null {
  const v = mem.get(k);
  if (!v) return null;
  mem.delete(k);
  mem.set(k, v); // 移到最新
  return v.url;
}

// ---------- 磁盘层 (Cache Storage, 只在安全上下文可用) ----------
type Idx = [string, number][]; // [key, size], 头部最旧
const hasDisk = () => typeof caches !== 'undefined' && isSecureContext;
const readIdx = (): Idx => { try { return JSON.parse(localStorage.getItem(INDEX) ?? '[]'); } catch { return []; } };
const writeIdx = (i: Idx) => localStorage.setItem(INDEX, JSON.stringify(i));
const diskUrl = (k: string) => `/__img/${encodeURIComponent(k)}`;

async function diskGet(k: string): Promise<Blob | null> {
  if (!hasDisk()) return null;
  const r = await (await caches.open(STORE)).match(diskUrl(k)).catch(() => undefined);
  if (!r) return null;
  const idx = readIdx().filter(([x]) => x !== k);
  writeIdx([...idx, [k, Number(r.headers.get('Content-Length')) || 0]]);
  return r.blob();
}
async function diskPut(k: string, b: Blob) {
  if (!hasDisk() || b.size > DISK_CAP) return;
  const c = await caches.open(STORE);
  await c.put(diskUrl(k), new Response(b, { headers: { 'Content-Type': b.type, 'Content-Length': String(b.size) } }));
  let idx = readIdx().filter(([x]) => x !== k);
  idx.push([k, b.size]);
  let total = idx.reduce((s, [, n]) => s + n, 0);
  while (total > DISK_CAP && idx.length > 1) {
    const [old, n] = idx.shift()!;
    total -= n;
    await c.delete(diskUrl(old));
  }
  writeIdx(idx);
}

// ---------- 取图: 去重 + 并发上限 ----------
const inflight = new Map<string, Promise<string>>();
let running = 0;
const queue: (() => void)[] = [];
const slot = () => new Promise<void>((res) => { if (running < PARALLEL) { running++; res(); } else queue.push(() => { running++; res(); }); });
const release = () => { running--; queue.shift()?.(); };

/** 已在内存里就同步返回, 不发请求 */
export const peek = (n: Node) => memGet(keyOf(n));

/** 取原图的 object URL: 内存 -> 磁盘 -> 网络 (1 个 Workers 请求) */
export function load(n: Node): Promise<string> {
  const k = keyOf(n);
  const hit = memGet(k);
  if (hit) return Promise.resolve(hit);
  const p = inflight.get(k) ?? (async () => {
    try {
      const d = await diskGet(k);
      if (d) return memPut(k, d);
      await slot();
      try {
        // 带上内容版本: 服务端回 immutable, 浏览器 HTTP 缓存也能命中 (Cache Storage 不可用的非安全上下文也受益)
        const v = n.version ? `?v=${encodeURIComponent(n.version)}` : '';
        const r = await fetch(`/api/v1/files/${encodeURIComponent(n.id)}/content${v}`, { headers: { Authorization: `Bearer ${auth.get()}` } });
        if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${r.status}`);
        const b = await r.blob();
        void diskPut(k, b).catch(() => {});
        return memPut(k, b);
      } finally { release(); }
    } finally { inflight.delete(k); }
  })();
  inflight.set(k, p);
  return p;
}

/** 退出登录时清掉, 别把图留在这台设备上 */
export async function clearImages() {
  for (const v of mem.values()) URL.revokeObjectURL(v.url);
  mem.clear();
  memBytes = 0;
  localStorage.removeItem(INDEX);
  if (hasDisk()) await caches.delete(STORE).catch(() => {});
}
