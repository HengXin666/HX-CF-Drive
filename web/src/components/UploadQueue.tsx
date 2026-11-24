// 上传队列: 逐个文件上传, 显示哈希/上传进度, 失败可重试 (已传分片不重传)
import { Button, Progress } from '../ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, fmtSize } from '../lib/api';
import { type Progress as P, uploadFile, type UploadOpts } from '../lib/transfer';

interface Item { id: number; file: File; dir: string; p: P; opts?: UploadOpts; error?: string; conflict?: boolean }

// 同名时 "保留两者": a.png -> a (1).png
const copyName = (n: string) => n.replace(/(\.[^.]*)?$/, (ext) => ` (${Date.now() % 1000})${ext}`);

let seq = 0;

export function useUploadQueue(onDone: () => void) {
  const [items, setItems] = useState<Item[]>([]);
  const running = useRef(false);
  const queue = useRef<Item[]>([]);

  const patch = (id: number, d: Partial<Item>) => setItems((list) => list.map((x) => (x.id === id ? { ...x, ...d } : x)));

  const pump = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    for (let it = queue.current.shift(); it; it = queue.current.shift()) {
      const cur = it;
      try {
        await uploadFile(cur.file, cur.dir, (p) => patch(cur.id, { p }), cur.opts);
        onDone();
      } catch (e) {
        const conflict = e instanceof ApiError && e.status === 409;
        patch(cur.id, { p: { phase: 'error', ratio: 0 }, conflict, error: conflict ? '已有同名文件' : (e as Error).message });
      }
    }
    running.current = false;
  }, [onDone]);

  const add = useCallback((files: File[], dir: string) => {
    const fresh = files.map((file) => ({ id: ++seq, file, dir, p: { phase: 'hash', ratio: 0 } as P }));
    setItems((list) => [...list, ...fresh]);
    queue.current.push(...fresh);
    void pump();
  }, [pump]);

  const retry = (it: Item, opts?: UploadOpts) => {
    const again = { ...it, opts: opts ?? it.opts, error: undefined, conflict: false, p: { phase: 'upload', ratio: 0 } as P };
    patch(it.id, again);
    queue.current.push(again);
    void pump();
  };
  const clearDone = () => setItems((list) => list.filter((x) => x.p.phase !== 'done'));

  return { items, add, retry, clearDone };
}

const PHASE: Record<P['phase'], string> = { hash: '计算哈希', upload: '上传中', done: '完成', error: '失败' };

export function UploadQueue({ q }: { q: ReturnType<typeof useUploadQueue> }) {
  const [open, setOpen] = useState(true);
  useEffect(() => { if (q.items.some((x) => x.p.phase !== 'done')) setOpen(true); }, [q.items]);
  if (!q.items.length) return null;
  return (
    <div className="fixed bottom-4 right-4 z-40 w-96 rounded-xl border border-border bg-background p-3 shadow-lg">
      <div className="mb-2 flex items-center justify-between text-sm font-medium">
        <span>上传 ({q.items.filter((x) => x.p.phase === 'done').length}/{q.items.length})</span>
        <div className="flex gap-1">
          <Button size="xs" variant="ghost" onClick={q.clearDone}>清除已完成</Button>
          <Button size="xs" variant="ghost" onClick={() => setOpen(!open)}>{open ? '收起' : '展开'}</Button>
        </div>
      </div>
      {open && (
        <ul className="flex max-h-72 flex-col gap-2 overflow-auto">
          {q.items.map((it) => (
            <li key={it.id} className="text-xs">
              <div className="flex justify-between gap-2">
                <span className="truncate">{it.opts?.name ?? it.file.name}</span>
                <span className="shrink-0 text-muted-foreground">
                  {fmtSize(it.file.size)} · {it.p.note ?? PHASE[it.p.phase]}
                </span>
              </div>
              {it.p.phase !== 'done' && <Progress className="mt-1" value={it.p.ratio * 100} />}
              {it.error && (
                <div className="mt-1 flex items-center justify-between gap-2 text-danger-fg">
                  <span className="truncate">{it.error}</span>
                  <div className="flex shrink-0 gap-1">
                    {it.conflict ? (
                      <>
                        <Button size="xs" variant="outline" onClick={() => q.retry(it, { overwrite: true })}>覆盖</Button>
                        <Button size="xs" variant="outline" onClick={() => q.retry(it, { name: copyName(it.file.name) })}>保留两者</Button>
                      </>
                    ) : (
                      <Button size="xs" variant="outline" onClick={() => q.retry(it)}>重试</Button>
                    )}
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
