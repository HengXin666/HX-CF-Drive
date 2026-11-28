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

if (sect('dav')) {
  const D = `${P}/dav`;
  await put(D, 'q.bin', 'x'.repeat(1000));
  const pf = (path, body, auth = H.Authorization) => fetch(`${BASE}/dav${path}`, { method: 'PROPFIND', headers: { Authorization: auth, Depth: '0', 'Content-Type': 'application/xml' }, body });
  const q = '<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:prop><D:quota-used-bytes/><D:quota-available-bytes/></D:prop></D:propfind>';
  let r = await pf('/', q);
  let x = await r.text();
  if (r.headers.get('X-D1-Rows')) meter.push(['PROPFIND quota (根令牌)', r.headers.get('X-D1-Rows')]);
  ok(r.status === 207 && /<D:quota-used-bytes>\d+<\/D:quota-used-bytes>/.test(x) && /<D:quota-available-bytes>\d+</.test(x), '根令牌 PROPFIND 返回 quota 属性');
  x = await (await pf('/', '')).text();
  ok(!/quota/.test(x), '不点名要 quota 时不返回 (不属于 allprop), 不多查询');
  const t = (await j('POST', '/api/v1/admin/tokens', { name: 'e2e22d', scopes: ['read'], rootPath: D })).body.token;
  r = await pf('/', q, `Basic ${Buffer.from(`u:${t}`).toString('base64')}`);
  x = await r.text();
  if (r.headers.get('X-D1-Rows')) meter.push(['PROPFIND quota (受限令牌, 子树 1 个文件)', r.headers.get('X-D1-Rows')]);
  ok(/<D:quota-used-bytes>1000<\/D:quota-used-bytes>/.test(x), '受限令牌按自己子树统计已用 (1000 字节)');
}

if (sect('search')) {
  const D = `${P}/search`;
  await put(`${D}/a`, 'cat.png', 'x', 'image/png');
  await put(`${D}/a/deep`, 'cat2.JPG', 'x', 'application/octet-stream');
  await put(`${D}/a`, 'cat.mp4', 'x', 'video/mp4');
  await put(`${D}/a`, 'notes.md', 'x', 'application/octet-stream');
  await put(`${D}/b`, 'cat3.png', 'x', 'image/png');
  const s = async (qs, label) => (await j('GET', `/api/v1/fs/search?${new URLSearchParams(qs)}`, undefined, {}, label));
  let r = await s({ type: 'image', dir: `${D}/a` }, '搜索 type=image dir=子树');
  ok(r.status === 200 && r.body.items.map((x) => x.name).sort().join(',') === 'cat.png,cat2.JPG', `按类型 + 当前目录子树 (${r.body.items?.map((x) => x.name)})`);
  r = await s({ q: 'cat', dir: D, type: 'video' });
  ok(r.body.items.length === 1 && r.body.items[0].path === `${D}/a/cat.mp4`, '关键字 + 类型, 返回完整路径');
  r = await s({ type: 'doc', dir: D });
  ok(r.body.items.length === 1 && r.body.items[0].name === 'notes.md', '扩展名识别文档 (MIME 是 octet-stream)');
  ok((await s({ type: 'bogus' })).status === 400 && (await s({})).status === 400, '坏类型 / 什么都不给 400');
}

if (sect('ttl')) {
  const D = `${P}/ttl`;
  // 小文件一次性上传带 TTL
  const r1 = await fetch(`${BASE}/api/v1/upload?path=${encodeURIComponent(D)}&name=t.txt&expiresIn=60`, { method: 'POST', headers: { ...H, 'Content-Type': 'text/plain' }, body: 'tmp' });
  const n1 = (await r1.json()).data;
  if (r1.headers.get('X-D1-Rows')) meter.push(['一次性上传带 expiresIn', r1.headers.get('X-D1-Rows')]);
  ok(n1.node.expiresAt > Date.now() + 50_000 && n1.node.expiresAt < Date.now() + 70_000, '上传带 expiresIn, 返回 expiresAt');
  ok((await (await fetch(n1.url)).text()) === 'tmp', '到期前可以访问');
  ok((await j('POST', '/api/v1/uploads', { path: D, name: 'x', size: 10, expiresIn: 5 })).status === 400, 'expiresIn 小于 60 秒 400');
  // 分片上传带 TTL: 凭证里带着, commit 时写进节点
  const init = (await j('POST', '/api/v1/uploads', { path: D, name: 'big.bin', size: 3, expiresIn: 3600 })).body;
  const rc = (await (await fetch(`${BASE}/api/v1/uploads/chunk?i=0&ticket=${encodeURIComponent(init.ticket)}`, { method: 'PUT', headers: H, body: 'abc' })).json()).receipt;
  const big = (await j('POST', '/api/v1/uploads/commit', { ticket: init.ticket, receipts: [rc] })).body.node;
  ok(big.expiresAt > Date.now() + 3500_000, '分片上传 commit 后带 expiresAt');
  // 把到期时间改到过去: 直接调 /fs/expire 不允许 < 60 秒, 用 D1 本地改不了, 所以改成取消 + 再设置检验接口
  let r = await j('POST', '/api/v1/fs/expire', { id: big.id, expiresIn: null }, {}, 'fs/expire 取消');
  ok(r.status === 200 && r.body.node.expiresAt === null, '/fs/expire 取消到期');
  r = await j('POST', '/api/v1/fs/expire', { path: D, expiresIn: 120 });
  ok(r.status === 200 && r.body.node.kind === 'dir' && r.body.node.expiresAt > Date.now(), '目录也能设到期');
  ok((await j('GET', `/api/v1/fs/list?path=${encodeURIComponent(D)}`)).body.children.find((c) => c.name === 't.txt').expiresAt === n1.node.expiresAt, '列表带 expiresAt');
  // 真的到期: 本地 D1 (LOCAL_D1=1, 在仓库根目录跑) 把一个从没读过的文件的 expires_at 改到过去, 验证 410 和维护清理
  if (process.env.LOCAL_D1) {
    const { execSync } = await import('node:child_process');
    const r2 = await fetch(`${BASE}/api/v1/upload?path=${encodeURIComponent(D + '/gone')}&name=g.txt&expiresIn=600`, { method: 'POST', headers: { ...H, 'Content-Type': 'text/plain' }, body: 'gone' });
    const g = (await r2.json()).data;
    execSync(`npx wrangler d1 execute hx-cf-drive --local --persist-to .wrangler/state --command "UPDATE nodes SET expires_at = ${Date.now() - 1000} WHERE id = '${g.node.id}'"`, { stdio: 'ignore' });
    ok((await fetch(g.url)).status === 410, '真的到期后直链返回 410');
    ok((await fetch(`${BASE}/api/v1/files/${g.node.id}/content`, { headers: H })).status === 410, '真的到期后 API 读内容 410');
    const m = await j('POST', '/api/v1/admin/maintenance?sweep=0', undefined, {}, '维护 (含到期清理)');
    ok(m.status === 200 && m.body.expired >= 1, `维护任务把到期节点移进回收站 (expired=${m.body.expired})`);
    ok(!(await j('GET', `/api/v1/fs/list?path=${encodeURIComponent(D + '/gone')}`)).body.children.some((c) => c.id === g.node.id), '到期节点已不在目录里');
    const tr = await j('GET', '/api/v1/fs/trash');
    ok(JSON.stringify(tr.body).includes(g.node.id), '到期节点在回收站里');
  }
}

if (sect('sharecap')) {
  const D = `${P}/sharecap`;
  const f = await put(D, 'a.txt', 'abcdef');
  const sh = (await j('POST', '/api/v1/shares', { id: f.id, maxDownloads: 2 }, {}, 'shares 创建带 maxDownloads')).body;
  const raw = (q = '', h = {}) => fetch(`${sh.url}?raw=1${q}`, { headers: h });
  ok((await raw('', { Range: 'bytes=2-' })).status === 206, '续传 (Range 不从 0 开始) 不计数');
  const r1 = await raw();
  if (r1.headers.get('X-D1-Rows')) meter.push(['分享下载 (计数)', r1.headers.get('X-D1-Rows')]);
  ok(r1.status === 200 && (await r1.text()) === 'abcdef', '第 1 次下载');
  ok((await raw()).status === 200, '第 2 次下载');
  ok((await raw()).status === 410, '第 3 次 410');
  const page = await fetch(sh.url, { headers: { Accept: 'text/html' } });
  ok(page.status === 410 && (await page.text()).includes('下载次数已用完'), '浏览器打开显示 "下载次数已用完"');
  let row = (await j('GET', '/api/v1/shares')).body.items.find((s) => s.id === sh.id);
  ok(row.max_downloads === 2 && row.downloads === 2, '分享列表带 max_downloads / downloads');
  row = (await j('PATCH', `/api/v1/shares/${sh.id}`, { resetDownloads: true, maxDownloads: 3 })).body.share;
  ok(row.downloads === 0 && row.max_downloads === 3 && (await raw()).status === 200, '清零并改上限后又能下载');
  row = (await j('PATCH', `/api/v1/shares/${sh.id}`, { maxDownloads: null })).body.share;
  for (let i = 0; i < 4; i++) await raw();
  ok((await j('GET', '/api/v1/shares')).body.items.find((s) => s.id === sh.id).downloads === 1, '去掉上限后不再计数');
  ok((await j('POST', '/api/v1/shares', { id: f.id, maxDownloads: 1.5 })).status === 400, '非整数上限 400');
  const plain = (await j('POST', '/api/v1/shares', { id: f.id })).body;
  const r2 = await fetch(`${plain.url}?raw=1`);
  if (r2.headers.get('X-D1-Rows')) meter.push(['分享下载 (未设上限)', r2.headers.get('X-D1-Rows')]);
  ok(r2.status === 200, '未设上限的分享照常');
}

if (sect('stars')) {
  const D = `${P}/stars`;
  const a = await put(D, 'a.txt', 'a');
  const d = (await j('POST', '/api/v1/fs/mkdir', { path: `${D}/sub` })).body.node;
  let r = await j('POST', '/api/v1/fs/star', { id: a.id, on: true }, {}, 'fs/star 加星');
  ok(r.status === 200 && r.body.starred, '加星');
  await j('POST', '/api/v1/fs/star', { path: `${D}/sub`, on: true });
  await j('POST', '/api/v1/fs/star', { id: a.id, on: true });
  r = await j('GET', '/api/v1/fs/stars', undefined, {}, 'fs/stars 列表');
  const mine = r.body.items.filter((x) => x.path.startsWith(D));
  ok(mine.length === 2 && mine[0].id === d.id && mine[1].path === `${D}/a.txt` && mine[0].starredAt > 0, '收藏列表: 最新在前, 带路径, 重复加星不重复');
  // 受限令牌各自收藏, 看不到管理员的
  const t = (await j('POST', '/api/v1/admin/tokens', { name: 'e2e22-star', scopes: ['read'], rootPath: D })).body.token;
  const T = { Authorization: `Bearer ${t}` };
  ok((await j('GET', '/api/v1/fs/stars', undefined, T)).body.items.length === 0, '别的令牌看不到我的收藏');
  ok((await j('POST', '/api/v1/fs/star', { path: '/a.txt', on: true }, T)).status === 200 && (await j('GET', '/api/v1/fs/stars', undefined, T)).body.items.length === 1, '受限令牌收藏自己根下的文件');
  // 删除后不列, 取消收藏
  await j('POST', '/api/v1/fs/delete', { id: d.id });
  ok(!(await j('GET', '/api/v1/fs/stars')).body.items.some((x) => x.id === d.id), '删除的不再列出');
  await j('POST', '/api/v1/fs/star', { id: a.id, on: false });
  ok(!(await j('GET', '/api/v1/fs/stars')).body.items.some((x) => x.id === a.id), '取消收藏');
}

if (sect('random')) {
  // 需要 wrangler dev 带 --var RANDOM_DIR:/e2e-random (DEVARGS='--var RANDOM_DIR:/e2e-random' bash .wrangler/devup.sh)
  const R = '/e2e-random';
  const probe = await fetch(`${BASE}/random?type=url`);
  if (probe.status === 404 && /disabled/.test(await probe.text())) {
    console.log('- random: 没设 RANDOM_DIR, 只验证关闭时 404');
    ok(true, '没设 RANDOM_DIR 时 /random 404');
  } else {
    await put(`${R}/landscape`, 'wide.png', 'L', 'image/png', '&overwrite=1');
    await put(`${R}/portrait`, 'tall.jpg', 'P', 'image/jpeg', '&overwrite=1');
    await put(R, 'note.txt', 'not image', 'text/plain', '&overwrite=1');
    const get = (q, ua = 'Mozilla/5.0 (X11; Linux x86_64)') => fetch(`${BASE}/random?${q}`, { headers: { 'User-Agent': ua }, redirect: 'manual' });
    const pc = await (await get('type=url')).json();
    ok(pc.name === 'wide.png' && pc.orientation === 'landscape', `auto + 桌面 UA 取横屏 (${pc.name})`);
    const ph = await (await get('type=url', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile')).json();
    ok(ph.name === 'tall.jpg' && ph.orientation === 'portrait', `auto + 手机 UA 取竖屏 (${ph.name})`);
    ok((await (await get('type=url&dir=portrait&orientation=landscape')).json()).name === 'tall.jpg', '子目录里没有对应方向时退回全部图片');
    const r = await get('');
    ok(r.status === 302 && /\/f\//.test(r.headers.get('Location')) && r.headers.get('Cache-Control') === 'no-store', 'type=img 302 跳签名直链, no-store');
    const img = await fetch(r.headers.get('Location'));
    ok(img.status === 200 && ['L', 'P'].includes(await img.text()), '跳过去的直链能打开');
    ok((await get('dir=nope')).status === 404 && (await get('dir=../x')).status === 400 && (await get('orientation=x')).status === 400, '不存在的目录 404, .. 和坏参数 400');
    let txt = 0; for (let i = 0; i < 10; i++) if (/note/.test((await (await get('type=url')).json()).name)) txt++;
    ok(txt === 0, '只取图片, 不取其他文件');
  }
}

if (sect('fetch')) {
  const D = `${P}/fetch`;
  // 小文件: 远程地址用本服务自己的直链, 不依赖外网
  const src = await put(`${D}/src`, 'hello.txt', 'hello url');
  const link = (await j('POST', '/api/v1/fs/link', { id: src.id })).body.url;
  let r = await j('POST', '/api/v1/fs/fetch', { url: link, path: D, expiresIn: 3600 }, {}, 'fs/fetch 小文件');
  ok(r.status === 200 && r.body.done && r.body.node.name === 'hello.txt' && r.body.node.expiresAt > Date.now(), `URL 上传小文件一次完成, 文件名取自 URL (${r.body.node?.name})`);
  ok((await (await fetch(r.body.url)).text()) === 'hello url', '内容一致');
  ok((await j('POST', '/api/v1/fs/fetch', { url: 'ftp://x/y', path: D })).status === 400, '非 http(s) 400');
  ok((await j('POST', '/api/v1/fs/fetch', { url: link + 'x', path: D, name: 'bad.txt' })).status === 502, '远程非 2xx 返回 502');
  // 大文件 (4 片 > 一次 3 片): 先分片传一个 4 片的源文件, 再 URL 上传, 走 /uploads/fetch 续拉
  const K = 19922944, size = K * 3 + 12345;
  const buf = new Uint8Array(size); for (let i = 0; i < size; i += 4096) buf[i] = (i / 4096) & 255;
  const init = (await j('POST', '/api/v1/uploads', { path: `${D}/src`, name: 'big.bin', size })).body;
  const rcs = [];
  for (let i = 0; i < init.chunkCount; i++) rcs.push((await (await fetch(`${BASE}/api/v1/uploads/chunk?i=${i}&ticket=${encodeURIComponent(init.ticket)}`, { method: 'PUT', headers: H, body: buf.subarray(i * K, Math.min(size, (i + 1) * K)) })).json()).receipt);
  const big = (await j('POST', '/api/v1/uploads/commit', { ticket: init.ticket, receipts: rcs })).body.node;
  const bigUrl = (await j('POST', '/api/v1/fs/link', { id: big.id })).body.url;
  r = await j('POST', '/api/v1/fs/fetch', { url: bigUrl, path: D, name: 'copy.bin' }, {}, 'fs/fetch 大文件第 1 段 (3 片)');
  ok(r.status === 200 && r.body.done === false && r.body.receipts.length === 3 && r.body.next === 3 && r.body.chunkCount === 4, `大文件先写 3 片并返回票据 (${JSON.stringify({ s: r.status, n: r.body.next, e: r.body.error })})`);
  const m = await j('POST', '/api/v1/uploads/fetch', { ticket: r.body.ticket, url: bigUrl, from: r.body.next }, {}, 'uploads/fetch 续拉 1 片');
  ok(m.status === 200 && m.body.receipts.length === 1 && m.body.next === null, '续拉剩下的 1 片');
  const cm = await j('POST', '/api/v1/uploads/commit', { ticket: r.body.ticket, receipts: [...r.body.receipts, ...m.body.receipts] });
  ok(cm.status === 200 && cm.body.node.size === size, 'commit 后大小一致');
  const got = new Uint8Array(await (await fetch(cm.body.url)).arrayBuffer());
  ok(got.length === size && got.every((v, i) => v === buf[i]), '大文件内容逐字节一致');
}

console.log(`\n${pass} 项通过`);
if (meter.length) { console.log('\nD1 实测 (查询 / 行读 / 行写):'); for (const [l, m] of meter) console.log(`  ${l}: ${m}`); }
