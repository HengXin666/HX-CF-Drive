// 收藏 (#22): 按令牌各自收藏的文件和目录。点目录进入, 点文件打开所在目录
import { useCallback, useEffect, useState } from 'react';
import { Icon } from '../components/Icon';
import { Meta, Page } from '../components/Shell';
import { type Column, DataTable } from '../components/Table';
import { fileIcon } from '../icons';
import { fmtSize, fmtTime, fs, type Node } from '../lib/api';
import { Button, toast } from '../ui';

type Row = Node & { path: string; starredAt: number };
const parentOf = (p: string) => p.slice(0, p.lastIndexOf('/')) || '/';

export function Stars({ go }: { go: (path: string) => void }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows((await fs.stars()).items);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const unstar = async (items: Row[], clear?: () => void) => {
    try {
      for (const n of items) await fs.star(n.id, false);
      toast.success(items.length > 1 ? `已取消 ${items.length} 个收藏` : `已取消收藏 ${items[0].name}`);
      clear?.();
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const open = (n: Row) => go(n.kind === 'dir' ? n.path : parentOf(n.path));

  const columns: Column<Row>[] = [
    { key: 'name', header: '名称', sort: (n) => n.name.toLowerCase(), render: (n) => {
      const fi = fileIcon(n.kind, n.mime, n.name);
      return (
        <span className="flex min-w-0 items-center gap-2.5">
          <Icon as={fi.icon} className={fi.tone} />
          <span className="grid min-w-0">
            <span className="truncate">{n.name}</span>
            <span className="truncate font-mono text-xs text-muted-foreground">{parentOf(n.path)}</span>
          </span>
        </span>
      );
    } },
    { key: 'size', header: '大小', align: 'right', hideOnMobile: true, sort: (n) => n.size,
      render: (n) => <span className="tabular-nums text-muted-foreground">{n.kind === 'dir' ? '—' : fmtSize(n.size)}</span> },
    { key: 'at', header: '收藏时间', hideOnMobile: true, sort: (n) => n.starredAt,
      render: (n) => <span className="whitespace-nowrap tabular-nums text-muted-foreground">{fmtTime(n.starredAt)}</span> },
    { key: 'op', header: '', align: 'right', render: (n) => (
      <span className="inline-flex gap-1.5" onClick={(e) => e.stopPropagation()}>
        <Button size="xs" variant="outline" onClick={() => open(n)}><Icon name="folder" /><span className="hidden sm:inline">打开位置</span></Button>
        <Button size="xs" variant="ghost" className="text-muted-foreground" aria-label="取消收藏" onClick={() => void unstar([n])}><Icon name="starOff" /></Button>
      </span>
    ) },
  ];

  return (
    <Page
      eyebrow={<span>网盘 / <span className="text-foreground">stars</span></span>}
      icon="star"
      title="收藏"
      meta={<><Meta icon="star">{rows.length} 项</Meta><span className="hidden sm:inline">每个令牌各自收藏</span></>}
    >
      <DataTable columns={columns} rows={rows} rowKey={(n) => n.id} loading={loading} emptyText="还没有收藏, 在文件列表里右键加星" emptyIcon="star" selectable
        onRowClick={open}
        bulkActions={(sel, clear) => (
          <Button size="sm" variant="outline" aria-label="取消收藏所选" onClick={() => void unstar(sel, clear)}><Icon name="starOff" /><span className="hidden sm:inline">取消收藏</span></Button>
        )} />
    </Page>
  );
}
