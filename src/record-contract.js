import { validateRecordPayload } from './record-payload-schemas.js';

/**
 * Portable reference contract for the Health & Exercise Skill unified-record module.
 * No third-party dependencies. This file validates runtime input; it is not a database adapter.
 */

export const RECORD_TYPES = Object.freeze([
  'food', 'training', 'body_checkin', 'posture', 'extra_activity'
]);
export const RECORD_STATUSES = Object.freeze(['draft', 'confirmed', 'archived']);
export const INPUT_METHODS = Object.freeze(['text', 'voice', 'photo', 'form']);
export const TRUST_LEVELS = Object.freeze(['user_confirmed', 'calculated', 'estimated', 'missing', 'unknown']);

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isNonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0;
const isIsoDate = (value) => typeof value === 'string' && !Number.isNaN(Date.parse(value)) && /^\d{4}-\d{2}-\d{2}T/.test(value);
const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

/** Return { ok, errors, value }. Never silently repairs or fills missing values. */
export function validateRecord(input, { requireComplete = false } = {}) {
  const errors = [];
  if (!isObject(input)) return { ok: false, errors: [{ path: '$', code: 'type.object', message: '记录必须是对象。' }] };

  const requiredStrings = ['recordId', 'userId', 'recordType', 'status', 'inputMethod', 'createdAt', 'updatedAt'];
  for (const key of requiredStrings) {
    if (!isNonEmptyString(input[key])) errors.push({ path: key, code: 'required.string', message: `${key} 必须是非空字符串。` });
  }
  if (isNonEmptyString(input.recordType) && !RECORD_TYPES.includes(input.recordType)) {
    errors.push({ path: 'recordType', code: 'enum.recordType', message: `recordType 必须是：${RECORD_TYPES.join(', ')}。` });
  }
  if (isNonEmptyString(input.status) && !RECORD_STATUSES.includes(input.status)) {
    errors.push({ path: 'status', code: 'enum.status', message: `status 必须是：${RECORD_STATUSES.join(', ')}。` });
  }
  if (isNonEmptyString(input.inputMethod) && !INPUT_METHODS.includes(input.inputMethod)) {
    errors.push({ path: 'inputMethod', code: 'enum.inputMethod', message: `inputMethod 必须是：${INPUT_METHODS.join(', ')}。` });
  }
  for (const key of ['createdAt', 'updatedAt']) {
    if (hasOwn(input, key) && !isIsoDate(input[key])) errors.push({ path: key, code: 'format.datetime', message: `${key} 必须是带时区信息的 ISO 8601 日期时间。` });
    if (isIsoDate(input[key]) && !/(Z|[+-]\d{2}:\d{2})$/.test(input[key])) {
      errors.push({ path: key, code: 'format.timezone', message: `${key} 必须包含时区，例如 Z 或 +08:00。` });
    }
  }
  if (hasOwn(input, 'schemaVersion') && (!Number.isInteger(input.schemaVersion) || input.schemaVersion < 1)) {
    errors.push({ path: 'schemaVersion', code: 'number.positiveInteger', message: 'schemaVersion 必须是大于等于 1 的整数。' });
  }
  if (hasOwn(input, 'revision') && (!Number.isInteger(input.revision) || input.revision < 0)) {
    errors.push({ path: 'revision', code: 'number.nonNegativeInteger', message: 'revision 必须是大于等于 0 的整数。' });
  }
  if (!isObject(input.payload)) errors.push({ path: 'payload', code: 'type.object', message: 'payload 必须是对象；未知字段不应伪装成已确认值。' });
  else if (isNonEmptyString(input.recordType) && RECORD_TYPES.includes(input.recordType)) {
    errors.push(...validateRecordPayload(input.recordType, input.payload, { requireComplete }));
  }
  if (!Array.isArray(input.fieldEvidence)) {
    errors.push({ path: 'fieldEvidence', code: 'type.array', message: 'fieldEvidence 必须是数组，用于标注字段可信度。' });
  } else {
    input.fieldEvidence.forEach((entry, index) => {
      const path = `fieldEvidence[${index}]`;
      if (!isObject(entry)) {
        errors.push({ path, code: 'type.object', message: '字段可信度条目必须是对象。' });
        return;
      }
      if (!isNonEmptyString(entry.field)) errors.push({ path: `${path}.field`, code: 'required.string', message: 'field 必须是非空字符串。' });
      if (!TRUST_LEVELS.includes(entry.trustLevel)) errors.push({ path: `${path}.trustLevel`, code: 'enum.trustLevel', message: `trustLevel 必须是：${TRUST_LEVELS.join(', ')}。` });
      if (entry.trustLevel === 'estimated' && !isNonEmptyString(entry.reason)) {
        errors.push({ path: `${path}.reason`, code: 'estimated.reasonRequired', message: '估算值必须说明估算依据或原因。' });
      }
      if (entry.trustLevel === 'missing' && hasOwn(entry, 'value') && entry.value !== null) {
        errors.push({ path: `${path}.value`, code: 'missing.valueMustBeNull', message: 'missing 字段的 value 必须为 null 或省略，不可伪造数值。' });
      }
    });
  }
  if (hasOwn(input, 'metadata') && !isObject(input.metadata)) errors.push({ path: 'metadata', code: 'type.object', message: 'metadata 必须是对象。' });

  return { ok: errors.length === 0, errors, value: errors.length === 0 ? structuredClone(input) : undefined };
}

/** Build a new draft only from explicit caller-provided data; does not infer missing fields. */
export function createRecordDraft(input) {
  const draft = {
    schemaVersion: 1,
    recordId: input?.recordId,
    userId: input?.userId,
    recordType: input?.recordType,
    status: 'draft',
    inputMethod: input?.inputMethod,
    createdAt: input?.createdAt,
    updatedAt: input?.updatedAt,
    revision: 0,
    payload: input?.payload,
    fieldEvidence: input?.fieldEvidence,
    metadata: input?.metadata ?? {}
  };
  const result = validateRecord(draft);
  if (!result.ok) {
    const error = new Error('记录草稿校验失败');
    error.name = 'RecordValidationError';
    error.details = result.errors;
    throw error;
  }
  return result.value;
}
