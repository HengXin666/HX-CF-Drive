// 通用输入框弹窗: 新建目录, 重命名, 移动, 分享密码等
import { Button, Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, Input } from '../ui';
import { useEffect, useState } from 'react';

export interface PromptField { key: string; label: string; value?: string; placeholder?: string; type?: string }

export interface PromptRequest {
  title: string;
  fields: PromptField[];
  okText?: string;
  onOk: (values: Record<string, string>) => Promise<void> | void;
}

export function PromptDialog({ req, onClose }: { req: PromptRequest | null; onClose: () => void }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    setValues(Object.fromEntries((req?.fields ?? []).map((f) => [f.key, f.value ?? ''])));
    setErr('');
  }, [req]);

  const submit = async () => {
    if (!req) return;
    setBusy(true);
    setErr('');
    try {
      await req.onOk(values);
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={!!req} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{req?.title}</DialogTitle>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          {req?.fields.map((f, i) => (
            <label key={f.key} className="flex flex-col gap-1 text-sm">
              <span className="text-muted-foreground">{f.label}</span>
              <Input
                autoFocus={i === 0}
                type={f.type ?? 'text'}
                placeholder={f.placeholder}
                value={values[f.key] ?? ''}
                onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
              />
            </label>
          ))}
          {err && <p className="text-sm text-danger-fg">{err}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>取消</Button>
            <Button type="submit" variant="primary" loading={busy}>{req?.okText ?? '确定'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
