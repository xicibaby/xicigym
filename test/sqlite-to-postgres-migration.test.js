import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { applySqliteMigrations } from '../src/infrastructure/sqlite-migrations.js';
import { inspectSqliteSource, migrateSqliteToPostgres } from '../src/infrastructure/sqlite-to-postgres-migration.js';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'health-skill-migrate-'));
  const file = join(dir, 'source.sqlite');
  const db = new DatabaseSync(file);
  applySqliteMigrations(db);
  const record = { recordId: 'rec-1', userId: 'user-1', revision: 1, status: 'draft', recordType: 'food', inputMethod: 'text', trustLevel: 'user_confirmed', createdAt: '2026-10-25T01:00:00.000Z', updatedAt: '2026-10-25T01:00:00.000Z', payload: { food: 'rice' } };
  db.prepare('INSERT INTO records(record_id,user_id,revision,status,document_json,updated_at) VALUES(?,?,?,?,?,?)').run(record.recordId,record.userId,record.revision,record.status,JSON.stringify(record),record.updatedAt);
  db.prepare('INSERT INTO record_revisions(record_id,revision,reason,snapshot_json,created_at) VALUES(?,?,?,?,?)').run(record.recordId,record.revision,'created',JSON.stringify(record),'2026-10-25T01:00:00.000Z');
  db.prepare('INSERT INTO idempotency_results(idempotency_key,record_id,result_json,created_at) VALUES(?,?,?,?)').run('idem-1','rec-1',JSON.stringify({recordId:'rec-1',status:'draft',revision:1}),'2026-10-25T01:00:00.000Z');
  db.close();
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  return { file, record };
}

test('inspect validates and counts records, revisions and idempotency without modifying source', async (t) => {
  const { file } = await fixture(t);
  const before = (await inspectSqliteSource(file)).counts;
  assert.deepEqual(before, { records: 1, revisions: 1, idempotency: 1 });
  const db = new DatabaseSync(file, { readOnly: true });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM records').get().n, 1);
  db.close();
});

test('dry run validates source and does not require or call PostgreSQL', async (t) => {
  const { file } = await fixture(t);
  const result = await migrateSqliteToPostgres({ sqliteFilename: file, pool: null, dryRun: true });
  assert.equal(result.dryRun, true);
  assert.deepEqual(result.sourceCounts, { records: 1, revisions: 1, idempotency: 1 });
  assert.equal(result.targetCounts, null);
});

test('refuses source rows whose JSON document disagrees with indexed columns', async (t) => {
  const { file } = await fixture(t);
  const db = new DatabaseSync(file);
  db.prepare('UPDATE records SET user_id=? WHERE record_id=?').run('wrong-user','rec-1');
  db.close();
  await assert.rejects(inspectSqliteSource(file), /列值与 document_json 不一致/);
});

test('refuses missing SQLite source instead of creating an empty database', async () => {
  await assert.rejects(inspectSqliteSource('/definitely/missing/health-records.sqlite'), /找不到 SQLite 数据库文件/);
});
