import test from 'node:test';
import assert from 'node:assert/strict';
import { RecordService } from '../src/application/record-service.js';
import { UserScopedRecordService } from '../src/application/user-scoped-record-service.js';
import { InMemoryRecordRepository } from '../src/infrastructure/in-memory-record-repository.js';
import { createRecordHttpServer } from '../src/http/record-http-server.js';

async function withServer(options, fn) {
  const recordService = new UserScopedRecordService(new RecordService(new InMemoryRecordRepository()));
  const server = createRecordHttpServer({
    recordService,
    authenticate: (req) => req.headers.authorization === 'Bearer test-token' ? { userId: 'user-1' } : null,
    ...options,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base); } finally { await new Promise((resolve, reject) => server.close((e) => e ? reject(e) : resolve())); }
}
const get = (url, headers = {}) => fetch(url, { headers: { authorization: 'Bearer test-token', ...headers } });

test('security headers are applied to API responses', async () => withServer({}, async (base) => {
  const response = await get(`${base}/v1/records`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(response.headers.get('cache-control'), 'no-store');
}));

test('CORS allows only explicitly configured origins', async () => withServer({ corsOrigins: ['https://app.example.test'] }, async (base) => {
  const allowed = await get(`${base}/v1/records`, { origin: 'https://app.example.test' });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://app.example.test');
  const denied = await get(`${base}/v1/records`, { origin: 'https://evil.example.test' });
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get('access-control-allow-origin'), null);
}));

test('JSON write endpoints reject missing or unsupported content type', async () => withServer({}, async (base) => {
  const response = await fetch(`${base}/v1/records`, { method: 'POST', headers: { authorization: 'Bearer test-token' }, body: '{}' });
  assert.equal(response.status, 415);
  assert.equal((await response.json()).error.code, 'UNSUPPORTED_MEDIA_TYPE');
}));

test('authenticated requests are rate limited and return Retry-After', async () => withServer({ rateLimit: { windowMs: 60_000, maxRequests: 2 } }, async (base) => {
  assert.equal((await get(`${base}/v1/records`)).status, 200);
  assert.equal((await get(`${base}/v1/records`)).status, 200);
  const limited = await get(`${base}/v1/records`);
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) >= 1);
}));
