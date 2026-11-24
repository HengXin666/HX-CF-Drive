#!/usr/bin/env node
// HX-CF-Drive 命令行: 无依赖, Node 18+。环境变量 HXD_BASE, HXD_TOKEN
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename } from 'node:path';

const BASE = (process.env.HXD_BASE ?? '').replace(/\/$/, '');
const TOKEN = process.env.HXD_TOKEN ?? '';
const H = { Authorization: `Bearer ${TOKEN}` };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 带 429/503 退避的请求
async function req(method, path, body, raw) {
  for (let tries = 0; ; tries++) {
    const r = await fetch(BASE + path, {
      method,
      headers: raw ? H : { ...H, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
      duplex: raw ? 'half' : undefined,
    });
    if ((r.status === 429 || r.status === 503) && tries < 8) {
      await sleep(Number(r.headers.get('Retry-After') || 2 ** tries) * 1000);
      continue;
    }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`${r.status} ${j.error ?? ''}`);
    return j;
  }
}

async function sha256(file) {
  const h = createHash('sha256');
  for await (const c of createReadStream(file)) h.update(c);
  return h.digest('hex');
}

async function put(file, dir = '/') {
  const size = statSync(file).size;
  const init = await req('POST', '/api/v1/uploads', { path: dir, name: basename(file), size, sha256: size ? await sha256(file) : undefined });
  if (init.done) return { ...init, instant: true };
  const fh = await open(file, 'r');
  const receipts = new Array(init.chunkCount);
  const todo = [...Array(init.chunkCount).keys()];
  const worker = async () => {
    for (let i = todo.shift(); i !== undefined; i = todo.shift()) {
      const len = Math.min(init.chunkSize, size - i * init.chunkSize);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, i * init.chunkSize);
      receipts[i] = (await req('PUT', `/api/v1/uploads/chunk?i=${i}&ticket=${encodeURIComponent(init.ticket)}`, undefined, buf)).receipt;
      process.stderr.write(`chunk ${i + 1}/${init.chunkCount}\n`);
    }
  };
  await Promise.all([worker(), worker()]);
  await fh.close();
  return req('POST', '/api/v1/uploads/commit', { ticket: init.ticket, receipts });
}

async function get(path, out) {
  const { node } = await req('GET', `/api/v1/fs/stat?path=${encodeURIComponent(path)}`);
  const ws = createWriteStream(out ?? node.name);
  let pos = 0;
  while (pos < node.size) {
    const r = await fetch(`${BASE}/api/v1/files/${node.id}/content`, { headers: { ...H, Range: `bytes=${pos}-` } });
    if (r.status !== 200 && r.status !== 206) throw new Error(`download ${r.status}`);
    const m = /bytes (\d+)-(\d+)\//.exec(r.headers.get('Content-Range') ?? '');
    for await (const c of r.body) ws.write(c);
    pos = m ? Number(m[2]) + 1 : node.size;
  }
  await new Promise((r) => ws.end(r));
  return { saved: out ?? node.name, size: node.size };
}

const [cmd, a, b, c] = process.argv.slice(2);
const enc = encodeURIComponent;
const run = {
  ls: () => req('GET', `/api/v1/fs/list?path=${enc(a ?? '/')}`),
  stat: () => req('GET', `/api/v1/fs/stat?path=${enc(a)}`),
  mkdir: () => req('POST', '/api/v1/fs/mkdir', { path: a }),
  mv: () => req('POST', '/api/v1/fs/move', { path: a, toPath: b, name: c }),
  rm: () => req('POST', '/api/v1/fs/delete', { path: a }),
  search: () => req('GET', `/api/v1/fs/search?q=${enc(a)}`),
  link: () => req('POST', '/api/v1/fs/link', { path: a, expiresIn: Number(b ?? 0) }),
  share: () => req('POST', '/api/v1/shares', { path: a, password: b || undefined, expiresIn: c ? Number(c) * 86400 : undefined }),
  put: () => put(a, b),
  get: () => get(a, b),
};

if (!BASE || !TOKEN || !run[cmd]) {
  console.error('用法: HXD_BASE=... HXD_TOKEN=... node hxd.mjs <ls|stat|mkdir|mv|rm|search|link|share|put|get> ...');
  process.exit(2);
}
run[cmd]().then((r) => console.log(JSON.stringify(r, null, 2)), (e) => { console.error(e.message); process.exit(1); });
