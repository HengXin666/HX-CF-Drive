// 分享管理: 列出分享链接, 复制, 编辑 (密码, 有效期, 启用 / 停用, 备注), 撤销
import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { Icon, IconButton } from '../components/Icon';
import { Meta, Page } from '../components/Shell';
import { type Column, DataTable } from '../components/Table';
import { fmtTime, type ShareRow, shares } from '../lib/api';
import { Badge, toast } from '../ui';

const ShareEditDialog = lazy(() => import('../components/ShareEditDialog').then((m) => ({ default: m.ShareEditDialog })));

export function Shares() {
  const [rows, setRows] = useState<ShareRow[]>([]);
  const [editing, setEditing] = useState<ShareRow | null>(null);
  const [usedEdit, setUsedEdit] = useState(false);
  const edit = (s: ShareRow) => { setUsedEdit(true); setEditing(s); };
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows((await shares.list()).items);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const url = (id: string) => `${location.origin}${import.meta.env.BASE_URL}s/${id}`;
  const revoke = async (s: ShareRow) => {
    try {
      await shares.remove(s.id);
      toast.success('已撤销');
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const columns: Column<ShareRow>[] = [
    { key: 'name', header: '文件', sort: (s) => s.name.toLowerCase(),
      render: (s) => (
        <span className="flex min-w-0 items-center gap-2.5">
          <Icon name="share" className={s.disabled ? 'text-muted-foreground' : 'text-brand'} />
          <span className="grid min-w-0">
            <span className={s.disabled ? 'truncate text-muted-foreground line-through' : 'truncate'}>{s.name}</span>
            {s.remark && <span className="truncate text-xs text-muted-foreground">{s.remark}</span>}
          </span>
        </span>
      ) },
    { key: 'pw', header: '访问', render: (s) => (s.disabled
      ? <Badge variant="outline" dot="muted">已停用</Badge>
      : s.expires_at && s.expires_at < Date.now()
        ? <Badge variant="outline" dot="destructive">已过期</Badge>
        : s.has_password
          ? <Badge variant="outline" dot="warning">密码</Badge>
          : <Badge variant="outline" dot="success">公开</Badge>) },
    { key: 'exp', header: '过期', hideOnMobile: true, sort: (s) => s.expires_at ?? Number.MAX_SAFE_INTEGER,
      render: (s) => <span className="whitespace-nowrap tabular-nums text-muted-foreground">{s.expires_at ? fmtTime(s.expires_at) : '永久'}</span> },
    { key: 'at', header: '创建', hideOnMobile: true, sort: (s) => s.created_at,
      render: (s) => <span className="whitespace-nowrap tabular-nums text-muted-foreground">{fmtTime(s.created_at)}</span> },
    { key: 'op', header: '', align: 'right', render: (s) => (
      <div className="flex justify-end gap-0.5" onClick={(e) => e.stopPropagation()}>
        <IconButton name="copy" label="复制链接" onClick={() => void navigator.clipboard.writeText(url(s.id)).then(() => toast.success('链接已复制'))} />
        <IconButton name="rename" label="编辑" onClick={() => edit(s)} />
        <IconButton name="trash" label="撤销" danger onClick={() => void revoke(s)} />
      </div>
    ) },
  ];

  return (
    <Page
      eyebrow={<span>网盘 / <span className="text-foreground">shares</span></span>}
      icon="share"
      title="分享"
      meta={<><Meta icon="link">{rows.length} 个链接</Meta><span className="hidden sm:inline">撤销后立即失效</span></>}
    >
      <DataTable columns={columns} rows={rows} rowKey={(s) => s.id} loading={loading} emptyText="还没有分享, 在文件列表里创建" emptyIcon="share" onRowClick={edit} />
      {usedEdit && <Suspense fallback={null}><ShareEditDialog share={editing} onClose={() => setEditing(null)} onSaved={() => void load()} /></Suspense>}
    </Page>
  );
}
