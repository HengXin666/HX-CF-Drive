// 回收站: 列出已删除的顶层节点, 可恢复 (目录连同子项)。超期由每日定时任务清理
import { Button, DataTable, type DataTableColumn, PageHeader, toast } from '../ui';
import { useCallback, useEffect, useState } from 'react';
import { fmtSize, fmtTime, fs, type Node } from '../lib/api';

export function Trash() {
  const [rows, setRows] = useState<Node[]>([]);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows((await fs.trash()).items);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const columns: DataTableColumn<Node>[] = [
    { key: 'name', header: '名称', render: (n) => `${n.kind === 'dir' ? '📁' : '📄'} ${n.name}` },
    { key: 'size', header: '大小', width: '110px', numeric: true, render: (n) => (n.kind === 'dir' ? '' : fmtSize(n.size)) },
    { key: 'at', header: '删除时间', width: '180px', render: (n) => (n.deletedAt ? fmtTime(n.deletedAt) : '') },
    { key: 'op', header: '', width: '80px', align: 'right', render: (n) => (
      <Button
        size="xs"
        variant="outline"
        onClick={async () => {
          try {
            await fs.restore(n.id);
            toast.success(`已恢复 ${n.name}`);
            await load();
          } catch (e) {
            toast.error((e as Error).message);
          }
        }}
      >恢复</Button>
    ) },
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <PageHeader title="回收站" desc="删除的文件保留一段时间 (默认 7 天), 之后由每日维护任务彻底清理。" />
      <DataTable columns={columns} rows={rows} rowKey={(n) => n.id} loading={loading} emptyText="回收站是空的" className="min-h-0 flex-1" />
    </div>
  );
}
