/**
 * Dependency-free runtime schemas for the five supported record payloads.
 * Drafts may be partial; confirmation uses requireComplete=true.
 * Unknown keys are rejected to catch typos instead of silently persisting them.
 */
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && value.trim().length > 0;
const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

const definitions = {
  food: {
    allowed: ['mealType', 'items', 'note', 'notes', 'consumedAt'],
    complete: (p) => [
      ...(!((Array.isArray(p.items) && p.items.length > 0) || isText(p.note) || isText(p.notes)) ? [{ path: 'items', code: 'required.foodDescription', message: '确认饮食记录需要至少一项食物，或一段明确的饮食描述。' }] : []),
    ],
    validate(p, errors) {
      enumValue(p, 'mealType', ['breakfast', 'lunch', 'dinner', 'snack', 'other'], errors);
      textField(p, 'note', errors);
      textField(p, 'notes', errors);
      dateTimeField(p, 'consumedAt', errors);
      if (hasOwn(p, 'items')) {
        if (!Array.isArray(p.items)) add(errors, 'items', 'type.array', 'items 必须是数组。');
        else p.items.forEach((item, i) => {
          const path = `items[${i}]`;
          if (!isObject(item)) { add(errors, path, 'type.object', '食物条目必须是对象。'); return; }
          unknownKeys(item, ['name', 'quantity', 'unit', 'caloriesKcal', 'proteinG', 'carbsG', 'fatG', 'brand'], path, errors);
          requiredText(item, 'name', path, errors);
          if (hasOwn(item, 'quantity')) positiveNumber(item, 'quantity', path, errors);
          if (hasOwn(item, 'unit')) requiredText(item, 'unit', path, errors);
          for (const key of ['caloriesKcal', 'proteinG', 'carbsG', 'fatG']) if (hasOwn(item, key)) nonNegativeNumber(item, key, path, errors);
          textField(item, 'brand', errors, path);
        });
      }
    }
  },
  training: {
    allowed: ['activityType', 'exercises', 'durationMinutes', 'intensity', 'perceivedExertion', 'painReported', 'painNotes', 'notes', 'startedAt', 'endedAt', 'equipment'],
    complete: (p) => {
      const errors = [];
      if (!isText(p.activityType)) add(errors, 'activityType', 'required.string', '确认训练记录需要 activityType。');
      const hasExercises = Array.isArray(p.exercises) && p.exercises.length > 0;
      const hasDuration = isFiniteNumber(p.durationMinutes) && p.durationMinutes > 0;
      if (!hasExercises && !hasDuration) add(errors, 'exercises', 'required.trainingContent', '确认训练记录需要至少一项训练动作或有效训练时长。');
      return errors;
    },
    validate(p, errors) {
      requiredTextIfPresent(p, 'activityType', errors);
      positiveNumberIfPresent(p, 'durationMinutes', errors);
      enumValue(p, 'intensity', ['low', 'moderate', 'high', 'unknown'], errors);
      rangeNumber(p, 'perceivedExertion', 1, 10, errors);
      booleanField(p, 'painReported', errors);
      for (const key of ['painNotes', 'notes', 'equipment']) textField(p, key, errors);
      for (const key of ['startedAt', 'endedAt']) dateTimeField(p, key, errors);
      if (hasOwn(p, 'exercises')) {
        if (!Array.isArray(p.exercises)) add(errors, 'exercises', 'type.array', 'exercises 必须是数组。');
        else p.exercises.forEach((exercise, i) => {
          const path = `exercises[${i}]`;
          if (!isObject(exercise)) { add(errors, path, 'type.object', '训练动作必须是对象。'); return; }
          unknownKeys(exercise, ['name', 'sets', 'reps', 'loadKg', 'intensity', 'restSeconds', 'completed'], path, errors);
          requiredText(exercise, 'name', path, errors);
          for (const key of ['sets', 'reps', 'restSeconds']) if (hasOwn(exercise, key)) nonNegativeInteger(exercise, key, path, errors);
          if (hasOwn(exercise, 'loadKg')) nonNegativeNumber(exercise, 'loadKg', path, errors);
          if (hasOwn(exercise, 'intensity') && !isText(exercise.intensity)) add(errors, `${path}.intensity`, 'type.string', '动作强度必须是非空字符串。');
          if (hasOwn(exercise, 'completed') && typeof exercise.completed !== 'boolean') add(errors, `${path}.completed`, 'type.boolean', 'completed 必须是布尔值。');
        });
      }
    }
  },
  body_checkin: {
    allowed: ['sleepHours', 'sleepQuality', 'energy', 'fatigue', 'painLevel', 'recovery', 'soreness', 'notes', 'checkedAt'],
    complete: (p) => Object.keys(p).some((key) => ['sleepHours', 'sleepQuality', 'energy', 'fatigue', 'painLevel', 'recovery', 'soreness', 'notes'].includes(key))
      ? [] : [{ path: 'payload', code: 'required.checkinSignal', message: '确认身体签到至少需要一项状态指标或备注。' }],
    validate(p, errors) {
      rangeNumber(p, 'sleepHours', 0, 24, errors);
      for (const key of ['sleepQuality', 'energy', 'fatigue', 'recovery', 'soreness']) rangeNumber(p, key, 1, 5, errors);
      rangeNumber(p, 'painLevel', 0, 10, errors);
      textField(p, 'notes', errors);
      dateTimeField(p, 'checkedAt', errors);
    }
  },
  posture: {
    allowed: ['photoRefs', 'visibleFeatures', 'notes', 'standardPhoto', 'limitations', 'capturedAt'],
    complete: (p) => {
      const hasFeatures = Array.isArray(p.visibleFeatures) && p.visibleFeatures.length > 0;
      const hasPhotos = Array.isArray(p.photoRefs) && p.photoRefs.length > 0;
      const hasNotes = isText(p.notes);
      return hasFeatures || hasPhotos || hasNotes ? [] : [{ path: 'payload', code: 'required.postureObservation', message: '确认姿态记录需要照片引用、可见特征或备注之一。' }];
    },
    validate(p, errors) {
      for (const key of ['photoRefs', 'visibleFeatures']) if (hasOwn(p, key)) {
        if (!Array.isArray(p[key]) || p[key].some((v) => !isText(v))) add(errors, key, 'type.stringArray', `${key} 必须是非空字符串组成的数组。`);
      }
      for (const key of ['notes', 'limitations']) textField(p, key, errors);
      booleanField(p, 'standardPhoto', errors);
      dateTimeField(p, 'capturedAt', errors);
      // This module records visible observations only; it must not store photo-based diagnoses.
      for (const key of ['diagnosis', 'painCause', 'medicalConclusion']) if (hasOwn(p, key)) {
        add(errors, key, 'safety.prohibitedConclusion', `${key} 不允许作为姿态照片分析结论保存。`);
      }
    }
  },
  extra_activity: {
    allowed: ['activityType', 'durationMinutes', 'intensity', 'steps', 'distanceKm', 'notes', 'startedAt', 'endedAt'],
    complete: (p) => {
      const errors = [];
      if (!isText(p.activityType)) add(errors, 'activityType', 'required.string', '确认额外活动记录需要 activityType。');
      if (!isFiniteNumber(p.durationMinutes) || p.durationMinutes <= 0) add(errors, 'durationMinutes', 'required.positiveNumber', '确认额外活动记录需要有效的 durationMinutes。');
      return errors;
    },
    validate(p, errors) {
      requiredTextIfPresent(p, 'activityType', errors);
      positiveNumberIfPresent(p, 'durationMinutes', errors);
      enumValue(p, 'intensity', ['low', 'moderate', 'high', 'unknown'], errors);
      nonNegativeIntegerIfPresent(p, 'steps', errors);
      nonNegativeNumberIfPresent(p, 'distanceKm', errors);
      textField(p, 'notes', errors);
      for (const key of ['startedAt', 'endedAt']) dateTimeField(p, key, errors);
    }
  }
};

function add(errors, path, code, message) { errors.push({ path: `payload.${path}`, code, message }); }
function unknownKeys(obj, allowed, path, errors) { for (const key of Object.keys(obj)) if (!allowed.includes(key)) { const fieldPath = path ? `${path}.${key}` : key; add(errors, fieldPath, 'property.unknown', `不支持字段 ${fieldPath}，请检查字段名。`); } }
function requiredText(obj, key, path, errors) { if (!isText(obj[key])) add(errors, `${path}.${key}`, 'required.string', `${path}.${key} 必须是非空字符串。`); }
function requiredTextIfPresent(obj, key, errors) { if (hasOwn(obj, key) && !isText(obj[key])) add(errors, key, 'type.nonEmptyString', `${key} 必须是非空字符串。`); }
function textField(obj, key, errors, prefix = '') { if (hasOwn(obj, key) && typeof obj[key] !== 'string') add(errors, prefix ? `${prefix}.${key}` : key, 'type.string', `${key} 必须是字符串。`); }
function positiveNumber(obj, key, prefix, errors) { if (!isFiniteNumber(obj[key]) || obj[key] <= 0) add(errors, `${prefix}.${key}`, 'number.positive', `${key} 必须是大于 0 的数字。`); }
function positiveNumberIfPresent(obj, key, errors) { if (hasOwn(obj, key) && (!isFiniteNumber(obj[key]) || obj[key] <= 0)) add(errors, key, 'number.positive', `${key} 必须是大于 0 的数字。`); }
function nonNegativeNumber(obj, key, prefix, errors) { if (!isFiniteNumber(obj[key]) || obj[key] < 0) add(errors, `${prefix}.${key}`, 'number.nonNegative', `${key} 必须是大于等于 0 的数字。`); }
function nonNegativeNumberIfPresent(obj, key, errors) { if (hasOwn(obj, key) && (!isFiniteNumber(obj[key]) || obj[key] < 0)) add(errors, key, 'number.nonNegative', `${key} 必须是大于等于 0 的数字。`); }
function nonNegativeInteger(obj, key, prefix, errors) { if (!Number.isInteger(obj[key]) || obj[key] < 0) add(errors, `${prefix}.${key}`, 'number.nonNegativeInteger', `${key} 必须是大于等于 0 的整数。`); }
function nonNegativeIntegerIfPresent(obj, key, errors) { if (hasOwn(obj, key) && (!Number.isInteger(obj[key]) || obj[key] < 0)) add(errors, key, 'number.nonNegativeInteger', `${key} 必须是大于等于 0 的整数。`); }
function rangeNumber(obj, key, min, max, errors) { if (hasOwn(obj, key) && (!isFiniteNumber(obj[key]) || obj[key] < min || obj[key] > max)) add(errors, key, 'number.range', `${key} 必须在 ${min} 到 ${max} 之间。`); }
function enumValue(obj, key, values, errors) { if (hasOwn(obj, key) && !values.includes(obj[key])) add(errors, key, 'enum.value', `${key} 必须是：${values.join(', ')}。`); }
function booleanField(obj, key, errors) { if (hasOwn(obj, key) && typeof obj[key] !== 'boolean') add(errors, key, 'type.boolean', `${key} 必须是布尔值。`); }
function dateTimeField(obj, key, errors) { if (hasOwn(obj, key) && (typeof obj[key] !== 'string' || Number.isNaN(Date.parse(obj[key])) || !/(Z|[+-]\d{2}:\d{2})$/.test(obj[key]))) add(errors, key, 'format.datetime', `${key} 必须是带时区的 ISO 8601 日期时间。`); }

export function validateRecordPayload(recordType, payload, { requireComplete = false } = {}) {
  const errors = [];
  const definition = definitions[recordType];
  if (!definition) return [{ path: 'recordType', code: 'enum.recordType', message: '不支持的记录类型。' }];
  if (!isObject(payload)) return [{ path: 'payload', code: 'type.object', message: 'payload 必须是对象。' }];
  unknownKeys(payload, definition.allowed, '', errors);
  definition.validate(payload, errors);
  if (requireComplete) errors.push(...definition.complete(payload));
  return errors;
}

export const RECORD_PAYLOAD_FIELDS = Object.freeze(Object.fromEntries(
  Object.entries(definitions).map(([type, definition]) => [type, Object.freeze([...definition.allowed])])
));
