// 演示数据存储: 元数据整体存一条 JSON, 文件内容按 key 存 Blob。IndexedDB 不可用时退回内存
export interface DNode {
  id: string;
  parentId: string | null;
  name: string;
  kind: 'dir' | 'file';
  size: number;
  mime: string | null;
  blobId: string | null;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  /** 到期时间 (#22 TTL) */
  expiresAt?: number | null;
}
// 数据块以内容 sha256 为 id, 相同内容只存一份 (秒传就靠它)。virtual 表示只有元数据的占位
export interface DBlob { id: string; size: number; refs: number; virtual?: boolean }
export interface DShare { id: string; nodeId: string; password: string | null; expiresAt: number | null; createdAt: number; disabled?: boolean; remark?: string | null }
export interface DBot { id: string; username: string | null; status: string; last_error: string | null }
export interface DChannel { id: string; title: string; status: string }
export interface DToken { id: string; name: string; scopes: string; root_id: string; expires_at: number | null; created_at: number; token: string }
export interface DTicket { ticket: string; parentId: string; name: string; size: number; mime: string | null; overwrite: boolean; chunkSize: number; chunkCount: number; expiresAt?: number | null }

export interface Meta {
  v: 1;
  nodes: Record<string, DNode>;
  blobs: Record<string, DBlob>;
  shares: DShare[];
  bots: DBot[];
  channels: DChannel[];
  tokens: DToken[];
  tickets: Record<string, DTicket>;
}

const DB_NAME = 'hx-cf-drive-demo';
let idb: IDBDatabase | null = null;
const mem = new Map<string, unknown>();
let meta: Meta | null = null;

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((ok, fail) => { r.onsuccess = () => ok(r.result); r.onerror = () => fail(r.error); });
}

async function open(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return null;
  try {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore('kv');
      r.result.createObjectStore('data');
    };
    return await req(r);
  } catch {
    return null;
  }
}

async function tx<T>(store: 'kv' | 'data', mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((ok, fail) => {
    const t = idb!.transaction(store, mode);
    const r = fn(t.objectStore(store));
    t.oncomplete = () => ok(r.result);
    t.onerror = () => fail(t.error);
    t.onabort = () => fail(t.error);
  });
}

/** 打开存储并读出元数据; 没有数据时返回 null, 由调用方播种 */
export async function load(): Promise<Meta | null> {
  idb ??= await open();
  if (!idb) return (meta = (mem.get('meta') as Meta | undefined) ?? null);
  meta = ((await tx('kv', 'readonly', (s) => s.get('meta'))) as Meta | undefined) ?? null;
  return meta;
}

export function state(): Meta {
  if (!meta) throw new Error('demo store not ready');
  return meta;
}

export async function save(m: Meta = state()): Promise<void> {
  meta = m;
  if (!idb) { mem.set('meta', structuredClone(m)); return; }
  await tx('kv', 'readwrite', (s) => s.put(m, 'meta'));
}

export async function getData(key: string): Promise<Blob | undefined> {
  if (!idb) return mem.get('d:' + key) as Blob | undefined;
  return (await tx('data', 'readonly', (s) => s.get(key))) as Blob | undefined;
}

export async function putData(key: string, b: Blob): Promise<void> {
  if (!idb) { mem.set('d:' + key, b); return; }
  await tx('data', 'readwrite', (s) => s.put(b, key));
}

export async function delData(key: string): Promise<void> {
  if (!idb) { mem.delete('d:' + key); return; }
  await tx('data', 'readwrite', (s) => s.delete(key));
}

/** 清空全部演示数据 (元数据 + 文件内容) */
export async function wipe(): Promise<void> {
  meta = null;
  mem.clear();
  if (!idb) return;
  await tx('kv', 'readwrite', (s) => s.clear());
  await tx('data', 'readwrite', (s) => s.clear());
}

export const now = () => Date.now();

export function newId(n = 16): string {
  const a = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const r = crypto.getRandomValues(new Uint8Array(n));
  return Array.from(r, (x) => a[x % a.length]).join('');
}

export async function sha256Hex(b: Blob | ArrayBuffer): Promise<string> {
  const buf = b instanceof Blob ? await b.arrayBuffer() : b;
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
  return Array.from(h, (x) => x.toString(16).padStart(2, '0')).join('');
}
