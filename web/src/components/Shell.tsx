// 应用外壳: 左侧导航 (HX-UI Sidebar, 手机上收成抽屉) + 右侧主区。版式对齐 HX-UI 文档站:
// 侧栏分组, 条目右侧小号等宽注释; 页头是等宽小字眉标 + 大标题 + 说明。
import { useTheme } from '@hx/ui/theme';
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarHeader,
  SidebarInset, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarProvider, SidebarTrigger, useSidebar,
} from '@hx/ui/ui/sidebar';
import { ConfirmDialogHost, Toaster, TooltipProvider } from '../ui';
import type { ReactNode } from 'react';
import { type IconName } from '../icons';

import { Icon, IconButton } from './Icon';

export interface NavItem { id: string; label: string; hint: string; icon: IconName; group: string }

export function ThemeToggle() {
  const { resolved, setMode } = useTheme();
  return (
    <IconButton
      name={resolved === 'dark' ? 'sun' : 'moon'}
      label={resolved === 'dark' ? '切换到亮色' : '切换到暗色'}
      onClick={() => setMode(resolved === 'dark' ? 'light' : 'dark')}
    />
  );
}

// 手机上侧栏是抽屉, 点了条目要收起来
function NavButton({ item, active, onNav }: { item: NavItem; active: boolean; onNav: (id: string) => void }) {
  const { isMobile, setOpenMobile } = useSidebar();
  return (
    <SidebarMenuButton isActive={active} onClick={() => { onNav(item.id); if (isMobile) setOpenMobile(false); }}>
      <Icon name={item.icon} />
      <span>{item.label}</span>
      <span className="ml-auto font-mono text-[10.5px] text-muted-foreground">{item.hint}</span>
    </SidebarMenuButton>
  );
}

export function Shell(props: {
  items: NavItem[];
  active: string;
  onNav: (id: string) => void;
  onLogout: () => void;
  usage?: ReactNode;
  children: ReactNode;
}) {
  const groups = [...new Set(props.items.map((i) => i.group))];
  return (
    <TooltipProvider delayDuration={300}>
            {/* 侧栏默认 fixed 贴着视口; 演示站顶上有横幅, 改成相对外层定位 */}
      <SidebarProvider className={__DEMO__ ? 'relative h-full min-h-0' : 'h-svh min-h-0'}>
        <Sidebar collapsible="offcanvas" className={__DEMO__ ? 'md:absolute md:h-full' : undefined}>
          <SidebarHeader className="h-14 flex-row items-center gap-2.5 border-b px-4">
            <img src={`${import.meta.env.BASE_URL}icon-192.png`} alt="" className="size-7 rounded-md" />
            <div className="grid leading-tight">
              <span className="text-sm font-semibold tracking-tight">HX-CF-Drive</span>
              <span className="font-mono text-[10.5px] text-muted-foreground">Cloudflare · Telegram</span>
            </div>
          </SidebarHeader>
          <SidebarContent>
            {groups.map((g) => (
              <SidebarGroup key={g}>
                <SidebarGroupLabel>{g}</SidebarGroupLabel>
                <SidebarGroupContent>
                  <SidebarMenu>
                    {props.items.filter((i) => i.group === g).map((it) => (
                      <SidebarMenuItem key={it.id}>
                        <NavButton item={it} active={it.id === props.active} onNav={props.onNav} />
                      </SidebarMenuItem>
                    ))}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            ))}
          </SidebarContent>
          <SidebarFooter className="gap-2 border-t p-3">
            {props.usage && <div className="rounded-lg border bg-background/60 p-3">{props.usage}</div>}
            <div className="flex items-center gap-1">
              <ThemeToggle />
              <div className="flex-1" />
              <IconButton name="logout" label="退出登录" onClick={props.onLogout} />
            </div>
          </SidebarFooter>
        </Sidebar>
        <SidebarInset className="min-h-0 min-w-0 overflow-hidden">{props.children}</SidebarInset>
        <Toaster position="bottom-right" visibleToasts={3} />
        <ConfirmDialogHost />
      </SidebarProvider>
    </TooltipProvider>
  );
}

/**
 * 页面骨架: 顶栏 (手机上的侧栏开关 + 路径眉标 + 右侧小工具) / 标题行 (图标, 标题, 一行元信息, 右侧操作) / 内容。
 * 标题刻意做小: 这是工具页不是落地页, 空间留给列表。
 */
export function Page({ eyebrow, icon, title, meta, right, toolbar, children }: {
  eyebrow?: ReactNode;
  icon?: IconName;
  title: ReactNode;
  meta?: ReactNode;
  right?: ReactNode;
  toolbar?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3 md:px-6">
        <SidebarTrigger className="-ml-1 md:hidden" />
        <div className="flex min-w-0 flex-1 items-center gap-2 font-mono text-xs text-muted-foreground">
          <span className="size-1.5 shrink-0 rounded-full bg-brand" />
          {eyebrow}
        </div>
        {toolbar}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-3 py-4 md:gap-5 md:px-6 md:py-6">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <div className="flex min-w-0 flex-1 items-center gap-3">
              {icon && (
                <span className="grid size-9 shrink-0 place-items-center rounded-lg border bg-muted/40 text-muted-foreground">
                  <Icon name={icon} />
                </span>
              )}
              <div className="grid min-w-0">
                <h1 className="truncate text-base font-semibold leading-snug md:text-lg">{title}</h1>
                {meta && <div className="flex min-w-0 items-center gap-3 truncate text-xs text-muted-foreground">{meta}</div>}
              </div>
            </div>
            {right && <div className="flex flex-wrap items-center gap-2">{right}</div>}
          </div>
          {children}
        </div>
      </div>
    </div>
  );
}

/** 元信息里的一项: 小图标 + 文字 */
export function Meta({ icon, children }: { icon: IconName; children: ReactNode }) {
  return <span className="inline-flex shrink-0 items-center gap-1"><Icon name={icon} className="size-3.5" />{children}</span>;
}
