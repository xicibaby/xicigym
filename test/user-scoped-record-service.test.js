import test from 'node:test';
import assert from 'node:assert/strict';
import { RecordService } from '../src/application/record-service.js';
import { UserScopedRecordService } from '../src/application/user-scoped-record-service.js';
import { InMemoryRecordRepository } from '../src/infrastructure/in-memory-record-repository.js';

const ts = '2026-10-25T09:00:00+08:00';
const draft = (recordId, userId = 'attacker') => ({ recordId, userId, recordType: 'food', inputMethod: 'text', createdAt: ts, updatedAt: ts, payload: { note: 'lunch' }, fieldEvidence: [{ field: 'note', trustLevel: 'user_confirmed', value: 'lunch' }] });
function setup() { return new UserScopedRecordService(new RecordService(new InMemoryRecordRepository())); }

test('create always binds record to authenticated principal, ignores body userId', async () => {
  const svc = setup(); const saved = await svc.createDraft({ userId: 'alice' }, draft('r1', 'bob'));
  assert.equal(saved.userId, 'alice');
});
test('foreign user sees not-found and cannot read record', async () => {
  const svc = setup(); await svc.createDraft({ userId: 'alice' }, draft('r1'));
  await assert.rejects(() => svc.getRecord({ userId: 'bob' }, 'r1'), { name: 'RecordNotFoundError' });
});
test('foreign user cannot mutate record', async () => {
  const svc = setup(); await svc.createDraft({ userId: 'alice' }, draft('r1'));
  await assert.rejects(() => svc.updateDraft({ userId: 'bob' }, 'r1', { payload: { note: 'hack' } }, 0), { name: 'RecordNotFoundError' });
  assert.equal((await svc.getRecord({ userId: 'alice' }, 'r1')).payload.note, 'lunch');
});
test('missing principal fails closed', async () => {
  const svc = setup(); await assert.rejects(() => svc.createDraft(null, draft('r1')), { name: 'UnauthenticatedError' });
});
