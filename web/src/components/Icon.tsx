// 图标与纯图标按钮。按钮带 aria-label 与悬停提示, 颜色跟随文字色
import type { LucideIcon } from 'lucide-react';
import { ICON, type IconName } from '../icons';
import { Button, cn, Tooltip, TooltipContent, TooltipTrigger } from '../ui';

export function Icon({ name, as, className }: { name?: IconName; as?: LucideIcon; className?: string }) {
  const C = as ?? (name ? ICON[name] : null);
  return C ? <C aria-hidden className={cn('size-4 shrink-0', className)} /> : null;
}

export function IconButton({ name, label, onClick, danger }: { name: IconName; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label={label}
          onClick={(e) => { e.stopPropagation(); onClick(); }}
          className={cn('text-muted-foreground hover:text-foreground', danger && 'hover:text-destructive')}
        >
          <Icon name={name} />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
