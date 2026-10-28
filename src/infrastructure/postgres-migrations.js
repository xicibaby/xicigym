/** PostgreSQL schema migrations. DDL is transactional; a transaction-scoped advisory lock serializes startup migrations. */
export const POSTGRES_MIGRATIONS = Object.freeze([
  {
    version: 1,
    name: 'initial_record_storage',
    statements: [
      `CREATE TABLE IF NOT EXISTS records (
        record_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision >= 0),
        status TEXT NOT NULL CHECK (status IN ('draft','confirmed')),
        document_json JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS record_revisions (
        record_id TEXT NOT NULL REFERENCES records(record_id) ON DELETE CASCADE,
        revision INTEGER NOT NULL CHECK (revision >= 0),
        reason TEXT NOT NULL,
        snapshot_json JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (record_id, revision)
      )`,
      `CREATE TABLE IF NOT EXISTS idempotency_results (
        idempotency_key TEXT PRIMARY KEY,
        record_id TEXT NOT NULL,
        result_json JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
      'CREATE INDEX IF NOT EXISTS idx_records_user_updated ON records(user_id, updated_at DESC, record_id DESC)',
      'CREATE INDEX IF NOT EXISTS idx_records_user_status ON records(user_id, status)',
    ],
  },
]);

export async function applyPostgresMigrations(pool) {
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('PostgreSQL migration runner requires a pg-compatible pool.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', [736214, 1]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    const result = await client.query('SELECT version FROM schema_migrations ORDER BY version');
    const applied = new Set((result.rows ?? []).map((row) => Number(row.version)));
    const latestSupported = Math.max(0, ...POSTGRES_MIGRATIONS.map((m) => m.version));
    const unsupported = [...applied].filter((version) => !Number.isInteger(version) || version < 1 || version > latestSupported);
    if (unsupported.length) throw new Error(`数据库包含当前代码不支持的迁移版本：${unsupported.join(', ')}；拒绝启动。`);
    const expectedVersions = POSTGRES_MIGRATIONS.map((m) => m.version).filter((version) => applied.has(version));
    for (let i = 0; i < expectedVersions.length; i++) {
      if (expectedVersions[i] !== POSTGRES_MIGRATIONS[i]?.version) {
        throw new Error('数据库迁移版本存在缺口或不连续；拒绝自动修补，请先人工核查 schema_migrations。');
      }
    }
    for (const migration of POSTGRES_MIGRATIONS) {
      if (applied.has(migration.version)) continue;
      const priorVersions = POSTGRES_MIGRATIONS.filter((m) => m.version < migration.version);
      if (priorVersions.some((m) => !applied.has(m.version))) {
        throw new Error(`不能应用迁移 ${migration.version}：缺少前置迁移。`);
      }
      for (const statement of migration.statements) await client.query(statement);
      await client.query('INSERT INTO schema_migrations(version, name) VALUES($1, $2)', [migration.version, migration.name]);
      applied.add(migration.version);
    }
    await client.query('COMMIT');
    return { appliedThrough: latestSupported };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally {
    client.release();
  }
}
