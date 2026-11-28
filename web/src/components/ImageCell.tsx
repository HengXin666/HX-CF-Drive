// 列表里的图片原图 (#20): 滚到可见区域才加载, 加载过的留在缓存里给预览和下载复用
import { type ReactNode, useEffect, useRef, useState } from 'react';
import type { Node } from '../lib/api';
import { load, peek } from '../lib/imgcache';
import { cn } from '../ui';
import { Icon } from './Icon';

export function ImageCell({ node, fallback, className }: { node: Node; fallback: ReactNode; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [src, setSrc] = useState(() => peek(node));
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (src || failed || !ref.current) return;
    let dead = false;
    const io = new IntersectionObserver((es) => {
      if (!es.some((e) => e.isIntersecting)) return;
      io.disconnect();
      setBusy(true);
      load(node).then((u) => { if (!dead) setSrc(u); }, () => { if (!dead) setFailed(true); });
    }, { rootMargin: '600px' });
    io.observe(ref.current);
    return () => { dead = true; io.disconnect(); };
  }, [node, src, failed]);
  if (failed) return <>{fallback}</>;
  return (
    <span ref={ref} className={cn('grid size-12 shrink-0 place-items-center overflow-hidden rounded-md border bg-muted/40', className)}>
      {src ? <img src={src} alt="" decoding="async" draggable={false} className="size-full object-cover" />
        : busy ? <Icon name="spinner" className="size-4 animate-spin text-muted-foreground" /> : fallback}
    </span>
  );
}
