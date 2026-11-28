import { describe, expect, it } from 'vitest';
import { usageFromCounters } from '../src/services/stats';

describe('用量快照 (#23)', () => {
  it('没有快照返回 null, 有快照按 stats 原结构还原', () => {
    expect(usageFromCounters({ tg_failed: 3 })).toBeNull();
    expect(usageFromCounters({ stat_at: 5, stat_files: 2, stat_dirs: 1, stat_blobs: 2, stat_bytes: 10 })).toEqual({
      nodes: [{ kind: 'dir', n: 1 }, { kind: 'file', n: 2 }], blobs: { n: 2, bytes: 10 }, at: 5,
    });
  });
});

import { advance, applyLow, type Sweep } from '../src/services/sweep';

describe('孤儿清扫 rowid 水位 (#23)', () => {
  it('推进 s 时 t / r 取不晚于 s 的最新水位, 并丢掉已清扫的水位', () => {
    const sw: Sweep = { s: 10, t: 1, r: 5, k: [[20, 100, 50], [30, 200, 60], [40, 300, 70]] };
    advance(sw, 35);
    expect(sw).toEqual({ s: 35, t: 200, r: 60, k: [[40, 300, 70]] });
  });
  it('旧水位没有 rowid 时 r 变为缺省 (退回按 created_at 扫)', () => {
    const sw: Sweep = { s: 10, t: 1, r: 5, k: [[20, 100]] };
    advance(sw, 20);
    expect(sw.r).toBeUndefined();
    expect(sw.t).toBe(100);
  });
  it('purge 删过最大 rowid 后, 所有记下的 rowid 压到不超过 low', () => {
    const sw: Sweep = { s: 10, t: 1, r: 80, k: [[20, 100, 50], [30, 200, 90], [40, 300]] };
    applyLow(sw, 60);
    expect(sw.r).toBe(60);
    expect(sw.k).toEqual([[20, 100, 50], [30, 200, 60], [40, 300]]);
    applyLow(sw, null);
    expect(sw.r).toBe(60);
  });
});
