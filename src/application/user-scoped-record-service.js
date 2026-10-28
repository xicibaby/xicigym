import { RecordNotFoundError } from './record-service.js';

/**
 * Enforces tenant/user ownership at the application boundary.
 * The principal MUST be created by a trusted server-side authentication adapter.
 */
export class UserScopedRecordService {
  constructor(recordService) { this.records = recordService; }

  #assertPrincipal(principal) {
    if (!principal || typeof principal.userId !== 'string' || !principal.userId.trim()) {
      const error = new Error('需要有效的登录身份。'); error.name = 'UnauthenticatedError'; throw error;
    }
    return principal.userId;
  }

  async #ownedRecord(principal, recordId) {
    const userId = this.#assertPrincipal(principal);
    const record = await this.records.getRecord(recordId);
    // Return the same not-found response for missing and foreign-owned records.
    if (record.userId !== userId) throw new RecordNotFoundError(recordId);
    return record;
  }

  async listRecords(principal, options = {}) {
    const userId = this.#assertPrincipal(principal);
    return this.records.listRecords({ ...options, userId });
  }
  async createDraft(principal, input) {
    const userId = this.#assertPrincipal(principal);
    // Never trust userId supplied in request JSON.
    return this.records.createDraft({ ...input, userId });
  }
  async getRecord(principal, recordId) { return this.#ownedRecord(principal, recordId); }
  async updateDraft(principal, recordId, patch, expectedRevision) {
    await this.#ownedRecord(principal, recordId);
    return this.records.updateDraft(recordId, patch, expectedRevision);
  }
  async confirmRecord(principal, recordId, options) {
    const userId = this.#assertPrincipal(principal);
    await this.#ownedRecord(principal, recordId);
    // Namespace idempotency keys per user to avoid cross-user collisions.
    return this.records.confirmRecord(recordId, {
      ...options,
      idempotencyKey: `${userId.length}:${userId}:${options.idempotencyKey}`
    });
  }
  async correctRecord(principal, recordId, patch, options) {
    await this.#ownedRecord(principal, recordId);
    return this.records.correctRecord(recordId, patch, options);
  }
  async getHistory(principal, recordId) {
    await this.#ownedRecord(principal, recordId);
    return this.records.getHistory(recordId);
  }
  async restoreRevision(principal, recordId, targetRevision, options) {
    await this.#ownedRecord(principal, recordId);
    return this.records.restoreRevision(recordId, targetRevision, options);
  }
}
