import { DatabaseSync } from 'node:sqlite';
import { access } from 'node:fs/promises';
import { applyPostgresMigrations } from './postgres-migrations.js';

const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
};
const canonicalJson = (value) => JSON.stringify(canonical(value));
const parseJson = (value, label) => {
  try { return typeof value === 'string' ? JSON.parse(value) : value; }
  catch { throw new Error(`${label} 不是有效 JSON，迁移已停止。`); }
};
async function fileExists(path) { try { await access(path); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } }

/** Read and validate a consistent SQLite snapshot without modifying its source. */
export async function inspectSqliteSource(filename) {
  if (!(await fileExists(filename))) throw new Error(`找不到 SQLite 数据库文件：${filename}`);
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    db.exec('BEGIN'); // pin all subsequent reads to one SQLite snapshot
    const integrity = db.prepare('PRAGMA integrity_check').all().map((r) => String(Object.values(r)[0]));
    if (integrity.length !== 1 || integrity[0] !== 'ok') throw new Error(`SQLite integrity_check 未通过：${integrity.join('; ')}`);
    const names = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name));
    for (const table of ['schema_migrations', 'records', 'record_revisions', 'idempotency_results']) {
      if (!names.has(table)) throw new Error(`SQLite 缺少必要表 ${table}；拒绝进行部分迁移。`);
    }
    const applied = db.prepare('SELECT version,name FROM schema_migrations ORDER BY version').all();
    if (!applied.length) throw new Error('SQLite 未记录任何 schema migration 版本；请先核查源库。');
    const versions = applied.map((row) => Number(row.version));
    if (versions.some((v, i) => !Number.isInteger(v) || v !== i + 1) || applied.some((row) => row.version !== 1 || row.name !== 'initial_record_storage')) {
      throw new Error('SQLite schema_migrations 包含缺口、未知版本或不匹配的迁移名称；当前工具只支持已核验的版本 1。');
    }
    const records = db.prepare('SELECT record_id,user_id,revision,status,document_json,updated_at FROM records ORDER BY record_id').all();
    const revisions = db.prepare('SELECT record_id,revision,reason,snapshot_json,created_at FROM record_revisions ORDER BY record_id,revision').all();
    const idempotency = db.prepare('SELECT idempotency_key,record_id,result_json,created_at FROM idempotency_results ORDER BY idempotency_key').all();
    const recordById = new Map();
    for (const row of records) {
      const doc = parseJson(row.document_json, `records/${row.record_id}`);
      if (!doc || doc.recordId !== row.record_id || doc.userId !== row.user_id || doc.revision !== row.revision || doc.status !== row.status) {
        throw new Error(`records/${row.record_id} 的列值与 document_json 不一致；拒绝迁移。`);
      }
      recordById.set(row.record_id, row);
    }
    const revisionKeys = new Set();
    for (const row of revisions) {
      if (!recordById.has(row.record_id)) throw new Error(`历史修订引用不存在的记录 ${row.record_id}；拒绝迁移。`);
      const key = `${row.record_id}\0${row.revision}`;
      if (revisionKeys.has(key)) throw new Error(`发现重复历史版本 ${row.record_id}/${row.revision}。`);
      revisionKeys.add(key);
      const snapshot = parseJson(row.snapshot_json, `record_revisions/${row.record_id}/${row.revision}`);
      if (snapshot.recordId !== row.record_id || snapshot.revision !== row.revision) throw new Error(`历史快照 ${row.record_id}/${row.revision} 与键不一致。`);
    }
    for (const row of records) {
      const latestKey = `${row.record_id}\0${row.revision}`;
      if (!revisionKeys.has(latestKey)) throw new Error(`记录 ${row.record_id} 缺少当前 revision=${row.revision} 的历史快照；拒绝迁移。`);
      const latest = revisions.find((revision) => revision.record_id === row.record_id && revision.revision === row.revision);
      if (canonicalJson(parseJson(latest.snapshot_json, `latest revision/${row.record_id}`)) !== canonicalJson(parseJson(row.document_json, `records/${row.record_id}`))) throw new Error(`记录 ${row.record_id} 与当前历史快照不一致；拒绝迁移。`);
    }
    for (const row of idempotency) {
      if (!row.idempotency_key || !row.record_id) throw new Error('发现空幂等键或记录 ID；拒绝迁移。');
      if (!recordById.has(row.record_id)) throw new Error(`幂等键 ${row.idempotency_key} 引用不存在的记录 ${row.record_id}；拒绝迁移。`);
      parseJson(row.result_json, `idempotency_results/${row.idempotency_key}`);
    }
    const result = { schemaMigrations: applied, records, revisions, idempotency, counts: { records: records.length, revisions: revisions.length, idempotency: idempotency.length } };
    db.exec('COMMIT');
    return result;
  } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
  finally { db.close(); }
}

function normalizeRecord(row) {
  return { ...row, document_json: parseJson(row.document_json, `records/${row.record_id}`) };
}
function normalizeRevision(row) {
  return { ...row, snapshot_json: parseJson(row.snapshot_json, `record_revisions/${row.record_id}/${row.revision}`) };
}
function normalizeIdempotency(row) {
  return { ...row, result_json: parseJson(row.result_json, `idempotency_results/${row.idempotency_key}`) };
}

/**
 * Conservative one-transaction copy. Existing identical rows are treated as already migrated;
 * any conflicting target row aborts the transaction. Source is opened read-only and never changed.
 */
export async function migrateSqliteToPostgres({ sqliteFilename, pool, dryRun = true }) {
  if (!dryRun && (!pool || typeof pool.connect !== 'function')) throw new TypeError('需要 pg-compatible PostgreSQL Pool。');
  const source = await inspectSqliteSource(sqliteFilename);
  if (dryRun) return { dryRun: true, sourceCounts: source.counts, targetCounts: null, inserted: { records: 0, revisions: 0, idempotency: 0 }, alreadyPresent: { records: 0, revisions: 0, idempotency: 0 }, note: '仅检查源库完整性与内部一致性；未连接或修改目标数据库。' };

  await applyPostgresMigrations(pool);
  const client = await pool.connect();
  const inserted = { records: 0, revisions: 0, idempotency: 0 };
  const alreadyPresent = { records: 0, revisions: 0, idempotency: 0 };
  try {
    await client.query('BEGIN');
    await client.query('LOCK TABLE records, record_revisions, idempotency_results IN SHARE ROW EXCLUSIVE MODE');
    for (const raw of source.records) {
      const row = normalizeRecord(raw);
      const existing = await client.query('SELECT record_id,user_id,revision,status,document_json,updated_at FROM records WHERE record_id=$1', [row.record_id]);
      if (existing.rowCount) {
        const target = existing.rows[0];
        const same = target.user_id === row.user_id && Number(target.revision) === row.revision && target.status === row.status && canonicalJson(parseJson(target.document_json, `target records/${row.record_id}`)) === canonicalJson(row.document_json) && new Date(target.updated_at).toISOString() === new Date(row.updated_at).toISOString();
        if (!same) throw new Error(`目标 records/${row.record_id} 已存在但内容不同；整个事务将回滚。`);
        alreadyPresent.records++;
      } else {
        await client.query('INSERT INTO records(record_id,user_id,revision,status,document_json,updated_at) VALUES($1,$2,$3,$4,$5::jsonb,$6)', [row.record_id,row.user_id,row.revision,row.status,JSON.stringify(row.document_json),row.updated_at]);
        inserted.records++;
      }
    }
    for (const raw of source.revisions) {
      const row = normalizeRevision(raw);
      const existing = await client.query('SELECT reason,snapshot_json,created_at FROM record_revisions WHERE record_id=$1 AND revision=$2', [row.record_id,row.revision]);
      if (existing.rowCount) {
        const target=existing.rows[0];
        if (target.reason !== row.reason || canonicalJson(parseJson(target.snapshot_json, 'target revision')) !== canonicalJson(row.snapshot_json) || new Date(target.created_at).toISOString() !== new Date(row.created_at).toISOString()) throw new Error(`目标历史快照 ${row.record_id}/${row.revision} 已存在但内容不同；整个事务将回滚。`);
        alreadyPresent.revisions++;
      } else {
        await client.query('INSERT INTO record_revisions(record_id,revision,reason,snapshot_json,created_at) VALUES($1,$2,$3,$4::jsonb,$5)', [row.record_id,row.revision,row.reason,JSON.stringify(row.snapshot_json),row.created_at]);
        inserted.revisions++;
      }
    }
    for (const raw of source.idempotency) {
      const row = normalizeIdempotency(raw);
      const existing = await client.query('SELECT record_id,result_json,created_at FROM idempotency_results WHERE idempotency_key=$1', [row.idempotency_key]);
      if (existing.rowCount) {
        const target=existing.rows[0];
        if (target.record_id !== row.record_id || canonicalJson(parseJson(target.result_json, 'target idempotency result')) !== canonicalJson(row.result_json) || new Date(target.created_at).toISOString() !== new Date(row.created_at).toISOString()) throw new Error(`目标幂等键 ${row.idempotency_key} 已存在但内容不同；整个事务将回滚。`);
        alreadyPresent.idempotency++;
      } else {
        await client.query('INSERT INTO idempotency_results(idempotency_key,record_id,result_json,created_at) VALUES($1,$2,$3::jsonb,$4)', [row.idempotency_key,row.record_id,JSON.stringify(row.result_json),row.created_at]);
        inserted.idempotency++;
      }
    }
    const targetCounts = {};
    for (const table of ['records','record_revisions','idempotency_results']) {
      const r = await client.query(`SELECT COUNT(*)::text AS count FROM ${table}`);
      targetCounts[table === 'record_revisions' ? 'revisions' : table === 'idempotency_results' ? 'idempotency' : 'records'] = Number(r.rows[0].count);
    }
    await client.query('COMMIT');
    return { dryRun: false, sourceCounts: source.counts, targetCounts, inserted, alreadyPresent, note: '源 SQLite 未修改；目标写入在单一 PostgreSQL 事务中提交。' };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally { client.release(); }
}
