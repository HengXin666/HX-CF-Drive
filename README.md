# HX-CF-Drive

全部运行在 Cloudflare 上的网盘网关。目录树在 D1, 文件切成 19 MiB 分片存进 Telegram 私有频道, **不使用 R2**。对外提供 REST API, WebDAV, 签名直链和分享链接。

> v0.2 目标: CF 各项额度尽量少用, Worker CPU 尽量低。下面的数字按代码路径推导, 未在线上实测。

## 特性与额度消耗

- 上传无状态: init (D1 只读) → chunk (D1 零读写, 请求体流式直通 TG, 返回签名回执) → commit (一次批量写约 4 行, 含索引)。断点续传靠客户端保存回执。
- 秒传: 浏览器本地算 sha256, 命中时 1 次请求, 写 2 行。
- 分片清单整体存一行 JSON, 读一个文件只读 1 行; 清单, file_path, 节点都缓存在 isolate 内存, 热文件 D1 零读, getFile 零次。
- 单次响应按子请求预算 (`SUBREQ_BUDGET`, 免费 48) 动态拼片: 冷分片 2 次, 热分片 1 次。拼不完返回 206, 前端 / 播放器 / 下载器按 Range 续拉。
- 不用 Durable Object: Bot 冷却放内存, TG 429 直接回给客户端按 Retry-After 重试, 下次自动换 Bot。
- 去掉审计日志, 分享计数, 令牌最后使用时间, 频道消息计数等每次操作都要写的行。
- 模糊搜索会扫全表, 按令牌限频 (`SEARCH_PER_MIN`, 默认 6/分)。按路径或 ID 访问是索引查找。
- 定时任务每天一次; 静态前端直接由 Assets 返回, 不进 Worker。
- CPU: 下载由 FixedLengthStream 原生搬运; 上传不再 `arrayBuffer()`, multipart 头尾 + 请求体原生管道拼接; 服务端不算哈希。
- 接入: REST API, WebDAV (rclone, RaiDrive, Finder, Infuse, OpenList), PicGo, ShareX, 受限 API 令牌。
- 运维: 定时任务每天一次: Bot 探活, 回收站清理, 删除无引用分片的频道消息。

## 架构

```
REST    /api/v1  ─┐
WebDAV  /dav     ─┤           ┌─ D1   目录树与元数据
直链    /f/:id   ─┼─ Worker ──┤        (分片清单一行 JSON)
分享    /s/:id   ─┘  (Hono)   └─ TG   Bot API 私有频道 19 MiB 分片
静态前端 public/  由 Assets 直接返回, 不进 Worker
```

## 目录结构

```
src/
  index.ts                   入口, 路由挂载, 定时任务
  env.ts                     绑定与类型
  drivers/tg.ts              Telegram 驱动 (上传, 下载, Bot 池, 重新绑定)
  lib/                       鉴权, 目录树, Range, 签名, D1 计量, 工具函数
  routes/api.ts              REST API
  routes/dav.ts              WebDAV
  routes/public.ts           签名直链与分享
  services/upload.ts         无状态分片上传 (签名凭证 + 回执)
  services/serve.ts          读取与流式拼接
  services/maintenance.ts    定时维护
migrations/                  D1 表结构
web/                         前端 (React + TS + HX-UI), 构建到 dist/web 由 Assets 直接返回
skills/hx-cf-drive/          给 AI Agent 的 Skill 与命令行脚本
  src/lib/transfer.ts        浏览器端 sha256 秒传, 断点续传, 大文件 Range 续拉
scripts/quota.mjs            免费额度估算 (按实测单次行数)
scripts/meter.mjs            实测每个操作的 D1 行读写
scripts/mock-tg.mjs          本地模拟 Telegram
scripts/e2e.mjs              端到端冒烟测试
test/                        单元测试
docs/                        额度, 部署, 接入, Telegram 配置
```

## 快速开始

```bash
npm install
npm install --prefix web
cp .dev.vars.example .dev.vars
npm run db:migrate:local
node scripts/mock-tg.mjs 8887 & # 本地测试可用模拟 Telegram, .dev.vars 里设 TG_API_BASE=http://127.0.0.1:8887
npm run dev                     # Worker, 8787
npm run dev:web                 # 前端热更新, 5173, 接口代理到 8787
npm test                        # 单元测试
node scripts/e2e.mjs            # 端到端冒烟
```

## 前端

`web/` 是 React + TypeScript 前端, UI 用 [HX-UI](https://github.com/HengXin666/HX-UI), 只用暗色主题, 侧栏可切换 5 套皮肤, 图标全部为 SVG (Iconify Solar)。

功能: 令牌登录, 目录浏览, 拖放上传 (浏览器算 sha256 秒传, 断点续传, 同名可覆盖或保留两者), 图片/视频/音频/PDF/文本预览, 大文件分段下载, 重命名/移动/删除, 回收站, 搜索, 分享与永久直链, 后台 (统计, 频道, Bot, 令牌, 手动维护), 接口文档页。

`npm run build:web` 构建到 `dist/web`, `wrangler deploy` 时作为静态资源上传, 静态资源请求不进 Worker, 不计请求数。HX-UI 尚未发布到 npm, 暂以 `web/vendor/hx-ui-*.tgz` 引入。

## 接口文档与 Agent 接入

- 网页内: 侧栏 "接口文档" (`/#/docs`), 全部接口带请求体, 返回值和可复制的 curl。数据源是 `web/src/docs/endpoints.ts`。
- `skills/hx-cf-drive/SKILL.md`: 给 AI Agent 的 Skill (Claude Code 等可直接放进 skills 目录), 部署后也发布在 `/skill.md`。
- `skills/hx-cf-drive/scripts/hxd.mjs`: 无依赖命令行 (ls, put, get, link, share ...), 自动分片, 秒传, 429 重试, 大文件 Range 续拉。
- `/llms.txt`: 给 LLM 的站点索引。

让 Agent 接入只需一句: "读取 `https://你的域名/skill.md`, 按其中说明使用 HX-CF-Drive, BASE=..., TOKEN=<受限令牌>"。

线上部署见 [docs/DEPLOY.md](docs/DEPLOY.md)。

## 文档

| 文档 | 内容 |
| --- | --- |
| [docs/QUOTA.md](docs/QUOTA.md) | 请求量, 增长坡度, 免费额度占用, 性能评判 |
| [docs/DEPLOY.md](docs/DEPLOY.md) | 从零部署到 Cloudflare |
| [docs/INTEGRATION.md](docs/INTEGRATION.md) | API, WebDAV, PicGo, ShareX, rclone 接入 |
| [docs/TELEGRAM.md](docs/TELEGRAM.md) | 存储小号, 私有频道, Bot 池配置与风控 |
| [docs/COMPARISON.md](docs/COMPARISON.md) | 与 CloudFlare-ImgBed, Teldrive 等成熟方案对比 |

## 已知限制

- Telegram 单分片 ≤ 20 MB (getFile 上限), 因此固定 19 MiB 分片。
- 免费计划单次调用最多 50 个外部子请求。冷分片要 2 次 (getFile + 下载), 热分片 1 次, 所以单次响应冷拼 24 片 (约 456 MB), 热拼 48 片, 超出部分 206 截断。不带 Range 的客户端 (如 curl 直接下大文件) 只能拿到第一段; 网页端和播放器会自动用 Range 续拉。Paid 计划上限 10,000, 把 `SUBREQ_BUDGET` 调大即可。
- Cache API 在 `*.workers.dev` 上不生效, 边缘缓存需要绑定自定义域名。
- 搜索用 `LIKE '%q%'`, 未命中时扫全表, 是 D1 读行的主要来源, 已按令牌限频。
- WebDAV 的 LOCK 是假锁, 只为兼容 Windows 和 Finder。
- 不支持空文件 (0 字节)。
- 同一分片被并发重传时, TG 里可能多出一条无引用消息, 只占频道空间, 不影响读取。
- 上传路径的 CPU 时间尚未在线上实测, 部署后用 `wrangler tail` 看 `cpuTime`。
