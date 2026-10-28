/**
 * Automated security-baseline review (step 24, area 3/4).
 *
 * This is a *technical control* review, not a human security sign-off. It verifies the
 * controls that can be proven locally and writes machine-readable evidence:
 *   S1 production config fail-closed matrix
 *   S2 PostgreSQL least-privilege application role (runs scripts/check-db-privileges.mjs)
 *   S3 TLS certificate verification requirement (sslmode=verify-full/verify-ca)
 *   S4 secret hygiene: repository scan for hardcoded credentials + error/log redaction
 *   S5 probe & network defaults (loopback default, documented gateway allow-list)
 *   S6 locked dependency tree (package-lock integrity)
 *   S7 CI workflow hardening (least-privilege token, npm ci, artifact archival)
 *   S8 approval record template schema (ready for human signatures)
 *
 * Required env: POSTGRES_APP_URL (least-privilege role), POSTGRES_TEST_URL not needed.
 * Exit codes: 0 = all technical controls pass, 1 = violation, 2 = missing input.
 * `humanReviewSigned` is always false here: only real reviewers can flip that.
 */
import { readFile, writeFile, mkdir, readdir, readFile as readText } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

import { loadRuntimeConfig } from '../src/config/runtime-config.js';
import { createGracefulShutdown } from '../src/http/shutdown.js';
import { startServer } from '../src/server.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const artifactsDir = join(root, 'artifacts', 'security-baseline');
const appUrl = process.env.POSTGRES_APP_URL;

const checks = [];
const record = (name, ok, detail = '') => {
  checks.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const baseEnv = {
  NODE_ENV: 'test',
  OIDC_ISSUER: 'https://identity.example.test/',
  OIDC_AUDIENCE: 'health-skill-api',
  OIDC_JWKS_URL: 'https://identity.example.test/jwks',
  DATABASE_PATH: './health-records.sqlite',
  CORS_ORIGINS: 'http://localhost:5173',
};
const prodEnv = {
  ...baseEnv,
  NODE_ENV: 'production',
  DATABASE_BACKEND: 'postgres',
  POSTGRES_URL: 'postgres://app_role:secret@db.example.test:5432/health?sslmode=verify-full',
  POSTGRES_SSL: 'true',
  CORS_ORIGINS: 'https://app.example.test',
};
const throwsWith = (env, pattern) => {
  try { loadRuntimeConfig(env); return false; }
  catch (error) { return pattern.test(String(error?.message)); }
};

async function checkProductionConfig() {
  const cases = [
    ['production-rejects-sqlite', { ...prodEnv, DATABASE_BACKEND: 'sqlite', DATABASE_PATH: './x.sqlite' }, /DATABASE_BACKEND=postgres/],
    ['production-rejects-missing-ssl-flag', { ...prodEnv, POSTGRES_SSL: 'false' }, /POSTGRES_SSL=true/],
    ['production-rejects-weak-sslmode', { ...prodEnv, POSTGRES_URL: 'postgres://app_role:secret@db.example.test:5432/health?sslmode=require' }, /sslmode=verify-full/],
    ['production-rejects-http-oidc', { ...prodEnv, OIDC_ISSUER: 'http://identity.example.test/' }, /must use HTTPS in production/],
    ['production-rejects-http-cors', { ...prodEnv, CORS_ORIGINS: 'http://app.example.test' }, /CORS_ORIGINS must use HTTPS/],
    ['production-rejects-wildcard-cors', { ...prodEnv, CORS_ORIGINS: '*' }, /wildcard/],
    ['production-rejects-memory-db', { ...prodEnv, DATABASE_BACKEND: 'sqlite', DATABASE_PATH: ':memory:' }, /DATABASE_BACKEND=postgres|persistent/],
  ];
  let ok = true;
  for (const [name, env, pattern] of cases) {
    const failedAsExpected = throwsWith(env, pattern);
    record(`S1:${name}`, failedAsExpected, failedAsExpected ? 'rejected as expected' : `expected rejection matching ${pattern}`);
    ok = ok && failedAsExpected;
  }
  let accepted = false;
  try { accepted = loadRuntimeConfig(prodEnv).postgresSsl === true; } catch { accepted = false; }
  record('S1:production-accepts-verified-tls', accepted, 'valid production config accepted');
  return ok && accepted;
}

async function checkRedaction() {
  let ok = true;
  // S4a: shutdown failure messages never contain credentials.
  const fakeServer = { close(callback) { callback(); }, closeIdleConnections() {}, closeAllConnections() {} };
  const controller = createGracefulShutdown({
    server: fakeServer,
    logger: { error() {} },
    timeoutMs: 1_000,
    closeResources: [async () => { throw new Error('pool failed for postgresql://app_role:supersecret@db/x'); }],
  });
  const result = await controller.shutdown();
  const redacted = result.resourceCloseFailures.length === 1 && !result.resourceCloseFailures[0].includes('supersecret');
  record('S4:shutdown-error-redaction', redacted, redacted ? 'credentials redacted' : 'credential leaked in shutdown failure message');
  ok = ok && redacted;

  // S4b: startup failure message never echoes POSTGRES_URL or password.
  let startupMessage = '';
  try {
    await startServer({
      env: {
        ...baseEnv,
        DATABASE_BACKEND: 'postgres',
        POSTGRES_URL: 'postgres://app_role:supersecret@127.0.0.1:1/health_test',
        PG_CONNECTION_TIMEOUT_MS: '500',
      },
      logger: { info() {}, error() {} },
    });
  } catch (error) { startupMessage = String(error?.message ?? ''); }
  const startupSafe = /PostgreSQL startup failed/.test(startupMessage) && !startupMessage.includes('supersecret') && !startupMessage.includes('127.0.0.1:1');
  record('S4:startup-error-redaction', startupSafe, startupSafe ? 'failure reported without connection string' : `unexpected message: ${startupMessage.slice(0, 160)}`);
  return ok && startupSafe;
}

async function checkSecretScan() {
  const findings = [];
  const scanDirs = ['src', '.github/workflows', 'examples'];
  const directFiles = ['openapi.yaml', 'package.json'];
  async function* walkFiles(relativePath) {
    const full = join(root, relativePath);
    let entries;
    try { entries = await readdir(full, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const child = `${relativePath}/${entry.name}`;
      if (entry.isDirectory()) yield* walkFiles(child);
      else if (entry.isFile()) yield child;
    }
  }
  const files = [...directFiles];
  for (const dir of scanDirs) for await (const file of walkFiles(dir)) files.push(file);
  const allowlistedPassword = /^(?:local-test-only|local-app-only|secret|<password>|password|<secret>|changeme)$/i;
  const patterns = [
    { name: 'postgres-credential-url', regex: /postgres(?:ql)?:\/\/[^\s'"<>]+?:([^/\s'"<>@]+)@/g },
    { name: 'aws-access-key', regex: /AKIA[0-9A-Z]{16}/g },
    { name: 'private-key-block', regex: /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/g },
    { name: 'generic-credential-assignment', regex: /(?:api[_-]?key|client[_-]?secret|access[_-]?token)\s*[:=]\s*['"]([A-Za-z0-9_\-]{20,})['"]/gi },
  ];
  for (const file of files) {
    let text;
    try { text = await readText(join(root, file), 'utf8'); } catch { continue; }
    for (const pattern of patterns) {
      pattern.regex.lastIndex = 0;
      for (const match of text.matchAll(pattern.regex)) {
        const candidate = match[1];
        if (pattern.name === 'postgres-credential-url' && allowlistedPassword.test(candidate ?? '')) continue;
        const line = text.slice(0, match.index).split('\n').length;
        findings.push({ file, line, pattern: pattern.name });
      }
    }
  }
  const ok = findings.length === 0;
  record('S4:no-hardcoded-secrets', ok, ok ? `scanned ${files.length} files` : JSON.stringify(findings.slice(0, 5)));
  return ok;
}

async function checkTlsAndLockfile() {
  let ok = true;
  // S3 exercised implicitly by S1; assert config exposes TLS state and prod requires it.
  const config = loadRuntimeConfig(prodEnv);
  record('S3:postgres-ssl-enabled', config.postgresSsl === true && config.databaseBackend === 'postgres', 'POSTGRES_SSL=true retained');
  ok = ok && config.postgresSsl === true;

  // S6: lockfile integrity.
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  let lock;
  let lockOk = false;
  try { lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8')); lockOk = true; } catch { lockOk = false; }
  record('S6:lockfile-present', lockOk, lockOk ? `lockfileVersion=${lock.lockfileVersion}` : 'package-lock.json missing');
  if (lockOk) {
    const lockedPg = lock.packages?.['node_modules/pg']?.version;
    const expectedPg = pkg.dependencies?.pg;
    record('S6:pg-version-pinned', Boolean(expectedPg) && lockedPg === expectedPg, `package.json=${expectedPg} lock=${lockedPg}`);
    const badResolved = Object.entries(lock.packages ?? {}).filter(([key, value]) => key && value?.resolved && !String(value.resolved).startsWith('https://registry.npmjs.org/')).map(([key]) => key);
    record('S6:registry-only-sources', badResolved.length === 0, badResolved.length ? `non-registry: ${badResolved.slice(0, 5).join(', ')}` : 'all resolved from registry.npmjs.org');
    record('S6:lockfile-version', Number(lock.lockfileVersion) >= 3, `lockfileVersion=${lock.lockfileVersion}`);
    ok = ok && Boolean(expectedPg) && lockedPg === expectedPg && badResolved.length === 0 && Number(lock.lockfileVersion) >= 3;
  } else {
    ok = false;
  }
  return ok;
}

async function checkProbeDefaults() {
  const config = loadRuntimeConfig({ ...baseEnv });
  const loopbackDefault = config.host === '127.0.0.1' && config.port === 3000;
  record('S5:loopback-default-bind', loopbackDefault, `host=${config.host} port=${config.port}`);
  let docsOk = false;
  try {
    const prep = await readFile(join(root, 'docs/release/SECURITY_REVIEW_PREP.md'), 'utf8');
    docsOk = /白名单|allow-list/i.test(prep) && /\/healthz/.test(prep);
  } catch { docsOk = false; }
  record('S5:probe-exposure-documented', docsOk, docsOk ? 'gateway allow-list requirement documented' : 'missing probe exposure documentation');
  let openapiOk = false;
  try {
    const spec = await readFile(join(root, 'openapi.yaml'), 'utf8');
    openapiOk = /\/healthz:/.test(spec) && /\/readyz:/.test(spec) && /\/metrics:/.test(spec);
  } catch { openapiOk = false; }
  record('S5:probe-contracts-documented', openapiOk, openapiOk ? '/healthz /readyz /metrics in OpenAPI' : 'probe contracts missing');
  return loopbackDefault && docsOk && openapiOk;
}

async function checkLeastPrivilege() {
  if (!appUrl) {
    record('S2:postgres-least-privilege', false, 'POSTGRES_APP_URL not set (fail-closed)');
    return false;
  }
  const result = spawnSync(process.execPath, [join(root, 'scripts', 'check-db-privileges.mjs'), '--json'], {
    cwd: root, encoding: 'utf8', timeout: 120_000,
    env: { ...process.env, POSTGRES_APP_URL: appUrl },
  });
  const reportPath = join(artifactsDir, 'DB_PRIVILEGE_CHECK.json');
  let report = null;
  try { report = JSON.parse(await readFile(reportPath, 'utf8')); } catch { report = null; }
  const ok = result.status === 0 && report?.pass === true;
  record('S2:postgres-least-privilege', ok, ok ? `role=${report.role} (${report.checks.length} checks)` : `failed: ${(report?.failedChecks ?? [result.status]).join(', ')}`);
  return ok;
}

async function checkCiHardening() {
  let ok = true;
  let workflow;
  try { workflow = parseYaml(await readFile(join(root, '.github', 'workflows', 'ci.yml'), 'utf8')); }
  catch { record('S7:workflow-parses', false, 'ci.yml missing or invalid'); return false; }
  record('S7:workflow-parses', true, 'ci.yml parsed');
  const job = workflow?.jobs?.['unit-and-postgres-integration'];
  const tokenOk = workflow?.permissions?.contents === 'read' && Object.keys(workflow.permissions).length === 1;
  record('S7:least-privilege-token', tokenOk, JSON.stringify(workflow?.permissions ?? null));
  const commands = (job?.steps ?? []).map((step) => String(step?.run ?? ''));
  const usesCi = commands.some((command) => command.startsWith('npm ci'));
  record('S7:locked-install', usesCi, commands.find((command) => command.startsWith('npm ci')) ?? 'npm ci missing');
  const archives = (job?.steps ?? []).some((step) => String(step?.uses ?? '').includes('upload-artifact'));
  record('S7:artifacts-archived', archives, archives ? 'upload-artifact configured' : 'no artifact archival');
  const noPrTarget = !JSON.stringify(workflow).includes('pull_request_target');
  record('S7:no-pull-request-target', noPrTarget, 'trigger hardened');
  ok = tokenOk && usesCi && archives && noPrTarget;
  return ok;
}

async function checkApprovalTemplate() {
  let template;
  try { template = JSON.parse(await readFile(join(root, 'examples', 'approval-record.template.json'), 'utf8')); }
  catch { record('S8:approval-template', false, 'examples/approval-record.template.json missing'); return false; }
  const required = ['schemaVersion', 'project', 'release', 'approvals', 'independentApproval'];
  const missing = required.filter((key) => !(key in template));
  const approvals = Array.isArray(template.approvals) ? template.approvals : [];
  const roles = new Set(approvals.map((approval) => approval.role));
  const hasRoles = ['product', 'security', 'operations'].every((role) => roles.has(role));
  const hasIndependent = template.independentApproval && template.independentApproval.required === true;
  const ok = missing.length === 0 && hasRoles && Boolean(hasIndependent);
  record('S8:approval-template', ok, ok ? 'product/security/operations + independent approval required' : `missing=${missing.join(',')} roles=${[...roles].join(',')}`);
  return ok;
}

async function main() {
  await mkdir(artifactsDir, { recursive: true });
  console.log('== security baseline review (technical controls only) ==');
  const results = [];
  results.push(await checkProductionConfig());
  results.push(await checkRedaction());
  results.push(await checkSecretScan());
  results.push(await checkTlsAndLockfile());
  results.push(await checkProbeDefaults());
  results.push(await checkLeastPrivilege());
  results.push(await checkCiHardening());
  results.push(await checkApprovalTemplate());

  const failed = checks.filter((check) => !check.ok);
  const technicalControlsPass = failed.length === 0;
  const report = {
    schemaVersion: 1,
    kind: 'security-technical-controls',
    generatedAt: new Date().toISOString(),
    technicalControlsPass,
    humanReviewSigned: false,
    securityReviewGate: technologyGate(),
    checks,
    failedChecks: failed.map((check) => check.name),
    note: '本报告只覆盖可在本地自动验证的技术控制项；securityReviewPassed 必须由真实安全/运维负责人审查后单独提供，代码与 AI 不得代签。',
    evidence: {
      dbPrivilege: 'artifacts/security-baseline/DB_PRIVILEGE_CHECK.json',
      reviewPrep: 'docs/release/SECURITY_REVIEW_PREP.md',
    },
    limitations: [
      '未覆盖：真实 TLS 握手与证书链、托管服务网络策略、日志平台访问控制、备份加密与保留执行。',
      '未覆盖：多实例共享限流/指标、容量与压测、灾备演练。',
      '技术控制通过不等于安全审查通过。',
    ],
  };
  await writeFile(join(artifactsDir, 'SECURITY_BASELINE_REPORT.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log(JSON.stringify({ technicalControlsPass, failedChecks: report.failedChecks, humanReviewSigned: false, securityReviewGate: report.securityReviewGate }, null, 2));
  if (!technicalControlsPass) process.exitCode = 1;
}

function technologyGate() {
  return 'BLOCKED_PENDING_HUMAN_REVIEW';
}

await main();
