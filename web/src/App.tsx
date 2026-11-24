// 应用外壳: 登录门, 侧栏导航, hash 路由 (#/files/a/b, #/trash, #/shares, #/admin)
import { AppFrame, Button, ConfirmDialogHost, SidebarNavItemButton, Toaster } from './ui';
import { useCallback, useEffect, useState } from 'react';
import { admin, auth } from './lib/api';
import { Admin } from './pages/Admin';
import { Files } from './pages/Files';
import { Login } from './pages/Login';
import { Shares } from './pages/Shares';
import { Trash } from './pages/Trash';

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
  const [isAdmin, setIsAdmin] = useState(false);
  const [hash, nav] = useHash();

  useEffect(() => {
    if (authed) admin.stats().then(() => setIsAdmin(true), () => setIsAdmin(false));
  }, [authed]);

  const go = useCallback((p: string) => nav('/files' + (p.startsWith('/') ? p : '/' + p)), [nav]);

  if (!authed) return (<><Login onLogin={() => setAuthed(true)} /><Toaster /></>);

  const page = hash.split('/')[1] ?? 'files';
  const filePath = decodeURIComponent(hash.replace(/^\/files/, '')) || '/';
  const items = [
    { id: 'files', label: '文件' },
    { id: 'trash', label: '回收站' },
    { id: 'shares', label: '分享' },
    ...(isAdmin ? [{ id: 'admin', label: '后台' }] : []),
  ];

  return (
    <AppFrame>
      <aside className="flex w-48 shrink-0 flex-col gap-1 p-3">
        <div className="mb-3 px-2 text-base font-semibold">HX-CF-Drive</div>
        {items.map((it) => (
          <SidebarNavItemButton
            key={it.id}
            item={{ ...it, active: page === it.id }}
            onClick={() => nav(it.id === 'files' ? '/files/' : `/${it.id}`)}
          />
        ))}
        <div className="flex-1" />
        <Button variant="ghost" size="sm" onClick={() => { auth.clear(); setAuthed(false); }}>退出</Button>
      </aside>
      <main className="flex min-w-0 flex-1 flex-col rounded-2xl border border-border bg-card p-5">
        {page === 'trash' ? <Trash /> : page === 'shares' ? <Shares /> : page === 'admin' && isAdmin ? <Admin /> : <Files path={filePath} go={go} />}
      </main>
      <Toaster />
      <ConfirmDialogHost />
    </AppFrame>
  );
}
