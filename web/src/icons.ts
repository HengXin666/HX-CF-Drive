// 图标统一走 Iconify Solar (SVG 蒙版)。类名必须写成字面量, Tailwind 才能扫到并生成
export const ICON = {
  logo: 'icon-[solar--cloud-storage-linear]',
  files: 'icon-[solar--folder-with-files-linear]',
  trash: 'icon-[solar--trash-bin-trash-linear]',
  share: 'icon-[solar--share-linear]',
  admin: 'icon-[solar--settings-linear]',
  docs: 'icon-[solar--book-linear]',
  logout: 'icon-[solar--logout-2-linear]',
  upload: 'icon-[solar--upload-minimalistic-linear]',
  download: 'icon-[solar--download-minimalistic-linear]',
  newFolder: 'icon-[solar--add-folder-linear]',
  search: 'icon-[solar--magnifier-linear]',
  link: 'icon-[solar--link-linear]',
  rename: 'icon-[solar--pen-linear]',
  move: 'icon-[solar--transfer-horizontal-linear]',
  restore: 'icon-[solar--restart-linear]',
  copy: 'icon-[solar--copy-linear]',
  close: 'icon-[solar--close-circle-linear]',
  more: 'icon-[solar--menu-dots-linear]',
  home: 'icon-[solar--home-2-linear]',
  chevron: 'icon-[solar--alt-arrow-right-linear]',
  refresh: 'icon-[solar--refresh-linear]',
  eye: 'icon-[solar--eye-linear]',
  key: 'icon-[solar--key-linear]',
  lock: 'icon-[solar--lock-keyhole-linear]',
  server: 'icon-[solar--server-square-linear]',
  database: 'icon-[solar--database-linear]',
  plane: 'icon-[solar--plain-linear]',
  palette: 'icon-[solar--palette-linear]',
  code: 'icon-[solar--code-square-linear]',
  bolt: 'icon-[solar--cpu-bolt-linear]',
  check: 'icon-[solar--check-circle-linear]',
  warn: 'icon-[solar--danger-triangle-linear]',
  folder: 'icon-[solar--folder-linear]',
  fileText: 'icon-[solar--file-text-linear]',
  image: 'icon-[solar--gallery-linear]',
  video: 'icon-[solar--videocamera-record-linear]',
  audio: 'icon-[solar--music-note-linear]',
  pdf: 'icon-[solar--document-linear]',
  zip: 'icon-[solar--zip-file-linear]',
} as const;

export type IconName = keyof typeof ICON;

// 按类型给文件配图标和颜色
export function fileIcon(kind: 'dir' | 'file', mime: string | null, name: string): { icon: string; tone: string } {
  if (kind === 'dir') return { icon: ICON.folder, tone: 'text-amber-300' };
  const m = mime ?? '';
  if (m.startsWith('image/')) return { icon: ICON.image, tone: 'text-sky-300' };
  if (m.startsWith('video/')) return { icon: ICON.video, tone: 'text-violet-300' };
  if (m.startsWith('audio/')) return { icon: ICON.audio, tone: 'text-pink-300' };
  if (m === 'application/pdf') return { icon: ICON.pdf, tone: 'text-rose-300' };
  if (/\.(zip|7z|rar|tar|gz|xz|zst)$/i.test(name)) return { icon: ICON.zip, tone: 'text-orange-300' };
  return { icon: ICON.fileText, tone: 'text-muted-foreground' };
}
