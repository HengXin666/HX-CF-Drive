// HX-UI 2 的适配层: 页面只从这里引组件, 换库或补库里缺的东西都在这一个文件里改。
// 组件按入口单独引 (@hx/ui/ui/<name>), 不引根入口, 免得把图表和动效一起打进来。
import { Button as HxButton } from '@hx/ui/ui/button';
import { ConfirmDialog } from '@hx/ui/ui/confirm-dialog';
import { Loader2 } from 'lucide-react';
import { type ComponentProps, useEffect, useState } from 'react';

export { Backdrop } from '@hx/ui/effects/backdrop';
export { Badge } from '@hx/ui/ui/badge';
export { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@hx/ui/ui/card';
export { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@hx/ui/ui/dialog';
export {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@hx/ui/ui/dropdown-menu';
export { Field } from '@hx/ui/ui/field';
export { Input } from '@hx/ui/ui/input';
export { Progress } from '@hx/ui/ui/progress';
export { Slider } from '@hx/ui/ui/slider';
export { Switch } from '@hx/ui/ui/switch';
export { Textarea } from '@hx/ui/ui/textarea';
export { ToggleGroup, ToggleGroupItem } from '@hx/ui/ui/toggle-group';
export { Toaster } from '@hx/ui/ui/sonner';
export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@hx/ui/ui/tooltip';
export { toast } from 'sonner';
export { cn } from '@hx/ui/utils';

/** 库里的 Button 加一个 loading: 转圈并禁用 */
export function Button({ loading, disabled, children, ...props }: ComponentProps<typeof HxButton> & { loading?: boolean }) {
  return (
    <HxButton disabled={disabled || loading} {...props}>
      {loading && <Loader2 className="animate-spin" />}
      {children}
    </HxButton>
  );
}

export interface ConfirmOptions {
  title: string;
  message?: string;
  confirmLabel?: string;
  danger?: boolean;
  /** 要求输入这段文字才能确认 (如目录名), 防手滑 */
  confirmText?: string;
}

// 命令式确认框: await confirmDialog({...}) 得到 true / false。宿主 <ConfirmDialogHost /> 放在外壳里一次
type Pending = ConfirmOptions & { resolve: (ok: boolean) => void };
let push: ((p: Pending | null) => void) | null = null;

export function confirmDialog(o: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    if (!push) { resolve(window.confirm(o.title)); return; }
    push({ ...o, resolve });
  });
}

export function ConfirmDialogHost() {
  const [cur, setCur] = useState<Pending | null>(null);
  useEffect(() => {
    push = setCur;
    return () => { push = null; };
  }, []);
  const close = (ok: boolean) => {
    cur?.resolve(ok);
    setCur(null);
  };
  return (
    <ConfirmDialog
      open={!!cur}
      onOpenChange={(o) => { if (!o) close(false); }}
      title={cur?.title ?? ''}
      description={cur?.message}
      confirmLabel={cur?.confirmLabel ?? '确定'}
      cancelLabel="取消"
      tone={cur?.danger ? 'destructive' : 'default'}
      confirmText={cur?.confirmText}
      onConfirm={() => close(true)}
    />
  );
}
