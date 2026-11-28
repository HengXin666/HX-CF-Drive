// MCP 核心 (#22): JSON-RPC 分发与工具到 REST 的翻译
import { describe, expect, it } from 'vitest';
import { type Call, handleMcp, MCP_UPLOAD_MAX } from '../src/lib/mcpcore';

const calls: unknown[][] = [];
const call: Call = async (method, path, body, raw) => {
  calls.push([method, path, body, raw && { len: raw.data.length, mime: raw.mime }]);
  if (path.startsWith('/fs/search')) return { status: 429, body: { error: 'search rate limited' } };
  return { status: 200, body: { ok: true } };
};
const rpc = (method: string, params?: unknown, id: number | undefined = 1) => handleMcp({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, params }, call) as Promise<Record<string, any>>;

describe('MCP', () => {
  it('initialize 协商版本', async () => {
    expect((await rpc('initialize', { protocolVersion: '2025-03-26' })).result.protocolVersion).toBe('2025-03-26');
    expect((await rpc('initialize', { protocolVersion: '1999-01-01' })).result.protocolVersion).toBe('2025-06-18');
  });
  it('通知不回复, 未知方法 -32601', async () => {
    expect(await rpc('notifications/initialized', undefined, undefined)).toBeNull();
    expect((await rpc('foo')).error.code).toBe(-32601);
    expect((await handleMcp({ id: 1, method: 'x' }, call) as any).error.code).toBe(-32600);
  });
  it('tools/list 不泄露实现', async () => {
    const tools = (await rpc('tools/list')).result.tools;
    expect(tools.map((t: any) => t.name)).toEqual(['list', 'stat', 'search', 'upload', 'link', 'share']);
    expect(tools.every((t: any) => t.inputSchema && !('run' in t))).toBe(true);
  });
  it('工具翻译成 REST 调用', async () => {
    calls.length = 0;
    await rpc('tools/call', { name: 'list', arguments: { path: '/a b' } });
    await rpc('tools/call', { name: 'upload', arguments: { dir: '/x', name: 'a.txt', text: '你好' } });
    await rpc('tools/call', { name: 'upload', arguments: { name: 'b.bin', base64: 'AAEC', mime: 'application/x-test' } });
    await rpc('tools/call', { name: 'link', arguments: { id: 'n1' } });
    expect(calls).toEqual([
      ['GET', '/fs/list?path=%2Fa+b', undefined, undefined],
      ['POST', '/upload?path=%2Fx&name=a.txt', undefined, { len: 6, mime: 'text/plain; charset=utf-8' }],
      ['POST', '/upload?path=%2F&name=b.bin', undefined, { len: 3, mime: 'application/x-test' }],
      ['POST', '/fs/link', { id: 'n1', path: undefined, expiresIn: 0 }, undefined],
    ]);
  });
  it('接口出错时 isError, 超大上传直接拒绝', async () => {
    const r = await rpc('tools/call', { name: 'search', arguments: { q: 'a' } });
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toContain('429');
    const big = await rpc('tools/call', { name: 'upload', arguments: { name: 'x', text: 'a'.repeat(MCP_UPLOAD_MAX + 1) } });
    expect(big.result.isError).toBe(true);
    expect((await rpc('tools/call', { name: 'nope' })).error.code).toBe(-32602);
  });
  it('批量请求只回有 id 的', async () => {
    const out = await handleMcp([{ jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', id: 7, method: 'ping' }], call) as any[];
    expect(out).toEqual([{ jsonrpc: '2.0', id: 7, result: {} }]);
  });
});
