// 从 CF GraphQL 按分钟取 Worker CPU / 子请求 和 D1 行读写, 与 bench.mjs 的阶段对齐
// CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... D1_ID=... node scripts/cfstats.mjs bench-client.json
import { readFileSync } from 'node:fs';

const bench = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const first = bench.phases[0].minute;
const last = new Date(Date.parse(bench.phases.at(-1).minute) + 120000).toISOString();

async function gql(query, variables) {
  const r = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const j = await r.json();
  if (j.errors?.length) return { error: j.errors.map((e) => e.message).join('; ') };
  return j.data.viewer.accounts[0];
}

const vars = { a: process.env.CLOUDFLARE_ACCOUNT_ID, s: first, e: last };
const w = await gql(`query($a:string,$s:Time,$e:Time){viewer{accounts(filter:{accountTag:$a}){
  workersInvocationsAdaptive(limit:200,filter:{scriptName:"hx-cf-drive",datetime_geq:$s,datetime_leq:$e}){
    sum{requests subrequests errors} quantiles{cpuTimeP50 cpuTimeP90 cpuTimeP99 wallTimeP50 wallTimeP90}
    dimensions{datetimeMinute}}}}}`, vars);
const d = await gql(`query($a:string,$s:Time,$e:Time,$db:string){viewer{accounts(filter:{accountTag:$a}){
  d1AnalyticsAdaptiveGroups(limit:200,filter:{databaseId:$db,datetimeMinute_geq:$s,datetimeMinute_leq:$e}){
    sum{readQueries writeQueries rowsRead rowsWritten} dimensions{datetimeMinute}}}}}`, { ...vars, db: process.env.D1_ID });

const byMin = (arr) => Object.fromEntries((arr ?? []).map((x) => [x.dimensions.datetimeMinute, x]));
const wm = byMin(w.workersInvocationsAdaptive);
const dm = byMin(d.d1AnalyticsAdaptiveGroups);
for (const p of bench.phases) {
  const x = wm[p.minute];
  const y = dm[p.minute];
  if (x) Object.assign(p, { cf_requests: x.sum.requests, subrequests: x.sum.subrequests, errors: x.sum.errors, cpu_p50: x.quantiles.cpuTimeP50, cpu_p90: x.quantiles.cpuTimeP90, cpu_p99: x.quantiles.cpuTimeP99, wall_p50: x.quantiles.wallTimeP50 });
  if (y) Object.assign(p, { d1_read_q: y.sum.readQueries, d1_write_q: y.sum.writeQueries, rows_read: y.sum.rowsRead, rows_written: y.sum.rowsWritten });
}
console.log(JSON.stringify({ ...bench, cf_errors: { workers: w.error ?? null, d1: d.error ?? null } }, null, 2));
