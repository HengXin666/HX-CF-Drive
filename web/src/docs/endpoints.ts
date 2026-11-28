// 接口清单: 前端文档页的数据源。改接口时同步改这里和 skills/hx-cf-drive/SKILL.md
export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export interface Endpoint {
  method: Method;
  path: string;
  scope: 'read' | 'write' | 'admin' | 'stats' | 'public';
  desc: string;
  body?: string;
  resp?: string;
  curl?: string; // 省略时按 method/path/body 生成
}
export interface Group { id: string; title: string; note?: string; items: Endpoint[] }

export const GROUPS: Group[] = [
  {
    id: 'fs', title: '文件与目录',
    note: '节点可用 id 或 path 定位, 路径相对令牌的根目录。',
    items: [
      { method: 'GET', path: '/api/v1/fs/list?path=/photos', scope: 'read', desc: '列目录 (全部子项, 目录在前)。可选分页: &limit=200 (1~1000) 按名字字节序返回一页并给出 next, 下一页带 &after=<next>, 每页只读 limit+1 行', resp: '{"node":{...},"path":"/photos","children":[Node],"next":"b.png"}' },
      { method: 'GET', path: '/api/v1/fs/stat?path=/a.png', scope: 'read', desc: '节点信息', resp: '{"node":Node}' },
      { method: 'POST', path: '/api/v1/fs/mkdir', scope: 'write', desc: '逐级创建目录', body: '{"path":"/photos/2026"}' },
      { method: 'POST', path: '/api/v1/fs/move', scope: 'write', desc: '移动或重命名', body: '{"path":"/a.png","toPath":"/photos","name":"b.png","overwrite":false}' },
      { method: 'POST', path: '/api/v1/fs/copy', scope: 'write', desc: '复制 (只复制元数据, 不重传数据)', body: '{"path":"/a.png","toPath":"/backup"}' },
      { method: 'POST', path: '/api/v1/fs/batch', scope: 'write', desc: '批量操作 (≤ 500 项): op = move / copy / delete / restore / rename。move/copy 用 toPath 或 toParentId 指定目标; rename 用 items。固定 3~5 条查询 + 一个 D1 batch (事务), 和项数无关; 校验不过的项 (不存在, 越权, 同名, 移进自身) 放进 failed, 其余照常执行', body: '{"op":"move","ids":["<id1>","<id2>"],"toPath":"/backup","overwrite":false}', resp: '{"ok":2,"failed":[{"id":"...","error":"target exists"}],"nodes":[Node]}' },
      { method: 'POST', path: '/api/v1/fs/delete', scope: 'write', desc: '移入回收站 (目录只标记顶层)', body: '{"path":"/old"}' },
      { method: 'GET', path: '/api/v1/fs/trash', scope: 'write', desc: '回收站列表 (受限令牌只看自己根下的)', resp: '{"items":[Node & {deletedAt}]}' },
      { method: 'POST', path: '/api/v1/fs/restore', scope: 'write', desc: '恢复 (同名时自动加后缀)', body: '{"id":"<nodeId>"}' },
      { method: 'POST', path: '/api/v1/fs/purge', scope: 'write', desc: '彻底删除一个回收站项目, 当场清理, 清不完的由维护接着做', body: '{"id":"<nodeId>"}', resp: '{"nodes":1,"blobs":1,"more":0,"leftNodes":0,"leftBlobs":0}' },
      { method: 'POST', path: '/api/v1/fs/trash/empty', scope: 'write', desc: '清空回收站 (受限令牌只清自己根下的)', resp: '{"nodes":3,"blobs":2,"more":0,"leftNodes":0,"leftBlobs":0}' },
      { method: 'GET', path: '/api/v1/fs/search?q=cat&type=image&dir=/photos&limit=50', scope: 'read', desc: '搜索: q 文件名模糊匹配, type 按类型 (image / video / audio / doc / archive / other, 先看 MIME 再看扩展名), 至少给一个; dir (或 dirId) 只搜该目录子树, 读行 ≈ 子树大小, 比全表便宜。每令牌每分钟限 6 次, 超出 429', resp: '{"items":[Node & {path}]}' },
      { method: 'POST', path: '/api/v1/fs/link', scope: 'read', desc: '签名直链, expiresIn 秒, 0 为永久', body: '{"path":"/a.png","expiresIn":0}', resp: '{"url":"https://.../f/<id>/a.png?e=0&s=..."}' },
      { method: 'POST', path: '/api/v1/fs/links', scope: 'read', desc: '批量签直链 (最多 200 个, 按请求顺序返回), 不是文件或无权访问的 id 放进 missing。2 次查询', body: '{"ids":["<id1>","<id2>"],"expiresIn":0}', resp: '{"items":[{"id":"...","name":"a.png","mime":"image/png","url":"..."}],"missing":[]}' },
      { method: 'GET', path: '/api/v1/files/<id>/content?v=<version>', scope: 'read', desc: '读取内容, 支持 Range 与 If-None-Match (弱 ETag / 多值); ?download=1 以附件下载。v 填节点的 version (列表里有), 仍是当前版本时响应带 immutable, 浏览器可长期缓存' },
    ],
  },
  {
    id: 'upload', title: '上传',
    note: '≤ 19 MiB 用一次性上传; 更大的走分片。分片接口无服务端状态, 客户端保存 ticket 和回执即可断点续传。带 sha256 可秒传。',
    items: [
      { method: 'POST', path: '/api/v1/upload?path=/picgo&rename=1', scope: 'write', desc: '一次性上传, multipart 字段 file (可多个), 或原始 body + ?name=', resp: '{"url":"...","node":Node} 或 {"files":[...]}',
        curl: 'curl -H "Authorization: Bearer $TOKEN" -F file=@a.png "$BASE/api/v1/upload?path=/picgo&rename=1"' },
      { method: 'POST', path: '/api/v1/uploads', scope: 'write', desc: '分片上传 1/3: 初始化', body: '{"path":"/video","name":"a.mp4","size":52428800,"sha256":"<hex>","overwrite":false}',
        resp: '{"done":false,"ticket":"...","chunkSize":19922944,"chunkCount":3} 或 {"done":true,"node":Node}' },
      { method: 'PUT', path: '/api/v1/uploads/chunk?i=0&ticket=<ticket>', scope: 'write', desc: '分片上传 2/3: 第 i 片的原始字节, 可并发, 429/503 按 Retry-After 重试', resp: '{"receipt":"..."}',
        curl: 'curl -X PUT -H "Authorization: Bearer $TOKEN" --data-binary @part0 "$BASE/api/v1/uploads/chunk?i=0&ticket=$TICKET"' },
      { method: 'POST', path: '/api/v1/uploads/commit', scope: 'write', desc: '分片上传 3/3: 提交全部回执, 缺片返回 400 并列出序号', body: '{"ticket":"...","receipts":["...","...","..."]}', resp: '{"node":Node,"url":"..."}' },
    ],
  },
  {
    id: 'share', title: '分享',
    items: [
      { method: 'POST', path: '/api/v1/shares', scope: 'read', desc: '创建分享, 密码, 有效期, 备注可选', body: '{"path":"/a.zip","password":"1234","expiresIn":604800,"remark":"给小明"}', resp: '{"id":"...","url":"https://.../s/<id>"}' },
      { method: 'GET', path: '/api/v1/shares', scope: 'read', desc: '分享列表 (含 has_password, expires_at, disabled, remark)' },
      { method: 'PATCH', path: '/api/v1/shares/<id>', scope: 'write', desc: '编辑分享, 只改传了的字段: password (null 去掉), expiresIn (秒, 从现在起; null 为永久), disabled (停用后访问返回 410), remark。改密码后旧的密码 Cookie 失效', body: '{"disabled":false,"password":"new","expiresIn":259200,"remark":"给同事"}', resp: '{"share":{...}}' },
      { method: 'DELETE', path: '/api/v1/shares/<id>', scope: 'write', desc: '撤销分享' },
    ],
  },
  {
    id: 'mcp', title: 'MCP (AI Agent)',
    note: 'Model Context Protocol 端点, Streamable HTTP 的无状态子集 (直接返回 JSON, 不开 SSE)。鉴权同 REST; 工具: list, stat, search, upload (≤ 10 MB), link, share, 进程内转给对应接口, scope 和额度不变。客户端配置见 docs/INTEGRATION.md 2.1 节。',
    items: [
      { method: 'POST', path: '/api/v1/mcp', scope: 'read', desc: 'JSON-RPC 2.0: initialize, tools/list, tools/call, ping; 通知回 202。工具需要的 scope 按对应接口 (upload 要 write)', body: '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"upload","arguments":{"dir":"/agent","name":"a.md","text":"# hi"}}}', resp: '{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"..."}],"structuredContent":{...}}}' },
    ],
  },
  {
    id: 'public', title: '公开访问',
    note: '不需要令牌。/f 已开 CORS, 可直接嵌入 img 或 video。',
    items: [
      { method: 'GET', path: '/f/<id>/<name>?e=0&s=<sig>', scope: 'public', desc: '签名直链, 支持 Range' },
      { method: 'GET', path: '/s/<id>?p=<password>&path=<sub>', scope: 'public', desc: '分享下载, 目录分享用 path 取子文件' },
    ],
  },
  {
    id: 'admin', title: '管理',
    items: [
      { method: 'GET', path: '/api/v1/admin/stats', scope: 'stats', desc: '用量, Bot 与频道状态, 累计计数 (stats scope 只读这一项, 不含 Bot 报错)。节点数与字节数是维护任务每 6 小时写的快照, snapshotAt 为统计时间', resp: '{"nodes":[{"kind":"file","n":120}],"blobs":{"n":98,"bytes":123456},"snapshotAt":1764300000000,"bots":[...],"channels":[...],"counters":{}}' },
      { method: 'GET', path: '/api/v1/me', scope: 'read', desc: '当前令牌的权限与根目录 (任何有效令牌都能调, 前端据此决定是否请求管理接口)', resp: '{"scopes":["read","write"],"rootId":"root"}' },
      { method: 'POST', path: '/api/v1/admin/channels', scope: 'admin', desc: '添加存储频道, 返回每个 Bot 是否为管理员', body: '{"id":"-1001234567890"}' },
      { method: 'PATCH', path: '/api/v1/admin/channels/<id>', scope: 'admin', desc: '频道设为只读或恢复', body: '{"status":"readonly"}' },
      { method: 'POST', path: '/api/v1/admin/bots', scope: 'admin', desc: '添加 Bot', body: '{"token":"123456:ABC..."}' },
      { method: 'DELETE', path: '/api/v1/admin/bots/<id>', scope: 'admin', desc: '停用 Bot, ?force=1 彻底删除' },
      { method: 'POST', path: '/api/v1/admin/tokens', scope: 'admin', desc: '签发 API 令牌, 明文只返回一次', body: '{"name":"picgo","scopes":["read","write"],"rootPath":"/picgo","expiresIn":31536000}', resp: '{"token":"hxd_..."}' },
      { method: 'GET', path: '/api/v1/admin/tokens', scope: 'admin', desc: '令牌列表' },
      { method: 'DELETE', path: '/api/v1/admin/tokens/<id>', scope: 'admin', desc: '吊销令牌' },
      { method: 'GET', path: '/api/v1/admin/topology?usage=0&check=0&fresh=0', scope: 'admin', desc: 'Bot 与频道拓扑。分片统计 (每对存了多少分片) 要扫全部清单, 只在 usage=1 时给出 (缓存 10 分钟, fresh=1 重算); 不带时 usage 为 null (本 isolate 恰有未过期的统计时顺带返回); check=1 时逐对检查管理员权限 (每对 1 次 TG 调用, 受 SUBREQ_BUDGET 限制)', resp: '{"bots":[...],"channels":[...],"usage":[{"c":"-100...","b":"7123...","n":251,"bytes":4831838208}],"perms":{"7123...|-100...":"ok"}}' },
      { method: 'POST', path: '/api/v1/admin/maintenance', scope: 'admin', desc: '立即执行清理 (回收站过期, 孤儿数据)' },
    ],
  },
];

export function curlOf(e: Endpoint, base: string): string {
  const c = e.curl ?? [
    'curl',
    e.method === 'GET' ? '' : `-X ${e.method}`,
    e.scope === 'public' ? '' : '-H "Authorization: Bearer $TOKEN"',
    e.body ? `-H "Content-Type: application/json" -d '${e.body}'` : '',
    `"$BASE${e.path}"`,
  ].filter(Boolean).join(' ');
  return c.replaceAll('$BASE', base);
}
