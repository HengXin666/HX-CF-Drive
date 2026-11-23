import { describe, expect, it } from 'vitest';
import { openJson, sealJson, signLink, verifyLink } from '../src/lib/sign';
import { splitPath, validName } from '../src/lib/util';
import { chunkCountOf, expectedChunkSize, takeBytes } from '../src/services/upload';
import { multipartFrame, sliceStream } from '../src/drivers/tg';
import { fitBudget } from '../src/services/serve';

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

describe('上传凭证与回执', () => {
  it('签名对象可解出, 篡改或换用途失败', async () => {
    const s = await sealJson('k', 'up', { a: 1, n: '图片.png' });
    expect(await openJson('k', 'up', s)).toEqual({ a: 1, n: '图片.png' });
    expect(await openJson('k', 'rc', s)).toBeNull();
    expect(await openJson('k2', 'up', s)).toBeNull();
    expect(await openJson('k', 'up', 'x' + s)).toBeNull();
  });
  it('分片数与末片大小', () => {
    expect(chunkCountOf(10, 4)).toBe(3);
    expect(expectedChunkSize(10, 4, 2)).toBe(2);
    expect(expectedChunkSize(8, 4, 1)).toBe(4);
  });
});

describe('子请求预算', () => {
  const C = 10;
  it('冷分片每片 2 次', () => expect(fitBudget({ start: 0, end: 99 }, C, 6, () => false)).toEqual({ start: 0, end: 29 }));
  it('热分片每片 1 次', () => expect(fitBudget({ start: 0, end: 99 }, C, 6, () => true)).toEqual({ start: 0, end: 59 }));
  it('从中间开始, 末片不完整', () => expect(fitBudget({ start: 15, end: 33 }, C, 48, () => false)).toEqual({ start: 15, end: 33 }));
});

describe('multipart 帧', () => {
  it('拼上内容后能被标准解析器读出', async () => {
    const { head, tail } = multipartFrame('bb', { chat_id: '-100', x: 'y' }, 'a.bin');
    const data = new Uint8Array([1, 2, 3, 13, 10]);
    const body = new Uint8Array([...head, ...data, ...tail]);
    const fd = await new Request('http://x', { method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=bb' }, body }).formData();
    expect(fd.get('chat_id')).toBe('-100');
    const f = fd.get('document') as unknown as File;
    expect([...new Uint8Array(await f.arrayBuffer())]).toEqual([1, 2, 3, 13, 10]);
  });
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
  it('takeBytes 按固定大小切成子流, 不丢字节', async () => {
    const reader = streamOf([7, 3, 11, 1]).getReader();
    const carry = { buf: null as Uint8Array | null };
    const out: number[][] = [];
    for (let i = 0; i < chunkCountOf(22, 5); i++) {
      const sub = takeBytes(reader, carry, expectedChunkSize(22, 5, i));
      out.push([...new Uint8Array(await new Response(sub).arrayBuffer())]);
    }
    expect(out.map((x) => x.length)).toEqual([5, 5, 5, 5, 2]);
    expect(out.flat()).toEqual([...Array(22).keys()]);
  });
  it('sliceStream 裁剪中间段', async () => {
    const out = streamOf([4, 4, 4]).pipeThrough(sliceStream(3, 6));
    const bytes = new Uint8Array(await new Response(out).arrayBuffer());
    expect([...bytes]).toEqual([3, 4, 5, 6, 7, 8]);
  });
});
