---
name: hx-cf-drive
description: 使用 HX-CF-Drive (Cloudflare Worker + Telegram 存储的网盘) 上传, 下载, 列目录, 搜索, 生成直链和分享。当用户要把文件存到 HX-CF-Drive, 从中取文件, 生成图床链接, 或接入它的 REST/WebDAV 接口时使用。
---

# HX-CF-Drive

一个跑在 Cloudflare Workers 上的网盘, 文件数据切片存在 Telegram 频道里, 目录树在 D1。对外提供 REST API, WebDAV 和签名直链。

## 需要的输入

- `BASE`: 服务地址, 例如 `https://drive.example.com` (无结尾斜杠)
- `TOKEN`: API 令牌 (`hxd_...`)。只向用户要**受限令牌**, 不要要管理员令牌。令牌可能只能访问某个子目录, 路径都相对它的根。

两者优先从环境变量 `HXD_BASE`, `HXD_TOKEN` 读; 没有就问用户。不要把令牌写进代码, 日志或提交。

## 首选: 用自带的命令行脚本

`scripts/hxd.mjs` 无依赖, Node 18+ 可用, 已处理分片, 秒传, 429 重试:

```bash
export HXD_BASE=https://drive.example.com HXD_TOKEN=hxd_...
node scripts/hxd.mjs ls /photos
node scripts/hxd.mjs put ./a.mp4 /video          # 任意大小, 自动分片 + sha256 秒传
node scripts/hxd.mjs get /video/a.mp4 ./a.mp4    # 自动按 Range 续拉
node scripts/hxd.mjs link /photos/a.png          # 永久直链, 可直接贴进 Markdown
node scripts/hxd.mjs mkdir /photos/2026
node scripts/hxd.mjs mv /a.png /photos [新名]
node scripts/hxd.mjs rm /old                     # 进回收站
node scripts/hxd.mjs search cat
node scripts/hxd.mjs share /a.zip [密码] [天数]
```

输出是 JSON, 方便解析。

## 直接调用 REST

认证: `Authorization: Bearer $TOKEN`。错误统一 `{"error":"..."}`。**429 和 503 必须读 `Retry-After` 秒数后重试**, 不要立刻重放。

| 操作 | 请求 |
| --- | --- |
| 当前令牌 | `GET /api/v1/me` → `{"scopes":["read","write"],"rootId":"..."}` (不查库; 先用它判断能做什么, 别靠 403 试探) |
| 列目录 | `GET /api/v1/fs/list?path=/a`; 大目录分页: `&limit=1~1000`, 响应带 `next`, 下一页加 `&after=<next>`, 没有 `next` 即结束 |
| 节点信息 | `GET /api/v1/fs/stat?path=/a/b.png` |
| 建目录 | `POST /api/v1/fs/mkdir {"path":"/a/b"}` |
| 移动/重命名 | `POST /api/v1/fs/move {"path":"/x","toPath":"/dir","name":"y","overwrite":false}` |
| 删除 | `POST /api/v1/fs/delete {"path":"/x"}` (进回收站, 可 restore) |
| 搜索 | `GET /api/v1/fs/search?q=kw` (扫整个令牌子树, 每令牌每分钟 6 次; 已知目录时优先 list 后本地过滤) |
| 直链 | `POST /api/v1/fs/link {"path":"/x","expiresIn":0}` → `{"url"}` |
| 批量直链 | `POST /api/v1/fs/links {"ids":[...],"expiresIn":0}` → `{"items":[{id,name,mime,url}],"missing":[]}` (≤ 200 个) |
| 分片清单 | `GET /api/v1/fs/manifest?id=<id>` → `{"size","chunkSize","chunks":[{"bot","fileId","size"}]}` |
| 读内容 | `GET /api/v1/files/<id>/content` (支持 Range); 带 `?v=<version>` 且等于当前版本时回 `immutable`, 可长期缓存 |
| 小文件上传 | `POST /api/v1/upload?path=/dir&rename=1` multipart 字段 `file` |
| 分享 | `POST /api/v1/shares {"path":"/x","password":"","expiresIn":604800}` |

节点 (Node) 字段: `id, name, kind ("dir"|"file"), size, mime, parentId, createdAt, updatedAt` (毫秒时间戳), `version` (文件内容版本, 即内容哈希 id; 覆盖上传后会变, 目录为 null)。

- 分页时顺序是名字的字节序 (不再目录在前); 不传 `limit` 时一次返回全部, 目录在前, 名字不分大小写排序。
- 缓存: 用 `version` 当缓存键; `ETag` 也是它, 回传 `If-None-Match` (可带 `W/` 前缀或多个值) 内容没变得 304。

### 大文件上传 (> 19 MiB 必须这样)

```
1. POST /api/v1/uploads {"path":"/dir","name":"a.mp4","size":N,"sha256":"<hex 可选>"}
   → {"done":true,"node"}            已秒传, 结束
   → {"done":false,"ticket","chunkSize","chunkCount"}
2. 对 i in 0..chunkCount-1:
   PUT /api/v1/uploads/chunk?i=<i>&ticket=<ticket>   body = 文件第 i 段 (每段恰好 chunkSize, 最后一段除外)
   → {"receipt"}                     保存回执; 并发不超过 2
   (可选, 多于 256 片时建议) 每凑满一组 256 片 (第 g 组 = 片 g*256 .. g*256+255, 最后一组可以不足):
   POST /api/v1/uploads/fold {"ticket","receipts":[这一组的全部回执]}  → {"fold"}   之后丢掉这组回执
3. POST /api/v1/uploads/commit {"ticket","receipts":[剩余的零散回执],"folds":[聚合回执]}  → {"node","url"}
```

ticket 24 小时有效, 服务端不存中间状态, 中断后用同一 ticket 补传缺的片再 commit 即可。
秒传只认本令牌或管理员登记的哈希; 受限令牌秒传管理员的文件还要求它已在自己根目录里。

### 大文件下载

单次响应最多拼约 456 MB, 超出会返回 206 截断。按 `Content-Range` 的结束位置继续发 `Range: bytes=<end+1>-`, 直到拿满 `size`。中断后从已写入的字节数接着发 Range 即可续传 (可带 `If-Range: <ETag>`, 内容变了会返回 200 整个文件)。

令牌只能放在 `Authorization: Bearer` 头里, 不支持 `?token=`。服务端内部错误只返回 `{"error":"internal error","requestId"}`。

## 注意

- 单个请求体上限 100 MB (CF 免费计划), WebDAV PUT 也受此限制。
- 删除目录只标记顶层, 立即对子项生效; 回收站保留约 7 天。
- 直链 `/f/...` 公开可访问且带 CORS, 生成前确认用户愿意公开该文件。
- 在线接口文档: `$BASE/#/docs`; 本文件也在 `$BASE/skill.md`。
