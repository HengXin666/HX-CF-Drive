// 后台: 用量统计, Telegram 频道与 Bot, API 令牌, 手动维护
import { Icon, IconButton } from '../components/Icon';
import { Page } from '../components/Shell';
import { Badge, Button, DataTable, type DataTableColumn, StatCard, StatGrid, toast } from '../ui';
import { useCallback, useEffect, useState } from 'react';
import { PromptDialog, type PromptRequest } from '../components/PromptDialog';
import { admin, fmtSize, fmtTime, type Stats, type TokenRow } from '../lib/api';

type Bot = Stats['bots'][number];
type Channel = Stats['channels'][number];

const tone = (s: string) => (s === 'active' ? 'success' : s === 'readonly' ? 'warning' : 'destructive') as 'success' | 'warning' | 'destructive';

export function Admin({ onChange }: { onChange: () => void }) {
  const [stats, setStats] = useState<Stats | null>(null);
  const [tokens, setTokens] = useState<TokenRow[]>([]);
  const [prompt, setPrompt] = useState<PromptRequest | null>(null);

  const load = useCallback(async () => {
    try {
      const [s, t] = await Promise.all([admin.stats(), admin.tokens()]);
      setStats(s);
      setTokens(t.items);
      onChange();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }, [onChange]);
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
    if (bad.length) toast.warning(bad.map(([k, v]) => `${k}: ${v}`).join('\n'), { durationMs: 10000 });
  };

  const count = (k: string) => stats?.nodes.find((x) => x.kind === k)?.n ?? 0;

  const channelCols: DataTableColumn<Channel>[] = [
    { key: 'id', header: '频道 ID', render: (c) => <code className="text-xs">{c.id}</code> },
    { key: 'title', header: '名称', render: (c) => c.title },
    { key: 'status', header: '状态', width: '90px', render: (c) => <Badge variant={tone(c.status)}>{c.status}</Badge> },
    { key: 'op', header: '', width: '110px', align: 'right', render: (c) => (
      <Button size="xs" variant="ghost" onClick={() => void run(() => admin.setChannel(c.id, c.status === 'active' ? 'readonly' : 'active'), '已更新')}>
        {c.status === 'active' ? '设为只读' : '恢复写入'}
      </Button>
    ) },
  ];
  const botCols: DataTableColumn<Bot>[] = [
    { key: 'name', header: 'Bot', render: (b) => (b.username ? `@${b.username}` : b.id) },
    { key: 'status', header: '状态', width: '90px', render: (b) => <Badge variant={tone(b.status)}>{b.status}</Badge> },
    { key: 'err', header: '最近错误', render: (b) => <span className="text-xs text-muted-foreground">{b.last_error ?? ''}</span> },
    { key: 'op', header: '', width: '80px', align: 'right', render: (b) => (
      <IconButton name="close" label="停用" danger onClick={() => void run(() => admin.removeBot(b.id), '已停用')} />
    ) },
  ];
  const tokenCols: DataTableColumn<TokenRow>[] = [
    { key: 'name', header: '名称', render: (t) => t.name },
    { key: 'scopes', header: '权限', render: (t) => t.scopes },
    { key: 'exp', header: '过期', width: '170px', render: (t) => (t.expires_at ? fmtTime(t.expires_at) : '永久') },
    { key: 'op', header: '', width: '80px', align: 'right', render: (t) => (
      <IconButton name="trash" label="删除" danger onClick={() => void run(() => admin.removeToken(t.id), '已删除')} />
    ) },
  ];

  return (
    <Page
      title="后台"
      right={<Button size="sm" variant="outline" onClick={() => void run(admin.maintenance, '维护完成')}><Icon name="refresh" /> 立即维护</Button>}
    >
      <div className="flex flex-col gap-4">
      <StatGrid>
        <StatCard icon="icon-[solar--file-text-linear]" label="文件" value={count('file')} />
        <StatCard icon="icon-[solar--folder-linear]" label="目录" value={count('dir')} />
        <StatCard icon="icon-[solar--database-linear]" label="去重后占用" value={fmtSize(stats?.blobs.bytes ?? 0)} hint={`${stats?.blobs.n ?? 0} 个数据块`} />
        <StatCard icon="icon-[solar--plain-linear]" label="可用 Bot" value={stats?.bots.filter((b) => b.status === 'active').length ?? 0} />
      </StatGrid>
      <DataTable
        title="Telegram 频道"
        columns={channelCols}
        rows={stats?.channels ?? []}
        rowKey={(c) => c.id}
        emptyText="还没有频道"
        actions={
          <Button size="sm" variant="outline" onClick={() => setPrompt({
            title: '添加频道', fields: [{ key: 'id', label: '频道 ID', placeholder: '-100xxxxxxxxxx' }],
            onOk: async (v) => { const r = await admin.addChannel(v.id.trim()); report(r.bots); await load(); },
          })}><Icon name="newFolder" raw="icon-[solar--add-circle-linear]" /> 添加</Button>
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
          })}><Icon name="newFolder" raw="icon-[solar--add-circle-linear]" /> 添加</Button>
        }
      />
      <DataTable
        title="API 令牌"
        columns={tokenCols}
        rows={tokens}
        rowKey={(t) => t.id}
        emptyText="还没有令牌"
        actions={
          <Button size="sm" variant="outline" onClick={() => setPrompt({
            title: '新建令牌',
            fields: [
              { key: 'name', label: '名称', placeholder: 'picgo' },
              { key: 'scopes', label: '权限 (逗号分隔: read, write, admin)', value: 'read,write' },
              { key: 'root', label: '限定根目录', value: '/' },
            ],
            onOk: async (v) => {
              const r = await admin.addToken(v.name.trim(), v.scopes.split(',').map((s) => s.trim()).filter(Boolean), v.root.trim() || '/');
              await navigator.clipboard.writeText(r.token);
              toast.success('令牌已复制到剪贴板, 只显示这一次', { durationMs: 8000 });
              await load();
            },
          })}><Icon raw="icon-[solar--add-circle-linear]" /> 新建</Button>
        }
      />
      </div>
      <PromptDialog req={prompt} onClose={() => setPrompt(null)} />
    </Page>
  );
}
