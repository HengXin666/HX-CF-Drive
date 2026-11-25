// 应用入口: 登录门 + hash 路由 (#/files/a/b, #/trash, #/shares, #/admin, #/docs)
import { useCallback, useEffect, useState } from 'react';
import { Shell, type NavItem } from './components/Shell';
import { admin, auth, fmtSize, type Stats } from './lib/api';
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
  const [hash, nav] = useHash();

  const refreshStats = useCallback(() => {
    admin.stats().then(setStats, () => setStats(null));
  }, []);
  useEffect(() => { if (authed) refreshStats(); }, [authed, refreshStats]);

  const go = useCallback((p: string) => nav('/files' + (p.startsWith('/') ? p : '/' + p)), [nav]);

  if (!authed) return (<><Login onLogin={() => setAuthed(true)} /><Toaster position="bottom-right" /></>);

  const page = hash.split('/')[1] || 'files';
  const filePath = decodeURIComponent(hash.replace(/^\/files/, '')) || '/';
  const isAdmin = !!stats;
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
      onLogout={() => { auth.clear(); setAuthed(false); }}
      usage={stats && (
        <div className="grid gap-0.5">
          <span className="font-mono text-[10.5px] text-muted-foreground">已用 · 去重后</span>
          <span className="text-lg font-semibold tabular-nums">{fmtSize(stats.blobs.bytes)}</span>
          <span className="text-xs text-muted-foreground">{fileCount} 个文件 · {stats.channels.length} 个频道</span>
        </div>
      )}
    >
      {page === 'trash' ? <Trash /> : page === 'shares' ? <Shares /> : page === 'docs' ? <ApiDocs />
        : page === 'admin' && isAdmin ? <Admin onChange={refreshStats} /> : <Files path={filePath} go={go} onChange={refreshStats} />}
    </Shell>
  );
}
