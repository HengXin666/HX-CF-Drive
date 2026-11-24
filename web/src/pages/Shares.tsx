// 分享管理: 列出分享链接, 复制, 撤销
import { useCallback, useEffect, useState } from 'react';
import { Icon, IconButton } from '../components/Icon';
import { Page } from '../components/Shell';
import { fmtTime, type ShareRow, shares } from '../lib/api';
import { Badge, DataTable, type DataTableColumn, toast } from '../ui';

export function Shares() {
  const [rows, setRows] = useState<ShareRow[]>([]);
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
  const columns: DataTableColumn<ShareRow>[] = [
    { key: 'name', header: '文件', render: (s) => <span className="flex items-center gap-2.5"><Icon name="share" className="size-4 text-link" />{s.name}</span> },
    { key: 'pw', header: '访问', width: '90px', render: (s) => (s.has_password
      ? <Badge variant="warning"><Icon name="lock" className="size-3" /> 密码</Badge>
      : <Badge variant="secondary">公开</Badge>) },
    { key: 'exp', header: '过期', width: '170px', render: (s) => <span className="text-muted-foreground tabular-nums">{s.expires_at ? fmtTime(s.expires_at) : '永久'}</span> },
    { key: 'at', header: '创建', width: '170px', render: (s) => <span className="text-muted-foreground tabular-nums">{fmtTime(s.created_at)}</span> },
    { key: 'op', header: '', width: '80px', align: 'right', render: (s) => (
      <div className="flex justify-end gap-0.5">
        <IconButton name="copy" label="复制链接" onClick={() => void navigator.clipboard.writeText(url(s.id)).then(() => toast.success('链接已复制'))} />
        <IconButton name="trash" label="撤销" danger onClick={() => void revoke(s)} />
      </div>
    ) },
  ];

  return (
    <Page title="分享" right={<span className="text-[12.5px] text-muted-foreground">在文件列表里创建, 撤销后链接立即失效</span>}>
      <DataTable columns={columns} rows={rows} rowKey={(s) => s.id} loading={loading} emptyText="还没有分享" />
    </Page>
  );
}
