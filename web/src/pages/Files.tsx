// 文件浏览: 路径眉标, 上传 (拖放/选择), 新建目录, 搜索, 预览, 下载, 直链, 分享, 重命名, 移动 (目录树), 删除, 多选批量操作
import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon, IconButton } from '../components/Icon';
import { ImageCell } from '../components/ImageCell';
import { MoveDialog } from '../components/MoveDialog';
import { Preview, type PreviewTarget } from '../components/Preview';
import { PromptDialog, type PromptRequest } from '../components/PromptDialog';
import { Meta, Page } from '../components/Shell';
import { type Column, DataTable } from '../components/Table';
import { UploadQueue, useUploadQueue } from '../components/UploadQueue';
import { fileIcon } from '../icons';
import { admin, ApiError, fmtSize, fmtTime, fs, joinPath, type Node, shares, type TokenRow } from '../lib/api';
import { isImage, load as loadImage, peek, usePrefs, wantsPreview } from '../lib/imgcache';
import { download } from '../lib/transfer';
import {
  Button, cn, confirmDialog, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger, Input, toast,
} from '../ui';

const parentOf = (p: string) => p.replace(/\/[^/]+\/?$/, '') || '/';
const within = (p: string, dir: string) => dir === '/' || p === dir || p.startsWith(dir + '/');

/**
 * 受影响的令牌: 只限定在某个子目录的令牌 (如 AIOA 的 /aioa) 按节点 id 引用文件,
 * 在目录内改名, 移动都不影响它; 删掉 (进回收站) 或移出它的根目录后, 持有令牌的服务就找不到了。
 * inside: 节点在令牌根目录里; holds: 节点就是或包含令牌根目录。
 */
function tokensAt(tokens: TokenRow[], p: string) {
  const scoped = tokens.filter((t) => t.root_path && t.root_path !== '/');
  return { inside: scoped.filter((t) => within(p, t.root_path) && p !== t.root_path), holds: scoped.filter((t) => within(t.root_path, p)) };
}
const names = (ts: TokenRow[]) => [...new Set(ts.map((t) => `${t.name} (${t.root_path})`))].join(', ');

async function copy(text: string, what: string) {
  await navigator.clipboard.writeText(text);
  toast.success(`${what}已复制`);
}

/** 顶栏路径: 每段可点; 窄屏只留根和最后两段, 中间折成 … */
function Crumbs({ path, go }: { path: string; go: (p: string) => void }) {
  const parts = path.split('/').filter(Boolean);
  const seg = 'shrink-0 rounded px-1 py-0.5 transition-colors hover:bg-accent hover:text-foreground';
  const at = (i: number) => '/' + parts.slice(0, i + 1).join('/');
  return (
    <nav aria-label="路径" className="flex min-w-0 items-center gap-0.5 overflow-hidden">
      <button type="button" aria-label="全部文件" className={cn(seg, 'inline-flex items-center', parts.length === 0 && 'text-brand')} onClick={() => go('/')}>
        <Icon name="home" className="size-3.5" />
      </button>
      {parts.map((c, i) => {
        const last = i === parts.length - 1;
        const hideNarrow = parts.length > 2 && i < parts.length - 2;
        return (
          <span key={i} className={cn('flex min-w-0 items-center gap-0.5', hideNarrow && 'hidden sm:flex')}>
            <Icon name="chevron" className="size-3 opacity-50" />
            <button type="button" className={cn(seg, 'min-w-0 truncate', last && 'text-foreground')} onClick={() => go(at(i))}>{c}</button>
          </span>
        );
      })}
          </nav>
  );
}

type Item = Node & { fullPath: string };

export function Files({ path, go, onChange }: { path: string; go: (p: string) => void; onChange: () => void }) {
  const [rows, setRows] = useState<Node[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [searching, setSearching] = useState<Node[] | null>(null);
  const [prompt, setPrompt] = useState<PromptRequest | null>(null);
  const [moving, setMoving] = useState<Item[] | null>(null);
  const [preview, setPreview] = useState<PreviewTarget | null>(null);
  const [drag, setDrag] = useState(false);
  const [img, setImg] = usePrefs();
  const picker = useRef<HTMLInputElement>(null);
  // 只有管理员能列令牌; 其他令牌拿不到就当没有
  const [tokens, setTokens] = useState<TokenRow[]>([]);
  useEffect(() => { admin.tokens().then((r) => setTokens(r.items), () => setTokens([])); }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows((await fs.list(path)).children);
    } catch (e) {
      toast.error((e as Error).message);
      if (e instanceof ApiError && e.status === 404) go('/');
    } finally {
      setLoading(false);
    }
  }, [path, go]);

  useEffect(() => { setSearching(null); setQ(''); void load(); }, [load]);
  const changed = useCallback(() => { void load(); onChange(); }, [load, onChange]);
  const uploads = useUploadQueue(changed);

  const runSearch = async () => {
    if (!q.trim()) { setSearching(null); return; }
    try {
      setSearching((await fs.search(q.trim())).items);
    } catch (e) {
      toast.error(e instanceof ApiError && e.status === 429 ? '搜索太频繁, 稍后再试' : (e as Error).message);
    }
  };

  const full = (n: Node): Item => ({ ...n, fullPath: n.path ?? joinPath(path, n.name) });
  const save = async (n: Node) => {
    // 列表或预览里已经加载过的图片直接存, 不再请求
    const cached = isImage(n) ? peek(n) : null;
    if (cached) {
      const a = document.createElement('a');
      a.href = cached;
      a.download = n.name;
      a.click();
      return;
    }
    const { url } = await fs.link(n.id, 3600);
    await download(url, n.name, n.size, () => {});
  };
  const open = async (n: Node) => {
    if (n.kind === 'dir') { go(full(n).fullPath); return; }
    if (isImage(n)) {
      // 图片走缓存: 命中直接显示, 没命中取一次原图并留在缓存里, 下次点开不再请求; 不签直链
      setPreview({ node: n, url: peek(n) ?? '' });
      const url = await loadImage(n);
      setPreview((p) => (p?.node.id === n.id ? { node: n, url } : p));
      return;
    }
    const { url } = await fs.link(n.id, 3600);
    if (/^(image|video|audio)\//.test(n.mime ?? '') || n.mime === 'application/pdf' || n.mime?.startsWith('text/')) setPreview({ node: n, url });
    else await download(url, n.name, n.size, () => {});
  };

  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      await fn();
      if (ok) toast.success(ok);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      changed();
    }
  };

  const share = (n: Node) => setPrompt({
    title: `分享 ${n.name}`,
    fields: [{ key: 'pw', label: '密码', description: '留空则任何拿到链接的人都能看', type: 'password' }, { key: 'days', label: '有效天数', description: '留空为永久', type: 'number' }],
    okText: '创建并复制链接',
    onOk: async (v) => {
      const r = await shares.create(n.id, v.pw || undefined, v.days ? Number(v.days) * 86400 : undefined);
      await copy(r.url, '分享链接');
    },
  });

  /** 删除或移出令牌根目录时的提醒; 没有受影响的令牌返回空串 */
  const tokenWarn = (items: Item[], verb: string) => {
    const inside = items.flatMap((n) => tokensAt(tokens, n.fullPath).inside);
    const holds = items.flatMap((n) => tokensAt(tokens, n.fullPath).holds);
    if (holds.length) return `其中包含令牌 ${names(holds)} 的根目录, ${verb}后这些令牌的服务会找不到里面所有文件, 新上传也会失败。`;
    if (inside.length) return `位于令牌 ${names(inside)} 的根目录里, ${verb}后持有令牌的服务会找不到 (在目录内改名, 移动不受影响)。`;
    return '';
  };

  const remove = async (items: Item[], clear?: () => void) => {
    if (!items.length) return;
    const dirs = items.filter((n) => n.kind === 'dir');
    const one = items.length === 1 ? items[0] : null;
    const warn = tokenWarn(items, '删除');
    const ok = await confirmDialog({
      title: one ? `删除${one.kind === 'dir' ? '目录' : ''} ${one.name}?` : `删除 ${items.length} 个项目?`,
      message: [dirs.length ? '目录连同里面的所有内容都会放进回收站, 保留期内可以恢复。' : '会放进回收站, 保留期内可以恢复。', warn].filter(Boolean).join(' '),
      confirmLabel: '删除',
      danger: true,
      // 删目录像删 GitHub 仓库一样手动输入名字确认; 一次删多个时输入 "删除"
      confirmText: dirs.length ? (one ? one.name : '删除') : undefined,
    });
    if (!ok) return;
    await act(async () => { for (const n of items) await fs.remove(n.id); }, items.length > 1 ? `已把 ${items.length} 项移入回收站` : '已移入回收站');
    clear?.();
  };

  const moveTo = async (items: Item[], to: string) => {
    const lost = items.flatMap((n) => tokensAt(tokens, n.fullPath).inside.filter((t) => !within(to, t.root_path)));
    if (lost.length && !(await confirmDialog({
      title: '移出令牌目录?',
      message: `${items.length === 1 ? items[0].name : `这 ${items.length} 项`}位于令牌 ${names(lost)} 的根目录里, 移到 ${to} 后持有令牌的服务会找不到。`,
      confirmLabel: '仍然移动',
      danger: true,
    }))) return;
    const failed: string[] = [];
    for (const n of items) {
      try { await fs.move(n.id, to, n.name); } catch (e) { failed.push(`${n.name}: ${(e as Error).message}`); }
    }
    changed();
    if (failed.length) throw new Error(failed.join('\n'));
    toast.success(items.length > 1 ? `已移动 ${items.length} 项到 ${to}` : `已移动到 ${to}`);
  };

  const columns: Column<Node>[] = [
    { key: 'name', header: '名称', sort: (n) => (n.kind === 'dir' ? '0' : '1') + n.name.toLowerCase(), render: (n) => {
      const fi = fileIcon(n.kind, n.mime, n.name);
      return (
        <span className="flex min-w-0 items-center gap-2.5 sm:min-w-64">
          {wantsPreview(n, img) ? <ImageCell node={n} fallback={<Icon as={fi.icon} className={fi.tone} />} /> : <Icon as={fi.icon} className={fi.tone} />}
          <span className="grid min-w-0">
            <span className="truncate">{n.name}</span>
            {/* 窄屏隐藏了大小和时间两列, 放到名字下面 */}
            <span className="truncate text-xs text-muted-foreground sm:hidden">
              {n.kind === 'dir' ? '' : `${fmtSize(n.size)} · `}{fmtTime(n.updatedAt)}
            </span>
          </span>
          {searching && n.path && <span className="truncate font-mono text-xs text-muted-foreground">{parentOf(n.path)}</span>}
        </span>
      );
    } },
    { key: 'size', header: '大小', align: 'right', hideOnMobile: true, sort: (n) => (n.kind === 'dir' ? -1 : n.size),
      render: (n) => <span className="tabular-nums text-muted-foreground">{n.kind === 'dir' ? '' : fmtSize(n.size)}</span> },
    { key: 'time', header: '修改时间', hideOnMobile: true, sort: (n) => n.updatedAt,
      render: (n) => <span className="whitespace-nowrap tabular-nums text-muted-foreground">{fmtTime(n.updatedAt)}</span> },
    { key: 'op', header: '', align: 'right', render: (n) => (
      <div className="flex justify-end gap-0.5" onClick={(e) => e.stopPropagation()}>
        <span className="hidden gap-0.5 sm:flex">
          {n.kind === 'file' && <IconButton name="download" label="下载" onClick={() => void save(n).catch((e) => toast.error((e as Error).message))} />}
          <IconButton name="share" label="分享" onClick={() => share(n)} />
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="icon-sm" variant="ghost" aria-label="更多" className="text-muted-foreground"><Icon name="more" /></Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-40">
            {n.kind === 'file' && <DropdownMenuItem className="sm:hidden" onSelect={() => void save(n).catch((e) => toast.error((e as Error).message))}><Icon name="download" /> 下载</DropdownMenuItem>}
            <DropdownMenuItem className="sm:hidden" onSelect={() => share(n)}><Icon name="share" /> 分享</DropdownMenuItem>
            {n.kind === 'file' && (
              <DropdownMenuItem onSelect={() => void fs.link(n.id, 0).then((r) => copy(r.url, '永久直链'), (e) => toast.error((e as Error).message))}>
                <Icon name="link" /> 复制永久直链
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onSelect={() => setPrompt({
              title: '重命名', fields: [{ key: 'name', label: '新名称', value: n.name }],
              onOk: async (v) => { await fs.move(n.id, undefined, v.name.trim()); changed(); },
            })}><Icon name="rename" /> 重命名</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setMoving([full(n)])}><Icon name="move" /> 移动到…</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => void remove([full(n)])}><Icon name="trash" /> 删除</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    ) },
  ];

  const here = path.split('/').filter(Boolean).pop();
  const list = searching ?? rows;
  const dirCount = list.filter((n) => n.kind === 'dir').length;

  return (
    <Page
      eyebrow={<Crumbs path={path} go={go} />}
      icon={searching ? 'search' : path === '/' ? 'files' : 'folder'}
      title={searching ? `搜索 “${q}”` : here ?? '全部文件'}
      meta={loading ? '加载中…' : searching
        ? <><Meta icon="fileText">{searching.length} 条结果</Meta><button type="button" className="inline-flex items-center gap-1 text-brand hover:underline" onClick={() => setSearching(null)}><Icon name="back" className="size-3.5" />返回目录</button></>
        : <><Meta icon="folder">{dirCount}</Meta><Meta icon="fileText">{list.length - dirCount}</Meta><span className="hidden items-center gap-1 sm:inline-flex"><Icon name="upload" className="size-3.5" />可直接拖入上传</span></>}
    >
      <div
        className={cn('relative rounded-xl transition-shadow', drag && 'ring-2 ring-brand ring-offset-4 ring-offset-background')}
        onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDrag(true); } }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          if (e.dataTransfer.files.length) uploads.add([...e.dataTransfer.files], path);
        }}
      >
        <DataTable
          columns={columns}
          rows={list}
          rowKey={(n) => n.id}
          loading={loading}
          selectable
          toolbar={(
            <>
              <form onSubmit={(e) => { e.preventDefault(); void runSearch(); }}>
                <Input size="sm" className="w-40 sm:w-60" leading={<Icon name="search" />} placeholder="搜索全部文件" aria-label="搜索全部文件"
                  value={q} onChange={(e) => setQ(e.target.value)} />
              </form>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" variant={img.on ? 'secondary' : 'outline'} aria-label="图片预览">
                    <Icon name="image" /><span className="hidden sm:inline">{img.on ? `预览 ≤ ${img.maxMB} MB` : '图片预览'}</span>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-48">
                  <DropdownMenuItem onSelect={() => setImg({ ...img, on: !img.on })}>
                    <Icon name={img.on ? 'close' : 'eye'} /> {img.on ? '关闭图片预览' : '在列表里显示图片'}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  {[1, 2, 5, 10, 20].map((mb) => (
                    <DropdownMenuItem key={mb} onSelect={() => setImg({ on: true, maxMB: mb })}>
                      <Icon name={img.on && img.maxMB === mb ? 'check' : 'image'} /> 只显示 ≤ {mb} MB 的图片
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
              <Button size="sm" variant="outline" aria-label="新建目录" onClick={() => setPrompt({
                title: '新建目录', fields: [{ key: 'name', label: '目录名' }],
                onOk: async (v) => { await fs.mkdir(joinPath(path, v.name.trim())); changed(); },
              })}>
                <Icon name="newFolder" /><span className="hidden sm:inline">新建目录</span>
              </Button>
              <Button size="sm" aria-label="上传" onClick={() => picker.current?.click()}>
                <Icon name="upload" /><span className="hidden sm:inline">上传</span>
              </Button>
              <input ref={picker} type="file" multiple hidden onChange={(e) => {
                if (e.target.files?.length) uploads.add([...e.target.files], path);
                e.target.value = '';
              }} />
            </>
          )}
          bulkActions={(sel, clear) => (
            <>
              <Button size="sm" variant="outline" aria-label="移动到" onClick={() => setMoving(sel.map(full))}><Icon name="move" /><span className="hidden sm:inline">移动到…</span></Button>
              <Button size="sm" variant="destructive" aria-label="删除" onClick={() => void remove(sel.map(full), clear)}><Icon name="trash" /><span className="hidden sm:inline">删除</span></Button>
            </>
          )}
          onRowClick={(n) => { open(n).catch((e) => toast.error((e as Error).message)); }}
          emptyText={searching ? '没有匹配的文件' : '空目录, 把文件拖进来或点上传'}
          emptyIcon={searching ? 'search' : 'upload'}
        />
      </div>
      <PromptDialog req={prompt} onClose={() => setPrompt(null)} />
      <MoveDialog
        nodes={moving}
        from={moving?.length ? parentOf(moving[0].fullPath) : path}
        onClose={() => setMoving(null)}
        onMove={(to) => moveTo(moving ?? [], to)}
      />
      <Preview target={preview} onClose={() => setPreview(null)} onDownload={(n) => void save(n)} />
      <UploadQueue q={uploads} />
    </Page>
  );
}
