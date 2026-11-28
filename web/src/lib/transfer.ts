// 上传与大文件下载。
// - 上传进度 (凭证 + 回执 + 聚合回执) 存 localStorage, 24 小时内重选同一文件自动续传, 只补传缺的分片
// - 大文件每凑满一组 256 片就 fold 成一个聚合回执, commit 时不用一次验几千个签名 (#12)
// - 大文件下载 (File System Access) 每段自动重试, 中断后进度存 IndexedDB, 再点下载接着写 (#13)
import { api, ApiError, auth, type Node } from './api';
import { sha256File } from './sha256';
import { demoDownload } from '../demo/media';

export interface Progress { phase: 'hash' | 'upload' | 'done' | 'error'; ratio: number; note?: string }

interface State { ticket: string; chunkSize: number; chunkCount: number; receipts: Record<number, string>; folds?: Record<number, string> }

/** 和服务端 PART_SIZE 一致 */
const PART = 256;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface UploadOpts { name?: string; overwrite?: boolean; /** 多少秒后自动删除 (#22 TTL) */ expiresIn?: number }

/**
 * 小于这个大小的文件走一次性上传 POST /upload: 1 个请求 (分片流程是 init + chunk + commit 3 个), 也不用先算哈希。
 * 代价是这些小文件没有秒传 (不登记 sha256), 重复上传会再占一份 TG 空间 (都 < 1 MB, 可以接受)。
 */
export const SINGLE_MAX = 1024 * 1024;

/** 一次性上传小文件; TG 限流时服务端回 429, 按 Retry-After 重试 (请求体是 Blob, 可以重发) */
async function uploadSmall(file: File, dir: string, name: string, overwrite: boolean, onProgress: (p: Progress) => void, expiresIn?: number): Promise<Node> {
  onProgress({ phase: 'upload', ratio: 0 });
  const q = new URLSearchParams({ path: dir, name, ...(overwrite ? { overwrite: '1' } : {}), ...(expiresIn ? { expiresIn: String(expiresIn) } : {}) });
  for (let tries = 0; ; tries++) {
    const r = await fetch(`/api/v1/upload?${q}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${auth.get()}`, ...(file.type ? { 'Content-Type': file.type } : {}) },
      body: file,
    }).catch(() => null);
    const j = r ? ((await r.json().catch(() => ({}))) as { data?: { node: Node }; error?: string }) : {};
    if (r?.ok && j.data) { onProgress({ phase: 'done', ratio: 1 }); return j.data.node; }
    const status = r?.status ?? 0;
    // 409 同名, 4xx 参数错误: 重试没用, 交给队列显示
    if ((status >= 400 && status < 500 && status !== 429 && status !== 408) || tries >= 8) throw new ApiError(status, j.error ?? `HTTP ${status}`);
    await sleep(Number(r?.headers.get('Retry-After') || 2 ** Math.min(tries, 5)) * 1000);
  }
}

/** 上传一个文件, 返回服务端建好的节点 (调用方直接插进列表, 不用重新列目录) */
export async function uploadFile(file: File, dir: string, onProgress: (p: Progress) => void, opts: UploadOpts = {}, concurrency = 2): Promise<Node | null> {
  const name = opts.name ?? file.name;
  const key = `hxd_up:${dir}:${name}:${file.size}:${file.lastModified}`;
  let state = JSON.parse(localStorage.getItem(key) ?? 'null') as State | null;
  if (!state && file.size > 0 && file.size < SINGLE_MAX) return uploadSmall(file, dir, name, !!opts.overwrite, onProgress, opts.expiresIn);
  if (!state) {
    const sha256 = file.size ? await sha256File(file, (r) => onProgress({ phase: 'hash', ratio: r })) : undefined;
    const init = await api<{ done: boolean; ticket: string; chunkSize: number; chunkCount: number; node?: Node }>('POST', '/uploads', {
      path: dir, name, size: file.size, mime: file.type || undefined, sha256, overwrite: !!opts.overwrite, expiresIn: opts.expiresIn,
    });
    if (init.done) { onProgress({ phase: 'done', ratio: 1, note: file.size ? '秒传' : undefined }); return init.node ?? null; }
    state = { ticket: init.ticket, chunkSize: init.chunkSize, chunkCount: init.chunkCount, receipts: {} };
    localStorage.setItem(key, JSON.stringify(state));
  }
  const st = state;
  st.folds ??= {};
  const folds = st.folds;
  const groups = Math.ceil(st.chunkCount / PART);
  const groupSize = (g: number) => Math.min(PART, st.chunkCount - g * PART);
  const has = (i: number) => !!st.receipts[i] || !!folds[Math.floor(i / PART)];
  // 一组回执齐了就折叠 (只在多于一组时), 折叠后丢掉零散回执, localStorage 也更小
  const tryFold = async (g: number) => {
    if (groups <= 1 || folds[g]) return;
    const rs: string[] = [];
    for (let i = g * PART; i < g * PART + groupSize(g); i++) {
      if (!st.receipts[i]) return;
      rs.push(st.receipts[i]);
    }
    const r = await api<{ fold: string }>('POST', '/uploads/fold', { ticket: st.ticket, receipts: rs });
    folds[g] = r.fold;
    for (let i = g * PART; i < g * PART + groupSize(g); i++) delete st.receipts[i];
    localStorage.setItem(key, JSON.stringify(st));
  };
  const todo: number[] = [];
  for (let i = 0; i < st.chunkCount; i++) if (!has(i)) todo.push(i);
  let done = st.chunkCount - todo.length;
  onProgress({ phase: 'upload', ratio: done / st.chunkCount });
  // 并发不宜大: TG 单频道约 20 条/分, 超了服务端回 429, 这里按 Retry-After 等
  const worker = async () => {
    for (let i = todo.shift(); i !== undefined; i = todo.shift()) {
      const body = file.slice(i * st.chunkSize, (i + 1) * st.chunkSize);
      for (let tries = 0; ; tries++) {
        const r = await fetch(`/api/v1/uploads/chunk?i=${i}&ticket=${encodeURIComponent(st.ticket)}`, {
          method: 'PUT', headers: { Authorization: `Bearer ${auth.get()}` }, body,
        }).catch(() => null);
        if (r?.ok) { st.receipts[i] = ((await r.json()) as { receipt: string }).receipt; break; }
        const status = r?.status ?? 0;
        if (status === 400 || status === 403 || tries >= 8) throw new Error(`分片 ${i} 失败: ${status} ${r ? await r.text() : ''}`);
        await sleep(Number(r?.headers.get('Retry-After') || 2 ** Math.min(tries, 5)) * 1000);
      }
      localStorage.setItem(key, JSON.stringify(st));
      onProgress({ phase: 'upload', ratio: ++done / st.chunkCount });
      await tryFold(Math.floor(i / PART));
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, st.chunkCount) }, worker));
  // 续传时可能有组已经传完但还没折叠 (上次在 fold 前中断)
  for (let g = 0; g < groups; g++) await tryFold(g);
  const res = await api<{ node: Node }>('POST', '/uploads/commit', { ticket: st.ticket, receipts: Object.values(st.receipts), folds: Object.values(folds) });
  localStorage.removeItem(key);
  onProgress({ phase: 'done', ratio: 1 });
  return res.node;
}

interface Writable {
  write(data: BufferSource | Blob): Promise<void>;
  seek(pos: number): Promise<void>;
  close(): Promise<void>;
}
interface FileHandle {
  name: string;
  createWritable(o?: { keepExistingData?: boolean }): Promise<Writable>;
  getFile(): Promise<File>;
  queryPermission?(o: { mode: 'readwrite' }): Promise<PermissionState>;
  requestPermission?(o: { mode: 'readwrite' }): Promise<PermissionState>;
}
type SavePicker = (o: { suggestedName: string }) => Promise<FileHandle>;

/** 未完成下载的进度: 文件句柄 + 已提交到磁盘的字节数 + ETag。存 IndexedDB (句柄可以结构化克隆, localStorage 存不了) */
interface Resume { handle: FileHandle; done: number; etag: string; size: number; at: number }

function idb(): Promise<IDBDatabase> {
  return new Promise((ok, fail) => {
    const r = indexedDB.open('hxd-download', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('resume');
    r.onsuccess = () => ok(r.result);
    r.onerror = () => fail(r.error);
  });
}
async function kv<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await idb();
  return new Promise((ok, fail) => {
    const req = fn(db.transaction('resume', mode).objectStore('resume'));
    req.onsuccess = () => ok(req.result as T);
    req.onerror = () => fail(req.error);
  });
}
const getResume = (k: string) => kv<Resume | undefined>('readonly', (s) => s.get(k)).catch(() => undefined);
const putResume = (k: string, v: Resume) => kv('readwrite', (s) => s.put(v, k)).catch(() => {});
const delResume = (k: string) => kv('readwrite', (s) => s.delete(k)).catch(() => {});

/** 同一个文件的下载记录用直链路径做键 (去掉会过期的签名参数) */
function resumeKey(url: string): string {
  const u = new URL(url, location.href);
  return u.pathname;
}

const MAX_TRIES = 8;
/** 第一次在 2 GiB 时提交, 之后每次翻倍: 额外的磁盘拷贝总量不超过文件大小的约 2 倍 */
const FIRST_FLUSH = 2 * 1024 ** 3;

/**
 * 下载。服务端单次响应只拼得下有限个分片 (Free 计划冷读约 456 MB), 超出部分 206 截断。
 * 支持 File System Access API 时按 Content-Range 一段段续拉写入本地; 否则交给浏览器普通下载。
 * - 每段失败自动重试, 指数退避 (1, 2, 4 ... 30 秒, 最多 8 次), 从已写入的位置继续
 * - 写入按几何间隔提交到磁盘; 最终失败或中断时 close() 保留已写部分, 进度存 IndexedDB
 * - 再次下载同一文件: ETag 没变就 keepExistingData + seek 接着写, 变了就从头开始
 */
export async function download(url: string, name: string, size: number, onProgress: (r: number) => void): Promise<void> {
  if (__DEMO__) return demoDownload(url, name);
  const picker = (window as unknown as { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
  const big = size > 400 * 1024 * 1024;
  if (!picker || !big) {
    const a = document.createElement('a');
    a.href = url + (url.includes('?') ? '&' : '?') + 'download=1';
    a.download = name;
    a.click();
    return;
  }
  const key = resumeKey(url);
  let resume = await getResume(key);
  let handle: FileHandle | null = null;
  let pos = 0;
  if (resume && resume.size === size && resume.done > 0 && resume.done < size) {
    const perm = (await resume.handle.queryPermission?.({ mode: 'readwrite' })) ?? 'granted';
    const ok = perm === 'granted' || (await resume.handle.requestPermission?.({ mode: 'readwrite' })) === 'granted';
    const onDisk = ok ? await resume.handle.getFile().then((f) => f.size).catch(() => -1) : -1;
    if (ok && onDisk >= resume.done) {
      handle = resume.handle;
      pos = resume.done;
    }
  }
  if (!handle) {
    resume = undefined;
    handle = await picker({ suggestedName: name });
  }
  const h = handle;
  let etag = resume?.etag ?? '';
  let out = await h.createWritable({ keepExistingData: pos > 0 });
  if (pos > 0) await out.seek(pos);
  let committed = pos;
  let nextFlush = Math.max(FIRST_FLUSH, committed * 2);
  const save = () => putResume(key, { handle: h, done: committed, etag, size, at: Date.now() });

  /** 提交已写部分到磁盘 (close 会把临时文件换成正式文件), 再接着打开继续写 */
  const flush = async () => {
    await out.close();
    committed = pos;
    await save();
    out = await h.createWritable({ keepExistingData: true });
    await out.seek(pos);
  };

  try {
    let tries = 0;
    while (pos < size) {
      try {
        const r = await fetch(url, { headers: { Range: `bytes=${pos}-`, ...(etag ? { 'If-Range': etag } : {}) } });
        const tag = r.headers.get('ETag') ?? '';
        if (r.status === 200 && pos > 0) {
          // If-Range 不匹配: 文件内容变了, 从头开始
          await out.close();
          await delResume(key);
          pos = 0; committed = 0; nextFlush = FIRST_FLUSH;
          out = await h.createWritable({ keepExistingData: false });
          etag = tag;
          await r.body?.cancel();
          continue;
        }
        if ((r.status !== 206 && r.status !== 200) || !r.body) throw new HttpStatus(r.status);
        if (!etag) { etag = tag; await save(); }
        const reader = r.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          await out.write(value);
          pos += value.length;
          onProgress(pos / size);
        }
        tries = 0;
        if (pos >= nextFlush && pos < size) {
          await flush();
          nextFlush = pos * 2;
        }
      } catch (e) {
        // 4xx (除 408/429) 重试也没用, 比如签名过期
        if (e instanceof HttpStatus && e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429) throw e;
        if (++tries > MAX_TRIES) throw e;
        await sleep(Math.min(30, 2 ** (tries - 1)) * 1000);
        // 已写入但没提交的部分照样有效: 可写流内容在 close 前都保留, pos 就是续拉位置
      }
    }
    await out.close();
    await delResume(key);
  } catch (e) {
    // 不 abort: close 保留已写部分, 下次点下载接着写
    // close 成功才算写到磁盘; 失败就只信上一次提交的位置
    if (await out.close().then(() => true, () => false)) committed = pos;
    await save();
    throw new Error(`${(e as Error).message}; 已下载 ${Math.floor((committed / size) * 100)}%, 再次下载同一文件会接着写`);
  }
}

class HttpStatus extends Error {
  constructor(public status: number) { super(`下载失败 ${status}`); }
}
