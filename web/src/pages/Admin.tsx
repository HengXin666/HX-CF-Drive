// 后台: 用量统计, Telegram 频道与 Bot, API 令牌, 手动维护
import { useCallback, useEffect, useState } from 'react';
import { Icon, IconButton } from '../components/Icon';
import { PromptDialog, type PromptRequest } from '../components/PromptDialog';
import { Meta, Page } from '../components/Shell';
import { type Column, DataTable } from '../components/Table';
import { Topology } from '../components/Topology';
import type { IconName } from '../icons';
import { admin, fmtSize, fmtTime, type Stats, type TokenRow } from '../lib/api';
import { Badge, Button, Card, toast } from '../ui';

type Bot = Stats['bots'][number];
type Channel = Stats['channels'][number];

const dot = (s: string) => (s === 'active' ? 'success' : s === 'readonly' ? 'warning' : 'destructive') as 'success' | 'warning' | 'destructive';
const Status = ({ s }: { s: string }) => <Badge variant="outline" dot={dot(s)}>{s}</Badge>;

function Stat({ icon, label, value, hint }: { icon: IconName; label: string; value: string | number; hint?: string }) {
  return (
    <Card className="gap-1.5 p-3 md:p-4">
      <div className="flex items-center justify-between font-mono text-[11px] text-muted-foreground">
        {label}
        <Icon name={icon} className="size-3.5" />
      </div>
      <div className="text-xl font-semibold tabular-nums tracking-tight md:text-2xl">{value}</div>
      {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
    </Card>
  );
}

/** onStats: 把这里拉到的用量交给侧栏, 不再让侧栏另发一次 /admin/stats */
export function Admin({ onStats }: { onStats: (s: Stats) => void }) {
  const [stats, setStats] = useState<Stats | null>(null);
  const [tokens, setTokens] = useState<TokenRow[]>([]);
  const [prompt, setPrompt] = useState<PromptRequest | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [s, t] = await Promise.all([admin.stats(), admin.tokens()]);
      setStats(s);
      setTokens(t.items);
      onStats(s);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }, [onStats]);
  useEffect(() => { void load(); }, [load]);

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      toast.success(ok);
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const report = (r: Record<string, string>) => {
    const bad = Object.entries(r).filter(([, v]) => !v.startsWith('ok'));
    if (bad.length) toast.warning(bad.map(([k, v]) => `${k}: ${v}`).join('\n'), { duration: 10000 });
  };

  const count = (k: string) => stats?.nodes.find((x) => x.kind === k)?.n ?? 0;

  const channelCols: Column<Channel>[] = [
    { key: 'id', header: '频道 ID', render: (c) => <code className="font-mono text-xs">{c.id}</code> },
    { key: 'title', header: '名称', hideOnMobile: true, render: (c) => c.title },
    { key: 'status', header: '状态', render: (c) => <Status s={c.status} /> },
    { key: 'op', header: '', align: 'right', render: (c) => (
      <Button size="xs" variant="ghost" onClick={() => void run(() => admin.setChannel(c.id, c.status === 'active' ? 'readonly' : 'active'), '已更新')}>
        {c.status === 'active' ? '设为只读' : '恢复写入'}
      </Button>
    ) },
  ];
  const botCols: Column<Bot>[] = [
    { key: 'name', header: 'Bot', render: (b) => <span className="font-mono text-xs">{b.username ? `@${b.username}` : b.id}</span> },
    { key: 'status', header: '状态', render: (b) => <Status s={b.status} /> },
    { key: 'err', header: '最近错误', hideOnMobile: true, render: (b) => <span className="text-xs text-muted-foreground">{b.last_error ?? ''}</span> },
    { key: 'op', header: '', align: 'right', render: (b) => (
      <IconButton name="close" label="停用" danger onClick={() => void run(() => admin.removeBot(b.id), '已停用')} />
    ) },
  ];
  const tokenCols: Column<TokenRow>[] = [
    { key: 'name', header: '名称', render: (t) => t.name },
    { key: 'root', header: '根目录', render: (t) => <code className="font-mono text-xs">{t.root_path}</code> },
    { key: 'scopes', header: '权限', hideOnMobile: true, render: (t) => (
      <span className="flex flex-wrap gap-1">{t.scopes.split(',').map((s) => <Badge key={s} variant="secondary" className="font-mono">{s.trim()}</Badge>)}</span>
    ) },
    { key: 'exp', header: '过期', hideOnMobile: true, render: (t) => <span className="whitespace-nowrap tabular-nums text-muted-foreground">{t.expires_at ? fmtTime(t.expires_at) : '永久'}</span> },
    { key: 'op', header: '', align: 'right', render: (t) => (
      <IconButton name="trash" label="删除" danger onClick={() => void run(() => admin.removeToken(t.id), '已删除')} />
    ) },
  ];

  return (
    <Page
      eyebrow={<span>管理 / <span className="text-foreground">admin</span></span>}
      icon="admin"
      title="后台"
      meta={<><Meta icon="plane">频道与 Bot</Meta><Meta icon="key">API 令牌</Meta></>}
      right={<Button size="sm" variant="outline" loading={busy} onClick={() => { setBusy(true); void run(admin.maintenance, '维护完成').finally(() => setBusy(false)); }}><Icon name="refresh" /><span className="hidden sm:inline">立即维护</span></Button>}
    >
      <div className="grid grid-cols-2 gap-2 md:gap-3 lg:grid-cols-4">
        <Stat icon="fileText" label="文件" value={count('file')} />
        <Stat icon="folder" label="目录" value={count('dir')} />
        <Stat icon="database" label="去重后占用" value={fmtSize(stats?.blobs.bytes ?? 0)} hint={`${stats?.blobs.n ?? 0} 个数据块${stats?.snapshotAt ? ` · 统计于 ${fmtTime(stats.snapshotAt)}` : ''}`} />
        <Stat icon="plane" label="可用 Bot" value={stats?.bots.filter((b) => b.status === 'active').length ?? 0} />
      </div>
      {/* Bot 或频道变了就重新拉拓扑 */}
      <Topology key={[...(stats?.bots ?? []), ...(stats?.channels ?? [])].map((x) => `${x.id}:${x.status}`).join(',')} />
      <DataTable
        title="Telegram 频道"
        description="文件分片存在这些频道里; 只读的频道不再写入新分片。"
        columns={channelCols}
        rows={stats?.channels ?? []}
        rowKey={(c) => c.id}
        emptyText="还没有频道"
        actions={
          <Button size="sm" variant="outline" onClick={() => setPrompt({
            title: '添加频道', fields: [{ key: 'id', label: '频道 ID', placeholder: '-100xxxxxxxxxx' }],
            onOk: async (v) => { const r = await admin.addChannel(v.id.trim()); report(r.bots); await load(); },
          })}><Icon name="add" /><span className="hidden sm:inline">添加</span></Button>
        }
      />
      <DataTable
        title="Bot"
        columns={botCols}
        rows={stats?.bots ?? []}
        rowKey={(b) => b.id}
        emptyText="还没有 Bot"
        actions={
          <Button size="sm" variant="outline" onClick={() => setPrompt({
            title: '添加 Bot', fields: [{ key: 'token', label: 'Bot Token', type: 'password' }],
            onOk: async (v) => { const r = await admin.addBot(v.token.trim()); report(r.channels); await load(); },
          })}><Icon name="add" /><span className="hidden sm:inline">添加</span></Button>
        }
      />
      <DataTable
        title="API 令牌"
        description="限定了根目录的令牌只能看到自己的目录; 删除或移出这些目录时文件页会提醒。"
        columns={tokenCols}
        rows={tokens}
        rowKey={(t) => t.id}
        emptyText="还没有令牌"
        actions={
          <Button size="sm" variant="outline" onClick={() => setPrompt({
            title: '新建令牌',
            fields: [
              { key: 'name', label: '名称', placeholder: 'picgo' },
              { key: 'scopes', label: '权限', description: '逗号分隔: read, write, admin, stats', value: 'read,write' },
              { key: 'root', label: '限定根目录', value: '/' },
            ],
            onOk: async (v) => {
              const r = await admin.addToken(v.name.trim(), v.scopes.split(',').map((s) => s.trim()).filter(Boolean), v.root.trim() || '/');
              await navigator.clipboard.writeText(r.token);
              toast.success('令牌已复制到剪贴板, 只显示这一次', { duration: 8000 });
              await load();
            },
          })}><Icon name="add" /><span className="hidden sm:inline">新建</span></Button>
        }
      />
      <PromptDialog req={prompt} onClose={() => setPrompt(null)} />
    </Page>
  );
}
