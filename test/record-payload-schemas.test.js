import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRecordPayload } from '../src/record-payload-schemas.js';

const validPayloads = {
  food: { mealType: 'lunch', items: [{ name: '米饭', quantity: 1, unit: '碗', caloriesKcal: 230 }] },
  training: { activityType: 'strength', exercises: [{ name: '深蹲', sets: 3, reps: 10 }] },
  body_checkin: { sleepHours: 7.5, energy: 4, fatigue: 2, painLevel: 0 },
  posture: { visibleFeatures: ['肩部轻微不对称'], limitations: '仅为可见特征观察' },
  extra_activity: { activityType: 'walking', durationMinutes: 25, intensity: 'moderate' }
};

test('accepts complete payloads for all five record types', () => {
  for (const [type, payload] of Object.entries(validPayloads)) {
    assert.deepEqual(validateRecordPayload(type, payload, { requireComplete: true }), [], `${type} should validate`);
  }
});

test('allows an empty partial payload while a draft is being filled', () => {
  for (const type of Object.keys(validPayloads)) assert.deepEqual(validateRecordPayload(type, {}), []);
});

test('requires meaningful content when confirming each record type', () => {
  for (const type of Object.keys(validPayloads)) {
    assert.ok(validateRecordPayload(type, {}, { requireComplete: true }).length > 0, `${type} should require content`);
  }
});

test('rejects invalid nutrition amounts and unknown food fields', () => {
  const errors = validateRecordPayload('food', { items: [{ name: '米饭', quantity: -1, unit: '碗', caloires: 230 }] });
  assert.ok(errors.some((e) => e.code === 'number.positive'));
  assert.ok(errors.some((e) => e.code === 'property.unknown'));
});

test('rejects out-of-range body check-in values', () => {
  const errors = validateRecordPayload('body_checkin', { sleepHours: 27, energy: 7, painLevel: -1 });
  assert.equal(errors.filter((e) => e.code === 'number.range').length, 3);
});

test('rejects diagnostic conclusions in posture payloads', () => {
  const errors = validateRecordPayload('posture', { visibleFeatures: ['肩部不对称'], diagnosis: '脊柱侧弯' });
  assert.ok(errors.some((e) => e.code === 'safety.prohibitedConclusion'));
});

test('rejects malformed exercise sets and activity duration', () => {
  assert.ok(validateRecordPayload('training', { activityType: 'strength', exercises: [{ name: '深蹲', sets: -2 }] }).some((e) => e.code === 'number.nonNegativeInteger'));
  assert.ok(validateRecordPayload('extra_activity', { activityType: 'walking', durationMinutes: 0 }, { requireComplete: true }).some((e) => e.code === 'required.positiveNumber'));
});
