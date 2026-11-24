// 登录页的演示说明。单独成文件, 正常构建里被整体摇掉
import { Icon } from '../components/Icon';

export const DEMO_TOKEN = 'demo';

/** 登录页说明: 令牌随便填, 已预填 */
export function DemoLoginNote() {
  return (
    <div className="mb-4 rounded-xl border border-link/30 bg-link/10 p-3 text-[12.5px] leading-relaxed">
      <div className="mb-1 flex items-center gap-1.5 font-semibold">
        <Icon raw="icon-[solar--shield-check-linear]" className="size-4 text-link" /> 这是纯前端演示
      </div>
      <p className="text-muted-foreground">
        接口都在浏览器内模拟, 数据存在本地 IndexedDB, 不连接任何后端或 Telegram。任意令牌都能进入, 已为你预填 <code className="text-foreground">{DEMO_TOKEN}</code>。
      </p>
    </div>
  );
}
