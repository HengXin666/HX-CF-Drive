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
