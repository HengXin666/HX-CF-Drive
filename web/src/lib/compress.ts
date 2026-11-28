// 上传前在浏览器里压缩 / 转 WebP (#22, 可选)。全部在前端做, Worker CPU 和服务端流程不变。
// 动图 (GIF, APNG, 动态 WebP) 和 SVG 原样上传; 压完反而更大且格式没变时也用原图。
export interface CompressPrefs {
  on: boolean;
  /** 转成 WebP; 关掉时保持原格式 (PNG 只缩放, JPEG / WebP 按质量重新编码) */
  webp: boolean;
  /** 0.4 ~ 1 */
  quality: number;
  /** 最长边像素, 0 为不缩放 */
  maxEdge: number;
}

const KEY = 'hxd_upload_img';
export const DEFAULT_PREFS: CompressPrefs = { on: false, webp: true, quality: 0.85, maxEdge: 0 };

export function getPrefs(): CompressPrefs {
  try { return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') }; } catch { return DEFAULT_PREFS; }
}
export const setPrefs = (p: CompressPrefs) => localStorage.setItem(KEY, JSON.stringify(p));

const SUPPORTED = /^image\/(jpeg|png|webp|bmp)$/;

/** 文件头里找动图标记: APNG 有 acTL 块 (在 IDAT 之前), 动态 WebP 有 ANIM 块 */
export async function isAnimated(file: Blob): Promise<boolean> {
  if (file.type === 'image/gif') return true;
  if (file.type !== 'image/png' && file.type !== 'image/webp') return false;
  const head = new Uint8Array(await file.slice(0, 256 * 1024).arrayBuffer());
  const text = new TextDecoder('latin1').decode(head);
  if (file.type === 'image/png') {
    const a = text.indexOf('acTL');
    const d = text.indexOf('IDAT');
    return a >= 0 && (d < 0 || a < d);
  }
  return text.includes('ANIM');
}

const extFor = (type: string) => ({ 'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/png': 'png' }[type] ?? 'img');
const renameExt = (name: string, ext: string) => (/\.[^.]+$/.test(name) ? name.replace(/\.[^.]+$/, `.${ext}`) : `${name}.${ext}`);

/** 返回处理后的文件; 不处理时返回 null (调用方用原文件) */
export async function compressImage(file: File, p: CompressPrefs): Promise<File | null> {
  if (!p.on || !SUPPORTED.test(file.type) || (await isAnimated(file))) return null;
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  try {
    const scale = p.maxEdge > 0 ? Math.min(1, p.maxEdge / Math.max(bmp.width, bmp.height)) : 1;
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    // BMP 没法原格式编码, 不转 WebP 时编成 PNG
    const type = p.webp ? 'image/webp' : file.type === 'image/bmp' ? 'image/png' : file.type;
    // 格式不变, 也不缩放, 而且是无损的 PNG: 没有可压的
    if (type === file.type && scale === 1 && type === 'image/png') return null;
    const q = Math.min(1, Math.max(0.4, p.quality));
    let blob: Blob;
    if (typeof OffscreenCanvas !== 'undefined') {
      const c = new OffscreenCanvas(w, h);
      c.getContext('2d')!.drawImage(bmp, 0, 0, w, h);
      blob = await c.convertToBlob({ type, quality: q });
    } else {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      c.getContext('2d')!.drawImage(bmp, 0, 0, w, h);
      blob = await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('编码失败'))), type, q));
    }
    // 浏览器不支持目标格式时会悄悄退回 PNG; 结果更大且尺寸 / 格式都没变时没意义
    if (blob.type !== type) return null;
    if (blob.size >= file.size && scale === 1 && type === file.type) return null;
    const name = type === file.type ? file.name : renameExt(file.name, extFor(type));
    return new File([blob], name, { type, lastModified: file.lastModified });
  } finally {
    bmp.close();
  }
}
