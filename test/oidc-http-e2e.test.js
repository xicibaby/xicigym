import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRecordHttpServer } from '../src/http/record-http-server.js';
import { createOidcBearerAuthenticator } from '../src/http/oidc-bearer-auth.js';
import { RecordService } from '../src/application/record-service.js';
import { UserScopedRecordService } from '../src/application/user-scoped-record-service.js';
import { SqliteRecordRepository } from '../src/infrastructure/sqlite-record-repository.js';

const issuer = 'https://issuer.integration.test/';
const audience = 'health-skill-api';
const nowSeconds = () => Math.floor(Date.now() / 1000);
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicJwk = { ...publicKey.export({ format: 'jwk' }), kid: 'integration-key-1', kty: 'RSA', use: 'sig', alg: 'RS256' };
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
function token(subject, overrides = {}) {
  const header = b64({ alg: 'RS256', typ: 'JWT', kid: 'integration-key-1' });
  const claims = b64({ iss: issuer, aud: audience, sub: subject, iat: nowSeconds(), exp: nowSeconds() + 300, ...overrides });
  const data = `${header}.${claims}`;
  return `${data}.${sign('RSA-SHA256', Buffer.from(data), privateKey).toString('base64url')}`;
}
async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}
async function close(server) {
  if (server?.listening) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
function authHeaders(subject) { return { authorization: `Bearer ${token(subject)}` }; }
async function api(base, subject, path, method = 'GET', body) {
  return fetch(`${base}${path}`, {
    method,
    headers: { ...(subject ? authHeaders(subject) : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

test('end-to-end OIDC -> HTTP API -> SQLite: ownership, confirmation, history and persistence', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'health-skill-e2e-'));
  const dbPath = join(directory, 'records.sqlite');
  const jwksServer = createHttpServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'public, max-age=60' });
    res.end(JSON.stringify({ keys: [publicJwk] }));
  });
  let apiServer;
  let repository;
  try {
    const jwksBase = await listen(jwksServer);
    const authenticate = createOidcBearerAuthenticator({ issuer, audience, jwksUrl: `${jwksBase}/.well-known/jwks.json`, allowHttpForTests: true });
    repository = new SqliteRecordRepository({ filename: dbPath });
    const scopedService = new UserScopedRecordService(new RecordService(repository));
    apiServer = createRecordHttpServer({ recordService: scopedService, authenticate });
    const base = await listen(apiServer);

    const noAuth = await api(base, null, '/v1/records');
    assert.equal(noAuth.status, 401, 'requests without a bearer token must fail closed');
    const badToken = await fetch(`${base}/v1/records`, { headers: { authorization: 'Bearer not.a.valid.token' } });
    assert.equal(badToken.status, 401, 'invalid bearer token must fail closed');

    const draftInput = {
      recordId: 'e2e-food-001', userId: 'attacker-selected-user', recordType: 'food', inputMethod: 'text',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), payload: { mealType: 'lunch', note: '米饭和鸡肉' },
      fieldEvidence: [{ field: 'note', trustLevel: 'user_confirmed', value: '米饭和鸡肉' }],
    };
    const created = await api(base, 'alice', '/v1/records', 'POST', draftInput);
    assert.equal(created.status, 201);
    const createdJson = await created.json();
    assert.equal(createdJson.data.userId, `${issuer}#alice`, 'server-derived identity must override body userId');
    assert.equal(createdJson.data.status, 'draft');

    const bobCannotRead = await api(base, 'bob', '/v1/records/e2e-food-001');
    assert.equal(bobCannotRead.status, 404, 'cross-user record lookup must not reveal record existence');
    const bobList = await api(base, 'bob', '/v1/records');
    assert.equal((await bobList.json()).data.total, 0, 'list query must be scoped to the authenticated subject');

    const confirmed = await api(base, 'alice', '/v1/records/e2e-food-001/confirm', 'POST', { expectedRevision: 0, idempotencyKey: 'e2e-confirm-001' });
    assert.equal(confirmed.status, 200);
    assert.deepEqual((await confirmed.json()).data, { recordId: 'e2e-food-001', status: 'confirmed', revision: 1, replayed: false });
    const replay = await api(base, 'alice', '/v1/records/e2e-food-001/confirm', 'POST', { expectedRevision: 0, idempotencyKey: 'e2e-confirm-001' });
    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).data.replayed, true, 'idempotent retry must be recognized');

    const history = await api(base, 'alice', '/v1/records/e2e-food-001/history');
    assert.equal(history.status, 200);
    const historyJson = await history.json();
    assert.deepEqual(historyJson.data.map((item) => item.revision), [0, 1]);

    const aliceList = await api(base, 'alice', '/v1/records?limit=10&offset=0');
    const aliceListJson = await aliceList.json();
    assert.equal(aliceList.status, 200);
    assert.equal(aliceListJson.data.total, 1);
    assert.equal(aliceListJson.data.items[0].status, 'confirmed');

    await close(apiServer); apiServer = undefined;
    repository.close(); repository = undefined;
    const reopened = new SqliteRecordRepository({ filename: dbPath });
    try {
      const persisted = await reopened.get('e2e-food-001');
      assert.equal(persisted.status, 'confirmed', 'confirmed record must survive database close/reopen');
      assert.equal(persisted.userId, `${issuer}#alice`);
      assert.equal((await reopened.getHistory('e2e-food-001')).length, 2);
    } finally { reopened.close(); }
  } finally {
    await close(apiServer);
    await close(jwksServer);
    repository?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
