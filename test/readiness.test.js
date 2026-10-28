import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteRecordRepository } from '../src/infrastructure/sqlite-record-repository.js';
import { InMemoryRecordRepository } from '../src/infrastructure/in-memory-record-repository.js';
import { PostgresRecordRepository } from '../src/infrastructure/postgres-record-repository.js';
import { inspectRecordRepository } from '../src/infrastructure/record-repository-contract.js';

function fakePool({ failQuery = false, schemaVersion = 1 } = {}) {
  return {
    async connect() { return { query: async () => ({ rows: [] }), release() {} }; },
    async query(sql) {
      if (failQuery) throw Object.assign(new Error('connect ECONNREFUSED postgres://u:p@h/db'), { code: 'ECONNREFUSED' });
      if (/schema_migrations/.test(sql)) return { rows: [{ version: schemaVersion === null ? null : String(schemaVersion) }] };
      return { rows: [{ '?column?': 1 }] };
    },
    async end() {},
  };
}

test('SQLite readiness reports backend and schema version', async () => {
  const repository = new SqliteRecordRepository({ filename: ':memory:' });
  try {
    const readiness = await repository.checkReadiness();
    assert.equal(readiness.ready, true);
    assert.equal(readiness.backend, 'sqlite');
    assert.equal(readiness.schemaVersion, 1);
    assert.ok(readiness.latencyMs >= 0);
  } finally { repository.close(); }
});

test('SQLite readiness fails closed after the connection is closed', async () => {
  const repository = new SqliteRecordRepository({ filename: ':memory:' });
  repository.close();
  const readiness = await repository.checkReadiness();
  assert.equal(readiness.ready, false);
  assert.equal(readiness.error, 'sqlite_unavailable');
});

test('in-memory readiness is ready and reports the memory backend', async () => {
  const readiness = await new InMemoryRecordRepository().checkReadiness();
  assert.deepEqual(readiness, { ready: true, backend: 'memory', schemaVersion: 1, latencyMs: 0 });
});

test('PostgreSQL readiness is ready when the pool answers and schema is supported', async () => {
  const repository = new PostgresRecordRepository({ pool: fakePool() });
  const readiness = await repository.checkReadiness();
  assert.equal(readiness.ready, true);
  assert.equal(readiness.backend, 'postgres');
  assert.equal(readiness.schemaVersion, 1);
});

test('PostgreSQL readiness fails closed on connection errors without leaking the URL', async () => {
  const repository = new PostgresRecordRepository({ pool: fakePool({ failQuery: true }) });
  const readiness = await repository.checkReadiness();
  assert.equal(readiness.ready, false);
  assert.equal(readiness.error, 'postgres_unavailable');
  assert.equal(readiness.schemaVersion, null);
  assert.ok(!JSON.stringify(readiness).includes('postgres://'));
});

test('PostgreSQL readiness fails closed for an unsupported or missing schema version', async () => {
  for (const schemaVersion of [0, 99, null]) {
    const repository = new PostgresRecordRepository({ pool: fakePool({ schemaVersion }) });
    const readiness = await repository.checkReadiness();
    assert.equal(readiness.ready, false, `schemaVersion=${schemaVersion}`);
    assert.equal(readiness.error, 'postgres_schema_unsupported');
  }
});

test('repository contract advertises readiness support without changing required data methods', () => {
  const sqlite = new SqliteRecordRepository({ filename: ':memory:' });
  try {
    const inspection = inspectRecordRepository(sqlite);
    assert.equal(inspection.ok, true);
    assert.equal(inspection.supportsReadiness, true);
    assert.equal(inspection.supportsAtomicConfirm, true);
    assert.equal(inspectRecordRepository({}).supportsReadiness, false);
  } finally { sqlite.close(); }
});
