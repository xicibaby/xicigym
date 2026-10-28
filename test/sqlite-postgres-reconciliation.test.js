import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReconciliationReport, reconcileSqliteToPostgres } from '../src/infrastructure/sqlite-postgres-reconciliation.js';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applySqliteMigrations } from '../src/infrastructure/sqlite-migrations.js';

const record = { record_id: 'r1', user_id: 'u1', revision: 1, status: 'draft', document_json: { recordId: 'r1', userId: 'u1', revision: 1, status: 'draft', payload: { b: 2, a: 1 } }, updated_at: '2026-10-25T01:00:00.000Z' };
const revision = { record_id: 'r1', revision: 1, reason: 'created', snapshot_json: record.document_json, created_at: '2026-10-25T01:00:00.000Z' };
const idem = { idempotency_key: 'i1', record_id: 'r1', result_json: { revision: 1, recordId: 'r1' }, created_at: '2026-10-25T01:00:00.000Z' };
const source = { records: [record], revisions: [revision], idempotency: [idem] };
const target = { records: [{ ...record, document_json: JSON.stringify({ status: 'draft', payload: { a: 1, b: 2 }, userId: 'u1', recordId: 'r1', revision: 1 }) }], revisions: [{ ...revision, snapshot_json: JSON.stringify(revision.snapshot_json) }], idempotency: [{ ...idem, result_json: JSON.stringify(idem.result_json) }] };

test('matching rows produce a deterministic clean reconciliation independent of JSON key order', () => {
  const report = buildReconciliationReport(source, target);
  assert.equal(report.match, true);
  assert.equal(report.mismatchCount, 0);
  assert.deepEqual(report.totals.source, { records: 1, revisions: 1, idempotency: 1 });
  assert.equal(report.tables.records.sourceHash, report.tables.records.targetHash);
});

test('reports missing, extra, and content-different rows with keyed SHA-256 evidence', () => {
  const bad = {
    records: [{ ...record, document_json: { ...record.document_json, payload: { a: 99 } } }, { ...record, record_id: 'extra' }],
    revisions: [],
    idempotency: [idem],
  };
  const report = buildReconciliationReport(source, bad);
  assert.equal(report.match, false);
  assert.equal(report.tables.records.different.length, 1);
  assert.equal(report.tables.records.extra.length, 1);
  assert.equal(report.tables.revisions.missing.length, 1);
  assert.equal(report.mismatchCount, 3);
  assert.match(report.tables.records.different[0].sourceHash, /^[a-f0-9]{64}$/);
});

test('read-only reconciliation queries the target and reports counts without writes', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'health-skill-reconcile-'));
  const filename = join(dir, 'source.sqlite');
  const db = new DatabaseSync(filename);
  applySqliteMigrations(db);
  db.prepare('INSERT INTO records(record_id,user_id,revision,status,document_json,updated_at) VALUES(?,?,?,?,?,?)').run('r1','u1',1,'draft',JSON.stringify(record.document_json),record.updated_at);
  db.prepare('INSERT INTO record_revisions(record_id,revision,reason,snapshot_json,created_at) VALUES(?,?,?,?,?)').run('r1',1,'created',JSON.stringify(record.document_json),record.updated_at);
  db.prepare('INSERT INTO idempotency_results(idempotency_key,record_id,result_json,created_at) VALUES(?,?,?,?)').run('i1','r1',JSON.stringify(idem.result_json),record.updated_at);
  db.close();
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  const calls = [];
  const pool = { async query(sql) { calls.push(sql); if (sql.includes('FROM records')) return { rows: target.records }; if (sql.includes('FROM record_revisions')) return { rows: target.revisions }; if (sql.includes('FROM idempotency_results')) return { rows: target.idempotency }; throw new Error('unexpected query'); } };
  const report = await reconcileSqliteToPostgres({ sqliteFilename: filename, pool });
  assert.equal(report.match, true);
  assert.equal(calls.length, 3);
  assert.ok(calls.every((sql) => /^SELECT\b/i.test(sql.trim())));
});

test('requires a PostgreSQL query-capable pool', async () => {
  await assert.rejects(reconcileSqliteToPostgres({ sqliteFilename: '/unused', pool: {} }), /pg-compatible PostgreSQL Pool/);
});
