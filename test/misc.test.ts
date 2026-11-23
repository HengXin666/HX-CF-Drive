import { describe, expect, it } from 'vitest';
import { signLink, verifyLink } from '../src/lib/sign';
import { chooseDriver } from '../src/lib/route';
import { splitPath, validName } from '../src/lib/util';
import { chunked } from '../src/services/upload';
import { sliceStream } from '../src/drivers/tg';

describe('签名直链', () => {
  it('正确签名通过, 篡改失败', async () => {
    const q = new URLSearchParams(await signLink('k', 'node1', 0));
    expect(await verifyLink('k', 'node1', 0, q.get('s')!)).toBe(true);
    expect(await verifyLink('k', 'node2', 0, q.get('s')!)).toBe(false);
    expect(await verifyLink('k2', 'node1', 0, q.get('s')!)).toBe(false);
  });
  it('过期失败', async () => {
    const q = new URLSearchParams(await signLink('k', 'n', 1000));
    expect(await verifyLink('k', 'n', 1000, q.get('s')!, 2000)).toBe(false);
    expect(await verifyLink('k', 'n', 1000, q.get('s')!, 500)).toBe(true);
  });
});

describe('路由策略', () => {
  const cfg = { videoTo: 'r2' as const, r2MinBytes: 200 * 1024 * 1024, hasBots: true };
  it('图片走 TG', () => expect(chooseDriver('image/png', 5e6, cfg)).toBe('tg'));
  it('视频走 R2', () => expect(chooseDriver('video/mp4', 5e7, cfg)).toBe('r2'));
  it('大文件走 R2', () => expect(chooseDriver('application/zip', 3e8, cfg)).toBe('r2'));
  it('没有 Bot 全走 R2', () => expect(chooseDriver('image/png', 1, { ...cfg, hasBots: false })).toBe('r2'));
  it('显式指定', () => expect(chooseDriver('video/mp4', 1, cfg, 'tg')).toBe('tg'));
});

describe('路径与文件名', () => {
  it('splitPath', () => expect(splitPath('/a//b%20c/')).toEqual(['a', 'b c']));
  it('非法名', () => {
    expect(validName('a/b')).toBe(false);
    expect(validName('..')).toBe(false);
    expect(validName('图片.png')).toBe(true);
  });
});

function streamOf(parts: number[]): ReadableStream<Uint8Array> {
  let i = 0, v = 0;
  return new ReadableStream({
    pull(ctl) {
      if (i >= parts.length) return ctl.close();
      const a = new Uint8Array(parts[i++]);
      for (let k = 0; k < a.length; k++) a[k] = v++ & 0xff;
      ctl.enqueue(a);
    },
  });
}

describe('流切片', () => {
  it('chunked 按固定大小切', async () => {
    const sizes: number[] = [];
    let total = 0;
    for await (const b of chunked(streamOf([7, 3, 11, 1]), 5)) {
      sizes.push(b.byteLength);
      total += b.byteLength;
    }
    expect(sizes).toEqual([5, 5, 5, 5, 2]);
    expect(total).toBe(22);
  });
  it('sliceStream 裁剪中间段', async () => {
    const out = streamOf([4, 4, 4]).pipeThrough(sliceStream(3, 6));
    const bytes = new Uint8Array(await new Response(out).arrayBuffer());
    expect([...bytes]).toEqual([3, 4, 5, 6, 7, 8]);
  });
});
