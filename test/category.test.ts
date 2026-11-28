// 按类型筛选 (#22): 前端用的 categoryOf 和服务端搜索用的 categorySql 规则一致
import { describe, expect, it } from 'vitest';
import { CATEGORIES, categoryOf, categorySql } from '../src/lib/category';

const SAMPLES: [string, string, string | null][] = [
  ['file', 'a.PNG', null], ['file', 'b', 'image/webp'], ['file', 'c.mp4', 'application/octet-stream'], ['file', 'd.mkv', null],
  ['file', 'e.mp3', 'audio/mpeg'], ['file', 'f.pdf', null], ['file', 'g.txt', 'text/plain'], ['file', 'h.tar.gz', 'application/gzip'],
  ['file', 'i.exe', 'application/x-msdownload'], ['file', 'noext', null], ['file', 'j.md', 'application/octet-stream'],
  ['file', 'weird.png', 'text/plain'], ['file', 'k.zip', 'video/mp4'], ['dir', 'photos.png', null], ['file', 'v.1.2.flac', null],
];

describe('文件分类', () => {
  it('categoryOf', () => {
    expect(SAMPLES.map(([k, n, m]) => categoryOf(k, m, n))).toEqual(
      ['image', 'image', 'video', 'video', 'audio', 'doc', 'doc', 'archive', 'other', 'other', 'doc', 'doc', 'video', null, 'audio']);
  });
  let sqlite: { DatabaseSync: new (p: string) => any } | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  try { sqlite = (globalThis as any).process?.getBuiltinModule?.('node:sqlite') ?? null; } catch { /* Node < 22 没有 */ }
  it.skipIf(!sqlite)('SQL 条件与 categoryOf 一致', () => {
    const db = new sqlite!.DatabaseSync(':memory:');
    db.exec('CREATE TABLE nodes (id INTEGER, kind TEXT, name TEXT, mime TEXT)');
    const ins = db.prepare('INSERT INTO nodes VALUES (?, ?, ?, ?)');
    SAMPLES.forEach(([k, n, m], i) => ins.run(i, k, n, m));
    for (const c of CATEGORIES) {
      const [w, a] = categorySql(c);
      const got = db.prepare(`SELECT id FROM nodes n WHERE ${w} ORDER BY id`).all(...a).map((r: { id: number }) => r.id);
      const want = SAMPLES.map(([k, n, m], i) => (categoryOf(k, m, n) === c ? i : -1)).filter((i) => i >= 0);
      expect([c, got]).toEqual([c, want]);
    }
  });
});
