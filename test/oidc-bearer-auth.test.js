import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createOidcBearerAuthenticator } from '../src/http/oidc-bearer-auth.js';

const issuer = 'https://identity.example.test/';
const audience = 'health-skill-api';
const nowSeconds = Math.floor(Date.now() / 1000);
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicJwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key-1', kty: 'RSA', use: 'sig', alg: 'RS256' };
function b64(value) { return Buffer.from(JSON.stringify(value)).toString('base64url'); }
function token(claimOverrides = {}, headerOverrides = {}) {
  const header = b64({ alg: 'RS256', typ: 'JWT', kid: 'test-key-1', ...headerOverrides });
  const claims = b64({ iss: issuer, aud: audience, sub: 'user-123', iat: nowSeconds, exp: nowSeconds + 300, ...claimOverrides });
  const data = `${header}.${claims}`;
  return `${data}.${sign('RSA-SHA256', Buffer.from(data), privateKey).toString('base64url')}`;
}

async function withJwksServer(run) {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ keys: [publicJwk] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const authenticate = createOidcBearerAuthenticator({ issuer, audience, jwksUrl: `http://127.0.0.1:${port}/jwks`, allowHttpForTests: true });
    await run(authenticate);
  } finally { await new Promise((resolve) => server.close(resolve)); }
}
function req(value) { return { headers: value ? { authorization: `Bearer ${value}` } : {} }; }

test('OIDC verifier accepts a correctly signed token and namespaces subject by issuer', async () => {
  await withJwksServer(async (authenticate) => {
    assert.deepEqual(await authenticate(req(token())), { userId: `${issuer}#user-123`, issuer, subject: 'user-123', audience });
  });
});
test('OIDC verifier rejects missing authorization and malformed token', async () => {
  await withJwksServer(async (authenticate) => {
    assert.equal(await authenticate(req()), null);
    assert.equal(await authenticate(req('not.a.jwt')), null);
  });
});
test('OIDC verifier rejects wrong issuer, audience and expired tokens', async () => {
  await withJwksServer(async (authenticate) => {
    assert.equal(await authenticate(req(token({ iss: 'https://attacker.example/' }))), null);
    assert.equal(await authenticate(req(token({ aud: 'another-api' }))), null);
    assert.equal(await authenticate(req(token({ exp: nowSeconds - 600 }))), null);
  });
});
test('OIDC verifier rejects non-RS256 algorithms even if token has a valid RS256 signature', async () => {
  await withJwksServer(async (authenticate) => {
    assert.equal(await authenticate(req(token({}, { alg: 'none' }))), null);
  });
});
test('OIDC verifier requires HTTPS JWKS outside explicit tests', () => {
  assert.throws(() => createOidcBearerAuthenticator({ issuer, audience, jwksUrl: 'http://identity.example/jwks' }), /HTTPS/);
});
test('OIDC verifier rejects missing subject and invalid not-before claims', async () => {
  await withJwksServer(async (authenticate) => {
    assert.equal(await authenticate(req(token({ sub: '' }))), null);
    assert.equal(await authenticate(req(token({ nbf: nowSeconds + 600 }))), null);
  });
});


test('OIDC verifier throttles forced JWKS refreshes for unknown kid values', async () => {
  let requests = 0;
  const server = createServer((req, res) => {
    requests += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ keys: [publicJwk] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const authenticate = createOidcBearerAuthenticator({
      issuer, audience, jwksUrl: `http://127.0.0.1:${port}/jwks`, allowHttpForTests: true,
      unknownKidRefreshIntervalMs: 30_000,
    });
    assert.equal((await authenticate(req(token()))).subject, 'user-123');
    assert.equal(await authenticate(req(token({}, { kid: 'attacker-kid-a' }))), null);
    assert.equal(await authenticate(req(token({}, { kid: 'attacker-kid-b' }))), null);
    assert.equal(requests, 2, 'initial load + at most one forced refresh');
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('OIDC verifier rejects oversized JWKS responses and forbids redirects', async () => {
  let redirectMode;
  const authenticate = createOidcBearerAuthenticator({
    issuer, audience, jwksUrl: 'https://identity.example.test/jwks',
    fetchImpl: async (_url, options) => {
      redirectMode = options.redirect;
      return new Response('x'.repeat(1024 * 1024 + 1), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  assert.equal(await authenticate(req(token())), null);
  assert.equal(redirectMode, 'error');
});
