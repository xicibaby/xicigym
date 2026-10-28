import test from 'node:test';
import assert from 'node:assert/strict';
import { createProbeEndpoints } from '../src/http/probe-endpoints.js';
import { createMetricsRegistry } from '../src/observability/metrics.js';
import { createRecordHttpServer } from '../src/http/record-http-server.js';
import { createSecurityPolicy } from '../src/http/security.js';
import { RecordService } from '../src/application/record-service.js';
import { UserScopedRecordService } from '../src/application/user-scoped-record-service.js';
import { InMemoryRecordRepository } from '../src/infrastructure/in-memory-record-repository.js';

async function withServer(options, fn) {
  const metrics = createMetricsRegistry();
  const probes = createProbeEndpoints({
    readinessCheck: options.readinessCheck ?? (async () => ({ ready: true, backend: 'memory', schemaVersion: 1 })),
    metrics,
    version: '9.9.9',
    readinessTimeoutMs: options.readinessTimeoutMs ?? 2_000,
  });
  const recordService = new UserScopedRecordService(new RecordService(new InMemoryRecordRepository()));
  const server = createRecordHttpServer({
    recordService,
    authenticate: (req) => req.headers['x-test-user'] ? { userId: req.headers['x-test-user'] } : null,
    securityPolicy: createSecurityPolicy({ corsOrigins: [], rateLimit: { windowMs: 60_000, maxRequests: 1_000 } }),
    metrics,
    probeEndpoints: probes,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base, metrics, probes); }
  finally { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}

test('/healthz is unauthenticated, does not touch the database and reports version', async () => {
  let readinessCalls = 0;
  await withServer({ readinessCheck: async () => { readinessCalls += 1; return { ready: true, backend: 'memory', schemaVersion: 1 }; } }, async (base) => {
    const response = await fetch(`${base}/healthz`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.version, '9.9.9');
    assert.ok(Number.isInteger(body.uptimeSeconds));
    assert.equal(readinessCalls, 0, '/healthz must not run the dependency check');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  });
});

test('/readyz reports ready and exposes backend/schema version', async () => {
  await withServer({}, async (base) => {
    const response = await fetch(`${base}/readyz`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, 'ready');
    assert.equal(body.ready, true);
    assert.equal(body.backend, 'memory');
    assert.equal(body.schemaVersion, 1);
    assert.ok(typeof body.checkedAt === 'string');
  });
});

test('/readyz returns 503 when the dependency is not ready or throws', async () => {
  await withServer({ readinessCheck: async () => ({ ready: false, backend: 'postgres', error: 'postgres_unavailable' }) }, async (base) => {
    const response = await fetch(`${base}/readyz`);
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.status, 'not_ready');
    assert.equal(body.error, 'postgres_unavailable');
  });
  await withServer({ readinessCheck: async () => { const error = new Error('postgres://user:secret@db/prod'); throw error; } }, async (base) => {
    const response = await fetch(`${base}/readyz`);
    assert.equal(response.status, 503);
    const text = await response.text();
    assert.equal(JSON.parse(text).error, 'readiness_check_failed');
    assert.ok(!text.includes('secret'), 'readiness failures must not leak connection strings');
  });
});

test('/readyz enforces the readiness timeout instead of hanging', async () => {
  await withServer({ readinessCheck: () => new Promise(() => {}), readinessTimeoutMs: 150 }, async (base) => {
    const startedAt = Date.now();
    const response = await fetch(`${base}/readyz`);
    const elapsedMs = Date.now() - startedAt;
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error, 'readiness_timeout');
    assert.ok(elapsedMs < 2_000, `readiness probe took too long: ${elapsedMs}ms`);
  });
});

test('/metrics exposes counters, readiness gauge and no record content', async () => {
  await withServer({}, async (base) => {
    const unauthorized = await fetch(`${base}/v1/records`, { headers: { 'x-test-user': 'alice', 'content-type': 'application/json' }, method: 'POST', body: JSON.stringify({}) });
    assert.equal(unauthorized.status, 422);
    await fetch(`${base}/healthz`);
    const response = await fetch(`${base}/metrics`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/plain; version=0\.0\.4/);
    const text = await response.text();
    assert.match(text, /# TYPE health_skill_http_requests_total counter/);
    assert.match(text, /health_skill_http_requests_total\{method="GET",status="200"\} \d+/);
    assert.match(text, /health_skill_http_requests_total\{method="POST",status="422"\} 1/);
    assert.match(text, /health_skill_http_in_flight_requests \d+/);
    assert.match(text, /health_skill_ready 0/);
    assert.match(text, /health_skill_uptime_seconds \d+/);
    assert.ok(!/alice|payload|token|password/i.test(text), 'metrics must not leak request content or identifiers');
  });
});

test('probe endpoints reject unsupported methods and keep unknown paths 404', async () => {
  await withServer({}, async (base) => {
    const post = await fetch(`${base}/readyz`, { method: 'POST' });
    assert.equal(post.status, 405);
    assert.equal(post.headers.get('allow'), 'GET, HEAD');
    assert.equal((await fetch(`${base}/unknown`)).status, 404);
    const head = await fetch(`${base}/healthz`, { method: 'HEAD' });
    assert.equal(head.status, 200);
  });
});

test('readiness failures surface in the metrics readiness gauge', async () => {
  let readiness = { ready: true, backend: 'memory', schemaVersion: 1 };
  await withServer({ readinessCheck: async () => readiness }, async (base, metrics) => {
    await fetch(`${base}/readyz`);
    assert.equal(metrics.snapshot().health_skill_ready, 1);
    readiness = { ready: false, backend: 'memory', error: 'memory_unavailable' };
    await fetch(`${base}/readyz`);
    assert.equal(metrics.snapshot().health_skill_ready, 0);
  });
});
