import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PostgresRecordRepository } from '../src/infrastructure/postgres-record-repository.js';
import { applyPostgresMigrations } from '../src/infrastructure/postgres-migrations.js';
import { validateDisposablePostgresTestUrl } from '../src/infrastructure/postgres-test-safety.js';

const databaseUrl = process.env.POSTGRES_TEST_URL;
const databaseSafetyError = validateDisposablePostgresTestUrl(databaseUrl, {
  allowNonDisposable: process.env.POSTGRES_TEST_ALLOW_NON_DISPOSABLE === '1',
});

test('REAL PostgreSQL: migrations, JSONB, optimistic locking, history, idempotency and ownership guards', {
  skip: !databaseUrl ? 'Set POSTGRES_TEST_URL to a disposable PostgreSQL test database.' : false,
}, async () => {
  assert.equal(databaseSafetyError, null, databaseSafetyError ?? '');
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: databaseUrl, max: 4, connectionTimeoutMillis: 5000 });
  const suffix = randomUUID();
  const recordId = `it-${suffix}`;
  const idempotencyKey = `it-confirm-${suffix}`;
  const base = {
    recordId,
    userId: `it-user-${suffix}`,
    revision: 0,
    status: 'draft',
    recordType: 'food',
    updatedAt: new Date().toISOString(),
    payload: { note: 'real PostgreSQL integration test', items: [{ name: 'rice', amount: 120 }] },
  };
  try {
    await applyPostgresMigrations(pool);
    const repo = new PostgresRecordRepository({ pool });
    await repo.insert(base);
    assert.deepEqual(await repo.get(recordId), base);

    const page = await repo.listByUser({ userId: base.userId, recordType: 'food', status: 'draft', limit: 10, offset: 0 });
    assert.equal(page.total, 1);
    assert.equal(page.items[0].recordId, recordId);

    const edited = { ...base, revision: 1, updatedAt: new Date(Date.now() + 10).toISOString(), payload: { ...base.payload, note: 'edited' } };
    await repo.replace(edited, { expectedRevision: 0, reason: 'integration_edit' });
    await assert.rejects(() => repo.replace({ ...edited, revision: 2 }, { expectedRevision: 0 }), { name: 'RecordConflictError' });

    const confirmed = { ...edited, revision: 2, status: 'confirmed', updatedAt: new Date(Date.now() + 20).toISOString() };
    const first = await repo.confirmAtomically(confirmed, { expectedRevision: 1, idempotencyKey });
    assert.deepEqual(first, { recordId, status: 'confirmed', revision: 2, replayed: false });
    const replay = await repo.confirmAtomically(confirmed, { expectedRevision: 1, idempotencyKey });
    assert.deepEqual(replay, { recordId, status: 'confirmed', revision: 2, replayed: true });

    const history = await repo.getHistory(recordId);
    assert.deepEqual(history.map((entry) => entry.revision), [0, 1, 2]);
    assert.equal((await repo.get(recordId)).payload.note, 'edited');

    const foreign = { ...confirmed, userId: `foreign-${suffix}`, revision: 3 };
    await assert.rejects(() => repo.replace(foreign, { expectedRevision: 2 }), { name: 'RecordConflictError' });
  } finally {
    await pool.query('DELETE FROM idempotency_results WHERE idempotency_key = $1', [idempotencyKey]).catch(() => {});
    await pool.query('DELETE FROM records WHERE record_id = $1', [recordId]).catch(() => {});
    await pool.end();
  }
});
