/**
 * Staging rehearsal / real staging drill (step 24, area 2/4).
 *
 * Mode A — local rehearsal (default), run against a disposable local PostgreSQL:
 *     POSTGRES_DRILL_URL=postgres://…@127.0.0.1:55432/health_skill_migration_test
 *     node scripts/staging-rehearsal.mjs --environment=local-rehearsal
 *   Seeds SQLite → backup/restore → migrate + replay → reconcile → boot runtime with probes →
 *   smoke /healthz /readyz /metrics → graceful shutdown. Evidence kind = "local-rehearsal".
 *
 * Mode B — real staging drill (requires real staging host and disposable/approved staging database):
 *     STAGING_BASE_URL=https://staging.example.test
 *     STAGING_DATABASE_URL=postgres://<drill_role>:<secret>@<host>:5432/<db>
 *     STAGING_OPERATOR="<name>"
 *     STAGING_SOURCE_SQLITE=/path/to/source.sqlite        # optional, enables reconcile
 *     STAGING_APPLY_MIGRATION=1                            # optional, explicit write authorization
 *     node scripts/staging-rehearsal.mjs --environment=staging
 *   Refuses localhost, http://, placeholder operators and non-disposable database names by default.
 *   Evidence kind = "staging"; the acceptance gate only accepts this kind for the staging item.
 *
 * This script never switches production traffic.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { RecordService } from '../src/application/record-service.js';
import { SqliteRecordRepository } from '../src/infrastructure/sqlite-record-repository.js';
import { PostgresRecordRepository } from '../src/infrastructure/postgres-record-repository.js';
import { applyPostgresMigrations } from '../src/infrastructure/postgres-migrations.js';
import { inspectSqliteSource, migrateSqliteToPostgres } from '../src/infrastructure/sqlite-to-postgres-migration.js';
import { reconcileSqliteToPostgres } from '../src/infrastructure/sqlite-postgres-reconciliation.js';
import { createSqliteBackup, inspectSqliteDatabase, restoreSqliteBackup } from '../src/infrastructure/sqlite-backup.js';
import { validateDisposablePostgresTestUrl } from '../src/infrastructure/postgres-test-safety.js';
import { startServer } from '../src/server.js';
import { APP_VERSION } from '../src/version.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const artifactsDir = join(root, 'artifacts', 'staging-rehearsal');
const environmentMode = (process.argv.find((arg) => arg.startsWith('--environment=')) ?? '--environment=local-rehearsal').split('=')[1];
const PLACEHOLDER = /^(?:<[^>]*>|tbd|todo|pending|none|n\/a|change ?me|example)$/i;
const checks = [];
const quietLogger = { info() {}, error() {} };
const record = (name, ok, detail = '') => {
  checks.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
async function waitFor(predicate, { timeoutMs = 5_000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await predicate()) return true; await sleep(intervalMs); }
  return false;
}
async function freePort() {
  return await new Promise((resolvePort, rejectPort) => {
    const probe = createServer();
    probe.unref();
    probe.on('error', rejectPort);
    probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolvePort(port)); });
  });
}
const NOW = '2026-10-28T12:00:00.000Z';

async function seedSource(sqlitePath) {
  const repository = new SqliteRecordRepository({ filename: sqlitePath });
  const service = new RecordService(repository);
  try {
    await service.createDraft({
      recordId: 'rec-staging-food-001', userId: 'user-staging-a', recordType: 'food', inputMethod: 'text',
      createdAt: NOW, updatedAt: NOW,
      payload: { mealType: 'lunch', items: [{ name: '鸡胸肉', quantity: 150, unit: 'g', caloriesKcal: 248, proteinG: 46 }] },
      fieldEvidence: [{ field: 'payload.items[0].proteinG', trustLevel: 'user_confirmed' }],
    });
    await service.confirmRecord('rec-staging-food-001', { expectedRevision: 0, idempotencyKey: 'staging-confirm-001' });
    await service.createDraft({
      recordId: 'rec-staging-training-002', userId: 'user-staging-a', recordType: 'training', inputMethod: 'form',
      createdAt: NOW, updatedAt: NOW,
      payload: { activityType: '三分化-上肢', durationMinutes: 55, exercises: [{ name: '卧推', sets: 4, reps: 8, loadKg: 50 }] },
      fieldEvidence: [{ field: 'payload.durationMinutes', trustLevel: 'user_confirmed' }],
    });
  } finally { repository.close(); }
  return await inspectSqliteSource(sqlitePath);
}

async function localRehearsal() {
  const drillUrl = process.env.POSTGRES_DRILL_URL;
  const safetyError = validateDisposablePostgresTestUrl(drillUrl);
  if (safetyError) { console.error(`REFUSED: ${safetyError}`); process.exitCode = 2; return; }
  await mkdir(artifactsDir, { recursive: true });
  const sourceDir = join(artifactsDir, 'local', 'source');
  const backupDir = join(artifactsDir, 'local', 'backup');
  await mkdir(sourceDir, { recursive: true });
  await mkdir(backupDir, { recursive: true });
  const sqlitePath = join(sourceDir, 'health-records-source.sqlite');
  const backupPath = join(backupDir, 'health-records-backup.sqlite');
  const restoredPath = join(backupDir, 'health-records-restored.sqlite');
  for (const suffix of ['', '-wal', '-shm']) await rm(sqlitePath + suffix, { force: true });
  for (const path of [backupPath, restoredPath]) await rm(path, { force: true });

  const source = await seedSource(sqlitePath);
  record('seed-sqlite-source', source.counts.records === 2 && source.counts.revisions === 3 && source.counts.idempotency === 1, JSON.stringify(source.counts));

  const repositoryForBackup = new SqliteRecordRepository({ filename: sqlitePath });
  const backup = await createSqliteBackup({ database: repositoryForBackup.db, destination: backupPath });
  repositoryForBackup.close();
  const restore = await restoreSqliteBackup({ backupFilename: backupPath, destination: restoredPath });
  const restoredInspect = await inspectSqliteDatabase(restoredPath);
  const restoredSource = await inspectSqliteSource(restoredPath);
  record('backup-and-restore', backup.schemaVersion === 1 && restore.schemaVersion === 1 && restoredInspect.ok === true && JSON.stringify(restoredSource.counts) === JSON.stringify(source.counts),
    `backup=${backup.bytes}B restoreSchema=${restore.schemaVersion} counts=${JSON.stringify(restoredSource.counts)}`);

  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: drillUrl, max: 4, connectionTimeoutMillis: 5_000, idleTimeoutMillis: 10_000 });
  let targetPostgresVersion = null;
  try {
    await pool.query('DROP SCHEMA IF EXISTS public CASCADE');
    await pool.query('CREATE SCHEMA public');
    const versionResult = await pool.query('SELECT version()');
    targetPostgresVersion = String(versionResult.rows[0].version).split(',')[0];
    const dryRun = await migrateSqliteToPostgres({ sqliteFilename: sqlitePath, pool, dryRun: true });
    record('migration-dry-run', dryRun.sourceCounts.records === source.counts.records, JSON.stringify(dryRun.sourceCounts));
    const applied = await migrateSqliteToPostgres({ sqliteFilename: sqlitePath, pool, dryRun: false });
    record('migration-apply', applied.inserted.records === source.counts.records && applied.inserted.revisions === source.counts.revisions, `inserted=${JSON.stringify(applied.inserted)}`);
    const replay = await migrateSqliteToPostgres({ sqliteFilename: sqlitePath, pool, dryRun: false });
    record('migration-replay-idempotent', replay.inserted.records === 0, `alreadyPresent=${JSON.stringify(replay.alreadyPresent)}`);
    const reconciliation = await reconcileSqliteToPostgres({ sqliteFilename: sqlitePath, pool });
    record('reconciliation-zero-diff', reconciliation.match === true && reconciliation.mismatchCount === 0, `mismatchCount=${reconciliation.mismatchCount}`);
  } finally { await pool.end().catch(() => {}); }

  const runtimePort = await freePort();
  const app = await startServer({
    env: {
      NODE_ENV: 'test', DATABASE_BACKEND: 'postgres', POSTGRES_URL: drillUrl, POSTGRES_SSL: 'false',
      POSTGRES_AUTO_MIGRATE: 'false',
      OIDC_ISSUER: 'https://127.0.0.1:9/oidc', OIDC_AUDIENCE: 'health-skill-record-api', OIDC_JWKS_URL: 'https://127.0.0.1:9/oidc/jwks.json',
      CORS_ORIGINS: 'http://localhost:5173', HOST: '127.0.0.1', PORT: String(runtimePort), RATE_LIMIT_MAX_REQUESTS: '1000',
    },
    logger: quietLogger,
  });
  const base = `http://127.0.0.1:${runtimePort}`;
  await waitFor(() => app.server.listening === true);
  const health = await fetch(`${base}/healthz`);
  const ready = await fetch(`${base}/readyz`);
  const readyBody = await ready.json();
  const metrics = await fetch(`${base}/metrics`);
  const metricsText = await metrics.text();
  const unauth = await fetch(`${base}/v1/records`);
  record('probe-smoke', health.status === 200 && ready.status === 200 && readyBody.backend === 'postgres' && metrics.status === 200 && unauth.status === 401,
    `healthz=${health.status} readyz=${ready.status}(${readyBody.backend}) metrics=${metrics.status} unauth=${unauth.status}`);
  record('metrics-content', /health_skill_http_requests_total/.test(metricsText) && /health_skill_ready 1/.test(metricsText), 'request counter + readiness gauge present');
  const shutdown = await app.shutdown();
  const sourceAfter = await inspectSqliteSource(sqlitePath);
  record('graceful-shutdown', shutdown.closed === true && shutdown.timedOut === false && JSON.stringify(sourceAfter.counts) === JSON.stringify(source.counts), `closed=${shutdown.closed} sourceUnchanged=true`);

  const evidence = {
    schemaVersion: 1, kind: 'local-rehearsal', generatedAt: new Date().toISOString(),
    allChecksPassed: checks.every((check) => check.ok),
    serviceVersion: APP_VERSION,
    environment: { baseUrl: base, operator: 'local-automation', postgresVersion: targetPostgresVersion, nodeVersion: process.version, disposableDatabase: true },
    checks,
    note: '本地隔离演练，仅用于证明剧本可执行；不能替代 staging 环境演练，也不会被验收门禁接受为 staging 证据。',
  };
  await writeFile(join(artifactsDir, 'STAGING_REHEARSAL_EVIDENCE.json'), JSON.stringify(evidence, null, 2) + '\n', 'utf8');
  console.log(evidence.allChecksPassed ? 'LOCAL REHEARSAL: ALL CHECKS PASSED (kind=local-rehearsal)' : 'LOCAL REHEARSAL: FAILED');
  if (!evidence.allChecksPassed) process.exitCode = 1;
}

async function stagingDrill() {
  const baseUrl = process.env.STAGING_BASE_URL;
  const databaseUrl = process.env.STAGING_DATABASE_URL;
  const operator = process.env.STAGING_OPERATOR;
  const sourceSqlite = process.env.STAGING_SOURCE_SQLITE;
  const applyMigration = process.env.STAGING_APPLY_MIGRATION === '1';
  // Dry-run mode exercises the *staging code path* against a local disposable database and a
  // local http API. It is explicitly NOT staging evidence: kind becomes "staging-dry-run" and
  // the acceptance gate rejects it. Use it to validate the drill before touching real staging.
  const dryRunMode = process.env.STAGING_DRY_RUN_ALLOW_LOCALHOST === '1';
  const problems = [];
  if (!baseUrl) problems.push('STAGING_BASE_URL is required');
  else if (dryRunMode) {
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(baseUrl)) problems.push('dry-run STAGING_BASE_URL must be http://127.0.0.1:<port>');
  } else {
    if (!/^https:\/\//.test(baseUrl)) problems.push('STAGING_BASE_URL must be an https URL');
    if (/127\.0\.0\.1|localhost/.test(baseUrl)) problems.push('STAGING_BASE_URL must not point to localhost');
  }
  if (!databaseUrl) problems.push('STAGING_DATABASE_URL is required');
  if (!operator || PLACEHOLDER.test(operator)) problems.push('STAGING_OPERATOR must be a real operator name (not a placeholder)');
  if (problems.length) { console.error(`REFUSED: ${problems.join('; ')}`); process.exitCode = 2; return; }
  const dbSafety = validateDisposablePostgresTestUrl(databaseUrl);
  if (dbSafety && !dryRunMode && process.env.STAGING_ALLOW_NON_DISPOSABLE !== '1') {
    console.error(`REFUSED: ${dbSafety}（如确认目标库为已批准的 staging 库，请显式设置 STAGING_ALLOW_NON_DISPOSABLE=1）`);
    process.exitCode = 2;
    return;
  }
  await mkdir(artifactsDir, { recursive: true });

  const health = await fetch(`${baseUrl}/healthz`);
  const ready = await fetch(`${baseUrl}/readyz`);
  const readyBody = await ready.json();
  record('staging-healthz', health.status === 200, `status=${health.status}`);
  record('staging-readyz', ready.status === 200 && readyBody.ready === true && readyBody.backend === 'postgres', `status=${ready.status} backend=${readyBody.backend}`);
  const metrics = await fetch(`${baseUrl}/metrics`);
  record('staging-metrics', metrics.status === 200 && /health_skill_http_requests_total/.test(await metrics.text()), `status=${metrics.status}`);

  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2, connectionTimeoutMillis: 10_000, ssl: process.env.STAGING_POSTGRES_SSL === 'false' || dryRunMode ? undefined : { rejectUnauthorized: true } });
  let targetPostgresVersion = null;
  try {
    const versionResult = await pool.query('SELECT version()');
    targetPostgresVersion = String(versionResult.rows[0].version).split(',')[0];
    if (sourceSqlite) {
      const dryRun = await migrateSqliteToPostgres({ sqliteFilename: sourceSqlite, pool, dryRun: true });
      record('staging-migration-dry-run', dryRun.sourceCounts.records >= 0, JSON.stringify(dryRun.sourceCounts));
      if (applyMigration) {
        const applied = await migrateSqliteToPostgres({ sqliteFilename: sourceSqlite, pool, dryRun: false });
        record('staging-migration-apply', true, `inserted=${JSON.stringify(applied.inserted)}`);
      }
      const reconciliation = await reconcileSqliteToPostgres({ sqliteFilename: sourceSqlite, pool });
      record('staging-reconciliation-zero-diff', reconciliation.match === true && reconciliation.mismatchCount === 0, `mismatchCount=${reconciliation.mismatchCount}`);
    }
  } finally { await pool.end().catch(() => {}); }

  const evidence = {
    schemaVersion: 1, kind: dryRunMode ? 'staging-dry-run' : 'staging', generatedAt: new Date().toISOString(),
    allChecksPassed: checks.every((check) => check.ok),
    serviceVersion: APP_VERSION,
    dryRun: dryRunMode,
    environment: {
      baseUrl,
      operator,
      postgresVersion: targetPostgresVersion,
      nodeVersion: process.version,
      disposableDatabase: Boolean(dbSafety) || process.env.STAGING_ALLOW_NON_DISPOSABLE === '1',
      ...(dryRunMode ? { dryRunNote: '本地预演：验证 staging 剧本代码路径，不是 staging 环境证据。' } : {}),
    },
    checks,
    migrationApplied: applyMigration,
    note: dryRunMode
      ? 'staging 剧本本地预演（kind=staging-dry-run）；验收门禁明确不接受该 kind 作为 staging 证据。'
      : '真实 staging 环境演练；不切换生产流量。',
  };
  await writeFile(join(artifactsDir, 'STAGING_REHEARSAL_EVIDENCE.json'), JSON.stringify(evidence, null, 2) + '\n', 'utf8');
  const label = dryRunMode ? 'STAGING DRY RUN (kind=staging-dry-run)' : 'STAGING DRILL (kind=staging)';
  console.log(evidence.allChecksPassed ? `${label}: ALL CHECKS PASSED` : `${label}: FAILED`);
  if (!evidence.allChecksPassed) process.exitCode = 1;
}

await mkdir(artifactsDir, { recursive: true });
if (environmentMode === 'staging') await stagingDrill();
else if (environmentMode === 'local-rehearsal') await localRehearsal();
else { console.error('REFUSED: --environment must be local-rehearsal or staging'); process.exitCode = 2; }
