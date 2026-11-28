/**
 * 文件分类 (#22 按类型筛选): 前端本地筛选和服务端搜索共用同一套规则。
 * 先看 MIME, 再看扩展名 (很多上传没有准确的 MIME)。
 */
export const CATEGORIES = ['image', 'video', 'audio', 'doc', 'archive', 'other'] as const;
export type Category = (typeof CATEGORIES)[number];
export const CATEGORY_LABEL: Record<Category, string> = { image: '图片', video: '视频', audio: '音频', doc: '文档', archive: '压缩包', other: '其他' };

const EXT: Record<Exclude<Category, 'other'>, string[]> = {
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'svg', 'heic', 'ico', 'tif', 'tiff'],
  video: ['mp4', 'mkv', 'webm', 'mov', 'avi', 'flv', 'm4v', 'ts', 'wmv'],
  audio: ['mp3', 'flac', 'wav', 'm4a', 'aac', 'ogg', 'opus', 'wma'],
  doc: ['pdf', 'txt', 'md', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'csv', 'json', 'epub', 'rtf', 'odt', 'html', 'xml', 'yaml', 'yml', 'log'],
  archive: ['zip', '7z', 'rar', 'tar', 'gz', 'tgz', 'xz', 'zst', 'bz2', 'iso'],
};
const MIME_PREFIX: Partial<Record<Category, string>> = { image: 'image/', video: 'video/', audio: 'audio/' };

const extOf = (name: string) => (name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '');

/** 一个文件属于哪一类 (目录返回 null) */
export function categoryOf(kind: string, mime: string | null, name: string): Category | null {
  if (kind === 'dir') return null;
  const m = (mime ?? '').toLowerCase();
  for (const c of ['image', 'video', 'audio'] as const) if (m.startsWith(MIME_PREFIX[c]!)) return c;
  if (m === 'application/pdf' || m.startsWith('text/')) return 'doc';
  const e = extOf(name);
  for (const c of ['image', 'video', 'audio', 'doc', 'archive'] as const) if (EXT[c].includes(e)) return c;
  return 'other';
}

/**
 * 同一规则的 SQL 条件 (列名 n.mime, n.name), 参数用 json_each 传扩展名列表, 不拼接用户输入。
 * 返回 [条件, 参数]; 条件里的 ? 按顺序绑定。
 */
export function categorySql(c: Category): [string, unknown[]] {
  const ext = "lower(CASE WHEN instr(n.name, '.') > 0 THEN replace(n.name, rtrim(n.name, replace(n.name, '.', '')), '') ELSE '' END)";
  const inExt = (list: string[]) => [`${ext} IN (SELECT value FROM json_each(?))`, [JSON.stringify(list)]] as [string, unknown[]];
  const mimeIs = (c2: 'image' | 'video' | 'audio') => `lower(coalesce(n.mime, '')) LIKE '${MIME_PREFIX[c2]}%'`;
  const media = `(${mimeIs('image')} OR ${mimeIs('video')} OR ${mimeIs('audio')})`;
  const docMime = "(lower(coalesce(n.mime, '')) = 'application/pdf' OR lower(coalesce(n.mime, '')) LIKE 'text/%')";
  if (c === 'image' || c === 'video' || c === 'audio') {
    const [e, a] = inExt(EXT[c]);
    // MIME 没认出是媒体时才看扩展名
    return [`n.kind = 'file' AND (${mimeIs(c)} OR (NOT ${media} AND NOT ${docMime} AND ${e}))`, a];
  }
  if (c === 'doc') {
    const [e, a] = inExt(EXT.doc);
    const [m, b] = inExt([...EXT.image, ...EXT.video, ...EXT.audio]);
    return [`n.kind = 'file' AND NOT ${media} AND (${docMime} OR (${e} AND NOT ${m}))`, [...a, ...b]];
  }
  const [known, a] = inExt([...EXT.image, ...EXT.video, ...EXT.audio, ...EXT.doc]);
  if (c === 'archive') {
    const [e, b] = inExt(EXT.archive);
    return [`n.kind = 'file' AND NOT ${media} AND NOT ${docMime} AND NOT ${known} AND ${e}`, [...a, ...b]];
  }
  const [arc, b] = inExt(EXT.archive);
  return [`n.kind = 'file' AND NOT ${media} AND NOT ${docMime} AND NOT ${known} AND NOT ${arc}`, [...a, ...b]];
}
