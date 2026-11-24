// 登录: 输入管理员令牌或 API 令牌, 存在本地
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input } from '../ui';
import { useState } from 'react';
import { api, auth } from '../lib/api';

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
    <div className="flex h-full items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>HX-CF-Drive</CardTitle>
          <CardDescription>Cloudflare + Telegram 网盘。输入管理员令牌或 API 令牌。</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
            <Input type="password" autoFocus placeholder="令牌" value={token} onChange={(e) => setToken(e.target.value)} />
            {err && <p className="text-sm text-danger-fg">{err}</p>}
            <Button type="submit" variant="primary" loading={busy} disabled={!token.trim()}>进入</Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
