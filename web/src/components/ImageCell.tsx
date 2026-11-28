// 列表里的图片原图 (#20): 滚到可见区域才加载, 加载过的留在缓存里给预览和下载复用
import { type ReactNode, useEffect, useRef, useState } from 'react';
import type { Node } from '../lib/api';
import { load, peek } from '../lib/imgcache';

export function ImageCell({ node, fallback }: { node: Node; fallback: ReactNode }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [src, setSrc] = useState(() => peek(node));
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (src || failed || !ref.current) return;
    let dead = false;
    const io = new IntersectionObserver((es) => {
      if (!es.some((e) => e.isIntersecting)) return;
      io.disconnect();
      load(node).then((u) => { if (!dead) setSrc(u); }, () => { if (!dead) setFailed(true); });
    }, { rootMargin: '200px' });
    io.observe(ref.current);
    return () => { dead = true; io.disconnect(); };
  }, [node, src, failed]);
  if (failed) return <>{fallback}</>;
  return (
    <span ref={ref} className="grid size-12 shrink-0 place-items-center overflow-hidden rounded-md border bg-muted/40">
      {src ? <img src={src} alt="" decoding="async" draggable={false} className="size-full object-cover" /> : fallback}
    </span>
  );
}
