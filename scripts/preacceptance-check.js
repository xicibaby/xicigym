import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const artifactsDir = join(root, 'artifacts', 'preacceptance');
const syntaxOnly = process.argv.includes('--syntax-only');
const requiredFiles = [
  'README.md', 'openapi.yaml', 'MIGRATION_CUTOVER_GATE_GUIDE.md',
  'SQLITE_TO_POSTGRES_MIGRATION_GUIDE.md', 'POSTGRESQL_ADAPTER_GUIDE.md',
  'STEP17_TEST_REPORT.md', 'STEP22_REAL_POSTGRES_REPORT.md', 'STEP22_BASELINE_AND_HANDOFF.md',
  'STEP23_RUNTIME_OBSERVABILITY_REPORT.md', 'STEP23_BASELINE_AND_HANDOFF.md',
  'STEP24_EXTERNAL_EVIDENCE_REPORT.md', 'STEP24_BASELINE_AND_HANDOFF.md', 'STEP24_REVIEW_LOG.md',
  'STEP25_HUMAN_ACTION_REPORT.md', 'scripts/next-human-action.mjs',
  'STEP26_DATA_SAFETY_REPORT.md', 'scripts/step26-evidence.mjs', 'scripts/load-smoke.mjs',
  'src/infrastructure/backup-crypto.js', 'src/infrastructure/postgres-backup.js', 'src/postgres-maintenance.js',
  'ops/prometheus/alerts.yml', 'ops/prometheus/README.md',
  '行动包/README_真人动作行动包.md', '行动包/01_CI平台动作卡.md', '行动包/02_staging环境动作卡.md',
  '行动包/03_安全审查动作卡.md', '行动包/04_四方签署动作卡.md', '行动包/05_门禁复核与发布动作卡.md',
  '行动包/安全审查记录模板.json', '行动包/审批记录模板.json',
  'docs/release/REAL_POSTGRES_DRILL_GUIDE.md', 'scripts/step22-runtime-evidence.mjs', 'scripts/step23-runtime-evidence.mjs',
  'docs/release/SECURITY_REVIEW_PREP.md', 'docs/release/CI_EVIDENCE_ARCHIVE_GUIDE.md',
  'docs/release/STAGING_REHEARSAL_RUNBOOK.md', 'docs/release/ACCEPTANCE_EVIDENCE_GATE.md',
  'src/server.js', 'src/http/probe-endpoints.js', 'src/http/shutdown.js', 'src/observability/metrics.js',
  'src/acceptance/acceptance-gate.js',
  'scripts/ci-local-evidence.mjs', 'scripts/staging-rehearsal.mjs', 'scripts/security-baseline-check.mjs',
  'scripts/check-db-privileges.mjs', 'scripts/acceptance-gate.mjs', 'scripts/archive-ci-record.mjs',
  'examples/approval-record.template.json',
  'src/infrastructure/postgres-record-repository.js',
  'src/infrastructure/sqlite-postgres-reconciliation.js', 'src/infrastructure/postgres-test-safety.js', 'src/migration-cutover-gate.js',
  'test/postgres-real.integration.test.js', '.github/workflows/ci.yml',
  'docs/release/PREACCEPTANCE_CHECKLIST.md',
];
const findings = [];
async function walk(dir) {
  const items = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const item of items) {
    if (item.name === 'node_modules' || item.name === '.git' || item.name === 'artifacts') continue;
    const path = join(dir, item.name);
    if (item.isDirectory()) files.push(...await walk(path));
    else if (item.isFile() && (path.endsWith('.js') || path.endsWith('.mjs'))) files.push(path);
  }
  return files;
}
for (const relative of requiredFiles) {
  try { await readFile(join(root, relative)); findings.push({ check: `required:${relative}`, status: 'PASS' }); }
  catch { findings.push({ check: `required:${relative}`, status: 'FAIL', detail: 'required project artifact missing' }); }
}
const jsFiles = await walk(root);
let syntaxFailure = false;
for (const file of jsFiles) {
  const result = spawnSync(process.execPath, ['--check', file], { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) {
    syntaxFailure = true;
    findings.push({ check: `syntax:${file.slice(root.length + 1)}`, status: 'FAIL', detail: (result.stderr || result.stdout || 'syntax check failed').trim().slice(0, 1000) });
  }
}
findings.push({ check: 'javascript-syntax', status: syntaxFailure ? 'FAIL' : 'PASS', files: jsFiles.length });
let testSummary = null;
if (!syntaxOnly) {
  const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap'], { cwd: root, encoding: 'utf8', timeout: 180000, maxBuffer: 20 * 1024 * 1024 });
  const output = `${run.stdout ?? ''}\n${run.stderr ?? ''}`;
  // Node 22/24 differ in the default reporter when stdout is a pipe: Node 22 emits TAP,
  // Node 24 emits the `spec` reporter. Force TAP for determinism and parse both shapes.
  const summaryLines = output.split(/\r?\n/).map((line) => line.trim())
    .filter((line) => /^(#|ℹ)\s/.test(line))
    .map((line) => line.replace(/^(#|ℹ)\s+/, ''));
  const summaryText = summaryLines.length ? summaryLines.join('\n') : output;
  const countOf = (label) => {
    const result = summaryText.match(new RegExp(`^${label} (\\d+)$`, 'm'));
    return result ? Number(result[1]) : null;
  };
  const parsedSummary = {
    tests: countOf('tests'), passed: countOf('pass'), failed: countOf('fail'),
    cancelled: countOf('cancelled'), skipped: countOf('skipped'),
  };
  const match = parsedSummary.tests !== null && parsedSummary.failed !== null;
  testSummary = match ? parsedSummary : { parsed: false, exitCode: run.status };
  const passed = run.status === 0 && match && testSummary.failed === 0 && testSummary.cancelled === 0;
  findings.push({ check: 'automated-test-suite', status: passed ? 'PASS' : 'FAIL', summary: testSummary, reporter: 'tap-or-spec' });
  await mkdir(artifactsDir, { recursive: true });
  await writeFile(join(artifactsDir, 'AUTOMATED_TEST_OUTPUT.txt'), output, { mode: 0o600 });
}
const realPgConfigured = Boolean(process.env.POSTGRES_TEST_URL);
const step22EvidencePath = join(root, 'artifacts', 'step22', 'RUNTIME_EVIDENCE.json');
let step22Evidence = null;
try { step22Evidence = JSON.parse(await readFile(step22EvidencePath, 'utf8')); }
catch { step22Evidence = null; }
const realPgEvidence = step22Evidence?.allChecksPassed === true && step22Evidence?.reconciliation?.match === true;
if (!syntaxOnly && step22Evidence) {
  const failedChecks = (step22Evidence.checks ?? []).filter((check) => check.ok !== true).map((check) => check.name);
  findings.push({
    check: 'step22-runtime-evidence',
    status: step22Evidence.allChecksPassed === true ? 'PASS' : 'FAIL',
    checks: (step22Evidence.checks ?? []).length,
    ...(failedChecks.length ? { detail: `未通过：${failedChecks.join(', ')}` } : {}),
    targetPostgresVersion: step22Evidence.targetPostgresVersion ?? null,
    reconciliationMismatchCount: step22Evidence.reconciliation?.mismatchCount ?? null,
    cutoverGateDecision: step22Evidence.cutoverGate?.decision ?? null,
    note: '证据来自 artifacts/step22/RUNTIME_EVIDENCE.json；由 npm run evidence:step22 在隔离环境生成。',
  });
}
const step23EvidencePath = join(root, 'artifacts', 'step23', 'RUNTIME_LIFECYCLE_EVIDENCE.json');
let step23Evidence = null;
try { step23Evidence = JSON.parse(await readFile(step23EvidencePath, 'utf8')); }
catch { step23Evidence = null; }
const lifecycleEvidence = step23Evidence?.allChecksPassed === true;
if (!syntaxOnly && step23Evidence) {
  const failedChecks = (step23Evidence.checks ?? []).filter((check) => check.ok !== true).map((check) => check.name);
  findings.push({
    check: 'step23-runtime-lifecycle',
    status: lifecycleEvidence ? 'PASS' : 'FAIL',
    checks: (step23Evidence.checks ?? []).length,
    ...(failedChecks.length ? { detail: `未通过：${failedChecks.join(', ')}` } : {}),
    serviceVersion: step23Evidence.serviceVersion ?? null,
    note: '证据来自 artifacts/step23/RUNTIME_LIFECYCLE_EVIDENCE.json；由 npm run evidence:step23 在隔离环境生成。',
  });
}
const serverSource = await readFile(join(root, 'src/server.js'), 'utf8');
const runtimeMode = serverSource.includes("config.databaseBackend === 'postgres'") && serverSource.includes("new SqliteRecordRepository") && serverSource.includes("import('pg')");
const probesWired = serverSource.includes('createProbeEndpoints') && serverSource.includes('createGracefulShutdown');

// ---- step 24: external-evidence readiness (supporting + acceptance gate) ----
async function readJson(relativePath) {
  try { return JSON.parse(await readFile(join(root, relativePath), 'utf8')); }
  catch { return null; }
}
const ciLocalEvidence = await readJson('artifacts/ci-local/CI_LOCAL_EQUIVALENT_EVIDENCE.json');
if (!syntaxOnly && ciLocalEvidence) {
  findings.push({
    check: 'ci-local-equivalent', status: ciLocalEvidence.allValidationsPassed === true ? 'PASS' : 'FAIL',
    validations: (ciLocalEvidence.validations ?? []).length,
    ciPlatformRecord: ciLocalEvidence.ciPlatformRecord === true,
    note: '本地等价执行；ciPlatformRecord=false，不能替代 CI 平台记录。',
  });
}
const step26Evidence = await readJson('artifacts/step26/PG_RESTORE_DRILL_EVIDENCE.json');
if (!syntaxOnly && step26Evidence) {
  findings.push({
    check: 'step26-data-safety', status: step26Evidence.allChecksPassed === true ? 'PASS' : 'FAIL',
    checks: (step26Evidence.checks ?? []).length,
    note: '加密备份 + PostgreSQL 逻辑恢复演练（本地隔离）。',
  });
}
const loadSmoke = await readJson('artifacts/step26/LOAD_SMOKE_EVIDENCE.json');
if (!syntaxOnly && loadSmoke) {
  findings.push({
    check: 'load-smoke', status: loadSmoke.allChecksPassed === true ? 'PASS' : 'FAIL',
    checks: (loadSmoke.checks ?? []).length,
    requestsPerSecond: loadSmoke.load?.requestsPerSecond ?? null,
    p95Ms: loadSmoke.load?.latencyMs?.p95 ?? null,
    note: '轻量 HTTP 负载冒烟，不是容量压测。',
  });
}
const stagingRehearsal = await readJson('artifacts/staging-rehearsal/STAGING_REHEARSAL_EVIDENCE.json');
if (!syntaxOnly && stagingRehearsal) {
  findings.push({
    check: 'staging-rehearsal', status: stagingRehearsal.allChecksPassed === true ? 'PASS' : 'FAIL',
    kind: stagingRehearsal.kind ?? null,
    checks: (stagingRehearsal.checks ?? []).length,
    note: `kind=${stagingRehearsal.kind ?? 'unknown'}；只有 kind=staging 才能被验收门禁接受。`,
  });
}
const securityBaseline = await readJson('artifacts/security-baseline/SECURITY_BASELINE_REPORT.json');
if (!syntaxOnly && securityBaseline) {
  findings.push({
    check: 'security-technical-controls', status: securityBaseline.technicalControlsPass === true ? 'PASS' : 'FAIL',
    checks: (securityBaseline.checks ?? []).length,
    humanReviewSigned: securityBaseline.humanReviewSigned === true,
    note: '自动化技术控制审查；不等于人工安全审查签署。',
  });
}
const acceptanceGate = await readJson('artifacts/acceptance/ACCEPTANCE_GATE_RESULT.json');
if (!syntaxOnly && acceptanceGate) {
  findings.push({
    check: 'acceptance-evidence-gate',
    status: acceptanceGate.decision === 'READY_FOR_MANUAL_FINAL_REVIEW' ? 'PASS' : 'BLOCKED',
    blockingCount: acceptanceGate.blockingCount ?? null,
    note: '外部验收证据门禁结果；BLOCKED 表示外部证据未齐，不代表本地代码检查失败。',
  });
}

const blockers = [];
if (!syntaxOnly && !realPgConfigured && !realPgEvidence) blockers.push('未配置 POSTGRES_TEST_URL，且没有可复核的项目内真实 PostgreSQL 演练证据；真实集成测试无法作为已通过证据。');
if (testSummary?.skipped > 0) blockers.push(`自动化测试存在 ${testSummary.skipped} 项跳过；必须确认跳过原因并补齐外部环境测试。`);
if (!runtimeMode) blockers.push('HTTP 启动入口未通过静态检查确认同时支持 SQLite 与 PostgreSQL；需要人工复核运行时后端选择与关闭流程。');
if (!probesWired) blockers.push('启动入口未确认接入健康探针与优雅关闭；需要人工复核 /healthz、/readyz、/metrics。');
if (!lifecycleEvidence) blockers.push('缺少可复核的运行时探针/指标/优雅关闭证据（npm run evidence:step23）。');
if (acceptanceGate) {
  for (const blocker of acceptanceGate.blockers ?? []) blockers.push(`验收证据：${blocker}`);
} else {
  blockers.push('验收证据：缺少 artifacts/acceptance/ACCEPTANCE_GATE_RESULT.json（运行 npm run gate:acceptance）。');
}
const localChecksPass = findings.every((x) => x.status !== 'FAIL');
const report = {
  schemaVersion: 2,
  generatedAt: new Date().toISOString(),
  nodeVersion: process.version,
  mode: syntaxOnly ? 'syntax-only' : 'full-preacceptance-check',
  localChecksPass,
  realPostgresConfigured: realPgConfigured,
  realPostgresEvidence: Boolean(realPgEvidence),
  step22EvidencePath: step22Evidence ? 'artifacts/step22/RUNTIME_EVIDENCE.json' : null,
  runtimeLifecycleEvidence: Boolean(lifecycleEvidence),
  step23EvidencePath: step23Evidence ? 'artifacts/step23/RUNTIME_LIFECYCLE_EVIDENCE.json' : null,
  runtimeProbes: probesWired ? ['/healthz', '/readyz', '/metrics'] : [],
  runtimeBackend: runtimeMode ? 'configurable-sqlite-postgres' : 'review-required',
  acceptanceGate: acceptanceGate ? { decision: acceptanceGate.decision, blockingCount: acceptanceGate.blockingCount } : null,
  acceptanceEvidencePath: acceptanceGate ? 'artifacts/acceptance/ACCEPTANCE_GATE_RESULT.json' : null,
  testSummary,
  findings,
  blockers,
  decision: syntaxOnly ? (localChecksPass ? 'PASS' : 'FAIL') : (localChecksPass && blockers.length === 0 ? 'READY_FOR_MANUAL_ACCEPTANCE_REVIEW' : 'NOT_READY_FOR_ACCEPTANCE'),
  note: '本报告只记录本地可重复检查结果；外部证据门禁为 BLOCKED 时不得宣称验收通过。',
};
if (!syntaxOnly) {
  await mkdir(artifactsDir, { recursive: true });
  await writeFile(join(artifactsDir, 'PREACCEPTANCE_RESULT.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  const md = [
    '# 验收前检查报告', '',
    `- 生成时间：${report.generatedAt}`,
    `- Node.js：${report.nodeVersion}`,
    `- 本地检查：${localChecksPass ? '通过' : '失败'}`,
    `- 真实 PostgreSQL URL：${realPgConfigured ? '已配置（不输出凭据）' : '未配置'}`,
    `- 项目内真实 PostgreSQL 演练证据：${realPgEvidence ? '存在且通过（artifacts/step22/RUNTIME_EVIDENCE.json）' : '不存在或未通过'}`,
    `- 运行时生命周期证据：${lifecycleEvidence ? '存在且通过（artifacts/step23/RUNTIME_LIFECYCLE_EVIDENCE.json）' : '不存在或未通过'}`,
    `- 运行时探针：${probesWired ? '/healthz、/readyz、/metrics 已接入' : '未确认接入'}`,
    `- 外部验收证据门禁：${acceptanceGate ? `${acceptanceGate.decision}（阻塞 ${acceptanceGate.blockingCount ?? '?'} 项）` : '缺失'}`,
    `- 判定：**${report.decision}**`, '',
    '## 自动化测试', '',
    testSummary ? `- 总数：${testSummary.tests ?? '无法解析'}；通过：${testSummary.passed ?? '—'}；失败：${testSummary.failed ?? '—'}；跳过：${testSummary.skipped ?? '—'}` : '- 仅执行语法检查。', '',
    '## 检查结果', '',
    ...findings.map((f) => `- ${f.status}: ${f.check}${f.detail ? ` — ${f.detail}` : ''}`), '',
    '## 验收前阻塞项', '',
    ...(blockers.length ? blockers.map((b) => `- [ ] ${b}`) : ['- 无']), '',
    '## 边界说明', '', report.note, '',
  ].join('\n');
  await writeFile(join(artifactsDir, 'PREACCEPTANCE_REPORT.md'), md, { mode: 0o600 });
}
console.log(JSON.stringify(report, null, 2));
if (!localChecksPass) process.exitCode = 1;
else if (!syntaxOnly && blockers.length) process.exitCode = 2;
