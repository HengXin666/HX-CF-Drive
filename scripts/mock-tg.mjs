// 本地测试用的 Telegram Bot API 模拟服务器: node scripts/mock-tg.mjs [port]
// 支持 getMe sendDocument getFile getChat getChatMember deleteMessage forwardMessage 和 /file 下载 (含 Range)
// 环境变量 MOCK_429_EVERY=N: 每 N 次 sendDocument 返回一次 429
import http from 'node:http';

const port = Number(process.argv[2] ?? 8787 + 100);
const files = new Map(); // fileKey -> Buffer
const messages = new Map(); // `${chat}:${id}` -> fileKey
let msgSeq = 1, sendCount = 0;
const every429 = Number(process.env.MOCK_429_EVERY ?? 0);

const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
const ok = (res, result) => json(res, 200, { ok: true, result });

async function readBody(req) { const parts = []; for await (const p of req) parts.push(p); return Buffer.concat(parts); }

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const m = /^\/bot(\d+):([^/]+)\/(\w+)$/.exec(url.pathname);
  const f = /^\/file\/bot(\d+):[^/]+\/(.+)$/.exec(url.pathname);
  if (f) {
    const [, botId, path] = f;
    const [owner, key] = path.split('/');
    const buf = files.get(key);
    if (!buf || owner !== botId) return json(res, 404, { ok: false });
    const r = /bytes=(\d+)-(\d+)/.exec(req.headers.range ?? '');
    if (r) {
      const a = Number(r[1]), b = Math.min(Number(r[2]), buf.length - 1);
      res.writeHead(206, { 'Content-Range': `bytes ${a}-${b}/${buf.length}`, 'Content-Length': b - a + 1 });
      return res.end(buf.subarray(a, b + 1));
    }
    res.writeHead(200, { 'Content-Length': buf.length });
    return res.end(buf);
  }
  if (!m) return json(res, 404, { ok: false, error_code: 404, description: 'Not Found' });
  const [, botId, method] = m;
  const raw = await readBody(req);
  const ct = req.headers['content-type'] ?? '';
  let params = {};
  let doc = null;
  if (ct.startsWith('multipart/form-data')) {
    const fd = await new Request('http://x', { method: 'POST', headers: { 'content-type': ct }, body: raw }).formData();
    for (const [k, v] of fd.entries()) {
      if (typeof v === 'string') params[k] = v; else doc = Buffer.from(await v.arrayBuffer());
    }
  } else if (raw.length) params = JSON.parse(raw.toString());

  switch (method) {
    case 'getMe': return ok(res, { id: Number(botId), is_bot: true, username: `mock${botId}_bot` });
    case 'getChat': return ok(res, { id: Number(params.chat_id), type: 'channel', title: 'mock channel' });
    case 'getChatMember': return ok(res, { status: 'administrator', can_post_messages: true, can_delete_messages: true });
    case 'sendDocument': {
      sendCount++;
      if (every429 && sendCount % every429 === 0) return json(res, 429, { ok: false, error_code: 429, description: 'Too Many Requests: retry after 1', parameters: { retry_after: 1 } });
      if (!doc) return json(res, 400, { ok: false, error_code: 400, description: 'no document' });
      if (doc.length > 50 * 1024 * 1024) return json(res, 413, { ok: false, error_code: 413, description: 'Request Entity Too Large' });
      const key = `k${msgSeq}`;
      files.set(key, doc);
      const id = msgSeq++;
      messages.set(`${params.chat_id}:${id}`, key);
      return ok(res, { message_id: id, document: { file_id: `${botId}_${key}`, file_size: doc.length } });
    }
    case 'forwardMessage': {
      const key = messages.get(`${params.from_chat_id}:${params.message_id}`);
      if (!key) return json(res, 400, { ok: false, error_code: 400, description: 'message not found' });
      const id = msgSeq++;
      messages.set(`${params.chat_id}:${id}`, key);
      return ok(res, { message_id: id, document: { file_id: `${botId}_${key}` } });
    }
    case 'getFile': {
      const [owner, key] = String(params.file_id).split('_');
      if (owner !== botId || !files.has(key)) return json(res, 400, { ok: false, error_code: 400, description: 'Bad Request: invalid file_id' });
      if (files.get(key).length > 20 * 1024 * 1024) return json(res, 400, { ok: false, error_code: 400, description: 'Bad Request: file is too big' });
      return ok(res, { file_id: params.file_id, file_path: `${botId}/${key}` });
    }
    case 'deleteMessage': {
      messages.delete(`${params.chat_id}:${params.message_id}`);
      return ok(res, true);
    }
    default: return json(res, 400, { ok: false, error_code: 400, description: `mock: ${method} not implemented` });
  }
}).listen(port, () => console.log(`mock telegram on :${port}`));
