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
- 传递方式: `Authorization: Bearer <token>`, WebDAV 用 Basic (用户名随意, 密码填令牌), 也可以 `?token=`。

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
| GET | `/api/v1/fs/search?q=&limit=` | 文件名搜索 |
| POST | `/api/v1/fs/link` `{id, expiresIn}` | 签名直链, expiresIn 秒, 0 为永久 |
| GET | `/api/v1/files/:id/content` | 读取内容, 支持 Range, `?download=1` |
| POST | `/api/v1/upload?path=&rename=1` | 一次性上传 (multipart 字段 file, 或原始 body + `?name=`) |
| POST | `/api/v1/uploads` | 分片上传: 初始化 |
| PUT | `/api/v1/uploads/:id/:idx` | 分片上传: 传第 idx 片 |
| GET | `/api/v1/uploads/:id` | 分片上传: 查已收分片 (续传) |
| POST | `/api/v1/uploads/:id/complete` | 分片上传: 完成 |
| DELETE | `/api/v1/uploads/:id` | 分片上传: 取消 |
| POST/GET/DELETE | `/api/v1/shares` | 分享链接 |
| GET | `/f/:id/:name?e=&s=` | 签名直链 (公开) |
| GET | `/s/:id?p=密码&path=子路径` | 分享 (公开) |
| * | `/api/v1/admin/*` | 管理: stats, bots, channels, tokens, maintenance, audit |

错误统一返回 `{"error": "..."}`。429 和 503 带 `Retry-After` 头, 客户端按它等待后重试。

### 分片上传流程

```bash
# 1. 初始化。带 sha256 可以秒传
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"path":"/video","name":"a.mp4","size":52428800,"sha256":"..."}' $BASE/api/v1/uploads
# => {"done":false,"uploadId":"...","driver":"r2","chunkSize":16777216,"chunkCount":4}
# 或 {"done":true,"node":{...},"url":"..."} 表示秒传成功

# 2. 逐片上传, 每片恰好 chunkSize 字节 (最后一片除外)。可并发, 可重传
curl -X PUT -H "Authorization: Bearer $TOKEN" --data-binary @part0 $BASE/api/v1/uploads/$UP/0

# 3. 完成
curl -X POST -H "Authorization: Bearer $TOKEN" $BASE/api/v1/uploads/$UP/complete
```

可选参数: `backend` 指定 `r2` 或 `tg`, `overwrite` 覆盖同名文件, `mkdirs: false` 禁止自动建目录。

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
  const init = await fetch(`${BASE}/api/v1/uploads`, {
    method: 'POST', headers: { ...H, 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, name: file.name, size: file.size, mime: file.type }),
  }).then((r) => r.json());
  if (init.done) return init.url;
  for (let i = 0; i < init.chunkCount; i++) {
    const body = file.slice(i * init.chunkSize, (i + 1) * init.chunkSize);
    for (;;) {
      const r = await fetch(`${BASE}/api/v1/uploads/${init.uploadId}/${i}`, { method: 'PUT', headers: H, body });
      if (r.ok) break;
      if (r.status !== 429 && r.status !== 503) throw new Error(await r.text());
      await new Promise((s) => setTimeout(s, Number(r.headers.get('Retry-After') ?? 5) * 1000));
    }
  }
  const done = await fetch(`${BASE}/api/v1/uploads/${init.uploadId}/complete`, { method: 'POST', headers: H }).then((r) => r.json());
  return done.url;
}
```

## 7. 嵌入网页

```html
<img src="https://drive.example.com/f/<id>/a.png?e=0&s=...">
<video controls src="https://drive.example.com/f/<id>/v.mp4?e=0&s=..."></video>
```

`/f/*` 已开启 CORS, 可以跨域加载。
