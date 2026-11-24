// 回收站: 列出已删除的顶层节点, 可恢复 (目录连同子项)。超期由每日定时任务清理
import { useCallback, useEffect, useState } from 'react';
import { Icon } from '../components/Icon';
import { Page } from '../components/Shell';
import { fileIcon } from '../icons';
import { fmtSize, fmtTime, fs, type Node } from '../lib/api';
import { Button, DataTable, type DataTableColumn, toast } from '../ui';

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

  const restore = async (n: Node) => {
    try {
      await fs.restore(n.id);
      toast.success(`已恢复 ${n.name}`);
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const columns: DataTableColumn<Node>[] = [
    { key: 'name', header: '名称', render: (n) => {
      const fi = fileIcon(n.kind, n.mime, n.name);
      return <span className="flex items-center gap-2.5"><Icon raw={fi.icon} className={`size-[18px] ${fi.tone}`} />{n.name}</span>;
    } },
    { key: 'size', header: '大小', width: '100px', numeric: true, render: (n) => (n.kind === 'dir' ? '-' : fmtSize(n.size)) },
    { key: 'at', header: '删除时间', width: '170px', render: (n) => <span className="text-muted-foreground tabular-nums">{n.deletedAt ? fmtTime(n.deletedAt) : ''}</span> },
    { key: 'op', header: '', width: '90px', align: 'right', render: (n) => (
      <Button size="xs" variant="outline" onClick={() => void restore(n)}><Icon name="restore" className="size-3.5" /> 恢复</Button>
    ) },
  ];

  return (
    <Page title="回收站" right={<span className="text-[12.5px] text-muted-foreground">保留 7 天, 之后由每日维护彻底清理</span>}>
      <DataTable columns={columns} rows={rows} rowKey={(n) => n.id} loading={loading} emptyText="回收站是空的" />
    </Page>
  );
}
