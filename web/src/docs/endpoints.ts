// 接口清单: 前端文档页的数据源。改接口时同步改这里和 skills/hx-cf-drive/SKILL.md
export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export interface Endpoint {
  method: Method;
  path: string;
  scope: 'read' | 'write' | 'admin' | 'public';
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
      { method: 'GET', path: '/api/v1/fs/list?path=/photos', scope: 'read', desc: '列目录', resp: '{"node":{...},"path":"/photos","children":[Node]}' },
      { method: 'GET', path: '/api/v1/fs/stat?path=/a.png', scope: 'read', desc: '节点信息', resp: '{"node":Node}' },
      { method: 'POST', path: '/api/v1/fs/mkdir', scope: 'write', desc: '逐级创建目录', body: '{"path":"/photos/2026"}' },
      { method: 'POST', path: '/api/v1/fs/move', scope: 'write', desc: '移动或重命名', body: '{"path":"/a.png","toPath":"/photos","name":"b.png","overwrite":false}' },
      { method: 'POST', path: '/api/v1/fs/copy', scope: 'write', desc: '复制 (只复制元数据, 不重传数据)', body: '{"path":"/a.png","toPath":"/backup"}' },
      { method: 'POST', path: '/api/v1/fs/delete', scope: 'write', desc: '移入回收站 (目录只标记顶层)', body: '{"path":"/old"}' },
      { method: 'GET', path: '/api/v1/fs/trash', scope: 'read', desc: '回收站列表', resp: '{"items":[Node & {deletedAt}]}' },
      { method: 'POST', path: '/api/v1/fs/restore', scope: 'write', desc: '恢复 (同名时自动加后缀)', body: '{"id":"<nodeId>"}' },
      { method: 'GET', path: '/api/v1/fs/search?q=cat&limit=50', scope: 'read', desc: '文件名模糊搜索, 每令牌每分钟限 6 次, 超出 429', resp: '{"items":[Node & {path}]}' },
      { method: 'POST', path: '/api/v1/fs/link', scope: 'read', desc: '签名直链, expiresIn 秒, 0 为永久', body: '{"path":"/a.png","expiresIn":0}', resp: '{"url":"https://.../f/<id>/a.png?e=0&s=..."}' },
      { method: 'GET', path: '/api/v1/files/<id>/content', scope: 'read', desc: '读取内容, 支持 Range; ?download=1 以附件下载' },
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
      { method: 'POST', path: '/api/v1/shares', scope: 'read', desc: '创建分享, 密码和有效期可选', body: '{"path":"/a.zip","password":"1234","expiresIn":604800}', resp: '{"id":"...","url":"https://.../s/<id>"}' },
      { method: 'GET', path: '/api/v1/shares', scope: 'read', desc: '分享列表' },
      { method: 'DELETE', path: '/api/v1/shares/<id>', scope: 'write', desc: '撤销分享' },
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
      { method: 'GET', path: '/api/v1/admin/stats', scope: 'admin', desc: '用量, Bot 与频道状态' },
      { method: 'POST', path: '/api/v1/admin/channels', scope: 'admin', desc: '添加存储频道, 返回每个 Bot 是否为管理员', body: '{"id":"-1001234567890"}' },
      { method: 'PATCH', path: '/api/v1/admin/channels/<id>', scope: 'admin', desc: '频道设为只读或恢复', body: '{"status":"readonly"}' },
      { method: 'POST', path: '/api/v1/admin/bots', scope: 'admin', desc: '添加 Bot', body: '{"token":"123456:ABC..."}' },
      { method: 'DELETE', path: '/api/v1/admin/bots/<id>', scope: 'admin', desc: '停用 Bot, ?force=1 彻底删除' },
      { method: 'POST', path: '/api/v1/admin/tokens', scope: 'admin', desc: '签发 API 令牌, 明文只返回一次', body: '{"name":"picgo","scopes":["read","write"],"rootPath":"/picgo","expiresIn":31536000}', resp: '{"token":"hxd_..."}' },
      { method: 'GET', path: '/api/v1/admin/tokens', scope: 'admin', desc: '令牌列表' },
      { method: 'DELETE', path: '/api/v1/admin/tokens/<id>', scope: 'admin', desc: '吊销令牌' },
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
