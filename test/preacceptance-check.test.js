import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateDisposablePostgresTestUrl } from '../src/infrastructure/postgres-test-safety.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

test('pre-acceptance syntax mode reports PASS without requiring external services', () => {
  const result = spawnSync(process.execPath, ['scripts/preacceptance-check.js', '--syntax-only'], {
    cwd: root, encoding: 'utf8', timeout: 30000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.decision, 'PASS');
  assert.equal(report.localChecksPass, true);
  assert.ok(report.findings.some((finding) => finding.check === 'javascript-syntax' && finding.status === 'PASS'));
});

test('PostgreSQL integration safety guard accepts explicitly disposable database names', () => {
  assert.equal(validateDisposablePostgresTestUrl('postgres://localhost/health_skill_test'), null);
  assert.equal(validateDisposablePostgresTestUrl('postgres://localhost/project-ci'), null);
});

test('PostgreSQL integration safety guard blocks production-like database names by default', () => {
  assert.match(validateDisposablePostgresTestUrl('postgres://user:secret@localhost/production'), /Refusing to run/);
  assert.match(validateDisposablePostgresTestUrl('https://localhost/health_skill_test'), /must use postgres/);
  assert.equal(validateDisposablePostgresTestUrl('postgres://localhost/production', { allowNonDisposable: true }), null);
});
