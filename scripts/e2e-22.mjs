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

if (sect('share')) {
  const f = await put(`${P}/share`, 's.txt', 'SHARED');
  const sh = (await j('POST', '/api/v1/shares', { id: f.id, password: 'p1', remark: '给小明' })).body;
  const get = (q = '', h = {}) => fetch(`${BASE}/s/${sh.id}${q}`, { headers: h });
  ok((await get('?p=p1')).status === 200, '创建带密码和备注的分享');
  let r = await j('PATCH', `/api/v1/shares/${sh.id}`, { disabled: true, remark: '已发' }, {}, 'PATCH share 停用+备注');
  ok(r.status === 200 && r.body.share.disabled === 1 && r.body.share.remark === '已发', '停用并改备注');
  ok((await get('?p=p1')).status === 410, '停用后访问返回 410');
  const page = await (await get('', { Accept: 'text/html' })).text();
  ok(page.includes('分享已停用'), '浏览器打开显示 分享已停用 页面');
  await j('PATCH', `/api/v1/shares/${sh.id}`, { disabled: false, password: 'p2' });
  ok((await get('?p=p1')).status === 401 && (await get('?p=p2')).status === 200, '启用并改密码: 旧密码失效, 新密码可用');
  await j('PATCH', `/api/v1/shares/${sh.id}`, { password: null, expiresIn: 1 });
  ok((await (await get()).text()) === 'SHARED', '去掉密码后直接可访问');
  await new Promise((s) => setTimeout(s, 1200));
  ok((await get()).status === 404, '有效期改成 1 秒, 过期后 404');
  await j('PATCH', `/api/v1/shares/${sh.id}`, { expiresIn: null });
  ok((await get()).status === 200, '改回永久');
  const row = (await j('GET', '/api/v1/shares')).body.items.find((x) => x.id === sh.id);
  ok(row && row.remark === '已发' && row.disabled === 0 && row.has_password === 0 && row.expires_at === null, '分享列表带上状态和备注');
  ok((await j('PATCH', `/api/v1/shares/${sh.id}`, {})).status === 400, '没有要改的字段返回 400');
  const t = (await j('POST', '/api/v1/admin/tokens', { name: 'e2e22s', scopes: ['read', 'write'], rootPath: `${P}/elsewhere` })).body.token;
  ok((await j('PATCH', `/api/v1/shares/${sh.id}`, { disabled: true }, { Authorization: `Bearer ${t}` })).status === 403, '受限令牌改不了根外的分享');
}

if (sect('mcp')) {
  const D = `${P}/mcp`;
  let id = 0;
  const rpc = async (method, params, auth = H.Authorization, label) => {
    const r = await fetch(`${BASE}/api/v1/mcp`, { method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
    if (label && r.headers.get('X-D1-Rows')) meter.push([label, r.headers.get('X-D1-Rows')]);
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const tool = async (name, args, auth, label) => (await rpc('tools/call', { name, arguments: args }, auth, label)).body.result;
  let r = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } });
  ok(r.status === 200 && r.body.result.serverInfo.name === 'HX-CF-Drive' && r.body.result.capabilities.tools, 'initialize');
  const n = await fetch(`${BASE}/api/v1/mcp`, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
  ok(n.status === 202, '通知回 202');
  ok((await rpc('tools/list')).body.result.tools.length === 6, 'tools/list 6 个工具');
  const up = await tool('upload', { dir: D, name: '笔记.md', text: '# 你好' }, undefined, 'mcp upload');
  ok(!up.isError && up.structuredContent.data.node.name === '笔记.md', 'upload 工具 (自动建目录)');
  ok((await (await fetch(up.structuredContent.url)).text()) === '# 你好', '返回的直链内容正确');
  const bin = await tool('upload', { dir: D, name: 'b.bin', base64: Buffer.from([0, 1, 2, 255]).toString('base64'), mime: 'application/octet-stream' });
  ok(!bin.isError && bin.structuredContent.data.node.size === 4, 'base64 上传');
  const ls = await tool('list', { path: D }, undefined, 'mcp list');
  ok(ls.structuredContent.children.map((c) => c.name).sort().join(',') === 'b.bin,笔记.md', 'list 工具');
  ok((await tool('stat', { path: `${D}/b.bin` })).structuredContent.node.size === 4, 'stat 工具');
  const lk = await tool('link', { path: `${D}/b.bin`, expiresIn: 60 });
  ok(Buffer.from(await (await fetch(lk.structuredContent.url)).arrayBuffer()).equals(Buffer.from([0, 1, 2, 255])), 'link 工具');
  const sh = await tool('share', { path: D, remark: 'mcp' });
  ok((await (await fetch(sh.structuredContent.url)).json()).children.length === 2, 'share 工具 (目录分享)');
  const miss = await tool('stat', { path: `${D}/nope` });
  ok(miss.isError && /404/.test(miss.content[0].text), '接口错误变成 isError');
  // 只读令牌不能上传; 受限令牌只看自己根下
  const ro = (await j('POST', '/api/v1/admin/tokens', { name: 'e2e22m', scopes: ['read'], rootPath: D })).body.token;
  const roUp = await tool('upload', { name: 'x.txt', text: 'x' }, `Bearer ${ro}`);
  ok(roUp.isError && /403/.test(roUp.content[0].text), '只读令牌调 upload 返回 403');
  ok((await tool('list', {}, `Bearer ${ro}`)).structuredContent.children.length === 2, '受限令牌的 / 是它自己的根目录');
  ok((await rpc('tools/list', undefined, 'Bearer bad')).status === 401, '坏令牌 401');
  ok((await fetch(`${BASE}/api/v1/mcp`, { headers: H })).status === 405, 'GET 405 (不开 SSE)');
}

console.log(`\n${pass} 项通过`);
if (meter.length) { console.log('\nD1 实测 (查询 / 行读 / 行写):'); for (const [l, m] of meter) console.log(`  ${l}: ${m}`); }
