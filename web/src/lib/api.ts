// 后端接口封装。令牌存在 localStorage, 所有请求带 Bearer
export interface PurgeResult { nodes: number; blobs: number; more: number; leftNodes: number; leftBlobs: number }

export interface Node {
  id: string;
  name: string;
  kind: 'dir' | 'file';
  size: number;
  mime: string | null;
  parentId: string | null;
  createdAt: number;
  updatedAt: number;
  path?: string;
  deletedAt?: number;
}

const KEY = 'hxd_token';
export const auth = {
  get: () => localStorage.getItem(KEY) ?? '',
  set: (t: string) => localStorage.setItem(KEY, t),
  clear: () => localStorage.removeItem(KEY),
};

export class ApiError extends Error {
  constructor(public status: number, message: string, public retryAfter?: number) {
    super(message);
  }
}

export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch('/api/v1' + path, {
    method,
    headers: { Authorization: `Bearer ${auth.get()}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = (await r.json().catch(() => ({}))) as { error?: string };
  if (!r.ok) throw new ApiError(r.status, j.error ?? `HTTP ${r.status}`, Number(r.headers.get('Retry-After')) || undefined);
  return j as T;
}

export const fs = {
  list: (path: string) => api<{ node: Node; path: string; children: Node[] }>('GET', `/fs/list?path=${encodeURIComponent(path)}`),
  mkdir: (path: string) => api<{ node: Node }>('POST', '/fs/mkdir', { path }),
  move: (id: string, toPath: string | undefined, name: string) => api('POST', '/fs/move', { id, toPath, name }),
  remove: (id: string) => api('POST', '/fs/delete', { id }),
  trash: () => api<{ items: Node[] }>('GET', '/fs/trash'),
  restore: (id: string) => api('POST', '/fs/restore', { id }),
  /** 彻底删除一个回收站项目。more=1 表示还有积压, 由定时维护接着清 */
  purge: (id: string) => api<PurgeResult>('POST', '/fs/purge', { id }),
  emptyTrash: () => api<PurgeResult>('POST', '/fs/trash/empty'),
  search: (q: string) => api<{ items: Node[] }>('GET', `/fs/search?q=${encodeURIComponent(q)}`),
  link: (id: string, expiresIn = 0) => api<{ url: string }>('POST', '/fs/link', { id, expiresIn }),
};

export interface ShareRow { id: string; node_id: string; name: string; expires_at: number | null; created_at: number; has_password: number }
export const shares = {
  list: () => api<{ items: ShareRow[] }>('GET', '/shares'),
  create: (id: string, password?: string, expiresIn?: number) => api<{ id: string; url: string }>('POST', '/shares', { id, password, expiresIn }),
  remove: (id: string) => api('DELETE', `/shares/${id}`),
};

export interface Stats {
  nodes: { kind: string; n: number }[];
  blobs: { n: number; bytes: number };
  bots: { id: string; username: string | null; status: string; last_error: string | null }[];
  channels: { id: string; title: string; status: string }[];
}
export interface TokenRow { id: string; name: string; scopes: string; root_id: string; root_path: string; expires_at: number | null; created_at: number }
export const admin = {
  stats: () => api<Stats>('GET', '/admin/stats'),
  addBot: (token: string) => api<{ username: string; channels: Record<string, string> }>('POST', '/admin/bots', { token }),
  removeBot: (id: string) => api('DELETE', `/admin/bots/${id}`),
  addChannel: (id: string) => api<{ title: string; bots: Record<string, string> }>('POST', '/admin/channels', { id }),
  setChannel: (id: string, status: string) => api('PATCH', `/admin/channels/${id}`, { status }),
  tokens: () => api<{ items: TokenRow[] }>('GET', '/admin/tokens'),
  addToken: (name: string, scopes: string[], rootPath: string) => api<{ token: string }>('POST', '/admin/tokens', { name, scopes, rootPath }),
  removeToken: (id: string) => api('DELETE', `/admin/tokens/${id}`),
  maintenance: () => api<Record<string, number>>('POST', '/admin/maintenance'),
};

export function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${u[i]}`;
}

export const fmtTime = (t: number) => new Date(t).toLocaleString('zh-CN', { hour12: false });

export function joinPath(dir: string, name: string): string {
  return (dir.endsWith('/') ? dir : dir + '/') + name;
}
