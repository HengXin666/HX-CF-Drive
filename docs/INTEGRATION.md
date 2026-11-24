# 外部接入

下文 `$BASE` 为服务地址, `$TOKEN` 为 API 令牌。

## 1. 令牌

管理员令牌拥有全部权限, 不要发给第三方工具。给每个工具单独发一个受限令牌:

```bash
curl -X POST -H "Authorization: Bearer $ADMIN" -H "Content-Type: application/json" \
  -d '{"name":"picgo","scopes":["read","write"],"rootPath":"/picgo","expiresIn":31536000}' \
  $BASE/api/v1/admin/tokens
# 返回 {"token":"hxd_...", ...}, 只显示这一次
```

- `scopes`: `read`, `write`, `admin` 的组合。
- `rootPath`: 令牌只能看到这个目录及其子目录, 路径都相对它。
- 传递方式: `Authorization: Bearer <token>`, WebDAV 用 Basic (用户名随意, 密码填令牌)。不支持 `?token=` (会进浏览器历史, 代理日志和 Referer); 需要免令牌访问时用签名直链 `/f/` 或分享链接 `/s/`。

## 2. REST API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/v1/fs/list?path=/a` 或 `?id=` | 列目录 |
| GET | `/api/v1/fs/stat?path=` | 节点信息 |
| POST | `/api/v1/fs/mkdir` `{path}` | 逐级创建 |
| POST | `/api/v1/fs/move` `{id或path, toParentId或toPath, name, overwrite}` | 移动或重命名 |
| POST | `/api/v1/fs/copy` `{id或path, toParentId或toPath, name}` | 复制 (只复制元数据) |
| POST | `/api/v1/fs/delete` `{id或path}` | 移入回收站 |
| GET | `/api/v1/fs/trash` | 回收站 |
| POST | `/api/v1/fs/restore` `{id}` | 恢复 |
| POST | `/api/v1/fs/purge` `{id}` | 彻底删除 (返回 `more=1` 表示有积压, 由维护接着清) |
| POST | `/api/v1/fs/trash/empty` | 清空回收站 (受限令牌只清自己根下的) |
| GET | `/api/v1/fs/search?q=&limit=` | 文件名搜索 |
| POST | `/api/v1/fs/link` `{id, expiresIn}` | 签名直链, expiresIn 秒, 0 为永久 |
| GET | `/api/v1/files/:id/content` | 读取内容, 支持 Range, `?download=1` |
| POST | `/api/v1/upload?path=&rename=1` | 一次性上传 (multipart 字段 file, 或原始 body + `?name=`) |
| POST | `/api/v1/uploads` | 分片上传: 初始化, 返回签名凭证 ticket |
| PUT | `/api/v1/uploads/chunk?i=&ticket=` | 分片上传: 传第 i 片, 返回签名回执 receipt |
| POST | `/api/v1/uploads/fold` `{ticket, receipts}` | 分片上传 (可选): 一组 256 片的回执换一个聚合回执 fold |
| POST | `/api/v1/uploads/commit` `{ticket, receipts, folds}` | 分片上传: 提交回执和聚合回执 |
| POST/GET/DELETE | `/api/v1/shares` | 分享链接 |
| GET | `/f/:id/:name?e=&s=` | 签名直链 (公开) |
| GET | `/s/:id?p=密码&path=子路径` | 分享 (公开) |
| * | `/api/v1/admin/*` | 管理: stats, bots, channels, tokens, maintenance |

错误统一返回 `{"error": "..."}`; 服务端内部错误只返回 `{"error":"internal error","requestId":"..."}`。429 和 503 带 `Retry-After` 头, 客户端按它等待后重试。

### 分片上传流程

服务端不保存上传中间状态: 初始化返回一个 HMAC 签名的凭证, 每片返回一个签名回执, 最后把回执全部交回来。续传只要客户端留着回执 (网页端存在 localStorage, 见 `web/src/lib/transfer.ts`)。凭证 24 小时有效。

```bash
# 1. 初始化。带 sha256 (客户端自己算) 可以秒传
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"path":"/video","name":"a.mp4","size":52428800,"sha256":"..."}' $BASE/api/v1/uploads
# => {"done":false,"ticket":"...","chunkSize":19922944,"chunkCount":3}
# 或 {"done":true,"node":{...}} 表示秒传成功

# 2. 逐片上传, 每片恰好 chunkSize 字节 (最后一片除外)。可并发, 429 时按 Retry-After 重试
curl -X PUT -H "Authorization: Bearer $TOKEN" --data-binary @part0 "$BASE/api/v1/uploads/chunk?i=0&ticket=$TICKET"
# => {"receipt":"..."}

# 3. 提交。缺片时返回 400 并列出缺的序号
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"ticket\":\"$TICKET\",\"receipts\":[\"...\",\"...\",\"...\"]}" $BASE/api/v1/uploads/commit
```

秒传规则: 管理员和根目录为 `/` 的令牌, 库里有同 sha256 同大小的文件就秒传; 受限令牌只有当这个文件已经在它自己的根目录里时才秒传, 否则照常上传 (它上传的文件也不登记哈希, 防止投毒)。

#### 断点续传

- 凭证 24 小时有效。中断后用同一个 ticket 补传缺的分片 (已有回执的不用重传), 再 commit。
- 回执只是签名字符串, 可以存在任何地方 (文件, 数据库)。网页端存在 localStorage, 键是目录 + 文件名 + 大小 + 修改时间。

#### 分批提交 (fold)

分片很多时 (例如 100 GB 约 5390 片), 一次 commit 验几千个签名可能超出 Free 计划的 CPU 时间。多于 256 片时建议:

1. 分片按 256 对齐分组: 第 g 组是第 `g*256` 到 `g*256+255` 片, 最后一组可以不足 256。
2. 一组的回执凑齐后, `POST /api/v1/uploads/fold {ticket, receipts: [这一组的全部回执]}`, 返回 `{"fold":"..."}`, 之后这组的回执可以丢掉。
3. commit 时 `{ticket, folds: [...], receipts: [没折叠的零散回执]}`。两者可以混用, 同一组给了聚合回执就忽略它的零散回执。

限制: 一次 fold 只接受一个完整的组, 跨组或缺片返回 400; 聚合回执和凭证一样 24 小时内有效。256 片以内的文件不需要 fold。

### 下载与续传

- `GET /api/v1/files/:id/content` 和签名直链都支持 `Range`; 带 `If-Range: <ETag>` 时内容变了会返回 200 整个文件。
- Free 计划单次响应最多拼约 456 MB, 超出返回 206。按 `Content-Range` 的结束位置继续发 `Range: bytes=<end+1>-` 直到拿满。
- aria2, IDM, `curl -C - -o a.bin "<直链>"` 都能断点续传 (curl 每次只拿到一段, 需要循环到文件大小为止)。

可选参数: `overwrite` 覆盖同名文件, `mkdirs: false` 禁止自动建目录。单个请求体不能超过 100 MB (CF 免费计划), 所以超过 19 MiB 的文件必须走分片接口。

## 3. WebDAV

地址 `$BASE/dav/`, 用户名随意, 密码填令牌。

### rclone

```bash
rclone config create hxd webdav url=$BASE/dav vendor=other user=me pass=$(rclone obscure $TOKEN)
rclone ls hxd:
rclone copy ./photos hxd:/photos --transfers 2
```

单个文件 ≤ 100 MB 时 WebDAV 上传最方便 (Worker 请求体上限 100 MB)。更大的文件请用分片 API 或 Web 界面。

### 其他客户端

- Windows: RaiDrive 选 WebDAV, 或资源管理器 "映射网络驱动器" (需要 HTTPS)。
- macOS Finder: 前往, 连接服务器, 填 `https://drive.example.com/dav/`。
- Infuse, nPlayer, Kodi: 添加 WebDAV 源, 视频可直接拖动播放。
- OpenList / AList: 添加 WebDAV 存储, 地址同上, 可把 HX-CF-Drive 和其他网盘挂在一起。

## 4. PicGo

安装插件 `web-uploader` (自定义 Web 图床), 配置:

| 字段 | 值 |
| --- | --- |
| API 地址 | `https://drive.example.com/api/v1/upload?path=/picgo&rename=1` |
| POST 参数名 | `file` |
| JSON 路径 | `url` |
| 自定义请求头 | `{"Authorization":"Bearer hxd_..."}` |

## 5. ShareX

新建自定义上传器, 导入以下 JSON (改地址和令牌):

```json
{
  "Version": "16.0.0",
  "Name": "HX-CF-Drive",
  "DestinationType": "ImageUploader, FileUploader",
  "RequestMethod": "POST",
  "RequestURL": "https://drive.example.com/api/v1/upload",
  "Parameters": { "path": "/sharex", "rename": "1" },
  "Headers": { "Authorization": "Bearer hxd_..." },
  "Body": "MultipartFormData",
  "FileFormName": "file",
  "URL": "{json:url}"
}
```

## 6. 在代码里调用

```js
// 浏览器或 Node 18+
const BASE = 'https://drive.example.com', TOKEN = 'hxd_...';
const H = { Authorization: `Bearer ${TOKEN}` };

async function upload(file, path = '/') {
  const post = (u, b) => fetch(BASE + u, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
  const init = await post('/api/v1/uploads', { path, name: file.name, size: file.size, mime: file.type });
  if (init.done) return init.node;
  const receipts = [];
  for (let i = 0; i < init.chunkCount; i++) {
    const body = file.slice(i * init.chunkSize, (i + 1) * init.chunkSize);
    for (;;) {
      const r = await fetch(`${BASE}/api/v1/uploads/chunk?i=${i}&ticket=${encodeURIComponent(init.ticket)}`, { method: 'PUT', headers: H, body });
      if (r.ok) { receipts.push((await r.json()).receipt); break; }
      if (r.status !== 429 && r.status !== 503) throw new Error(await r.text());
      await new Promise((s) => setTimeout(s, Number(r.headers.get('Retry-After') ?? 5) * 1000));
    }
  }
  return (await post('/api/v1/uploads/commit', { ticket: init.ticket, receipts })).node;
}
```

## 7. 嵌入网页

```html
<img src="https://drive.example.com/f/<id>/a.png?e=0&s=...">
<video controls src="https://drive.example.com/f/<id>/v.mp4?e=0&s=..."></video>
```

`/f/*` 已开启 CORS, 可以跨域加载。

大文件 (冷读超过约 456 MB) 单次响应会被 206 截断, 浏览器直接点链接下载会只拿到第一段。网页端会自动按 Content-Range 续拉 (`web/src/lib/transfer.ts` 的 `download`), 或用支持断点续传的下载器 (aria2, IDM)。播放器本身就按 Range 请求, 不受影响。

## 8. 从其他 Worker 或服务端调用

### Service Binding (推荐)

同一账户下的其他 Worker 不要走公网域名: 账户的 Bot 防护可能对非浏览器 UA 弹托管质询, 而且每次调用都算一次公网请求。用 Service Binding 直接调用, 不经过公网, 不过质询:

```toml
# 调用方的 wrangler.toml
[[services]]
binding = "DRIVE"
service = "hx-cf-drive"
```

```ts
// 主机名随便写, 路由只看路径
const r = await env.DRIVE.fetch('https://drive/api/v1/fs/list?path=/', {
  headers: { Authorization: `Bearer ${env.DRIVE_TOKEN}` },
});
```

返回的直链和分享链接用 `PUBLIC_URL` (在 `wrangler.toml` 的 `[vars]` 或部署变量里设置) 拼出, 没设时用请求的 origin。经 Service Binding 调用时请务必设置 `PUBLIC_URL`, 否则链接会是 `https://drive/...` 这样的内部地址。

### 外部 HTTP 调用

从 VPS, CI 等外部服务器调用时, 请带一个自定义 User-Agent (例如 `curl -A hxd/1`, 或代码里设置 `User-Agent: my-service/1`)。curl, node 等默认 UA 可能被 Cloudflare 的托管质询拦下, 返回一个 HTML 页面而不是 JSON。不需要也不建议为此修改账户或区域的安全设置。

### 错误响应

服务端内部错误只返回 `{"error":"internal error","requestId":"..."}`, 响应头带 `X-Request-Id`; 详细原因在 `wrangler tail` 的日志里按这个 id 查。请求体不是合法 JSON 时返回 400。
