// 粘贴上传与文件夹上传 (#22): 把剪贴板, 拖放的文件夹, 目录选择器里的文件展开成 (文件, 目标目录) 列表。
// 服务端上传接口本来就按 path 自动 mkdir -p, 所以保留层级只要给每个文件算好目标目录; 空目录单独建。
import { joinPath } from './api';

export interface Picked { file: File; dir: string }

/** 相对路径 'a/b/c.txt' 的目录部分拼到 base 下 */
const dirOf = (base: string, rel: string) => {
  const parts = rel.split('/').filter(Boolean);
  parts.pop();
  return parts.reduce((d, p) => joinPath(d, p), base);
};

/** 目录选择器 (webkitdirectory) 选出的文件带 webkitRelativePath, 形如 '相册/2026/a.png' */
export function fromInput(files: FileList | File[], base: string): Picked[] {
  return [...files].map((file) => ({ file, dir: file.webkitRelativePath ? dirOf(base, file.webkitRelativePath) : base }));
}

/** readEntries 一次最多给 100 项, 要读到空为止 */
function readAll(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => {
    const out: FileSystemEntry[] = [];
    const step = () => reader.readEntries((batch) => {
      if (!batch.length) { resolve(out); return; }
      out.push(...batch);
      step();
    }, reject);
    step();
  });
}

const fileOf = (e: FileSystemFileEntry) => new Promise<File>((resolve, reject) => e.file(resolve, reject));

/**
 * 拖放: 有文件夹时递归展开 (webkitGetAsEntry), 返回文件和其中的空目录 (要单独 mkdir, 否则不会出现)。
 * 拖放事件结束后 DataTransfer 就失效, 所以必须先同步取出所有 entry 再异步读。
 */
export async function fromDrop(dt: DataTransfer, base: string): Promise<{ files: Picked[]; emptyDirs: string[] }> {
  const entries = [...dt.items].filter((it) => it.kind === 'file').map((it) => it.webkitGetAsEntry?.() ?? null);
  // 浏览器不支持 entry API: 退回普通文件列表 (拿不到文件夹)
  if (!entries.length || entries.some((e) => !e)) return { files: [...dt.files].map((file) => ({ file, dir: base })), emptyDirs: [] };
  const files: Picked[] = [];
  const emptyDirs: string[] = [];
  const walk = async (e: FileSystemEntry, dir: string): Promise<void> => {
    if (e.isFile) {
      files.push({ file: await fileOf(e as FileSystemFileEntry), dir });
      return;
    }
    const sub = joinPath(dir, e.name);
    const kids = await readAll((e as FileSystemDirectoryEntry).createReader());
    if (!kids.length) emptyDirs.push(sub);
    for (const k of kids) await walk(k, sub);
  };
  for (const e of entries) await walk(e!, base);
  return { files, emptyDirs };
}

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * 剪贴板里的文件。截图粘贴时浏览器给的名字一律是 image.png, 同目录连贴几张会撞名, 换成带时间的名字。
 */
export function fromClipboard(data: DataTransfer | null): File[] {
  if (!data) return [];
  const d = new Date();
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return [...data.files].map((f, i) => {
    if (f.name && !/^image\.(png|jpe?g|gif|webp)$/i.test(f.name)) return f;
    const ext = (f.type.split('/')[1] || 'png').replace('jpeg', 'jpg').replace(/\+.*$/, '');
    return new File([f], `粘贴-${stamp}${i ? `-${i}` : ''}.${ext}`, { type: f.type, lastModified: f.lastModified });
  });
}
