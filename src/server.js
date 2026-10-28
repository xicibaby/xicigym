import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { loadRuntimeConfig } from './config/runtime-config.js';
import { createOidcBearerAuthenticator } from './http/oidc-bearer-auth.js';
import { createRecordHttpServer } from './http/record-http-server.js';
import { createSecurityPolicy } from './http/security.js';
import { createProbeEndpoints } from './http/probe-endpoints.js';
import { createGracefulShutdown } from './http/shutdown.js';
import { createMetricsRegistry } from './observability/metrics.js';
import { RecordService } from './application/record-service.js';
import { UserScopedRecordService } from './application/user-scoped-record-service.js';
import { SqliteRecordRepository } from './infrastructure/sqlite-record-repository.js';
import { APP_VERSION } from './version.js';

export async function startServer({ env = process.env, logger = console } = {}) {
  // Validate all required settings before creating the database or opening a port.
  const config = loadRuntimeConfig(env);
  let repository;
  let pool = null;
  if (config.databaseBackend === 'postgres') {
    try {
      const { Pool } = await import('pg');
      pool = new Pool({
        connectionString: config.postgresUrl,
        max: Number(env.PG_POOL_MAX || 10),
        connectionTimeoutMillis: Number(env.PG_CONNECTION_TIMEOUT_MS || 5000),
        ssl: config.postgresSsl ? { rejectUnauthorized: true } : false,
        application_name: 'health-skill-record-api',
      });
      await pool.query('SELECT 1');
      const { PostgresRecordRepository } = await import('./infrastructure/postgres-record-repository.js');
      repository = await PostgresRecordRepository.connect({ pool, migrate: env.POSTGRES_AUTO_MIGRATE === 'true' });
    } catch (error) {
      if (pool) await pool.end().catch(() => {});
      throw new Error(`PostgreSQL startup failed (${error?.code || error?.name || 'unknown'}); verify POSTGRES_URL, TLS and database availability.`);
    }
  } else {
    repository = new SqliteRecordRepository({ filename: config.databasePath });
  }

  const metrics = createMetricsRegistry();
  const readinessCheck = async () => {
    if (typeof repository.checkReadiness === 'function') return await repository.checkReadiness();
    return { ready: true, backend: config.databaseBackend, schemaVersion: null };
  };
  const probes = createProbeEndpoints({
    readinessCheck,
    metrics,
    version: APP_VERSION,
    startedAt: Date.now(),
    readinessTimeoutMs: config.readinessTimeoutMs,
  });

  const service = new UserScopedRecordService(new RecordService(repository));
  const authenticate = createOidcBearerAuthenticator({ issuer: config.issuer, audience: config.audience, jwksUrl: config.jwksUrl });
  const securityPolicy = createSecurityPolicy({ corsOrigins: config.corsOrigins, rateLimit: config.rateLimit });
  const server = createRecordHttpServer({ recordService: service, authenticate, securityPolicy, metrics, probeEndpoints: probes });

  const closeDatabase = async () => {
    if (config.databaseBackend === 'postgres') await repository.close();
    else repository.close();
    if (pool) {
      try { await pool.end(); }
      catch (error) {
        // A pool may already be closed by an outage drill or an earlier shutdown attempt.
        if (!/more than once/i.test(String(error?.message))) throw error;
      }
    }
  };
  const shutdownController = createGracefulShutdown({
    server,
    closeResources: [closeDatabase],
    logger,
    timeoutMs: config.shutdownTimeoutMs,
  });

  try {
    await new Promise((resolveListen, rejectListen) => {
      server.once('error', rejectListen);
      server.listen(config.port, config.host, () => {
        server.removeListener('error', rejectListen);
        resolveListen();
      });
    });
  } catch (error) {
    await closeDatabase().catch((closeError) => logger.error('cleanup after listen failure failed:', closeError?.message));
    throw new Error(`HTTP listener failed (${error?.code || error?.name || 'unknown'}); port ${config.port} may be in use.`);
  }
  logger.info(`Health Skill record API listening on ${config.host}:${config.port} (${config.nodeEnv}); probes: /healthz /readyz /metrics`);

  return {
    server,
    repository,
    config,
    metrics,
    probes,
    version: APP_VERSION,
    readiness: () => probes.lastReadiness(),
    shutdown: shutdownController.shutdown,
    isShuttingDown: shutdownController.isShuttingDown,
  };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  startServer().then((app) => {
    const stop = (signal) => {
      app.shutdown().then((result) => {
        if (result.timedOut || !result.closed) {
          console.error(`Shutdown incomplete after ${signal}: timeout=${result.timedOut}`);
          process.exitCode = 1;
        }
      }).catch((error) => {
        console.error(`Shutdown failed: ${error?.message ?? 'unknown'}`);
        process.exitCode = 1;
      });
    };
    process.once('SIGINT', () => stop('SIGINT'));
    process.once('SIGTERM', () => stop('SIGTERM'));
  }).catch((error) => {
    console.error(`Startup failed: ${error.message}`);
    process.exitCode = 1;
  });
}
