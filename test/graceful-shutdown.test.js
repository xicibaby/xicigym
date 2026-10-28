import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { createGracefulShutdown } from '../src/http/shutdown.js';

const quietLogger = { info() {}, error() {} };

async function listen(handler) {
  const server = createHttpServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test('graceful shutdown closes the listener and resources exactly once', async () => {
  const { server, base } = await listen((req, res) => res.end('ok'));
  let resourceCloses = 0;
  const controller = createGracefulShutdown({
    server, logger: quietLogger, timeoutMs: 2_000,
    closeResources: [async () => { resourceCloses += 1; }],
  });
  assert.equal(controller.isShuttingDown(), false);
  const first = controller.shutdown();
  const second = controller.shutdown();
  assert.equal(first, second, 'shutdown must be idempotent and return the same promise');
  const result = await first;
  assert.equal(result.closed, true);
  assert.equal(result.timedOut, false);
  assert.equal(result.resourceCloseFailures.length, 0);
  assert.equal(resourceCloses, 1);
  assert.equal(controller.isShuttingDown(), true);
  await assert.rejects(fetch(`${base}/health`), /fetch failed|ECONNREFUSED/);
});

test('graceful shutdown waits for an in-flight request before closing', async () => {
  let releaseInFlight;
  let markStarted;
  const requestStarted = new Promise((resolve) => { markStarted = resolve; });
  const inFlightGate = new Promise((resolve) => { releaseInFlight = resolve; });
  const { server, base } = await listen(async (req, res) => {
    markStarted();
    await inFlightGate;
    res.end('finished');
  });
  const request = fetch(`${base}/slow`).then((response) => response.text());
  await requestStarted;
  const controller = createGracefulShutdown({ server, logger: quietLogger, timeoutMs: 2_000 });
  const shutdownPromise = controller.shutdown();
  setTimeout(() => releaseInFlight(), 100);
  assert.equal(await request, 'finished');
  const result = await shutdownPromise;
  assert.equal(result.closed, true);
  assert.equal(result.timedOut, false);
  assert.ok(result.durationMs >= 50);
});

test('graceful shutdown force-closes connections after the timeout', async () => {
  let markStarted;
  const requestStarted = new Promise((resolve) => { markStarted = resolve; });
  const { server, base } = await listen((req, res) => { markStarted(); /* never responds */ });
  const controller = createGracefulShutdown({ server, logger: quietLogger, timeoutMs: 150 });
  const pending = fetch(`${base}/hang`).catch((error) => error.name);
  await requestStarted;
  const result = await controller.shutdown();
  assert.equal(result.timedOut, true);
  assert.equal(result.closed, false);
  assert.ok(result.durationMs >= 100);
  const outcome = await pending;
  assert.ok(typeof outcome === 'string', `request should have been aborted, got ${outcome}`);
});

test('resource close failures are reported, not thrown, and remaining resources still close', async () => {
  const { server } = await listen((req, res) => res.end('ok'));
  let secondClosed = false;
  const controller = createGracefulShutdown({
    server,
    logger: quietLogger,
    timeoutMs: 1_000,
    closeResources: [
      async () => { throw new Error('pool close failed for postgresql://user:pass@host/db'); },
      async () => { secondClosed = true; },
    ],
  });
  const result = await controller.shutdown();
  assert.equal(result.closed, true);
  assert.equal(result.resourceCloseFailures.length, 1);
  assert.ok(!result.resourceCloseFailures[0].includes('pass'), 'reported failures must redact credentials');
  assert.equal(secondClosed, true);
});

test('shutdown validates inputs', () => {
  assert.throws(() => createGracefulShutdown({ server: {}, logger: quietLogger }), /server with close/);
  const { server } = { server: { close() {} } };
  assert.throws(() => createGracefulShutdown({ server, timeoutMs: 10 }), /timeoutMs/);
  assert.throws(() => createGracefulShutdown({ server, closeResources: ['nope'] }), /closeResources/);
});
