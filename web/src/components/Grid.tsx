// 网格 / 画廊视图 (#22): 图片显示原图, 复用 #20 的开关, 大小上限和缓存 (ImageCell), 不做缩略图
import type { MouseEvent, ReactNode } from 'react';
import { fileIcon } from '../icons';
import { fmtSize, type Node } from '../lib/api';
import { type ImgPrefs, wantsPreview } from '../lib/imgcache';
import { cn } from '../ui';
import { Icon } from './Icon';
import { ImageCell } from './ImageCell';

export function Grid({ rows, img, selected, onToggle, onOpen, onContextMenu, loading, empty }: {
  rows: Node[];
  img: ImgPrefs;
  selected: Set<string>;
  onToggle: (n: Node) => void;
  onOpen: (n: Node) => void;
  onContextMenu: (n: Node, e: MouseEvent) => void;
  loading?: boolean;
  empty: ReactNode;
}) {
  if (loading && !rows.length) return <div className="grid h-40 place-items-center text-muted-foreground"><Icon name="spinner" className="size-5 animate-spin" /></div>;
  if (!rows.length) return <div className="grid h-40 place-items-center rounded-xl border border-dashed text-sm text-muted-foreground">{empty}</div>;
  return (
    <ul className="grid grid-cols-2 gap-3 sm:grid-cols-[repeat(auto-fill,minmax(10rem,1fr))]" aria-label="文件网格">
      {rows.map((n) => {
        const fi = fileIcon(n.kind, n.mime, n.name);
        const icon = <Icon as={fi.icon} className={cn('size-10', fi.tone)} />;
        const on = selected.has(n.id);
        return (
          <li key={n.id} data-rk={n.id}
            className={cn('group relative flex cursor-pointer flex-col overflow-hidden rounded-xl border bg-card transition-colors hover:border-ring/60 hover:bg-accent/40', on && 'border-brand ring-1 ring-brand')}
            onClick={(e) => { if (e.ctrlKey || e.metaKey || selected.size) onToggle(n); else onOpen(n); }}
            onContextMenu={(e) => onContextMenu(n, e)}
          >
            <div className="grid aspect-square place-items-center bg-muted/30">
              {wantsPreview(n, img) ? <ImageCell node={n} fallback={icon} className="size-full rounded-none border-0" /> : icon}
            </div>
            <div className="grid gap-0.5 px-2.5 py-2">
              <span className="truncate text-sm" title={n.name}>{n.name}</span>
              <span className="truncate text-xs text-muted-foreground">{n.kind === 'dir' ? '目录' : fmtSize(n.size)}</span>
            </div>
            <button type="button" aria-label={on ? `取消选择 ${n.name}` : `选择 ${n.name}`} aria-pressed={on}
              className={cn('absolute top-2 left-2 grid size-6 place-items-center rounded-md border bg-background/80 backdrop-blur transition-opacity',
                on ? 'border-brand bg-brand text-brand-foreground opacity-100' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100 max-sm:opacity-70')}
              onClick={(e) => { e.stopPropagation(); onToggle(n); }}>
              {on && <Icon name="check" className="size-4" />}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
