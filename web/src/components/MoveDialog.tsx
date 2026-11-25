// 移动到: 左边目录树选目标, 底部显示将要移到的完整路径
import { useEffect, useState } from 'react';
import type { Node } from '../lib/api';
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui';
import { FolderTree } from './FolderTree';

const within = (p: string, dir: string) => dir === '/' || p === dir || p.startsWith(dir + '/');

export function MoveDialog({ nodes, from, onClose, onMove }: {
  /** 要移动的项目; 为空时不显示 */
  nodes: (Node & { fullPath: string })[] | null;
  /** 它们现在所在的目录 */
  from: string;
  onClose: () => void;
  onMove: (to: string) => Promise<void>;
}) {
  const [to, setTo] = useState(from);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { setTo(from); setErr(''); }, [nodes, from]);
  const dirs = (nodes ?? []).filter((n) => n.kind === 'dir').map((n) => n.fullPath);
  const label = nodes?.length === 1 ? nodes[0].name : `${nodes?.length ?? 0} 个项目`;

  const submit = async () => {
    setBusy(true);
    setErr('');
    try {
      await onMove(to);
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={!!nodes} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>移动 {label}</DialogTitle>
          <DialogDescription>选择目标目录, 双击或点箭头展开。</DialogDescription>
        </DialogHeader>
        <div className="max-h-80 overflow-y-auto rounded-lg border bg-background/50 p-1.5">
          <FolderTree value={to} onChange={setTo} disabled={(p) => dirs.some((d) => within(p, d))} />
        </div>
        <p className="truncate font-mono text-xs text-muted-foreground">
          {from} <span className="px-1">→</span> <span className="text-foreground">{to}</span>
        </p>
        {err && <p className="text-sm text-destructive">{err}</p>}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button loading={busy} disabled={to === from} onClick={() => void submit()}>移动到这里</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
