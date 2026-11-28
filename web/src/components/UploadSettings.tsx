// 上传设置 (#22): 浏览器端图片压缩 / 转 WebP 的开关, 质量, 最长边
import { useEffect, useState } from 'react';
import { type CompressPrefs, getPrefs, setPrefs } from '../lib/compress';
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Field, Input, Slider, Switch, toast } from '../ui';

export function UploadSettings({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [p, setP] = useState<CompressPrefs>(getPrefs);
  useEffect(() => { if (open) setP(getPrefs()); }, [open]);
  const set = (d: Partial<CompressPrefs>) => setP((x) => ({ ...x, ...d }));
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>上传设置</DialogTitle>
          <DialogDescription>图片在浏览器里处理后再上传, 不占服务器 CPU。GIF, APNG, 动态 WebP 和 SVG 原样上传; 压完更大时用原图。只对本浏览器生效。</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <Field label="上传前压缩图片" orientation="horizontal"><Switch checked={p.on} onCheckedChange={(v) => set({ on: v })} /></Field>
          <Field label="转成 WebP" description="关闭则保持原格式: JPEG / WebP 按质量重新编码, PNG 只缩放" orientation="horizontal" disabled={!p.on}>
            <Switch checked={p.webp} onCheckedChange={(v) => set({ webp: v })} />
          </Field>
          <Field label={`质量 ${Math.round(p.quality * 100)}`} disabled={!p.on}>
            <Slider disabled={!p.on} min={40} max={100} step={1} value={[Math.round(p.quality * 100)]} onValueChange={(v) => set({ quality: v[0] / 100 })} />
          </Field>
          <Field label="最长边 (像素)" description="超过就等比缩小; 0 或留空为不缩放" disabled={!p.on}>
            <Input type="number" min={0} step={1} disabled={!p.on} value={p.maxEdge || ''} placeholder="0"
              onChange={(e) => set({ maxEdge: Math.max(0, Math.floor(Number(e.target.value) || 0)) })} />
          </Field>
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>取消</Button>
          <Button type="button" onClick={() => { setPrefs(p); toast.success(p.on ? '已开启上传前压缩' : '已关闭上传前压缩'); onClose(); }}>保存</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
