// 多令牌隔离与内容安全端到端测试 (v0.3.1): BASE=http://127.0.0.1:8787 ADMIN=test-admin node scripts/e2e-security.mjs
// 本地配合 scripts/mock-tg.mjs; 每条对应评审里的一个问题, 修复前全部失败
const BASE = process.env.BASE ?? 'http://127.0.0.1:8787';
const A = { Authorization: `Bearer ${process.env.ADMIN ?? 'test-admin'}` };
const j = async (method, path, body, h = A) => {
  const r = await fetch(BASE + path, { method, headers: { ...h, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let b; try { b = JSON.parse(t); } catch { b = t; } return { s: r.status, b, h: r.headers };
};
let pass = 0;
const out = (k, v) => console.log('  ', k, JSON.stringify(v));
const ok = (cond, msg) => { if (!cond) { console.error('✗', msg); process.exit(1); } pass++; console.log('✓', msg); };
await j('POST', '/api/v1/admin/maintenance?sweep=0');
await j('POST', '/api/v1/admin/channels', { id: process.env.CHANNEL ?? '-1001234567890' });
const RUN = Date.now();
const mk = async (name, scopes, rootPath) => (await j('POST', '/api/v1/admin/tokens', { name, scopes, rootPath })).b;
const aioa = await mk('aioa', ['read', 'write'], `/aioa-${RUN}`);
const ro = await mk('ro', ['read'], `/aioa-${RUN}`);
const H = (t) => ({ Authorization: `Bearer ${t.token}` });
const raw = async (h, path, name, body, ct) => {
  const r = await fetch(`${BASE}/api/v1/upload?path=${encodeURIComponent(path)}&name=${encodeURIComponent(name)}`, { method: 'POST', headers: { ...h, 'Content-Type': ct, 'Content-Length': String(Buffer.byteLength(body)) }, body });
  return r.json();
};
// 1. 管理员私有文件 + 分享
const priv = await raw(A, '/private', 'secret.txt', 'TOP SECRET', 'text/plain');
const sh = await j('POST', '/api/v1/shares', { id: priv.data.node.id });
// 受限令牌列出全部分享
const ls = await j('GET', '/api/v1/shares', null, H(aioa));
ok(ls.s === 200 && !ls.b.items.some((x) => x.id === sh.b.id), '受限令牌列不出根外的分享');
const del = await j('DELETE', `/api/v1/shares/${sh.b.id}`, null, H(aioa));
ok(del.s === 403 && (await j('GET', '/api/v1/shares')).b.items.some((x) => x.id === sh.b.id), '受限令牌删不掉根外的分享');
const own = await raw(H(aioa), '/', 'mine-share.txt', 'm', 'text/plain');
const osh = await j('POST', '/api/v1/shares', { id: own.data.node.id }, H(aioa));
ok((await j('GET', '/api/v1/shares', null, H(aioa))).b.items.some((x) => x.id === osh.b.id), '受限令牌看得到自己根下的分享');
// 2. XSS: 受限令牌上传 html
const x = await raw(H(aioa), '/', 'a.html', '<script>alert(localStorage.hxd_token)</script>', 'text/html');
const xr = await fetch(x.url);
ok(/(^|;\s*)sandbox/.test(xr.headers.get('content-security-policy') ?? '') && xr.headers.get('x-content-type-options') === 'nosniff', '上传的 html 在沙箱里返回 (CSP sandbox + nosniff)');
const ar = await fetch(`${BASE}/api/v1/files/${x.data.node.id}/content`, { headers: H(aioa) });
ok(/sandbox/.test(ar.headers.get('content-security-policy') ?? ''), '接口读取内容也带沙箱');
const svg = await raw(H(aioa), '/', 'b.jpg', '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>', 'image/svg+xml');
const sr = await fetch(svg.url);
ok(/sandbox/.test(sr.headers.get('content-security-policy') ?? ''), 'svg 同样在沙箱里');
const bad = await raw(H(aioa), '/', 'c.png', 'x', 'text/html; foo=<b>');
ok((await fetch(bad.url)).headers.get('content-type') === 'image/png', '非法 Content-Type 改为按扩展名');
// 3. 只读令牌签永久直链, 吊销令牌后仍可用
const lk = await j('POST', '/api/v1/fs/link', { path: '/a.html' }, H(ro));
await j('DELETE', `/api/v1/admin/tokens/${ro.id}`);
const lr = await fetch(lk.b.url);
ok(lk.s === 200 && lr.status === 403, '吊销令牌后它签的直链失效');
const adm = await j('POST', '/api/v1/fs/link', { id: x.data.node.id });
ok((await fetch(adm.b.url)).status === 200, '管理员直链不受影响');
// 4. 秒传投毒: 根目录非管理员令牌声明假 sha256
const root = await mk('rootw', ['read', 'write'], undefined);
const realContent = Buffer.from(`legit-installer-${RUN}`.padEnd(40, '.'));
const sha = (await import('node:crypto')).createHash('sha256').update(realContent).digest('hex');
const evil = Buffer.alloc(realContent.length, 0x45); // 同长度
const init = await j('POST', '/api/v1/uploads', { path: '/x', name: 'evil.bin', size: evil.length, sha256: sha }, H(root));
const rc = await (await fetch(`${BASE}/api/v1/uploads/chunk?i=0&ticket=${encodeURIComponent(init.b.ticket)}`, { method: 'PUT', headers: H(root), body: evil })).json();
await j('POST', '/api/v1/uploads/commit', { ticket: init.b.ticket, receipts: [rc.receipt] }, H(root));
const victim = await j('POST', '/api/v1/uploads', { path: `/admin-${RUN}`, name: 'legit.bin', size: realContent.length, sha256: sha });
ok(victim.b.done !== true, '别的令牌伪造哈希登记的 blob 不会被管理员秒传');
// 5. 受限令牌上传后自己再传同内容: 是否秒传
const c5 = Buffer.from('aioa-attachment-' + Date.now());
const s5 = (await import('node:crypto')).createHash('sha256').update(c5).digest('hex');
const up1 = await j('POST', '/api/v1/uploads', { path: '/g1', name: 'f.bin', size: c5.length, sha256: s5 }, H(aioa));
const r1 = await (await fetch(`${BASE}/api/v1/uploads/chunk?i=0&ticket=${encodeURIComponent(up1.b.ticket)}`, { method: 'PUT', headers: H(aioa), body: c5 })).json();
await j('POST', '/api/v1/uploads/commit', { ticket: up1.b.ticket, receipts: [r1.receipt] }, H(aioa));
const up2 = await j('POST', '/api/v1/uploads', { path: '/g2', name: 'f.bin', size: c5.length, sha256: s5 }, H(aioa));
ok(up2.b.done === true, '受限令牌重传自己的同内容可以秒传');
// 6. 受限令牌: 回收站可见性被全局 LIMIT 200 截断
for (let i = 0; i < 202; i++) { const f = await raw(A, `/junk-${RUN}`, `j${i}.txt`, 'x', 'text/plain'); await j('POST', '/api/v1/fs/delete', { id: f.data.node.id }); }
const af = await raw(H(aioa), '/', 'mine.txt', 'mine', 'text/plain');
await new Promise((r) => setTimeout(r, 20));
for (let i = 202; i < 404; i++) { const f = await raw(A, `/junk-${RUN}`, `j${i}.txt`, 'x', 'text/plain'); if (i === 202) await j('POST', '/api/v1/fs/delete', { id: af.data.node.id }, H(aioa)); await j('POST', '/api/v1/fs/delete', { id: f.data.node.id }); }
const tr = await j('GET', '/api/v1/fs/trash', null, H(aioa));
ok(tr.b.items.some((n) => n.id === af.data.node.id), '别人的回收站很多时, 受限令牌仍看得到自己删的文件');
await j('POST', '/api/v1/fs/restore', { id: af.data.node.id }, H(aioa));
ok((await j('GET', '/api/v1/fs/stat?path=/mine.txt', null, H(aioa))).s === 200, '受限令牌能恢复');
const se = await j('GET', '/api/v1/fs/search?q=mine', null, H(aioa));
ok(se.b.items?.some((n) => n.name === 'mine.txt'), '受限令牌在自己子树里搜得到');
// 分享密码防爆破
const pf = await raw(A, `/pw-${RUN}`, 'p.txt', 'pw-content', 'text/plain');
const psh = await j('POST', '/api/v1/shares', { id: pf.data.node.id, password: 'right' });
ok((await fetch(`${BASE}/s/${psh.b.id}`)).status === 401, '不带密码 401 (不计数)');
let st = 0;
for (let i = 0; i < 10; i++) st = (await fetch(`${BASE}/s/${psh.b.id}`, { headers: { 'X-Share-Password': `w${i}` } })).status;
ok(st === 401, '前 10 次错密码 401');
const locked = await fetch(`${BASE}/s/${psh.b.id}`, { headers: { 'X-Share-Password': 'right' } });
ok(locked.status === 429 && Number(locked.headers.get('retry-after')) > 0, '连错 10 次后锁定, 正确密码也 429');
// stats scope
const st1 = await mk('stats', ['stats'], '/');
const sr2 = await j('GET', '/api/v1/admin/stats', null, H(st1));
ok(sr2.s === 200 && typeof sr2.b.channels === 'number' && sr2.b.counters && !sr2.b.bots.some((b) => 'last_error' in b), 'stats 令牌能读用量, 看不到 Bot 报错与频道细节');
ok((await j('GET', '/api/v1/admin/tokens', null, H(st1))).s === 403, 'stats 令牌进不了其他管理接口');
ok((await j('GET', '/api/v1/fs/list?path=/', null, H(st1))).s === 403, 'stats 令牌读不了文件');
console.log(`全部通过: ${pass} 项`);
