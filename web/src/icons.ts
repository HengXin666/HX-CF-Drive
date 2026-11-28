// 图标统一用 lucide (与 HX-UI 一致)。页面按名字取, 换图标只改这里
import {
  ArrowLeft, BookOpen, Check, ChevronRight, CircleAlert, Copy, Cpu, Database, Download, Eye, FileArchive, FileCode2,
  FileText, Film, Folder, FolderInput, FolderOpen, FolderPlus, FolderTree, House, Image, KeyRound, Link2, Lock, LogOut, type LucideIcon,
  Moon, Music, MoreHorizontal, Pencil, Plus, RefreshCw, RotateCcw, Search, Send, Server, Settings, Share2, ShieldCheck,
  Sun, Trash2, Upload, X, Info, Rocket, HardDrive, LoaderCircle, FolderUp, ClipboardPaste,
} from 'lucide-react';

export const ICON = {
  logo: HardDrive,
  spinner: LoaderCircle,
  files: FolderOpen,
  trash: Trash2,
  share: Share2,
  admin: Settings,
  docs: BookOpen,
  logout: LogOut,
  upload: Upload,
  download: Download,
  newFolder: FolderPlus,
  add: Plus,
  search: Search,
  link: Link2,
  rename: Pencil,
  move: FolderInput,
  tree: FolderTree,
  restore: RotateCcw,
  copy: Copy,
  close: X,
  more: MoreHorizontal,
  home: House,
  chevron: ChevronRight,
  back: ArrowLeft,
  refresh: RefreshCw,
  eye: Eye,
  key: KeyRound,
  lock: Lock,
  shield: ShieldCheck,
  server: Server,
  database: Database,
  plane: Send,
  code: FileCode2,
  bolt: Cpu,
  check: Check,
  warn: CircleAlert,
  info: Info,
  rocket: Rocket,
  sun: Sun,
  moon: Moon,
  folder: Folder,
  fileText: FileText,
  image: Image,
  video: Film,
  audio: Music,
  pdf: FileText,
  zip: FileArchive,
  folderUp: FolderUp,
  clipboard: ClipboardPaste,
} satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof ICON;

// 按类型给文件配图标和颜色; 颜色用低饱和色, 亮暗两套主题都看得清
export function fileIcon(kind: 'dir' | 'file', mime: string | null, name: string): { icon: LucideIcon; tone: string } {
  if (kind === 'dir') return { icon: ICON.folder, tone: 'text-amber-500 dark:text-amber-400' };
  const m = mime ?? '';
  if (m.startsWith('image/')) return { icon: ICON.image, tone: 'text-sky-500 dark:text-sky-400' };
  if (m.startsWith('video/')) return { icon: ICON.video, tone: 'text-violet-500 dark:text-violet-400' };
  if (m.startsWith('audio/')) return { icon: ICON.audio, tone: 'text-pink-500 dark:text-pink-400' };
  if (m === 'application/pdf') return { icon: ICON.pdf, tone: 'text-rose-500 dark:text-rose-400' };
  if (/\.(zip|7z|rar|tar|gz|xz|zst)$/i.test(name)) return { icon: ICON.zip, tone: 'text-orange-500 dark:text-orange-400' };
  return { icon: ICON.fileText, tone: 'text-muted-foreground' };
}
