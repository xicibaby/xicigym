/**
 * Kubernetes-style liveness/readiness probes plus a Prometheus metrics endpoint.
 *
 * - GET /healthz  liveness: the HTTP process answers. Never touches the database.
 * - GET /readyz   readiness: bounded-time dependency check (database reachable and
 *                 schema version supported). Returns 503 on failure.
 * - GET /metrics  aggregate process/HTTP metrics; never includes record content,
 *                 credentials, tokens or user identifiers.
 *
 * These endpoints are unauthenticated by design for infrastructure probes. Deploy
 * them behind a private network or gateway allow-list; they expose no tenant data.
 */
const DEFAULT_READINESS_TIMEOUT_MS = 2_000;

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

export function createProbeEndpoints({
  readinessCheck,
  metrics = null,
  version = '0.0.0',
  serviceName = 'health-skill-record-api',
  startedAt = Date.now(),
  now = () => Date.now(),
  readinessTimeoutMs = DEFAULT_READINESS_TIMEOUT_MS,
} = {}) {
  if (typeof readinessCheck !== 'function') throw new TypeError('readinessCheck must be a function');
  if (!Number.isInteger(readinessTimeoutMs) || readinessTimeoutMs < 100 || readinessTimeoutMs > 30_000) {
    throw new TypeError('readinessTimeoutMs must be an integer between 100 and 30000');
  }

  if (metrics) {
    metrics.describe('health_skill_http_requests_total', { type: 'counter', help: 'HTTP requests handled, by method and status code.' });
    metrics.describe('health_skill_http_in_flight_requests', { type: 'gauge', help: 'HTTP requests currently being handled.' });
    metrics.describe('health_skill_ready', { type: 'gauge', help: '1 when the last readiness probe succeeded, else 0.' });
    metrics.describe('health_skill_db_schema_version', { type: 'gauge', help: 'Schema migration version reported by the last readiness probe.' });
    metrics.describe('health_skill_uptime_seconds', { type: 'gauge', help: 'Seconds since the process started serving.' });
    metrics.set('health_skill_ready', 0);
    metrics.set('health_skill_uptime_seconds', 0);
  }

  let lastReadiness = Object.freeze({ ready: false, checkedAt: null, error: 'not_checked' });

  async function runReadiness() {
    const started = now();
    let result;
    try {
      let timer;
      const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve({ ready: false, error: 'readiness_timeout' }), readinessTimeoutMs);
        timer.unref?.();
      });
      try {
        result = await Promise.race([Promise.resolve().then(() => readinessCheck()), timeout]);
      } finally {
        clearTimeout(timer);
      }
      if (!result || typeof result !== 'object' || Array.isArray(result)) result = { ready: false, error: 'invalid_readiness_result' };
    } catch {
      // Never surface the underlying error text: it can contain a connection string.
      result = { ready: false, error: 'readiness_check_failed' };
    }
    const ready = result.ready === true;
    lastReadiness = Object.freeze({
      ready,
      backend: result.backend ?? null,
      schemaVersion: Number.isInteger(result.schemaVersion) ? result.schemaVersion : null,
      latencyMs: Math.max(0, now() - started),
      checkedAt: new Date(now()).toISOString(),
      ...(ready ? {} : { error: typeof result.error === 'string' ? result.error : 'not_ready' }),
    });
    if (metrics) {
      metrics.set('health_skill_ready', ready ? 1 : 0);
      if (lastReadiness.schemaVersion !== null) metrics.set('health_skill_db_schema_version', lastReadiness.schemaVersion);
    }
    return lastReadiness;
  }

  function wantPath(req) {
    if (!req?.url) return null;
    try {
      const url = new URL(req.url, 'http://localhost');
      if (!['/healthz', '/readyz', '/metrics'].includes(url.pathname)) return null;
      return url.pathname;
    } catch {
      return null;
    }
  }

  /** Returns true when the request was handled. Callers should continue routing otherwise. */
  async function handle(req, res) {
    const path = wantPath(req);
    if (!path) return false;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD', 'cache-control': 'no-store' });
      res.end();
      return true;
    }
    if (path === '/healthz') {
      const payload = {
        status: 'ok',
        service: serviceName,
        version,
        uptimeSeconds: Math.max(0, Math.round((now() - startedAt) / 1000)),
      };
      if (req.method === 'HEAD') { res.writeHead(200, { 'cache-control': 'no-store' }); res.end(); return true; }
      sendJson(res, 200, payload);
      return true;
    }
    if (path === '/readyz') {
      const readiness = await runReadiness();
      if (req.method === 'HEAD') { res.writeHead(readiness.ready ? 200 : 503, { 'cache-control': 'no-store' }); res.end(); return true; }
      sendJson(res, readiness.ready ? 200 : 503, readiness.ready ? { status: 'ready', ...readiness } : { status: 'not_ready', ...readiness });
      return true;
    }
    // /metrics
    if (req.method === 'HEAD') { res.writeHead(200, { 'cache-control': 'no-store' }); res.end(); return true; }
    if (!metrics) {
      res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end('metrics are not configured\n');
      return true;
    }
    metrics.set('health_skill_uptime_seconds', Math.max(0, Math.round((now() - startedAt) / 1000)));
    const body = metrics.render();
    res.writeHead(200, {
      'content-type': 'text/plain; version=0.0.4; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
    });
    res.end(body);
    return true;
  }

  return { handle, runReadiness, lastReadiness: () => lastReadiness, paths: Object.freeze(['/healthz', '/readyz', '/metrics']) };
}
