// 预置示例数据: 几层目录, 代码生成的图片 (SVG + Canvas), 文本, 提示音, 大文件占位, 回收站, 分享, 后台
import { type DNode, type Meta, now, putData, save, sha256Hex, state } from './db';
import { insert, mkdirp, resolvePath, ROOT, trash } from './tree';

const DAY = 86400_000;

function svgAurora(): string {
  const waves = [0, 1, 2, 3].map((i) => {
    const y = 300 + i * 46;
    return `<path d="M0 ${y} C 240 ${y - 140}, 480 ${y + 120}, 720 ${y - 40} S 1200 ${y - 160}, 1440 ${y - 20} V 900 H 0 Z" fill="url(#g${i % 2})" opacity="${0.55 - i * 0.1}"/>`;
  }).join('');
  const stars = Array.from({ length: 70 }, (_, i) => `<circle cx="${(i * 197) % 1440}" cy="${(i * 89) % 380}" r="${(i % 3) * 0.6 + 0.6}" fill="#e6edf3" opacity="${0.3 + (i % 5) * 0.12}"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="900" viewBox="0 0 1440 900">
<defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0d1321"/><stop offset="1" stop-color="#1d2a3f"/></linearGradient>
<linearGradient id="g0" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#3ee8b5"/><stop offset="1" stop-color="#6c7cff"/></linearGradient>
<linearGradient id="g1" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7c5cff"/><stop offset="1" stop-color="#2ad1e6"/></linearGradient></defs>
<rect width="1440" height="900" fill="url(#bg)"/>${stars}${waves}</svg>`;
}

function svgMountains(): string {
  const layer = (base: number, amp: number, color: string, seed: number) => {
    let d = `M0 ${base}`;
    for (let x = 0; x <= 1600; x += 80) d += ` L${x} ${base - Math.abs(Math.sin((x + seed) / 170) * amp) - ((x * seed) % 37)}`;
    return `<path d="${d} V1000 H0 Z" fill="${color}"/>`;
  };
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000" viewBox="0 0 1600 1000">
<defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ff9a6b"/><stop offset=".55" stop-color="#d4648a"/><stop offset="1" stop-color="#3a2f5b"/></linearGradient></defs>
<rect width="1600" height="1000" fill="url(#sky)"/><circle cx="1120" cy="380" r="110" fill="#ffd9a0" opacity=".9"/>
${layer(560, 180, '#5b3f6e', 13)}${layer(680, 150, '#3f2d55', 29)}${layer(800, 120, '#2a1f3d', 41)}${layer(910, 70, '#1a1428', 7)}</svg>`;
}

function svgShot(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500"><rect width="800" height="500" rx="18" fill="#22272e"/>
<rect x="24" y="24" width="180" height="452" rx="12" fill="#2d333b"/><rect x="224" y="24" width="552" height="60" rx="12" fill="#2d333b"/>
${[0, 1, 2, 3, 4].map((i) => `<rect x="224" y="${104 + i * 72}" width="552" height="56" rx="10" fill="#2d333b" opacity="${1 - i * 0.15}"/>`).join('')}</svg>`;
}

function canvasPng(draw: (g: CanvasRenderingContext2D, w: number, h: number) => void, w = 1200, h = 800): Promise<Blob> {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d')!, w, h);
  return new Promise((ok) => c.toBlob((b) => ok(b ?? new Blob([], { type: 'image/png' })), 'image/png'));
}

// 几何拼贴: 三角网格 + 渐变色
const geometry = (g: CanvasRenderingContext2D, w: number, h: number) => {
  const s = 80;
  for (let y = 0; y < h + s; y += s) {
    for (let x = 0; x < w + s; x += s) {
      const hue = 190 + ((x / w) * 80 + (y / h) * 60);
      for (const up of [true, false]) {
        g.beginPath();
        if (up) { g.moveTo(x, y); g.lineTo(x + s, y); g.lineTo(x, y + s); } else { g.moveTo(x + s, y); g.lineTo(x + s, y + s); g.lineTo(x, y + s); }
        g.closePath();
        g.fillStyle = `hsl(${hue + (up ? 0 : 18)} 55% ${up ? 32 : 24}%)`;
        g.fill();
      }
    }
  }
  g.fillStyle = 'rgba(230,237,243,.92)';
  g.font = '600 64px system-ui, sans-serif';
  g.fillText('HX-CF-Drive', 72, h - 96);
};

// 柱状图: 近 14 天上传量 (虚构数据)
const chart = (g: CanvasRenderingContext2D, w: number, h: number) => {
  g.fillStyle = '#22272e';
  g.fillRect(0, 0, w, h);
  g.fillStyle = '#e6edf3';
  g.font = '600 34px system-ui, sans-serif';
  g.fillText('近 14 天上传量 (GB)', 64, 80);
  const vals = [3.2, 4.1, 2.6, 5.8, 6.3, 4.4, 7.9, 6.1, 5.2, 8.4, 9.1, 7.3, 10.2, 8.8];
  const bw = (w - 160) / vals.length;
  vals.forEach((v, i) => {
    const bh = (v / 11) * (h - 220);
    const grad = g.createLinearGradient(0, h - 80 - bh, 0, h - 80);
    grad.addColorStop(0, '#6c7cff');
    grad.addColorStop(1, '#3ee8b5');
    g.fillStyle = grad;
    g.fillRect(96 + i * bw, h - 80 - bh, bw * 0.62, bh);
  });
  g.strokeStyle = '#444c56';
  g.beginPath(); g.moveTo(80, h - 80); g.lineTo(w - 48, h - 80); g.stroke();
};

// 2 秒和弦, 16 位单声道 PCM WAV
function wav(): Blob {
  const rate = 22050, n = rate * 2;
  const buf = new DataView(new ArrayBuffer(44 + n * 2));
  const str = (o: number, s: string) => [...s].forEach((c, i) => buf.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); buf.setUint32(4, 36 + n * 2, true); str(8, 'WAVEfmt ');
  buf.setUint32(16, 16, true); buf.setUint16(20, 1, true); buf.setUint16(22, 1, true);
  buf.setUint32(24, rate, true); buf.setUint32(28, rate * 2, true); buf.setUint16(32, 2, true); buf.setUint16(34, 16, true);
  str(36, 'data'); buf.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const v = [523.25, 659.25, 783.99].reduce((a, f, k) => a + Math.sin(2 * Math.PI * f * t) * Math.exp(-t * (1.6 + k * 0.4)), 0) / 3;
    buf.setInt16(44 + i * 2, v * 0.6 * 32767, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}

const README = `# HX-CF-Drive 演示

这是纯前端演示站里的示例文件。你看到的一切都由浏览器在本地模拟:

- 目录, 上传, 秒传, 回收站, 分享, 直链都能点
- 数据存在 IndexedDB, 刷新不丢, 顶部横幅可以一键重置
- 不连接任何后端, 也不会碰 Telegram

真实部署时, 文件会被切成 19 MiB 分片存进 Telegram 私有频道, 目录树放在 Cloudflare D1。

## 试试这些

1. 把任意文件拖进文件列表上传
2. 下载这个 README 再原样上传到别的目录, 会看到 "秒传"
3. 在 "文档" 目录上点分享, 设置密码后打开链接
`;

const CHANGELOG = `v0.3  新增纯前端演示站 (GitHub Pages)
v0.2  前端改版: HX-UI 暗色主题, 内置接口文档与 Agent Skill
v0.1  REST API, WebDAV, 分片上传, 签名直链, 分享链接
`;

const API_JSON = JSON.stringify({
  base: 'https://drive.example.com',
  upload: { init: 'POST /api/v1/uploads', chunk: 'PUT /api/v1/uploads/chunk?i=0&ticket=...', commit: 'POST /api/v1/uploads/commit' },
  chunkSize: 19922944,
  scopes: ['read', 'write', 'admin'],
}, null, 2);

const NOTES = `# 存储笔记

- 单个 Bot 每频道约 20 条/分钟, 多 Bot 轮转可以提速
- 相同内容按 sha256 去重, 复制文件不会重复占用空间
- 永久直链可直接嵌入 img 或 video 标签
`;

export async function seed(): Promise<void> {
  const t0 = now();
  const meta: Meta = {
    v: 1,
    nodes: { [ROOT]: { id: ROOT, parentId: null, name: '', kind: 'dir', size: 0, mime: null, blobId: null, createdAt: t0, updatedAt: t0, deletedAt: null } },
    blobs: {}, shares: [], tickets: {},
    bots: [
      { id: '7123456001', username: 'hxdrive_store_a_bot', status: 'active', last_error: null },
      { id: '7123456002', username: 'hxdrive_store_b_bot', status: 'active', last_error: null },
      { id: '7123456003', username: 'hxdrive_store_c_bot', status: 'dead', last_error: 'Forbidden: bot was kicked from the channel chat' },
    ],
    channels: [
      { id: '-1001234567890', title: 'HX Drive 存储 A', status: 'active' },
      { id: '-1009876543210', title: 'HX Drive 存储 B', status: 'readonly' },
    ],
    tokens: [
      { id: 'tok_picgo', name: 'picgo', scopes: 'read,write', root_id: ROOT, expires_at: null, created_at: t0 - 20 * DAY, token: 'hxd_demo_picgo' },
      { id: 'tok_agent', name: 'backup-agent', scopes: 'read', root_id: ROOT, expires_at: t0 + 300 * DAY, created_at: t0 - 6 * DAY, token: 'hxd_demo_agent' },
    ],
  };
  await save(meta);

  const age = (n: DNode, days: number) => { n.createdAt = n.updatedAt = t0 - days * DAY; return n; };
  const file = async (dir: string, name: string, data: Blob | { virtual: number }, mime: string, days: number) => {
    const blob = data instanceof Blob ? data : null;
    const size = blob ? blob.size : (data as { virtual: number }).virtual;
    const id = blob ? await sha256Hex(blob) : await sha256Hex(new TextEncoder().encode(`virtual:${name}`).buffer as ArrayBuffer);
    if (!state().blobs[id]) {
      state().blobs[id] = { id, size, refs: 0, virtual: !blob || undefined };
      if (blob) await putData(id, blob);
    }
    return age(insert({ parentId: mkdirp(dir).id, name, kind: 'file', size, mime, blobId: id }), days);
  };
  const text = (s: string, mime: string) => new Blob([s], { type: mime });

  for (const [d, days] of [['/文档', 21], ['/文档/笔记', 12], ['/图片', 18], ['/图片/2026', 9], ['/音频', 8], ['/软件', 15], ['/备份', 30]] as const) age(mkdirp(d), days);
  await file('/', 'README.md', text(README, 'text/markdown'), 'text/markdown', 1);
  await file('/文档', '更新日志.txt', text(CHANGELOG, 'text/plain'), 'text/plain', 3);
  await file('/文档', '接口示例.json', text(API_JSON, 'application/json'), 'application/json', 5);
  await file('/文档/笔记', '存储笔记.md', text(NOTES, 'text/markdown'), 'text/markdown', 2);
  const hill = await file('/图片', '壁纸-山峦.svg', text(svgMountains(), 'image/svg+xml'), 'image/svg+xml', 7);
  await file('/图片/2026', '极光.svg', text(svgAurora(), 'image/svg+xml'), 'image/svg+xml', 4);
  await file('/图片/2026', '几何拼贴.png', await canvasPng(geometry), 'image/png', 2);
  await file('/图片', '上传量图表.png', await canvasPng(chart, 1200, 700), 'image/png', 1);
  await file('/音频', '提示音.wav', wav(), 'audio/wav', 6);
  await file('/软件', 'ubuntu-24.04-desktop-amd64.iso', { virtual: 6_114_656_256 }, 'application/x-iso9660-image', 15);
  await file('/备份', '相册备份-2025.tar.zst', { virtual: 3_651_272_704 }, 'application/zstd', 30);

  // 回收站: 一个文件, 一个带子项的目录
  await file('/', '旧草稿.txt', text('这份草稿已经删除, 可以在回收站里恢复。\n', 'text/plain'), 'text/plain', 10);
  trash(resolvePath('/旧草稿.txt')!.id);
  await file('/临时', '界面截图.svg', text(svgShot(), 'image/svg+xml'), 'image/svg+xml', 5);
  trash(resolvePath('/临时')!.id);
  for (const n of Object.values(state().nodes)) if (n.deletedAt) n.deletedAt -= DAY;

  // 分享: 一个公开图片, 一个带密码 (1234) 的目录
  const docs = mkdirp('/文档');
  state().shares.push(
    { id: 'demoHill01', nodeId: hill.id, password: null, expiresAt: null, createdAt: t0 - 3 * DAY },
    { id: 'demoDocs02', nodeId: docs.id, password: '1234', expiresAt: t0 + 7 * DAY, createdAt: t0 - DAY },
  );
  await save();
}
