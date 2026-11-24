// 应用外壳: 左侧导航 (品牌, 页面, 用量, 皮肤, 退出) + 右侧主面板。版式沿用 HX-UI 文档站
import type { ReactNode } from 'react';
import { type IconName } from '../icons';
import { AppFrame, ConfirmDialogHost, Toaster } from '../ui';
import { Icon } from './Icon';

export interface NavItem { id: string; label: string; icon: IconName }

const SKINS = [
  { id: 'default', label: '石墨' },
  { id: 'midnight', label: '午夜' },
  { id: 'linear', label: '靛蓝' },
  { id: 'fintech', label: '深海' },
  { id: 'emerald', label: '翡翠' },
] as const;

export function setSkin(id: string) {
  localStorage.setItem('hxd_skin', id);
  if (id === 'default') document.documentElement.removeAttribute('data-skin');
  else document.documentElement.setAttribute('data-skin', id);
}

export function Shell(props: {
  items: NavItem[];
  active: string;
  onNav: (id: string) => void;
  onLogout: () => void;
  usage?: ReactNode;
  children: ReactNode;
}) {
  const skin = localStorage.getItem('hxd_skin') ?? 'default';
  return (
    <AppFrame className={__DEMO__ ? 'h-full w-full' : undefined}>
      <div className="relative z-10 flex min-h-0 w-full min-w-0 flex-1 gap-2">
        <aside className="hidden w-56 shrink-0 flex-col overflow-hidden rounded-xl border border-border/40 bg-card/25 md:flex">
          <div className="flex h-12 items-center gap-2 px-4">
            <img src={`${import.meta.env.BASE_URL}icon-192.png`} alt="" className="size-7 rounded-lg" />
            <span className="text-[13px] font-semibold tracking-tight">HX-CF-Drive</span>
          </div>
          <nav className="flex flex-col gap-0.5 px-2 py-1">
            {props.items.map((it) => {
              const on = it.id === props.active;
              return (
                <button
                  key={it.id}
                  type="button"
                  onClick={() => props.onNav(it.id)}
                  className={`flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-[13px] transition-colors ${
                    on ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
                  }`}
                >
                  <Icon name={it.icon} className={`size-4 ${on ? 'text-link' : ''}`} />
                  {it.label}
                </button>
              );
            })}
          </nav>
          <div className="flex-1" />
          {props.usage && <div className="mx-2 mb-2 rounded-lg border border-border/40 bg-background/40 p-3">{props.usage}</div>}
          <div className="flex items-center gap-1 border-t border-border/40 px-2 py-2">
            <Icon name="palette" className="ml-1.5 size-4 text-muted-foreground" />
            <select
              aria-label="皮肤"
              defaultValue={skin}
              onChange={(e) => setSkin(e.target.value)}
              className="h-7 min-w-0 flex-1 rounded-md bg-transparent px-1 text-[12px] text-muted-foreground outline-none hover:text-foreground"
            >
              {SKINS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
            <button
              type="button"
              title="退出"
              aria-label="退出"
              onClick={props.onLogout}
              className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <Icon name="logout" />
            </button>
          </div>
        </aside>
        <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-border/40">
          <div className="flex h-11 items-center gap-1 border-b border-border/40 px-2 md:hidden">
            {props.items.map((it) => (
              <button key={it.id} type="button" title={it.label} aria-label={it.label} onClick={() => props.onNav(it.id)}
                className={`grid size-8 place-items-center rounded-md ${it.id === props.active ? 'bg-accent text-link' : 'text-muted-foreground'}`}>
                <Icon name={it.icon} />
              </button>
            ))}
          </div>
          {props.children}
        </main>
      </div>
      <Toaster position="bottom-right" maxVisible={3} />
      <ConfirmDialogHost />
    </AppFrame>
  );
}

// 页面统一骨架: 顶栏 (标题/面包屑 + 右侧操作) + 可滚动内容
export function Page({ title, right, children }: { title: ReactNode; right?: ReactNode; children: ReactNode }) {
  return (
    <>
      <header className="flex min-h-14 flex-wrap items-center gap-3 border-b border-border/40 px-5 py-2">
        <div className="min-w-0 flex-1 text-[15px] font-semibold">{title}</div>
        {right && <div className="flex flex-wrap items-center gap-2">{right}</div>}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
    </>
  );
}
