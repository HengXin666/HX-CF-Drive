# HX-CF-Drive

全部运行在 Cloudflare 上的网盘网关。目录树在 D1, 热数据和视频在 R2, 冷数据和图片切成 16 MB 分片存进 Telegram 私有频道。对外提供 REST API, WebDAV, 签名直链和分享链接。

## 特性

- 双后端: R2 (快, 按量付费) + Telegram (免费, 有限速), 按 MIME 和大小自动路由, 也可以按请求指定。
- 目录树: 文件夹, 移动, 重命名, 复制 (只复制元数据), 回收站 (默认保留 7 天), 文件名搜索。
- 分片上传: 断点续传, 幂等重传, sha256 秒传。
- 读取: HTTP Range, 视频拖动, 跨分片拼接, 小文件边缘缓存, R2 公开域名直出。
- 风控: Bot 池 x 频道池, Durable Object 全局限速 (默认每频道 15 条/分), 严格服从 `retry_after`, Bot 失效自动换 Bot 重新取 `file_id`。
- 接入: REST API, WebDAV (rclone, RaiDrive, Finder, Infuse, OpenList), PicGo, ShareX, 受限 API 令牌。
- 运维: 定时任务每 15 分钟做 Bot 探活, 清理过期上传, 回收站清理, 删除频道消息。

## 架构

```
REST    /api/v1  ─┐
WebDAV  /dav     ─┤           ┌─ D1   目录树与元数据
直链    /f/:id   ─┼─ Worker ──┼─ R2   视频与大文件 (multipart)
分享    /s/:id   ─┘  (Hono)   ├─ DO   ChannelLimiter 频道节拍与 Bot 冷却
                              └─ TG   Bot API 私有频道 16 MB 分片
```

## 目录结构

```
src/
  index.ts                   入口, 路由挂载, 定时任务
  env.ts                     绑定与类型
  do/limiter.ts              全局限速 Durable Object
  drivers/tg.ts              Telegram 驱动 (上传, 下载, Bot 池, 重新绑定)
  drivers/r2.ts              R2 驱动 (单块与 multipart)
  lib/                       鉴权, 目录树, Range, 签名, 路由策略, 工具函数
  routes/api.ts              REST API
  routes/dav.ts              WebDAV
  routes/public.ts           签名直链与分享
  services/upload.ts         分片上传流程
  services/serve.ts          读取与流式拼接
  services/maintenance.ts    定时维护
migrations/                  D1 表结构
public/index.html            极简 Web 界面
scripts/quota.mjs            免费额度估算
scripts/mock-tg.mjs          本地模拟 Telegram
scripts/e2e.mjs              端到端冒烟测试
test/                        单元测试
docs/                        额度, 部署, 接入, Telegram 配置
```

## 快速开始

```bash
pnpm install # 或 npm install
cp .dev.vars.example .dev.vars
pnpm db:migrate:local
node scripts/mock-tg.mjs 8887 & # 本地测试可用模拟 Telegram, .dev.vars 里设 TG_API_BASE=http://127.0.0.1:8887
pnpm dev
pnpm test # 单元测试
node scripts/e2e.mjs # 端到端冒烟
```

线上部署见 [docs/DEPLOY.md](docs/DEPLOY.md)。

## 文档

| 文档 | 内容 |
| --- | --- |
| [docs/QUOTA.md](docs/QUOTA.md) | 请求量, 增长坡度, 免费额度占用, 性能评判 |
| [docs/DEPLOY.md](docs/DEPLOY.md) | 从零部署到 Cloudflare |
| [docs/INTEGRATION.md](docs/INTEGRATION.md) | API, WebDAV, PicGo, ShareX, rclone 接入 |
| [docs/TELEGRAM.md](docs/TELEGRAM.md) | 存储小号, 私有频道, Bot 池配置与风控 |

## 已知限制

- Telegram 单分片 ≤ 20 MB (getFile 上限), 因此固定 16 MB 分片。
- 免费计划单次调用最多 50 个子请求, TG 文件单次响应最多拼 20 片 (320 MB), 超出部分用 206 分段返回。不带 Range 的客户端 (如 curl 直接下大文件) 只能拿到前 320 MB, 请用支持 Range 的下载器。
- Cache API 在 `*.workers.dev` 上不生效, 边缘缓存需要绑定自定义域名。
- 搜索用 `LIKE '%q%'`, 会扫全表, 文件很多时是 D1 读行的主要来源。
- WebDAV 的 LOCK 是假锁, 只为兼容 Windows 和 Finder。
