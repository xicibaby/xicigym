import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteRecordRepository } from '../src/infrastructure/sqlite-record-repository.js';
import { RecordService, RecordConflictError } from '../src/application/record-service.js';
const input=()=>({recordId:'sqlite_rec_01',userId:'user_01',recordType:'food',inputMethod:'text',createdAt:'2026-10-25T10:00:00+08:00',updatedAt:'2026-10-25T10:00:00+08:00',payload:{mealType:'lunch',note:'鸡蛋和米饭'},fieldEvidence:[{field:'payload.note',trustLevel:'user_confirmed',value:'鸡蛋和米饭'}]});
test('SQLite persists records and history across repository instances',async()=>{const db=new DatabaseSync(':memory:');const a=new SqliteRecordRepository({database:db});const svc=new RecordService(a);await svc.createDraft(input());await svc.updateDraft('sqlite_rec_01',{payload:{mealType:'lunch',note:'更新后的午餐'}},0);const b=new SqliteRecordRepository({database:db});assert.equal((await b.get('sqlite_rec_01')).payload.note,'更新后的午餐');assert.equal((await b.getHistory('sqlite_rec_01')).length,2);a.close();});
test('confirm and idempotency result are atomic and replayed',async()=>{const repo=new SqliteRecordRepository({database:new DatabaseSync(':memory:')});const svc=new RecordService(repo);await svc.createDraft(input());const one=await svc.confirmRecord('sqlite_rec_01',{expectedRevision:0,idempotencyKey:'sqlite-confirm-1'});const two=await svc.confirmRecord('sqlite_rec_01',{expectedRevision:0,idempotencyKey:'sqlite-confirm-1'});assert.equal(one.replayed,false);assert.equal(two.replayed,true);assert.equal((await repo.getHistory('sqlite_rec_01')).length,2);assert.equal((await repo.get('sqlite_rec_01')).status,'confirmed');repo.close();});
test('SQLite rejects stale writes',async()=>{const repo=new SqliteRecordRepository({database:new DatabaseSync(':memory:')});const svc=new RecordService(repo);await svc.createDraft(input());await svc.updateDraft('sqlite_rec_01',{payload:{note:'first edit'}},0);await assert.rejects(()=>svc.updateDraft('sqlite_rec_01',{payload:{note:'stale edit'}},0),RecordConflictError);assert.equal((await svc.getRecord('sqlite_rec_01')).payload.note,'first edit');repo.close();});

test('SQLite file survives closing and reopening the database',async()=>{const dir=await mkdtemp(join(tmpdir(),'health-records-'));const filename=join(dir,'records.sqlite');try{let repo=new SqliteRecordRepository({filename});let svc=new RecordService(repo);await svc.createDraft(input());repo.close();repo=new SqliteRecordRepository({filename});assert.equal((await repo.get('sqlite_rec_01')).status,'draft');assert.equal((await repo.getHistory('sqlite_rec_01')).length,1);repo.close();}finally{await rm(dir,{recursive:true,force:true});}});

test('SQLite list is user-scoped, filterable, and paginated',async()=>{
  const repo=new SqliteRecordRepository({database:new DatabaseSync(':memory:')});
  const svc=new RecordService(repo);
  await svc.createDraft(input());
  await svc.createDraft({...input(),recordId:'sqlite_rec_02',userId:'user_02',recordType:'body_checkin',payload:{energy:4},fieldEvidence:[]});
  const own=await svc.listRecords({userId:'user_01',limit:10,offset:0});
  assert.equal(own.total,1); assert.equal(own.items[0].userId,'user_01');
  const filtered=await svc.listRecords({userId:'user_02',recordType:'body_checkin',limit:10,offset:0});
  assert.equal(filtered.total,1); assert.equal(filtered.items[0].recordType,'body_checkin');
  repo.close();
});


test('SQLite schema migrations are versioned and idempotent', async () => {
  const db = new DatabaseSync(':memory:');
  const repo = new SqliteRecordRepository({ database: db });
  const first = db.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all();
  assert.deepEqual(first.map((row) => row.version), [1]);
  assert.equal(first[0].name, 'initial_record_storage');
  const repoAgain = new SqliteRecordRepository({ database: db });
  const second = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all();
  assert.deepEqual(second.map((row) => row.version), [1]);
  repoAgain.close();
});

test('SQLite refuses to open a database migrated by a newer unsupported code version', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT 'now'); INSERT INTO schema_migrations(version, name) VALUES(999, 'future_migration');`);
  assert.throws(() => new SqliteRecordRepository({ database: db }), /高于当前代码支持的最高迁移版本/);
  db.close();
});
