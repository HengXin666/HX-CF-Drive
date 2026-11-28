// 编辑分享 (#22): 启用 / 停用, 备注, 密码 (不变 / 新密码 / 去掉), 有效期 (不变 / 永久 / 从现在起 N 天)
import { useEffect, useState } from 'react';
import { fmtTime, type SharePatch, type ShareRow, shares } from '../lib/api';
import {
  Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Field, Input, Switch, toast, ToggleGroup, ToggleGroupItem,
} from '../ui';

export function ShareEditDialog({ share, onClose, onSaved }: { share: ShareRow | null; onClose: () => void; onSaved: () => void }) {
  const [enabled, setEnabled] = useState(true);
  const [remark, setRemark] = useState('');
  const [pwMode, setPwMode] = useState<'keep' | 'set' | 'none'>('keep');
  const [pw, setPw] = useState('');
  const [expMode, setExpMode] = useState<'keep' | 'never' | 'days'>('keep');
  const [days, setDays] = useState('7');
  const [maxDl, setMaxDl] = useState('');
  const [reset, setReset] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!share) return;
    setEnabled(!share.disabled);
    setRemark(share.remark ?? '');
    setPwMode('keep');
    setPw('');
    setExpMode('keep');
    setDays('7');
    setMaxDl(share.max_downloads ? String(share.max_downloads) : '');
    setReset(false);
  }, [share]);

  const save = async () => {
    if (!share) return;
    const patch: SharePatch = {};
    if (enabled === !!share.disabled) patch.disabled = !enabled;
    if (remark.trim() !== (share.remark ?? '')) patch.remark = remark.trim() || null;
    if (pwMode === 'set') {
      if (!pw) { toast.error('请输入新密码'); return; }
      patch.password = pw;
    } else if (pwMode === 'none') patch.password = null;
    if (expMode === 'never') patch.expiresIn = null;
    else if (expMode === 'days') {
      const d = Number(days);
      if (!(d > 0)) { toast.error('有效天数要大于 0'); return; }
      patch.expiresIn = Math.round(d * 86400);
    }
    const md = maxDl.trim() ? Number(maxDl) : null;
    if (md !== null && !(Number.isInteger(md) && md >= 1)) { toast.error('下载次数上限要是正整数, 留空为不限'); return; }
    if (md !== (share.max_downloads ?? null)) patch.maxDownloads = md;
    if (reset) patch.resetDownloads = true;
    if (!Object.keys(patch).length) { onClose(); return; }
    setBusy(true);
    try {
      await shares.update(share.id, patch);
      toast.success('分享已更新');
      onSaved();
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={!!share} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>编辑分享 {share?.name}</DialogTitle>
          <DialogDescription>链接地址不变。改密码后, 之前输过密码的访客要重新输入。</DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); void save(); }}>
          <Field label="启用" description="停用后访问返回“分享已停用”, 可以随时再启用" orientation="horizontal">
            <Switch checked={enabled} onCheckedChange={setEnabled} />
          </Field>
          <Field label="备注" description="只有你能看到"><Input value={remark} maxLength={200} onChange={(e) => setRemark(e.target.value)} /></Field>
          <Field label={`访问密码 (现在: ${share?.has_password ? '有' : '无'})`}>
            <ToggleGroup type="single" variant="outline" size="sm" value={pwMode} aria-label="访问密码" onValueChange={(v) => v && setPwMode(v as typeof pwMode)}>
              <ToggleGroupItem value="keep">不变</ToggleGroupItem>
              <ToggleGroupItem value="set">设新密码</ToggleGroupItem>
              <ToggleGroupItem value="none" disabled={!share?.has_password}>去掉密码</ToggleGroupItem>
            </ToggleGroup>
          </Field>
          {pwMode === 'set' && <Field label="新密码"><Input type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} /></Field>}
          <Field label={`有效期 (现在: ${share?.expires_at ? `${fmtTime(share.expires_at)} 到期` : '永久'})`}>
            <ToggleGroup type="single" variant="outline" size="sm" value={expMode} aria-label="有效期" onValueChange={(v) => v && setExpMode(v as typeof expMode)}>
              <ToggleGroupItem value="keep">不变</ToggleGroupItem>
              <ToggleGroupItem value="never">永久</ToggleGroupItem>
              <ToggleGroupItem value="days">从现在起</ToggleGroupItem>
            </ToggleGroup>
          </Field>
          <Field label="下载次数上限" description={`留空为不限 (不计数)。HEAD 和断点续传不计数${share?.max_downloads ? `; 已下载 ${share.downloads ?? 0} 次` : ''}`}>
            <Input type="number" min={1} step={1} placeholder="不限" value={maxDl} onChange={(e) => setMaxDl(e.target.value)} />
          </Field>
          {!!share?.downloads && (
            <Field label="清零已下载次数" orientation="horizontal"><Switch checked={reset} onCheckedChange={setReset} /></Field>
          )}
          {expMode === 'days' && <Field label="有效天数"><Input type="number" min={0} step="any" value={days} onChange={(e) => setDays(e.target.value)} /></Field>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>取消</Button>
            <Button type="submit" loading={busy}>保存</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
