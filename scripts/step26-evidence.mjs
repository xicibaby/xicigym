/**
 * Step 26 evidence: data-safety drill (encrypted PostgreSQL logical backup + restore),
 * encrypted SQLite backup, alert-rule validation and no-secret-leak checks.
 *
 * Required env: POSTGRES_DRILL_URL (disposable PostgreSQL database name containing test/temp/sandbox/ci).
 * Output: artifacts/step26/PG_RESTORE_DRILL_EVIDENCE.json
 */
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { parse as parseYaml } from 'yaml';

import { RecordService } from '../src/application/record-service.js';
import { SqliteRecordRepository } from '../src/infrastructure/sqlite-record-repository.js';
import { PostgresRecordRepository } from '../src/infrastructure/postgres-record-repository.js';
import { applyPostgresMigrations } from '../src/infrastructure/postgres-migrations.js';
import { inspectSqliteSource, migrateSqliteToPostgres } from '../src/infrastructure/sqlite-to-postgres-migration.js';
import { reconcileSqliteToPostgres } from '../src/infrastructure/sqlite-postgres-reconciliation.js';
import { decryptBackup, encryptBackup, parseEncryptionKey } from '../src/infrastructure/backup-crypto.js';
import { exportPostgresBackup, importPostgresBackup, parsePostgresBackup, serializePostgresBackup } from '../src/infrastructure/postgres-backup.js';
import { runMaintenance } from '../src/maintenance.js';
import { validateDisposablePostgresTestUrl } from '../src/infrastructure/postgres-test-safety.js';
import { APP_VERSION } from '../src/version.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const artifactsDir = join(root, 'artifacts', 'step26');
const backupDir = join(artifactsDir, 'backup');
const sqliteDir = join(artifactsDir, 'sqlite');
const drillUrl = process.env.POSTGRES_DRILL_URL || process.env.POSTGRES_TEST_URL;
const safetyError = validateDisposablePostgresTestUrl(drillUrl);
if (safetyError) { console.error(`REFUSED: ${safetyError}`); process.exitCode = 2; process.exit(); }

const checks = [];
const quietLogger = { log() {}, error() {}, info() {} };
const record = (name, ok, detail = '') => {
  checks.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const NOW = '2026-10-28T12:00:00.000Z';

async function seedSource(sqlitePath) {
  const repository = new SqliteRecordRepository({ filename: sqlitePath });
  const service = new RecordService(repository);
  try {
    await service.createDraft({
      recordId: 'rec-drill-food-001', userId: 'user-drill', recordType: 'food', inputMethod: 'text',
      createdAt: NOW, updatedAt: NOW,
      payload: { mealType: 'dinner', items: [{ name: '三文鱼', quantity: 120, unit: 'g', proteinG: 25 }] },
      fieldEvidence: [{ field: 'payload.items[0].proteinG', trustLevel: 'user_confirmed' }],
    });
    await service.confirmRecord('rec-drill-food-001', { expectedRevision: 0, idempotencyKey: 'drill-confirm-001' });
    await service.createDraft({
      recordId: 'rec-drill-training-002', userId: 'user-drill', recordType: 'training', inputMethod: 'voice',
      createdAt: NOW, updatedAt: NOW,
      payload: { activityType: '三分化-推', durationMinutes: 50, exercises: [{ name: '哑铃卧推', sets: 4, reps: 10, loadKg: 22.5 }] },
      fieldEvidence: [{ field: 'payload.durationMinutes', trustLevel: 'user_confirmed' }],
    });
  } finally { repository.close(); }
  return await inspectSqliteSource(sqlitePath);
}

async function resetSchema(pool) {
  await pool.query('DROP SCHEMA IF EXISTS public CASCADE');
  await pool.query('CREATE SCHEMA public');
  await pool.query('GRANT USAGE, CREATE ON SCHEMA public TO PUBLIC');
}

async function run() {
  await mkdir(artifactsDir, { recursive: true });
  await mkdir(backupDir, { recursive: true });
  await mkdir(sqliteDir, { recursive: true });
  const startedAt = new Date().toISOString();

  // ---------- A. encrypted SQLite backup drill ----------
  const sqlitePath = join(sqliteDir, 'health-records-source.sqlite');
  const sqliteBackupPath = join(backupDir, 'sqlite-backup.sqlite.enc');
  const sqliteRestoredPath = join(sqliteDir, 'health-records-restored.sqlite');
  for (const suffix of ['', '-wal', '-shm']) await rm(sqlitePath + suffix, { force: true });
  for (const path of [sqliteBackupPath, sqliteRestoredPath]) await rm(path, { force: true });
  const source = await seedSource(sqlitePath);
  const encryptionKey = randomBytes(32);
  const keyBase64 = encryptionKey.toString('base64');
  const env = { BACKUP_ENCRYPTION_KEY: keyBase64 };
  const sqliteBackup = await runMaintenance(['backup', sqlitePath, sqliteBackupPath], { logger: quietLogger, env });
  record('sqlite-encrypted-backup', sqliteBackup.encrypted === true && sqliteBackup.integrity?.[0] === 'ok', `bytes=${sqliteBackup.bytes} schemaVersion=${sqliteBackup.schemaVersion}`);
  const sqliteCheck = await runMaintenance(['check', sqliteBackupPath], { logger: quietLogger, env });
  record('sqlite-encrypted-backup-inspects', sqliteCheck.ok === true && sqliteCheck.encrypted === true, `integrity=${sqliteCheck.integrity?.[0]}`);
  const sqliteRestore = await runMaintenance(['restore', sqliteBackupPath, sqliteRestoredPath], { logger: quietLogger, env });
  record('sqlite-encrypted-restore', sqliteRestore.encrypted === true && sqliteRestore.schemaVersion === 1, JSON.stringify(sqliteRestore.integrity ?? []));

  // ---------- B. PostgreSQL logical backup + restore drill ----------
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: drillUrl, max: 4, connectionTimeoutMillis: 5_000, idleTimeoutMillis: 10_000 });
  const pgBackupPath = join(backupDir, 'postgres-logical-backup.json.enc');
  await rm(pgBackupPath, { force: true });
  try {
    await resetSchema(pool);
    await applyPostgresMigrations(pool);
    const applied = await migrateSqliteToPostgres({ sqliteFilename: sqlitePath, pool, dryRun: false });
    record('pg-target-prepared', applied.inserted.records === source.counts.records && applied.inserted.revisions === source.counts.revisions, `inserted=${JSON.stringify(applied.inserted)}`);

    const backup = await exportPostgresBackup({ pool });
    record('pg-logical-backup-export', backup.counts.records === source.counts.records && backup.counts.record_revisions === source.counts.revisions && backup.sha256.length === 64, `sha256=${backup.sha256.slice(0, 12)}… counts=${JSON.stringify(backup.counts)}`);

    const plaintext = serializePostgresBackup(backup);
    const encrypted = encryptBackup(Buffer.from(plaintext, 'utf8'), { key: encryptionKey });
    await writeFile(pgBackupPath, encrypted, { flag: 'wx', mode: 0o600 });
    const roundTrip = parsePostgresBackup(decryptBackup(await readFile(pgBackupPath), { key: encryptionKey }).toString('utf8'));
    record('pg-backup-encrypted-roundtrip', roundTrip.sha256 === backup.sha256 && roundTrip.counts.records === backup.counts.records, `bytes=${encrypted.length}`);

    const tamperedCipher = Buffer.from(encrypted);
    tamperedCipher[tamperedCipher.length - 5] ^= 0xff;
    let cipherRejected = false;
    try { decryptBackup(tamperedCipher, { key: encryptionKey }); } catch { cipherRejected = true; }
    record('pg-backup-tamper-rejected', cipherRejected, 'ciphertext tamper detected by GCM');
    const wrongKeyRejected = (() => { try { decryptBackup(encrypted, { key: randomBytes(32) }); return false; } catch { return true; } })();
    record('pg-backup-wrong-key-rejected', wrongKeyRejected, 'wrong key fails closed');

    const tamperedJson = JSON.parse(plaintext);
    tamperedJson.payload.tables.records[0].status = 'archived';
    let payloadRejected = false;
    try { parsePostgresBackup(JSON.stringify(tamperedJson)); } catch { payloadRejected = true; }
    record('pg-backup-payload-hash-rejected', payloadRejected, 'sha256 mismatch rejected');

    // Simulated disaster: rebuild schema empty, restore from the encrypted backup.
    await resetSchema(pool);
    await applyPostgresMigrations(pool);
    const imported = await importPostgresBackup({ pool, backup: roundTrip });
    record('pg-restore-into-rebuilt-schema', imported.restored.records === backup.counts.records && imported.restored.record_revisions === backup.counts.record_revisions, `restored=${JSON.stringify(imported.restored)}`);
    record('pg-restore-sha256-match', imported.sha256 === backup.sha256, `sha256=${imported.sha256.slice(0, 12)}…`);

    const repository = new PostgresRecordRepository({ pool });
    const restoredRecord = await repository.get('rec-drill-food-001');
    const history = await repository.getHistory('rec-drill-food-001');
    record('pg-restore-content-check', restoredRecord?.status === 'confirmed' && history.length === 2, `status=${restoredRecord?.status} revisions=${history.length}`);

    const reconciliation = await reconcileSqliteToPostgres({ sqliteFilename: sqlitePath, pool });
    record('pg-restore-reconcile-zero-diff', reconciliation.match === true && reconciliation.mismatchCount === 0, `mismatchCount=${reconciliation.mismatchCount}`);
  } finally {
    await pool.end().catch(() => {});
  }

  // ---------- C. alert rules ----------
  try {
    const alertsRaw = await readFile(join(root, 'ops', 'prometheus', 'alerts.yml'), 'utf8');
    const alerts = parseYaml(alertsRaw);
    const groups = alerts?.groups ?? [];
    const rules = groups.flatMap((group) => group.rules ?? []);
    const valid = groups.length > 0 && rules.length >= 4 && rules.every((rule) => typeof rule.alert === 'string' && typeof rule.expr === 'string' && rule.expr.length > 0);
    const metricsReferenced = rules.every((rule) => /health_skill_/.test(rule.expr));
    record('alert-rules-valid', valid, `groups=${groups.length} rules=${rules.length}`);
    record('alert-rules-use-exported-metrics', metricsReferenced, 'all expressions reference health_skill_* metrics');
  } catch (error) {
    record('alert-rules-valid', false, String(error?.message ?? error).slice(0, 160));
  }

  // ---------- D. no key leakage in artifacts ----------
  const files = await readdir(artifactsDir, { recursive: true, withFileTypes: true });
  const keyMaterial = keyBase64.slice(0, 16);
  let leaked = false;
  for (const entry of files) {
    if (!entry.isFile()) continue;
    if (!/\.(json|txt|md)$/.test(entry.name)) continue;
    const full = join(entry.parentPath ?? entry.path, entry.name);
    const text = await readFile(full, 'utf8').catch(() => '');
    if (text.includes(keyBase64) || text.includes(keyMaterial)) { leaked = true; break; }
  }
  record('artifacts-contain-no-key-material', leaked === false, 'encryption key never written to artifacts');

  const passed = checks.every((check) => check.ok);
  const summary = {
    schemaVersion: 1,
    kind: 'data-safety-drill',
    generatedAt: new Date().toISOString(),
    startedAt,
    allChecksPassed: passed,
    serviceVersion: APP_VERSION,
    checks,
    backupFiles: {
      sqliteEncrypted: 'artifacts/step26/backup/sqlite-backup.sqlite.enc',
      postgresEncrypted: 'artifacts/step26/backup/postgres-logical-backup.json.enc',
    },
    encryption: { algorithm: 'AES-256-GCM', keySource: 'ephemeral random key generated by the drill (not persisted)' },
    environment: { nodeVersion: process.version, postgresMustBeDisposable: true },
    limitations: [
      '逻辑备份适合中小数据量与灾备演练；生产仍需 pg_dump/物理备份与服务商备份。',
      '恢复演练在本地隔离 PostgreSQL 上进行，不代表真实故障切换；TLS、网络与权限由人工审查。',
      '加密密钥在演练中临时生成且不落盘；生产必须由秘密管理器托管并演练轮换。',
    ],
  };
  await writeFile(join(artifactsDir, 'PG_RESTORE_DRILL_EVIDENCE.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');
  console.log(passed ? 'STEP 26 EVIDENCE: ALL CHECKS PASSED' : 'STEP 26 EVIDENCE: FAILED');
  if (!passed) process.exitCode = 1;
}

await run();
