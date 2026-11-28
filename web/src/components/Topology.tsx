// 后台: Bot 与存储频道的拓扑图 (SVG)。左边 Bot, 右边频道, 连线粗细是这对上存的分片数
import { useCallback, useEffect, useMemo, useState } from 'react';
import { admin, fmtSize, type Topology as Topo } from '../lib/api';
import { Button, Card, cn, toast } from '../ui';
import { Icon } from './Icon';

const W = 760;
const BOX_W = 232;
const BOX_H = 46;
const GAP = 14;
const PAD = 20;
const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

type Edge = { b: string; c: string; n: number; bytes: number; perm?: string; writable: boolean };

export function Topology() {
  const [t, setT] = useState<Topo | null>(null);
  const [busy, setBusy] = useState<'' | 'check' | 'fresh'>('');
  const [hover, setHover] = useState<string | null>(null);

  const load = useCallback(async (check = false, fresh = false) => {
    setBusy(check ? 'check' : fresh ? 'fresh' : '');
    try {
      const r = await admin.topology(check, fresh);
      // 权限检查结果留着, 只重新统计时不清掉
      setT((old) => (check || !old ? r : { ...r, perms: old.perms }));
      if (check) {
        const bad = Object.values(r.perms).filter((v) => !v.startsWith('ok') && v !== 'unchecked').length;
        if (bad) toast.warning(`${bad} 对 Bot 和频道的权限有问题, 红线标出`);
        else toast.success('权限检查完成');
      }
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy('');
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const g = useMemo(() => {
    if (!t) return null;
    const edges = new Map<string, Edge>();
    // 上传时任何可用 Bot 都可能写任何 active 频道: 这些是 "可写" 的线
    for (const b of t.bots) if (b.status === 'active') for (const c of t.channels) if (c.status === 'active') {
      edges.set(`${b.id}|${c.id}`, { b: b.id, c: c.id, n: 0, bytes: 0, writable: true });
    }
    // 已经存了分片的线 (含失效 Bot, 只读频道)
    for (const u of t.usage) {
      const k = `${u.b}|${u.c}`;
      const e = edges.get(k) ?? { b: u.b, c: u.c, n: 0, bytes: 0, writable: false };
      e.n += u.n;
      e.bytes += u.bytes;
      edges.set(k, e);
    }
    for (const [k, v] of Object.entries(t.perms)) { const e = edges.get(k); if (e) e.perm = v; }
    const sum = (key: 'b' | 'c', id: string) => [...edges.values()].filter((e) => e[key] === id).reduce((a, e) => ({ n: a.n + e.n, bytes: a.bytes + e.bytes }), { n: 0, bytes: 0 });
    const rows = Math.max(t.bots.length, t.channels.length, 1);
    const H = PAD * 2 + rows * BOX_H + (rows - 1) * GAP;
    const yOf = (i: number, count: number) => {
      const block = count * BOX_H + (count - 1) * GAP;
      return (H - block) / 2 + i * (BOX_H + GAP);
    };
    const bots = t.bots.map((b, i) => ({ ...b, y: yOf(i, t.bots.length), ...sum('b', b.id) }));
    const channels = t.channels.map((c, i) => ({ ...c, y: yOf(i, t.channels.length), ...sum('c', c.id) }));
    const max = Math.max(1, ...[...edges.values()].map((e) => e.n));
    return { edges: [...edges.values()], bots, channels, H, max };
  }, [t]);

  const total = t?.usage.reduce((a, u) => ({ n: a.n + u.n, bytes: a.bytes + u.bytes }), { n: 0, bytes: 0 });
  const liveBots = t?.bots.filter((b) => b.status === 'active').length ?? 0;
  const liveChans = t?.channels.filter((c) => c.status === 'active').length ?? 0;
  const at = (id: string) => hover === null || hover === id || hover.split('|').includes(id);

  return (
    <Card className="gap-3 p-3 md:p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="grid gap-0.5">
          <div className="flex items-center gap-2 font-semibold"><Icon name="tree" className="size-4 text-brand" />存储拓扑</div>
          <div className="text-xs text-muted-foreground">
            {t ? <>{liveBots} / {t.bots.length} 个 Bot 可用, 写入 {liveChans} / {t.channels.length} 个频道, 共 {total?.n ?? 0} 片 · {fmtSize(total?.bytes ?? 0)}</> : <span className="inline-flex items-center gap-1.5"><Icon name="spinner" className="size-3.5 animate-spin" />加载中…</span>}
          </div>
        </div>
        <div className="flex gap-1.5">
          <Button size="sm" variant="outline" loading={busy === 'fresh'} onClick={() => void load(false, true)}><Icon name="refresh" /><span className="hidden sm:inline">重新统计</span></Button>
          <Button size="sm" variant="outline" loading={busy === 'check'} onClick={() => void load(true)}><Icon name="shield" /><span className="hidden sm:inline">检查权限</span></Button>
        </div>
      </div>
      {g && (t!.bots.length === 0 || t!.channels.length === 0) ? (
        <div className="grid h-32 place-items-center text-sm text-muted-foreground">先在下面添加 Bot 和频道</div>
      ) : g && (
        <div className="overflow-x-auto">
          <svg viewBox={`0 0 ${W} ${g.H}`} className="min-w-[560px] w-full" role="img" aria-label="Bot 与频道的拓扑">
            {g.edges.map((e) => {
              const b = g.bots.find((x) => x.id === e.b);
              const c = g.channels.find((x) => x.id === e.c);
              if (!b || !c) return null;
              const x1 = PAD + BOX_W, y1 = b.y + BOX_H / 2, x2 = W - PAD - BOX_W, y2 = c.y + BOX_H / 2, mx = (x1 + x2) / 2;
              const bad = e.perm && !e.perm.startsWith('ok') && e.perm !== 'unchecked';
              const k = `${e.b}|${e.c}`;
              return (
                <path key={k} d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`} fill="none"
                  strokeWidth={e.n ? 1.5 + 6 * Math.sqrt(e.n / g.max) : 1.2}
                  strokeDasharray={e.writable ? undefined : '5 4'}
                  className={cn('transition-opacity', bad ? 'stroke-destructive' : e.n ? 'stroke-brand' : 'stroke-muted-foreground/40', !at(e.b) && !at(e.c) && hover !== k ? 'opacity-15' : e.n ? 'opacity-80' : 'opacity-100')}
                  onMouseEnter={() => setHover(k)} onMouseLeave={() => setHover(null)}>
                  <title>{`@${b.username ?? b.id} → ${c.title || c.id}\n${e.n} 片 · ${fmtSize(e.bytes)}${e.writable ? '' : '\n(不再写入, 只读取)'}${e.perm ? `\n权限: ${e.perm}` : ''}`}</title>
                </path>
              );
            })}
            {g.bots.map((b) => (
              <g key={b.id} transform={`translate(${PAD},${b.y})`} className={cn('transition-opacity', b.status !== 'active' && 'opacity-50', !at(b.id) && 'opacity-30')}
                onMouseEnter={() => setHover(b.id)} onMouseLeave={() => setHover(null)}>
                <rect width={BOX_W} height={BOX_H} rx={8} className={cn('fill-card', b.status === 'active' ? 'stroke-border' : 'stroke-destructive/60')} strokeWidth={1} />
                <circle cx={14} cy={BOX_H / 2} r={4} className={b.status === 'active' ? 'fill-emerald-500' : 'fill-destructive'} />
                <text x={26} y={19} className="fill-foreground font-mono text-[12px]">{cut(`@${b.username ?? b.id}`, 28)}</text>
                <text x={26} y={35} className="fill-muted-foreground text-[11px]">{b.status === 'active' ? `${b.n} 片 · ${fmtSize(b.bytes)}` : `失效 · ${b.n} 片待重绑`}</text>
                <title>{`@${b.username ?? b.id} (${b.id})\n状态: ${b.status}`}</title>
              </g>
            ))}
            {g.channels.map((c) => (
              <g key={c.id} transform={`translate(${W - PAD - BOX_W},${c.y})`} className={cn('transition-opacity', c.status === 'dead' && 'opacity-50', !at(c.id) && 'opacity-30')}
                onMouseEnter={() => setHover(c.id)} onMouseLeave={() => setHover(null)}>
                <rect width={BOX_W} height={BOX_H} rx={8} className={cn('fill-card', c.status === 'active' ? 'stroke-border' : c.status === 'readonly' ? 'stroke-amber-500/70' : 'stroke-destructive/60')} strokeWidth={1}
                  strokeDasharray={c.status === 'readonly' ? '4 3' : undefined} />
                <text x={12} y={19} className="fill-foreground text-[12px]">{cut(c.title || c.id, 20)}{c.status !== 'active' ? (c.status === 'readonly' ? ' · 只读' : ' · 失效') : ''}</text>
                <text x={12} y={35} className="fill-muted-foreground font-mono text-[11px]">{`${c.n} 片 · ${fmtSize(c.bytes)}`}</text>
                <title>{`${c.title || ''} ${c.id}\n状态: ${c.status}`}</title>
              </g>
            ))}
          </svg>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
            <span className="inline-flex items-center gap-1.5"><svg width="22" height="6"><line x1="0" y1="3" x2="22" y2="3" strokeWidth="3" className="stroke-brand" /></svg>存有分片, 越粗越多</span>
            <span className="inline-flex items-center gap-1.5"><svg width="22" height="6"><line x1="0" y1="3" x2="22" y2="3" strokeWidth="1.2" className="stroke-muted-foreground/40" /></svg>可写, 还没分到</span>
            <span className="inline-flex items-center gap-1.5"><svg width="22" height="6"><line x1="0" y1="3" x2="22" y2="3" strokeWidth="1.5" strokeDasharray="5 4" className="stroke-brand" /></svg>只读取 (Bot 失效或频道只读)</span>
            <span className="inline-flex items-center gap-1.5"><svg width="22" height="6"><line x1="0" y1="3" x2="22" y2="3" strokeWidth="2" className="stroke-destructive" /></svg>检查权限时发现问题</span>
          </div>
        </div>
      )}
    </Card>
  );
}
