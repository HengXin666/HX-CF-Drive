// 复制链接的格式 (#22): URL / Markdown / HTML / BBCode。图片用图片语法, 其他文件用超链接
export type LinkFormat = 'url' | 'markdown' | 'html' | 'bbcode';
export const FORMATS: { id: LinkFormat; label: string }[] = [
  { id: 'url', label: 'URL' },
  { id: 'markdown', label: 'Markdown' },
  { id: 'html', label: 'HTML' },
  { id: 'bbcode', label: 'BBCode' },
];

export interface LinkItem { name: string; mime: string | null; url: string }

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const md = (s: string) => s.replace(/([[\]\\])/g, '\\$1');
const isImg = (it: LinkItem) => (it.mime ?? '').startsWith('image/');

export function formatLink(it: LinkItem, f: LinkFormat): string {
  switch (f) {
    case 'markdown': return isImg(it) ? `![${md(it.name)}](${it.url})` : `[${md(it.name)}](${it.url})`;
    case 'html': return isImg(it) ? `<img src="${esc(it.url)}" alt="${esc(it.name)}">` : `<a href="${esc(it.url)}">${esc(it.name)}</a>`;
    case 'bbcode': return isImg(it) ? `[img]${it.url}[/img]` : `[url=${it.url}]${it.name}[/url]`;
    default: return it.url;
  }
}

export const formatLinks = (items: LinkItem[], f: LinkFormat) => items.map((it) => formatLink(it, f)).join('\n');

const KEY = 'hxd_linkfmt';
export const lastFormat = (): LinkFormat => {
  const v = localStorage.getItem(KEY);
  return FORMATS.some((x) => x.id === v) ? (v as LinkFormat) : 'url';
};
export const rememberFormat = (f: LinkFormat) => localStorage.setItem(KEY, f);
