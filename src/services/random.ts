/**
 * 随机图 API (#22 P2-18): GET /random?dir=&orientation=auto|landscape|portrait&type=img|url
 *
 * 默认关闭: 只有设置了 RANDOM_DIR (如 "/random") 才开放, 而且只能取这个目录子树里的图片, 不会暴露网盘其他内容。
 * - dir: RANDOM_DIR 下的子目录 (相对路径), 不传为 RANDOM_DIR 本身。
 * - orientation: 节点不存图片宽高, 所以按约定的子目录区分: landscape / portrait (或 横屏 / 竖屏) 子目录;
 *   auto 按 User-Agent 判断, 手机取竖屏, 其余取横屏; 对应子目录不存在时退回全部图片。
 * - type=img (默认): 302 跳到 1 小时有效的签名直链 (/f/ 走节点缓存和 Range, Worker 不经手内容); type=url: 返回 JSON。
 * 图片清单按目录缓存在 isolate 内存里 5 分钟 (最多 RANDOM_MAX 张): 热点时 D1 零读, 冷启动读一次子树。
 * 本 isolate 内删除 / 移动后立即失效; 其他 isolate 最多滞后 5 分钟 (期间可能跳到已删除的图, 返回 404)。
 */
import type { Context } from 'hono';
import type { AppEnv, Env } from '../env';
import { categoryOf } from '../lib/category';
import { epoch, type NodeRow, resolvePath, subtree } from '../lib/tree';
import { HttpError } from '../lib/util';

const TTL = 5 * 60_000;
export const RANDOM_MAX = 5000;
const cache = new Map<string, { at: number; ep: number; all: NodeRow[]; land: NodeRow[]; port: NodeRow[] }>();
const LAND = /^(landscape|横屏|pc|desktop)$/i;
const PORT = /^(portrait|竖屏|mobile|phone)$/i;

async function pool(env: Env, dir: string) {
  const hit = cache.get(dir);
  // 本 isolate 内有删除 / 移动 (epoch 变了) 就立即重读; 别的 isolate 里最多滞后 TTL
  if (hit && Date.now() - hit.at < TTL && hit.ep === epoch()) return hit;
  const ep = epoch();
  const base = env.RANDOM_DIR!.trim();
  const root = await resolvePath(env, 'root', `${base}/${dir}`);
  if (!root || root.kind !== 'dir') throw new HttpError(404, 'random dir not found');
  const rows = await subtree(env, root.id, RANDOM_MAX);
  const byId = new Map(rows.map((n) => [n.id, n]));
  // 每张图属于哪个方向: 往上找祖先目录名, 碰到 landscape / portrait 子目录就归到那一类
  const side = (n: NodeRow): 'l' | 'p' | null => {
    for (let cur = byId.get(n.parent_id ?? ''); cur && cur.id !== root.id; cur = byId.get(cur.parent_id ?? '')) {
      if (LAND.test(cur.name)) return 'l';
      if (PORT.test(cur.name)) return 'p';
    }
    return null;
  };
  const all = rows.filter((n) => n.kind === 'file' && n.blob_id && categoryOf(n.kind, n.mime, n.name) === 'image' && !(n.expires_at && n.expires_at < Date.now()));
  const v = { at: Date.now(), ep, all, land: all.filter((n) => side(n) === 'l'), port: all.filter((n) => side(n) === 'p') };
  if (cache.size > 100) cache.clear();
  cache.set(dir, v);
  return v;
}

export async function randomImage(c: Context<AppEnv>, link: (n: NodeRow) => Promise<string>): Promise<Response> {
  if (!c.env.RANDOM_DIR?.trim()) throw new HttpError(404, 'random api disabled (set RANDOM_DIR)');
  const dir = (c.req.query('dir') ?? '').replace(/^\/+|\/+$/g, '');
  if (dir.split('/').some((s) => s === '..' || s === '.')) throw new HttpError(400, 'bad dir');
  let o = c.req.query('orientation') ?? 'auto';
  if (!['auto', 'landscape', 'portrait'].includes(o)) throw new HttpError(400, 'orientation must be auto, landscape or portrait');
  if (o === 'auto') o = /Mobi|Android|iPhone|iPad/i.test(c.req.header('User-Agent') ?? '') ? 'portrait' : 'landscape';
  const p = await pool(c.env, dir);
  const list = (o === 'landscape' ? p.land : p.port).length ? (o === 'landscape' ? p.land : p.port) : p.all;
  if (!list.length) throw new HttpError(404, 'no images');
  const n = list[Math.floor(Math.random() * list.length)];
  const url = await link(n);
  const noStore = { 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' };
  if (c.req.query('type') === 'url') return c.json({ url, name: n.name, orientation: o }, 200, noStore);
  return new Response(null, { status: 302, headers: { Location: url, ...noStore } });
}
