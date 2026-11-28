import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { AppEnv, Env } from './env';
import { HttpError } from './lib/util';
import { api } from './routes/api';
import { dav } from './routes/dav';
import { pub } from './routes/public';
import { runMaintenance } from './services/maintenance';
import { setTgApiBase } from './drivers/tg';
import { meterDb, meterHeader, type Meter } from './lib/d1meter';

const app = new Hono<AppEnv>();

app.onError((err, c) => {
  if (err instanceof HttpError) {
    return c.json({ error: err.message }, err.status as 400, err.headers);
  }
  // 请求体不是合法 JSON (c.req.json 抛 SyntaxError)
  if (err instanceof SyntaxError) return c.json({ error: 'invalid json body' }, 400);
  // 详细错误只进日志, 客户端只拿到请求 ID, 不暴露 SQL, 上游返回等内部信息
  const requestId = c.req.header('cf-ray') ?? crypto.randomUUID();
  console.error(`[${requestId}] ${c.req.method} ${new URL(c.req.url).pathname}`, err);
  return c.json({ error: 'internal error', requestId }, 500, { 'X-Request-Id': requestId });
});

app.use(
  '/api/*',
  cors({
    origin: '*',
    allowHeaders: ['Authorization', 'Content-Type', 'Range', 'If-Range', 'X-Share-Password'],
    allowMethods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    exposeHeaders: ['Content-Range', 'Content-Length', 'ETag', 'Retry-After', 'X-Request-Id'],
    maxAge: 86400,
  }),
);
app.use('/f/*', cors({ origin: '*', exposeHeaders: ['Content-Range', 'Content-Length', 'ETag'] }));

app.get('/api/health', (c) => c.json({ ok: true, name: 'HX-CF-Drive', version: '0.4.0' }));
app.route('/api/v1', api);
app.route('/dav', dav);
app.route('/', pub);

// 其余路径交给静态前端
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext) {
    setTgApiBase(env.TG_API_BASE);
    if (env.D1_METER !== '1') return app.fetch(req, env, ctx);
    // 实测模式: 响应头带上本请求的 D1 用量
    const m: Meter = { q: 0, r: 0, w: 0 };
    const res = await app.fetch(req, { ...env, DB: meterDb(env.DB, m) }, ctx);
    const out = new Response(res.body, res);
    out.headers.set('X-D1-Rows', meterHeader(m));
    return out;
  },
  async scheduled(_ev: ScheduledController, env: Env, ctx: ExecutionContext) {
    setTgApiBase(env.TG_API_BASE);
    ctx.waitUntil(runMaintenance(env).then((r) => console.log('maintenance', JSON.stringify(r))));
  },
} satisfies ExportedHandler<Env>;
