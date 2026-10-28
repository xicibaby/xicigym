import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryRecordRepository } from '../src/infrastructure/in-memory-record-repository.js';
import { RecordConflictError, RecordService, RecordStateError } from '../src/application/record-service.js';

const makeService = () => new RecordService(new InMemoryRecordRepository());
const input = () => ({ recordId: 'rec_flow_01', userId: 'user_01', recordType: 'food', inputMethod: 'text',
  createdAt: '2026-10-25T10:00:00+08:00', updatedAt: '2026-10-25T10:00:00+08:00',
  payload: { mealType: 'lunch', note: '鸡蛋和米饭' },
  fieldEvidence: [{ field: 'payload.note', trustLevel: 'user_confirmed', value: '鸡蛋和米饭' }] });

test('creates, reads, and edits a draft with optimistic revision checks', async () => {
  const service = makeService();
  const created = await service.createDraft(input());
  assert.equal((await service.getRecord(created.recordId)).status, 'draft');
  const edited = await service.updateDraft(created.recordId, { payload: { mealType: 'lunch', note: '鸡蛋、米饭和青菜' } }, 0);
  assert.equal(edited.revision, 1);
  await assert.rejects(() => service.updateDraft(created.recordId, { payload: { note: '旧版本' } }, 0), RecordConflictError);
});

test('confirm is idempotent and cannot be used across record IDs', async () => {
  const service = makeService(); await service.createDraft(input());
  const first = await service.confirmRecord('rec_flow_01', { expectedRevision: 0, idempotencyKey: 'confirm-001' });
  const second = await service.confirmRecord('rec_flow_01', { expectedRevision: 0, idempotencyKey: 'confirm-001' });
  assert.equal(first.status, 'confirmed'); assert.equal(second.replayed, true);
  await assert.rejects(() => service.confirmRecord('other-id', { expectedRevision: 0, idempotencyKey: 'confirm-001' }), RecordConflictError);
});

test('confirmed records require correction workflow, and revision history is preserved', async () => {
  const service = makeService(); await service.createDraft(input());
  await service.confirmRecord('rec_flow_01', { expectedRevision: 0, idempotencyKey: 'confirm-002' });
  await assert.rejects(() => service.updateDraft('rec_flow_01', { payload: { note: 'edit' } }, 1), RecordStateError);
  const corrected = await service.correctRecord('rec_flow_01', { payload: { mealType: 'lunch', note: '用户修正后的描述' } }, { expectedRevision: 1 });
  assert.equal(corrected.revision, 2);
  const history = await service.getHistory('rec_flow_01');
  assert.equal(history.length, 3);
  assert.equal(history[2].reason, 'user_correction');
});

test('restores a prior snapshot as a new revision instead of deleting history', async () => {
  const service = makeService(); await service.createDraft(input());
  await service.updateDraft('rec_flow_01', { payload: { mealType: 'lunch', note: 'edited' } }, 0);
  const restored = await service.restoreRevision('rec_flow_01', 0, { expectedRevision: 1 });
  assert.equal(restored.revision, 2);
  assert.equal(restored.payload.note, '鸡蛋和米饭');
  assert.equal((await service.getHistory('rec_flow_01')).length, 3);
});

test('allows a partial draft but refuses confirmation until record-type minimum content exists', async () => {
  const service = makeService();
  await service.createDraft({ ...input(), payload: {}, fieldEvidence: [] });
  await assert.rejects(
    () => service.confirmRecord('rec_flow_01', { expectedRevision: 0, idempotencyKey: 'confirm-incomplete' }),
    (error) => error.name === 'RecordValidationError' && error.details.some((item) => item.code === 'required.foodDescription')
  );
});


test('concurrent draft edits with the same expected revision allow only one winner', async () => {
  const service = makeService();
  await service.createDraft(input());
  const outcomes = await Promise.allSettled([
    service.updateDraft('rec_flow_01', { payload: { mealType: 'lunch', note: '并发修改 A' } }, 0),
    service.updateDraft('rec_flow_01', { payload: { mealType: 'lunch', note: '并发修改 B' } }, 0)
  ]);
  assert.equal(outcomes.filter((item) => item.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter((item) => item.status === 'rejected').length, 1);
  const rejected = outcomes.find((item) => item.status === 'rejected');
  assert.equal(rejected.reason.name, 'RecordConflictError');
  const history = await service.getHistory('rec_flow_01');
  assert.equal(history.length, 2);
});
