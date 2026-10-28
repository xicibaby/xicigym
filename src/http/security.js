/**
 * Small, dependency-free HTTP security helpers for the reference server.
 * In-memory rate limiting is only suitable for a single process; production
 * multi-instance deployments must inject a shared limiter at the gateway.
 */
export function createSecurityPolicy({
  corsOrigins = [],
  rateLimit = { windowMs: 60_000, maxRequests: 120 },
  now = () => Date.now(),
} = {}) {
  if (!Array.isArray(corsOrigins) || corsOrigins.some((origin) => typeof origin !== 'string' || !origin.trim())) {
    throw new TypeError('corsOrigins must be an array of non-empty origin strings');
  }
  const origins = new Set(corsOrigins);
  const windowMs = rateLimit?.windowMs ?? 60_000;
  const maxRequests = rateLimit?.maxRequests ?? 120;
  if (!Number.isInteger(windowMs) || windowMs < 1000 || !Number.isInteger(maxRequests) || maxRequests < 1) {
    throw new TypeError('rateLimit requires windowMs >= 1000 and maxRequests >= 1');
  }
  const windows = new Map();

  function applyHeaders(req, res) {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('x-frame-options', 'DENY');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('cache-control', 'no-store');
    res.setHeader('cross-origin-resource-policy', 'same-site');
    const origin = req.headers.origin;
    if (origin && origins.has(origin)) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('vary', 'Origin');
      res.setHeader('access-control-allow-credentials', 'true');
      res.setHeader('access-control-allow-methods', 'GET, POST, PATCH, OPTIONS');
      res.setHeader('access-control-allow-headers', 'Authorization, Content-Type, Idempotency-Key, X-Request-Id');
      res.setHeader('access-control-max-age', '600');
      return { originAllowed: true, hasOrigin: true };
    }
    return { originAllowed: !origin, hasOrigin: Boolean(origin) };
  }

  function consume(key) {
    const current = now();
    let entry = windows.get(key);
    if (!entry || current >= entry.resetAt) entry = { count: 0, resetAt: current + windowMs };
    entry.count += 1;
    windows.set(key, entry);
    // Periodically prune expired keys to avoid unbounded memory growth.
    if (windows.size > 10_000) {
      for (const [k, v] of windows) if (current >= v.resetAt) windows.delete(k);
    }
    return { allowed: entry.count <= maxRequests, remaining: Math.max(0, maxRequests - entry.count), retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - current) / 1000)) };
  }

  return { applyHeaders, consume, origins, rateLimit: { windowMs, maxRequests } };
}

export function requireJsonContentType(req) {
  const value = req.headers['content-type'];
  if (typeof value !== 'string' || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(value.trim())) {
    const error = new Error('请求必须使用 Content-Type: application/json。');
    error.name = 'HttpInputError';
    error.statusCode = 415;
    throw error;
  }
}
