/**
 * MCP 端点 (#22): POST /api/v1/mcp, Streamable HTTP 传输的无状态子集 (每个 POST 直接回 JSON, 不开 SSE, 没有会话)。
 * 鉴权和 REST 一样 (Authorization: Bearer <令牌>, 可带 X-Drive-Scope); 工具调用在进程内转给 REST 路由, 不发子请求, 额度与直接调接口相同。
 */
import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { requireScope, SCOPE_HEADER } from '../lib/auth';
import { type Call, handleMcp } from '../lib/mcpcore';
import { HttpError } from '../lib/util';
import { api } from './api';

export const mcp = new Hono<AppEnv>();

/** 进程内调用 REST 路由用的壳: 错误转成和外部请求一样的 JSON */
let inner: Hono<AppEnv> | null = null;
function innerApp(): Hono<AppEnv> {
  if (inner) return inner;
  inner = new Hono<AppEnv>();
  inner.onError((e, c) => {
    if (e instanceof HttpError) return c.json({ error: e.message }, e.status as 400);
    if (e instanceof SyntaxError) return c.json({ error: 'invalid json body' }, 400);
    console.error('mcp tool', e);
    return c.json({ error: 'internal error' }, 500);
  });
  inner.route('/api/v1', api);
  return inner;
}

mcp.post('/', requireScope(), async (c) => {
  const base = new URL(c.req.url).origin;
  const auth = c.req.header('Authorization') ?? '';
  const scope = c.req.header(SCOPE_HEADER);
  const call: Call = async (method, path, body, raw) => {
    const headers: Record<string, string> = { Authorization: auth };
    if (scope) headers[SCOPE_HEADER] = scope;
    let payload: BodyInit | undefined;
    if (raw) { headers['Content-Type'] = raw.mime; headers['Content-Length'] = String(raw.data.length); payload = raw.data; }
    else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await innerApp().fetch(new Request(`${base}/api/v1${path}`, { method, headers, body: payload }), c.env, c.executionCtx);
    const text = await res.text();
    let parsed: unknown = text;
    try { parsed = JSON.parse(text); } catch { /* 非 JSON 原样返回 */ }
    return { status: res.status, body: parsed };
  };
  let msg: unknown;
  try {
    msg = await c.req.json();
  } catch {
    return c.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }, 400);
  }
  const out = await handleMcp(msg, call);
  if (out === null) return c.body(null, 202);
  return c.json(out);
});

// 不提供服务端推送流 (SSE), 也没有会话可删
mcp.on(['GET', 'DELETE'], '/', (c) => c.json({ error: 'method not allowed' }, 405, { Allow: 'POST' }));
