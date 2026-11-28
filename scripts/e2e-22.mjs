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

console.log(`\n${pass} 项通过`);
if (meter.length) { console.log('\nD1 实测 (查询 / 行读 / 行写):'); for (const [l, m] of meter) console.log(`  ${l}: ${m}`); }
