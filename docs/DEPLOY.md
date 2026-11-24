# 部署教程

全程只用 Cloudflare 免费计划, 只需要 Workers + D1, 不需要 R2 和 Durable Object, 不用绑定支付方式。需要 Node.js 18+ 和一个 Cloudflare 账号。

> 条款提示: Cloudflare 自助服务条款要求非企业用户通过付费服务 (含 Developer Platform) 分发视频和大文件, 否则 CDN 可能被限制。大量放视频建议上 Workers Paid ($5/月)。

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
