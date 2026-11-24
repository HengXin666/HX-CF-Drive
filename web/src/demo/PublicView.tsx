// 直接在新标签页打开 /f/ 直链或 /s/ 分享时的页面 (Pages 上这些路径回落到 404.html, 由这里接管)
import { useCallback, useEffect, useState } from 'react';
import { Icon } from '../components/Icon';
import { fileIcon } from '../icons';
import { fmtSize, type Node } from '../lib/api';
import { Backdrop, Button, Input } from '../ui';
import { BASE } from './serve';

/** 当前地址是否是直链或分享页 */
export function publicKind(): 'f' | 's' | null {
  const p = location.pathname.startsWith(BASE) ? location.pathname.slice(BASE.length) : '';
  return /^f\//.test(p) ? 'f' : /^s\//.test(p) ? 's' : null;
}

type View =
  | { t: 'loading' }
  | { t: 'error'; msg: string }
  | { t: 'password'; wrong: boolean }
  | { t: 'dir'; node: Node; children: Node[] }
  | { t: 'file'; name: string; mime: string; size: number; src: string; text?: string };

function FileBody({ v }: { v: Extract<View, { t: 'file' }> }) {
  const m = v.mime;
  if (m.startsWith('image/')) return <img src={v.src} alt={v.name} className="max-h-[60vh] w-full rounded-lg object-contain" />;
  if (m.startsWith('video/')) return <video src={v.src} controls className="max-h-[60vh] w-full rounded-lg bg-black" />;
  if (m.startsWith('audio/')) return <audio src={v.src} controls className="w-full" />;
  if (v.text !== undefined) return <pre className="max-h-[60vh] overflow-auto rounded-lg bg-background/60 p-4 font-mono text-[12.5px] whitespace-pre-wrap">{v.text}</pre>;
  return <p className="text-[13px] text-muted-foreground">这个类型不能在线预览, 可以直接下载。</p>;
}

export function PublicView() {
  const kind = publicKind();
  const [view, setView] = useState<View>({ t: 'loading' });
  const [pw, setPw] = useState('');
  const [sub, setSub] = useState('');

  const fetchView = useCallback(async (password: string, path: string) => {
    const u = new URL(location.href);
    if (password) u.searchParams.set('p', password);
    if (path) u.searchParams.set('path', path);
    const r = await fetch(u.href);
    if (r.status === 401) { setView({ t: 'password', wrong: !!password }); return; }
    if (!r.ok) {
      const e = (await r.json().catch(() => ({}))) as { error?: string };
      setView({ t: 'error', msg: e.error ?? `HTTP ${r.status}` });
      return;
    }
    const mime = (r.headers.get('Content-Type') ?? '').split(';')[0];
    if (kind === 's' && mime === 'application/json' && !r.headers.get('Content-Disposition')) {
      const j = (await r.json()) as { node: Node; children: Node[] };
      setView({ t: 'dir', ...j });
      return;
    }
    const blob = await r.blob();
    const cd = r.headers.get('Content-Disposition') ?? '';
    const name = decodeURIComponent(/filename\*=UTF-8''([^;]+)/.exec(cd)?.[1] ?? 'file');
    const text = mime.startsWith('text/') || mime === 'application/json' ? await blob.slice(0, 262144).text() : undefined;
    setView({ t: 'file', name, mime, size: blob.size, src: URL.createObjectURL(blob), text });
  }, [kind]);

  // 只在进入子路径时重新拉取; 密码由表单提交触发
  useEffect(() => { void fetchView(pw, sub); }, [sub, fetchView]);

  const save = () => {
    if (view.t !== 'file') return;
    const a = document.createElement('a');
    a.href = view.src;
    a.download = view.name;
    a.click();
  };

  const title = kind === 'f' ? '文件直链' : '分享';
  return (
    <div className="relative isolate flex h-full items-center justify-center overflow-auto bg-background p-6">
      <Backdrop variant="aurora" fade className="absolute inset-0 -z-10" />
      <div className="w-full max-w-2xl rounded-2xl border border-border/50 bg-card/70 p-6 shadow-xl backdrop-blur">
        <div className="mb-5 flex items-center gap-3">
          <img src={`${BASE}icon-192.png`} alt="" className="size-10 rounded-xl" />
          <div className="min-w-0 flex-1">
            <div className="text-[15px] font-semibold">HX-CF-Drive {title}</div>
            <div className="text-[12.5px] text-muted-foreground">演示数据来自你浏览器里的本地存储</div>
          </div>
          <Button size="sm" variant="outline" onClick={() => { location.href = `${BASE}#/files/`; }}>
            <Icon name="files" /> 打开演示网盘
          </Button>
        </div>
        {view.t === 'loading' && <p className="text-[13px] text-muted-foreground">加载中...</p>}
        {view.t === 'error' && <p className="flex items-center gap-1.5 text-[13px] text-danger-fg"><Icon name="warn" /> {view.msg}</p>}
        {view.t === 'password' && (
          <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); void fetchView(pw, sub); }}>
            <p className="flex items-center gap-1.5 text-[13px]"><Icon name="lock" /> 这个分享需要密码 (示例分享的密码是 1234)</p>
            <Input type="password" autoFocus placeholder="分享密码" value={pw} onChange={(e) => setPw(e.target.value)} />
            {view.wrong && <p className="text-[13px] text-danger-fg">密码不对</p>}
            <Button type="submit" variant="primary" disabled={!pw}>查看</Button>
          </form>
        )}
        {view.t === 'dir' && (
          <div className="flex flex-col gap-1">
            <div className="mb-2 flex items-center gap-2 text-[13px] text-muted-foreground">
              {sub && <Button size="xs" variant="ghost" onClick={() => setSub(sub.replace(/\/[^/]+$/, ''))}><Icon raw="icon-[solar--arrow-left-linear]" /> 上一级</Button>}
              <span className="truncate">{view.node.name}{sub && ` / ${sub.split('/').filter(Boolean).join(' / ')}`}</span>
            </div>
            {view.children.length === 0 && <p className="text-[13px] text-muted-foreground">空目录</p>}
            {view.children.map((c) => {
              const fi = fileIcon(c.kind, c.mime, c.name);
              return (
                <button key={c.id} type="button" onClick={() => setSub(`${sub}/${c.name}`)}
                  className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] hover:bg-accent/50">
                  <Icon raw={fi.icon} className={`size-[18px] ${fi.tone}`} />
                  <span className="min-w-0 flex-1 truncate">{c.name}</span>
                  <span className="text-muted-foreground tabular-nums">{c.kind === 'dir' ? '' : fmtSize(c.size)}</span>
                </button>
              );
            })}
          </div>
        )}
        {view.t === 'file' && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2 text-[13px]">
              {sub && <Button size="xs" variant="ghost" onClick={() => setSub(sub.replace(/\/[^/]+$/, ''))}><Icon raw="icon-[solar--arrow-left-linear]" /> 返回</Button>}
              <span className="min-w-0 flex-1 truncate font-medium">{view.name}</span>
              <span className="text-muted-foreground">{fmtSize(view.size)}</span>
              <Button size="sm" variant="primary" onClick={save}><Icon name="download" /> 下载</Button>
            </div>
            <FileBody v={view} />
          </div>
        )}
      </div>
    </div>
  );
}
