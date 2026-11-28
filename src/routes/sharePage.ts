/**
 * 分享链接在浏览器里打开时的页面 (v0.4): 密码输入, 文件夹列表, 下载按钮。
 * 只在 GET/HEAD 且 Accept 含 text/html, 又没带 download / raw 时用; 其余请求 (curl, App, <img>, 播放器) 行为不变。
 * 纯字符串渲染, 不引前端包, 不加载外部资源; 配色与前端一致 (中性灰, 亮暗跟随系统)。
 */
import type { NodeRow } from '../lib/tree';

export function wantsHtml(req: Request, q: Record<string, string>): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  if (q.download === '1' || q.raw === '1') return false;
  return (req.headers.get('Accept') ?? '').includes('text/html');
}

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] as string);

export function fmtSize(n: number): string {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 ? v : v.toFixed(v >= 100 ? 0 : 1)} ${u[i]}`;
}

const fmtTime = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');

// lucide 图标 (folder, file, download, lock, external-link), 内联免外链
const ICONS: Record<string, string> = {
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>',
  lock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  open: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
};
const icon = (name: string, cls = 'i') =>
  `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;

const CSS = `
:root{--bg:#fafafa;--card:#fff;--fg:#0a0a0a;--muted:#737373;--border:#e5e5e5;--accent:#f5f5f5;--primary:#171717;--primary-fg:#fafafa;--danger:#dc2626;--folder:#f59e0b}
@media (prefers-color-scheme:dark){:root{--bg:#0a0a0a;--card:#171717;--fg:#fafafa;--muted:#a3a3a3;--border:#262626;--accent:#262626;--primary:#fafafa;--primary-fg:#171717;--danger:#f87171;--folder:#fbbf24}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 Geist,ui-sans-serif,system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
main{max-width:760px;margin:0 auto;padding:40px 16px}
.eyebrow{font:12px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted);letter-spacing:.04em;text-transform:uppercase;margin-bottom:6px}
h1{font-size:22px;font-weight:600;margin:0 0 4px;word-break:break-all}
.meta{color:var(--muted);font-size:13px;display:flex;gap:12px;flex-wrap:wrap;margin-bottom:20px}
.card{background:var(--card);border:1px solid var(--border);border-radius:12px;overflow:hidden}
.pad{padding:20px}
.row{display:flex;align-items:center;gap:12px;padding:10px 16px;border-top:1px solid var(--border)}
.row:first-child{border-top:0}.row:hover{background:var(--accent)}
.row a.name{flex:1;min-width:0;color:inherit;text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.row .size{color:var(--muted);font-size:12px;white-space:nowrap}
.i{width:16px;height:16px;flex:none}.dir .i{color:var(--folder)}
.btn{display:inline-flex;align-items:center;gap:8px;height:36px;padding:0 14px;border-radius:8px;border:1px solid var(--border);background:var(--card);color:var(--fg);text-decoration:none;font:inherit;font-weight:500;cursor:pointer}
.btn.primary{background:var(--primary);color:var(--primary-fg);border-color:var(--primary)}
.btn.icon{height:30px;padding:0 8px}
.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:16px}
.crumbs{display:flex;gap:6px;flex-wrap:wrap;color:var(--muted);font-size:13px;margin-bottom:12px}.crumbs a{color:inherit}
input{height:36px;width:100%;padding:0 12px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--fg);font:inherit;margin:12px 0}
.err{color:var(--danger);font-size:13px}.empty{padding:32px;text-align:center;color:var(--muted)}
footer{margin-top:24px;color:var(--muted);font-size:12px;text-align:center}
`;

function layout(title: string, body: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<meta name="robots" content="noindex"><title>${esc(title)}</title><style>${CSS}</style></head>`
    + `<body><main>${body}<footer>HX-CF-Drive 分享</footer></main></body></html>`;
}

/** 分享页里的链接参数: 子路径, 密码, 以及 download / raw */
export interface Ctx { id: string; pw: string }

function href(ctx: Ctx, extra: Record<string, string>): string {
  const q = new URLSearchParams(extra);
  if (ctx.pw) q.set('p', ctx.pw);
  const s = q.toString();
  return `/s/${encodeURIComponent(ctx.id)}${s ? `?${s}` : ''}`;
}

const joinPath = (dir: string, name: string) => `${dir.replace(/\/+$/, '')}/${name}`;

export function passwordPage(id: string, opts: { wrong?: boolean; locked?: number } = {}): string {
  const msg = opts.locked
    ? `<p class="err">密码错误次数太多, 请 ${Math.ceil(opts.locked / 60)} 分钟后再试。</p>`
    : opts.wrong ? '<p class="err">密码不对, 请重试。</p>' : '';
  return layout('需要密码', `<div class="eyebrow">${icon('lock')} 分享</div><h1>这个分享需要密码</h1><div class="meta">输入分享者给你的密码后查看。</div>`
    + `<form class="card pad" method="get" action="/s/${encodeURIComponent(id)}">${msg}`
    + `<input type="password" name="p" placeholder="密码" autocomplete="off" autofocus required${opts.locked ? ' disabled' : ''}>`
    + `<button class="btn primary" type="submit"${opts.locked ? ' disabled' : ''}>查看</button></form>`);
}

export function errorPage(title: string, detail: string): string {
  return layout(title, `<div class="eyebrow">分享</div><h1>${esc(title)}</h1><div class="meta">${esc(detail)}</div>`);
}

export function filePage(ctx: Ctx, node: NodeRow, sub?: string): string {
  const base: Record<string, string> = sub ? { path: sub } : {};
  return layout(node.name, `<div class="eyebrow">${icon('file')} 文件分享</div><h1>${esc(node.name)}</h1>`
    + `<div class="meta"><span>${fmtSize(node.size)}</span><span>${esc(node.mime ?? '')}</span><span>${fmtTime(node.updated_at)}</span></div>`
    + `<div class="actions"><a class="btn primary" href="${esc(href(ctx, { ...base, download: '1' }))}">${icon('download')} 下载</a>`
    + `<a class="btn" href="${esc(href(ctx, { ...base, raw: '1' }))}" target="_blank" rel="noopener">${icon('open')} 在浏览器打开</a></div>`);
}

/** 文件夹: sub 是相对分享根的路径 ('' 为根本身) */
export function dirPage(ctx: Ctx, root: NodeRow, sub: string, children: NodeRow[]): string {
  const segs = sub.split('/').filter(Boolean);
  const crumbs = [`<a href="${esc(href(ctx, {}))}">${esc(root.name)}</a>`];
  segs.forEach((s, i) => crumbs.push(`<span>/</span><a href="${esc(href(ctx, { path: '/' + segs.slice(0, i + 1).join('/') }))}">${esc(s)}</a>`));
  const rows = children.map((n) => {
    const p = joinPath(sub || '/', n.name);
    if (n.kind === 'dir') {
      return `<div class="row dir">${icon('folder')}<a class="name" href="${esc(href(ctx, { path: p }))}">${esc(n.name)}</a><span class="size">文件夹</span></div>`;
    }
    return `<div class="row">${icon('file')}<a class="name" href="${esc(href(ctx, { path: p }))}">${esc(n.name)}</a><span class="size">${fmtSize(n.size)}</span>`
      + `<a class="btn icon" title="下载" aria-label="下载 ${esc(n.name)}" href="${esc(href(ctx, { path: p, download: '1' }))}">${icon('download')}</a></div>`;
  }).join('');
  const title = segs.length ? segs[segs.length - 1] : root.name;
  const files = children.filter((n) => n.kind === 'file').length;
  return layout(title, `<div class="eyebrow">${icon('folder')} 文件夹分享</div><h1>${esc(title)}</h1>`
    + `<div class="meta"><span>${children.length - files} 个文件夹</span><span>${files} 个文件</span></div>`
    + `<nav class="crumbs">${crumbs.join('')}</nav><div class="card">${rows || '<div class="empty">空文件夹</div>'}</div>`);
}
