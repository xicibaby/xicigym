/** Demo/test adapter only. Replace with a transactional database adapter in production. */
export class InMemoryRecordRepository {
  #records = new Map();
  #revisions = new Map();
  #idempotency = new Map();

  /** In-memory storage is always ready by construction; reported for probe parity. */
  async checkReadiness() {
    return { ready: true, backend: 'memory', schemaVersion: 1, latencyMs: 0 };
  }

  async listByUser({ userId, recordType, status, limit = 20, offset = 0 }) {
    const all = [...this.#records.values()].filter((record) => record.userId === userId
      && (!recordType || record.recordType === recordType)
      && (!status || record.status === status))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.recordId.localeCompare(a.recordId));
    return { items: structuredClone(all.slice(offset, offset + limit)), total: all.length, limit, offset };
  }
  async get(recordId) {
    const value = this.#records.get(recordId);
    return value ? structuredClone(value) : null;
  }
  async insert(record) {
    if (this.#records.has(record.recordId)) throw new Error('recordId 已存在');
    this.#records.set(record.recordId, structuredClone(record));
    this.#revisions.set(record.recordId, [{ revision: record.revision, snapshot: structuredClone(record), reason: 'created' }]);
    return structuredClone(record);
  }
  async replace(record, { reason = 'updated', expectedRevision = record.revision - 1 } = {}) {
    const current = this.#records.get(record.recordId);
    if (!current) throw new Error('记录不存在');
    if (current.revision !== expectedRevision) {
      const error = new Error('记录版本已变化，请重新读取后再编辑。');
      error.name = 'RecordConflictError';
      throw error;
    }
    // Build snapshots first; publish the current version only after all in-memory operations succeed.
    const history = this.#revisions.get(record.recordId) ?? [];
    const nextHistory = [...history, { revision: record.revision, snapshot: structuredClone(record), reason }];
    this.#records.set(record.recordId, structuredClone(record));
    this.#revisions.set(record.recordId, nextHistory);
    return structuredClone(record);
  }
  async getHistory(recordId) {
    return structuredClone(this.#revisions.get(recordId) ?? []);
  }
  async getIdempotentResult(key) {
    const result = this.#idempotency.get(key);
    return result ? structuredClone(result) : null;
  }
  async saveIdempotentResult(key, result) {
    const existing = this.#idempotency.get(key);
    if (existing && existing.recordId !== result.recordId) {
      const error = new Error('幂等键已用于另一条记录。');
      error.name = 'RecordConflictError';
      throw error;
    }
    this.#idempotency.set(key, structuredClone(result));
  }
}
