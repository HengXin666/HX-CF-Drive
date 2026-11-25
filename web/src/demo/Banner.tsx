// 演示声明: 顶部常驻横幅 (含仓库/部署文档链接与重置), 登录页说明卡片
import { type ReactNode, useState } from 'react';
import { Icon } from '../components/Icon';
import { Button, Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../ui';
import { load, wipe } from './db';
import { seed } from './seed';

export const REPO = 'https://github.com/HengXin666/HX-CF-Drive';
export const DEPLOY_DOC = `${REPO}/blob/main/docs/DEPLOY.md`;

/** 清空本地演示数据并重新播种 */
export async function resetDemo(): Promise<void> {
  await wipe();
  for (const k of Object.keys(localStorage)) if (k.startsWith('hxd_up:')) localStorage.removeItem(k);
  await load();
  await seed();
}

const linkCls = 'flex h-7 items-center gap-1.5 rounded-md px-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground';

function ResetButton() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      await resetDemo();
      location.reload();
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button type="button" className={linkCls} onClick={() => setOpen(true)}>
        <Icon name="restore" className="size-3.5" /> 重置演示数据
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader><DialogTitle>重置演示数据?</DialogTitle></DialogHeader>
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            会清空你在演示里上传, 修改, 删除的全部内容, 恢复成初始示例数据。数据只在本浏览器里, 不影响任何人。
          </p>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>取消</Button>
            <Button variant="destructive" loading={busy} onClick={() => void run()}>重置</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function DemoBanner() {
  return (
    <div role="note" className="relative z-20 flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b bg-card/80 px-4 py-1.5 text-[12.5px] backdrop-blur">
      <span className="flex min-w-0 items-center gap-2">
        <Icon name="info" className="text-brand" />
        <span>
          <b className="font-semibold">纯前端演示</b>
          <span className="text-muted-foreground">: 所有数据只保存在你的浏览器里, 不连接任何后端或 Telegram</span>
        </span>
      </span>
      <span className="ml-auto flex flex-wrap items-center gap-0.5">
        <a className={linkCls} href={REPO} target="_blank" rel="noreferrer">
          <Icon name="code" className="size-3.5" /> 源码仓库
        </a>
        <a className={linkCls} href={DEPLOY_DOC} target="_blank" rel="noreferrer">
          <Icon name="rocket" className="size-3.5" /> 部署自己的网盘
        </a>
        <ResetButton />
      </span>
    </div>
  );
}

/** 横幅在上, 页面占满剩余高度 */
export function DemoFrame({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full flex-col">
      <DemoBanner />
      <div className="relative min-h-0 flex-1">
        <div className="absolute inset-0">{children}</div>
      </div>
    </div>
  );
}
