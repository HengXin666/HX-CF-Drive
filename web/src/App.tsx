// 应用入口: 登录门 + hash 路由 (#/files/a/b, #/trash, #/shares, #/admin, #/docs)
import { File, HardDrive, Send } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Shell, type NavItem } from './components/Shell';
import { admin, ApiError, auth, fmtSize, me, type Stats } from './lib/api';
import { clearImages } from './lib/imgcache';
import { Admin } from './pages/Admin';
import { ApiDocs } from './pages/ApiDocs';
import { Files } from './pages/Files';
import { Login } from './pages/Login';
import { Shares } from './pages/Shares';
import { Trash } from './pages/Trash';
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
      {page === 'trash' ? <Trash /> : page === 'shares' ? <Shares /> : page === 'docs' ? <ApiDocs />
        : page === 'admin' && isAdmin ? <Admin onStats={setStats} /> : <Files path={filePath} go={go} isAdmin={isAdmin} />}
    </Shell>
  );
}
