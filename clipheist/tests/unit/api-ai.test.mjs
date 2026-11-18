import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const handler = require('../../api/ai.js');

function res() {
  const r = { code: 0, body: null, headers: {} };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.end = () => r;
  r.setHeader = (k, v) => { r.headers[k] = v; };
  return r;
}

test('returns 501 when no API key is configured (Studio falls back to on-device copy)', async () => {
  delete process.env.ANTHROPIC_API_KEY;
  const r = res();
  await handler({ method: 'POST', headers: {}, body: {} }, r);
  assert.equal(r.code, 501);
});

test('rejects non-POST methods and invalid image data', async () => {
  process.env.ANTHROPIC_API_KEY = 'test';
  let r = res(); await handler({ method: 'GET', headers: {} }, r); assert.equal(r.code, 405);
  r = res(); await handler({ method: 'POST', headers: {}, body: { images: ['<script>'] } }, r); assert.equal(r.code, 400);
});

test('enforces ALLOWED_ORIGIN when set', async () => {
  process.env.ANTHROPIC_API_KEY = 'test';
  process.env.ALLOWED_ORIGIN = 'https://good.example';
  const r = res();
  await handler({ method: 'POST', headers: { origin: 'https://evil.example' }, body: {} }, r);
  assert.equal(r.code, 403);
  delete process.env.ALLOWED_ORIGIN;
});

test('calls the Messages API server-side and sanitizes the JSON reply', async () => {
  process.env.ANTHROPIC_API_KEY = 'secret-key';
  let sent;
  globalThis.fetch = async (url, opts) => {
    sent = { url, headers: opts.headers, body: JSON.parse(opts.body) };
    return { ok: true, json: async () => ({ content: [{ type: 'text', text: 'Here: {"title":"Chase went sideways","description":"Five cars, one bike.","hashtags":["#Gaming","open world"],"hook_caption":"WAIT FOR IT","clip_captions":["x","nice"]}' }] }) };
  };
  const r = res();
  await handler({ method: 'POST', headers: {}, body: { style: 'hype', vertical: true, clips: [{ start: 0, end: 3, reasons: ['Fast action'] }, { start: 5, end: 8, reasons: ['Impact spike'] }], images: ['QUJD'] } }, r);
  assert.equal(r.code, 200);
  assert.equal(sent.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(sent.headers['x-api-key'], 'secret-key');
  assert.deepEqual(sent.body.messages[0].content.map((c) => c.type), ['image', 'text']);
  assert.deepEqual(r.body.hashtags, ['gaming', 'openworld']);
  assert.deepEqual(r.body.clip_captions, ['', 'nice'], 'first clip caption cleared when a hook exists');
  assert.equal(JSON.stringify(r.body).includes('secret-key'), false, 'key never echoed');
});

test('maps upstream failures to 502', async () => {
  process.env.ANTHROPIC_API_KEY = 'k';
  globalThis.fetch = async () => ({ ok: false, status: 529, text: async () => 'overloaded' });
  const r = res();
  await handler({ method: 'POST', headers: {}, body: { clips: [], images: [] } }, r);
  assert.equal(r.code, 502);
});
