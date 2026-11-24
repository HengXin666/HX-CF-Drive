// 端到端冒烟: BASE=http://127.0.0.1:8787 ADMIN=test-admin CHANNEL=-1001234567890 node scripts/e2e.mjs
// 本地配合 scripts/mock-tg.mjs 使用; 线上会真实往频道发消息, 请用测试频道
import crypto from 'node:crypto';

const BASE = process.env.BASE ?? 'http://127.0.0.1:8787';
const ADMIN = process.env.ADMIN ?? 'test-admin';
const CHANNEL = process.env.CHANNEL ?? '-1001234567890';
const H = { Authorization: `Bearer ${ADMIN}` };
let pass = 0;
const RUN = Date.now();
const P = `/e2e-${RUN}`; // 每次运行独立目录
const ok = (cond, msg) => { if (!cond) { console.error('✗', msg); process.exit(1); } pass++; console.log('✓', msg); };
const j = async (method, path, body, headers = {}) => {
  const r = await fetch(BASE + path, { method, headers: { ...H, 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body): undefined });
  const t = await r.text();
  try { return { status: r.status, body: JSON.parse(t) }; } catch { return { status: r.status, body: t }; }
};
const rand = (n) => crypto.randomBytes(n);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

// 无状态分片上传: init → chunk (拿回执) → commit
async function chunkUpload(path, name, buf, mime, extra = {}) {
  const init = await j('POST', '/api/v1/uploads', { path, name, size: buf.length, mime, sha256: sha(buf), ...extra });
  if (init.status !== 200) throw new Error(`init ${init.status} ${JSON.stringify(init.body)}`);
  if (init.body.done) return init.body;
  const { ticket, chunkSize, chunkCount } = init.body;
  const receipts = [];
  for (let i = 0; i < chunkCount; i++) {
    for (;;) {
      const r = await fetch(`${BASE}/api/v1/uploads/chunk?i=${i}&ticket=${encodeURIComponent(ticket)}`, { method: 'PUT', headers: H, body: buf.subarray(i * chunkSize, (i + 1) * chunkSize) });
      if (r.status === 429) { await new Promise((s) => setTimeout(s, Number(r.headers.get('Retry-After') ?? 2) * 1000)); continue; }
      if (!r.ok) throw new Error(`chunk ${i}: ${r.status} ${await r.text()}`);
      receipts.push((await r.json()).receipt);
      break;
    }
  }
  const bad = await j('POST', '/api/v1/uploads/commit', { ticket, receipts: receipts.slice(1) });
  if (chunkCount > 1 && bad.status !== 400) throw new Error('缺分片时 commit 应该失败');
  const done = await j('POST', '/api/v1/uploads/commit', { ticket, receipts });
  return { ...done.body, chunkCount };
}

const health = await j('GET', '/api/health');
ok(health.body.ok, 'health');
ok((await fetch(BASE + '/api/v1/fs/list')).status === 401, '无令牌 401');

await j('POST', '/api/v1/admin/maintenance');
const ch = await j('POST', '/api/v1/admin/channels', { id: CHANNEL });
ok(ch.status === 200, `添加频道 ${JSON.stringify(ch.body.bots)}`);

// 小图: 走 TG, 一次性上传接口
const img = rand(300 * 1024);
const fd = new FormData();
fd.append('file', new Blob([img], { type: 'image/png' }), 'a.png');
const up = await (await fetch(`${BASE}/api/v1/upload?path=${P}/img`, { method: 'POST', headers: H, body: fd })).json();
ok(up.success && up.url.includes('/f/'), '图床式上传返回签名直链');
const got = Buffer.from(await (await fetch(up.url)).arrayBuffer());
ok(got.equals(img), '签名直链内容一致');
ok((await fetch(up.url.replace(/s=[^&]+/, 's=bad'))).status === 403, '篡改签名 403');

// 40MB 普通文件: 19MiB 分片, 3 片 + Range
const big = rand(40 * 1024 * 1024);
const r1 = await chunkUpload(`${P}/files`, 'big.bin', big, 'application/octet-stream');
ok(r1.chunkCount === 3 && r1.node.size === big.length, 'TG 分片上传 40MB (3 片, 缺片 commit 被拒)');
const id = r1.node.id;
const part = await fetch(`${BASE}/api/v1/files/${id}/content`, { headers: { ...H, Range: 'bytes=19922900-19923000' } });
const pb = Buffer.from(await part.arrayBuffer());
ok(part.status === 206 && pb.equals(big.subarray(19922900, 19923001)), '跨分片 Range 正确');
const full = Buffer.from(await (await fetch(`${BASE}/api/v1/files/${id}/content`, { headers: H })).arrayBuffer());
ok(full.equals(big), '完整下载一致');

// 秒传
const r2 = await chunkUpload(`${P}/files`, 'big-copy.bin', big, 'application/octet-stream');
ok(r2.done === true, '同哈希秒传');

// 视频: 同样走 TG, 后缀 Range
const vid = rand(20 * 1024 * 1024);
const r3 = await chunkUpload(`${P}/video`, 'v.mp4', vid, 'video/mp4');
const vr = await fetch(`${BASE}/api/v1/files/${r3.node.id}/content`, { headers: { ...H, Range: 'bytes=-100' } });
ok(Buffer.from(await vr.arrayBuffer()).equals(vid.subarray(-100)), '视频后缀 Range 正确');

// 篡改回执
const t2 = await j('POST', '/api/v1/uploads', { path: `${P}/files`, name: 'x.bin', size: 10 });
ok((await j('POST', '/api/v1/uploads/commit', { ticket: t2.body.ticket, receipts: ['abc.def'] })).status === 400, '伪造回执被拒');

// 目录, 移动, 搜索, 回收站
const ls = await j('GET', `/api/v1/fs/list?path=${P}/files`);
ok(ls.body.children.length === 2, '列目录');
await j('POST', '/api/v1/fs/move', { path: `${P}/files/big-copy.bin`, toPath: `${P}/img`, name: `mv${RUN}.bin` });
ok((await j('GET', `/api/v1/fs/stat?path=${P}/img/mv${RUN}.bin`)).status === 200, '移动+重命名');
ok((await j('GET', `/api/v1/fs/search?q=mv${RUN}`)).body.items.length === 1, '搜索');
await j('POST', '/api/v1/fs/delete', { path: `${P}/img` });
ok((await j('GET', `/api/v1/fs/stat?path=${P}/img/a.png`)).status === 404, '删除目录');
const trash = await j('GET', '/api/v1/fs/trash');
await j('POST', '/api/v1/fs/restore', { id: trash.body.items[0].id });
ok((await j('GET', `/api/v1/fs/stat?path=${P}/img/a.png`)).status === 200, '回收站恢复 (含子项) ');

// 删除目录只标记顶层: 子项按 ID 不可见, 搜索不到, 恢复后回来
const sub = await chunkUpload(`${P}/del/a/b`, `deep${RUN}.bin`, rand(1000), 'application/octet-stream');
await j('POST', '/api/v1/fs/delete', { path: `${P}/del` });
ok((await fetch(`${BASE}/api/v1/files/${sub.node.id}/content`, { headers: H })).status === 404, '已删目录下的文件按 ID 404');
ok((await j('GET', `/api/v1/fs/search?q=deep${RUN}`)).body.items.length === 0, '已删目录下的文件搜不到');
const tr2 = (await j('GET', '/api/v1/fs/trash')).body.items.find((x) => x.name === 'del');
await j('POST', '/api/v1/fs/restore', { id: tr2.id });
ok((await fetch(`${BASE}/api/v1/files/${sub.node.id}/content`, { headers: H })).status === 200, '恢复目录后子项回来');

// 空文件
const em = await j('POST', '/api/v1/uploads', { path: `${P}/empty`, name: 'e.txt', size: 0 });
ok(em.body.done === true, '空文件直接完成');
const er = await fetch(`${BASE}/api/v1/files/${em.body.node.id}/content`, { headers: H });
ok(er.status === 200 && (await er.arrayBuffer()).byteLength === 0, '空文件读取');

// WebDAV
const dav = (m, p, body, h = {}) => fetch(BASE + '/dav' + p, { method: m, headers: { Authorization: 'Basic ' + Buffer.from('u:' + ADMIN).toString('base64'), ...h }, body });
ok((await dav('MKCOL', `${P}-dav`)).status === 201, 'WebDAV MKCOL');
const txt = Buffer.from('hello webdav 你好');
ok((await dav('PUT', `${P}-dav/x.txt`, txt, { 'Content-Length': String(txt.length) })).status === 201, 'WebDAV PUT');
ok((await dav('PUT', `${P}-dav/zero.txt`, Buffer.alloc(0), { 'Content-Length': '0' })).status === 201, 'WebDAV PUT 空文件');
const pf = await (await dav('PROPFIND', `${P}-dav`, null, { Depth: '1' })).text();
ok(pf.includes('x.txt'), 'WebDAV PROPFIND');
ok((await dav('MOVE', `${P}-dav/x.txt`, null, { Destination: BASE + `/dav${P}-dav/y.txt` })).status === 201, 'WebDAV MOVE');
ok(Buffer.from(await (await dav('GET', `${P}-dav/y.txt`)).arrayBuffer()).equals(txt), 'WebDAV GET');

// 受限令牌
const tk = await j('POST', '/api/v1/admin/tokens', { name: 'picgo', scopes: ['read', 'write'], rootPath: `${P}-picgo` });
const lim = await fetch(BASE + '/api/v1/fs/list?path=/', { headers: { Authorization: `Bearer ${tk.body.token}` } });
const limBody = await lim.json();
ok(lim.status === 200 && limBody.children.length === 0, '受限令牌只看到自己的根');
ok((await fetch(BASE + `/api/v1/files/${id}/content`, { headers: { Authorization: `Bearer ${tk.body.token}` } })).status === 403, '受限令牌越权 403');
ok((await fetch(BASE + '/api/v1/admin/stats', { headers: { Authorization: `Bearer ${tk.body.token}` } })).status === 403, '非管理员不能进后台');

// 分享
const sh = await j('POST', '/api/v1/shares', { path: `${P}/video/v.mp4`, password: 'pw' });
ok((await fetch(sh.body.url)).status === 401, '分享需要密码');
ok(Buffer.from(await (await fetch(sh.body.url + '?p=pw')).arrayBuffer()).equals(vid), '分享下载');

const stats = await j('GET', '/api/v1/admin/stats');
console.log('stats', JSON.stringify(stats.body.blobs));
console.log(`\n全部通过: ${pass} 项`);
