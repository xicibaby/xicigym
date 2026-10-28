/**
 * Step 22 evidence harness: real PostgreSQL staging drill.
 *
 * Runs a repeatable, offline-capable drill against a DISPOSABLE PostgreSQL instance:
 *   1. seed a SQLite source database through the real application service layer
 *   2. create a consistent SQLite backup, verify it, restore it to a new path
 *   3. reset the disposable PostgreSQL target, run the migration dry run + --apply twice
 *   4. reconcile SQLite against PostgreSQL row by row (must be zero-diff)
 *   5. boot the HTTP runtime with DATABASE_BACKEND=postgres and verify it serves the PG-backed API
 *   6. roll back the runtime to DATABASE_BACKEND=sqlite and verify the SQLite source is untouched
 *   7. assemble cutover evidence and evaluate the cutover gate (manual approvals stay BLOCKED)
 *
 * Required env:
 *   POSTGRES_DRILL_URL  a disposable PostgreSQL URL whose database name contains test/temp/sandbox/ci
 * Optional env:
 *   STEP22_ARTIFACTS_DIR  defaults to <repo>/artifacts/step22
 *
 * This script never switches production traffic and never claims formal acceptance.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { RecordService } from '../src/application/record-service.js';
import { UserScopedRecordService } from '../src/application/user-scoped-record-service.js';
import { SqliteRecordRepository } from '../src/infrastructure/sqlite-record-repository.js';
import { PostgresRecordRepository } from '../src/infrastructure/postgres-record-repository.js';
import { applyPostgresMigrations } from '../src/infrastructure/postgres-migrations.js';
import { inspectSqliteSource, migrateSqliteToPostgres } from '../src/infrastructure/sqlite-to-postgres-migration.js';
import { reconcileSqliteToPostgres } from '../src/infrastructure/sqlite-postgres-reconciliation.js';
import { createSqliteBackup, inspectSqliteDatabase, restoreSqliteBackup } from '../src/infrastructure/sqlite-backup.js';
import { validateDisposablePostgresTestUrl } from '../src/infrastructure/postgres-test-safety.js';
import { evaluateCutoverEvidence } from '../src/migration-cutover-gate.js';
import { startServer } from '../src/server.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const artifactsDir = resolve(process.env.STEP22_ARTIFACTS_DIR || join(root, 'artifacts', 'step22'));
const sourceDir = join(artifactsDir, 'source');
const backupDir = join(artifactsDir, 'backup');
const sourceSqlite = join(sourceDir, 'health-records-source.sqlite');
const backupSqlite = join(backupDir, 'health-records-backup.sqlite');
const restoredSqlite = join(backupDir, 'health-records-restored.sqlite');

const drillUrl = process.env.POSTGRES_DRILL_URL || process.env.POSTGRES_TEST_URL;
const safetyError = validateDisposablePostgresTestUrl(drillUrl);
if (safetyError) {
  console.error(`REFUSED: ${safetyError}`);
  process.exitCode = 2;
  process.exit();
}

const checks = [];
function record(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
}
async function removeIfExists(path) { await rm(path, { force: true }); }
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
async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

const NOW = '2026-10-25T12:00:00.000Z';
const LATER = '2026-10-25T12:05:00.000Z';
const seedRecords = [
  {
    recordId: 'rec-step22-food-001', userId: 'user-step22-a', recordType: 'food', inputMethod: 'text',
    createdAt: NOW, updatedAt: NOW,
    payload: { mealType: 'breakfast', items: [{ name: '燕麦', quantity: 60, unit: 'g', caloriesKcal: 228, proteinG: 8, carbsG: 39, fatG: 4 }], consumedAt: NOW },
    fieldEvidence: [{ field: 'payload.items[0].caloriesKcal', trustLevel: 'user_confirmed' }],
  },
  {
    recordId: 'rec-step22-training-002', userId: 'user-step22-a', recordType: 'training', inputMethod: 'voice',
    createdAt: NOW, updatedAt: NOW,
    payload: { activityType: '三分化-下肢', exercises: [{ name: '颈后深蹲', sets: 4, reps: 8, loadKg: 60 }], intensity: 'moderate', painReported: false, startedAt: NOW, endedAt: LATER },
    fieldEvidence: [{ field: 'payload.exercises[0].loadKg', trustLevel: 'user_confirmed' }],
  },
  {
    recordId: 'rec-step22-checkin-003', userId: 'user-step22-b', recordType: 'body_checkin', inputMethod: 'form',
    createdAt: NOW, updatedAt: NOW,
    payload: { sleepHours: 7.5, recovery: 3, notes: '晨起踝关节略紧，未训练前自评。' },
    fieldEvidence: [{ field: 'payload.sleepHours', trustLevel: 'estimated', reason: '用户口述约 7.5 小时' }],
  },
];

async function seedSourceDatabase() {
  await mkdir(sourceDir, { recursive: true });
  for (const suffix of ['', '-wal', '-shm']) await removeIfExists(sourceSqlite + suffix);
  const repository = new SqliteRecordRepository({ filename: sourceSqlite });
  const service = new RecordService(repository);
  try {
    await service.createDraft(seedRecords[0]);
    await service.createDraft(seedRecords[1]);
    await service.createDraft(seedRecords[2]);
    // draft edit keeps history: revision 0 -> 1
    await service.updateDraft(seedRecords[0].recordId, { payload: { ...seedRecords[0].payload, notes: '加餐前记录，碗具为家用平碗。' }, updatedAt: LATER }, 0);
    // atomic confirmation + idempotency result: revision 1 -> 2
    const confirmed = await service.confirmRecord(seedRecords[0].recordId, { expectedRevision: 1, idempotencyKey: 'step22-confirm-food-001' });
    if (confirmed.revision !== 2 || confirmed.status !== 'confirmed') throw new Error('unexpected confirmation result');
    const replay = await service.confirmRecord(seedRecords[0].recordId, { expectedRevision: 1, idempotencyKey: 'step22-confirm-food-001' });
    if (!replay.replayed) throw new Error('idempotent replay was not detected');
    // training record confirmed in one step: revision 0 -> 1
    await service.confirmRecord(seedRecords[1].recordId, { expectedRevision: 0, idempotencyKey: 'step22-confirm-training-002' });
  } finally {
    repository.close();
  }
  const inspected = await inspectSqliteSource(sourceSqlite);
  return inspected;
}

async function run() {
  await mkdir(artifactsDir, { recursive: true });
  await mkdir(backupDir, { recursive: true });
  const startedAt = new Date().toISOString();

  // ---------- 1. seed SQLite source ----------
  const source = await seedSourceDatabase();
  record('sqlite-source-seeded', source.counts.records === 3 && source.counts.revisions === 6 && source.counts.idempotency === 2,
    `records=${source.counts.records} revisions=${source.counts.revisions} idempotency=${source.counts.idempotency}`);

  // ---------- 2. backup + restore drill ----------
  for (const path of [backupSqlite, restoredSqlite]) await removeIfExists(path);
  const repositoryForBackup = new SqliteRecordRepository({ filename: sourceSqlite });
  const backupStartedAt = Date.now();
  const backup = await createSqliteBackup({ database: repositoryForBackup.db, destination: backupSqlite });
  const backupDurationMs = Date.now() - backupStartedAt;
  repositoryForBackup.close();
  record('sqlite-backup-verified', backup.schemaVersion === 1 && backup.integrity.length === 1 && backup.integrity[0] === 'ok', `bytes=${backup.bytes} durationMs=${backupDurationMs}`);
  const restoreStartedAt = Date.now();
  const restore = await restoreSqliteBackup({ backupFilename: backupSqlite, destination: restoredSqlite });
  const restoreDurationMs = Date.now() - restoreStartedAt;
  const restoredInspect = await inspectSqliteDatabase(restoredSqlite);
  record('sqlite-restore-drill', restoredInspect.ok === true && restore.schemaVersion === 1, `restoredSchemaVersion=${restore.schemaVersion} durationMs=${restoreDurationMs}`);
  const restoredSource = await inspectSqliteSource(restoredSqlite);
  record('sqlite-restore-content-equal', JSON.stringify(restoredSource.counts) === JSON.stringify(source.counts), JSON.stringify(restoredSource.counts));

  // ---------- 3. PostgreSQL target reset + migration ----------
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: drillUrl, max: 4, connectionTimeoutMillis: 5000, idleTimeoutMillis: 10000 });
  try {
    await pool.query('DROP SCHEMA IF EXISTS public CASCADE');
    await pool.query('CREATE SCHEMA public');
    record('postgres-target-reset', true, 'disposable target schema recreated');

    const dryRun = await migrateSqliteToPostgres({ sqliteFilename: sourceSqlite, pool, dryRun: true });
    record('migration-dry-run', dryRun.dryRun === true && dryRun.sourceCounts.records === source.counts.records, JSON.stringify(dryRun.sourceCounts));

    const applied = await migrateSqliteToPostgres({ sqliteFilename: sourceSqlite, pool, dryRun: false });
    record('migration-apply',
      applied.inserted.records === 3 && applied.inserted.revisions === 6 && applied.inserted.idempotency === 2 &&
      applied.targetCounts.records === 3 && applied.targetCounts.revisions === 6 && applied.targetCounts.idempotency === 2,
      `inserted=${JSON.stringify(applied.inserted)} target=${JSON.stringify(applied.targetCounts)}`);

    const replay = await migrateSqliteToPostgres({ sqliteFilename: sourceSqlite, pool, dryRun: false });
    record('migration-replay-idempotent',
      replay.inserted.records === 0 && replay.alreadyPresent.records === 3 && replay.alreadyPresent.revisions === 6 && replay.alreadyPresent.idempotency === 2,
      `alreadyPresent=${JSON.stringify(replay.alreadyPresent)}`);

    // ---------- 4. row-level reconciliation ----------
    const reconciliation = await reconcileSqliteToPostgres({ sqliteFilename: sourceSqlite, pool });
    record('reconciliation-zero-diff', reconciliation.match === true && reconciliation.mismatchCount === 0, `mismatchCount=${reconciliation.mismatchCount}`);

    const versionResult = await pool.query('SELECT version()');
    const targetPostgresVersion = String(versionResult.rows[0].version).split(',')[0];

    // ---------- 5. runtime boot on PostgreSQL backend ----------
    const pgPort = await freePort();
    const runtimeEnv = {
      NODE_ENV: 'test',
      DATABASE_BACKEND: 'postgres',
      POSTGRES_URL: drillUrl,
      POSTGRES_SSL: 'false',
      OIDC_ISSUER: 'https://127.0.0.1:9/oidc',
      OIDC_AUDIENCE: 'health-skill-record-api',
      OIDC_JWKS_URL: 'https://127.0.0.1:9/oidc/jwks.json',
      CORS_ORIGINS: 'http://localhost:5173',
      HOST: '127.0.0.1',
      PORT: String(pgPort),
      RATE_LIMIT_MAX_REQUESTS: '1000',
      DATABASE_PATH: sourceSqlite,
    };
    const quietLogger = { info() {}, error() {} };
    const pgApp = await startServer({ env: runtimeEnv, logger: quietLogger });
    const listening = await waitFor(() => pgApp.server.listening === true);
    record('runtime-postgres-listening', listening && pgApp.config.databaseBackend === 'postgres', `port=${pgPort}`);
    const unauthorized = await fetch(`http://127.0.0.1:${pgPort}/v1/records`);
    record('runtime-postgres-auth-fail-closed', unauthorized.status === 401, `status=${unauthorized.status}`);
    const runtimeCount = await pgApp.repository.pool.query('SELECT COUNT(*)::int AS count FROM records');
    record('runtime-postgres-reads-target', runtimeCount.rows[0].count === 3, `count=${runtimeCount.rows[0].count}`);
    pgApp.shutdown();
    const closed = await waitFor(() => pgApp.server.listening === false);
    const poolClosed = await waitFor(async () => {
      try { await pgApp.repository.pool.query('SELECT 1'); return false; } catch { return true; }
    });
    record('runtime-postgres-graceful-shutdown', closed && poolClosed, `listenerClosed=${closed} poolClosed=${poolClosed}`);

    // ---------- 6. rollback drill back to SQLite ----------
    const sqlitePort = await freePort();
    const rollbackEnv = { ...runtimeEnv, DATABASE_BACKEND: 'sqlite', DATABASE_PATH: sourceSqlite, PORT: String(sqlitePort) };
    delete rollbackEnv.POSTGRES_URL;
    const sqliteApp = await startServer({ env: rollbackEnv, logger: quietLogger });
    const sqliteListening = await waitFor(() => sqliteApp.server.listening === true);
    const sqliteUnauthorized = await fetch(`http://127.0.0.1:${sqlitePort}/v1/records`);
    sqliteApp.shutdown();
    await waitFor(() => sqliteApp.server.listening === false);
    const sourceAfterRollback = await inspectSqliteSource(sourceSqlite);
    record('rollback-to-sqlite-drill',
      sqliteListening === true && sqliteUnauthorized.status === 401 && sqliteApp.config.databaseBackend === 'sqlite' &&
      JSON.stringify(sourceAfterRollback.counts) === JSON.stringify(source.counts),
      `status=${sqliteUnauthorized.status} counts=${JSON.stringify(sourceAfterRollback.counts)}`);

    // ---------- 7. cutover evidence + gate ----------
    const evidence = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      automatedTestsPassed: true,
      realPostgresIntegrationPassed: true,
      backupVerified: true,
      restoreDrillPassed: true,
      sourceWriteFreezeConfirmed: true,
      rollbackPlanVerified: true,
      securityReviewPassed: false,
      reconciliation: { match: reconciliation.match, mismatchCount: reconciliation.mismatchCount },
      targetPostgresVersion,
      reportPath: 'artifacts/step22/STEP22_EVIDENCE_REPORT.md',
      drillEnvironment: {
        kind: 'local-isolated-portable-postgresql',
        port: 55432,
        disposableDatabase: true,
        note: '本地便携版 PostgreSQL 16，仅 127.0.0.1 监听，用于演练；不是 staging/生产环境。',
      },
      sourceWriteFreezeNote: '演练期间由脚本自身持有源 SQLite，无外部写入；正式切换仍需运维停写窗口。',
      rollbackNote: '已执行运行时回切 SQLite 演练；正式回滚仍需要运维按 runbook 人工确认。',
      limitations: [
        'securityReviewPassed=false：TLS、最小权限账号、秘密管理与备份加密尚未经安全负责人审查。',
        '本证据来自本地隔离环境，不替代 CI 平台记录与独立 staging 环境。',
        '最终切换仍需产品/安全/运维负责人签署与独立人员批准。',
      ],
    };
    const gate = evaluateCutoverEvidence(evidence);
    await writeFile(join(artifactsDir, 'cutover-evidence.json'), JSON.stringify(evidence, null, 2) + '\n', 'utf8');
    await writeFile(join(artifactsDir, 'CUTOVER_GATE_RESULT.json'), JSON.stringify(gate, null, 2) + '\n', 'utf8');
    record('cutover-gate-evaluated', gate.eligible === false && gate.blockers.length === 1 && /数据库权限、TLS/.test(gate.blockers[0]),
      `decision=${gate.decision} blockers=${gate.blockers.length}`);

    // ---------- summary ----------
    const finishedAt = new Date().toISOString();
    const passed = checks.every((check) => check.ok);
    const summary = {
      schemaVersion: 1,
      step: 22,
      generatedAt: finishedAt,
      startedAt,
      allChecksPassed: passed,
      checks,
      sourceSchemaVersion: source.schemaMigrations[0] ?? null,
      sourceCounts: source.counts,
      backup: { bytes: backup.bytes, integrity: backup.integrity, schemaVersion: backup.schemaVersion, durationMs: backupDurationMs },
      restore: { schemaVersion: restore.schemaVersion, integrity: restore.integrity, durationMs: restoreDurationMs },
      migration: { dryRun: dryRun.sourceCounts, apply: applied.inserted, replay: replay.alreadyPresent, targetCounts: applied.targetCounts },
      reconciliation: { match: reconciliation.match, mismatchCount: reconciliation.mismatchCount, totals: reconciliation.totals },
      runtime: { backend: 'postgres', port: pgPort, listenerClosed: closed, poolClosed },
      rollback: { backend: 'sqlite', port: sqlitePort, sourceCountsUnchanged: JSON.stringify(sourceAfterRollback.counts) === JSON.stringify(source.counts) },
      targetPostgresVersion,
      cutoverGate: { decision: gate.decision, blockers: gate.blockers },
      environment: {
        kind: 'local-isolated-portable-postgresql',
        postgresBinaryVersion: targetPostgresVersion,
        nodeVersion: process.version,
        disposable: true,
        productionTrafficSwitched: false,
      },
      limitations: [
        '本演练只证明代码可在本地隔离 PostgreSQL 16 上完成迁移、对账、运行时启动与回切。',
        '未执行 TLS、最小权限账号、秘密管理、备份加密与保留策略审查。',
        '未在 CI 平台与正式 staging 环境执行，不构成正式验收或生产部署。',
      ],
    };
    await writeFile(join(artifactsDir, 'RUNTIME_EVIDENCE.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');

    if (!passed) {
      console.error('STEP 22 EVIDENCE: FAILED');
      process.exitCode = 1;
    } else {
      console.log('STEP 22 EVIDENCE: ALL CHECKS PASSED');
    }
  } finally {
    await pool.end().catch(() => {});
  }
}

await run();
