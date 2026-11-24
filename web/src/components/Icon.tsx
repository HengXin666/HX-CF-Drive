// SVG 图标 (Iconify Solar 蒙版), 颜色跟随文字色
import { ICON, type IconName } from '../icons';

export function Icon({ name, raw, className = 'size-4' }: { name?: IconName; raw?: string; className?: string }) {
  return <span aria-hidden className={`inline-block shrink-0 bg-current align-[-0.2em] ${raw ?? (name ? ICON[name] : '')} ${className}`} />;
}

// 只有图标的按钮, 自带 aria-label 与悬停提示
export function IconButton({ name, label, onClick, danger }: { name: IconName; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      className={`grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground ${danger ? 'hover:text-danger-fg' : ''}`}
    >
      <Icon name={name} />
    </button>
  );
}
