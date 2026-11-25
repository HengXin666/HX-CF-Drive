// 通用输入框弹窗: 新建目录, 重命名, 分享密码, 新建令牌等
import { useEffect, useState } from 'react';
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Field, Input } from '../ui';

export interface PromptField { key: string; label: string; value?: string; placeholder?: string; type?: string; description?: string }

export interface PromptRequest {
  title: string;
  fields: PromptField[];
  okText?: string;
  /** 输入框上方的说明 */
  note?: string;
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
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{req?.title}</DialogTitle>
          {req?.note && <DialogDescription className="whitespace-pre-line">{req.note}</DialogDescription>}
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          {req?.fields.map((f, i) => (
            <Field key={f.key} label={f.label} description={f.description} error={i === req.fields.length - 1 ? err || undefined : undefined}>
              <Input
                autoFocus={i === 0}
                type={f.type ?? 'text'}
                placeholder={f.placeholder}
                value={values[f.key] ?? ''}
                onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
              />
            </Field>
          ))}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>取消</Button>
            <Button type="submit" loading={busy}>{req?.okText ?? '确定'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
