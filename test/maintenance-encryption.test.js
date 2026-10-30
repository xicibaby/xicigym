import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { randomUUID as uuid } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteRecordRepository } from '../src/infrastructure/sqlite-record-repository.js';
import { RecordService } from '../src/application/record-service.js';
import { runMaintenance } from '../src/maintenance.js';

const key = randomBytes(32).toString('base64');
const input = (recordId) => ({
  recordId, userId: 'maint_user', recordType: 'food', inputMethod: 'text',
  createdAt: '2026-10-28T10:00:00+08:00', updatedAt: '2026-10-28T10:00:00+08:00',
  payload: { mealType: 'lunch', note: '加密备份测试' },
  fieldEvidence: [{ field: 'payload.note', trustLevel: 'user_confirmed' }],
});
const quiet = { log() {}, error() {} };

test('encrypted SQLite backup can be inspected and restored only with the right key', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'health-encrypted-backup-'));
  const source = join(dir, 'source.sqlite');
  const backupPath = join(dir, 'backup.sqlite.enc');
  const restored = join(dir, 'restored.sqlite');
  try {
    const repo = new SqliteRecordRepository({ filename: source });
    const service = new RecordService(repo);
    await service.createDraft(input('maint_rec_01'));
    await service.updateDraft('maint_rec_01', { payload: { mealType: 'lunch', note: '修订后的午餐' } }, 0);
    repo.close();

    const backupReport = await runMaintenance(['backup', source, backupPath], { logger: quiet, env: { BACKUP_ENCRYPTION_KEY: key } });
    assert.equal(backupReport.encrypted, true);
    assert.equal(backupReport.integrity[0], 'ok');
    const raw = await import('node:fs/promises').then((fs) => fs.readFile(backupPath));
    assert.equal(raw.subarray(0, 4).toString('latin1'), 'HSB1');

    const checkReport = await runMaintenance(['check', backupPath], { logger: quiet, env: { BACKUP_ENCRYPTION_KEY: key } });
    assert.equal(checkReport.ok, true);
    assert.equal(checkReport.encrypted, true);

    await assert.rejects(
      () => runMaintenance(['restore', backupPath, join(dir, 'restored-wrong-key.sqlite')], { logger: quiet, env: { BACKUP_ENCRYPTION_KEY: randomBytes(32).toString('base64') } }),
      /解密失败/,
    );

    const restoreReport = await runMaintenance(['restore', backupPath, restored], { logger: quiet, env: { BACKUP_ENCRYPTION_KEY: key } });
    assert.equal(restoreReport.encrypted, true);

    const restoredRepo = new SqliteRecordRepository({ filename: restored });
    assert.equal((await restoredRepo.get('maint_rec_01')).payload.note, '修订后的午餐');
    assert.equal((await restoredRepo.getHistory('maint_rec_01')).length, 2);
    restoredRepo.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('encrypted backup refuses to overwrite an existing destination', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'health-encrypted-no-overwrite-'));
  const source = join(dir, 'source.sqlite');
  const target = join(dir, 'backup.sqlite.enc');
  try {
    const db = new DatabaseSync(source);
    const repo = new SqliteRecordRepository({ database: db });
    await writeFile(target, 'existing');
    await assert.rejects(
      () => runMaintenance(['backup', source, target], { logger: quiet, env: { BACKUP_ENCRYPTION_KEY: key } }),
      /EEXIST|已存在/,
    );
    repo.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('encrypted backup requires key material to restore', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'health-encrypted-needs-key-'));
  const source = join(dir, 'source.sqlite');
  const backupPath = join(dir, 'backup.sqlite.enc');
  try {
    const repo = new SqliteRecordRepository({ filename: source });
    repo.close();
    await runMaintenance(['backup', source, backupPath], { logger: quiet, env: { BACKUP_ENCRYPTION_KEY: key } });
    await assert.rejects(
      () => runMaintenance(['restore', backupPath, join(dir, 'restored.sqlite')], { logger: quiet, env: {} }),
      /备份已加密/,
    );
  } finally { await rm(dir, { recursive: true, force: true }); }
});
