/**
 * Idempotent graceful shutdown for the HTTP listener plus database resources.
 *
 * Order: stop accepting new connections -> wait for in-flight requests to finish
 * (bounded by timeoutMs) -> close database resources. When the timeout expires the
 * remaining sockets are force-closed so an operator restart cannot hang forever.
 * Calling shutdown() twice returns the same promise; it never throws for expected
 * shutdown failures (it reports them instead).
 */
const DEFAULT_TIMEOUT_MS = 10_000;

function safeErrorMessage(error) {
  const message = typeof error?.message === 'string' ? error.message : String(error);
  // Keep error reporting free of connection strings or credentials.
  return message.replace(/(?:postgres(?:ql)?:\/\/)[^\s'"]+/gi, '[redacted-database-url]').slice(0, 300);
}

export function createGracefulShutdown({
  server,
  closeResources = [],
  logger = console,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  now = () => Date.now(),
} = {}) {
  if (!server || typeof server.close !== 'function') throw new TypeError('server with close() is required');
  if (!Array.isArray(closeResources) || closeResources.some((close) => typeof close !== 'function')) {
    throw new TypeError('closeResources must be an array of functions');
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) {
    throw new TypeError('timeoutMs must be an integer between 100 and 120000');
  }

  let shutdownPromise = null;

  async function stopListener() {
    return await new Promise((resolve) => {
      let settled = false;
      // Node closes idle keep-alive sockets when close() is called, but sockets that
      // become idle after an in-flight response need an explicit sweep.
      const sweeper = setInterval(() => {
        try { server.closeIdleConnections?.(); } catch { /* ignore */ }
      }, 50);
      sweeper.unref?.();
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearInterval(sweeper);
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => {
        try { server.closeAllConnections?.(); } catch { /* ignore */ }
        finish({ closed: false, timedOut: true });
      }, timeoutMs);
      timer.unref?.();
      try {
        server.close((error) => finish({ closed: !error, timedOut: false }));
        server.closeIdleConnections?.();
      } catch (error) {
        finish({ closed: false, timedOut: false, error: safeErrorMessage(error) });
      }
    });
  }

  async function closeAllResources() {
    const failures = [];
    for (const close of closeResources) {
      try { await close(); }
      catch (error) { failures.push(safeErrorMessage(error)); logger?.error?.('shutdown: resource close failed:', safeErrorMessage(error)); }
    }
    return failures;
  }

  function shutdown() {
    if (shutdownPromise) return shutdownPromise;
    const startedAt = now();
    shutdownPromise = (async () => {
      const listener = await stopListener();
      const failures = await closeAllResources();
      const durationMs = Math.max(0, now() - startedAt);
      const result = { closed: listener.closed, timedOut: listener.timedOut, durationMs, resourceCloseFailures: failures };
      if (listener.timedOut) logger?.error?.(`shutdown: listener did not drain within ${timeoutMs}ms; remaining connections were force-closed.`);
      return result;
    })();
    return shutdownPromise;
  }

  return { shutdown, isShuttingDown: () => shutdownPromise !== null };
}
