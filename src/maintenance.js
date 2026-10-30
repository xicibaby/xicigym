import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSqliteBackup, inspectSqliteDatabase, restoreSqliteBackup } from './infrastructure/sqlite-backup.js';
import { decryptBackup, encryptBackup, isEncryptedBackup, parseEncryptionKey } from './infrastructure/backup-crypto.js';

async function loadKeyOptions(env) {
  if (env.BACKUP_ENCRYPTION_KEY) return { key: parseEncryptionKey(env.BACKUP_ENCRYPTION_KEY), source: 'BACKUP_ENCRYPTION_KEY' };
  if (env.BACKUP_PASSPHRASE_FILE) {
    const passphrase = (await readFile(env.BACKUP_PASSPHRASE_FILE, 'utf8')).trim();
    if (passphrase.length < 12) throw new TypeError('BACKUP_PASSPHRASE_FILE 中的口令至少 12 个字符');
    return { passphrase, source: 'BACKUP_PASSPHRASE_FILE' };
  }
  return null;
}

async function withEncryptedTemp(backupFilename, keyOptions, fn) {
  const raw = await readFile(backupFilename);
  const encrypted = isEncryptedBackup(raw);
  if (!encrypted) return fn(backupFilename, false);
  if (!keyOptions) throw new Error('备份已加密；需要 BACKUP_ENCRYPTION_KEY 或 BACKUP_PASSPHRASE_FILE');
  const plaintext = decryptBackup(raw, keyOptions);
  const dir = await mkdtemp(join(tmpdir(), 'health-skill-decrypt-'));
  const temp = join(dir, 'decrypted.sqlite');
  try {
    await writeFile(temp, plaintext, { mode: 0o600 });
    return await fn(temp, true);
  } finally { await rm(dir, { recursive: true, force: true }); }
}

export async function runMaintenance(args = process.argv.slice(2), { logger = console, env = process.env } = {}) {
  const [command, ...values] = args;
  const keyOptions = await loadKeyOptions(env);

  if (command === 'check' && values.length === 1) {
    const report = await withEncryptedTemp(values[0], keyOptions, (source, encrypted) => inspectSqliteDatabase(source).then((result) => ({ ...result, encrypted, file: values[0] })));
    logger.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
    return report;
  }

  if (command === 'backup' && values.length === 2) {
    const [source, destination] = values;
    if (!keyOptions) {
      const db = new DatabaseSync(source);
      try {
        const report = await createSqliteBackup({ database: db, destination });
        logger.log(JSON.stringify({ ...report, encrypted: false }, null, 2));
        return report;
      } finally { db.close(); }
    }
    // Encrypted backup: create a consistent plaintext snapshot in a private temp dir, encrypt it,
    // publish with an exclusive create (no overwrite), then remove the plaintext snapshot.
    const dir = await mkdtemp(join(tmpdir(), 'health-skill-encrypt-'));
    const staging = join(dir, 'snapshot.sqlite');
    const db = new DatabaseSync(source);
    try {
      const plaintextReport = await createSqliteBackup({ database: db, destination: staging });
      const plaintext = await readFile(staging);
      const encrypted = encryptBackup(plaintext, keyOptions);
      await writeFile(destination, encrypted, { flag: 'wx', mode: 0o600 });
      const info = await stat(destination);
      const report = {
        destination, bytes: info.size, encrypted: true, encryptionSource: keyOptions.source,
        integrity: plaintextReport.integrity, schemaVersion: plaintextReport.schemaVersion,
        plaintextBytes: plaintext.length,
      };
      logger.log(JSON.stringify(report, null, 2));
      return report;
    } finally {
      db.close();
      await rm(dir, { recursive: true, force: true });
    }
  }

  if (command === 'restore' && values.length === 2) {
    const [backupFilename, destination] = values;
    const report = await withEncryptedTemp(backupFilename, keyOptions, (source, encrypted) =>
      restoreSqliteBackup({ backupFilename: source, destination }).then((result) => ({ ...result, encrypted })));
    logger.log(JSON.stringify(report, null, 2));
    return report;
  }

  logger.error([
    '用法：',
    '  node src/maintenance.js check <database.sqlite>',
    '  node src/maintenance.js backup <source.sqlite> <new-backup.sqlite>',
    '  node src/maintenance.js restore <backup.sqlite> <new-destination.sqlite>',
    '可选环境变量：BACKUP_ENCRYPTION_KEY（32 字节 base64）或 BACKUP_PASSPHRASE_FILE（含口令的文件）',
    '安全提示：restore 只写入新路径，不会覆盖已有数据库；加密备份需要相同的密钥/口令才能恢复。',
    '恢复到正式路径前请停止服务，并先将旧数据库及 WAL/SHM 文件移到安全位置。',
  ].join('\n'));
  process.exitCode = 2;
  return null;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runMaintenance().catch((error) => {
    console.error(`数据库维护操作失败：${error.message}`);
    process.exitCode = 1;
  });
}
