import { DatabaseSync } from 'node:sqlite';
import { applySqliteMigrations, SQLITE_MIGRATIONS } from './sqlite-migrations.js';

/** SQLite persistence adapter for local reference use. Production needs auth and managed infrastructure. */
export class SqliteRecordRepository {
  constructor({ filename = './health-records.sqlite', database = null } = {}) {
    this.db = database ?? new DatabaseSync(filename);
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
    applySqliteMigrations(this.db);
  }
  /**
   * Readiness probe: confirms the connection answers and the applied schema version is
   * supported. Never throws and never includes the database path in the result.
   */
  checkReadiness() {
    const startedAt = Date.now();
    try {
      this.db.prepare('SELECT 1 AS ok').get();
      const schemaVersion = this.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version ?? 0;
      const latestSupported = Math.max(0, ...SQLITE_MIGRATIONS.map((migration) => migration.version));
      const ready = Number.isInteger(schemaVersion) && schemaVersion >= 1 && schemaVersion <= latestSupported;
      return {
        ready,
        backend: 'sqlite',
        schemaVersion,
        latencyMs: Math.max(0, Date.now() - startedAt),
        ...(ready ? {} : { error: 'sqlite_schema_unsupported' }),
      };
    } catch {
      return { ready: false, backend: 'sqlite', schemaVersion: null, latencyMs: Math.max(0, Date.now() - startedAt), error: 'sqlite_unavailable' };
    }
  }
  listByUser({ userId, recordType, status, limit = 20, offset = 0 }) {
    const where = ['user_id=?']; const params = [userId];
    if (recordType) { where.push("json_extract(document_json, '$.recordType')=?"); params.push(recordType); }
    if (status) { where.push('status=?'); params.push(status); }
    const clause = where.join(' AND ');
    const total = this.db.prepare(`SELECT COUNT(*) AS total FROM records WHERE ${clause}`).get(...params).total;
    const rows = this.db.prepare(`SELECT document_json FROM records WHERE ${clause} ORDER BY updated_at DESC, record_id DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
    return { items: rows.map((row) => this.#parse(row.document_json)), total, limit, offset };
  }
  close() { this.db.close(); }
  #transaction(fn) { this.db.exec('BEGIN IMMEDIATE'); try { const r=fn(); this.db.exec('COMMIT'); return r; } catch(e) { try { this.db.exec('ROLLBACK'); } catch {} throw e; } }
  #parse(s) { return JSON.parse(s); }
  get(id) { const r=this.db.prepare('SELECT document_json FROM records WHERE record_id=?').get(id); return r?this.#parse(r.document_json):null; }
  insert(r) { return this.#transaction(()=>{ this.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?)').run(r.recordId,r.userId,r.revision,r.status,JSON.stringify(r),r.updatedAt); this.db.prepare('INSERT INTO record_revisions(record_id,revision,reason,snapshot_json) VALUES(?,?,?,?)').run(r.recordId,r.revision,'created',JSON.stringify(r)); return structuredClone(r); }); }
  replace(r,{reason='updated',expectedRevision=r.revision-1}={}) { return this.#transaction(()=>{ const c=this.db.prepare('SELECT revision FROM records WHERE record_id=?').get(r.recordId); if(!c) throw new Error('记录不存在'); if(c.revision!==expectedRevision){const e=new Error('记录版本已变化，请重新读取后再编辑。');e.name='RecordConflictError';throw e;} this.db.prepare('UPDATE records SET user_id=?,revision=?,status=?,document_json=?,updated_at=? WHERE record_id=?').run(r.userId,r.revision,r.status,JSON.stringify(r),r.updatedAt,r.recordId); this.db.prepare('INSERT INTO record_revisions(record_id,revision,reason,snapshot_json) VALUES(?,?,?,?)').run(r.recordId,r.revision,reason,JSON.stringify(r)); return structuredClone(r); }); }
  getHistory(id) { return this.db.prepare('SELECT revision,reason,snapshot_json AS snapshot FROM record_revisions WHERE record_id=? ORDER BY revision').all(id).map(r=>({revision:r.revision,reason:r.reason,snapshot:this.#parse(r.snapshot)})); }
  getIdempotentResult(key) { const r=this.db.prepare('SELECT record_id,result_json FROM idempotency_results WHERE idempotency_key=?').get(key); return r?{...this.#parse(r.result_json),recordId:r.record_id}:null; }
  saveIdempotentResult(key,r) { this.db.prepare('INSERT INTO idempotency_results(idempotency_key,record_id,result_json) VALUES(?,?,?)').run(key,r.recordId,JSON.stringify(r)); }
  confirmAtomically(confirmed,{expectedRevision,idempotencyKey}) { return this.#transaction(()=>{ const prior=this.db.prepare('SELECT record_id,result_json FROM idempotency_results WHERE idempotency_key=?').get(idempotencyKey); if(prior){if(prior.record_id!==confirmed.recordId){const e=new Error('幂等键已用于另一条记录。');e.name='RecordConflictError';throw e;}return {...this.#parse(prior.result_json),replayed:true};} const c=this.db.prepare('SELECT revision,status FROM records WHERE record_id=?').get(confirmed.recordId); if(!c){const e=new Error(`记录不存在：${confirmed.recordId}`);e.name='RecordNotFoundError';throw e;} if(c.status!=='draft'){const e=new Error('只有草稿可以确认保存。');e.name='RecordStateError';throw e;} if(c.revision!==expectedRevision){const e=new Error('记录版本已变化，请重新读取后再确认。');e.name='RecordConflictError';throw e;} this.db.prepare('UPDATE records SET revision=?,status=?,document_json=?,updated_at=? WHERE record_id=?').run(confirmed.revision,confirmed.status,JSON.stringify(confirmed),confirmed.updatedAt,confirmed.recordId); this.db.prepare('INSERT INTO record_revisions(record_id,revision,reason,snapshot_json) VALUES(?,?,?,?)').run(confirmed.recordId,confirmed.revision,'confirmed',JSON.stringify(confirmed)); const result={recordId:confirmed.recordId,status:confirmed.status,revision:confirmed.revision}; this.db.prepare('INSERT INTO idempotency_results(idempotency_key,record_id,result_json) VALUES(?,?,?)').run(idempotencyKey,confirmed.recordId,JSON.stringify(result)); return {...result,replayed:false}; }); }
}
