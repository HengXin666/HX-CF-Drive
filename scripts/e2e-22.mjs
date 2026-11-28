// #22 功能的端到端检查: BASE=http://127.0.0.1:8795 node scripts/e2e-22.mjs [段名...]
// 本地配合 wrangler dev + scripts/mock-tg.mjs; .dev.vars 开 D1_METER=1 时顺带打印每个操作的 D1 查询 / 行读 / 行写
const BASE = process.env.BASE ?? 'http://127.0.0.1:8795';
const ADMIN = process.env.ADMIN ?? 'test-admin';
const CHANNEL = process.env.CHANNEL ?? '-1001234567890';
const H = { Authorization: `Bearer ${ADMIN}` };
const P = `/e2e22-${Date.now()}`;
const only = new Set(process.argv.slice(2));
let pass = 0;
const meter = [];
const ok = (cond, msg) => { if (!cond) { console.error('✗', msg); process.exit(1); } pass++; console.log('✓', msg); };
async function j(method, path, body, headers = {}, label) {
  const r = await fetch(BASE + path, { method, headers: { ...H, 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text();
  if (label && r.headers.get('X-D1-Rows')) meter.push([label, r.headers.get('X-D1-Rows')]);
  try { return { status: r.status, body: JSON.parse(t), headers: r.headers }; } catch { return { status: r.status, body: t, headers: r.headers }; }
}
async function put(dir, name, data, mime = 'text/plain', q = '') {
  const r = await fetch(`${BASE}/api/v1/upload?path=${encodeURIComponent(dir)}&name=${encodeURIComponent(name)}${q}`, { method: 'POST', headers: { ...H, 'Content-Type': mime }, body: data });
  const b = await r.json();
  if (!r.ok) throw new Error(`upload ${r.status} ${JSON.stringify(b)}`);
  return b.data.node;
}
const sect = (name) => only.size === 0 || only.has(name);

await j('POST', '/api/v1/admin/channels', { id: CHANNEL });

if (sect('links')) {
  const a = await put(`${P}/links`, 'a.png', 'AAA', 'image/png');
  const b = await put(`${P}/links`, 'b.txt', 'BB');
  const d = (await j('POST', '/api/v1/fs/mkdir', { path: `${P}/links/dir` })).body.node;
  const r = await j('POST', '/api/v1/fs/links', { ids: [b.id, a.id, d.id, 'nope'] }, {}, 'fs/links 2 个文件');
  ok(r.status === 200 && r.body.items.length === 2 && r.body.items[0].id === b.id, '批量直链按请求顺序返回文件');
  ok(r.body.missing.includes(d.id) && r.body.missing.includes('nope'), '目录和不存在的 id 进 missing');
  ok((await (await fetch(r.body.items[1].url)).text()) === 'AAA', '批量直链可直接访问');
  // 受限令牌拿不到根外文件的链接
  const t = (await j('POST', '/api/v1/admin/tokens', { name: 'e2e22', scopes: ['read'], rootPath: `${P}/other` })).body.token;
  const r2 = await j('POST', '/api/v1/fs/links', { ids: [a.id] }, { Authorization: `Bearer ${t}` });
  ok(r2.status === 200 && r2.body.items.length === 0 && r2.body.missing[0] === a.id, '受限令牌签不到根外的直链');
  ok((await j('POST', '/api/v1/fs/links', { ids: Array.from({ length: 201 }, (_, i) => 'x' + i) })).status === 413, '超过 200 个返回 413');
}

if (sect('batch')) {
  const D = `${P}/batch`;
  const fs = [];
  for (const n of ['a.txt', 'b.txt', 'c.txt', 'd.txt']) fs.push(await put(D, n, n));
  const sub = (await j('POST', '/api/v1/fs/mkdir', { path: `${D}/sub` })).body.node;
  await put(`${D}/to`, 'c.txt', 'old');
  const to = (await j('GET', `/api/v1/fs/stat?path=${encodeURIComponent(D + '/to')}`)).body.node;
  const list = async (p) => (await j('GET', `/api/v1/fs/list?path=${encodeURIComponent(p)}`)).body.children.map((c) => c.name).sort().join(',');
  // move: c.txt 在目标里已存在 → failed; sub 移进 to
  let r = await j('POST', '/api/v1/fs/batch', { op: 'move', ids: [fs[0].id, fs[2].id, sub.id, 'nope'], toParentId: to.id }, {}, 'batch move 4 项');
  ok(r.status === 200 && r.body.ok === 2 && r.body.failed.length === 2, `批量移动: 2 成功, 同名与不存在进 failed (${JSON.stringify(r.body.failed)})`);
  ok(await list(D + '/to') === 'a.txt,c.txt,sub', '目标目录内容正确');
  // 把 sub 移进它自己
  r = await j('POST', '/api/v1/fs/batch', { op: 'move', ids: [sub.id], toPath: `${D}/to/sub` });
  ok(r.body.ok === 0 && /itself/.test(r.body.failed[0]?.error), '不能把目录移进自身');
  // copy 两个文件到 sub
  r = await j('POST', '/api/v1/fs/batch', { op: 'copy', ids: [fs[1].id, fs[3].id], toParentId: sub.id }, {}, 'batch copy 2 项');
  ok(r.body.ok === 2 && r.body.nodes.length === 2 && await list(`${D}/to/sub`) === 'b.txt,d.txt', '批量复制');
  ok((await (await fetch(`${BASE}/api/v1/files/${r.body.nodes[0].id}/content`, { headers: H })).text()) === 'b.txt', '复制出的文件内容正确');
  // rename: 序号式 + 一个撞名
  r = await j('POST', '/api/v1/fs/batch', { op: 'rename', items: [{ id: fs[1].id, name: '照片_01.txt' }, { id: fs[3].id, name: '照片_02.txt' }, { id: fs[2].id, name: 'x/y' }] }, {}, 'batch rename 3 项');
  ok(r.body.ok === 2 && r.body.failed[0]?.error === 'invalid name' && await list(D) === 'c.txt,to,照片_01.txt,照片_02.txt', '批量重命名, 非法名字进 failed');
  r = await j('POST', '/api/v1/fs/batch', { op: 'rename', items: [{ id: fs[1].id, name: 'c.txt' }] });
  ok(r.body.ok === 0 && r.body.failed[0]?.error === 'target exists', '重命名撞上已有文件');
  // delete 3 项 → restore 3 项 (其中一个在原处已有同名)
  const ids = [fs[1].id, fs[2].id, fs[3].id];
  r = await j('POST', '/api/v1/fs/batch', { op: 'delete', ids }, {}, 'batch delete 3 项');
  ok(r.body.ok === 3 && await list(D) === 'to', '批量删除');
  await put(D, 'c.txt', 'new');
  r = await j('POST', '/api/v1/fs/batch', { op: 'restore', ids }, {}, 'batch restore 3 项');
  const names = await list(D);
  ok(r.body.ok === 3 && names.includes('照片_01.txt') && /c\.txt \(restored /.test(names), `批量恢复, 同名加后缀 (${names})`);
  // 受限令牌不能动根外的节点
  const t = (await j('POST', '/api/v1/admin/tokens', { name: 'e2e22b', scopes: ['read', 'write'], rootPath: `${D}/to` })).body.token;
  r = await j('POST', '/api/v1/fs/batch', { op: 'delete', ids: [fs[1].id, sub.id] }, { Authorization: `Bearer ${t}` });
  ok(r.body.ok === 1 && r.body.failed[0]?.id === fs[1].id && r.body.failed[0].error === 'outside token root', '受限令牌: 根外的项进 failed, 根内的照常删除');
  ok((await j('POST', '/api/v1/fs/batch', { op: 'nuke', ids: [] })).status === 400, '未知 op 返回 400');
}

console.log(`\n${pass} 项通过`);
if (meter.length) { console.log('\nD1 实测 (查询 / 行读 / 行写):'); for (const [l, m] of meter) console.log(`  ${l}: ${m}`); }
