// 目录树: 选目标目录用 (移动到)。按需展开, 展开时才去拉子目录; 版式参考 hxoa 面板的工作区树。
// HX-UI 还没有 Tree / TreeSelect (已提 issue), 先在这里自己写。
import { ChevronRight, Folder, FolderOpen, House } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { fs, joinPath } from '../lib/api';
import { cn } from '../ui';
import { ContextMenu, useContextMenu } from './ContextMenu';

interface Dir { path: string; name: string }

export function FolderTree({ value, onChange, disabled, menu }: {
  value: string;
  onChange: (path: string) => void;
  /** 不能选的目录 (及其子目录), 如被移动的目录自己 */
  disabled?: (path: string) => boolean;
  /** 右键菜单的内容; 不传则保留浏览器默认菜单 */
  menu?: (path: string, ctl: { open: boolean; toggle: () => void; disabled: boolean }) => ReactNode;
}) {
  const ctx = useContextMenu<string>();
  const [kids, setKids] = useState<Record<string, Dir[] | 'loading' | string>>({});
  // 默认展开到当前选中目录的每一级
  const [open, setOpen] = useState<Set<string>>(() => {
    const s = new Set(['/']);
    value.split('/').filter(Boolean).reduce((p, seg) => { const n = joinPath(p, seg); s.add(n); return n; }, '/');
    return s;
  });

  const load = useCallback(async (p: string) => {
    setKids((k) => ({ ...k, [p]: 'loading' }));
    try {
      const r = await fs.list(p);
      const dirs = r.children.filter((c) => c.kind === 'dir').map((c) => ({ name: c.name, path: joinPath(p, c.name) }));
      dirs.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
      setKids((k) => ({ ...k, [p]: dirs }));
    } catch (e) {
      setKids((k) => ({ ...k, [p]: (e as Error).message }));
    }
  }, []);

  useEffect(() => { for (const p of open) if (kids[p] === undefined) void load(p); }, [open, kids, load]);

  const toggle = (p: string) => setOpen((s) => {
    const n = new Set(s);
    if (n.has(p)) n.delete(p); else n.add(p);
    return n;
  });

  const row = (d: Dir, depth: number) => {
    const isOpen = open.has(d.path);
    const list = kids[d.path];
    const off = disabled?.(d.path) ?? false;
    const leaf = Array.isArray(list) && list.length === 0;
    const Ico = d.path === '/' ? House : isOpen ? FolderOpen : Folder;
    return (
      <div key={d.path}>
        <div
          role="treeitem"
          aria-selected={value === d.path}
          aria-expanded={leaf ? undefined : isOpen}
          aria-disabled={off || undefined}
          tabIndex={off ? -1 : 0}
          title={off ? '不能移到自己或自己的子目录里' : d.path}
          style={{ paddingLeft: 6 + depth * 16 }}
          onClick={() => { if (!off) onChange(d.path); }}
          onDoubleClick={() => toggle(d.path)}
          onContextMenu={menu ? (e) => ctx.open(e, d.path) : undefined}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !off) onChange(d.path);
            if (e.key === 'ArrowRight' && !isOpen) toggle(d.path);
            if (e.key === 'ArrowLeft' && isOpen) toggle(d.path);
          }}
          className={cn(
            'flex h-8 cursor-pointer items-center gap-1.5 rounded-md pr-2 text-sm transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
            value === d.path ? 'bg-accent text-accent-foreground ring-1 ring-border' : 'hover:bg-accent/60',
            off && 'cursor-not-allowed opacity-40',
          )}
        >
          <span
            role="button"
            aria-label={isOpen ? '折叠' : '展开'}
            onClick={(e) => { e.stopPropagation(); toggle(d.path); }}
            className={cn('flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground', leaf && 'invisible')}
          >
            <ChevronRight className={cn('size-3.5 transition-transform', isOpen && 'rotate-90')} />
          </span>
          <Ico className={cn('size-4 shrink-0', d.path === '/' ? 'text-muted-foreground' : 'text-amber-500 dark:text-amber-400')} />
          <span className="min-w-0 flex-1 truncate">{d.name}</span>
        </div>
        {isOpen && (
          list === 'loading' ? <div className="py-1 text-xs text-muted-foreground" style={{ paddingLeft: 34 + depth * 16 }}>加载中…</div>
            : typeof list === 'string' ? <div className="py-1 text-xs text-destructive" style={{ paddingLeft: 34 + depth * 16 }}>{list}</div>
              : list?.map((c) => row(c, depth + 1))
        )}
      </div>
    );
  };

  return (
    <div role="tree" className="flex flex-col gap-0.5">
      {row({ path: '/', name: '全部文件' }, 0)}
      {menu && (
        <ContextMenu at={ctx.at} onClose={ctx.close}>
          {(p) => menu(p, { open: open.has(p), toggle: () => toggle(p), disabled: disabled?.(p) ?? false })}
        </ContextMenu>
      )}
    </div>
  );
}
