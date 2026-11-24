// 分享管理: 列出分享链接, 复制, 撤销
import { Badge, Button, DataTable, type DataTableColumn, PageHeader, toast } from '../ui';
import { useCallback, useEffect, useState } from 'react';
import { fmtTime, type ShareRow, shares } from '../lib/api';

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

  const url = (id: string) => `${location.origin}/s/${id}`;
  const columns: DataTableColumn<ShareRow>[] = [
    { key: 'name', header: '文件', render: (s) => s.name },
    { key: 'pw', header: '密码', width: '80px', render: (s) => (s.has_password ? <Badge variant="warning">有</Badge> : <Badge variant="secondary">无</Badge>) },
    { key: 'exp', header: '过期', width: '180px', render: (s) => (s.expires_at ? fmtTime(s.expires_at) : '永久') },
    { key: 'at', header: '创建', width: '180px', render: (s) => fmtTime(s.created_at) },
    { key: 'op', header: '', width: '150px', align: 'right', render: (s) => (
      <div className="flex justify-end gap-1">
        <Button size="xs" variant="ghost" onClick={() => void navigator.clipboard.writeText(url(s.id)).then(() => toast.success('链接已复制'))}>复制</Button>
        <Button
          size="xs"
          variant="destructive"
          onClick={async () => {
            await shares.remove(s.id);
            toast.success('已撤销');
            await load();
          }}
        >撤销</Button>
      </div>
    ) },
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <PageHeader title="分享" desc="在文件列表的菜单里创建分享。撤销后链接立即失效。" />
      <DataTable columns={columns} rows={rows} rowKey={(s) => s.id} loading={loading} emptyText="还没有分享" className="min-h-0 flex-1" />
    </div>
  );
}
