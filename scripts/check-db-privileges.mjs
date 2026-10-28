/**
 * Least-privilege database account checker (security control S2).
 *
 * Connects with the *application* role URL and proves the role cannot be used for
 * schema changes or destructive operations. Read-only by default: every DDL attempt
 * runs inside a transaction that is rolled back and must be rejected by PostgreSQL.
 *
 * Usage:
 *   POSTGRES_APP_URL=postgres://<app_role>:<secret>@<host>:<port>/<db> node scripts/check-db-privileges.mjs
 *   --json  print machine-readable result only
 *
 * Exit codes: 0 = least privilege verified, 1 = violation found, 2 = missing/invalid input.
 * The URL is never printed and never included in the result.
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const appUrl = process.env.POSTGRES_APP_URL;
const jsonOnly = process.argv.includes('--json');
const artifactsDir = join(root, 'artifacts', 'security-baseline');
const resultPath = join(artifactsDir, 'DB_PRIVILEGE_CHECK.json');

const EXPECTED_TABLES = ['records', 'record_revisions', 'idempotency_results'];
const REQUIRED_WRITE_PRIVILEGES = { records: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'], record_revisions: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'], idempotency_results: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] };
const FORBIDDEN_TABLE_PRIVILEGES = ['TRUNCATE', 'REFERENCES', 'TRIGGER'];

function fail2(message) {
  console.error(`REFUSED: ${message}`);
  process.exit(2);
}

if (!appUrl) fail2('set POSTGRES_APP_URL to the least-privilege application role URL (never a superuser).');
let parsed;
try { parsed = new URL(appUrl); } catch { fail2('POSTGRES_APP_URL is not a valid URL.'); }
if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) fail2('POSTGRES_APP_URL must use postgres:// or postgresql://.');
const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
if (!database) fail2('POSTGRES_APP_URL must include a database name.');

const { default: pg } = await import('pg');
const client = new pg.Client({ connectionString: appUrl, connectionTimeoutMillis: 5_000, ssl: process.env.POSTGRES_SSL === 'true' ? { rejectUnauthorized: true } : undefined });

const checks = [];
function record(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), detail });
  if (!jsonOnly) console.log(`${ok ? 'PASS' : 'FAIL'} ${name} — ${detail}`);
}

async function expectSqlError(sql, label) {
  await client.query('BEGIN');
  try {
    await client.query(sql);
    await client.query('ROLLBACK');
    return { name: label, ok: false, detail: 'PostgreSQL accepted a statement the role should not be allowed to run.' };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    const code = error?.code ?? 'unknown';
    const allowed = ['42501', '42P01', '42710', '3F000', '25006', '0A000'].includes(code);
    return { name: label, ok: allowed, detail: `rejected with SQLSTATE ${code}${allowed ? '' : ` (unexpected: ${String(error?.message).slice(0, 160)})`}` };
  }
}

try {
  await client.connect();

  const role = await client.query(
    `SELECT current_user AS name, rolsuper, rolcreatedb, rolcreaterole, rolbypassrls, rolreplication, rolcanlogin
       FROM pg_roles WHERE rolname = current_user`,
  );
  if (!role.rowCount) fail2('could not inspect the connected role.');
  const info = role.rows[0];
  record('role-logon', info.rolcanlogin === true, 'role can log in');
  record('not-superuser', info.rolsuper === false, 'rolsuper');
  record('no-createdb', info.rolcreatedb === false, 'rolcreatedb');
  record('no-createrole', info.rolcreaterole === false, 'rolcreaterole');
  record('no-bypassrls', info.rolbypassrls === false, 'rolbypassrls');
  record('no-replication', info.rolreplication === false, 'rolreplication');

  const owners = await client.query(
    `SELECT tablename, tableowner FROM pg_tables WHERE schemaname = 'public' AND tablename = ANY($1)`,
    [EXPECTED_TABLES],
  );
  const missingTables = EXPECTED_TABLES.filter((table) => !owners.rows.some((row) => row.tablename === table));
  record('expected-tables-present', missingTables.length === 0, missingTables.length ? `missing: ${missingTables.join(', ')}` : 'records, record_revisions, idempotency_results found');
  const owned = owners.rows.filter((row) => row.tableowner === info.name).map((row) => row.tablename);
  record('does-not-own-tables', owned.length === 0, owned.length ? `owns: ${owned.join(', ')}` : 'role does not own application tables');

  for (const table of EXPECTED_TABLES) {
    const privileges = await client.query(
      `SELECT privilege_type FROM information_schema.role_table_grants
        WHERE grantee = current_user AND table_schema = 'public' AND table_name = $1`,
      [table],
    );
    const granted = new Set(privileges.rows.map((row) => row.privilege_type));
    const missing = REQUIRED_WRITE_PRIVILEGES[table].filter((privilege) => !granted.has(privilege));
    record(`table-privileges:${table}`, missing.length === 0, missing.length ? `missing ${missing.join(', ')}` : REQUIRED_WRITE_PRIVILEGES[table].join(', '));
    const forbidden = FORBIDDEN_TABLE_PRIVILEGES.filter((privilege) => granted.has(privilege));
    record(`no-destructive-privileges:${table}`, forbidden.length === 0, forbidden.length ? `unexpected ${forbidden.join(', ')}` : 'no TRUNCATE/REFERENCES/TRIGGER');
  }

  const schemaPrivilege = await client.query(`SELECT has_schema_privilege(current_user, 'public', 'USAGE') AS allowed`);
  const hasUsage = schemaPrivilege.rows[0]?.allowed === true;
  record('schema-usage', hasUsage, 'USAGE on schema public');

  const migrationsSelect = await client.query(
    `SELECT privilege_type FROM information_schema.role_table_grants
      WHERE grantee = current_user AND table_schema = 'public' AND table_name = 'schema_migrations' AND privilege_type = 'SELECT'`,
  );
  record('readiness-can-read-schema-version', migrationsSelect.rowCount === 1, 'SELECT on schema_migrations (readiness probe)');

  record(...Object.values(await expectSqlError('CREATE TABLE public.__privilege_probe (id integer)', 'cannot-create-tables')));
  record(...Object.values(await expectSqlError('ALTER TABLE public.records ADD COLUMN __privilege_probe integer', 'cannot-alter-tables')));
  record(...Object.values(await expectSqlError('DROP TABLE public.records', 'cannot-drop-tables')));
  record(...Object.values(await expectSqlError('TRUNCATE public.records', 'cannot-truncate-records')));

  const readable = await client.query('SELECT COUNT(*)::int AS count FROM records');
  record('can-read-records', Number.isInteger(readable.rows[0]?.count), `SELECT count succeeded (${readable.rows[0]?.count})`);

  const failed = checks.filter((check) => !check.ok);
  const result = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    check: 'postgres-least-privilege',
    database,
    role: info.name,
    pass: failed.length === 0,
    failedChecks: failed.map((check) => check.name),
    checks,
    note: '只读检查；所有 DDL 尝试都在事务中回滚并被 PostgreSQL 拒绝。不输出连接串或密码。',
  };
  await mkdir(artifactsDir, { recursive: true });
  await writeFile(resultPath, JSON.stringify(result, null, 2) + '\n', 'utf8');
  if (!jsonOnly) console.log(JSON.stringify({ pass: result.pass, failedChecks: result.failedChecks, evidence: 'artifacts/security-baseline/DB_PRIVILEGE_CHECK.json' }, null, 2));
  process.exitCode = result.pass ? 0 : 1;
} catch (error) {
  console.error(`PRIVILEGE CHECK FAILED: ${String(error?.message).slice(0, 300)}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
