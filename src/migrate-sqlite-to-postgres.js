import { DatabaseSync } from 'node:sqlite';
import { migrateSqliteToPostgres } from './infrastructure/sqlite-to-postgres-migration.js';

const sqliteFilename = process.env.SQLITE_SOURCE_PATH;
const connectionString = process.env.POSTGRES_URL;
const apply = process.argv.includes('--apply');
if (!sqliteFilename) throw new Error('请设置 SQLITE_SOURCE_PATH。');
if (apply && !connectionString) throw new Error('执行写入时必须设置 POSTGRES_URL。');
let pool;
try {
  if (apply) {
    const { Pool } = await import('pg');
    pool = new Pool({ connectionString, ssl: process.env.POSTGRES_SSL === 'true' ? { rejectUnauthorized: true } : undefined, max: 2, connectionTimeoutMillis: 5000, idleTimeoutMillis: 10000 });
  } else {
    // Dry-run validates the SQLite source only; it deliberately does not require pg or connect to PostgreSQL.
    const { inspectSqliteSource } = await import('./infrastructure/sqlite-to-postgres-migration.js');
    const result = await inspectSqliteSource(sqliteFilename);
    console.log(JSON.stringify({ dryRun: true, sourceCounts: result.counts, schemaMigrations: result.schemaMigrations, note: '源库检查通过；尚未检查目标 PostgreSQL。执行写入需显式加 --apply。' }, null, 2));
    process.exitCode = 0;
  }
  if (apply) {
    const result = await migrateSqliteToPostgres({ sqliteFilename, pool, dryRun: false });
    console.log(JSON.stringify(result, null, 2));
  }
} finally { if (pool) await pool.end(); }
