import test from 'node:test';
import assert from 'node:assert/strict';
import { createMetricsRegistry } from '../src/observability/metrics.js';

test('metrics registry increments counters and renders Prometheus text', () => {
  const metrics = createMetricsRegistry();
  metrics.describe('health_skill_http_requests_total', { type: 'counter', help: 'requests' });
  metrics.describe('health_skill_ready', { type: 'gauge', help: 'readiness' });
  metrics.inc('health_skill_http_requests_total', { method: 'GET', status: '200' });
  metrics.inc('health_skill_http_requests_total', { method: 'GET', status: '200' });
  metrics.set('health_skill_ready', 1);
  const text = metrics.render();
  assert.match(text, /# HELP health_skill_http_requests_total requests/);
  assert.match(text, /# TYPE health_skill_http_requests_total counter/);
  assert.match(text, /health_skill_http_requests_total\{method="GET",status="200"\} 2/);
  assert.match(text, /# TYPE health_skill_ready gauge/);
  assert.match(text, /health_skill_ready 1/);
  assert.ok(text.endsWith('\n'));
});

test('metrics rendering is deterministic and escapes label values', () => {
  const metrics = createMetricsRegistry();
  metrics.inc('health_skill_http_requests_total', { method: 'GET', status: '500' });
  metrics.inc('health_skill_http_requests_total', { method: 'GET', status: '200' });
  metrics.inc('health_skill_http_requests_total', { method: 'path"with\\quote', status: '200' });
  const first = metrics.render();
  const second = metrics.render();
  assert.equal(first, second);
  assert.ok(first.indexOf('status="200"') < first.indexOf('status="500"'));
  assert.match(first, /method="path\\"with\\\\quote"/);
});

test('in-flight gauge returns to zero and counters use observeHttpRequest', () => {
  const metrics = createMetricsRegistry();
  metrics.inc('health_skill_http_in_flight_requests');
  metrics.inc('health_skill_http_in_flight_requests');
  assert.match(metrics.render(), /health_skill_http_in_flight_requests 2/);
  metrics.inc('health_skill_http_in_flight_requests', {}, -1);
  metrics.inc('health_skill_http_in_flight_requests', {}, -1);
  assert.match(metrics.render(), /health_skill_http_in_flight_requests 0/);
  metrics.observeHttpRequest('post', 201);
  assert.match(metrics.render(), /health_skill_http_requests_total\{method="POST",status="201"\} 1/);
});

test('metrics registry rejects unsafe names, labels and values', () => {
  const metrics = createMetricsRegistry();
  assert.throws(() => metrics.inc('Unsafe-Metric'), /lowercase snake_case/);
  assert.throws(() => metrics.inc('health_skill_x', { 'bad-label': 'v' }), /invalid metric label name/);
  assert.throws(() => metrics.set('health_skill_x', -1), /non-negative/);
  assert.throws(() => metrics.set('health_skill_x', Number.POSITIVE_INFINITY), /non-negative/);
  assert.throws(() => metrics.inc('health_skill_x', { a: 'x'.repeat(201) }), /too long/);
  assert.throws(() => metrics.describe('health_skill_x', { type: 'histogram' }), /unsupported metric type/);
});

test('snapshot exposes current series values for assertions', () => {
  const metrics = createMetricsRegistry();
  metrics.set('health_skill_ready', 1);
  metrics.inc('health_skill_http_requests_total', { method: 'GET', status: '200' }, 3);
  const snapshot = metrics.snapshot();
  assert.equal(snapshot.health_skill_ready, 1);
  assert.equal(snapshot['health_skill_http_requests_total{method="GET",status="200"}'], 3);
});
