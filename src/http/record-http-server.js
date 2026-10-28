import { createServer } from 'node:http';
import { RECORD_STATUSES, RECORD_TYPES } from '../record-contract.js';
import { createSecurityPolicy, requireJsonContentType } from './security.js';

const MAX_BODY_BYTES = 1024 * 1024;
const FORBIDDEN_PATCH_FIELDS = new Set(['recordId', 'userId', 'status', 'schemaVersion', 'revision', 'createdAt']);

class HttpInputError extends Error { constructor(message) { super(message); this.name = 'HttpInputError'; } }

async function readJson(req) {
  let body = ''; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) { const e = new HttpInputError('请求体超过 1 MiB 限制。'); e.statusCode = 413; throw e; }
    body += chunk;
  }
  if (!body) return {};
  try { return JSON.parse(body); } catch { throw new HttpInputError('请求体必须是有效 JSON。'); }
}
function send(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(body);
}
function requireObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpInputError('请求体必须是 JSON 对象。');
  return value;
}
function checkPatch(patch) {
  requireObject(patch);
  const forbidden = Object.keys(patch).filter((key) => FORBIDDEN_PATCH_FIELDS.has(key));
  if (forbidden.length) throw new HttpInputError(`这些字段不可由客户端修改：${forbidden.join(', ')}`);
  return patch;
}
function expectedRevision(value) {
  if (!Number.isInteger(value) || value < 0) throw new HttpInputError('expectedRevision 必须是非负整数。');
  return value;
}
function mapError(error) {
  if (error.statusCode) return error.statusCode;
  switch (error.name) {
    case 'UnauthenticatedError': return 401;
    case 'RecordNotFoundError': return 404;
    case 'RecordConflictError': return 409;
    case 'RecordStateError': return 409;
    case 'RecordValidationError': return 422;
    case 'HttpInputError': return error.statusCode ?? 400;
    case 'TypeError': return 400;
    default: return 500;
  }
}

/**
 * Minimal dependency-free HTTP adapter. `authenticate(req)` must verify a real
 * session/JWT using the chosen identity provider and return { userId } or null.
 * No insecure built-in token parsing or demo identity is provided.
 *
 * Optional infrastructure wiring:
 * - `metrics`: registry from observability/metrics.js; records request counters and in-flight gauge.
 * - `probeEndpoints`: from http/probe-endpoints.js; serves /healthz, /readyz, /metrics without auth.
 */
export function createRecordHttpServer({ recordService, authenticate, corsOrigins = [], rateLimit, securityPolicy, metrics = null, probeEndpoints = null } = {}) {
  if (!recordService) throw new TypeError('recordService is required');
  if (typeof authenticate !== 'function') throw new TypeError('authenticate(req) adapter is required; fail-closed by design');
  if (probeEndpoints && typeof probeEndpoints.handle !== 'function') throw new TypeError('probeEndpoints.handle must be a function');
  const security = securityPolicy ?? createSecurityPolicy({ corsOrigins, ...(rateLimit ? { rateLimit } : {}) });

  function trackRequest(req, res) {
    if (!metrics) return;
    metrics.inc('health_skill_http_in_flight_requests');
    let recorded = false;
    const finish = () => {
      if (recorded) return;
      recorded = true;
      metrics.inc('health_skill_http_in_flight_requests', {}, -1);
      metrics.observeHttpRequest(req.method, res.statusCode);
    };
    res.once('finish', finish);
    res.once('close', finish);
  }

  return createServer(async (req, res) => {
    trackRequest(req, res);
    const cors = security.applyHeaders(req, res);
    try {
      if (cors.hasOrigin && !cors.originAllowed) return send(res, 403, { error: { code: 'ORIGIN_NOT_ALLOWED', message: '请求来源不在允许列表中。' } });
      if (probeEndpoints && await probeEndpoints.handle(req, res)) return;
      if (!req.url || !req.url.startsWith('/v1/records')) return send(res, 404, { error: { code: 'NOT_FOUND', message: '接口不存在。' } });
      if (req.method === 'OPTIONS') {
        if (cors.hasOrigin && !cors.originAllowed) return send(res, 403, { error: { code: 'ORIGIN_NOT_ALLOWED', message: '请求来源不在允许列表中。' } });
        res.writeHead(204, { 'allow': 'GET,POST,PATCH,OPTIONS' }); return res.end();
      }
      const principal = await authenticate(req);
      if (!principal || typeof principal.userId !== 'string' || !principal.userId.trim()) {
        return send(res, 401, { error: { code: 'UNAUTHENTICATED', message: '请先登录。' } });
      }
      const throttle = security.consume(`user:${principal.userId}`);
      res.setHeader('ratelimit-limit', String(security.rateLimit.maxRequests));
      res.setHeader('ratelimit-remaining', String(throttle.remaining));
      res.setHeader('ratelimit-reset', String(Math.ceil(Date.now() / 1000) + throttle.retryAfterSeconds));
      if (!throttle.allowed) { res.setHeader('retry-after', String(throttle.retryAfterSeconds)); return send(res, 429, { error: { code: 'RATE_LIMITED', message: '请求过于频繁，请稍后重试。' } }); }
      const url = new URL(req.url, 'http://localhost');
      const match = url.pathname.match(/^\/v1\/records(?:\/([^/]+))?(?:\/(confirm|history|corrections|restore))?$/);
      if (!match) return send(res, 404, { error: { code: 'NOT_FOUND', message: '接口不存在。' } });
      const recordId = match[1] ? decodeURIComponent(match[1]) : null;
      const action = match[2] ?? null;
      let result;
      if (req.method === 'GET' && !recordId && !action) {
        const limitRaw = url.searchParams.get('limit');
        const offsetRaw = url.searchParams.get('offset');
        const limit = limitRaw === null ? 20 : Number(limitRaw);
        const offset = offsetRaw === null ? 0 : Number(offsetRaw);
        if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new HttpInputError('limit 必须是 1 到 100 的整数。');
        if (!Number.isInteger(offset) || offset < 0) throw new HttpInputError('offset 必须是非负整数。');
        const recordType = url.searchParams.get('recordType') ?? undefined;
        const status = url.searchParams.get('status') ?? undefined;
        if (recordType && !RECORD_TYPES.includes(recordType)) throw new HttpInputError('recordType 不受支持。');
        if (status && !RECORD_STATUSES.includes(status)) throw new HttpInputError('status 不受支持。');
        result = await recordService.listRecords(principal, { limit, offset, recordType, status });
        return send(res, 200, { data: result });
      }
      if (req.method === 'POST' && !recordId && !action) {
        requireJsonContentType(req);
        result = await recordService.createDraft(principal, requireObject(await readJson(req)));
        return send(res, 201, { data: result });
      }
      if (req.method === 'GET' && recordId && !action) {
        result = await recordService.getRecord(principal, recordId);
        return send(res, 200, { data: result });
      }
      if (req.method === 'PATCH' && recordId && !action) {
        requireJsonContentType(req);
        const body = requireObject(await readJson(req));
        result = await recordService.updateDraft(principal, recordId, checkPatch(body.patch), expectedRevision(body.expectedRevision));
        return send(res, 200, { data: result });
      }
      if (req.method === 'POST' && recordId && action === 'confirm') {
        requireJsonContentType(req);
        const body = requireObject(await readJson(req));
        result = await recordService.confirmRecord(principal, recordId, { expectedRevision: expectedRevision(body.expectedRevision), idempotencyKey: body.idempotencyKey });
        return send(res, 200, { data: result });
      }
      if (req.method === 'GET' && recordId && action === 'history') {
        result = await recordService.getHistory(principal, recordId);
        return send(res, 200, { data: result });
      }
      if (req.method === 'POST' && recordId && action === 'corrections') {
        requireJsonContentType(req);
        const body = requireObject(await readJson(req));
        result = await recordService.correctRecord(principal, recordId, checkPatch(body.patch), { expectedRevision: expectedRevision(body.expectedRevision), reason: body.reason ?? 'user_correction' });
        return send(res, 200, { data: result });
      }
      if (req.method === 'POST' && recordId && action === 'restore') {
        requireJsonContentType(req);
        const body = requireObject(await readJson(req));
        if (!Number.isInteger(body.targetRevision) || body.targetRevision < 0) throw new HttpInputError('targetRevision 必须是非负整数。');
        result = await recordService.restoreRevision(principal, recordId, body.targetRevision, { expectedRevision: expectedRevision(body.expectedRevision) });
        return send(res, 200, { data: result });
      }
      return send(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: '该接口不支持此请求方法。' } });
    } catch (error) {
      const status = mapError(error);
      const code = status === 401 ? 'UNAUTHENTICATED' : status === 403 ? 'FORBIDDEN' : status === 404 ? 'NOT_FOUND' : status === 409 ? 'CONFLICT' : status === 415 ? 'UNSUPPORTED_MEDIA_TYPE' : status === 422 ? 'VALIDATION_FAILED' : status === 413 ? 'PAYLOAD_TOO_LARGE' : status === 429 ? 'RATE_LIMITED' : status === 400 ? 'BAD_REQUEST' : 'INTERNAL_ERROR';
      const payload = { error: { code, message: status === 500 ? '服务暂时无法处理请求。' : error.message } };
      if (status === 422 && Array.isArray(error.details)) payload.error.details = error.details;
      if (status === 500) console.error('Unhandled record API error:', error);
      return send(res, status, payload);
    }
  });
}
