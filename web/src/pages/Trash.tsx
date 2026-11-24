// 回收站: 列出已删除的顶层节点, 可恢复或彻底删除 (目录连同子项)。超期由定时维护清理
import { useCallback, useEffect, useState } from 'react';
import { Icon } from '../components/Icon';
import { Page } from '../components/Shell';
import { fileIcon } from '../icons';
import { fmtSize, fmtTime, fs, type Node, type PurgeResult } from '../lib/api';
import { Button, confirmDialog, DataTable, type DataTableColumn, toast } from '../ui';

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

  const done = (r: PurgeResult, what: string) => {
    toast.success(r.more ? `${what}; 还有 ${r.leftNodes + r.leftBlobs} 项积压, 由定时维护接着清理` : what);
  };

  const purge = async (n: Node) => {
    if (!(await confirmDialog({ title: `彻底删除 ${n.name}?`, message: '删除后不能恢复。', confirmLabel: '彻底删除', variant: 'danger' }))) return;
    try {
      done(await fs.purge(n.id), `已彻底删除 ${n.name}`);
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const empty = async () => {
    if (!(await confirmDialog({ title: '清空回收站?', message: '回收站里的所有项目都会被彻底删除, 不能恢复。', confirmLabel: '清空', variant: 'danger' }))) return;
    try {
      done(await fs.emptyTrash(), '回收站已清空');
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
    { key: 'op', header: '', width: '190px', align: 'right', render: (n) => (
      <span className="inline-flex gap-1.5">
        <Button size="xs" variant="outline" onClick={() => void restore(n)}><Icon name="restore" className="size-3.5" /> 恢复</Button>
        <Button size="xs" variant="ghost" onClick={() => void purge(n)}><Icon name="trash" className="size-3.5" /> 彻底删除</Button>
      </span>
    ) },
  ];

  return (
    <Page title="回收站" right={(
      <span className="flex items-center gap-3">
        <span className="text-[12.5px] text-muted-foreground">保留 7 天, 之后由定时维护彻底清理</span>
        <Button size="xs" variant="outline" disabled={!rows.length} onClick={() => void empty()}><Icon name="trash" className="size-3.5" /> 清空</Button>
      </span>
    )}>
      <DataTable columns={columns} rows={rows} rowKey={(n) => n.id} loading={loading} emptyText="回收站是空的" />
    </Page>
  );
}
