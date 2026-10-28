import test from 'node:test';
import assert from 'node:assert/strict';
import { loadRuntimeConfig } from '../src/config/runtime-config.js';

const base = {
  NODE_ENV: 'development',
  OIDC_ISSUER: 'https://identity.example.test/',
  OIDC_AUDIENCE: 'health-skill-api',
  OIDC_JWKS_URL: 'https://identity.example.test/.well-known/jwks.json',
  DATABASE_PATH: './test.sqlite',
  CORS_ORIGINS: 'http://localhost:5173',
};

test('runtime config parses safe defaults and deduplicates CORS origins', () => {
  const config = loadRuntimeConfig({ ...base, CORS_ORIGINS: 'http://localhost:5173, http://localhost:5173', PORT: '3100' });
  assert.equal(config.port, 3100);
  assert.deepEqual(config.corsOrigins, ['http://localhost:5173']);
  assert.deepEqual(config.rateLimit, { windowMs: 60_000, maxRequests: 120 });
});

test('runtime config requires identity and persistent storage settings', () => {
  for (const key of ['OIDC_ISSUER', 'OIDC_AUDIENCE', 'OIDC_JWKS_URL', 'DATABASE_PATH']) {
    const env = { ...base }; delete env[key];
    assert.throws(() => loadRuntimeConfig(env), new RegExp(`${key} is required`));
  }
});

test('production requires HTTPS issuer, JWKS, explicit HTTPS CORS and persistent database', () => {
  const prod = { ...base, NODE_ENV: 'production', DATABASE_BACKEND: 'postgres', POSTGRES_URL: 'postgres://app:secret@db.example.test:5432/health?sslmode=verify-full', POSTGRES_SSL: 'true', OIDC_ISSUER: 'http://identity.example.test/', OIDC_JWKS_URL: 'http://identity.example.test/jwks', CORS_ORIGINS: 'https://app.example.test' };
  assert.throws(() => loadRuntimeConfig(prod), /must use HTTPS in production/);
  assert.throws(() => loadRuntimeConfig({ ...prod, OIDC_ISSUER: base.OIDC_ISSUER, OIDC_JWKS_URL: base.OIDC_JWKS_URL, CORS_ORIGINS: 'http://app.example.test' }), /CORS_ORIGINS must use HTTPS/);
  assert.throws(() => loadRuntimeConfig({ ...prod, OIDC_ISSUER: base.OIDC_ISSUER, OIDC_JWKS_URL: base.OIDC_JWKS_URL, CORS_ORIGINS: 'https://app.example.test', POSTGRES_SSL: 'false' }), /POSTGRES_SSL=true/);
  assert.throws(() => loadRuntimeConfig({ ...base, NODE_ENV: 'production', DATABASE_BACKEND: 'sqlite', CORS_ORIGINS: 'https://app.example.test' }), /DATABASE_BACKEND=postgres is required/);
});

test('production requires TLS certificate verification (sslmode=verify-full)', () => {
  const prodBase = {
    ...base, NODE_ENV: 'production', DATABASE_BACKEND: 'postgres', POSTGRES_SSL: 'true',
    OIDC_ISSUER: 'https://identity.example.test/', OIDC_JWKS_URL: 'https://identity.example.test/jwks',
    CORS_ORIGINS: 'https://app.example.test',
  };
  assert.throws(() => loadRuntimeConfig({ ...prodBase, POSTGRES_URL: 'postgres://app:secret@db.example.test:5432/health' }), /sslmode=verify-full/);
  assert.throws(() => loadRuntimeConfig({ ...prodBase, POSTGRES_URL: 'postgres://app:secret@db.example.test:5432/health?sslmode=require' }), /sslmode=verify-full/);
  assert.throws(() => loadRuntimeConfig({ ...prodBase, POSTGRES_URL: 'postgres://app:secret@db.example.test:5432/health?sslmode=disable' }), /sslmode=verify-full/);
  assert.equal(loadRuntimeConfig({ ...prodBase, POSTGRES_URL: 'postgres://app:secret@db.example.test:5432/health?sslmode=verify-full' }).postgresSsl, true);
  assert.equal(loadRuntimeConfig({ ...prodBase, POSTGRES_URL: 'postgres://app:secret@db.example.test:5432/health?sslmode=verify-ca' }).postgresSsl, true);
  assert.throws(() => loadRuntimeConfig({ ...base, DATABASE_BACKEND: 'postgres', POSTGRES_URL: 'postgres://u:p@h/db?sslmode=disable', POSTGRES_SSL: 'true' }), /contradicts POSTGRES_SSL=true/);
});

test('runtime config rejects wildcard/path CORS entries and invalid numeric settings', () => {
  assert.throws(() => loadRuntimeConfig({ ...base, CORS_ORIGINS: '*' }), /wildcard/);
  assert.throws(() => loadRuntimeConfig({ ...base, CORS_ORIGINS: 'http://localhost:5173/path' }), /origins only/);
  assert.throws(() => loadRuntimeConfig({ ...base, PORT: '70000' }), /PORT must be an integer/);
  assert.throws(() => loadRuntimeConfig({ ...base, RATE_LIMIT_MAX_REQUESTS: '0' }), /RATE_LIMIT_MAX_REQUESTS must be an integer/);
});


test('runtime config selects PostgreSQL and ignores SQLite path', () => {
  const config = loadRuntimeConfig({ ...base, DATABASE_BACKEND: 'postgres', POSTGRES_URL: 'postgres://app:secret@db.example.test:5432/health_test', POSTGRES_SSL: 'true' });
  assert.equal(config.databaseBackend, 'postgres');
  assert.equal(config.postgresSsl, true);
  assert.equal(config.databasePath, null);
  assert.equal(config.postgresUrl, 'postgres://app:secret@db.example.test:5432/health_test');
});

test('runtime config validates PostgreSQL URL and backend-specific requirements', () => {
  assert.throws(() => loadRuntimeConfig({ ...base, DATABASE_BACKEND: 'postgres' }), /POSTGRES_URL is required/);
  assert.throws(() => loadRuntimeConfig({ ...base, DATABASE_BACKEND: 'postgres', POSTGRES_URL: 'https://db.example.test' }), /must use postgres/);
  assert.throws(() => loadRuntimeConfig({ ...base, DATABASE_BACKEND: 'mysql' }), /must be sqlite or postgres/);
});

test('runtime config provides observability and shutdown defaults with bounds', () => {
  const config = loadRuntimeConfig({ ...base });
  assert.equal(config.shutdownTimeoutMs, 10_000);
  assert.equal(config.readinessTimeoutMs, 2_000);
  const tuned = loadRuntimeConfig({ ...base, SHUTDOWN_TIMEOUT_MS: '1500', READINESS_TIMEOUT_MS: '300' });
  assert.equal(tuned.shutdownTimeoutMs, 1500);
  assert.equal(tuned.readinessTimeoutMs, 300);
  assert.throws(() => loadRuntimeConfig({ ...base, SHUTDOWN_TIMEOUT_MS: '0' }), /SHUTDOWN_TIMEOUT_MS must be an integer/);
  assert.throws(() => loadRuntimeConfig({ ...base, SHUTDOWN_TIMEOUT_MS: '120001' }), /SHUTDOWN_TIMEOUT_MS must be an integer/);
  assert.throws(() => loadRuntimeConfig({ ...base, READINESS_TIMEOUT_MS: '99' }), /READINESS_TIMEOUT_MS must be an integer/);
  assert.throws(() => loadRuntimeConfig({ ...base, READINESS_TIMEOUT_MS: '30001' }), /READINESS_TIMEOUT_MS must be an integer/);
});

