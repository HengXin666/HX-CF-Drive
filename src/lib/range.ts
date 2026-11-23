/** HTTP Range 解析与分片映射 (纯函数, 便于单测)  */

export interface ByteRange { start: number; end: number } // 闭区间

/** 解析单段 Range 头; 不支持多段。返回 null 表示无 Range; 抛 'unsatisfiable' 表示越界 */
export function parseRange(header: string | null, size: number): ByteRange | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, a, b] = m;
  let start: number, end: number;
  if (a === '' && b === '') return null;
  if (a === '') {
    const suffix = Number(b);
    if (suffix === 0) throw new Error('unsatisfiable');
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(a);
    end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
  }
  if (start >= size || start > end) throw new Error('unsatisfiable');
  return { start, end };
}

export interface ChunkSlice { idx: number; from: number; to: number } // 分片内闭区间

/** 把字节区间映射到分片区间 */
export function mapToChunks(r: ByteRange, chunkSize: number): ChunkSlice[] {
  const out: ChunkSlice[] = [];
  const first = Math.floor(r.start / chunkSize);
  const last = Math.floor(r.end / chunkSize);
  for (let i = first; i <= last; i++) {
    const base = i * chunkSize;
    out.push({
      idx: i,
      from: Math.max(r.start, base) - base,
      to: Math.min(r.end, base + chunkSize - 1) - base,
    });
  }
  return out;
}

/** 限制单次响应的分片数量; 返回截断后的区间 */
export function clampRange(r: ByteRange, chunkSize: number, maxChunks: number): ByteRange {
  const first = Math.floor(r.start / chunkSize);
  const lastAllowed = first + maxChunks - 1;
  const maxEnd = (lastAllowed + 1) * chunkSize - 1;
  return { start: r.start, end: Math.min(r.end, maxEnd) };
}
