/**
 * Step 23 evidence harness: runtime lifecycle, probes and metrics on a real runtime.
 *
 * Checks (all asserted, non-zero exit on any failure):
 *   SQLite backend
 *     1. /healthz answers without authentication and without touching the database
 *     2. /readyz reports ready with backend+schema version
 *     3. unauthenticated record request still fails closed (401)
 *     4. /metrics exposes request counters, in-flight gauge and readiness gauge, with no PII
 *     5. HEAD probe is supported; unknown path stays 404
 *     6. graceful shutdown resolves, closes the listener, is idempotent, resources released
 *   PostgreSQL backend
 *     7. /readyz reports ready against a real PostgreSQL 16 instance
 *     8. simulated database outage: /readyz returns 503 while /healthz stays 200
 *     9. /metrics readiness gauge drops to 0 during the outage
 *    10. shutdown still completes after the pool was already closed
 *
 * Required env: POSTGRES_DRILL_URL (disposable database whose name contains test/temp/sandbox/ci).
 * Optional env: STEP23_ARTIFACTS_DIR, POSTGRES_DRILL_ALLOW_MIGRATE (default true).
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startServer } from '../src/server.js';
import { APP_VERSION } from '../src/version.js';
import { validateDisposablePostgresTestUrl } from '../src/infrastructure/postgres-test-safety.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const artifactsDir = resolve(process.env.STEP23_ARTIFACTS_DIR || join(root, 'artifacts', 'step23'));
const sqliteDir = join(artifactsDir, 'sqlite');
const sqlitePath = join(sqliteDir, 'health-records.sqlite');

const drillUrl = process.env.POSTGRES_DRILL_URL || process.env.POSTGRES_TEST_URL;
const safetyError = validateDisposablePostgresTestUrl(drillUrl);
if (safetyError) {
  console.error(`REFUSED: ${safetyError}`);
  process.exitCode = 2;
  process.exit();
}

const checks = [];
const quietLogger = { info() {}, error() {} };
function record(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
}
async function freePort() {
  return await new Promise((resolvePort, rejectPort) => {
    const probe = createServer();
    probe.unref();
    probe.on('error', rejectPort);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolvePort(port));
    });
  });
}
async function waitFor(predicate, { timeoutMs = 5_000, intervalMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolveWait) => setTimeout(resolveWait, intervalMs));
  }
  return false;
}
const get = (url) => fetch(url);
const envBase = {
  NODE_ENV: 'test',
  OIDC_ISSUER: 'https://127.0.0.1:9/oidc',
  OIDC_AUDIENCE: 'health-skill-record-api',
  OIDC_JWKS_URL: 'https://127.0.0.1:9/oidc/jwks.json',
  CORS_ORIGINS: 'http://localhost:5173',
  HOST: '127.0.0.1',
  RATE_LIMIT_MAX_REQUESTS: '1000',
};

async function run() {
  await mkdir(artifactsDir, { recursive: true });
  await mkdir(sqliteDir, { recursive: true });
  for (const suffix of ['', '-wal', '-shm']) await rm(sqlitePath + suffix, { force: true });
  const startedAt = new Date().toISOString();

  // ---------- A. SQLite backend runtime ----------
  const sqlitePort = await freePort();
  const sqliteEnv = { ...envBase, DATABASE_BACKEND: 'sqlite', DATABASE_PATH: sqlitePath, PORT: String(sqlitePort) };
  const sqliteApp = await startServer({ env: sqliteEnv, logger: quietLogger });
  const base = `http://127.0.0.1:${sqlitePort}`;
  const started = await waitFor(() => sqliteApp.server.listening === true);
  record('runtime-sqlite-listening', started === true, `port=${sqlitePort}, version=${sqliteApp.version}`);

  const health = await get(`${base}/healthz`);
  const healthBody = await health.json();
  record('healthz-liveness', health.status === 200 && healthBody.status === 'ok' && healthBody.version === APP_VERSION,
    `status=${health.status} version=${healthBody.version} uptime=${healthBody.uptimeSeconds}s`);

  const ready = await get(`${base}/readyz`);
  const readyBody = await ready.json();
  record('readyz-sqlite-ready', ready.status === 200 && readyBody.ready === true && readyBody.backend === 'sqlite' && readyBody.schemaVersion === 1,
    `backend=${readyBody.backend} schemaVersion=${readyBody.schemaVersion} latencyMs=${readyBody.latencyMs}`);

  const unauth = await fetch(`${base}/v1/records`);
  record('record-api-still-fails-closed', unauth.status === 401, `status=${unauth.status}`);

  const head = await fetch(`${base}/healthz`, { method: 'HEAD' });
  const notFound = await fetch(`${base}/not-a-probe`);
  record('probe-head-and-404', head.status === 200 && notFound.status === 404, `head=${head.status} unknown=${notFound.status}`);

  const metricsResponse = await get(`${base}/metrics`);
  const metricsText = await metricsResponse.text();
  const hasCounters = /health_skill_http_requests_total\{method="GET",status="200"\} \d+/.test(metricsText);
  const hasInFlight = /health_skill_http_in_flight_requests \d+/.test(metricsText);
  const hasReadyGauge = /health_skill_ready 1/.test(metricsText);
  const hasUptime = /health_skill_uptime_seconds \d+/.test(metricsText);
  const leaks = /(?:postgres(?:ql)?:\/\/)|password|secret|alice|payload/i.test(metricsText);
  record('metrics-exposition', metricsResponse.status === 200 && hasCounters && hasInFlight && hasReadyGauge && hasUptime && !leaks,
    `contentType=${metricsResponse.headers.get('content-type')} counters=${hasCounters} inFlight=${hasInFlight} readyGauge=${hasReadyGauge} leaks=${leaks}`);

  const firstShutdown = sqliteApp.shutdown();
  const secondShutdown = sqliteApp.shutdown();
  const sqliteShutdown = await firstShutdown;
  const shutdownIdempotent = firstShutdown === secondShutdown;
  const listenerClosed = await waitFor(() => sqliteApp.server.listening === false);
  const closedRejects = await (async () => { try { await fetch(`${base}/healthz`); return false; } catch { return true; } })();
  record('graceful-shutdown-sqlite',
    shutdownIdempotent && sqliteShutdown.closed === true && sqliteShutdown.timedOut === false && listenerClosed && closedRejects && sqliteShutdown.resourceCloseFailures.length === 0,
    `closed=${sqliteShutdown.closed} timedOut=${sqliteShutdown.timedOut} durationMs=${sqliteShutdown.durationMs} idempotent=${shutdownIdempotent}`);

  // ---------- B. PostgreSQL backend runtime ----------
  const pgPort = await freePort();
  const pgEnv = { ...envBase, DATABASE_BACKEND: 'postgres', POSTGRES_URL: drillUrl, POSTGRES_SSL: 'false', POSTGRES_AUTO_MIGRATE: process.env.POSTGRES_DRILL_ALLOW_MIGRATE === 'false' ? 'false' : 'true', PORT: String(pgPort) };
  const pgApp = await startServer({ env: pgEnv, logger: quietLogger });
  const pgBase = `http://127.0.0.1:${pgPort}`;
  await waitFor(() => pgApp.server.listening === true);

  const versionResult = await pgApp.repository.pool.query('SELECT version()');
  const targetPostgresVersion = String(versionResult.rows[0].version).split(',')[0];

  const pgReady = await get(`${pgBase}/readyz`);
  const pgReadyBody = await pgReady.json();
  record('readyz-postgres-ready',
    pgReady.status === 200 && pgReadyBody.ready === true && pgReadyBody.backend === 'postgres' && Number.isInteger(pgReadyBody.schemaVersion) && pgReadyBody.schemaVersion >= 1,
    `backend=${pgReadyBody.backend} schemaVersion=${pgReadyBody.schemaVersion} latencyMs=${pgReadyBody.latencyMs}`);

  const pgHealth = await get(`${pgBase}/healthz`);
  record('healthz-postgres-liveness', pgHealth.status === 200, `status=${pgHealth.status}`);

  // Simulate a database outage by closing the runtime pool out from under the probes.
  await pgApp.repository.pool.end();
  const outageReady = await get(`${pgBase}/readyz`);
  const outageBody = await outageReady.json();
  const outageHealth = await get(`${pgBase}/healthz`);
  record('readiness-detects-database-outage',
    outageReady.status === 503 && outageBody.status === 'not_ready' && outageHealth.status === 200,
    `readyz=${outageReady.status}(${outageBody.error}) healthz=${outageHealth.status}`);

  const outageMetrics = await (await get(`${pgBase}/metrics`)).text();
  record('metrics-readiness-gauge-drops', /health_skill_ready 0/.test(outageMetrics), 'health_skill_ready 0');

  const pgShutdown = await pgApp.shutdown();
  record('graceful-shutdown-postgres-after-outage',
    pgShutdown.closed === true && pgShutdown.timedOut === false,
    `closed=${pgShutdown.closed} timedOut=${pgShutdown.timedOut} resourceCloseFailures=${pgShutdown.resourceCloseFailures.length}`);

  // ---------- summary ----------
  const passed = checks.every((check) => check.ok);
  const finishedAt = new Date().toISOString();
  const summary = {
    schemaVersion: 1,
    step: 23,
    generatedAt: finishedAt,
    startedAt,
    allChecksPassed: passed,
    serviceVersion: APP_VERSION,
    checks,
    probes: { liveness: '/healthz', readiness: '/readyz', metrics: '/metrics', authentication: 'none', note: '探针按设计不鉴权；应部署在私有网络或网关白名单后。' },
    sqliteRuntime: { port: sqlitePort, shutdown: sqliteShutdown },
    postgresRuntime: {
      port: pgPort,
      targetPostgresVersion,
      shutdown: pgShutdown,
      outageSimulation: '运行期关闭连接池，/readyz 返回 503，/healthz 保持 200。',
    },
    environment: {
      kind: 'local-isolated-runtime',
      nodeVersion: process.version,
      disposableDatabase: true,
      productionTrafficSwitched: false,
    },
    limitations: [
      '本证据来自本地隔离运行时，不是 staging/生产环境，也不构成验收通过。',
      '指标为单进程内存聚合，多实例部署需要网关/共享指标系统汇总。',
      '未实现告警规则、仪表盘、分布式追踪与负载压测。',
      '探针端点无鉴权，必须通过私有网络或网关白名单限制访问。',
    ],
  };
  await writeFile(join(artifactsDir, 'RUNTIME_LIFECYCLE_EVIDENCE.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');
  if (!passed) {
    console.error('STEP 23 EVIDENCE: FAILED');
    process.exitCode = 1;
  } else {
    console.log('STEP 23 EVIDENCE: ALL CHECKS PASSED');
  }
}

await run();
