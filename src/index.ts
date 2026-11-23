import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { AppEnv, Env } from './env';
import { HttpError } from './lib/util';
import { api } from './routes/api';
import { dav } from './routes/dav';
import { pub } from './routes/public';
import { runMaintenance } from './services/maintenance';
import { setTgApiBase } from './drivers/tg';

export { ChannelLimiter } from './do/limiter';

const app = new Hono<AppEnv>();

app.onError((err, c) => {
  if (err instanceof HttpError) {
    return c.json({ error: err.message }, err.status as 400, err.headers);
  }
  console.error(err);
  return c.json({ error: 'internal error', detail: String(err) }, 500);
});

app.use(
  '/api/*',
  cors({
    origin: '*',
    allowHeaders: ['Authorization', 'Content-Type', 'Range', 'X-Share-Password'],
    allowMethods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    exposeHeaders: ['Content-Range', 'Content-Length', 'ETag', 'Retry-After'],
    maxAge: 86400,
  }),
);
app.use('/f/*', cors({ origin: '*', exposeHeaders: ['Content-Range', 'Content-Length', 'ETag'] }));

app.get('/api/health', (c) => c.json({ ok: true, name: 'HX-CF-Drive', version: '0.1.0' }));
app.route('/api/v1', api);
app.route('/dav', dav);
app.route('/', pub);

// 其余路径交给静态前端
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

export default {
  fetch(req: Request, env: Env, ctx: ExecutionContext) {
    setTgApiBase(env.TG_API_BASE);
    return app.fetch(req, env, ctx);
  },
  async scheduled(_ev: ScheduledController, env: Env, ctx: ExecutionContext) {
    setTgApiBase(env.TG_API_BASE);
    ctx.waitUntil(runMaintenance(env).then((r) => console.log('maintenance', JSON.stringify(r))));
  },
} satisfies ExportedHandler<Env>;
