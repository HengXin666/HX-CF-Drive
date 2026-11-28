// 批量重命名 (#22): 序号模板 或 正则替换, 下方实时预览, 一次 /fs/batch 提交
import { useEffect, useMemo, useState } from 'react';
import { fs, type Node } from '../lib/api';
import { applyRename, type RenameRule } from '../lib/rename';
import {
  Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Field, Input, Switch, toast, ToggleGroup, ToggleGroupItem,
} from '../ui';

export function RenameDialog({ nodes, onClose, onDone }: { nodes: Node[] | null; onClose: () => void; onDone: () => void }) {
  const [mode, setMode] = useState<'seq' | 'regex'>('seq');
  const [template, setTemplate] = useState('{name}_{n}');
  const [start, setStart] = useState(1);
  const [pad, setPad] = useState(2);
  const [keepExt, setKeepExt] = useState(true);
  const [find, setFind] = useState('');
  const [replace, setReplace] = useState('');
  const [ignoreCase, setIgnoreCase] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setBusy(false); }, [nodes]);

  const list = nodes ?? [];
  const rule: RenameRule = mode === 'seq' ? { mode, template, start, pad, keepExt } : { mode, find, replace, ignoreCase };
  const { out, err } = useMemo(() => {
    try { return { out: applyRename(list.map((n) => n.name), rule), err: '' }; } catch (e) { return { out: list.map((n) => n.name), err: (e as Error).message }; }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list, mode, template, start, pad, keepExt, find, replace, ignoreCase]);
  const changes = list.map((n, i) => ({ id: n.id, from: n.name, name: out[i] })).filter((x) => x.name !== x.from);
  const dup = new Set(out).size !== out.length;

  const submit = async () => {
    setBusy(true);
    try {
      const r = await fs.batch({ op: 'rename', items: changes.map(({ id, name }) => ({ id, name })) });
      if (r.failed.length) toast.error(`${r.failed.length} 项没改成: ${r.failed.slice(0, 3).map((f) => `${list.find((n) => n.id === f.id)?.name}: ${f.error}`).join('; ')}`);
      else toast.success(`已重命名 ${r.ok} 项`);
      onDone();
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={!!nodes} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>批量重命名 {list.length} 项</DialogTitle>
          <DialogDescription>按当前列表顺序编号; 正则用 JavaScript 语法, 替换里可以写 $1。</DialogDescription>
        </DialogHeader>
        <ToggleGroup type="single" variant="outline" size="sm" value={mode} aria-label="重命名方式" onValueChange={(v) => v && setMode(v as 'seq' | 'regex')}>
          <ToggleGroupItem value="seq">序号</ToggleGroupItem>
          <ToggleGroupItem value="regex">正则</ToggleGroupItem>
        </ToggleGroup>
        {mode === 'seq' ? (
          <div className="grid gap-3 sm:grid-cols-[1fr_6rem_6rem]">
            <Field label="模板" description="{n} 序号, {name} 原名 (不含扩展名)"><Input value={template} onChange={(e) => setTemplate(e.target.value)} /></Field>
            <Field label="起始"><Input type="number" value={start} onChange={(e) => setStart(Math.floor(Number(e.target.value) || 0))} /></Field>
            <Field label="位数"><Input type="number" min={0} max={8} value={pad} onChange={(e) => setPad(Math.min(8, Math.max(0, Math.floor(Number(e.target.value) || 0))))} /></Field>
            <Field label="保留扩展名" orientation="horizontal"><Switch checked={keepExt} onCheckedChange={setKeepExt} /></Field>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="查找 (正则)" error={err || undefined}><Input value={find} placeholder="如 IMG_(\d+)" onChange={(e) => setFind(e.target.value)} /></Field>
            <Field label="替换为"><Input value={replace} placeholder="如 照片_$1" onChange={(e) => setReplace(e.target.value)} /></Field>
            <Field label="忽略大小写" orientation="horizontal"><Switch checked={ignoreCase} onCheckedChange={setIgnoreCase} /></Field>
          </div>
        )}
        <div className="max-h-56 overflow-auto rounded-lg border bg-background/50 p-2 font-mono text-xs" aria-label="预览">
          {list.slice(0, 200).map((n, i) => (
            <div key={n.id} className="grid grid-cols-[1fr_auto_1fr] gap-2 py-0.5">
              <span className="truncate text-muted-foreground">{n.name}</span>
              <span className="text-muted-foreground">→</span>
              <span className={out[i] === n.name ? 'truncate text-muted-foreground' : 'truncate text-foreground'}>{out[i]}</span>
            </div>
          ))}
        </div>
        {dup && <p className="text-sm text-destructive">新名字有重复, 请调整规则。</p>}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button loading={busy} disabled={!!err || dup || !changes.length} onClick={() => void submit()}>重命名 {changes.length} 项</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
