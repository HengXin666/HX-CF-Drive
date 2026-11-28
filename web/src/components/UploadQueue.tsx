// 上传队列: 文件级并发 (默认 2), 显示哈希/上传进度, 失败可重试 (已传分片不重传)
// 状态放在模块级 store 里 (useSyncExternalStore), 只有队列面板订阅: 进度事件不会让文件页整表重渲染 (#23)。
// 进度刷新节流到每秒 4 次; 每个文件传完把服务端返回的节点交给文件页插进列表, 不再重新列目录。
import { Button, Progress } from '../ui';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { ApiError, fmtSize, type Node } from '../lib/api';
import { type Progress as P, uploadFile, type UploadOpts } from '../lib/transfer';

export interface Item { id: number; file: File; dir: string; p: P; opts?: UploadOpts; error?: string; conflict?: boolean }

// 同名时 "保留两者": a.png -> a (1).png
const copyName = (n: string) => n.replace(/(\.[^.]*)?$/, (ext) => ` (${Date.now() % 1000})${ext}`);

/** 同时上传几个文件。可在控制台 localStorage.hxd_upload_parallel = 1~4 调整; 太大会更快撞上 TG 限流 (429 会按 Retry-After 退避) */
const parallel = () => Math.min(4, Math.max(1, Number(localStorage.getItem('hxd_upload_parallel')) || 2));
const TICK = 250;

interface Handlers { onUploaded?: (node: Node, dir: string) => void; onIdle?: () => void }

let seq = 0;
let items: Item[] = [];
const waiting: Item[] = [];
let active = 0;
let handlers: Handlers = {};
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;

function emit(now = false) {
  if (now) {
    if (timer) { clearTimeout(timer); timer = null; }
    listeners.forEach((f) => f());
  } else if (!timer) {
    timer = setTimeout(() => { timer = null; listeners.forEach((f) => f()); }, TICK);
  }
}

function patch(id: number, d: Partial<Item>, now = true) {
  items = items.map((x) => (x.id === id ? { ...x, ...d } : x));
  emit(now);
}

function pump() {
  while (active < parallel() && waiting.length) {
    const cur = waiting.shift()!;
    active++;
    let phase = cur.p.phase;
    void uploadFile(cur.file, cur.dir, (p) => {
      // 阶段变化立刻显示, 进度百分比节流
      patch(cur.id, { p }, p.phase !== phase);
      phase = p.phase;
    }, cur.opts).then((node) => {
      if (node) handlers.onUploaded?.(node, cur.dir);
    }, (e) => {
      const conflict = e instanceof ApiError && e.status === 409;
      patch(cur.id, { p: { phase: 'error', ratio: 0 }, conflict, error: conflict ? '已有同名文件' : (e as Error).message });
    }).finally(() => {
      active--;
      if (!active && !waiting.length) handlers.onIdle?.();
      pump();
    });
  }
}

export const uploads = {
  add(files: File[], dir: string) {
    const fresh = files.map((file) => ({ id: ++seq, file, dir, p: { phase: 'hash', ratio: 0 } as P }));
    items = [...items, ...fresh];
    waiting.push(...fresh);
    emit(true);
    pump();
  },
  retry(it: Item, opts?: UploadOpts) {
    const again = { ...it, opts: opts ?? it.opts, error: undefined, conflict: false, p: { phase: 'upload', ratio: 0 } as P };
    patch(it.id, again);
    waiting.push(again);
    pump();
  },
  clearDone() {
    items = items.filter((x) => x.p.phase !== 'done');
    emit(true);
  },
  /** 文件页挂载时登记回调, 返回注销函数 */
  bind(h: Handlers) {
    handlers = h;
    return () => { if (handlers === h) handlers = {}; };
  },
};

const subscribe = (f: () => void) => { listeners.add(f); return () => { listeners.delete(f); }; };
const snapshot = () => items;

const PHASE: Record<P['phase'], string> = { hash: '计算哈希', upload: '上传中', done: '完成', error: '失败' };

export function UploadQueue() {
  const list = useSyncExternalStore(subscribe, snapshot);
  const [open, setOpen] = useState(true);
  useEffect(() => { if (list.some((x) => x.p.phase !== 'done')) setOpen(true); }, [list]);
  if (!list.length) return null;
  return (
    <div className="fixed inset-x-2 bottom-2 z-40 sm:inset-x-auto sm:right-4 sm:bottom-4 sm:w-96 rounded-xl border bg-popover p-3 text-popover-foreground shadow-float">
      <div className="mb-2 flex items-center justify-between text-sm font-medium">
        <span>上传 ({list.filter((x) => x.p.phase === 'done').length}/{list.length})</span>
        <div className="flex gap-1">
          <Button size="xs" variant="ghost" onClick={uploads.clearDone}>清除已完成</Button>
          <Button size="xs" variant="ghost" onClick={() => setOpen(!open)}>{open ? '收起' : '展开'}</Button>
        </div>
      </div>
      {open && (
        <ul className="flex max-h-72 flex-col gap-2 overflow-auto">
          {list.map((it) => (
            <li key={it.id} className="text-xs">
              <div className="flex justify-between gap-2">
                <span className="truncate">{it.opts?.name ?? it.file.name}</span>
                <span className="shrink-0 font-mono text-muted-foreground">
                  {fmtSize(it.file.size)} · {it.p.note ?? PHASE[it.p.phase]}
                </span>
              </div>
              {it.p.phase !== 'done' && <Progress className="mt-1.5" size="sm" tone={it.error ? 'destructive' : 'default'} value={it.p.ratio * 100} />}
              {it.error && (
                <div className="mt-1 flex items-center justify-between gap-2 text-destructive">
                  <span className="truncate">{it.error}</span>
                  <div className="flex shrink-0 gap-1">
                    {it.conflict ? (
                      <>
                        <Button size="xs" variant="outline" onClick={() => uploads.retry(it, { overwrite: true })}>覆盖</Button>
                        <Button size="xs" variant="outline" onClick={() => uploads.retry(it, { name: copyName(it.file.name) })}>保留两者</Button>
                      </>
                    ) : (
                      <Button size="xs" variant="outline" onClick={() => uploads.retry(it)}>重试</Button>
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
