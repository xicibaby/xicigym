import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryRecordRepository } from '../src/infrastructure/in-memory-record-repository.js';
import { SqliteRecordRepository } from '../src/infrastructure/sqlite-record-repository.js';
import { assertRecordRepository, inspectRecordRepository, RECORD_REPOSITORY_REQUIRED_METHODS } from '../src/infrastructure/record-repository-contract.js';

test('in-memory and SQLite adapters satisfy the shared repository port', () => {
  const memory = new InMemoryRecordRepository();
  const sqlite = new SqliteRecordRepository({ filename: ':memory:' });
  try {
    assert.equal(inspectRecordRepository(memory).ok, true);
    assert.equal(inspectRecordRepository(sqlite).ok, true);
    assert.equal(RECORD_REPOSITORY_REQUIRED_METHODS.length, 7);
    assert.equal(assertRecordRepository(sqlite, { requireAtomicConfirm: true }), sqlite);
    assert.throws(() => assertRecordRepository(memory, { requireAtomicConfirm: true }), /confirmAtomically/);
  } finally { sqlite.close(); }
});

test('repository contract rejects incomplete adapters with actionable method names', () => {
  assert.throws(() => assertRecordRepository({ get() {} }), /listByUser/);
});
