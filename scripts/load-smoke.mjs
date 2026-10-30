/**
 * Load smoke evidence for the HTTP record API (step 26).
 *
 * Measures the HTTP + PostgreSQL path under a small concurrency burst, checks that no 5xx
 * appear, records latency percentiles, and verifies the per-user rate limiter returns 429
 * with Retry-After. This is a smoke test, not a capacity/soak test.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { PostgresRecordRepository } from '../src/infrastructure/postgres-record-repository.js';
import { applyPostgresMigrations } from '../src/infrastructure/postgres-migrations.js';
import { RecordService } from '../src/application/record-service.js';
import { UserScopedRecordService } from '../src/application/user-scoped-record-service.js';
import { createRecordHttpServer } from '../src/http/record-http-server.js';
import { createSecurityPolicy } from '../src/http/security.js';
import { validateDisposablePostgresTestUrl } from '../src/infrastructure/postgres-test-safety.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const artifactsDir = join(root, 'artifacts', 'step26');
const drillUrl = process.env.POSTGRES_DRILL_URL || process.env.POSTGRES_TEST_URL;
const safetyError = validateDisposablePostgresTestUrl(drillUrl, { allowNonDisposable: process.env.POSTGRES_TEST_ALLOW_NON_DISPOSABLE === '1' });
if (safetyError) { console.error(`REFUSED: ${safetyError}`); process.exitCode = 2; process.exit(); }

const checks = [];
const record = (name, ok, detail = '') => { checks.push({ name, ok: Boolean(ok), detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };
const percentile = (sorted, p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))] : null;

const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const pool = new Pool({ connectionString: drillUrl, max: 10, connectionTimeoutMillis: 5_000, idleTimeoutMillis: 10_000 });
await applyPostgresMigrations(pool);
const repository = new PostgresRecordRepository({ pool });
const service = new UserScopedRecordService(new RecordService(repository));
const auth = (req) => (req.headers['x-test-user'] ? { userId: String(req.headers['x-test-user']) } : null);
const securityPolicy = createSecurityPolicy({ corsOrigins: [], rateLimit: { windowMs: 60_000, maxRequests: 10_000 } });
const server = createRecordHttpServer({ recordService: service, authenticate: auth, securityPolicy, metrics: null });
await new Promise((listenResolve) => server.listen(0, '127.0.0.1', listenResolve));
const base = `http://127.0.0.1:${server.address().port}`;

try {
  // warmup
  for (let index = 0; index < 5; index += 1) await fetch(`${base}/v1/records`, { headers: { 'x-test-user': `load-${runId}` } });

  const total = 200;
  const concurrency = 20;
  const latencies = [];
  const statuses = new Map();
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < total) {
      const index = nextIndex;
      nextIndex += 1;
      const started = process.hrtime.bigint();
      let status = 0;
      try {
        if (index % 10 < 7) {
          const response = await fetch(`${base}/v1/records?limit=10`, { headers: { 'x-test-user': `load-${runId}` } });
          status = response.status;
          await response.arrayBuffer();
        } else {
          const body = {
            recordId: `load-${runId}-${index}`, recordType: 'food', inputMethod: 'text',
            createdAt: '2026-10-28T12:00:00+08:00', updatedAt: '2026-10-28T12:00:00+08:00',
            payload: { mealType: 'snack', note: 'load smoke' },
            fieldEvidence: [{ field: 'payload.note', trustLevel: 'user_confirmed' }],
          };
          const response = await fetch(`${base}/v1/records`, { method: 'POST', headers: { 'x-test-user': `load-${runId}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
          status = response.status;
          await response.arrayBuffer();
        }
      } catch { status = 0; }
      latencies.push(Number(process.hrtime.bigint() - started) / 1e6);
      statuses.set(status, (statuses.get(status) ?? 0) + 1);
    }
  }
  const startedAt = Date.now();
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  const durationMs = Date.now() - startedAt;
  const sorted = [...latencies].sort((a, b) => a - b);
  const serverErrors = [...statuses.entries()].filter(([status]) => status >= 500).reduce((sum, [, count]) => sum + count, 0);
  const failures = statuses.get(0) ?? 0;
  const successes = [...statuses.entries()].filter(([status]) => status >= 200 && status < 400).reduce((sum, [, count]) => sum + count, 0);
  const stats = {
    total, concurrency, durationMs,
    requestsPerSecond: Number((total / (durationMs / 1000)).toFixed(1)),
    statuses: Object.fromEntries([...statuses.entries()].sort((a, b) => a[0] - b[0])),
    latencyMs: { p50: percentile(sorted, 50), p90: percentile(sorted, 90), p95: percentile(sorted, 95), p99: percentile(sorted, 99), max: sorted.at(-1) },
  };
  record('load:no-server-errors', serverErrors === 0, `5xx=${serverErrors}`);
  record('load:no-transport-failures', failures === 0, `failed=${failures}`);
  record('load:all-requests-ok', successes === total, `${successes}/${total} in ${durationMs}ms (${stats.requestsPerSecond} rps)`);
  record('load:p95-budget', stats.latencyMs.p95 !== null && stats.latencyMs.p95 < 500, `p50=${stats.latencyMs.p50?.toFixed(1)}ms p95=${stats.latencyMs.p95?.toFixed(1)}ms p99=${stats.latencyMs.p99?.toFixed(1)}ms`);

  // Rate limiter behavior under its own low limit.
  const limitedPolicy = createSecurityPolicy({ corsOrigins: [], rateLimit: { windowMs: 60_000, maxRequests: 5 } });
  const limitedServer = createRecordHttpServer({ recordService: service, authenticate: auth, securityPolicy: limitedPolicy, metrics: null });
  await new Promise((listenResolve) => limitedServer.listen(0, '127.0.0.1', listenResolve));
  const limitedBase = `http://127.0.0.1:${limitedServer.address().port}`;
  try {
    let firstLimited = null;
    for (let index = 0; index < 8; index += 1) {
      const response = await fetch(`${limitedBase}/v1/records`, { headers: { 'x-test-user': `limit-${runId}` } });
      await response.arrayBuffer();
      if (response.status === 429 && firstLimited === null) firstLimited = response.headers.get('retry-after');
    }
    record('rate-limit:429-with-retry-after', firstLimited !== null && Number(firstLimited) >= 1, `retry-after=${firstLimited}s`);
  } finally {
    await new Promise((closeResolve) => limitedServer.close(closeResolve));
  }

  await pool.query('DELETE FROM records WHERE user_id = $1', [`load-${runId}`]);

  const evidence = {
    schemaVersion: 1,
    kind: 'load-smoke',
    generatedAt: new Date().toISOString(),
    allChecksPassed: checks.every((check) => check.ok),
    checks,
    load: stats,
    environment: { nodeVersion: process.version, postgresUrlIsDisposable: true, note: 'HTTP + 真实 PostgreSQL；OIDC 鉴权适配器在冒烟中替换为测试主体，其余中间件与生产一致。' },
    limitations: [
      '这是一次轻量冒烟（200 请求 / 并发 20），不是容量压测或长时间浸泡测试。',
      '单机单进程、无网关限流与网络延迟模拟；生产容量需在 staging 做正式压测。',
    ],
  };
  await mkdir(artifactsDir, { recursive: true });
  await writeFile(join(artifactsDir, 'LOAD_SMOKE_EVIDENCE.json'), JSON.stringify(evidence, null, 2) + '\n', 'utf8');
  console.log(evidence.allChecksPassed ? 'LOAD SMOKE: ALL CHECKS PASSED' : 'LOAD SMOKE: FAILED');
  if (!evidence.allChecksPassed) process.exitCode = 1;
} finally {
  await new Promise((closeResolve) => server.close(closeResolve));
  await pool.end().catch(() => {});
}
