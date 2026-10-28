export { RecordService, RecordNotFoundError, RecordStateError, RecordConflictError } from './application/record-service.js';
export { UserScopedRecordService } from './application/user-scoped-record-service.js';
export { createRecordHttpServer } from './http/record-http-server.js';
export { SqliteRecordRepository } from './infrastructure/sqlite-record-repository.js';
export { InMemoryRecordRepository } from './infrastructure/in-memory-record-repository.js';
export { createRecordDraft, validateRecord, RECORD_TYPES, RECORD_STATUSES, INPUT_METHODS, TRUST_LEVELS } from './record-contract.js';

export { validateRecordPayload, RECORD_PAYLOAD_FIELDS } from './record-payload-schemas.js';

export { createOidcBearerAuthenticator } from './http/oidc-bearer-auth.js';
export { loadRuntimeConfig } from './config/runtime-config.js';
export { startServer } from './server.js';
export { APP_VERSION } from './version.js';
export { createProbeEndpoints } from './http/probe-endpoints.js';
export { createGracefulShutdown } from './http/shutdown.js';
export { createMetricsRegistry } from './observability/metrics.js';

export { createSqliteBackup, inspectSqliteDatabase, restoreSqliteBackup } from './infrastructure/sqlite-backup.js';

export { RECORD_REPOSITORY_REQUIRED_METHODS, inspectRecordRepository, assertRecordRepository } from './infrastructure/record-repository-contract.js';

export { PostgresRecordRepository } from './infrastructure/postgres-record-repository.js';
export { POSTGRES_MIGRATIONS, applyPostgresMigrations } from './infrastructure/postgres-migrations.js';
export { inspectSqliteSource, migrateSqliteToPostgres } from './infrastructure/sqlite-to-postgres-migration.js';
