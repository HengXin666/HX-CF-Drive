// 本地实测用: 统计每个请求的 D1 查询数和行读写, 写进响应头 X-D1-Rows。仅 D1_METER=1 时启用
export interface Meter { q: number; r: number; w: number }

const INNER = Symbol('inner');
type Meta = { rows_read?: number; rows_written?: number } | undefined;

function add(m: Meter, meta: Meta): void {
  m.q++;
  m.r += meta?.rows_read ?? 0;
  m.w += meta?.rows_written ?? 0;
}

function pass(t: object, k: string | symbol): unknown {
  const v = Reflect.get(t, k);
  return typeof v === 'function' ? v.bind(t) : v;
}

function wrapStmt(s: D1PreparedStatement, m: Meter): D1PreparedStatement {
  return new Proxy(s, {
    get(t, k) {
      if (k === INNER) return t;
      if (k === 'bind') return (...a: unknown[]) => wrapStmt(t.bind(...a), m);
      if (k === 'run' || k === 'all') {
        return async () => {
          const r = await t[k]();
          add(m, r.meta as Meta);
          return r;
        };
      }
      // first 没有 meta, 改用 all 取首行 (无 LIMIT 的查询会略微多算)
      if (k === 'first') {
        return async (col?: string) => {
          const r = await t.all<Record<string, unknown>>();
          add(m, r.meta as Meta);
          const row = r.results[0] ?? null;
          return col ? (row?.[col] ?? null) : row;
        };
      }
      return pass(t, k);
    },
  });
}

export function meterDb(db: D1Database, m: Meter): D1Database {
  return new Proxy(db, {
    get(t, k) {
      if (k === 'prepare') return (sql: string) => wrapStmt(t.prepare(sql), m);
      if (k === 'batch') {
        return async (ss: D1PreparedStatement[]) => {
          const inner = ss.map((s) => ((s as unknown as Record<symbol, D1PreparedStatement>)[INNER] ?? s));
          const rs = await t.batch(inner);
          for (const r of rs) add(m, r.meta as Meta);
          return rs;
        };
      }
      return pass(t, k);
    },
  });
}

export function meterHeader(m: Meter): string {
  return `q=${m.q} r=${m.r} w=${m.w}`;
}
