// 回收站: 列出已删除的顶层节点, 可恢复或彻底删除 (目录连同子项)。超期由定时维护清理
import { useCallback, useEffect, useState } from 'react';
import { Icon } from '../components/Icon';
import { Meta, Page } from '../components/Shell';
import { type Column, DataTable } from '../components/Table';
import { fileIcon } from '../icons';
import { fmtSize, fmtTime, fs, type Node, type PurgeResult } from '../lib/api';
import { Button, confirmDialog, toast } from '../ui';

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
    if (!(await confirmDialog({ title: `彻底删除 ${n.name}?`, message: '删除后不能恢复。', confirmLabel: '彻底删除', danger: true }))) return;
    try {
      done(await fs.purge(n.id), `已彻底删除 ${n.name}`);
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const empty = async () => {
    if (!(await confirmDialog({
      title: '清空回收站?', message: '回收站里的所有项目都会被彻底删除, 不能恢复。', confirmLabel: '清空', danger: true, confirmText: '清空回收站',
    }))) return;
    try {
      done(await fs.emptyTrash(), '回收站已清空');
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const columns: Column<Node>[] = [
    { key: 'name', header: '名称', sort: (n) => n.name.toLowerCase(), render: (n) => {
      const fi = fileIcon(n.kind, n.mime, n.name);
      return <span className="flex min-w-0 items-center gap-2.5"><Icon as={fi.icon} className={fi.tone} /><span className="truncate">{n.name}</span></span>;
    } },
    { key: 'size', header: '大小', align: 'right', hideOnMobile: true, sort: (n) => n.size,
      render: (n) => <span className="tabular-nums text-muted-foreground">{n.kind === 'dir' ? '—' : fmtSize(n.size)}</span> },
    { key: 'at', header: '删除时间', hideOnMobile: true, sort: (n) => n.deletedAt ?? 0,
      render: (n) => <span className="whitespace-nowrap tabular-nums text-muted-foreground">{n.deletedAt ? fmtTime(n.deletedAt) : ''}</span> },
    { key: 'op', header: '', align: 'right', render: (n) => (
      <span className="inline-flex gap-1.5">
        <Button size="xs" variant="outline" onClick={() => void restore(n)}><Icon name="restore" /><span className="hidden sm:inline">恢复</span></Button>
        <Button size="xs" variant="ghost" className="text-muted-foreground hover:text-destructive" onClick={() => void purge(n)}><Icon name="trash" /><span className="hidden sm:inline">彻底删除</span></Button>
      </span>
    ) },
  ];

  return (
    <Page
      eyebrow={<span>网盘 / <span className="text-foreground">trash</span></span>}
      icon="trash"
      title="回收站"
      meta={<><Meta icon="fileText">{rows.length} 项</Meta><Meta icon="restore">保留 7 天</Meta></>}
      right={<Button size="sm" variant="outline" disabled={!rows.length} onClick={() => void empty()}><Icon name="trash" /><span className="hidden sm:inline">清空</span></Button>}
    >
      <DataTable columns={columns} rows={rows} rowKey={(n) => n.id} loading={loading} emptyText="回收站是空的" emptyIcon="trash" />
    </Page>
  );
}
