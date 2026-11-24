// 登录: 输入管理员令牌或 API 令牌, 存在本地
import { useState } from 'react';
import { Icon } from '../components/Icon';
import { api, auth } from '../lib/api';
import { Backdrop, Button, Input } from '../ui';

export function Login({ onLogin }: { onLogin: () => void }) {
  const [token, setToken] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setErr('');
    auth.set(token.trim());
    try {
      await api('GET', '/fs/list?path=/');
      onLogin();
    } catch (e) {
      auth.clear();
      setErr((e as Error).message === 'unauthorized' ? '令牌无效' : (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative isolate flex h-full items-center justify-center overflow-hidden bg-background p-6">
      <Backdrop variant="aurora" fade className="absolute inset-0 -z-10" />
      <div className="w-full max-w-sm rounded-2xl border border-border/50 bg-card/70 p-7 shadow-xl backdrop-blur">
        <div className="mb-6 flex items-center gap-3">
          <img src="/icon-192.png" alt="" className="size-12 rounded-xl" />
          <div>
            <div className="text-[17px] font-semibold tracking-tight">HX-CF-Drive</div>
            <div className="text-[12.5px] text-muted-foreground">Cloudflare + Telegram 网盘</div>
          </div>
        </div>
        <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <div className="relative">
            <Icon name="key" className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input type="password" autoFocus className="h-10 pl-9" placeholder="管理员令牌或 API 令牌" value={token} onChange={(e) => setToken(e.target.value)} />
          </div>
          {err && <p className="flex items-center gap-1.5 text-[13px] text-danger-fg"><Icon name="warn" /> {err}</p>}
          <Button type="submit" variant="primary" className="h-10" loading={busy} disabled={!token.trim()}>进入</Button>
        </form>
      </div>
    </div>
  );
}
