import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecordDraft, validateRecord } from '../src/record-contract.js';

const validInput = () => ({
  recordId: 'rec_test_001', userId: 'user_test_001', recordType: 'food', inputMethod: 'form',
  createdAt: '2026-10-25T10:00:00+08:00', updatedAt: '2026-10-25T10:00:00+08:00',
  payload: { mealType: 'lunch', items: [{ name: '米饭', quantity: 1, unit: '碗' }] },
  fieldEvidence: [
    { field: 'payload.items[0].name', trustLevel: 'user_confirmed', value: '米饭' },
    { field: 'payload.items[0].calories', trustLevel: 'estimated', value: 230, reason: '根据常见份量估算' }
  ]
});

test('accepts a valid draft and preserves user-provided fields', () => {
  const draft = createRecordDraft(validInput());
  assert.equal(draft.status, 'draft');
  assert.equal(draft.revision, 0);
  assert.equal(draft.payload.items[0].name, '米饭');
});

test('rejects unsupported record type', () => {
  const result = validateRecord({ ...validInput(), recordType: 'mood' });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === 'enum.recordType'));
});

test('rejects estimated values without a reason', () => {
  const input = validInput();
  input.fieldEvidence[1].reason = '';
  const result = validateRecord(input);
  assert.ok(result.errors.some((e) => e.code === 'estimated.reasonRequired'));
});

test('rejects datetimes without timezone', () => {
  const result = validateRecord({ ...validInput(), createdAt: '2026-10-25T10:00:00' });
  assert.ok(result.errors.some((e) => e.code === 'format.timezone'));
});

test('does not auto-fill absent payload/evidence', () => {
  const result = validateRecord({ ...validInput(), payload: undefined, fieldEvidence: undefined });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.path === 'payload'));
  assert.ok(result.errors.some((e) => e.path === 'fieldEvidence'));
});

test('rejects a non-null value marked as missing', () => {
  const input = validInput();
  input.fieldEvidence.push({ field: 'payload.waterMl', trustLevel: 'missing', value: 500 });
  const result = validateRecord(input);
  assert.ok(result.errors.some((e) => e.code === 'missing.valueMustBeNull'));
});
