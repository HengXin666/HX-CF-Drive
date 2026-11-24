// 文件浏览: 面包屑, 上传 (拖放/选择), 新建目录, 搜索, 预览, 下载, 直链, 分享, 重命名, 移动, 删除
import {
  Button, confirmDialog, DataTable, type DataTableColumn, Dialog, DialogContent, DialogHeader, DialogTitle,
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger, Input, PageHeader, toast,
} from '../ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { PromptDialog, type PromptRequest } from '../components/PromptDialog';
import { UploadQueue, useUploadQueue } from '../components/UploadQueue';
import { ApiError, fmtSize, fmtTime, fs, joinPath, type Node, shares } from '../lib/api';
import { download } from '../lib/transfer';

const parentOf = (p: string) => p.replace(/\/[^/]+\/?$/, '') || '/';

async function copy(text: string, what: string) {
  await navigator.clipboard.writeText(text);
  toast.success(`${what}已复制`);
}

export function Files({ path, go }: { path: string; go: (p: string) => void }) {
  const [rows, setRows] = useState<Node[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [searching, setSearching] = useState<Node[] | null>(null);
  const [prompt, setPrompt] = useState<PromptRequest | null>(null);
  const [preview, setPreview] = useState<{ node: Node; url: string } | null>(null);
  const [drag, setDrag] = useState(false);
  const picker = useRef<HTMLInputElement>(null);

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
  const uploads = useUploadQueue(load);

  const runSearch = async () => {
    if (!q.trim()) { setSearching(null); return; }
    try {
      setSearching((await fs.search(q.trim())).items);
    } catch (e) {
      toast.error(e instanceof ApiError && e.status === 429 ? '搜索太频繁, 稍后再试' : (e as Error).message);
    }
  };

  const open = async (n: Node) => {
    if (n.kind === 'dir') { go(n.path ?? joinPath(path, n.name)); return; }
    const { url } = await fs.link(n.id, 3600);
    if (/^(image|video|audio)\//.test(n.mime ?? '') || n.mime === 'application/pdf') setPreview({ node: n, url });
    else await download(url, n.name, n.size, () => {});
  };

  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      await fn();
      if (ok) toast.success(ok);
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const menu = (n: Node) => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="xs" variant="ghost" onClick={(e) => e.stopPropagation()}>···</Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
        {n.kind === 'file' && (
          <>
            <DropdownMenuItem onSelect={() => void fs.link(n.id, 3600).then(({ url }) => download(url, n.name, n.size, () => {}))}>下载</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void fs.link(n.id, 0).then(({ url }) => copy(url, '永久直链'))}>复制永久直链</DropdownMenuItem>
          </>
        )}
        <DropdownMenuItem
          onSelect={() => setPrompt({
            title: `分享 ${n.name}`,
            fields: [{ key: 'pw', label: '密码 (可空)' }, { key: 'days', label: '有效天数 (可空为永久)', type: 'number' }],
            okText: '创建并复制链接',
            onOk: async (v) => {
              const r = await shares.create(n.id, v.pw || undefined, v.days ? Number(v.days) * 86400 : undefined);
              await copy(r.url, '分享链接');
            },
          })}
        >分享</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => setPrompt({
            title: '重命名', fields: [{ key: 'name', label: '新名称', value: n.name }],
            onOk: async (v) => act(() => fs.move(n.id, undefined, v.name.trim())),
          })}
        >重命名</DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => setPrompt({
            title: '移动到', fields: [{ key: 'to', label: '目标目录', value: n.path ? parentOf(n.path) : path }],
            onOk: async (v) => act(() => fs.move(n.id, v.to.trim() || '/', n.name), '已移动'),
          })}
        >移动</DropdownMenuItem>
        <DropdownMenuItem
          className="text-danger-fg"
          onSelect={async () => {
            if (await confirmDialog({ title: `删除 ${n.name}?`, message: '会放进回收站, 保留期内可以恢复。', confirmLabel: '删除', variant: 'danger' })) {
              await act(() => fs.remove(n.id), '已移入回收站');
            }
          }}
        >删除</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const columns: DataTableColumn<Node>[] = [
    { key: 'name', header: '名称', render: (n) => (
      <span className="flex items-center gap-2">
        <span aria-hidden>{n.kind === 'dir' ? '📁' : '📄'}</span>
        <span className="truncate">{n.name}</span>
        {searching && <span className="truncate text-xs text-muted-foreground">{n.path}</span>}
      </span>
    ) },
    { key: 'size', header: '大小', width: '110px', numeric: true, render: (n) => (n.kind === 'dir' ? '' : fmtSize(n.size)) },
    { key: 'time', header: '修改时间', width: '180px', render: (n) => fmtTime(n.updatedAt) },
    { key: 'op', header: '', width: '56px', align: 'right', render: menu },
  ];

  const crumbs = path.split('/').filter(Boolean);

  return (
    <div
      className={`flex min-h-0 flex-1 flex-col gap-3 ${drag ? 'outline-2 outline-dashed outline-primary' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        if (e.dataTransfer.files.length) uploads.add([...e.dataTransfer.files], path);
      }}
    >
      <PageHeader
        title="文件"
        desc={
          <span className="flex flex-wrap items-center gap-1">
            <button className="hover:underline" onClick={() => go('/')}>根目录</button>
            {crumbs.map((c, i) => (
              <span key={i} className="flex items-center gap-1">
                <span>/</span>
                <button className="hover:underline" onClick={() => go('/' + crumbs.slice(0, i + 1).join('/'))}>{c}</button>
              </span>
            ))}
          </span>
        }
        right={
          <div className="flex items-center gap-2">
            <form onSubmit={(e) => { e.preventDefault(); void runSearch(); }}>
              <Input className="w-48" placeholder="搜索文件名" value={q} onChange={(e) => setQ(e.target.value)} />
            </form>
            <Button
              variant="outline"
              onClick={() => setPrompt({
                title: '新建目录', fields: [{ key: 'name', label: '目录名' }],
                onOk: async (v) => act(() => fs.mkdir(joinPath(path, v.name.trim()))),
              })}
            >新建目录</Button>
            <Button variant="primary" onClick={() => picker.current?.click()}>上传</Button>
            <input
              ref={picker}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files?.length) uploads.add([...e.target.files], path);
                e.target.value = '';
              }}
            />
          </div>
        }
      />
      {searching && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          搜索 “{q}” 共 {searching.length} 条
          <Button size="xs" variant="ghost" onClick={() => setSearching(null)}>返回目录</Button>
        </div>
      )}
      <DataTable
        columns={columns}
        rows={searching ?? rows}
        rowKey={(n) => n.id}
        loading={loading}
        onRowClick={(n) => void open(n).catch((e) => toast.error((e as Error).message))}
        emptyText={searching ? '没有匹配的文件' : '空目录, 拖文件进来或点上传'}
        className="min-h-0 flex-1"
      />
      <PromptDialog req={prompt} onClose={() => setPrompt(null)} />
      <Dialog open={!!preview} onOpenChange={(o) => !o && setPreview(null)}>
        <DialogContent className="max-w-4xl">
          <DialogHeader><DialogTitle>{preview?.node.name}</DialogTitle></DialogHeader>
          {preview && (preview.node.mime?.startsWith('image/') ? (
            <img src={preview.url} alt={preview.node.name} className="max-h-[70vh] w-full object-contain" />
          ) : preview.node.mime?.startsWith('video/') ? (
            <video src={preview.url} controls autoPlay className="max-h-[70vh] w-full" />
          ) : preview.node.mime?.startsWith('audio/') ? (
            <audio src={preview.url} controls autoPlay className="w-full" />
          ) : (
            <iframe src={preview.url} title={preview.node.name} className="h-[70vh] w-full" />
          ))}
        </DialogContent>
      </Dialog>
      <UploadQueue q={uploads} />
    </div>
  );
}
