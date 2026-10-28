import { createHash } from 'node:crypto';
import { inspectSqliteSource } from './sqlite-to-postgres-migration.js';

const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
};
const jsonValue = (value) => {
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return value; }
  }
  return value;
};
const timestamp = (value) => {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toISOString();
};
const hash = (value) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

const TABLES = {
  records: {
    key: (r) => String(r.record_id),
    source: (r) => ({ record_id: String(r.record_id), user_id: String(r.user_id), revision: Number(r.revision), status: String(r.status), document_json: jsonValue(r.document_json), updated_at: timestamp(r.updated_at) }),
    target: (r) => ({ record_id: String(r.record_id), user_id: String(r.user_id), revision: Number(r.revision), status: String(r.status), document_json: jsonValue(r.document_json), updated_at: timestamp(r.updated_at) }),
  },
  revisions: {
    key: (r) => `${r.record_id}\u0000${Number(r.revision)}`,
    source: (r) => ({ record_id: String(r.record_id), revision: Number(r.revision), reason: String(r.reason), snapshot_json: jsonValue(r.snapshot_json), created_at: timestamp(r.created_at) }),
    target: (r) => ({ record_id: String(r.record_id), revision: Number(r.revision), reason: String(r.reason), snapshot_json: jsonValue(r.snapshot_json), created_at: timestamp(r.created_at) }),
  },
  idempotency: {
    key: (r) => String(r.idempotency_key),
    source: (r) => ({ idempotency_key: String(r.idempotency_key), record_id: String(r.record_id), result_json: jsonValue(r.result_json), created_at: timestamp(r.created_at) }),
    target: (r) => ({ idempotency_key: String(r.idempotency_key), record_id: String(r.record_id), result_json: jsonValue(r.result_json), created_at: timestamp(r.created_at) }),
  },
};

/** Pure, deterministic row-level comparison. Inputs are normalized source/target rows. */
export function buildReconciliationReport(source, target) {
  const tables = {};
  let mismatchCount = 0;
  for (const [name, spec] of Object.entries(TABLES)) {
    const sourceRows = source[name] ?? [];
    const targetRows = target[name] ?? [];
    const sourceMap = new Map(sourceRows.map((raw) => { const row = spec.source(raw); return [spec.key(row), row]; }));
    const targetMap = new Map(targetRows.map((raw) => { const row = spec.target(raw); return [spec.key(row), row]; }));
    const missing = [];
    const extra = [];
    const different = [];
    for (const [key, row] of sourceMap) {
      if (!targetMap.has(key)) missing.push({ key, sourceHash: hash(row) });
      else if (hash(row) !== hash(targetMap.get(key))) different.push({ key, sourceHash: hash(row), targetHash: hash(targetMap.get(key)) });
    }
    for (const [key, row] of targetMap) if (!sourceMap.has(key)) extra.push({ key, targetHash: hash(row) });
    missing.sort((a,b) => a.key.localeCompare(b.key));
    extra.sort((a,b) => a.key.localeCompare(b.key));
    different.sort((a,b) => a.key.localeCompare(b.key));
    const sourceHash = hash([...sourceMap.entries()].sort(([a],[b]) => a.localeCompare(b)));
    const targetHash = hash([...targetMap.entries()].sort(([a],[b]) => a.localeCompare(b)));
    tables[name] = { sourceCount: sourceMap.size, targetCount: targetMap.size, sourceHash, targetHash, missing, extra, different, match: missing.length === 0 && extra.length === 0 && different.length === 0 };
    mismatchCount += missing.length + extra.length + different.length;
  }
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    match: mismatchCount === 0,
    mismatchCount,
    totals: {
      source: Object.fromEntries(Object.entries(tables).map(([k,v]) => [k, v.sourceCount])),
      target: Object.fromEntries(Object.entries(tables).map(([k,v]) => [k, v.targetCount])),
    },
    tables,
    limitations: ['SHA-256 摘要用于检测本次读取到的内容差异，不代表数据库来源真实性。', '对账过程只读取源 SQLite 和目标 PostgreSQL；不执行迁移、修复或删除。', '请在停写窗口或一致性快照下运行，以避免对账期间源数据持续变化。'],
  };
}

/** Read-only reconciliation of SQLite source against PostgreSQL target. */
export async function reconcileSqliteToPostgres({ sqliteFilename, pool }) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('对账需要 pg-compatible PostgreSQL Pool。');
  const sourceSnapshot = await inspectSqliteSource(sqliteFilename);
  const [records, revisions, idempotency] = await Promise.all([
    pool.query('SELECT record_id,user_id,revision,status,document_json,updated_at FROM records ORDER BY record_id'),
    pool.query('SELECT record_id,revision,reason,snapshot_json,created_at FROM record_revisions ORDER BY record_id,revision'),
    pool.query('SELECT idempotency_key,record_id,result_json,created_at FROM idempotency_results ORDER BY idempotency_key'),
  ]);
  const report = buildReconciliationReport({ records: sourceSnapshot.records, revisions: sourceSnapshot.revisions, idempotency: sourceSnapshot.idempotency }, {
    records: records.rows ?? [], revisions: revisions.rows ?? [], idempotency: idempotency.rows ?? [],
  });
  return { ...report, sourceSchemaMigrations: sourceSnapshot.schemaMigrations, sourceIntegrityCounts: sourceSnapshot.counts };
}
