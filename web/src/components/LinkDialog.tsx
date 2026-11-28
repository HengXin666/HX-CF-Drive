// 复制链接弹窗 (#22): 一个或一批文件的永久直链, 可选 URL / Markdown / HTML / BBCode, 一键复制全部
import { useEffect, useState } from 'react';
import { fs, type Node } from '../lib/api';
import { FORMATS, formatLinks, type LinkFormat, type LinkItem } from '../lib/linkfmt';
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Textarea, toast, ToggleGroup, ToggleGroupItem } from '../ui';
import { Icon } from './Icon';

const BATCH = 200;

const KEY = 'hxd_linkfmt';
const lastFormat = (): LinkFormat => {
  const v = localStorage.getItem(KEY);
  return FORMATS.some((x) => x.id === v) ? (v as LinkFormat) : 'url';
};
const rememberFormat = (f: LinkFormat) => localStorage.setItem(KEY, f);


export function LinkDialog({ nodes, onClose }: { nodes: Node[] | null; onClose: () => void }) {
  const [fmt, setFmt] = useState<LinkFormat>(lastFormat);
  const [items, setItems] = useState<LinkItem[] | null>(null);
  const [err, setErr] = useState('');
  const files = (nodes ?? []).filter((n) => n.kind === 'file');
  const key = files.map((n) => n.id).join(',');

  useEffect(() => {
    if (!key) { setItems(null); return; }
    let live = true;
    setItems(null);
    setErr('');
    (async () => {
      const ids = key.split(',');
      const out: (LinkItem & { id: string })[] = [];
      // 每批 200 个一次请求 (POST /fs/links)
      for (let i = 0; i < ids.length; i += BATCH) out.push(...(await fs.links(ids.slice(i, i + BATCH), 0)).items);
      // 按选中的顺序
      const order = new Map(ids.map((id, i) => [id, i]));
      out.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
      if (live) setItems(out);
    })().catch((e) => live && setErr((e as Error).message));
    return () => { live = false; };
  }, [key]);

  const text = items ? formatLinks(items, fmt) : '';
  const skipped = (nodes?.length ?? 0) - files.length;
  return (
    <Dialog open={!!nodes} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{files.length > 1 ? `复制 ${files.length} 个文件的链接` : `复制链接 ${files[0]?.name ?? ''}`}</DialogTitle>
          <DialogDescription>永久直链, 不需要令牌即可访问; 吊销签发它的令牌后失效。{skipped > 0 ? ` 已跳过 ${skipped} 个目录。` : ''}</DialogDescription>
        </DialogHeader>
        <ToggleGroup type="single" variant="outline" size="sm" value={fmt} aria-label="链接格式"
          onValueChange={(v) => { if (v) { setFmt(v as LinkFormat); rememberFormat(v as LinkFormat); } }}>
          {FORMATS.map((f) => <ToggleGroupItem key={f.id} value={f.id}>{f.label}</ToggleGroupItem>)}
        </ToggleGroup>
        <Textarea readOnly aria-label="链接" className="max-h-72 min-h-28 font-mono text-xs" value={err || (items ? text : '生成中…')} onFocus={(e) => e.currentTarget.select()} />
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>关闭</Button>
          <Button type="button" disabled={!items?.length} onClick={() => void navigator.clipboard.writeText(text).then(() => { toast.success(`已复制 ${items!.length} 条链接`); onClose(); }, (e) => toast.error((e as Error).message))}>
            <Icon name="copy" /> 复制{items && items.length > 1 ? '全部' : ''}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
