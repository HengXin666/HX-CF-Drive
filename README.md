<div align="center">

<img src="web/public/icon-192.png" width="96" alt="HX-CF-Drive">

<h1>HX-CF-Drive</h1>

<p><b>全部跑在 Cloudflare 上的网盘网关, 把 Telegram 私有频道当作块存储。</b></p>

<p>目录树放在 D1, 文件切成 19 MiB 分片存进 Telegram, 不使用 R2 和 Durable Object。<br>对外提供 REST API, WebDAV, 签名直链, 分享链接, 以及给 AI Agent 用的 Skill 和命令行。</p>

<p>
<a href="https://github.com/HengXin666/HX-CF-Drive/blob/main/LICENSE"><img alt="License" src="https://img.shields.io/github/license/HengXin666/HX-CF-Drive?style=flat-square&color=7c8cff"></a>
<a href="https://workers.cloudflare.com/"><img alt="Cloudflare Workers" src="https://img.shields.io/badge/Cloudflare-Workers-F38020?style=flat-square&logo=cloudflareworkers&logoColor=white"></a>
<a href="https://developers.cloudflare.com/d1/"><img alt="Cloudflare D1" src="https://img.shields.io/badge/Cloudflare-D1-F38020?style=flat-square&logo=cloudflare&logoColor=white"></a>
<a href="https://core.telegram.org/bots/api"><img alt="Telegram Bot API" src="https://img.shields.io/badge/Telegram-Bot%20API-2AABEE?style=flat-square&logo=telegram&logoColor=white"></a>
<a href="https://www.typescriptlang.org/"><img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5-3178C6?style=flat-square&logo=typescript&logoColor=white"></a>
<a href="https://react.dev/"><img alt="React" src="https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react&logoColor=black"></a>
<a href="https://hono.dev/"><img alt="Hono" src="https://img.shields.io/badge/Hono-4-E36002?style=flat-square&logo=hono&logoColor=white"></a>
</p>

<p>
<a href="https://hengxin666.github.io/HX-CF-Drive/"><img alt="在线演示 (纯前端)" src="https://img.shields.io/badge/%E5%9C%A8%E7%BA%BF%E6%BC%94%E7%A4%BA-%E7%BA%AF%E5%89%8D%E7%AB%AF-7c8cff?style=for-the-badge&logo=githubpages&logoColor=white"></a><br>
<a href="https://hengxin666.github.io/HX-CF-Drive/"><b>在线演示 (纯前端)</b></a>: 接口在浏览器内模拟, 数据只存在你的浏览器里, 不连接任何后端或 Telegram
</p>

<p>
<a href="#-快速开始">快速开始</a> |
<a href="docs/DEPLOY.md">部署指南</a> |
<a href="docs/INTEGRATION.md">接入文档</a> |
<a href="docs/QUOTA.md">额度分析</a> |
<a href="docs/COMPARISON.md">方案对比</a>
</p>

</div>

---

## ✨ 特性

<p align="center"><img src="docs/assets/features.svg" width="100%" alt="HX-CF-Drive 特性"></p>

v0.2 的目标只有两个: Cloudflare 各项额度尽量少用, Worker CPU 尽量低。具体做法:

- **上传无状态**: 分片阶段 D1 零读写, 请求体流式直通 Telegram, 整个文件只在 commit 时批量写一次。
- **读文件只读 1 行**: 分片清单整体存成一行 JSON, 清单, file_path, 节点都缓存在 isolate 内存, 热文件 D1 零读。
- **不用 Durable Object**: Bot 冷却放内存, TG 429 原样回给客户端按 Retry-After 重试, 下次自动换 Bot。
- **不写流水账**: 去掉审计日志, 分享计数, 令牌最后使用时间等每次操作都要写的行。
- **CPU 很低**: 下载由 FixedLengthStream 原生搬运, 上传不再 `arrayBuffer()`, 服务端不算哈希。
- **静态前端不进 Worker**: 由 Assets 直接返回, 不计 Workers 请求数。

> [!NOTE]
> 文中 D1 行数来自本地实测 (`wrangler dev` + 模拟 Telegram), CPU 时间来自线上实测。详见 [docs/QUOTA.md](docs/QUOTA.md)。

## 🧭 架构

<p align="center"><img src="docs/assets/architecture.svg" width="100%" alt="HX-CF-Drive 架构图"></p>

- 请求先匹配 Assets 静态文件 (`run_worker_first = false`), 只有 `/api` `/dav` `/f` `/s` 才进 Worker。
- Worker 用 Hono 挂载 REST, WebDAV, 签名直链和分享四组路由, 元数据读写走 D1, 文件内容走 Telegram Bot API。
- Bot 池 x 频道池: 写入按 blob id 哈希打散到所有可写频道; Bot 失效时用另一个 Bot 转发原消息拿新 file_id。
- 定时维护 (每 6 小时: Bot 探活, 回收站清理, 删除孤儿分片, 清扫放弃上传的消息) 默认由 GitHub Actions 调接口触发, 有积压时循环调用, 不占 Free 账户的 Cron 名额; keepalive.yml 每周重新启用定时工作流, 防止 60 天无活动被 GitHub 自动停用。

<details>
<summary><b>目录结构</b></summary>

```
src/
  index.ts                   入口, 路由挂载, 定时任务
  env.ts                     绑定与类型
  drivers/tg.ts              Telegram 驱动 (上传, 下载, Bot 池, 重新绑定)
  lib/                       鉴权, 目录树, Range, 签名, D1 计量, 工具函数
  routes/api.ts              REST API
  routes/dav.ts              WebDAV
  routes/public.ts           签名直链与分享
  routes/sharePage.ts        分享链接的浏览器页面
  services/upload.ts         无状态分片上传 (签名凭证 + 回执)
  services/serve.ts          读取与流式拼接
  services/maintenance.ts    定时维护
migrations/                  D1 表结构
web/                         前端 (React + TS + HX-UI), 构建到 dist/web 由 Assets 直接返回
  src/lib/transfer.ts        浏览器端 sha256 秒传, 断点续传, 大文件 Range 续拉
skills/hx-cf-drive/          给 AI Agent 的 Skill 与命令行脚本
scripts/quota.mjs            免费额度估算 (按实测单次行数)
scripts/meter.mjs            实测每个操作的 D1 行读写
scripts/mock-tg.mjs          本地模拟 Telegram
scripts/e2e.mjs              端到端冒烟测试
test/                        单元测试
docs/                        部署, 额度, 接入, Telegram 配置, 方案对比
```

</details>

## 📤 上传流程

<p align="center"><img src="docs/assets/upload-flow.svg" width="100%" alt="上传流程时序图"></p>

| 阶段 | 接口 | D1 | Telegram |
| --- | --- | --- | --- |
| init | `POST /api/v1/uploads` | 只读查重与解析路径, 新目录才写 | 0 |
| chunk | `PUT /api/v1/uploads/chunk` | **零读写** | 每片 1 次 `sendDocument` |
| fold (可选) | `POST /api/v1/uploads/fold` | **零读写**, 每 256 片验一次签名, 换一个聚合回执 | 0 |
| commit | `POST /api/v1/uploads/commit` | 一次批量写 (blob + node, 含索引约 6 行); 超过 256 片时每 256 片多 1 行 | 0 |
| 秒传 | `POST /api/v1/uploads` 命中 sha256 | 一次请求完成, 写约 4 行 (含索引) | 0 |

- 浏览器端先算 sha256, 命中已有 blob 时 1 次请求完成上传。秒传只认自己或管理员登记的哈希, 受限令牌秒传管理员的文件还要求它在自己根目录下。
- 每个分片返回一张签名回执, 客户端保存回执即可断点续传, 服务端不保存任何上传中的状态。网页端: 同一浏览器 24 小时内重新选择同一个文件 (同目录, 同名, 同大小, 同修改时间), 只补传缺的分片。
- 大文件 (多于 256 片, 约 4.75 GiB) 每凑满一组 256 片就 fold 成一个聚合回执, commit 时验签很快; 清单按 256 片一段存进 `blob_parts`, 读取时按 Range 只加载用到的段。单文件不再受 D1 单行 2 MB 的限制。
- 小文件也可以用 `POST /api/v1/upload` 一次性上传 (multipart 或 raw), 适合 PicGo 和 ShareX。

## 📥 下载流程

<p align="center"><img src="docs/assets/download-flow.svg" width="100%" alt="下载流程与子请求预算"></p>

- Free 计划单次调用最多 50 个外部子请求, 默认预算 `SUBREQ_BUDGET = 48`。冷分片 2 次 (getFile + 下载), 热分片 1 次。
- 单次响应冷拼最多 24 片 (约 456 MiB), 热拼最多 48 片, 超出部分返回 206, 网页端, 播放器, 下载器按 Range 续拉。
- file_path 在 isolate 内存里缓存 50 分钟 (Telegram 保证至少有效 1 小时), 热文件不再调用 getFile。
- Workers Paid 计划子请求上限 10,000, 调大 `SUBREQ_BUDGET` 即可一次拼更多片。
- 断点续传: 服务端支持 Range 和 If-Range, aria2, IDM, `curl -C -` 都能续。网页端 (Chrome / Edge, 大于 400 MB 时用 File System Access 写本地文件) 每段失败自动重试 (指数退避, 最多 8 次); 最终失败或关掉页面后, 再点同一个文件的下载会接着写, 文件内容变了就从头开始。其他浏览器交给浏览器自带下载。

## ⚖️ 与同类项目

| | [CloudFlare-ImgBed](https://github.com/MarSeventh/CloudFlare-ImgBed) | [Teldrive](https://github.com/tgdrive/teldrive) | HX-CF-Drive |
| --- | --- | --- | --- |
| 运行环境 | CF Pages / Workers | 自有服务器 + PostgreSQL | CF Workers + D1 |
| Telegram 接入 | Bot API, 20 MB 分片 | 真人账号 (MTProto) + Bot | Bot API, 19 MiB 分片 |
| 其他存储后端 | R2, S3, Discord 等 | 无 | 无, 只用 TG |
| Web 界面与生态 | 完整, 社区活跃 | 完整 | 简洁, 个人项目 |
| 侧重点 | 图床 + 文件管理, 功能全 | 网盘, rclone 集成 | 额度占用低, 无状态上传, Agent 接入 |

如果你需要成熟完整的图床与文件管理, CloudFlare-ImgBed 是更稳妥的选择。HX-CF-Drive 更适合想把额度压到最低, 或者要让 AI Agent 直接读写网盘的场景。完整对比见 [docs/COMPARISON.md](docs/COMPARISON.md)。

## 🚀 快速开始

### 部署到 Cloudflare (推荐)

<a href="docs/DEPLOY.md"><img src="docs/assets/deploy-flow.svg" width="100%" alt="GitHub Actions 一键部署流程"></a>

Fork 仓库, 建一个 Cloudflare API 令牌, 填好仓库 Secrets, 在 Actions 里点一次 Run workflow。D1 建库, 迁移, 测试, 部署, 写机密, 登记频道和冒烟全部自动完成。图文步骤见 **[部署指南](docs/DEPLOY.md)**。

### 本地开发

```bash
npm install
npm install --prefix web
cp .dev.vars.example .dev.vars
npm run db:migrate:local
node scripts/mock-tg.mjs 8887 &  # 模拟 Telegram, .dev.vars 里设 TG_API_BASE=http://127.0.0.1:8887
npm run dev                      # Worker, 8787
npm run dev:web                  # 前端热更新, 5173, 接口代理到 8787
npm test                         # 单元测试
node scripts/e2e.mjs             # 端到端冒烟
```

## 🖥️ 前端

`web/` 是 React + TypeScript 前端, UI 用 [HX-UI](https://github.com/HengXin666/HX-UI), 只用暗色主题, 侧栏可切换 5 套皮肤, 图标全部为 SVG (Iconify Solar)。

- 令牌登录, 目录浏览, 拖放上传 (sha256 秒传, 断点续传, 同名可覆盖或保留两者)。
- 图片, 视频, 音频, PDF, 文本预览, 大文件分段下载。
- 重命名, 移动, 删除, 回收站, 搜索, 分享与永久直链。
- 后台: 统计, 频道, Bot, 令牌, 手动维护, 以及内置接口文档页 (`/#/docs`)。

`npm run build:web` 构建到 `dist/web`, 部署时作为静态资源上传。HX-UI 2 只发 GitHub Release 的 tgz, 存一份在 `web/vendor/hx-ui-2.1.0.tgz` 引入 (离线也能装)。

## 🤖 接入与 Agent

| 方式 | 说明 |
| --- | --- |
| REST API | `/api/v1`, 支持受限令牌 (按权限和目录隔离), 全部接口带 curl 示例 |
| WebDAV | `/dav`, 可挂到 rclone, RaiDrive, Finder, Infuse, OpenList |
| 直链与分享 | `/f/:id` 签名永久直链, `/s/:id` 分享链接 |
| 图床工具 | PicGo, ShareX 走一次性上传接口 |
| Agent Skill | [`skills/hx-cf-drive/SKILL.md`](skills/hx-cf-drive/SKILL.md), 部署后也发布在 `/skill.md` |
| 命令行 | `skills/hx-cf-drive/scripts/hxd.mjs`, 无依赖, 自动分片, 秒传, 429 重试, Range 续拉 |
| LLM 索引 | `/llms.txt` |

让 Agent 接入只需一句话:

```text
读取 https://你的域名/skill.md, 按其中说明使用 HX-CF-Drive, BASE=..., TOKEN=<受限令牌>
```

## 📊 实测

2026-11-25 线上轻量实测 (Workers Free, 149 次计量请求)。CPU 和 D1 行数来自 Cloudflare GraphQL, 不是推算。

<p align="center"><img src="docs/assets/bench-ops.svg" width="100%" alt="每个接口的开销"></p>
<p align="center"><img src="docs/assets/bench-scale.svg" width="100%" alt="读写量与额度"></p>

- 每个请求 CPU 中位数 1 到 6 ms, D1 只在元数据操作时读写, R2 为 0。
- 下载先见底的是 Workers 请求数 (平均 20 MB 文件约 1.9 TB/天), 大量小文件上传先见底的是 D1 写入 (约 1.6 万个/天)。
- 单 Bot 单频道约 20 条/分就会被 TG 限流, 量大请加 Bot 和频道。

完整报告见 [docs/BENCHMARK.md](docs/BENCHMARK.md)。

## 📚 文档

| 文档 | 内容 |
| --- | --- |
| [docs/DEPLOY.md](docs/DEPLOY.md) | 图文部署指南: GitHub Actions 一键部署, 手动部署, 升级, 备份 |
| [docs/TELEGRAM.md](docs/TELEGRAM.md) | 存储小号, 私有频道, Bot 池配置与风控 |
| [docs/INTEGRATION.md](docs/INTEGRATION.md) | API, WebDAV, PicGo, ShareX, rclone 接入 |
| [docs/BENCHMARK.md](docs/BENCHMARK.md) | 线上实测报告: 每个接口的耗时, CPU, D1 行数, 额度外推 |
| [docs/QUOTA.md](docs/QUOTA.md) | 每个操作的请求量与 D1 行读写, 免费额度占用 |
| [docs/COMPARISON.md](docs/COMPARISON.md) | 与 CloudFlare-ImgBed, Teldrive 等方案对比 |

## 🛟 适用场景与风险

文件内容存在 Telegram, 不在你的控制之内: 存储账号或 Bot 被封, 频道被删, 文件就没了。D1 里的目录树是唯一不可再生的数据。

| 适合 | 不适合 |
| --- | --- |
| 图床, 公开分享的素材 | 唯一副本 |
| 备份的第二份 / 第三份副本 | 业务关键数据, 例如用户头像, 邮件正文, 附件原件 |
| 可以重新生成或重新下载的大文件 | 合规敏感数据 (个人信息, 医疗, 财务) |
| Agent 的临时文件, 中间产物 | 需要 SLA 的生产数据 |

如果要给别的服务当存储 (例如头像, 邮件正文), 主副本请放在 R2 / S3 / 数据库里, 这里只当缓存或备份。

备份建议:

- 定期导出目录树: `npx wrangler d1 export hx-cf-drive --remote --output=backup.sql`, 可以放进 GitHub Actions 定时跑。
- 重要文件另存一份到别处 (rclone 经 WebDAV 同步即可)。
- 多频道冗余写会让上传的 TG 调用和 manifest 翻倍, 目前不做。

## 📝 更新记录

**v0.4.0**

- 分片只凭票据直传: `PUT /api/v1/uploads/chunk` 不带 `Authorization` 时只凭上传票据 (HMAC 签名, 24 小时到期, 签发令牌被吊销即作废); `/api/v1/uploads` 返回公网分片地址 `chunkUrl`, 服务端申请上传后让手机或浏览器直接把字节传给 Drive (#16)
- 分享页: 浏览器打开 `/s/:id` 时返回页面, 有密码输入, 文件夹列表 (面包屑, 子目录), 下载按钮, 亮暗跟随系统; 页面不执行脚本, 不加载外部资源。curl, App, 播放器等非浏览器请求以及 `?download=1` / `?raw=1` 行为不变 (#16)
- 补上 10 GB 级 (540 片, 3 段) fold + commit 的测试, 文档写明超过 256 片必须按组 fold (#16)

**v0.3.1** (迁移 0004)

- 安全: 文件内容响应统一带 `Content-Security-Policy: sandbox` 与 `nosniff`, 上传的 html / svg 不再能在本站执行脚本读走 localStorage 里的令牌; 上传时的 Content-Type 只接受合法的 `type/subtype`
- 隔离: 分享列表与删除按令牌范围隔离 (以前任何令牌都能列出并删除全部分享, 分享 id 即公开凭证); 吊销令牌时删除它建的分享
- 隔离: 普通令牌签的直链带令牌 id (`t=`), 吊销令牌后最多 60 秒内失效; 管理员链接格式不变
- 秒传按上传者隔离 (`blobs.owner`): 只认自己或管理员登记的哈希。伪造哈希只能污染自己的空间, 受限令牌重传自己的文件也能秒传了 (v0.3 里完全不能)
- 受限令牌的回收站, 搜索在自己子树里查, 不再被全局 LIMIT 挤掉; 恢复时原目录不在就放回令牌根目录
- 彻底删除按 blob 年龄分批: 超过 47 小时的不再发注定失败的 `deleteMessages`, 维护结果新增 `tgExpired` / `tgFailed`, 能看到留在频道里的消息数
- 同一张上传凭证重复提交返回 409 (以前是 500)
- 新增只读接口 `GET /api/v1/fs/manifest?id=`: 返回每片的 Bot, TG file_id 与大小, 持有对应 Bot 令牌的客户端可以直接从 TG 并发拉取, 字节不经过 Worker (read 权限, 只限自己的子树)
- 分享密码连续错 10 次锁 15 分钟 (状态在 D1, 多 isolate 绕不过); 密码优先从 `X-Share-Password` 头读
- 新 scope `stats`: 只能读 `/admin/stats` (不含 Bot 报错与频道细节), 给别的服务看用量; stats 新增累计计数 `tg_expired` / `tg_failed`
- 下载时预取下一片, 片与片之间不再串行等一个 TG 往返 (同时最多 2 个 TG 连接, 子请求数不变)
- 新增 `scripts/e2e-security.mjs` (20 项)

**v0.3** (迁移 0002, 0003)

- 回收站可以立即彻底删除和清空; TG 删除改用 `deleteMessages` 批量删; 维护返回剩余量, 有积压时循环调用 (#6)
- 放弃的上传留下的消息按消息 id 水位清扫, 维护改为每 6 小时一次 (#7)
- 受限令牌只能秒传自己根目录里的文件, 上传的文件不登记哈希 (#8)
- 补充适用场景, 风险与备份建议 (#9)
- `PUBLIC_URL` 与 Service Binding 接入说明 (#10)
- 500 不再返回原始错误, 带 `X-Request-Id`; 不再接受 `?token=` (#11)
- 大文件分批提交 (fold) 与分段清单 `blob_parts` (#12)
- 网页大文件下载自动重试与断点续传 (#13)

## ⚠️ 已知限制

<details>
<summary>展开查看</summary>

- Telegram 单分片 ≤ 20 MB (getFile 上限), 因此固定 19 MiB 分片。
- Free 计划单次响应冷拼 24 片, 热拼 48 片, 超出部分 206 截断。不带 Range 的客户端 (如 curl 直接下大文件) 只能拿到第一段。
- Cache API 在 `*.workers.dev` 上不生效, 边缘缓存需要绑定自定义域名。
- 搜索用 `LIKE '%q%'`, 未命中时扫全表, 是 D1 读行的主要来源, 已按令牌限频 (`SEARCH_PER_MIN`, 默认 6/分)。
- WebDAV 的 LOCK 是假锁, 只为兼容 Windows 和 Finder。
- 同一分片被并发重传, 或上传了分片但没有提交时, 频道里会留下无引用消息, 由定时维护按消息 id 水位清扫 (`ORPHAN_SWEEP`, 默认开)。TG 只允许 Bot 删除 48 小时内的消息, 维护停掉超过 48 小时就清不掉了; 多个部署共用一个频道时必须设 `ORPHAN_SWEEP=0`。
- 回收站默认保留 `TRASH_DAYS` (7) 天, 也可以 `POST /api/v1/fs/purge` 立即彻底删除, 或 `POST /api/v1/fs/trash/empty` 清空。
- 秒传只认自己或管理员登记的哈希, 受限令牌秒传管理员的文件还要求文件在自己根目录下有引用。服务端不重算哈希, 哈希由上传者自己负责。
- TG 删除有 48 小时窗口, 回收站默认 7 天: 走回收站的文件, 字节基本都会留在频道里 (只删 D1 记录)。要真删, 删除后立即 `POST /api/v1/fs/purge`。
- 上传路径的 CPU 时间尚未在线上实测, 部署后用 `wrangler tail` 看 `cpuTime`。

</details>
