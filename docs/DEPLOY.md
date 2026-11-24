# 部署教程

全程只用 Cloudflare 免费计划, 只需要 Workers + D1, 不需要 R2 和 Durable Object, 不用绑定支付方式。需要 Node.js 18+ 和一个 Cloudflare 账号。

> 条款提示: Cloudflare 自助服务条款要求非企业用户通过付费服务 (含 Developer Platform) 分发视频和大文件, 否则 CDN 可能被限制。大量放视频建议上 Workers Paid ($5/月)。

## 用 GitHub Actions 部署 (推荐)

工作流在 `.github/workflows/deploy.yml`: 自动建 D1 (已存在则复用) 和建表, 跑类型检查与单测, 构建前端, 部署 Worker, 写入机密, 最后冒烟。仓库里的 `database_id` 不用填, CI 会自己查出来写进去。

### 1. Cloudflare 侧 (只做一次)

1. 记下账户 ID: 控制台首页右侧 "Account ID"。
2. 建 API 令牌: 我的个人资料, API 令牌, 创建令牌, 选模板 "编辑 Cloudflare Workers", 再加一行权限 `账户 / D1 / 编辑`, 账户资源只选自己的账户。

### 2. GitHub 仓库 Settings, Secrets and variables, Actions

| 类型 | 名称 | 必填 | 值 |
| --- | --- | --- | --- |
| Secret | `CLOUDFLARE_API_TOKEN` | 是 | 上一步的 API 令牌 |
| Secret | `CLOUDFLARE_ACCOUNT_ID` | 是 | 账户 ID |
| Secret | `ADMIN_TOKEN` | 是 | 管理员令牌, `openssl rand -base64 32` 生成 |
| Secret | `SIGNING_KEY` | 是 | 直链签名密钥, 同上生成; 改了旧直链全部失效 |
| Secret | `BOT_TOKENS` | 否 | 逗号分隔的 Bot Token, 也可部署后在后台添加 |
| Secret | `TG_CHANNEL_ID` | 否 | 存储频道 id (`-100...`), 手动运行勾选 "登记频道" 时用 |
| Variable | `DEPLOY_ENABLED` | 否 | 设为 `true` 后 push 到 main 自动部署; 不设只能手动触发 |
| Variable | `D1_NAME` | 否 | D1 库名, 默认 `hx-cf-drive` |
| Variable | `CUSTOM_DOMAIN` | 否 | 绑定的自定义域名, 如 `drive.example.com`, 需托管在同一 CF 账户 |
| Variable | `PUBLIC_URL` | 否 | 绑了自定义域名时填, 冒烟和初始化走这个地址 |

也可以用 gh 命令行设置:

```bash
gh secret set CLOUDFLARE_API_TOKEN
gh secret set CLOUDFLARE_ACCOUNT_ID
openssl rand -base64 32 | gh secret set ADMIN_TOKEN
openssl rand -base64 32 | gh secret set SIGNING_KEY
gh secret set BOT_TOKENS
gh secret set TG_CHANNEL_ID
gh variable set DEPLOY_ENABLED --body true
```

### 3. 首次部署

Actions, Deploy, Run workflow, 勾选 "部署后把 TG_CHANNEL_ID 登记为存储频道"。日志最后会列出每个 Bot 在频道里的状态, 都是 `ok` 即完成。之后 push 到 main 自动部署 (只改文档不会触发)。

部署地址在运行摘要里, 形如 `https://hx-cf-drive.<子域>.workers.dev`。

下面是手动部署的步骤, 用了工作流可以跳过。

## 1. 安装与登录

```bash
npm install
npm install --prefix web
npx wrangler login
```

## 2. 创建资源

```bash
# D1 数据库, 把输出的 database_id 填进 wrangler.toml
npx wrangler d1 create hx-cf-drive
```

编辑 `wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "hx-cf-drive"
database_id = "这里换成上一步输出的 id"
```

## 3. 建表

```bash
npm run db:migrate # 远程
npm run db:migrate:local # 本地开发
```

## 4. 设置机密

```bash
# 管理员令牌, 用随机长字符串
openssl rand -base64 32 | npx wrangler secret put ADMIN_TOKEN
# 直链签名密钥, 改了之后所有旧直链失效
openssl rand -base64 32 | npx wrangler secret put SIGNING_KEY
# Bot 令牌, 逗号分隔 (也可以部署后用 API 添加)
npx wrangler secret put BOT_TOKENS
```

Telegram 侧的准备见 [TELEGRAM.md](TELEGRAM.md)。

## 5. 部署

```bash
npm run deploy # 先构建前端到 dist/web, 再 wrangler deploy
```

输出里的 `https://hx-cf-drive.<你的子域>.workers.dev` 就是服务地址。

## 6. 初始化 Telegram 频道

```bash
BASE=https://hx-cf-drive.xxx.workers.dev
ADMIN=你的管理员令牌

# 把 BOT_TOKENS 写进数据库并探活
curl -X POST -H "Authorization: Bearer $ADMIN" $BASE/api/v1/admin/maintenance

# 添加频道, 返回里会检查每个 Bot 是否为管理员
curl -X POST -H "Authorization: Bearer $ADMIN" -H "Content-Type: application/json" \
  -d '{"id":"-1001234567890"}' $BASE/api/v1/admin/channels

# 查看状态
curl -H "Authorization: Bearer $ADMIN" $BASE/api/v1/admin/stats
```

`channels` 里每个 Bot 都显示 `ok` 才算配置完成。

## 7. 绑定自定义域名 (强烈建议)

`*.workers.dev` 上 Cache API 不生效。只有设 `EDGE_CACHE=1` 时才用得上 (永久直链小文件写边缘缓存)。默认关闭, 靠 isolate 内存缓存 file_path 和清单。

1. 域名托管到 Cloudflare。
2. Workers 后台, 选中 `hx-cf-drive`, 设置, 域和路由, 添加自定义域, 例如 `drive.example.com`。

## 9. 常用配置

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `CHUNK_SIZE` | 19922944 | 分片字节数, 超过 19 MiB 会被压回 19 MiB |
| `SUBREQ_BUDGET` | 48 | 单次响应可用的外部子请求数。Free 上限 50, Paid 默认 10,000 |
| `SEARCH_PER_MIN` | 6 | 每个令牌每分钟模糊搜索次数 |
| `TRASH_DAYS` | 7 | 回收站保留天数 |
| `EDGE_CACHE` | 0 | 1 = 永久直链小文件写入边缘缓存, 仅自定义域名有效 |
| `D1_METER` | 空 | 1 = 响应头 `X-D1-Rows` 带本请求的 D1 查询数和行读写, 只在排查时开 |

## 10. 验证与监控

```bash
# 端到端冒烟 (会往频道真实发消息, 建议先用测试频道)
BASE=$BASE ADMIN=$ADMIN CHANNEL=-100xxxx node scripts/e2e.mjs

# 实时日志, 关注 cpuTime 和 429
npx wrangler tail

# 实测每个操作的 D1 行读写 (需 D1_METER=1, 会建测试目录)
BASE=$BASE ADMIN=$ADMIN node scripts/meter.mjs 200
```

## 11. 升级与回滚

```bash
git pull && npm install
npm run db:migrate # 有新迁移时
npm run deploy
npx wrangler rollback # 回滚到上一个版本
```

## 12. 备份

```bash
# 导出 D1 (目录树是唯一不可再生的数据, 务必定期备份)
npx wrangler d1 export hx-cf-drive --remote --output backup-$(date +%F).sql
```

TG 频道里的分片按 blob id 命名, 分片清单在 D1 的 blobs.manifest 里, 只要 D1 备份在, 数据就能找回。
