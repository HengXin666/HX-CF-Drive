// 上传与大文件下载。上传进度 (凭证 + 回执) 存 localStorage, 刷新后重传同一文件自动续传
import { api, auth } from './api';
import { sha256File } from './sha256';

export interface Progress { phase: 'hash' | 'upload' | 'done' | 'error'; ratio: number; note?: string }

interface State { ticket: string; chunkSize: number; chunkCount: number; receipts: Record<number, string> }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function uploadFile(file: File, dir: string, onProgress: (p: Progress) => void, concurrency = 2): Promise<void> {
  const key = `hxd_up:${dir}:${file.name}:${file.size}:${file.lastModified}`;
  let state = JSON.parse(localStorage.getItem(key) ?? 'null') as State | null;
  if (!state) {
    const sha256 = file.size ? await sha256File(file, (r) => onProgress({ phase: 'hash', ratio: r })) : undefined;
    const init = await api<{ done: boolean; ticket: string; chunkSize: number; chunkCount: number }>('POST', '/uploads', {
      path: dir, name: file.name, size: file.size, mime: file.type || undefined, sha256,
    });
    if (init.done) { onProgress({ phase: 'done', ratio: 1, note: file.size ? '秒传' : undefined }); return; }
    state = { ticket: init.ticket, chunkSize: init.chunkSize, chunkCount: init.chunkCount, receipts: {} };
    localStorage.setItem(key, JSON.stringify(state));
  }
  const st = state;
  const todo: number[] = [];
  for (let i = 0; i < st.chunkCount; i++) if (!st.receipts[i]) todo.push(i);
  let done = st.chunkCount - todo.length;
  onProgress({ phase: 'upload', ratio: done / st.chunkCount });
  // 并发不宜大: TG 单频道约 20 条/分, 超了服务端回 429, 这里按 Retry-After 等
  const worker = async () => {
    for (let i = todo.shift(); i !== undefined; i = todo.shift()) {
      const body = file.slice(i * st.chunkSize, (i + 1) * st.chunkSize);
      for (let tries = 0; ; tries++) {
        const r = await fetch(`/api/v1/uploads/chunk?i=${i}&ticket=${encodeURIComponent(st.ticket)}`, {
          method: 'PUT', headers: { Authorization: `Bearer ${auth.get()}` }, body,
        }).catch(() => null);
        if (r?.ok) { st.receipts[i] = ((await r.json()) as { receipt: string }).receipt; break; }
        const status = r?.status ?? 0;
        if (status === 400 || status === 403 || tries >= 8) throw new Error(`分片 ${i} 失败: ${status} ${r ? await r.text() : ''}`);
        await sleep(Number(r?.headers.get('Retry-After') || 2 ** Math.min(tries, 5)) * 1000);
      }
      localStorage.setItem(key, JSON.stringify(st));
      onProgress({ phase: 'upload', ratio: ++done / st.chunkCount });
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, st.chunkCount) }, worker));
  await api('POST', '/uploads/commit', { ticket: st.ticket, receipts: Object.values(st.receipts) });
  localStorage.removeItem(key);
  onProgress({ phase: 'done', ratio: 1 });
}

type SavePicker = (o: { suggestedName: string }) => Promise<{ createWritable: () => Promise<WritableStream & { close(): Promise<void>; abort(): Promise<void> }> }>;

/**
 * 下载。服务端单次响应只拼得下有限个分片 (Free 计划冷读约 456 MB), 超出部分 206 截断。
 * 支持 File System Access API 时按 Content-Range 一段段续拉写入本地; 否则交给浏览器普通下载。
 */
export async function download(url: string, name: string, size: number, onProgress: (r: number) => void): Promise<void> {
  const picker = (window as unknown as { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
  const big = size > 400 * 1024 * 1024;
  if (!picker || !big) {
    const a = document.createElement('a');
    a.href = url + (url.includes('?') ? '&' : '?') + 'download=1';
    a.download = name;
    a.click();
    return;
  }
  const out = await (await picker({ suggestedName: name })).createWritable();
  let pos = 0;
  try {
    while (pos < size) {
      const r = await fetch(url, { headers: { Range: `bytes=${pos}-` } });
      if ((r.status !== 206 && r.status !== 200) || !r.body) throw new Error(`下载失败 ${r.status}`);
      const m = /bytes (\d+)-(\d+)\//.exec(r.headers.get('Content-Range') ?? '');
      const end = m ? Number(m[2]) : size - 1;
      await r.body.pipeTo(out, { preventClose: true });
      pos = end + 1;
      onProgress(pos / size);
    }
    await out.close();
  } catch (e) {
    await out.abort();
    throw e;
  }
}
