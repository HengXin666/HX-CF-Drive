import { describe, expect, it } from 'vitest';
import { clampRange, mapToChunks, parseRange } from '../src/lib/range';

const MB = 1024 * 1024;

describe('parseRange', () => {
  it('无 Range', () => expect(parseRange(null, 100)).toBeNull());
  it('普通区间', () => expect(parseRange('bytes=10-19', 100)).toEqual({ start: 10, end: 19 }));
  it('开放结尾', () => expect(parseRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 }));
  it('后缀区间', () => expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 }));
  it('结尾越界截断', () => expect(parseRange('bytes=50-500', 100)).toEqual({ start: 50, end: 99 }));
  it('起点越界', () => expect(() => parseRange('bytes=100-', 100)).toThrow('unsatisfiable'));
  it('多段不支持 → 当作无 Range', () => expect(parseRange('bytes=0-1,5-6', 100)).toBeNull());
});

describe('mapToChunks', () => {
  it('跨三个分片', () => {
    const r = mapToChunks({ start: 16 * MB - 10, end: 32 * MB + 9 }, 16 * MB);
    expect(r).toEqual([
      { idx: 0, from: 16 * MB - 10, to: 16 * MB - 1 },
      { idx: 1, from: 0, to: 16 * MB - 1 },
      { idx: 2, from: 0, to: 9 },
    ]);
  });
  it('单分片内部', () => expect(mapToChunks({ start: 5, end: 9 }, 16)).toEqual([{ idx: 0, from: 5, to: 9 }]));
});

describe('clampRange', () => {
  it('500MB 视频单次最多 20 片', () => {
    const r = clampRange({ start: 0, end: 500 * MB - 1 }, 16 * MB, 20);
    expect(r).toEqual({ start: 0, end: 320 * MB - 1 });
  });
  it('不超过时原样返回', () => expect(clampRange({ start: 0, end: 99 }, 16, 20)).toEqual({ start: 0, end: 99 }));
});
