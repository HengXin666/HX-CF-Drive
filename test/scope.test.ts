import { describe, expect, it } from 'vitest';
import { narrowScope } from '../src/lib/auth';

type Row = { id: string; parent_id: string | null; name: string; kind: string; deleted_at: number | null };

/** 只认 walkPath 与 mkdirp 的假 D1: nodes 是一棵小树 */
function fakeEnv(rows: Row[]) {
  const stmt = (sql: string, args: unknown[] = []) => ({
    bind: (...a: unknown[]) => stmt(sql, a),
    all: async () => {
      const [rootId, segsJson] = args as [string, string];
      const segs = JSON.parse(segsJson) as string[];
      const live = rows.filter((r) => r.deleted_at === null);
      let cur = live.find((r) => r.id === rootId);
      const out: Row[] = [];
      for (let d = 0; cur; d++) {
        out.push(cur);
        if (d >= segs.length || cur.kind !== 'dir') break;
        const parent: Row = cur;
        cur = live.find((r) => r.parent_id === parent.id && r.name === segs[d]);
      }
      return { results: out };
    },
    args,
  });
  return {
    DB: {
      prepare: (sql: string) => stmt(sql),
      batch: async (list: { args: unknown[] }[]) => {
        for (const s of list) rows.push({ id: String(s.args[0]), parent_id: String(s.args[1]), name: String(s.args[2]), kind: 'dir', deleted_at: null });
        return [];
      },
    },
  } as never;
}

const base = (): Row[] => [
  { id: 'R', parent_id: null, name: '', kind: 'dir', deleted_at: null },
  { id: 'D', parent_id: 'R', name: 'drive', kind: 'dir', deleted_at: null },
  { id: 'F', parent_id: 'R', name: 'a.txt', kind: 'file', deleted_at: null },
];
const who = (scopes: string[]) => ({ id: 't', scopes: new Set(scopes), rootId: 'R' });

describe('X-Drive-Scope 收窄根目录', () => {
  it('没给或给 / 时不变', async () => {
    const p = who(['read']);
    expect(await narrowScope(fakeEnv(base()), p, undefined)).toBe(p);
    expect(await narrowScope(fakeEnv(base()), p, '/')).toBe(p);
  });
  it('已有目录: 根换成它', async () => {
    expect((await narrowScope(fakeEnv(base()), who(['read']), '/drive')).rootId).toBe('D');
  });
  it('不存在: 有写权限就建, 只读 404', async () => {
    const rows = base();
    const p = await narrowScope(fakeEnv(rows), who(['read', 'write']), '/new');
    expect(rows.find((r) => r.name === 'new')?.id).toBe(p.rootId);
    await expect(narrowScope(fakeEnv(base()), who(['read']), '/new')).rejects.toThrow(/scope not found/);
  });
  it('不是目录或不以 / 开头: 拒绝', async () => {
    await expect(narrowScope(fakeEnv(base()), who(['read']), '/a.txt')).rejects.toThrow(/not a dir/);
    await expect(narrowScope(fakeEnv(base()), who(['read']), 'drive')).rejects.toThrow(/bad scope/);
    await expect(narrowScope(fakeEnv(base()), who(['read']), '/100%')).rejects.toThrow(/bad scope/);
  });
  it('目录在回收站里: 只读 404, 可写时重建一个新的', async () => {
    const trashed = () => base().map((r) => (r.id === 'D' ? { ...r, deleted_at: 5 } : r));
    await expect(narrowScope(fakeEnv(trashed()), who(['read']), '/drive')).rejects.toThrow(/scope not found/);
    expect((await narrowScope(fakeEnv(trashed()), who(['write']), '/drive')).rootId).not.toBe('D');
  });
});
