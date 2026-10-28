import test from 'node:test';
import assert from 'node:assert/strict';
import { PostgresRecordRepository } from '../src/infrastructure/postgres-record-repository.js';
import { applyPostgresMigrations, POSTGRES_MIGRATIONS } from '../src/infrastructure/postgres-migrations.js';
import { assertRecordRepository, inspectRecordRepository } from '../src/infrastructure/record-repository-contract.js';

class ScriptedPool {
  constructor(script = []) { this.script = [...script]; this.calls = []; this.released = 0; this.ended = false; }
  async connect() { return { query: async (sql, params = []) => this.#query(sql, params), release: () => { this.released++; } }; }
  async query(sql, params = []) { return this.#query(sql, params); }
  async end() { this.ended = true; }
  async #query(sql, params) {
    this.calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
    if (!this.script.length) return { rows: [], rowCount: 0 };
    const next = this.script.shift();
    if (next.error) throw next.error;
    if (next.match && !sql.includes(next.match)) throw new Error(`Expected SQL containing ${next.match}, got ${sql}`);
    return next.result ?? { rows: [], rowCount: 0 };
  }
}
const record = { recordId: 'r1', userId: 'u1', revision: 0, status: 'draft', recordType: 'food', updatedAt: '2026-10-25T00:00:00.000Z', payload: { note: 'lunch' } };

test('PostgreSQL adapter satisfies shared repository contract and requires a pool', () => {
  const repo = new PostgresRecordRepository({ pool: new ScriptedPool() });
  assert.equal(inspectRecordRepository(repo).ok, true);
  assert.equal(assertRecordRepository(repo, { requireAtomicConfirm: true }), repo);
  assert.throws(() => new PostgresRecordRepository({ pool: {} }), /pg-compatible Pool/);
});

test('PostgreSQL insert writes record and first revision in one transaction', async () => {
  const pool = new ScriptedPool([
    { match: 'BEGIN' }, { match: 'INSERT INTO records' }, { match: 'INSERT INTO record_revisions' }, { match: 'COMMIT' },
  ]);
  const saved = await new PostgresRecordRepository({ pool }).insert(record);
  assert.deepEqual(saved, record);
  assert.deepEqual(pool.calls.map((c) => c.sql.split(' ')[0]), ['BEGIN', 'INSERT', 'INSERT', 'COMMIT']);
  assert.equal(pool.released, 1);
});

test('PostgreSQL stale replace rolls back and does not write a revision', async () => {
  const pool = new ScriptedPool([
    { match: 'BEGIN' }, { match: 'UPDATE records', result: { rows: [], rowCount: 0 } },
    { match: 'SELECT record_id FROM records', result: { rows: [{ record_id: 'r1' }], rowCount: 1 } }, { match: 'ROLLBACK' },
  ]);
  const repo = new PostgresRecordRepository({ pool });
  await assert.rejects(() => repo.replace({ ...record, revision: 2 }, { expectedRevision: 0 }), { name: 'RecordConflictError' });
  assert.equal(pool.calls.some((c) => c.sql.includes('INSERT INTO record_revisions')), false);
  assert.equal(pool.calls.at(-1).sql, 'ROLLBACK');
});

test('PostgreSQL confirmation commits record, history and idempotency result together', async () => {
  const pool = new ScriptedPool([
    { match: 'BEGIN' }, { match: 'INSERT INTO idempotency_results', result: { rows: [{ idempotency_key: 'k1' }], rowCount: 1 } },
    { match: 'SELECT user_id,revision,status FROM records', result: { rows: [{ user_id: 'u1', revision: 0, status: 'draft' }], rowCount: 1 } },
    { match: 'UPDATE records', result: { rows: [], rowCount: 1 } }, { match: 'INSERT INTO record_revisions' }, { match: 'COMMIT' },
  ]);
  const result = await new PostgresRecordRepository({ pool }).confirmAtomically({ ...record, revision: 1, status: 'confirmed' }, { expectedRevision: 0, idempotencyKey: 'k1' });
  assert.deepEqual(result, { recordId: 'r1', status: 'confirmed', revision: 1, replayed: false });
  assert.equal(pool.calls.at(-1).sql, 'COMMIT');
  assert.equal(pool.calls.filter((c) => c.sql.includes('INSERT INTO idempotency_results')).length, 1);
});

test('PostgreSQL confirmation replays a prior idempotency result without mutating record', async () => {
  const pool = new ScriptedPool([
    { match: 'BEGIN' }, { match: 'INSERT INTO idempotency_results', result: { rows: [], rowCount: 0 } },
    { match: 'SELECT record_id,result_json', result: { rows: [{ record_id: 'r1', result_json: { recordId: 'r1', status: 'confirmed', revision: 1 } }], rowCount: 1 } },
    { match: 'COMMIT' },
  ]);
  const result = await new PostgresRecordRepository({ pool }).confirmAtomically({ ...record, revision: 1, status: 'confirmed' }, { expectedRevision: 0, idempotencyKey: 'k1' });
  assert.equal(result.replayed, true);
  assert.equal(pool.calls.some((c) => c.sql.includes('UPDATE records')), false);
});

test('PostgreSQL migration runner uses advisory lock and applies versioned schema atomically', async () => {
  const pool = new ScriptedPool([
    { match: 'BEGIN' }, { match: 'pg_advisory_xact_lock' }, { match: 'CREATE TABLE IF NOT EXISTS schema_migrations' },
    { match: 'SELECT version FROM schema_migrations ORDER BY', result: { rows: [] } },
    ...POSTGRES_MIGRATIONS[0].statements.map((s) => ({ match: s.slice(0, 24) })),
    { match: 'INSERT INTO schema_migrations' }, { match: 'COMMIT' },
  ]);
  const result = await applyPostgresMigrations(pool);
  assert.deepEqual(result, { appliedThrough: 1 });
  assert.equal(pool.calls[1].sql, 'SELECT pg_advisory_xact_lock($1, $2)');
  assert.equal(pool.calls.at(-1).sql, 'COMMIT');
  assert.equal(pool.released, 1);
});

test('PostgreSQL migration runner refuses unsupported future schema and rolls back', async () => {
  const pool = new ScriptedPool([
    { match: 'BEGIN' }, { match: 'pg_advisory_xact_lock' }, { match: 'CREATE TABLE IF NOT EXISTS schema_migrations' },
    { match: 'SELECT version FROM schema_migrations ORDER BY', result: { rows: [{ version: 999 }] } },
    { match: 'ROLLBACK' },
  ]);
  await assert.rejects(() => applyPostgresMigrations(pool), /不支持的迁移版本/);
  assert.equal(pool.calls.at(-1).sql, 'ROLLBACK');
  assert.equal(pool.released, 1);
});


test('injected pool lifecycle is caller-owned by default and only ends when explicitly requested', async () => {
  const pool = new ScriptedPool();
  const repo = new PostgresRecordRepository({ pool });
  await repo.close();
  assert.equal(pool.ended, false);
  await repo.close({ endPool: true });
  assert.equal(pool.ended, true);
});

test('replace enforces immutable user ownership in SQL and does not rewrite user_id', async () => {
  const pool = new ScriptedPool([
    { match: 'BEGIN' }, { match: 'UPDATE records SET revision=', result: { rows: [{ record_id: 'r1' }], rowCount: 1 } },
    { match: 'INSERT INTO record_revisions' }, { match: 'COMMIT' },
  ]);
  await new PostgresRecordRepository({ pool }).replace({ ...record, revision: 1 }, { expectedRevision: 0 });
  const update = pool.calls.find((c) => c.sql.startsWith('UPDATE records'));
  assert.match(update.sql, /WHERE record_id=\$5 AND user_id=\$6 AND revision=\$7/);
  assert.doesNotMatch(update.sql, /SET user_id=/);
});

test('confirmation checks user ownership before updating and scopes update by user_id', async () => {
  const pool = new ScriptedPool([
    { match: 'BEGIN' }, { match: 'INSERT INTO idempotency_results', result: { rows: [{ idempotency_key: 'k1' }], rowCount: 1 } },
    { match: 'SELECT user_id,revision,status FROM records', result: { rows: [{ user_id: 'other-user', revision: 0, status: 'draft' }], rowCount: 1 } },
    { match: 'ROLLBACK' },
  ]);
  await assert.rejects(() => new PostgresRecordRepository({ pool }).confirmAtomically({ ...record, revision: 1, status: 'confirmed' }, { expectedRevision: 0, idempotencyKey: 'k1' }), { name: 'RecordNotFoundError' });
  assert.equal(pool.calls.some((c) => c.sql.startsWith('UPDATE records')), false);
  assert.equal(pool.calls.at(-1).sql, 'ROLLBACK');
});

test('list count rejects unsafe integer values instead of silently rounding', async () => {
  const pool = new ScriptedPool([
    { match: 'COUNT(*)::text', result: { rows: [{ total: '9007199254740993' }], rowCount: 1 } },
  ]);
  await assert.rejects(() => new PostgresRecordRepository({ pool }).listByUser({ userId: 'u1' }), RangeError);
});

test('migration runner rejects gaps in the applied migration history', async () => {
  const pool = new ScriptedPool([
    { match: 'BEGIN' }, { match: 'pg_advisory_xact_lock' }, { match: 'CREATE TABLE IF NOT EXISTS schema_migrations' },
    { match: 'SELECT version FROM schema_migrations ORDER BY', result: { rows: [{ version: 2 }] } },
    { match: 'ROLLBACK' },
  ]);
  await assert.rejects(() => applyPostgresMigrations(pool), /不支持的迁移版本/);
  assert.equal(pool.calls.at(-1).sql, 'ROLLBACK');
});
