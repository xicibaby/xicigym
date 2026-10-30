/**
 * PostgreSQL logical backup command line.
 *
 *   node src/postgres-maintenance.js backup <new-backup.json[.enc]>    # POSTGRES_URL required
 *   node src/postgres-maintenance.js check <backup-file>
 *   node src/postgres-maintenance.js restore <backup-file> [--allow-existing]
 *
 * Optional:
 *   BACKUP_ENCRYPTION_KEY   base64 of 32 bytes -> produced/consumed files are encrypted
 *   BACKUP_PASSPHRASE_FILE  text file with a passphrase (>=12 chars) instead of the key
 * Restore refuses non-empty target tables unless `--allow-existing` is explicit. Restore
 * does not create the schema: run the migration runner first so versions match.
 */
import { readFile, stat, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { decryptBackup, encryptBackup, isEncryptedBackup, parseEncryptionKey } from './infrastructure/backup-crypto.js';
import { exportPostgresBackup, importPostgresBackup, parsePostgresBackup, serializePostgresBackup } from './infrastructure/postgres-backup.js';

async function loadKeyOptions(env = process.env) {
  if (env.BACKUP_ENCRYPTION_KEY) return { key: parseEncryptionKey(env.BACKUP_ENCRYPTION_KEY), source: 'BACKUP_ENCRYPTION_KEY' };
  if (env.BACKUP_PASSPHRASE_FILE) {
    const passphrase = (await readFile(env.BACKUP_PASSPHRASE_FILE, 'utf8')).trim();
    if (passphrase.length < 12) throw new TypeError('BACKUP_PASSPHRASE_FILE 中的口令至少 12 个字符');
    return { passphrase, source: 'BACKUP_PASSPHRASE_FILE' };
  }
  return null;
}

export async function runPostgresMaintenance(args = process.argv.slice(2), { logger = console, env = process.env } = {}) {
  const [command, ...rest] = args;
  const flags = new Set(rest.filter((value) => value.startsWith('--')));
  const values = rest.filter((value) => !value.startsWith('--'));
  const connectionString = env.POSTGRES_URL?.trim();
  const keyOptions = await loadKeyOptions(env);

  if (command === 'backup' && values.length === 1) {
    if (!connectionString) throw new Error('需要设置 POSTGRES_URL');
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({ connectionString, max: 2, connectionTimeoutMillis: 10_000, ssl: env.POSTGRES_SSL === 'true' ? { rejectUnauthorized: true } : undefined });
    try {
      const backup = await exportPostgresBackup({ pool });
      const payload = serializePostgresBackup(backup);
      const bytes = Buffer.from(payload, 'utf8');
      const output = keyOptions ? encryptBackup(bytes, keyOptions) : bytes;
      await writeFile(values[0], output, { flag: 'wx', mode: 0o600 });
      const report = {
        destination: values[0], bytes: output.length, encrypted: Boolean(keyOptions), counts: backup.counts,
        sha256: backup.sha256, generatedAt: backup.generatedAt, postgresVersion: backup.postgresVersion,
      };
      logger.log(JSON.stringify(report, null, 2));
      return report;
    } finally { await pool.end().catch(() => {}); }
  }

  if (command === 'check' && values.length === 1) {
    const file = await readFile(values[0]);
    const plaintext = isEncryptedBackup(file) ? decryptBackup(file, keyOptions ?? {}) : file;
    const backup = parsePostgresBackup(plaintext.toString('utf8'));
    const report = {
      valid: true, encrypted: isEncryptedBackup(file), generatedAt: backup.generatedAt,
      postgresVersion: backup.postgresVersion, counts: backup.counts, sha256: backup.sha256,
    };
    logger.log(JSON.stringify(report, null, 2));
    return report;
  }

  if (command === 'restore' && values.length === 1) {
    if (!connectionString) throw new Error('需要设置 POSTGRES_URL');
    const file = await readFile(values[0]);
    const plaintext = isEncryptedBackup(file) ? decryptBackup(file, keyOptions ?? {}) : file;
    const backup = parsePostgresBackup(plaintext.toString('utf8'));
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({ connectionString, max: 2, connectionTimeoutMillis: 10_000, ssl: env.POSTGRES_SSL === 'true' ? { rejectUnauthorized: true } : undefined });
    try {
      const result = await importPostgresBackup({ pool, backup, allowExisting: flags.has('--allow-existing') });
      const report = { restored: true, source: values[0], backupGeneratedAt: backup.generatedAt, ...result };
      logger.log(JSON.stringify(report, null, 2));
      return report;
    } finally { await pool.end().catch(() => {}); }
  }

  logger.error([
    '用法：',
    '  node src/postgres-maintenance.js backup <new-backup.json[.enc]>      # 需要 POSTGRES_URL',
    '  node src/postgres-maintenance.js check <backup-file>',
    '  node src/postgres-maintenance.js restore <backup-file> [--allow-existing]',
    '可选环境变量：BACKUP_ENCRYPTION_KEY（32 字节 base64）或 BACKUP_PASSPHRASE_FILE',
    '恢复只写入空表（除非显式 --allow-existing）；恢复前请先用迁移工具把目标 schema 建到相同版本。',
  ].join('\n'));
  process.exitCode = 2;
  return null;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runPostgresMaintenance().catch((error) => {
    console.error(`PostgreSQL 备份/恢复失败：${error.message}`);
    process.exitCode = 1;
  });
}
