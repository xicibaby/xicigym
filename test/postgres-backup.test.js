import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PostgresRecordRepository } from '../src/infrastructure/postgres-record-repository.js';
import { applyPostgresMigrations } from '../src/infrastructure/postgres-migrations.js';
import { validateDisposablePostgresTestUrl } from '../src/infrastructure/postgres-test-safety.js';
import { exportPostgresBackup, hashPostgresBackupPayload, importPostgresBackup, parsePostgresBackup, serializePostgresBackup } from '../src/infrastructure/postgres-backup.js';

const databaseUrl = process.env.POSTGRES_TEST_URL;
const databaseSafetyError = validateDisposablePostgresTestUrl(databaseUrl, {
  allowNonDisposable: process.env.POSTGRES_TEST_ALLOW_NON_DISPOSABLE === '1',
});

async function withIsolatedSchema(fn) {
  const { Pool } = await import('pg');
  const schema = `backup_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const adminPool = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 5_000 });
  await adminPool.query(`CREATE SCHEMA ${schema}`);
  const appPool = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 5_000 });
  const client = await appPool.connect();
  await client.query(`SET search_path TO ${schema}`);
  client.release();
  try {
    return await fn({ adminPool, appPool, schema });
  } finally {
    await appPool.end().catch(() => {});
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await adminPool.end().catch(() => {});
  }
}

test('REAL PostgreSQL: logical backup round-trips into a rebuilt schema and rejects tampering', {
  skip: !databaseUrl ? 'Set POSTGRES_TEST_URL to a disposable PostgreSQL test database.' : false,
}, async () => {
  assert.equal(databaseSafetyError, null, databaseSafetyError ?? '');
  await withIsolatedSchema(async ({ appPool, schema }) => {
    await appPool.query(`SELECT set_config('search_path', '${schema}', false)`);
    await applyPostgresMigrations(appPool);
    const repo = new PostgresRecordRepository({ pool: appPool });
    const suffix = randomUUID();
    const recordId = `bk-${suffix}`;
    const idempotencyKey = `bk-confirm-${suffix}`;
    const base = {
      recordId, userId: `bk-user-${suffix}`, revision: 0, status: 'draft', recordType: 'food',
      updatedAt: '2026-10-28T10:00:00+08:00',
      payload: { mealType: 'lunch', items: [{ name: '米饭', quantity: 150 }] },
    };
    await repo.insert(base);
    const confirmed = { ...base, revision: 1, status: 'confirmed', updatedAt: '2026-10-28T10:05:00+08:00' };
    await repo.confirmAtomically(confirmed, { expectedRevision: 0, idempotencyKey });

    const backup = await exportPostgresBackup({ pool: appPool });
    assert.equal(backup.format, 'health-skill-pg-backup-v1');
    assert.equal(backup.counts.records, 1);
    assert.equal(backup.counts.record_revisions, 2);
    assert.equal(backup.counts.idempotency_results, 1);
    const serialized = serializePostgresBackup(backup);
    assert.equal(parsePostgresBackup(serialized).sha256, backup.sha256);

    // Simulated disaster: schema rebuilt empty, then restore from the logical backup.
    await appPool.query(`DROP SCHEMA ${schema} CASCADE`);
    await appPool.query(`CREATE SCHEMA ${schema}`);
    await appPool.query(`SELECT set_config('search_path', '${schema}', false)`);
    await applyPostgresMigrations(appPool);
    const restored = await importPostgresBackup({ pool: appPool, backup });
    assert.deepEqual(restored.restored, { schema_migrations: 1, records: 1, record_revisions: 2, idempotency_results: 1 });
    assert.equal(restored.sha256, backup.sha256);

    const restoredRepo = new PostgresRecordRepository({ pool: appPool });
    assert.deepEqual(await restoredRepo.get(recordId), confirmed);
    assert.deepEqual((await restoredRepo.getHistory(recordId)).map((entry) => entry.revision), [0, 1]);
    assert.deepEqual(await restoredRepo.getIdempotentResult(idempotencyKey), { recordId, status: 'confirmed', revision: 1 });

    // Non-empty target is refused unless explicitly allowed.
    await assert.rejects(() => importPostgresBackup({ pool: appPool, backup }), /非空/);
    const overwritten = await importPostgresBackup({ pool: appPool, backup, allowExisting: true });
    assert.equal(overwritten.sha256, backup.sha256);

    // Tampered payload must fail validation before touching the target.
    const tampered = JSON.parse(serialized);
    tampered.payload.tables.records[0].status = 'archived';
    assert.throws(() => parsePostgresBackup(JSON.stringify(tampered)), /校验失败/);

    // Backup file with a different migration history must not restore (hash recomputed so only
    // the migration check can reject it).
    const mismatch = JSON.parse(serialized);
    mismatch.payload.tables.schema_migrations = [{ version: 2, name: 'future_migration', applied_at: '2026-01-01T00:00:00+00:00' }];
    mismatch.sha256 = hashPostgresBackupPayload(mismatch.payload);
    await assert.rejects(() => importPostgresBackup({ pool: appPool, backup: mismatch }), /迁移版本/);
  });
});
