import { applyPostgresMigrations, POSTGRES_MIGRATIONS } from './postgres-migrations.js';

const parseJson = (value) => typeof value === 'string' ? JSON.parse(value) : value;
const clone = (value) => structuredClone(value);
function conflict(message) { const error = new Error(message); error.name = 'RecordConflictError'; return error; }
function notFound(id) { const error = new Error(`记录不存在：${id}`); error.name = 'RecordNotFoundError'; return error; }
function stateError(message) { const error = new Error(message); error.name = 'RecordStateError'; return error; }

/**
 * PostgreSQL adapter for a pg-compatible Pool. The caller owns the pool lifecycle.
 * This adapter is not activated by default; connect() runs versioned migrations first.
 */
export class PostgresRecordRepository {
  constructor({ pool }) {
    if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
      throw new TypeError('PostgresRecordRepository requires a pg-compatible Pool.');
    }
    this.pool = pool;
  }
  static async connect({ pool, migrate = true }) {
    if (migrate) await applyPostgresMigrations(pool);
    return new PostgresRecordRepository({ pool });
  }
  // The pool is injected and remains caller-owned unless explicitly transferred.
  async close({ endPool = false } = {}) { if (endPool) await this.pool.end?.(); }

  /**
   * Readiness probe: cheap query plus applied migration version check.
   * Never throws, never echoes the connection string; returns a reason code only.
   */
  async checkReadiness() {
    const startedAt = Date.now();
    try {
      await this.pool.query('SELECT 1');
      const result = await this.pool.query('SELECT MAX(version) AS version FROM schema_migrations');
      const schemaVersion = Number(result.rows?.[0]?.version ?? 0);
      const latestSupported = Math.max(0, ...POSTGRES_MIGRATIONS.map((migration) => migration.version));
      const ready = Number.isInteger(schemaVersion) && schemaVersion >= 1 && schemaVersion <= latestSupported;
      return {
        ready,
        backend: 'postgres',
        schemaVersion,
        latencyMs: Math.max(0, Date.now() - startedAt),
        ...(ready ? {} : { error: 'postgres_schema_unsupported' }),
      };
    } catch {
      return { ready: false, backend: 'postgres', schemaVersion: null, latencyMs: Math.max(0, Date.now() - startedAt), error: 'postgres_unavailable' };
    }
  }

  async listByUser({ userId, recordType, status, limit = 20, offset = 0 }) {
    const clauses = ['user_id = $1']; const params = [userId];
    if (recordType) { params.push(recordType); clauses.push(`document_json->>'recordType' = $${params.length}`); }
    if (status) { params.push(status); clauses.push(`status = $${params.length}`); }
    const where = clauses.join(' AND ');
    const count = await this.pool.query(`SELECT COUNT(*)::text AS total FROM records WHERE ${where}`, params);
    const total = Number(count.rows[0]?.total ?? 0);
    if (!Number.isSafeInteger(total) || total < 0) throw new RangeError('记录总数超出安全整数范围，拒绝返回不精确分页结果。');
    const listParams = [...params, limit, offset];
    const rows = await this.pool.query(`SELECT document_json FROM records WHERE ${where} ORDER BY updated_at DESC, record_id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, listParams);
    return { items: rows.rows.map((r) => parseJson(r.document_json)), total, limit, offset };
  }
  async get(recordId) {
    const result = await this.pool.query('SELECT document_json FROM records WHERE record_id=$1', [recordId]);
    return result.rows[0] ? parseJson(result.rows[0].document_json) : null;
  }
  async #transaction(fn) {
    const client = await this.pool.connect();
    try { await client.query('BEGIN'); const result = await fn(client); await client.query('COMMIT'); return result; }
    catch (error) { try { await client.query('ROLLBACK'); } catch {} throw error; }
    finally { client.release(); }
  }
  async insert(record) {
    return this.#transaction(async (client) => {
      try {
        await client.query('INSERT INTO records(record_id,user_id,revision,status,document_json,updated_at) VALUES($1,$2,$3,$4,$5::jsonb,$6)', [record.recordId, record.userId, record.revision, record.status, JSON.stringify(record), record.updatedAt]);
      } catch (error) {
        if (error.code === '23505') throw conflict('recordId 已存在，不能重复创建草稿。');
        throw error;
      }
      await client.query('INSERT INTO record_revisions(record_id,revision,reason,snapshot_json) VALUES($1,$2,$3,$4::jsonb)', [record.recordId, record.revision, 'created', JSON.stringify(record)]);
      return clone(record);
    });
  }
  async replace(record, { reason = 'updated', expectedRevision = record.revision - 1 } = {}) {
    return this.#transaction(async (client) => {
      const updated = await client.query(`UPDATE records SET revision=$1, status=$2, document_json=$3::jsonb, updated_at=$4
        WHERE record_id=$5 AND user_id=$6 AND revision=$7 RETURNING record_id`, [record.revision, record.status, JSON.stringify(record), record.updatedAt, record.recordId, record.userId, expectedRevision]);
      if (!updated.rowCount) {
        const exists = await client.query('SELECT record_id FROM records WHERE record_id=$1', [record.recordId]);
        if (!exists.rowCount) throw notFound(record.recordId);
        throw conflict('记录版本已变化，请重新读取后再编辑。');
      }
      await client.query('INSERT INTO record_revisions(record_id,revision,reason,snapshot_json) VALUES($1,$2,$3,$4::jsonb)', [record.recordId, record.revision, reason, JSON.stringify(record)]);
      return clone(record);
    });
  }
  async getHistory(recordId) {
    const result = await this.pool.query('SELECT revision,reason,snapshot_json FROM record_revisions WHERE record_id=$1 ORDER BY revision', [recordId]);
    return result.rows.map((r) => ({ revision: r.revision, reason: r.reason, snapshot: parseJson(r.snapshot_json) }));
  }
  async getIdempotentResult(key) {
    const result = await this.pool.query('SELECT record_id,result_json FROM idempotency_results WHERE idempotency_key=$1', [key]);
    if (!result.rows[0]) return null;
    return { ...parseJson(result.rows[0].result_json), recordId: result.rows[0].record_id };
  }
  async saveIdempotentResult(key, result) {
    try {
      await this.pool.query('INSERT INTO idempotency_results(idempotency_key,record_id,result_json) VALUES($1,$2,$3::jsonb)', [key, result.recordId, JSON.stringify(result)]);
    } catch (error) {
      if (error.code !== '23505') throw error;
      const prior = await this.getIdempotentResult(key);
      if (prior?.recordId !== result.recordId) throw conflict('幂等键已用于另一条记录。');
      if (JSON.stringify(prior) !== JSON.stringify(result)) throw conflict('幂等键已存在不同结果。');
    }
  }
  async confirmAtomically(confirmed, { expectedRevision, idempotencyKey }) {
    return this.#transaction(async (client) => {
      // Insert-first serializes competing requests on the unique idempotency key.
      const claimed = await client.query(`INSERT INTO idempotency_results(idempotency_key,record_id,result_json)
        VALUES($1,$2,$3::jsonb) ON CONFLICT(idempotency_key) DO NOTHING RETURNING idempotency_key`,
      [idempotencyKey, confirmed.recordId, JSON.stringify({ recordId: confirmed.recordId, status: confirmed.status, revision: confirmed.revision })]);
      if (!claimed.rowCount) {
        const priorResult = await client.query('SELECT record_id,result_json FROM idempotency_results WHERE idempotency_key=$1 FOR UPDATE', [idempotencyKey]);
        const prior = priorResult.rows[0];
        if (!prior) throw new Error('幂等结果竞争后不可见，请重试请求。');
        if (prior.record_id !== confirmed.recordId) throw conflict('幂等键已用于另一条记录。');
        return { ...parseJson(prior.result_json), replayed: true };
      }
      const currentResult = await client.query('SELECT user_id,revision,status FROM records WHERE record_id=$1 FOR UPDATE', [confirmed.recordId]);
      const current = currentResult.rows[0];
      if (!current) throw notFound(confirmed.recordId);
      if (current.user_id !== confirmed.userId) throw notFound(confirmed.recordId);
      if (current.status !== 'draft') throw stateError('只有草稿可以确认保存。');
      if (current.revision !== expectedRevision) throw conflict('记录版本已变化，请重新读取后再确认。');
      const update = await client.query(`UPDATE records SET revision=$1,status=$2,document_json=$3::jsonb,updated_at=$4
        WHERE record_id=$5 AND revision=$6 AND user_id=$7`, [confirmed.revision, confirmed.status, JSON.stringify(confirmed), confirmed.updatedAt, confirmed.recordId, expectedRevision, confirmed.userId]);
      if (!update.rowCount) throw conflict('记录版本已变化，请重新读取后再确认。');
      await client.query('INSERT INTO record_revisions(record_id,revision,reason,snapshot_json) VALUES($1,$2,$3,$4::jsonb)', [confirmed.recordId, confirmed.revision, 'confirmed', JSON.stringify(confirmed)]);
      return { recordId: confirmed.recordId, status: confirmed.status, revision: confirmed.revision, replayed: false };
    });
  }
}
