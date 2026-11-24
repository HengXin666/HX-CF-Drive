// 目录树操作, 语义对齐后端 src/lib/tree.ts: 根节点 id 为 root, 删除进回收站, 同名冲突返回 409
import { type DNode, delData, newId, now, state } from './db';

export class HttpError extends Error {
  constructor(public status: number, message: string, public headers: Record<string, string> = {}) {
    super(message);
  }
}

export const ROOT = 'root';

export function publicNode(n: DNode) {
  return { id: n.id, name: n.name, kind: n.kind, size: n.size, mime: n.mime, parentId: n.parentId, createdAt: n.createdAt, updatedAt: n.updatedAt };
}

export function getNode(id: string): DNode | null {
  const n = state().nodes[id];
  return n && n.deletedAt === null ? n : null;
}

export function children(pid: string): DNode[] {
  return Object.values(state().nodes)
    .filter((n) => n.parentId === pid && n.deletedAt === null)
    .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, 'zh-CN') : a.kind === 'dir' ? -1 : 1));
}

const childNamed = (pid: string, name: string) => children(pid).find((n) => n.name === name) ?? null;

export const splitPath = (p: string) => p.split('/').filter(Boolean);

export function resolvePath(path: string, from = ROOT): DNode | null {
  let cur = getNode(from);
  for (const part of splitPath(path)) {
    if (!cur || cur.kind !== 'dir') return null;
    cur = childNamed(cur.id, part);
  }
  return cur;
}

export function pathOf(n: DNode): string {
  const parts: string[] = [];
  for (let cur: DNode | undefined = n; cur && cur.id !== ROOT; cur = state().nodes[cur.parentId ?? '']) parts.unshift(cur.name);
  return '/' + parts.join('/');
}

function checkName(name: string) {
  if (!name || name === '.' || name === '..' || /[/\\]/.test(name)) throw new HttpError(400, 'invalid name');
}

export function insert(n: Omit<DNode, 'id' | 'createdAt' | 'updatedAt' | 'deletedAt'>): DNode {
  checkName(n.name);
  const t = now();
  const node: DNode = { ...n, id: newId(), createdAt: t, updatedAt: t, deletedAt: null };
  state().nodes[node.id] = node;
  if (node.blobId) state().blobs[node.blobId].refs++;
  return node;
}

export function mkdirp(path: string): DNode {
  let cur = getNode(ROOT)!;
  for (const part of splitPath(path)) {
    const hit = childNamed(cur.id, part);
    if (hit && hit.kind !== 'dir') throw new HttpError(409, `${part} is a file`);
    cur = hit ?? insert({ parentId: cur.id, name: part, kind: 'dir', size: 0, mime: null, blobId: null });
  }
  return cur;
}

/** 目标目录下已有同名项时: overwrite 则把旧的放进回收站, 否则 409 */
export function claimName(pid: string, name: string, overwrite: boolean, self?: string) {
  const hit = childNamed(pid, name);
  if (!hit || hit.id === self) return;
  if (!overwrite) throw new HttpError(409, 'name exists');
  trash(hit.id);
}

const isAncestor = (a: string, n: DNode) => {
  for (let cur: DNode | undefined = n; cur; cur = state().nodes[cur.parentId ?? '']) if (cur.id === a) return true;
  return false;
};

export function move(id: string, toId: string, name: string, overwrite: boolean): DNode {
  const n = getNode(id);
  const to = getNode(toId);
  if (!n || !to) throw new HttpError(404, 'not found');
  if (n.id === ROOT) throw new HttpError(400, 'cannot move root');
  if (to.kind !== 'dir') throw new HttpError(400, 'target is not a dir');
  if (isAncestor(n.id, to)) throw new HttpError(400, 'cannot move into itself');
  checkName(name);
  claimName(to.id, name, overwrite, n.id);
  Object.assign(n, { parentId: to.id, name, updatedAt: now() });
  return n;
}

/** 复制只复制元数据并增加数据块引用 */
export function copy(src: DNode, pid: string, name: string): DNode {
  claimName(pid, name, false);
  const walk = (n: DNode, p: string, nm: string): DNode => {
    const c = insert({ parentId: p, name: nm, kind: n.kind, size: n.size, mime: n.mime, blobId: n.blobId });
    if (n.kind === 'dir') for (const ch of children(n.id)) walk(ch, c.id, ch.name);
    return c;
  };
  return walk(src, pid, name);
}

function subtree(id: string): DNode[] {
  const all = Object.values(state().nodes);
  const out: DNode[] = [];
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop()!;
    const n = state().nodes[cur];
    if (!n) continue;
    out.push(n);
    for (const c of all) if (c.parentId === cur) stack.push(c.id);
  }
  return out;
}

/** 整棵子树标记同一个删除时间, 回收站只列出顶层 */
export function trash(id: string): number {
  if (id === ROOT) throw new HttpError(400, 'cannot delete root');
  const t = now();
  const list = subtree(id).filter((n) => n.deletedAt === null);
  for (const n of list) n.deletedAt = t;
  return list.length;
}

export function trashList(): (ReturnType<typeof publicNode> & { deletedAt: number })[] {
  const nodes = state().nodes;
  return Object.values(nodes)
    .filter((n) => n.deletedAt !== null && n.deletedAt > 1 && nodes[n.parentId ?? '']?.deletedAt !== n.deletedAt)
    .sort((a, b) => b.deletedAt! - a.deletedAt!)
    .map((n) => ({ ...publicNode(n), deletedAt: n.deletedAt! }));
}

export function restore(id: string) {
  const n = state().nodes[id];
  if (!n || n.deletedAt === null) throw new HttpError(404, 'not in trash');
  const t = n.deletedAt;
  for (const x of subtree(id)) if (x.deletedAt === t) x.deletedAt = null;
  // 父目录已不在时恢复到根目录; 同名时自动加后缀
  if (!getNode(n.parentId ?? '')) n.parentId = ROOT;
  const base = n.name;
  for (let i = 1; children(n.parentId!).some((c) => c.id !== n.id && c.name === n.name); i++) {
    n.name = base.replace(/(\.[^.]*)?$/, (ext) => ` (${i})${ext}`);
  }
}

/** 彻底删除: 把回收站项目 (整棵子树) 的删除时间改成 1, 视为早已过期, 再跑一轮维护 */
export async function purge(ids: string[] | null): Promise<Record<string, number>> {
  const nodes = state().nodes;
  const tops = ids ?? trashList().map((n) => n.id);
  for (const id of tops) {
    const n = nodes[id];
    if (!n || n.deletedAt === null) continue;
    const t = n.deletedAt;
    for (const x of subtree(id)) if (x.deletedAt === t) x.deletedAt = 1;
  }
  return { ...(await maintenance()), more: 0, leftNodes: 0, leftBlobs: 0 };
}

/** 维护: 清理超过保留期的回收站条目, 以及引用为 0 的数据块 */
export async function maintenance(keepMs = 7 * 86400_000): Promise<Record<string, number>> {
  const s = state();
  const out = { seeded: 0, revived: 0, nodes: 0, blobs: 0, tgDeletes: 0 };
  const cut = now() - keepMs;
  for (const n of Object.values(s.nodes)) {
    if (n.deletedAt !== null && n.deletedAt < cut) {
      if (n.blobId && s.blobs[n.blobId]) s.blobs[n.blobId].refs--;
      delete s.nodes[n.id];
      out.nodes++;
    }
  }
  for (const b of Object.values(s.blobs)) {
    if (b.refs > 0) continue;
    delete s.blobs[b.id];
    await delData(b.id);
    out.blobs++;
    out.tgDeletes++;
  }
  return out;
}
