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
  /** 内容版本 (= ETag)。读内容时带 ?v= 可被浏览器长期缓存 */
  version?: string | null;
  /** 到期时间 (毫秒, #22 TTL); 过了访问返回 410 */
  expiresAt?: number | null;
}

const KEY = 'hxd_token';
export const auth = {
  get: () => localStorage.getItem(KEY) ?? '',
  set: (t: string) => localStorage.setItem(KEY, t),
  clear: () => { localStorage.removeItem(KEY); linkCache.clear(); },
};

/** 预览 / 下载用的 1 小时签名链接, 按 (节点, 内容版本) 缓存到过期前 5 分钟: 重复打开同一文件不再签 (#23) */
const linkCache = new Map<string, { url: string; until: number }>();
export async function tempLink(n: Node): Promise<string> {
  const k = `${n.id}:${n.version ?? n.updatedAt}`;
  const hit = linkCache.get(k);
  if (hit && hit.until > Date.now()) return hit.url;
  const { url } = await fs.link(n.id, 3600);
  if (linkCache.size > 500) linkCache.clear();
  linkCache.set(k, { url, until: Date.now() + 55 * 60_000 });
  return url;
}

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
  /** 搜索: q 和 type 至少一个; dir 只搜这个目录的子树 (#22) */
  search: (q: string, o: { type?: string; dir?: string } = {}) => api<{ items: Node[] }>('GET', `/fs/search?${new URLSearchParams({ ...(q ? { q } : {}), ...(o.type ? { type: o.type } : {}), ...(o.dir ? { dir: o.dir } : {}) })}`),
  link: (id: string, expiresIn = 0) => api<{ url: string }>('POST', '/fs/link', { id, expiresIn }),
  /** 批量操作 (#22): 一个请求, 服务端一个 D1 batch; 校验不过的项在 failed 里 */
  batch: (b: { op: 'move' | 'copy' | 'delete' | 'restore' | 'rename'; ids?: string[]; items?: { id: string; name: string }[]; toPath?: string; overwrite?: boolean }) =>
    api<{ ok: number; failed: { id: string; error: string }[]; nodes?: Node[] }>('POST', '/fs/batch', b),
  /** 设置 / 取消到期时间 (#22): expiresIn 秒, null 取消 */
  expire: (id: string, expiresIn: number | null) => api<{ node: Node }>('POST', '/fs/expire', { id, expiresIn }),
  /**
   * URL 远程上传 (#22): 服务端拉远程内容写进 TG。一次最多 3 片, 更大的用 /uploads/fetch 续拉 (远程要支持 Range), 最后 commit。
   * 限 256 片 (≈ 4.7 GB) 以内; 每段失败重试 3 次 (429 按 Retry-After 等)
   */
  fetchUrl: async (url: string, path: string, o: { name?: string; expiresIn?: number } = {}, onProgress?: (done: number, total: number) => void) => {
    type Start = { done: true; node: Node; url: string } | { done: false; ticket: string; chunkCount: number; receipts: string[]; next: number };
    const r = await api<Start>('POST', '/fs/fetch', { url, path, name: o.name || undefined, expiresIn: o.expiresIn || undefined });
    if (r.done) return { node: r.node, url: r.url };
    if (r.chunkCount > 256) throw new Error('文件超过 256 片 (约 4.7 GB), 请用 API 分批 fold 后提交');
    const receipts = [...r.receipts];
    let next: number | null = r.next;
    while (next !== null) {
      onProgress?.(receipts.length, r.chunkCount);
      for (let tries = 0; ; tries++) {
        try {
          const m: { receipts: string[]; next: number | null } = await api('POST', '/uploads/fetch', { ticket: r.ticket, url, from: next });
          receipts.push(...m.receipts);
          next = m.next;
          break;
        } catch (e) {
          if (tries >= 3) throw e;
          await new Promise((ok) => setTimeout(ok, ((e as ApiError).retryAfter ?? 3) * 1000));
        }
      }
    }
    onProgress?.(receipts.length, r.chunkCount);
    return api<{ node: Node; url: string }>('POST', '/uploads/commit', { ticket: r.ticket, receipts });
  },
  /** 批量签直链 (每次最多 200 个), 不是文件或无权访问的 id 进 missing */
  links: (ids: string[], expiresIn = 0) => api<{ items: { id: string; name: string; mime: string | null; url: string }[]; missing: string[] }>('POST', '/fs/links', { ids, expiresIn }),
};

export interface ShareRow { id: string; node_id: string; name: string; expires_at: number | null; created_at: number; has_password: number; disabled?: number; remark?: string | null }
/** 编辑分享: 只传要改的字段。password: null 去掉密码; expiresIn: 秒, null 为永久 */
export interface SharePatch { password?: string | null; expiresIn?: number | null; disabled?: boolean; remark?: string | null }
export const shares = {
  list: () => api<{ items: ShareRow[] }>('GET', '/shares'),
  create: (id: string, password?: string, expiresIn?: number) => api<{ id: string; url: string }>('POST', '/shares', { id, password, expiresIn }),
  remove: (id: string) => api('DELETE', `/shares/${id}`),
  update: (id: string, patch: SharePatch) => api<{ share: ShareRow }>('PATCH', `/shares/${id}`, patch),
};

export interface Stats {
  nodes: { kind: string; n: number }[];
  blobs: { n: number; bytes: number };
  /** 节点数与字节数的统计时间: 维护任务每 6 小时重算一次快照 */
  snapshotAt?: number;
  bots: { id: string; username: string | null; status: string; last_error: string | null }[];
  channels: { id: string; title: string; status: string }[];
}
export interface Topology {
  /** 分片统计的时间; 没统计时为 null */
  at: number | null;
  bots: { id: string; username: string | null; status: string }[];
  channels: { id: string; title: string | null; status: string }[];
  /** 每对 (频道 c, Bot b) 上存了多少分片; 只在 usage=1 / fresh=1 时统计, 否则可能为 null */
  usage: { c: string; b: string; n: number; bytes: number }[] | null;
  /** key 为 `${botId}|${channelId}`, 值为 ok / NOT ADMIN ... / unchecked */
  perms: Record<string, string>;
}
export interface TokenRow { id: string; name: string; scopes: string; root_id: string; root_path: string; expires_at: number | null; created_at: number }
export interface Me { scopes: string[]; rootId: string }
/** 当前令牌的权限: 不是管理员就不请求管理接口 */
export const me = () => api<Me>('GET', '/me');

// 侧栏和后台页都要用量: 30 秒内共用同一个请求 (含进行中的), 后台操作后传 fresh 强制重拉
let statsReq: { at: number; p: Promise<Stats> } | null = null;
const STATS_TTL = 30_000;
let tokensReq: { tok: string | null; p: Promise<{ items: TokenRow[] }> } | null = null;

export const admin = {
  stats: (fresh = false) => {
    if (!fresh && statsReq && Date.now() - statsReq.at < STATS_TTL) return statsReq.p;
    const p = api<Stats>('GET', '/admin/stats');
    const cur = (statsReq = { at: Date.now(), p });
    p.catch(() => { if (statsReq === cur) statsReq = null; });
    return p;
  },
  addBot: (token: string) => api<{ username: string; channels: Record<string, string> }>('POST', '/admin/bots', { token }),
  removeBot: (id: string) => api('DELETE', `/admin/bots/${id}`),
  addChannel: (id: string) => api<{ title: string; bots: Record<string, string> }>('POST', '/admin/channels', { id }),
  setChannel: (id: string, status: string) => api('PATCH', `/admin/channels/${id}`, { status }),
  /** 令牌列表在本次会话内缓存 (#23, 文件页每次进入都要用它做删除/移动提醒); 增删令牌后自动作废, fresh 强制重拉 */
  tokens: (fresh = false) => {
    const tok = auth.get();
    if (!fresh && tokensReq && tokensReq.tok === tok) return tokensReq.p;
    const p = api<{ items: TokenRow[] }>('GET', '/admin/tokens');
    const cur = (tokensReq = { tok, p });
    p.catch(() => { if (tokensReq === cur) tokensReq = null; });
    return p;
  },
  addToken: (name: string, scopes: string[], rootPath: string) => api<{ token: string }>('POST', '/admin/tokens', { name, scopes, rootPath }).finally(() => { tokensReq = null; }),
  removeToken: (id: string) => api('DELETE', `/admin/tokens/${id}`).finally(() => { tokensReq = null; }),
  maintenance: () => api<Record<string, number>>('POST', '/admin/maintenance'),
  /** check=true 时逐对检查 Bot 在频道里的管理员权限 (花 TG 子请求); usage=true 时统计分片 (10 分钟缓存), fresh=true 时重新统计 */
  topology: (check = false, fresh = false, usage = false) => api<Topology>('GET', `/admin/topology?check=${check ? 1 : 0}&fresh=${fresh ? 1 : 0}${usage ? '&usage=1' : ''}`),
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
