// HX-CF-Drive 浏览器客户端: 本地算 sha256 (秒传), 无状态分片上传 (断点续传), 大文件分段下载拼接。
// 只依赖浏览器标准 API, 可以单独拷到别的前端里用。

// ---------- sha256 ----------
// ≤256MB 用 crypto.subtle 一次算完 (最快); 更大的文件分块喂给下面的增量实现, 内存占用恒定。
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

class Sha256 {
  constructor() {
    this.h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    this.w = new Uint32Array(64);
    this.buf = new Uint8Array(64);
    this.fill = 0;
    this.len = 0;
  }
  block(d, o) {
    const w = this.w, h = this.h;
    for (let i = 0; i < 16; i++) w[i] = (d[o + i * 4] << 24) | (d[o + i * 4 + 1] << 16) | (d[o + i * 4 + 2] << 8) | d[o + i * 4 + 3];
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15], b = w[i - 2];
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let [A, B, C, D, E, F, G, H] = h;
    for (let i = 0; i < 64; i++) {
      const S1 = ((E >>> 6) | (E << 26)) ^ ((E >>> 11) | (E << 21)) ^ ((E >>> 25) | (E << 7));
      const t1 = (H + S1 + ((E & F) ^ (~E & G)) + K[i] + w[i]) | 0;
      const S0 = ((A >>> 2) | (A << 30)) ^ ((A >>> 13) | (A << 19)) ^ ((A >>> 22) | (A << 10));
      const t2 = (S0 + ((A & B) ^ (A & C) ^ (B & C))) | 0;
      H = G; G = F; F = E; E = (D + t1) | 0; D = C; C = B; B = A; A = (t1 + t2) | 0;
    }
    h[0] += A; h[1] += B; h[2] += C; h[3] += D; h[4] += E; h[5] += F; h[6] += G; h[7] += H;
  }
  update(d) {
    let o = 0;
    this.len += d.length;
    if (this.fill) {
      const n = Math.min(64 - this.fill, d.length);
      this.buf.set(d.subarray(0, n), this.fill);
      this.fill += n; o = n;
      if (this.fill < 64) return;
      this.block(this.buf, 0); this.fill = 0;
    }
    for (; o + 64 <= d.length; o += 64) this.block(d, o);
    if (o < d.length) { this.buf.set(d.subarray(o)); this.fill = d.length - o; }
  }
  hex() {
    const bits = this.len * 8;
    const pad = new Uint8Array(((this.fill < 56 ? 56 : 120) - this.fill) + 8);
    pad[0] = 0x80;
    const dv = new DataView(pad.buffer);
    dv.setUint32(pad.length - 8, Math.floor(bits / 2 ** 32));
    dv.setUint32(pad.length - 4, bits >>> 0);
    this.update(pad);
    return [...this.h].map((x) => (x >>> 0).toString(16).padStart(8, '0')).join('');
  }
}

export async function sha256File(file, onProgress) {
  if (file.size <= 256 * 1024 * 1024) {
    const d = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
    return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  const h = new Sha256();
  const step = 8 * 1024 * 1024;
  for (let o = 0; o < file.size; o += step) {
    h.update(new Uint8Array(await file.slice(o, o + step).arrayBuffer()));
    onProgress?.(Math.min(o + step, file.size) / file.size);
  }
  return h.hex();
}

// ---------- 上传 ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 上传一个文件。进度 (凭证 + 已拿到的回执) 存在 localStorage, 刷新页面后重传同一文件会自动续传。
 * opt: { base, token, path, overwrite, concurrency, onLog }
 */
export async function uploadFile(file, opt) {
  const base = opt.base ?? '';
  const auth = { Authorization: 'Bearer ' + opt.token };
  const log = opt.onLog ?? (() => {});
  const call = async (method, url, body) => {
    const r = await fetch(base + '/api/v1' + url, { method, headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || r.status);
    return j;
  };
  const key = `hxd_up:${opt.path}:${file.name}:${file.size}:${file.lastModified}`;
  let state = JSON.parse(localStorage.getItem(key) || 'null');
  if (!state) {
    log(`${file.name}: 计算 sha256...`);
    const sha256 = await sha256File(file, (p) => log(`${file.name}: sha256 ${(p * 100).toFixed(0)}%`));
    const init = await call('POST', '/uploads', { path: opt.path, name: file.name, size: file.size, mime: file.type || undefined, sha256, overwrite: !!opt.overwrite });
    if (init.done) { log(`${file.name}: 秒传完成`); return init; }
    state = { ticket: init.ticket, chunkSize: init.chunkSize, chunkCount: init.chunkCount, receipts: {} };
    localStorage.setItem(key, JSON.stringify(state));
  }
  const todo = [];
  for (let i = 0; i < state.chunkCount; i++) if (!state.receipts[i]) todo.push(i);
  let done = state.chunkCount - todo.length;
  // 并发数不宜大: TG 单 Bot 单频道约 20 条/分, 服务端遇限流会回 429
  const worker = async () => {
    for (let i = todo.shift(); i !== undefined; i = todo.shift()) {
      const blob = file.slice(i * state.chunkSize, (i + 1) * state.chunkSize);
      for (let tries = 0; ; tries++) {
        const url = `${base}/api/v1/uploads/chunk?i=${i}&ticket=${encodeURIComponent(state.ticket)}`;
        const r = await fetch(url, { method: 'PUT', headers: auth, body: blob }).catch(() => null);
        if (r?.ok) { state.receipts[i] = (await r.json()).receipt; break; }
        const status = r?.status ?? 0;
        if (status === 400 || status === 403 || tries >= 8) throw new Error(`分片 ${i} 失败: ${status} ${r ? await r.text() : ''}`);
        await sleep(Number(r?.headers.get('Retry-After') || 2 ** Math.min(tries, 5)) * 1000);
      }
      localStorage.setItem(key, JSON.stringify(state));
      log(`${file.name}: ${++done}/${state.chunkCount}`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(opt.concurrency ?? 2, state.chunkCount) }, worker));
  const res = await call('POST', '/uploads/commit', { ticket: state.ticket, receipts: Object.values(state.receipts) });
  localStorage.removeItem(key);
  log(`${file.name}: 上传完成`);
  return res;
}

// ---------- 下载 ----------
/**
 * 大文件下载: 服务端单次响应只拼得下有限个分片, 这里按 Content-Range 一段段续拉并写入本地文件。
 * 需要 File System Access API (Chrome/Edge)。不支持时退回浏览器普通下载 (大文件只会拿到前一段)。
 */
export async function downloadLarge(url, name, size, onLog = () => {}) {
  if (!window.showSaveFilePicker) { location.href = url + '&download=1'; return; }
  const handle = await window.showSaveFilePicker({ suggestedName: name });
  const out = await handle.createWritable();
  let pos = 0;
  try {
    while (pos < size) {
      const r = await fetch(url, { headers: { Range: `bytes=${pos}-` } });
      if (r.status !== 206 && r.status !== 200) throw new Error('下载失败 ' + r.status);
      const m = /bytes (\d+)-(\d+)\//.exec(r.headers.get('Content-Range') || '');
      const end = m ? Number(m[2]) : size - 1;
      await r.body.pipeTo(out, { preventClose: true });
      pos = end + 1;
      onLog(`${name}: 已下载 ${(pos / size * 100).toFixed(1)}%`);
    }
    await out.close();
  } catch (e) {
    await out.abort();
    throw e;
  }
}
