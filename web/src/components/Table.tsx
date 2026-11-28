// 表格: 包一层 HX-UI 的 DataTable (TanStack), 列用 key / header / render 描述, 可选标题与右上角操作。
// 列宽与对齐库里还不支持 (已提 issue), 先在单元格里自己对齐。
import { type ColumnDef, DataTable as HxTable } from '@hx/ui/data';
import { type MouseEvent, type ReactNode, useEffect, useMemo, useState } from 'react';
import type { IconName } from '../icons';
import { cn } from '../ui';
import { Icon } from './Icon';

export interface Column<T> {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
  /** 给了就能点表头排序 */
  sort?: (row: T) => string | number;
  align?: 'right';
  className?: string;
  /** 窄屏 (< 640px) 不显示这一列; 需要的信息请在别的列里用 sm:hidden 补上 */
  hideOnMobile?: boolean;
}

function useNarrow() {
  const q = '(max-width: 639px)';
  const [narrow, setNarrow] = useState(() => matchMedia(q).matches);
  useEffect(() => {
    const m = matchMedia(q);
    const f = () => setNarrow(m.matches);
    m.addEventListener('change', f);
    return () => m.removeEventListener('change', f);
  }, []);
  return narrow;
}

export function DataTable<T>(props: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  loading?: boolean;
  emptyText?: string;
  emptyIcon?: IconName;
  onRowClick?: (row: T) => void;
  /** 右键某一行; 不传则保留浏览器默认菜单 */
  onRowContextMenu?: (row: T, e: MouseEvent) => void;
  title?: string;
  description?: string;
  actions?: ReactNode;
  /** 表格上方右侧的按钮; 多选时被批量操作条盖住 */
  toolbar?: ReactNode;
  selectable?: boolean;
  bulkActions?: (rows: T[], clear: () => void) => ReactNode;
  pageSize?: number;
}) {
  const narrow = useNarrow();
  const cols = useMemo<ColumnDef<T, unknown>[]>(() => props.columns.filter((c) => !(narrow && c.hideOnMobile)).map((c) => ({
    id: c.key,
    header: () => <span className={cn(c.align === 'right' && 'block w-full text-right')}>{c.header}</span>,
    ...(c.sort ? { accessorFn: c.sort, enableSorting: true } : { enableSorting: false }),
    cell: ({ row }) => <div data-rk={props.rowKey(row.original)} className={cn(c.align === 'right' && 'flex justify-end', c.className)}>{c.render(row.original)}</div>,
  })), [props.columns, narrow]);
  const table = (
    <HxTable<T>
      data={props.rows}
      columns={cols}
      getRowId={(r) => props.rowKey(r)}
      loading={props.loading}
      empty={(
        <span className="flex flex-col items-center gap-2">
          <span className="grid size-10 place-items-center rounded-full border bg-muted/40"><Icon name={props.emptyIcon ?? 'folder'} className="size-4.5" /></span>
          {props.emptyText}
        </span>
      )}
      onRowClick={props.onRowClick}
      selectable={props.selectable}
      bulkActions={props.bulkActions}
      toolbar={props.toolbar}
      pageSize={props.pageSize ?? 50}
      density="compact"
      aria-label={props.title}
    />
  );
  // 右键: 从事件目标找到所在行 (单元格里带了 data-rk), 空白处交给外层
  const ctx = props.onRowContextMenu;
  const body = ctx ? (
    <div onContextMenu={(e) => {
      const k = (e.target as HTMLElement).closest('tr')?.querySelector<HTMLElement>('[data-rk]')?.dataset.rk;
      const r = k === undefined ? undefined : props.rows.find((x) => props.rowKey(x) === k);
      if (r) ctx(r, e);
    }}>{table}</div>
  ) : table;
  if (!props.title && !props.actions) return body;
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-end gap-3">
        <div className="min-w-0 flex-1">
          {props.title && <h2 className="text-sm font-medium">{props.title}</h2>}
          {props.description && <p className="mt-0.5 text-xs text-muted-foreground">{props.description}</p>}
        </div>
        {props.actions}
      </div>
      {body}
    </section>
  );
}
