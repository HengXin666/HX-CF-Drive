# 部署教程

全程只用 Cloudflare 免费计划。需要 Node.js 18+ 和一个 Cloudflare 账号。

## 1. 安装与登录

```bash
npm install
npx wrangler login
```

## 2. 创建资源

```bash
# D1 数据库, 把输出的 database_id 填进 wrangler.toml
npx wrangler d1 create hx-cf-drive

# R2 存储桶 (第一次用 R2 需要先在后台开通, 免费额度不需要付费, 但要绑定支付方式)
npx wrangler r2 bucket create hx-cf-drive
```

编辑 `wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "hx-cf-drive"
database_id = "这里换成上一步输出的 id"
```

Durable Object 不需要手动创建, `wrangler deploy` 时按 `[[migrations]]` 自动建。免费计划只能用 SQLite 后端, 配置里已经是 `new_sqlite_classes`。

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
npm run deploy
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

`*.workers.dev` 上 Cache API 不生效, 小图每次都会回源 TG。

1. 域名托管到 Cloudflare。
2. Workers 后台, 选中 `hx-cf-drive`, 设置, 域和路由, 添加自定义域, 例如 `drive.example.com`。

## 8. R2 公开域名 (可选, 省 Worker 请求)

视频走 R2 时, 给桶开一个公开自定义域名, 视频直链就完全不经过 Worker:

1. R2 后台, 选中桶, 设置, 公开访问, 连接自定义域, 例如 `cdn.example.com`。
2. `wrangler.toml` 里设 `R2_PUBLIC_BASE = "https://cdn.example.com"`, 重新部署。

注意: 公开桶里的对象只靠随机 key 保护, 拿到链接的人都能访问, 且无法过期。私密视频不要开这个。

## 9. 常用配置

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `CHUNK_SIZE` | 16777216 | 分片字节数, TG 最大 19 MB |
| `MAX_CHUNKS_PER_RESPONSE` | 20 | 单次响应最多拼几片, Paid 计划可调到 200 |
| `CHANNEL_RATE_PER_MIN` | 15 | 每频道每分钟发送上限 |
| `ROUTE_VIDEO_TO` | r2 | 视频存哪, `r2` 或 `tg` |
| `ROUTE_R2_MIN_BYTES` | 209715200 | 大于此值的文件走 R2 |
| `TRASH_DAYS` | 7 | 回收站保留天数 |
| `R2_PUBLIC_BASE` | 空 | R2 公开域名 |

## 10. 验证与监控

```bash
# 端到端冒烟 (会往频道真实发消息, 建议先用测试频道)
BASE=$BASE ADMIN=$ADMIN CHANNEL=-100xxxx node scripts/e2e.mjs

# 实时日志, 关注 cpuTime 和 429
npx wrangler tail
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

TG 频道里的分片和 R2 对象都按 blob id 命名, 只要 D1 备份在, 数据就能找回。
