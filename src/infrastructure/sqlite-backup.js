import { backup, DatabaseSync } from 'node:sqlite';
import { access, copyFile, link, mkdir, rm, stat } from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';

async function exists(path) {
  try { await access(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

/**
 * Make a consistent SQLite snapshot using node:sqlite's backup API (safe with WAL).
 * The destination must not already exist; callers should retain and rotate backups separately.
 */
export async function createSqliteBackup({ database, destination }) {
  if (!database || typeof database.prepare !== 'function') throw new TypeError('必须提供已打开的 SQLite DatabaseSync 实例。');
  if (typeof destination !== 'string' || !destination.trim()) throw new TypeError('必须提供备份目标路径。');
  if (await exists(destination)) throw new Error('备份目标已存在；为避免覆盖历史备份，请选择新的文件路径。');
  await mkdir(dirname(destination), { recursive: true });
  const staging = join(dirname(destination), `.${basename(destination)}.${randomUUID()}.tmp`);
  try {
    await backup(database, staging);
    const report = await inspectSqliteDatabase(staging);
    if (!report.ok) throw new Error(`备份完整性校验失败：${report.integrity.join('; ')}`);
    await link(staging, destination); // atomic no-overwrite publication on the same filesystem
    await rm(staging, { force: true });
    const file = await stat(destination);
    return { destination, bytes: file.size, integrity: report.integrity, schemaVersion: report.schemaVersion };
  } catch (error) {
    await rm(staging, { force: true }).catch(() => {});
    throw error;
  }
}

/** Read-only integrity and expected-schema validation. Never mutates the inspected file. */
export async function inspectSqliteDatabase(filename) {
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    const integrity = db.prepare('PRAGMA integrity_check').all().map((row) => String(Object.values(row)[0]));
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get();
    if (!table) return { ok: false, integrity, schemaVersion: null, reason: '缺少 schema_migrations 表。' };
    const schemaVersion = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version ?? 0;
    const required = ['records', 'record_revisions', 'idempotency_results'];
    const names = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
    const missing = required.filter((name) => !names.has(name));
    const ok = integrity.length === 1 && integrity[0] === 'ok' && missing.length === 0 && schemaVersion >= 1;
    return { ok, integrity, schemaVersion, ...(missing.length ? { reason: `缺少必需的数据表：${missing.join(', ')}` } : {}) };
  } finally {
    db.close();
  }
}

/**
 * Restore a previously validated backup to a NEW destination path.
 * It intentionally refuses to overwrite an existing DB. Stop the service and move the
 * existing database plus -wal/-shm sidecars aside before restoring to the production path.
 */
export async function restoreSqliteBackup({ backupFilename, destination }) {
  if (typeof backupFilename !== 'string' || !backupFilename.trim()) throw new TypeError('必须提供备份文件路径。');
  if (typeof destination !== 'string' || !destination.trim()) throw new TypeError('必须提供恢复目标路径。');
  const sourceStat = await stat(backupFilename);
  if (!sourceStat.isFile()) throw new Error('备份源必须是普通文件。');
  const sourceReport = await inspectSqliteDatabase(backupFilename);
  if (!sourceReport.ok) throw new Error(`拒绝恢复未通过完整性检查的备份：${sourceReport.reason ?? sourceReport.integrity.join('; ')}`);
  if (await exists(destination)) throw new Error('恢复目标已存在；为避免覆盖现有数据，请先停止服务并将现有数据库及其 WAL/SHM 文件移到安全位置。');
  await mkdir(dirname(destination), { recursive: true });
  const staging = join(dirname(destination), `.${basename(destination)}.${randomUUID()}.restore`);
  try {
    await copyFile(backupFilename, staging, 1); // COPYFILE_EXCL
    const stagedReport = await inspectSqliteDatabase(staging);
    if (!stagedReport.ok) throw new Error('恢复暂存文件完整性检查失败。');
    await link(staging, destination); // atomic no-overwrite publication on the same filesystem
    await rm(staging, { force: true });
    return { destination, schemaVersion: stagedReport.schemaVersion, integrity: stagedReport.integrity };
  } catch (error) {
    await rm(staging, { force: true }).catch(() => {});
    throw error;
  }
}
