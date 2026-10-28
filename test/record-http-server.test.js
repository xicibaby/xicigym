import test from 'node:test';
import assert from 'node:assert/strict';
import { RecordService } from '../src/application/record-service.js';
import { UserScopedRecordService } from '../src/application/user-scoped-record-service.js';
import { InMemoryRecordRepository } from '../src/infrastructure/in-memory-record-repository.js';
import { createRecordHttpServer } from '../src/http/record-http-server.js';

const ts = '2026-10-25T09:00:00+08:00';
const input = { recordId: 'r1', userId: 'mallory', recordType: 'food', inputMethod: 'text', createdAt: ts, updatedAt: ts, payload: { note: 'lunch' }, fieldEvidence: [{ field: 'note', trustLevel: 'user_confirmed', value: 'lunch' }] };
async function withServer(fn) {
  const svc = new UserScopedRecordService(new RecordService(new InMemoryRecordRepository()));
  const server = createRecordHttpServer({ recordService: svc, authenticate: (req) => req.headers['x-test-user'] ? { userId: req.headers['x-test-user'] } : null });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try { await fn(`http://127.0.0.1:${port}`); } finally { await new Promise((resolve, reject) => server.close((e) => e ? reject(e) : resolve())); }
}
const req = (url, user, method = 'GET', body) => fetch(url, { method, headers: { ...(user ? { 'x-test-user': user } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) , ...(body !== undefined ? {} : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });

test('unauthenticated request receives 401', async () => withServer(async (base) => { const r = await req(`${base}/v1/records`, null, 'POST', input); assert.equal(r.status, 401); }));
test('POST creates record under authenticated identity, not body userId', async () => withServer(async (base) => { const r = await req(`${base}/v1/records`, 'alice', 'POST', input); assert.equal(r.status, 201); const j = await r.json(); assert.equal(j.data.userId, 'alice'); }));
test('foreign user cannot read guessed record ID', async () => withServer(async (base) => { await req(`${base}/v1/records`, 'alice', 'POST', input); const r = await req(`${base}/v1/records/r1`, 'bob'); assert.equal(r.status, 404); }));
test('client cannot patch protected ownership/state fields', async () => withServer(async (base) => { await req(`${base}/v1/records`, 'alice', 'POST', input); const r = await req(`${base}/v1/records/r1`, 'alice', 'PATCH', { expectedRevision: 0, patch: { userId: 'bob' } }); assert.equal(r.status, 400); }));
test('invalid expected revision returns 400', async () => withServer(async (base) => { await req(`${base}/v1/records`, 'alice', 'POST', input); const r = await req(`${base}/v1/records/r1`, 'alice', 'PATCH', { expectedRevision: -1, patch: { payload: { note: 'new' } } }); assert.equal(r.status, 400); }));

test('GET /v1/records returns only the authenticated user records with pagination', async () => withServer(async (base) => {
  await req(`${base}/v1/records`, 'alice', 'POST', { ...input, recordId: 'alice-1' });
  await req(`${base}/v1/records`, 'alice', 'POST', { ...input, recordId: 'alice-2', recordType: 'body_checkin', payload: { notes: '精力一般' } });
  await req(`${base}/v1/records`, 'bob', 'POST', { ...input, recordId: 'bob-1' });
  const page = await req(`${base}/v1/records?limit=1&offset=0`, 'alice');
  assert.equal(page.status, 200);
  const json = await page.json();
  assert.equal(json.data.total, 2);
  assert.equal(json.data.items.length, 1);
  assert.ok(json.data.items.every((item) => item.userId === 'alice'));
  const filtered = await req(`${base}/v1/records?recordType=body_checkin`, 'alice');
  const filteredJson = await filtered.json();
  assert.equal(filteredJson.data.total, 1);
  assert.equal(filteredJson.data.items[0].recordType, 'body_checkin');
}));

test('GET /v1/records rejects invalid pagination and filters', async () => withServer(async (base) => {
  assert.equal((await req(`${base}/v1/records?limit=101`, 'alice')).status, 400);
  assert.equal((await req(`${base}/v1/records?recordType=unknown`, 'alice')).status, 400);
}));
