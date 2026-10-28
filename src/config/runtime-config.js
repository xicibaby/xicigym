const isNonEmpty = (value) => typeof value === 'string' && value.trim().length > 0;

function parseAbsoluteUrl(value, name) {
  let url;
  try { url = new URL(value); } catch { throw new TypeError(`${name} must be an absolute URL`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new TypeError(`${name} must be an HTTP(S) URL without embedded credentials`);
  }
  return url;
}
function parseInteger(value, fallback, name, min, max) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new TypeError(`${name} must be an integer between ${min} and ${max}`);
  return parsed;
}
function parseOrigins(raw, isProduction) {
  const values = (raw ?? '').split(',').map((v) => v.trim()).filter(Boolean);
  const origins = [];
  for (const value of values) {
    if (value === '*') throw new TypeError('CORS_ORIGINS must not contain wildcard origin');
    const url = parseAbsoluteUrl(value, 'CORS_ORIGINS entry');
    if (url.pathname !== '/' || url.search || url.hash) throw new TypeError('CORS_ORIGINS entries must be origins only, without path/query/fragment');
    if (isProduction && url.protocol !== 'https:') throw new TypeError('CORS_ORIGINS must use HTTPS in production');
    if (!origins.includes(url.origin)) origins.push(url.origin);
  }
  if (isProduction && origins.length === 0) throw new TypeError('CORS_ORIGINS must contain at least one explicit HTTPS origin in production');
  return origins;
}

/** Validate deployment configuration before opening the listener or database. */
export function loadRuntimeConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV || 'development';
  const isProduction = nodeEnv === 'production';
  const issuer = env.OIDC_ISSUER?.trim();
  const audience = env.OIDC_AUDIENCE?.trim();
  const jwksUrlRaw = env.OIDC_JWKS_URL?.trim();
  const databaseBackend = (env.DATABASE_BACKEND || (isProduction ? 'postgres' : 'sqlite')).trim().toLowerCase();
  const databasePath = env.DATABASE_PATH?.trim();
  const postgresUrl = env.POSTGRES_URL?.trim();
  const postgresSsl = env.POSTGRES_SSL === 'true';

  if (!isNonEmpty(issuer)) throw new TypeError('OIDC_ISSUER is required');
  if (!isNonEmpty(audience)) throw new TypeError('OIDC_AUDIENCE is required');
  if (!isNonEmpty(jwksUrlRaw)) throw new TypeError('OIDC_JWKS_URL is required');
  if (!['sqlite', 'postgres'].includes(databaseBackend)) throw new TypeError('DATABASE_BACKEND must be sqlite or postgres');
  if (databaseBackend === 'sqlite' && !isNonEmpty(databasePath)) throw new TypeError('DATABASE_PATH is required when DATABASE_BACKEND=sqlite');
  if (databaseBackend === 'postgres' && !isNonEmpty(postgresUrl)) throw new TypeError('POSTGRES_URL is required when DATABASE_BACKEND=postgres');
  if (isProduction && databaseBackend !== 'postgres') throw new TypeError('DATABASE_BACKEND=postgres is required in production');
  if (databaseBackend === 'postgres') {
    let databaseUrl;
    try { databaseUrl = new URL(postgresUrl); } catch { throw new TypeError('POSTGRES_URL must be a valid PostgreSQL URL'); }
    if (!['postgres:', 'postgresql:'].includes(databaseUrl.protocol)) throw new TypeError('POSTGRES_URL must use postgres:// or postgresql://');
    if (isProduction && !postgresSsl) throw new TypeError('POSTGRES_SSL=true is required in production');
    const sslmode = databaseUrl.searchParams.get('sslmode');
    if (isProduction) {
      // Certificate validation must stay enabled end-to-end; require/libpq defaults are not
      // sufficient evidence of hostname+CA verification.
      if (sslmode !== 'verify-full' && sslmode !== 'verify-ca') {
        throw new TypeError('POSTGRES_URL must set sslmode=verify-full (or verify-ca) in production');
      }
    }
    if (!isProduction && sslmode === 'disable' && postgresSsl) {
      throw new TypeError('POSTGRES_URL sslmode=disable contradicts POSTGRES_SSL=true');
    }
  }

  const issuerUrl = parseAbsoluteUrl(issuer, 'OIDC_ISSUER');
  const jwksUrl = parseAbsoluteUrl(jwksUrlRaw, 'OIDC_JWKS_URL');
  if (isProduction && (issuerUrl.protocol !== 'https:' || jwksUrl.protocol !== 'https:')) {
    throw new TypeError('OIDC_ISSUER and OIDC_JWKS_URL must use HTTPS in production');
  }
  if (isProduction && databaseBackend === 'sqlite' && databasePath === ':memory:') throw new TypeError('DATABASE_PATH must be persistent in production');

  const corsOrigins = parseOrigins(env.CORS_ORIGINS, isProduction);
  const port = parseInteger(env.PORT, 3000, 'PORT', 1, 65535);
  const rateLimitWindowMs = parseInteger(env.RATE_LIMIT_WINDOW_MS, 60_000, 'RATE_LIMIT_WINDOW_MS', 1000, 86_400_000);
  const rateLimitMaxRequests = parseInteger(env.RATE_LIMIT_MAX_REQUESTS, 120, 'RATE_LIMIT_MAX_REQUESTS', 1, 1_000_000);
  const shutdownTimeoutMs = parseInteger(env.SHUTDOWN_TIMEOUT_MS, 10_000, 'SHUTDOWN_TIMEOUT_MS', 100, 120_000);
  const readinessTimeoutMs = parseInteger(env.READINESS_TIMEOUT_MS, 2_000, 'READINESS_TIMEOUT_MS', 100, 30_000);
  const host = env.HOST?.trim() || '127.0.0.1';

  return Object.freeze({
    nodeEnv, isProduction, issuer: issuerUrl.href, audience,
    jwksUrl: jwksUrl.href, databaseBackend, databasePath: databaseBackend === 'sqlite' ? databasePath : null, postgresUrl: postgresUrl || null, postgresSsl, corsOrigins, host, port,
    rateLimit: Object.freeze({ windowMs: rateLimitWindowMs, maxRequests: rateLimitMaxRequests }),
    shutdownTimeoutMs, readinessTimeoutMs,
  });
}
