import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { createSqliteBackup, inspectSqliteDatabase, restoreSqliteBackup } from './infrastructure/sqlite-backup.js';

export async function runMaintenance(args = process.argv.slice(2), logger = console) {
  const [command, ...values] = args;
  if (command === 'check' && values.length === 1) {
    const report = await inspectSqliteDatabase(values[0]);
    logger.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
    return report;
  }
  if (command === 'backup' && values.length === 2) {
    const [source, destination] = values;
    const db = new DatabaseSync(source);
    try {
      const report = await createSqliteBackup({ database: db, destination });
      logger.log(JSON.stringify(report, null, 2));
      return report;
    } finally { db.close(); }
  }
  if (command === 'restore' && values.length === 2) {
    const [backupFilename, destination] = values;
    const report = await restoreSqliteBackup({ backupFilename, destination });
    logger.log(JSON.stringify(report, null, 2));
    return report;
  }
  logger.error([
    '用法：',
    '  node src/maintenance.js check <database.sqlite>',
    '  node src/maintenance.js backup <source.sqlite> <new-backup.sqlite>',
    '  node src/maintenance.js restore <backup.sqlite> <new-destination.sqlite>',
    '安全提示：restore 只写入新路径，不会覆盖已有数据库。恢复到正式路径前请停止服务，并先将旧数据库及 WAL/SHM 文件移到安全位置。',
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
