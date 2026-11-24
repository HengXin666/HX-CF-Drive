// 演示模式下 /f 直链只存在于拦截层, img/video/下载链接不走 fetch, 需要先取成 blob URL
import { useEffect, useState } from 'react';

async function fetchBlob(url: string): Promise<Blob> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${r.status}`);
  return r.blob();
}

/** 把直链换成 blob URL, 卸载时释放 */
export function useDemoSrc(url: string | undefined): string | undefined {
  const [src, setSrc] = useState<string>();
  useEffect(() => {
    if (!url) return;
    let u = '';
    let dead = false;
    fetchBlob(url).then((b) => {
      if (dead) return;
      u = URL.createObjectURL(b);
      setSrc(u);
    }, () => setSrc(undefined));
    return () => {
      dead = true;
      if (u) URL.revokeObjectURL(u);
      setSrc(undefined);
    };
  }, [url]);
  return src;
}

/** 下载: 取成 blob 再触发保存 */
export async function demoDownload(url: string, name: string): Promise<void> {
  const b = await fetchBlob(url);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(b);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
}
