// 应用入口: 登录门 + hash 路由 (#/files/a/b, #/trash, #/shares, #/admin, #/docs)
import { File, HardDrive, Send } from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { Icon } from './components/Icon';
import { Shell, type NavItem } from './components/Shell';
import { admin, ApiError, auth, fmtSize, me, type Stats } from './lib/api';
import { clearImages } from './lib/imgcache';
import { Files } from './pages/Files';
import { Login } from './pages/Login';

// 路由级代码分割 (#23): 只用文件页的人不用下载后台, 接口文档, 分享和回收站
const Admin = lazy(() => import('./pages/Admin').then((m) => ({ default: m.Admin })));
const ApiDocs = lazy(() => import('./pages/ApiDocs').then((m) => ({ default: m.ApiDocs })));
const Shares = lazy(() => import('./pages/Shares').then((m) => ({ default: m.Shares })));
const Trash = lazy(() => import('./pages/Trash').then((m) => ({ default: m.Trash })));
/** 鼠标移到侧栏菜单上时预取对应页面, 点下去基本不用等 */
const PREFETCH: Record<string, () => Promise<unknown>> = {
  admin: () => import('./pages/Admin'), docs: () => import('./pages/ApiDocs'), shares: () => import('./pages/Shares'), trash: () => import('./pages/Trash'),
};

const Loading = () => (
  <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground"><Icon name="spinner" className="size-4 animate-spin" />加载中…</div>
);
import { Toaster } from './ui';

function useHash(): [string, (h: string) => void] {
  const [hash, setHash] = useState(() => location.hash.slice(1) || '/files/');
  useEffect(() => {
    const f = () => setHash(location.hash.slice(1) || '/files/');
    window.addEventListener('hashchange', f);
    return () => window.removeEventListener('hashchange', f);
  }, []);
  return [hash, (h) => { location.hash = h; }];
}

export function App() {
  const [authed, setAuthed] = useState(!!auth.get());
  const [stats, setStats] = useState<Stats | null>(null);
  const [scopes, setScopes] = useState<string[] | null>(null);
  const [hash, nav] = useHash();

  // 先问自己有什么权限, 有 admin / stats 才拉用量 (统计是维护任务写的快照, 只在打开页面和后台操作后刷新)
  useEffect(() => {
    if (!authed) { setScopes(null); setStats(null); return; }
    let dead = false;
    me().then((m) => {
      if (dead) return;
      setScopes(m.scopes);
      if (m.scopes.includes('admin') || m.scopes.includes('stats')) admin.stats().then((s) => { if (!dead) setStats(s); }, () => {});
    }, (e) => {
      if (dead) return;
      // 令牌已失效: 回到登录页
      if (e instanceof ApiError && e.status === 401) { auth.clear(); setAuthed(false); }
      else setScopes([]);
    });
    return () => { dead = true; };
  }, [authed]);

  const go = useCallback((p: string) => nav('/files' + (p.startsWith('/') ? p : '/' + p)), [nav]);

  if (!authed) return (<><Login onLogin={() => setAuthed(true)} /><Toaster position="bottom-right" /></>);

  const page = hash.split('/')[1] || 'files';
  const filePath = decodeURIComponent(hash.replace(/^\/files/, '')) || '/';
  const isAdmin = !!scopes?.includes('admin');
  const items: NavItem[] = [
    { id: 'files', label: '文件', hint: 'files', icon: 'files', group: '网盘' },
    { id: 'shares', label: '分享', hint: 'shares', icon: 'share', group: '网盘' },
    { id: 'trash', label: '回收站', hint: 'trash', icon: 'trash', group: '网盘' },
    ...(isAdmin ? [{ id: 'admin', label: '后台', hint: 'admin', icon: 'admin', group: '管理' } as NavItem] : []),
    { id: 'docs', label: '接口文档', hint: 'api', icon: 'docs', group: '管理' },
  ];
  const fileCount = stats?.nodes.find((x) => x.kind === 'file')?.n ?? 0;

  return (
    <Shell
      items={items}
      active={page}
      onNav={(id) => nav(id === 'files' ? '/files/' : `/${id}`)}
      onHover={(id) => void PREFETCH[id]?.()}
      onLogout={() => { auth.clear(); void clearImages(); setAuthed(false); }}
      usage={stats && (
        <div className="flex items-center gap-3">
          <span className="grid size-8 shrink-0 place-items-center rounded-md bg-brand-soft text-brand"><HardDrive className="size-4" /></span>
          <div className="grid min-w-0 leading-tight">
            <span className="text-sm font-semibold tabular-nums">{fmtSize(stats.blobs.bytes)}</span>
            <span className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <span className="inline-flex items-center gap-0.5"><File className="size-3" />{fileCount}</span>
              <span className="inline-flex items-center gap-0.5"><Send className="size-3" />{stats.channels.length}</span>
              <span>去重后</span>
            </span>
          </div>
        </div>
      )}
    >
      <Suspense fallback={<Loading />}>
        {page === 'trash' ? <Trash /> : page === 'shares' ? <Shares /> : page === 'docs' ? <ApiDocs />
          : page === 'admin' && scopes === null ? <Loading /> // 权限还没回来: 先等, 免得先挂文件页白拉一次目录
          : page === 'admin' && isAdmin ? <Admin onStats={setStats} /> : <Files path={filePath} go={go} isAdmin={isAdmin} />}
      </Suspense>
    </Shell>
  );
}
