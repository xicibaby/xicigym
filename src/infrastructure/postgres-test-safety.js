/**
 * Safety guard for integration tests that run schema migrations and mutate test rows.
 * Never log the supplied URL because it may contain credentials.
 */
export function validateDisposablePostgresTestUrl(value, { allowNonDisposable = false } = {}) {
  if (!value) return 'Set POSTGRES_TEST_URL to a disposable PostgreSQL test database.';
  let parsed;
  try { parsed = new URL(value); } catch { return 'POSTGRES_TEST_URL must be a valid PostgreSQL URL.'; }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) return 'POSTGRES_TEST_URL must use postgres:// or postgresql://.';
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, '')).toLowerCase();
  if (!/(^|[-_])(test|tests|testing|temp|temporary|sandbox|ci)([-_]|$)/.test(databaseName) && !allowNonDisposable) {
    return 'Refusing to run destructive integration setup on a database not clearly marked test/temp/sandbox/ci. Use a disposable database or explicitly set POSTGRES_TEST_ALLOW_NON_DISPOSABLE=1 after review.';
  }
  return null;
}
