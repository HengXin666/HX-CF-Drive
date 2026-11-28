// 右键菜单: 在鼠标位置弹出, 样式和行内 "更多" 菜单一致 (复用 HX-UI 的 DropdownMenu)
import { type MouseEvent, type ReactNode, useCallback, useState } from 'react';
import { createPortal } from 'react-dom';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '../ui';

export interface MenuAt<T> { x: number; y: number; data: T }

/** open 放进 onContextMenu; menu 渲染在组件里任意位置 */
export function useContextMenu<T>() {
  const [at, setAt] = useState<MenuAt<T> | null>(null);
  const open = useCallback((e: MouseEvent, data: T) => {
    e.preventDefault();
    e.stopPropagation();
    setAt({ x: e.clientX, y: e.clientY, data });
  }, []);
  const close = useCallback(() => setAt(null), []);
  return { at, open, close };
}

export function ContextMenu<T>({ at, onClose, children }: { at: MenuAt<T> | null; onClose: () => void; children: (data: T) => ReactNode }) {
  return (
    <DropdownMenu open={!!at} onOpenChange={(o) => { if (!o) onClose(); }} modal={false}>
      {/* 锚点挂到 body: 在弹窗 (带 transform) 里 fixed 定位会相对弹窗偏移 */}
      {createPortal(
        <DropdownMenuTrigger asChild>
          <span aria-hidden style={{ position: 'fixed', left: at?.x ?? 0, top: at?.y ?? 0, width: 1, height: 1, pointerEvents: 'none' }} />
        </DropdownMenuTrigger>,
        document.body,
      )}
      <DropdownMenuContent align="start" side="bottom" sideOffset={2} className="min-w-44" onCloseAutoFocus={(e) => e.preventDefault()}>
        {at && children(at.data)}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
