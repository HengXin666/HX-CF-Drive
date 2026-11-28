import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { sealJson } from '../src/lib/sign';
import { HttpError } from '../src/lib/util';
import { api } from '../src/routes/api';
import { dirPage, filePage, fmtSize, passwordPage, wantsHtml } from '../src/routes/sharePage';
import { commitUpload, foldReceipts, openTicketBare, PART_SIZE, type Ticket } from '../src/services/upload';
import type { NodeRow } from '../src/lib/tree';

/** 只够 commit / tokenAlive 用的假 D1: 记下 batch 里的语句, tokens 表只认 alive 里的 id */
function fakeDb(alive: string[] = []) {
  const batches: { sql: string; args: unknown[] }[][] = [];
  const stmt = (sql: string, args: unknown[] = []) => ({
    sql, args,
    bind: (...a: unknown[]) => stmt(sql, a),
    first: async () => (sql.includes('FROM tokens') && alive.includes(String(args[0])) ? { expires_at: null } : null),
    all: async () => ({ results: [] }),
    run: async () => ({ meta: { changes: 0 } }),
  });
  return { batches, DB: { prepare: (sql: string) => stmt(sql), batch: async (s: { sql: string; args: unknown[] }[]) => { batches.push(s); return []; } } };
}

const KEY = 'k';
const ticketOf = (over: Partial<Ticket> = {}): Ticket => ({
  u: 'admin', p: 'root', n: 'big.bin', z: 10, t: 'application/octet-stream', h: null, o: 0, id: 'B1', k: 10, c: '-100', x: 9e9, ...over,
});

describe('只凭票据传分片 (v0.4)', () => {
  it('签名有效且签发令牌还在: 通过', async () => {
    const { DB } = fakeDb(['tokA']);
    const env = { SIGNING_KEY: KEY, DB } as never;
    const t = await openTicketBare(env, await sealJson(KEY, 'up', ticketOf({ u: 'tokA' })));
    expect(t.id).toBe('B1');
  });
  it('令牌已吊销, 过期, 篡改或换用途: 拒绝', async () => {
    const { DB } = fakeDb([]);
    const env = { SIGNING_KEY: KEY, DB } as never;
    await expect(openTicketBare(env, await sealJson(KEY, 'up', ticketOf({ u: 'gone' })))).rejects.toThrow(/revoked/);
    await expect(openTicketBare(env, await sealJson(KEY, 'up', ticketOf({ x: 1 })))).rejects.toThrow(/expired/);
    await expect(openTicketBare(env, 'x' + (await sealJson(KEY, 'up', ticketOf())))).rejects.toThrow(/bad/);
    await expect(openTicketBare(env, await sealJson(KEY, 'rc', ticketOf()))).rejects.toThrow(/bad/);
  });
  it('分片接口不带 Authorization 不再要令牌 (坏票据回 400 而不是 401), 带了坏令牌仍是 401', async () => {
    const app = new Hono();
    app.onError((e, c) => c.json({ error: e.message }, (e instanceof HttpError ? e.status : 500) as 400));
    app.route('/api/v1', api);
    const { DB } = fakeDb([]);
    const env = { SIGNING_KEY: KEY, DB, ADMIN_TOKEN: 'adm' };
    const init = { method: 'PUT', body: 'abc', headers: { 'content-length': '3' } };
    const bare = await app.request('/api/v1/uploads/chunk?i=0&ticket=bad', init, env);
    expect(bare.status).toBe(400);
    const wrong = await app.request('/api/v1/uploads/chunk?i=0&ticket=bad', { ...init, headers: { ...init.headers, authorization: 'Bearer nope' } }, env);
    expect(wrong.status).toBe(401);
  });
});

describe('10 GB 级分段提交 (#12, v0.4)', () => {
  it('540 片按 256 一组 fold 成 3 个聚合回执, commit 只验 3 次签名, 清单写 3 段', async () => {
    const chunk = 19 * 1024 * 1024;
    const count = 540;
    const t = ticketOf({ z: chunk * (count - 1) + 123, k: chunk });
    const { DB, batches } = fakeDb();
    const env = { SIGNING_KEY: KEY, DB } as never;
    const rc = (i: number) => sealJson(KEY, 'rc', { id: 'B1', i, c: '-100', m: i, b: '1', f: `f${i}`, s: i === count - 1 ? 123 : chunk });
    const folds: string[] = [];
    for (let g = 0; g * PART_SIZE < count; g++) {
      const n = Math.min(PART_SIZE, count - g * PART_SIZE);
      folds.push(await foldReceipts(env, t, await Promise.all(Array.from({ length: n }, (_, k) => rc(g * PART_SIZE + k)))));
    }
    expect(folds).toHaveLength(3);
    const node = await commitUpload(env, t, [], folds);
    expect(node.size).toBe(t.z);
    const sqls = batches[0].map((s) => s.sql);
    expect(sqls.filter((s) => s.includes('blob_parts'))).toHaveLength(3);
    const blob = batches[0][0];
    expect(blob.args[4]).toBe('{"parts":3}');
  });
  it('少一组时报缺片', async () => {
    const t = ticketOf({ z: 10 * 300, k: 10 });
    const { DB } = fakeDb();
    const env = { SIGNING_KEY: KEY, DB } as never;
    const g0 = await foldReceipts(env, t, await Promise.all(Array.from({ length: PART_SIZE }, (_, i) => sealJson(KEY, 'rc', { id: 'B1', i, c: '-100', m: i, b: '1', f: 'f', s: 10 }))));
    await expect(commitUpload(env, t, [], [g0])).rejects.toThrow(/missing chunks: 256/);
  });
});

describe('分享页 (v0.4)', () => {
  const req = (accept: string, method = 'GET') => new Request('http://x/s/abc', { method, headers: { accept } });
  it('只有浏览器导航才给页面', () => {
    expect(wantsHtml(req('text/html,application/xhtml+xml'), {})).toBe(true);
    expect(wantsHtml(req('*/*'), {})).toBe(false);
    expect(wantsHtml(req('image/avif,image/*'), {})).toBe(false);
    expect(wantsHtml(req('text/html'), { download: '1' })).toBe(false);
    expect(wantsHtml(req('text/html'), { raw: '1' })).toBe(false);
    expect(wantsHtml(req('text/html', 'POST'), {})).toBe(false);
  });
  const node = (name: string, kind: 'dir' | 'file', size = 0): NodeRow =>
    ({ id: name, parent_id: 'p', name, kind, size, mime: 'text/plain', blob_id: null, created_at: 0, updated_at: 0, deleted_at: null }) as NodeRow;
  it('文件夹列表: 子目录与下载链接带上路径和密码, 名字转义', () => {
    const html = dirPage({ id: 'abc', pw: 'p w' }, node('根', 'dir'), '/a', [node('子<b>', 'dir'), node('x&y.txt', 'file', 2048)]);
    expect(html).toContain('子&lt;b&gt;');
    expect(html).not.toContain('子<b>');
    expect(html).toContain('/s/abc?path=%2Fa%2Fx%26y.txt&amp;download=1&amp;p=p+w');
    expect(html).toContain('2.0 KB');
  });
  it('文件页有下载按钮; 密码页有表单与错误提示', () => {
    expect(filePage({ id: 'abc', pw: '' }, node('a.mp4', 'file', 5)) ).toContain('/s/abc?download=1');
    expect(passwordPage('abc', { wrong: true })).toContain('密码不对');
    expect(passwordPage('abc', { locked: 600 })).toContain('10 分钟');
    expect(fmtSize(10 * 1024 ** 3)).toBe('10.0 GB');
  });
});
