import { createRecordDraft, validateRecord } from '../record-contract.js';

const clone = (value) => structuredClone(value);

export class RecordNotFoundError extends Error { constructor(id) { super(`记录不存在：${id}`); this.name = 'RecordNotFoundError'; } }
export class RecordStateError extends Error { constructor(message) { super(message); this.name = 'RecordStateError'; } }
export class RecordConflictError extends Error { constructor(message) { super(message); this.name = 'RecordConflictError'; } }

export class RecordService {
  constructor(repository) { this.repository = repository; }

  async createDraft(input) {
    const draft = createRecordDraft(input);
    const existing = await this.repository.get(draft.recordId);
    if (existing) throw new RecordConflictError('recordId 已存在，不能重复创建草稿。');
    return this.repository.insert(draft);
  }

  async listRecords(options) {
    if (typeof this.repository.listByUser !== 'function') throw new Error('当前仓储不支持记录列表查询。');
    return this.repository.listByUser(options);
  }

  async getRecord(recordId) {
    const record = await this.repository.get(recordId);
    if (!record) throw new RecordNotFoundError(recordId);
    return record;
  }

  async updateDraft(recordId, patch, expectedRevision) {
    const current = await this.getRecord(recordId);
    if (current.status !== 'draft') throw new RecordStateError('只有草稿状态的记录可以编辑。');
    if (expectedRevision !== current.revision) throw new RecordConflictError('记录版本已变化，请重新读取后再编辑。');
    const next = { ...current, ...clone(patch), recordId: current.recordId, userId: current.userId,
      status: 'draft', schemaVersion: current.schemaVersion, revision: current.revision + 1,
      updatedAt: patch.updatedAt ?? new Date().toISOString() };
    const validation = validateRecord(next);
    if (!validation.ok) {
      const error = new Error('草稿更新校验失败'); error.name = 'RecordValidationError'; error.details = validation.errors; throw error;
    }
    return this.repository.replace(validation.value, { reason: 'draft_edited', expectedRevision: current.revision });
  }

  async confirmRecord(recordId, { expectedRevision, idempotencyKey }) {
    if (typeof idempotencyKey !== 'string' || idempotencyKey.trim() === '') {
      throw new TypeError('确认保存必须提供 idempotencyKey。');
    }
    const previous = await this.repository.getIdempotentResult(idempotencyKey);
    if (previous) {
      if (previous.recordId !== recordId) throw new RecordConflictError('幂等键已用于另一条记录。');
      return { ...previous, replayed: true };
    }
    const current = await this.getRecord(recordId);
    if (current.status !== 'draft') throw new RecordStateError('只有草稿可以确认保存。');
    if (expectedRevision !== current.revision) throw new RecordConflictError('记录版本已变化，请重新读取后再确认。');
    const confirmed = { ...current, status: 'confirmed', revision: current.revision + 1, updatedAt: new Date().toISOString() };
    const validation = validateRecord(confirmed, { requireComplete: true });
    if (!validation.ok) {
      const error = new Error('确认保存校验失败'); error.name = 'RecordValidationError'; error.details = validation.errors; throw error;
    }
    if (typeof this.repository.confirmAtomically === 'function') return this.repository.confirmAtomically(validation.value, { expectedRevision, idempotencyKey });
    const saved = await this.repository.replace(validation.value, { reason: 'confirmed', expectedRevision: current.revision });
    const result = { recordId, status: saved.status, revision: saved.revision };
    await this.repository.saveIdempotentResult(idempotencyKey, result);
    return { ...result, replayed: false };
  }

  async correctRecord(recordId, patch, { expectedRevision, reason = 'user_correction' }) {
    const current = await this.getRecord(recordId);
    if (current.status !== 'confirmed') throw new RecordStateError('只有已确认记录可以走修订流程。');
    if (expectedRevision !== current.revision) throw new RecordConflictError('记录版本已变化，请重新读取后再修订。');
    const next = { ...current, ...clone(patch), recordId: current.recordId, userId: current.userId,
      status: 'confirmed', revision: current.revision + 1, updatedAt: patch.updatedAt ?? new Date().toISOString() };
    const validation = validateRecord(next, { requireComplete: true });
    if (!validation.ok) {
      const error = new Error('记录修订校验失败'); error.name = 'RecordValidationError'; error.details = validation.errors; throw error;
    }
    return this.repository.replace(validation.value, { reason, expectedRevision: current.revision });
  }

  async getHistory(recordId) {
    await this.getRecord(recordId);
    return this.repository.getHistory(recordId);
  }

  /** Explicit, audited recovery: restore a prior snapshot as a new revision, never erase history. */
  async restoreRevision(recordId, targetRevision, { expectedRevision }) {
    const current = await this.getRecord(recordId);
    if (expectedRevision !== current.revision) throw new RecordConflictError('记录版本已变化，请重新读取后再恢复。');
    const history = await this.repository.getHistory(recordId);
    const target = history.find((item) => item.revision === targetRevision);
    if (!target) throw new RecordNotFoundError(`${recordId} 的历史版本 ${targetRevision}`);
    const restored = { ...target.snapshot, revision: current.revision + 1, updatedAt: new Date().toISOString() };
    return this.repository.replace(restored, { reason: `restored_from_revision_${targetRevision}`, expectedRevision: current.revision });
  }
}
