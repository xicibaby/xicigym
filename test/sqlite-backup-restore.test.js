import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteRecordRepository } from '../src/infrastructure/sqlite-record-repository.js';
import { RecordService } from '../src/application/record-service.js';
import { createSqliteBackup, inspectSqliteDatabase, restoreSqliteBackup } from '../src/infrastructure/sqlite-backup.js';

const input = (recordId='backup_rec_01') => ({
  recordId, userId: 'backup_user', recordType: 'food', inputMethod: 'text',
  createdAt: '2026-10-25T10:00:00+08:00', updatedAt: '2026-10-25T10:00:00+08:00',
  payload: { mealType: 'lunch', note: '米饭和鸡蛋' },
  fieldEvidence: [{ field: 'payload.note', trustLevel: 'user_confirmed', value: '米饭和鸡蛋' }],
});

test('consistent backup restores records, history and idempotency state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'health-backup-'));
  const source = join(dir, 'source.sqlite');
  const backupPath = join(dir, 'backups', 'snapshot.sqlite');
  const restored = join(dir, 'restored.sqlite');
  try {
    const repo = new SqliteRecordRepository({ filename: source });
    const service = new RecordService(repo);
    await service.createDraft(input());
    await service.updateDraft('backup_rec_01', { payload: { mealType: 'lunch', note: '已修订的午餐' } }, 0);
    const result = await createSqliteBackup({ database: repo.db, destination: backupPath });
    assert.ok(result.bytes > 0);
    assert.deepEqual(result.integrity, ['ok']);
    repo.close();

    const restoreResult = await restoreSqliteBackup({ backupFilename: backupPath, destination: restored });
    assert.equal(restoreResult.schemaVersion, 1);
    const restoredRepo = new SqliteRecordRepository({ filename: restored });
    assert.equal((await restoredRepo.get('backup_rec_01')).payload.note, '已修订的午餐');
    assert.equal((await restoredRepo.getHistory('backup_rec_01')).length, 2);
    restoredRepo.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('backup refuses to overwrite an existing backup', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'health-backup-no-overwrite-'));
  const db = new DatabaseSync(join(dir, 'source.sqlite'));
  const target = join(dir, 'backup.sqlite');
  try {
    const repo = new SqliteRecordRepository({ database: db });
    await createSqliteBackup({ database: db, destination: target });
    await assert.rejects(() => createSqliteBackup({ database: db, destination: target }), /备份目标已存在/);
    repo.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('restore refuses to overwrite an existing destination', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'health-restore-no-overwrite-'));
  const db = new DatabaseSync(join(dir, 'source.sqlite'));
  const backupPath = join(dir, 'backup.sqlite');
  const destination = join(dir, 'existing.sqlite');
  try {
    const repo = new SqliteRecordRepository({ database: db });
    await createSqliteBackup({ database: db, destination: backupPath });
    await writeFile(destination, 'keep-existing-file');
    await assert.rejects(() => restoreSqliteBackup({ backupFilename: backupPath, destination }), /恢复目标已存在/);
    repo.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('restore rejects a corrupted backup before creating the target', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'health-restore-corrupt-'));
  const corrupted = join(dir, 'corrupt.sqlite');
  const destination = join(dir, 'restored.sqlite');
  try {
    await writeFile(corrupted, 'not a sqlite database');
    await assert.rejects(() => restoreSqliteBackup({ backupFilename: corrupted, destination }));
    await assert.rejects(() => import('node:fs/promises').then(({ access }) => access(destination)), { code: 'ENOENT' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('database inspector validates schema and integrity', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'health-inspect-'));
  const filename = join(dir, 'valid.sqlite');
  try {
    const repo = new SqliteRecordRepository({ filename });
    repo.close();
    const report = await inspectSqliteDatabase(filename);
    assert.equal(report.ok, true);
    assert.deepEqual(report.integrity, ['ok']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
