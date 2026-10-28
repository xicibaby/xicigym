/** Versioned SQLite schema migrations. Each migration must be additive and rerunnable. */
export const SQLITE_MIGRATIONS = [
  {
    version: 1,
    name: 'initial_record_storage',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS records (
          record_id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          revision INTEGER NOT NULL,
          status TEXT NOT NULL,
          document_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS record_revisions (
          record_id TEXT NOT NULL,
          revision INTEGER NOT NULL,
          reason TEXT NOT NULL,
          snapshot_json TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          PRIMARY KEY(record_id, revision),
          FOREIGN KEY(record_id) REFERENCES records(record_id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS idempotency_results (
          idempotency_key TEXT PRIMARY KEY,
          record_id TEXT NOT NULL,
          result_json TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
        CREATE INDEX IF NOT EXISTS idx_records_user_updated ON records(user_id, updated_at DESC, record_id DESC);
      `);
    },
  },
];

export function applySqliteMigrations(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );`);
  const getApplied = db.prepare('SELECT version FROM schema_migrations WHERE version=?');
  const insertApplied = db.prepare('INSERT INTO schema_migrations(version, name) VALUES(?, ?)');
  const latestSupported = Math.max(0, ...SQLITE_MIGRATIONS.map((migration) => migration.version));
  const newestApplied = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version ?? 0;
  if (newestApplied > latestSupported) {
    throw new Error(`数据库版本 ${newestApplied} 高于当前代码支持的最高迁移版本 ${latestSupported}；拒绝启动以避免降级代码破坏数据。`);
  }
  for (const migration of SQLITE_MIGRATIONS) {
    if (getApplied.get(migration.version)) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      // Recheck after acquiring the write lock in case another initializer ran.
      if (!getApplied.get(migration.version)) {
        migration.up(db);
        insertApplied.run(migration.version, migration.name);
      }
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }
}
