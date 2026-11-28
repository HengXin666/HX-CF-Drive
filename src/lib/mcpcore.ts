/**
 * MCP (Model Context Protocol) 端点的核心 (#22): JSON-RPC 分发 + 工具表, 不依赖 Workers 环境。
 * 每个工具都翻译成一次对 REST API 的进程内调用 (不发子请求), 鉴权, scope, 令牌根目录隔离, 额度都和直接调接口完全一样。
 * Worker (src/routes/mcp.ts) 和演示模式 (web/src/demo/server.ts) 共用这一份。
 */
export type Call = (method: string, path: string, body?: unknown, raw?: { data: Uint8Array; mime: string }) => Promise<{ status: number; body: unknown }>;

export const MCP_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
/** 通过 MCP 上传的单个文件上限: 内容在 JSON 里 (base64 解码要花 Worker CPU), 大文件请走 REST 分片上传 */
export const MCP_UPLOAD_MAX = 10 * 1024 * 1024;

interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (a: Record<string, unknown>, call: Call) => Promise<{ status: number; body: unknown }>;
}

const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const q = (o: Record<string, string | number | undefined>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== '') s.set(k, String(v));
  return s.toString();
};
const target = { id: { type: 'string', description: '节点 id (和 path 二选一)' }, path: { type: 'string', description: '路径, 相对令牌根目录, 如 /photos/a.png' } };

function b64decode(s: string): Uint8Array {
  const bin = atob(s.replace(/\s+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const TOOLS: Tool[] = [
  {
    name: 'list',
    description: '列出目录内容 (需要 read)。不传 limit 时返回全部子项 (目录在前); 传 limit 时按名字分页, 下一页把返回的 next 作为 after。',
    inputSchema: { type: 'object', properties: { ...target, limit: { type: 'integer', minimum: 1, maximum: 1000 }, after: { type: 'string' } } },
    run: (a, call) => call('GET', `/fs/list?${q({ id: str(a.id), path: str(a.path) ?? (str(a.id) ? undefined : '/'), limit: num(a.limit), after: str(a.after) })}`),
  },
  {
    name: 'stat',
    description: '查看一个文件或目录的信息 (需要 read)。',
    inputSchema: { type: 'object', properties: target },
    run: (a, call) => call('GET', `/fs/stat?${q({ id: str(a.id), path: str(a.path) })}`),
  },
  {
    name: 'search',
    description: '按文件名和 / 或类型搜索 (需要 read, 每令牌每分钟限 6 次)。q 和 type 至少给一个; dir 只搜该目录的子树 (更快), 不给则搜整个令牌根目录。',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: '名字里包含的文字' },
        type: { type: 'string', enum: ['image', 'video', 'audio', 'doc', 'archive', 'other'] },
        dir: { type: 'string', description: '只在这个目录及子目录里搜' },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
      },
    },
    run: (a, call) => call('GET', `/fs/search?${q({ q: str(a.q), type: str(a.type), dir: str(a.dir), limit: num(a.limit) })}`),
  },
  {
    name: 'upload',
    description: `上传一个文件 (需要 write), 目录不存在会自动创建, 返回节点和永久直链。text 和 base64 二选一; 单个文件 ≤ ${MCP_UPLOAD_MAX / 1024 / 1024} MB, 更大的请用 REST 分片上传。`,
    inputSchema: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: '目标目录, 如 /agent/tmp, 默认 /' },
        name: { type: 'string', description: '文件名' },
        text: { type: 'string', description: '文本内容 (UTF-8)' },
        base64: { type: 'string', description: '二进制内容的 base64' },
        mime: { type: 'string', description: 'MIME 类型, 如 image/png' },
        overwrite: { type: 'boolean', description: '同名时覆盖, 默认 false (同名报错)' },
        expiresIn: { type: 'integer', minimum: 60, description: '多少秒后自动删除 (临时文件用); 不传为永久' },
      },
      required: ['name'],
    },
    run: async (a, call) => {
      const name = str(a.name);
      if (!name) return { status: 400, body: { error: 'name required' } };
      const data = typeof a.text === 'string' ? new TextEncoder().encode(a.text) : typeof a.base64 === 'string' ? b64decode(a.base64) : null;
      if (!data) return { status: 400, body: { error: 'text or base64 required' } };
      if (data.length > MCP_UPLOAD_MAX) return { status: 413, body: { error: `too large for MCP upload (max ${MCP_UPLOAD_MAX} bytes), use chunked REST upload` } };
      const mime = str(a.mime) ?? (typeof a.text === 'string' ? 'text/plain; charset=utf-8' : 'application/octet-stream');
      return call('POST', `/upload?${q({ path: str(a.dir) ?? '/', name, overwrite: a.overwrite ? 1 : undefined, expiresIn: num(a.expiresIn) })}`, undefined, { data, mime });
    },
  },
  {
    name: 'link',
    description: '给文件签直链 (需要 read)。expiresIn 为秒, 0 或不传为永久。直链不需要令牌即可访问, 支持 Range。',
    inputSchema: { type: 'object', properties: { ...target, expiresIn: { type: 'integer', minimum: 0 } } },
    run: (a, call) => call('POST', '/fs/link', { id: str(a.id), path: str(a.path), expiresIn: num(a.expiresIn) ?? 0 }),
  },
  {
    name: 'share',
    description: '创建分享链接 (需要 read), 文件或目录都行; 密码, 有效期 (秒), 备注可选。',
    inputSchema: { type: 'object', properties: { ...target, password: { type: 'string' }, expiresIn: { type: 'integer', minimum: 0 }, remark: { type: 'string' } } },
    run: (a, call) => call('POST', '/shares', { id: str(a.id), path: str(a.path), password: str(a.password), expiresIn: num(a.expiresIn), remark: str(a.remark) }),
  },
];

interface Msg { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> }
const ok = (id: Msg['id'], result: unknown) => ({ jsonrpc: '2.0', id, result });
const err = (id: Msg['id'], code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

async function one(m: Msg, call: Call, info: { name: string; version: string }): Promise<unknown | null> {
  if (!m || typeof m !== 'object' || m.jsonrpc !== '2.0' || typeof m.method !== 'string') return err(m?.id, -32600, 'invalid request');
  // 通知 (没有 id) 不回复
  const notify = m.id === undefined;
  switch (m.method) {
    case 'initialize': {
      const want = String(m.params?.protocolVersion ?? '');
      return ok(m.id, {
        protocolVersion: MCP_VERSIONS.includes(want) ? want : MCP_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: info,
        instructions: 'HX-CF-Drive: Telegram 存储的网盘。路径相对令牌根目录; 上传后返回的 url 是永久直链, 可直接嵌入或分享。',
      });
    }
    case 'ping': return notify ? null : ok(m.id, {});
    case 'tools/list': return ok(m.id, { tools: TOOLS.map(({ run: _r, ...t }) => t) });
    case 'tools/call': {
      const name = String(m.params?.name ?? '');
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) return err(m.id, -32602, `unknown tool: ${name}`);
      const args = (m.params?.arguments ?? {}) as Record<string, unknown>;
      let r: { status: number; body: unknown };
      try {
        r = await tool.run(args, call);
      } catch (e) {
        r = { status: 400, body: { error: (e as Error).message } };
      }
      const isError = r.status >= 400;
      const text = isError ? `HTTP ${r.status}: ${(r.body as { error?: string })?.error ?? JSON.stringify(r.body)}` : JSON.stringify(r.body);
      return ok(m.id, { content: [{ type: 'text', text }], ...(isError ? { isError: true } : { structuredContent: r.body }) });
    }
    default:
      if (m.method.startsWith('notifications/')) return null;
      return notify ? null : err(m.id, -32601, `method not found: ${m.method}`);
  }
}

/** 处理一个 POST 体 (单条或批量)。返回 null 表示全是通知, HTTP 层回 202 */
export async function handleMcp(body: unknown, call: Call, info = { name: 'HX-CF-Drive', version: '0.4.0' }): Promise<unknown | null> {
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map((m) => one(m as Msg, call, info)))).filter((x) => x !== null);
    return out.length ? out : null;
  }
  return one(body as Msg, call, info);
}
