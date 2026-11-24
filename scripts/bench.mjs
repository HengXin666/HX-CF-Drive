// 线上轻量实测: 每类操作独占一个整分钟, 便于按分钟从 CF GraphQL 取 CPU 和 D1 行数
// 在自己机器上跑 (CF 会对 GitHub Actions 机房 IP 的 node 请求弹人机验证):
// BASE=https://... ADMIN=... node scripts/bench.mjs > bench-client.json, 再用 Bench 工作流取 CF 统计
// 总量约 250 次请求, 上传约 90MB 到 TG, 不到 Free 日额度的 1%
import crypto from 'node:crypto';

const BASE = process.env.BASE;
const H = { Authorization: `Bearer ${process.env.ADMIN}`, 'User-Agent': 'hxd/1' };
const P = `/bench-${Date.now()}`;
const phases = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

let retries = 0;
// TG 限流 (单频道约 20 条/分) 时服务端回 429, 客户端退避重试
async function call(method, path, body, headers = {}) {
  for (let k = 0; ; k++) {
    try { return await call1(method, path, body, headers); } catch (e) {
      if (!String(e.message).includes(' 429 ') || k >= 6) throw e;
      retries++;
      await sleep(5000 * (k + 1));
    }
  }
}
async function call1(method, path, body, headers = {}) {
  const isJson = body && !(body instanceof Uint8Array) && !(body instanceof FormData);
  const t = performance.now();
  const r = await fetch(BASE + path, {
    method,
    headers: { ...H, ...(isJson ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: isJson ? JSON.stringify(body) : body,
  });
  const buf = Buffer.from(await r.arrayBuffer());
  const ms = performance.now() - t;
  if (r.status >= 400) throw new Error(`${method} ${path} ${r.status} ${buf.toString().slice(0, 200)}`);
  let json;
  try { json = JSON.parse(buf.toString()); } catch {}
  return { ms, bytes: buf.length, json };
}

// 等到下一个整分钟再开始, 每阶段独占一分钟
async function phase(key, label, n, fn) {
  const now = Date.now();
  await sleep(60000 - (now % 60000) + 500);
  const start = new Date(Date.now() - 500).toISOString();
  const ms = [];
  let bytes = 0;
  for (let i = 0; i < n; i++) {
    const r = await fn(i);
    for (const x of [r].flat()) { ms.push(x.ms); bytes += x.bytes ?? 0; }
  }
  ms.sort((a, b) => a - b);
  const q = (p) => Math.round(ms[Math.min(ms.length - 1, Math.floor(p * ms.length))]);
  phases.push({ key, label, minute: start.slice(0, 16) + ':00Z', requests: ms.length, p50: q(0.5), p90: q(0.9), bytes });
  console.error(`${label}: ${ms.length} req, p50 ${q(0.5)}ms`);
}

// 准备: 一个 50 项目录 + 一个 40MB 文件 + 一张 300KB 图片 (不计入阶段)
// 空文件共用 'empty' blob, 不占 TG 消息
for (let i = 0; i < 50; i++) await call('POST', '/api/v1/uploads', { path: `${P}/many`, name: `f${i}.txt`, size: 0 });
const img = crypto.randomBytes(300 * 1024);

await phase('stat', '按路径 stat', 30, () => call('GET', `/api/v1/fs/stat?path=${P}/many/f1.txt`));
await phase('list', '列目录 (50 项)', 30, () => call('GET', `/api/v1/fs/list?path=${P}/many`));
await phase('upload_small', '一次性上传 300KB', 10, (i) => {
  const fd = new FormData();
  fd.append('file', new Blob([crypto.randomBytes(300 * 1024)], { type: 'image/png' }), `a${i}.png`);
  return call('POST', `/api/v1/upload?path=${P}/img`, fd);
});
let big;
await phase('upload_chunk', '分片上传 40MB (init+3 片+commit)', 2, async (k) => {
  const data = crypto.randomBytes(40 * 1024 * 1024);
  const out = [];
  const init = await call('POST', '/api/v1/uploads', { path: `${P}/files`, name: `big${k}.bin`, size: data.length, sha256: sha(data) });
  out.push(init);
  const { ticket, chunkSize, chunkCount } = init.json;
  const receipts = [];
  for (let i = 0; i < chunkCount; i++) {
    const r = await call('PUT', `/api/v1/uploads/chunk?i=${i}&ticket=${encodeURIComponent(ticket)}`, data.subarray(i * chunkSize, (i + 1) * chunkSize));
    receipts.push(r.json.receipt);
    out.push(r);
  }
  const done = await call('POST', '/api/v1/uploads/commit', { ticket, receipts });
  out.push(done);
  big = done.json.node.id;
  return out;
});
await phase('download', '完整下载 40MB', 4, () => call('GET', `/api/v1/files/${big}/content`));
await phase('range', 'Range 读 1KB', 30, () => call('GET', `/api/v1/files/${big}/content`, null, { Range: 'bytes=0-1023' }));
const fd = new FormData();
fd.append('file', new Blob([img], { type: 'image/png' }), 'link.png');
const link = new URL((await call('POST', `/api/v1/upload?path=${P}/img`, fd)).json.url);
await phase('link', '签名直链 /f 300KB', 30, () => call('GET', link.pathname + link.search, null, { Authorization: '' }));
await phase('search', '模糊搜索', 5, () => call('GET', '/api/v1/fs/search?q=f1'));

// 清理: 移进回收站, 每日维护会回收
await call('POST', '/api/v1/fs/delete', { path: P });
console.log(JSON.stringify({ base: BASE, prefix: P, retries, phases }, null, 2));
