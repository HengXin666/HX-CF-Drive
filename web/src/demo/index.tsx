// 演示模式入口: 拦截 fetch, 准备本地数据, 渲染横幅 + 应用 (或直链/分享页)
import type { ReactNode } from 'react';
import { DemoFrame } from './Banner';
import { load } from './db';
import { PublicView, publicKind } from './PublicView';
import { seed } from './seed';
import { handle, route } from './server';

function patchFetch() {
  const real = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    // 先按地址判断, 不归演示层的请求原样交给浏览器, 避免提前消费请求体
    if (!route(href)) return real(input, init);
    return handle(new Request(input instanceof Request ? input : new URL(href, location.href), init));
  };
}

export async function boot(render: (node: ReactNode) => void, app: ReactNode): Promise<void> {
  patchFetch();
  if (!(await load())) await seed();
  render(<DemoFrame>{publicKind() ? <PublicView /> : app}</DemoFrame>);
}
