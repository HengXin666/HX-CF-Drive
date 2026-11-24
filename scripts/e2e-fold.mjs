// 分段清单与分批提交 (#12) 的端到端测试。需要很小的分片, 只在本地跑:
//   node scripts/mock-tg.mjs & npx wrangler dev --var CHUNK_SIZE:4096 --var TG_API_BASE:http://127.0.0.1:8887
//   BASE=http://127.0.0.1:8787 node scripts/e2e-fold.mjs
import crypto from 'node:crypto';

const BASE = process.env.BASE ?? 'http://127.0.0.1:8787';
const ADMIN = process.env.ADMIN ?? 'test-admin';
const CHANNEL = process.env.CHANNEL ?? '-1001234567890';
const H = { Authorization: `Bearer ${ADMIN}` };
// 模拟 TG 的测试辅助接口, 线上跑时不可用, 相关断言自动跳过
const MOCK = process.env.MOCK ?? 'http://127.0.0.1:8887';
const mockMsgs = async () => { try { return (await (await fetch(`${MOCK}/__mock/messages?chat=${CHANNEL}`)).json()).result; } catch { return null; } };
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

await j('POST', '/api/v1/admin/maintenance');
await j('POST', '/api/v1/admin/channels', { id: CHANNEL });
const init = await j('POST', '/api/v1/uploads', { path: `${P}/fold`, name: 'probe.bin', size: 1 });
const cs = init.body.chunkSize;
if (!cs || cs > 64 * 1024) { console.log('需要 CHUNK_SIZE ≤ 64KB, 跳过'); process.exit(0); }

const n = 600; // 3 段: 256 + 256 + 88
const fb = rand(cs * (n - 1) + 123);
const fi = await j('POST', '/api/v1/uploads', { path: `${P}/fold`, name: 'big.bin', size: fb.length, mime: 'application/octet-stream', overwrite: true });
const { ticket, chunkCount } = fi.body;
const rcs = [];
const folds = [];
for (let i = 0; i < chunkCount; i++) {
  for (;;) {
    const r = await fetch(`${BASE}/api/v1/uploads/chunk?i=${i}&ticket=${encodeURIComponent(ticket)}`, { method: 'PUT', headers: H, body: fb.subarray(i * cs, (i + 1) * cs) });
    if (r.status === 429) { await new Promise((s) => setTimeout(s, 200)); continue; }
    if (!r.ok) throw new Error(`chunk ${i}: ${r.status}`);
    rcs[i] = (await r.json()).receipt;
    break;
  }
}
const bad = await j('POST', '/api/v1/uploads/fold', { ticket, receipts: rcs.slice(250, 260) });
ok(bad.status === 400, '跨组的 fold 被拒');
for (let g = 0; g < 2; g++) {
  const f = await j('POST', '/api/v1/uploads/fold', { ticket, receipts: rcs.slice(g * 256, g * 256 + 256) });
  ok(f.status === 200 && f.body.fold, `fold 第 ${g} 组`);
  folds.push(f.body.fold);
}
const miss = await j('POST', '/api/v1/uploads/commit', { ticket, folds, receipts: rcs.slice(512, 590) });
ok(miss.status === 400, '分段提交缺片被拒');
const cm = await j('POST', '/api/v1/uploads/commit', { ticket, folds, receipts: rcs.slice(512) });
ok(cm.status === 200 && cm.body.node.size === fb.length, `分段提交 ${chunkCount} 片`);
const fid = cm.body.node.id;
const a = 256 * cs - 10, b = 256 * cs + 10;
const rr = await fetch(`${BASE}/api/v1/files/${fid}/content`, { headers: { ...H, Range: `bytes=${a}-${b}` } });
ok(Buffer.from(await rr.arrayBuffer()).equals(fb.subarray(a, b + 1)), '跨段 Range 正确');
// 整个文件按 Content-Range 续拉
const parts = [];
for (let pos = 0; pos < fb.length;) {
  const r = await fetch(`${BASE}/api/v1/files/${fid}/content`, { headers: { ...H, Range: `bytes=${pos}-` } });
  const end = Number(/bytes \d+-(\d+)\//.exec(r.headers.get('Content-Range'))[1]);
  parts.push(Buffer.from(await r.arrayBuffer()));
  pos = end + 1;
}
ok(Buffer.concat(parts).equals(fb), '分段文件续拉下载一致');
const m0 = await mockMsgs();
await j('POST', '/api/v1/fs/delete', { id: fid });
let pr2 = await j('POST', '/api/v1/fs/purge', { id: fid });
for (let k = 0; k < 20 && pr2.body.more; k++) pr2 = await j('POST', '/api/v1/admin/maintenance?sweep=0');
ok(pr2.status === 200 && pr2.body.leftBlobs === 0, `分段文件彻底删除 ${JSON.stringify(pr2.body)}`);
if (m0) ok((await mockMsgs()).length <= m0.length - chunkCount, '分段文件的 TG 消息全部删除');

console.log(`\n全部通过: ${pass} 项`);
