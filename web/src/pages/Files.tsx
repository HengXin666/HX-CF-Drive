// 文件浏览: 面包屑, 上传 (拖放/选择), 新建目录, 搜索, 预览, 下载, 直链, 分享, 重命名, 移动, 删除
import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon, IconButton } from '../components/Icon';
import { Preview, type PreviewTarget } from '../components/Preview';
import { PromptDialog, type PromptRequest } from '../components/PromptDialog';
import { Page } from '../components/Shell';
import { UploadQueue, useUploadQueue } from '../components/UploadQueue';
import { fileIcon } from '../icons';
import { admin, ApiError, fmtSize, fmtTime, fs, joinPath, type Node, shares, type TokenRow } from '../lib/api';
import { download } from '../lib/transfer';
import {
  Button, confirmDialog, DataTable, type DataTableColumn, DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuTrigger, Input, toast,
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
const names = (ts: TokenRow[]) => ts.map((t) => `${t.name} (${t.root_path})`).join(', ');

async function copy(text: string, what: string) {
  await navigator.clipboard.writeText(text);
  toast.success(`${what}已复制`);
}

function Crumbs({ path, go }: { path: string; go: (p: string) => void }) {
  const parts = path.split('/').filter(Boolean);
  const cls = 'rounded-md px-1.5 py-0.5 hover:bg-accent';
  return (
    <nav className="flex min-w-0 flex-wrap items-center gap-0.5 text-[13px]">
      <button type="button" className={`${cls} flex items-center gap-1.5 ${parts.length ? 'text-muted-foreground' : ''}`} onClick={() => go('/')}>
        <Icon name="home" /> 全部文件
      </button>
      {parts.map((c, i) => (
        <span key={i} className="flex items-center gap-0.5">
          <Icon name="chevron" className="size-3.5 text-muted-foreground/60" />
          <button type="button" className={`${cls} ${i < parts.length - 1 ? 'text-muted-foreground' : ''}`}
            onClick={() => go('/' + parts.slice(0, i + 1).join('/'))}>{c}</button>
        </span>
      ))}
    </nav>
  );
}

export function Files({ path, go, onChange }: { path: string; go: (p: string) => void; onChange: () => void }) {
  const [rows, setRows] = useState<Node[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [searching, setSearching] = useState<Node[] | null>(null);
  const [prompt, setPrompt] = useState<PromptRequest | null>(null);
  const [preview, setPreview] = useState<PreviewTarget | null>(null);
  const [drag, setDrag] = useState(false);
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

  const save = async (n: Node) => {
    const { url } = await fs.link(n.id, 3600);
    await download(url, n.name, n.size, () => {});
  };
  const open = async (n: Node) => {
    if (n.kind === 'dir') { go(n.path ?? joinPath(path, n.name)); return; }
    const { url } = await fs.link(n.id, 3600);
    if (/^(image|video|audio)\//.test(n.mime ?? '') || n.mime === 'application/pdf' || n.mime?.startsWith('text/')) setPreview({ node: n, url });
    else await download(url, n.name, n.size, () => {});
  };

  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      await fn();
      if (ok) toast.success(ok);
      changed();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const share = (n: Node) => setPrompt({
    title: `分享 ${n.name}`,
    fields: [{ key: 'pw', label: '密码 (留空则公开)' }, { key: 'days', label: '有效天数 (留空为永久)', type: 'number' }],
    okText: '创建并复制链接',
    onOk: async (v) => {
      const r = await shares.create(n.id, v.pw || undefined, v.days ? Number(v.days) * 86400 : undefined);
      await copy(r.url, '分享链接');
    },
  });
  const pathOfNode = (n: Node) => n.path ?? joinPath(path, n.name);
  /** 删除或移出令牌根目录时的提醒; 没有受影响的令牌返回空串 */
  const tokenWarn = (n: Node, verb: string) => {
    const { inside, holds } = tokensAt(tokens, pathOfNode(n));
    if (holds.length) return `这是令牌 ${names(holds)} 的根目录或包含它, ${verb}后这些令牌的服务会找不到其中所有文件, 新上传也会失败。`;
    if (inside.length) return `位于令牌 ${names(inside)} 的根目录里, ${verb}后持有令牌的服务会找不到它 (在目录内改名, 移动不受影响)。`;
    return '';
  };
  const remove = async (n: Node) => {
    const warn = tokenWarn(n, '删除');
    if (n.kind === 'dir') {
      // 目录: 像删 GitHub 仓库一样手动输入目录名确认
      setPrompt({
        title: `删除目录 ${n.name}?`,
        note: `目录和里面的所有内容都会放进回收站, 保留期内可以恢复。${warn ? '\n' + warn : ''}`,
        fields: [{ key: 'confirm', label: `输入目录名 ${n.name} 确认`, placeholder: n.name }],
        okText: '删除',
        danger: true,
        onOk: async (v) => {
          if (v.confirm.trim() !== n.name) throw new Error('目录名不一致');
          await act(() => fs.remove(n.id), '已移入回收站');
        },
      });
      return;
    }
    if (await confirmDialog({ title: `删除 ${n.name}?`, message: `会放进回收站, 保留期内可以恢复。${warn ? ' ' + warn : ''}`, confirmLabel: '删除', variant: 'danger' })) {
      await act(() => fs.remove(n.id), '已移入回收站');
    }
  };
  /** 移动: 移出令牌根目录时先提醒; 挪动根目录本身不影响, 令牌按 id 跟随 */
  const moveTo = async (n: Node, to: string) => {
    const { inside } = tokensAt(tokens, pathOfNode(n));
    const lost = inside.filter((t) => !within(to, t.root_path));
    if (lost.length && !(await confirmDialog({
      title: "移出令牌目录?",
      message: `${n.name} 位于令牌 ${names(lost)} 的根目录里, 移到 ${to} 后持有令牌的服务会找不到它。`,
      confirmLabel: '仍然移动',
      variant: 'danger',
    }))) return;
    await act(() => fs.move(n.id, to, n.name), '已移动');
  };
  const wrap = (fn: () => unknown) => () => { Promise.resolve(fn()).catch((e) => toast.error((e as Error).message)); };

  const item = (icon: Parameters<typeof Icon>[0]['name'], label: string, fn: () => unknown, danger?: boolean) => (
    <DropdownMenuItem onSelect={wrap(fn)} className={danger ? 'text-danger-fg' : undefined}>
      <Icon name={icon} className="size-4 opacity-80" /> {label}
    </DropdownMenuItem>
  );

  const columns: DataTableColumn<Node>[] = [
    { key: 'name', header: '名称', render: (n) => {
      const fi = fileIcon(n.kind, n.mime, n.name);
      return (
        <span className="flex min-w-0 items-center gap-2.5">
          <Icon raw={fi.icon} className={`size-[18px] ${fi.tone}`} />
          <span className="truncate">{n.name}</span>
          {searching && n.path && <span className="truncate text-xs text-muted-foreground">{parentOf(n.path)}</span>}
        </span>
      );
    } },
    { key: 'size', header: '大小', width: '100px', numeric: true, render: (n) => (n.kind === 'dir' ? <span className="text-muted-foreground">-</span> : fmtSize(n.size)) },
    { key: 'time', header: '修改时间', width: '170px', render: (n) => <span className="text-muted-foreground tabular-nums">{fmtTime(n.updatedAt)}</span> },
    { key: 'op', header: '', width: '112px', align: 'right', render: (n) => (
      <div className="flex justify-end gap-0.5">
        {n.kind === 'file' && <IconButton name="download" label="下载" onClick={wrap(() => save(n))} />}
        <IconButton name="share" label="分享" onClick={() => share(n)} />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" aria-label="更多" title="更多" onClick={(e) => e.stopPropagation()}
              className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground">
              <Icon name="more" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
            {n.kind === 'file' && item('link', '复制永久直链', async () => copy((await fs.link(n.id, 0)).url, '永久直链'))}
            {item('rename', '重命名', () => setPrompt({
              title: '重命名', fields: [{ key: 'name', label: '新名称', value: n.name }],
              onOk: async (v) => act(() => fs.move(n.id, undefined, v.name.trim())),
            }))}
            {item('move', '移动到', () => setPrompt({
              title: '移动到', fields: [{ key: 'to', label: '目标目录', value: n.path ? parentOf(n.path) : path }],
              onOk: async (v) => moveTo(n, v.to.trim() || '/'),
            }))}
            <DropdownMenuSeparator />
            {item('trash', '删除', () => remove(n), true)}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    ) },
  ];

  return (
    <Page
      title={<Crumbs path={path} go={go} />}
      right={
        <>
          <form className="relative" onSubmit={(e) => { e.preventDefault(); void runSearch(); }}>
            <Icon name="search" className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input className="h-8 w-52 pl-8" placeholder="搜索文件名, 回车" value={q} onChange={(e) => setQ(e.target.value)} />
          </form>
          <Button size="sm" variant="outline" onClick={() => setPrompt({
            title: '新建目录', fields: [{ key: 'name', label: '目录名' }],
            onOk: async (v) => act(() => fs.mkdir(joinPath(path, v.name.trim()))),
          })}>
            <Icon name="newFolder" /> 新建目录
          </Button>
          <Button size="sm" variant="primary" onClick={() => picker.current?.click()}>
            <Icon name="upload" /> 上传
          </Button>
          <input ref={picker} type="file" multiple hidden onChange={(e) => {
            if (e.target.files?.length) uploads.add([...e.target.files], path);
            e.target.value = '';
          }} />
        </>
      }
    >
      <div
        className={`relative flex min-h-full flex-col gap-3 rounded-xl ${drag ? 'outline-2 outline-offset-4 outline-dashed outline-primary/70' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          if (e.dataTransfer.files.length) uploads.add([...e.dataTransfer.files], path);
        }}
      >
        {searching && (
          <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
            <Icon name="search" /> “{q}” 共 {searching.length} 条
            <Button size="xs" variant="ghost" onClick={() => setSearching(null)}>返回目录</Button>
          </div>
        )}
        <DataTable
          columns={columns}
          rows={searching ?? rows}
          rowKey={(n) => n.id}
          loading={loading}
          onRowClick={(n) => { open(n).catch((e) => toast.error((e as Error).message)); }}
          emptyText={searching ? '没有匹配的文件' : '空目录, 把文件拖进来或点上传'}
        />
      </div>
      <PromptDialog req={prompt} onClose={() => setPrompt(null)} />
      <Preview target={preview} onClose={() => setPreview(null)} onDownload={(n) => void save(n)} />
      <UploadQueue q={uploads} />
    </Page>
  );
}
