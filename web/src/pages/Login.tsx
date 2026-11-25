// 登录: 输入管理员令牌或 API 令牌, 存在本地
import { useState } from 'react';
import { Icon } from '../components/Icon';
import { ThemeToggle } from '../components/Shell';
import { DEMO_TOKEN, DemoLoginNote } from '../demo/LoginNote';
import { api, auth } from '../lib/api';
import { Backdrop, Button, Card, Field, Input, TooltipProvider } from '../ui';

export function Login({ onLogin }: { onLogin: () => void }) {
  const [token, setToken] = useState(__DEMO__ ? DEMO_TOKEN : '');
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
    <TooltipProvider>
      <div className="relative isolate flex h-full flex-col overflow-hidden bg-background">
        <Backdrop variant="grid" className="-z-10" />
        <header className="flex h-14 items-center gap-2.5 border-b px-5">
          <img src={`${import.meta.env.BASE_URL}icon-192.png`} alt="" className="size-7 rounded-md" />
          <span className="text-sm font-semibold">HX-CF-Drive</span>
          <span className="ml-auto"><ThemeToggle /></span>
        </header>
        <main className="flex flex-1 items-center justify-center p-6">
          <div className="w-full max-w-sm">
            <p className="mb-3 font-mono text-xs text-muted-foreground">Cloudflare · Telegram 网盘</p>
            <h1 className="mb-6 text-4xl font-semibold tracking-tight">登录</h1>
            <Card className="gap-4 p-6">
              {__DEMO__ && <DemoLoginNote />}
              <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
                <Field label="令牌" description="管理员令牌, 或后台签发的 API 令牌" error={err || undefined}>
                  <Input type="password" autoFocus leading={<Icon name="key" />} placeholder="粘贴令牌" value={token} onChange={(e) => setToken(e.target.value)} />
                </Field>
                <Button type="submit" loading={busy} disabled={!token.trim()}>{__DEMO__ ? '进入演示' : '进入'}</Button>
              </form>
            </Card>
          </div>
        </main>
      </div>
    </TooltipProvider>
  );
}
