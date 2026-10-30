/**
 * PostgreSQL logical backup / restore for the unified record module.
 *
 * Scope: portable, dependency-free export of the four module tables to a single JSON
 * envelope with a SHA-256 integrity hash. This is a *disaster-recovery drill* tool for
 * small/medium datasets, not a replacement for `pg_dump`/physical backups:
 *   - reads a consistent point-in-time view inside a READ ONLY transaction
 *   - restore requires a schema created by the normal migration runner first
 *   - restore refuses to write into non-empty tables unless explicitly allowed
 *   - restore re-reads the restored rows and re-checks the SHA-256 before commit
 */
import { createHash } from 'node:crypto';

export const POSTGRES_BACKUP_FORMAT = 'health-skill-pg-backup-v1';
export const POSTGRES_BACKUP_SCHEMA_VERSION = 1;

const TABLES = [
  { name: 'schema_migrations', columns: ['version', 'name', 'applied_at'], keyColumns: [1], jsonColumns: [] },
  { name: 'records', columns: ['record_id', 'user_id', 'revision', 'status', 'document_json', 'updated_at'], keyColumns: [1], jsonColumns: ['document_json'] },
  { name: 'record_revisions', columns: ['record_id', 'revision', 'reason', 'snapshot_json', 'created_at'], keyColumns: [1, 2], jsonColumns: ['snapshot_json'] },
  { name: 'idempotency_results', columns: ['idempotency_key', 'record_id', 'result_json', 'created_at'], keyColumns: [1], jsonColumns: ['result_json'] },
];

const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
};

export function hashPostgresBackupPayload(payload) {
  return createHash('sha256').update(JSON.stringify(canonical(payload))).digest('hex');
}

function assertPool(pool) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('需要 pg-compatible Pool 或 Client');
}

async function readTables(pool) {
  const tables = {};
  for (const table of TABLES) {
    const orderBy = table.keyColumns.map((position) => `${position}`).join(', ');
    const result = await pool.query(`SELECT ${table.columns.join(', ')} FROM ${table.name} ORDER BY ${orderBy}`);
    tables[table.name] = result.rows ?? [];
  }
  return tables;
}

/** Read a consistent logical backup from PostgreSQL. */
export async function exportPostgresBackup({ pool, now = () => new Date() } = {}) {
  assertPool(pool);
  const client = typeof pool.connect === 'function' ? await pool.connect() : pool;
  try {
    if (typeof client.query === 'function') await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const versionResult = await client.query('SELECT version()');
    const tables = await readTables(client);
    const counts = Object.fromEntries(TABLES.map((table) => [table.name, tables[table.name].length]));
    if (counts.schema_migrations === 0) throw new Error('源库没有迁移记录；拒绝导出不完整的备份');
    const payload = { tables };
    const backup = {
      format: POSTGRES_BACKUP_FORMAT,
      schemaVersion: POSTGRES_BACKUP_SCHEMA_VERSION,
      generatedAt: now().toISOString(),
      postgresVersion: String(versionResult.rows[0].version).split(',')[0],
      counts,
      sha256: hashPostgresBackupPayload(payload),
      payload,
    };
    if (typeof client.query === 'function') await client.query('COMMIT');
    return backup;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    throw error;
  } finally {
    if (typeof client.release === 'function') client.release();
  }
}

export function serializePostgresBackup(backup) {
  validatePostgresBackup(backup);
  return JSON.stringify(backup) + '\n';
}

export function validatePostgresBackup(backup) {
  if (!backup || typeof backup !== 'object' || Array.isArray(backup)) throw new TypeError('备份必须是对象');
  if (backup.format !== POSTGRES_BACKUP_FORMAT) throw new TypeError(`不支持的备份格式：${backup.format}`);
  if (backup.schemaVersion !== POSTGRES_BACKUP_SCHEMA_VERSION) throw new TypeError(`不支持的备份 schemaVersion：${backup.schemaVersion}`);
  if (!backup.payload?.tables) throw new TypeError('备份缺少 payload.tables');
  const actual = hashPostgresBackupPayload(backup.payload);
  if (actual !== backup.sha256) throw new Error('备份校验失败：内容哈希与记录不一致');
  return backup;
}

export function parsePostgresBackup(text) {
  let backup;
  try { backup = JSON.parse(text); } catch { throw new Error('备份文件不是合法 JSON'); }
  return validatePostgresBackup(backup);
}

function placeholders(table, row) {
  return table.columns.map((column, index) => (table.jsonColumns.includes(column) ? `$${index + 1}::jsonb` : `$${index + 1}`)).join(', ');
}

function valuesFor(table, row) {
  return table.columns.map((column) => {
    const value = row[column];
    return table.jsonColumns.includes(column) ? JSON.stringify(value) : value;
  });
}

/** Restore a logical backup into a schema created by the migration runner. */
export async function importPostgresBackup({ pool, backup, allowExisting = false } = {}) {
  assertPool(pool);
  validatePostgresBackup(backup);
  const client = typeof pool.connect === 'function' ? await pool.connect() : pool;
  const restored = {};
  try {
    await client.query('BEGIN');
    // Refuse to restore into a schema whose migrations do not match the backup.
    const applied = await client.query('SELECT version FROM schema_migrations ORDER BY version');
    const backupVersions = backup.payload.tables.schema_migrations.map((row) => Number(row.version));
    const appliedVersions = applied.rows.map((row) => Number(row.version));
    if (JSON.stringify(backupVersions) !== JSON.stringify(appliedVersions)) {
      throw new Error('目标库迁移版本与备份不一致；请先用迁移工具把目标 schema 建到相同版本');
    }

    for (const table of [...TABLES].reverse()) {
      if (table.name === 'schema_migrations') continue; // version row is required by migrations; compared above
      const count = await client.query(`SELECT COUNT(*)::int AS count FROM ${table.name}`);
      if (count.rows[0].count > 0) {
        if (!allowExisting) throw new Error(`目标表 ${table.name} 非空；恢复只写入空目标（如确需覆盖请显式 allowExisting）`);
        await client.query(`DELETE FROM ${table.name}`);
      }
    }

    await client.query('DELETE FROM schema_migrations');

    for (const table of TABLES) {
      const rows = backup.payload.tables[table.name];
      for (const row of rows) {
        const sql = `INSERT INTO ${table.name}(${table.columns.join(', ')}) VALUES(${placeholders(table, row)})`;
        await client.query(sql, valuesFor(table, row));
      }
      restored[table.name] = rows.length;
    }

    const reread = await readTables(client);
    const rereadPayload = { tables: reread };
    const rereadHash = hashPostgresBackupPayload(rereadPayload);
    if (rereadHash !== backup.sha256) throw new Error('恢复后校验失败：行内容与备份哈希不一致，已回滚');
    await client.query('COMMIT');
    return { restored, sha256: rereadHash, postgresVersion: backup.postgresVersion, generatedAt: backup.generatedAt };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    throw error;
  } finally {
    if (typeof client.release === 'function') client.release();
  }
}

export { TABLES as POSTGRES_BACKUP_TABLES };
