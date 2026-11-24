// 本地实测每个操作的 D1 行读写: .dev.vars 加 D1_METER=1, 配合 mock-tg, 然后
// BASE=http://127.0.0.1:8787 node scripts/meter.mjs [目录下预置文件数, 默认 200]
import crypto from 'node:crypto';

const BASE = process.env.BASE ?? 'http://127.0.0.1:8787';
const H = { Authorization: `Bearer ${process.env.ADMIN ?? 'test-admin'}` };
const CHANNEL = process.env.CHANNEL ?? '-1001234567890';
const FILL = Number(process.argv[2] ?? 200);
const P = `/meter-${Date.now()}`;
const rows = [];

async function call(label, method, path, body, headers = {}) {
  const isJson = body && !(body instanceof Uint8Array) && !(body instanceof FormData);
  const r = await fetch(BASE + path, {
    method,
    headers: { ...H, ...(isJson ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: isJson ? JSON.stringify(body) : body,
  });
  const buf = Buffer.from(await r.arrayBuffer());
  const m = r.headers.get('X-D1-Rows');
  if (!m) throw new Error('没有 X-D1-Rows 头, 确认 .dev.vars 里 D1_METER=1');
  if (label) rows.push([label, r.status, ...m.split(' ').map((x) => Number(x.split('=')[1]))]);
  try { return { status: r.status, body: JSON.parse(buf.toString()), buf }; } catch { return { status: r.status, buf }; }
}
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

await call(null, 'POST', '/api/v1/admin/maintenance');
await call(null, 'POST', '/api/v1/admin/channels', { id: CHANNEL });

// 预置 FILL 个小文件, 让列目录和搜索有真实规模
const fill = Buffer.from('x');
for (let i = 0; i < FILL; i++) {
  const t = await call(null, 'POST', '/api/v1/uploads', { path: `${P}/many`, name: `f${i}.txt`, size: 1 });
  const c = await call(null, 'PUT', `/api/v1/uploads/chunk?i=0&ticket=${encodeURIComponent(t.body.ticket)}`, fill);
  await call(null, 'POST', '/api/v1/uploads/commit', { ticket: t.body.ticket, receipts: [c.body.receipt] });
}

// 40MB 三片上传
const big = crypto.randomBytes(40 * 1024 * 1024);
const init = await call('上传 init (新文件)', 'POST', '/api/v1/uploads', { path: `${P}/files`, name: 'big.bin', size: big.length, sha256: sha(big) });
const { ticket, chunkSize, chunkCount } = init.body;
const receipts = [];
for (let i = 0; i < chunkCount; i++) {
  const r = await call(i === 0 ? '上传 chunk (每片)' : null, 'PUT', `/api/v1/uploads/chunk?i=${i}&ticket=${encodeURIComponent(ticket)}`, big.subarray(i * chunkSize, (i + 1) * chunkSize));
  receipts.push(r.body.receipt);
}
const done = await call('上传 commit (3 片)', 'POST', '/api/v1/uploads/commit', { ticket, receipts });
const id = done.body.node.id;
await call('秒传 init (哈希命中)', 'POST', '/api/v1/uploads', { path: `${P}/files`, name: 'dup.bin', size: big.length, sha256: sha(big) });

const fd = new FormData();
fd.append('file', new Blob([crypto.randomBytes(300 * 1024)], { type: 'image/png' }), 'a.png');
const img = await call('图床一次性上传 300KB', 'POST', `/api/v1/upload?path=${P}/img`, fd);

await call('按 ID 读 40MB (首次)', 'GET', `/api/v1/files/${id}/content`);
await call('按 ID 读 40MB (isolate 已缓存)', 'GET', `/api/v1/files/${id}/content`);
await call('Range 读 1KB', 'GET', `/api/v1/files/${id}/content`, null, { Range: 'bytes=0-1023' });
await call('签名直链 /f (首次)', 'GET', new URL(img.body.url).pathname + new URL(img.body.url).search);
await call('签名直链 /f (已缓存)', 'GET', new URL(img.body.url).pathname + new URL(img.body.url).search);
await call('按路径 stat (3 层)', 'GET', `/api/v1/fs/stat?path=${P}/files/big.bin`);
await call(`列目录 (${FILL} 项)`, 'GET', `/api/v1/fs/list?path=${P}/many`);
await call('模糊搜索 (全表)', 'GET', '/api/v1/fs/search?q=f1');
await call('重命名', 'POST', '/api/v1/fs/move', { path: `${P}/files/dup.bin`, name: 'dup2.bin' });
await call('删除单文件 (进回收站)', 'POST', '/api/v1/fs/delete', { path: `${P}/files/dup2.bin` });
await call(`删除目录 (${FILL} 项)`, 'POST', '/api/v1/fs/delete', { path: `${P}/many` });
await call('WebDAV PROPFIND Depth 1', 'PROPFIND', `/dav${P}/files`, null, { Depth: '1', Authorization: 'Basic ' + Buffer.from('u:' + H.Authorization.slice(7)).toString('base64') });
await call('后台 stats', 'GET', '/api/v1/admin/stats');

const total = await call(null, 'GET', '/api/v1/admin/stats');
console.log(`\n| 操作 | HTTP | 查询 | 行读 | 行写 |\n|---|---|---|---|---|`);
for (const [l, s, q, r, w] of rows) console.log(`| ${l} | ${s} | ${q} | ${r} | ${w} |`);
console.log(`\n库内 nodes 约 ${JSON.stringify(total.body.nodes ?? total.body)} (影响全表扫描的行读)`);
