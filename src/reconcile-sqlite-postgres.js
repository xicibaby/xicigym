import { reconcileSqliteToPostgres } from './infrastructure/sqlite-postgres-reconciliation.js';

const sqliteFilename = process.env.SQLITE_SOURCE_PATH;
const connectionString = process.env.POSTGRES_URL;
if (!sqliteFilename) throw new Error('请设置 SQLITE_SOURCE_PATH。');
if (!connectionString) throw new Error('请设置 POSTGRES_URL。');
const { Pool } = await import('pg');
const pool = new Pool({
  connectionString,
  ssl: process.env.POSTGRES_SSL === 'true' ? { rejectUnauthorized: true } : undefined,
  max: 2,
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 10000,
});
try {
  const report = await reconcileSqliteToPostgres({ sqliteFilename, pool });
  console.log(JSON.stringify(report, null, 2));
  if (!report.match) process.exitCode = 2;
} finally {
  await pool.end();
}
