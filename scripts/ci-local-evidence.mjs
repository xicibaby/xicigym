/**
 * CI workflow validation + local equivalent execution evidence (step 24, area 1/4).
 *
 * What this does:
 *   1. Parses `.github/workflows/ci.yml` and validates its structure and hardening
 *      (single PostgreSQL 16 service, npm ci, syntax + full test steps, least-privilege
 *      token permissions, no pull_request_target, no secret echoing).
 *   2. Executes the same two steps locally against the disposable PostgreSQL instance
 *      (POSTGRES_TEST_URL) and records exit codes/durations.
 *
 * What this does NOT do: it does not run GitHub Actions and is NOT a CI platform record.
 * The resulting evidence is marked `ciPlatformRecord: false` on purpose; the acceptance
 * gate keeps the real CI record as a separate blocker.
 *
 * Required env: POSTGRES_TEST_URL (disposable database).
 * Optional env: CI_LOCAL_ARTIFACTS_DIR.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const artifactsDir = resolve(process.env.CI_LOCAL_ARTIFACTS_DIR || join(root, 'artifacts', 'ci-local'));
const workflowPath = join(root, '.github', 'workflows', 'ci.yml');
const testUrl = process.env.POSTGRES_TEST_URL;

if (!testUrl) {
  console.error('REFUSED: set POSTGRES_TEST_URL to a disposable PostgreSQL test database.');
  console.error('Local equivalent CI execution must use the same disposable database as CI.');
  process.exit(2);
}

const validations = [];
function record(name, ok, detail = '') {
  validations.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}
const scriptNames = async () => {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  return new Set(Object.keys(pkg.scripts ?? {}));
};

async function main() {
  await mkdir(artifactsDir, { recursive: true });
  const workflowText = await readFile(workflowPath, 'utf8');
  const workflowSha256 = createHash('sha256').update(workflowText).digest('hex');
  let workflow;
  try { workflow = parseYaml(workflowText); }
  catch (error) {
    record('workflow-yaml-parses', false, String(error?.message).slice(0, 200));
    throw new Error('workflow YAML is invalid');
  }
  record('workflow-yaml-parses', true, `sha256=${workflowSha256.slice(0, 12)}…`);

  // --- structure ---
  const job = workflow?.jobs?.['unit-and-postgres-integration'];
  record('workflow-triggers', Boolean(workflow?.on), Object.keys(workflow?.on ?? {}).join(', '));
  record('job-present', Boolean(job), 'unit-and-postgres-integration');
  record('job-runner-and-timeout', job?.['runs-on'] === 'ubuntu-latest' && Number(job?.['timeout-minutes']) > 0, `${job?.['runs-on']} timeout=${job?.['timeout-minutes']}m`);
  const postgres = job?.services?.postgres;
  const serviceOptions = String(postgres?.options ?? '');
  record('postgres16-service',
    postgres?.image === 'postgres:16-alpine'
      && postgres?.env?.POSTGRES_DB === 'health_skill_test'
      && Boolean(postgres?.env?.POSTGRES_USER)
      && Boolean(postgres?.env?.POSTGRES_PASSWORD)
      && serviceOptions.includes('pg_isready')
      && /\d+:\d+/.test(JSON.stringify(postgres?.ports)),
    `image=${postgres?.image} healthcheck=${serviceOptions.includes('pg_isready')}`);
  record('test-environment-env', job?.env?.NODE_ENV === 'test' && String(job?.env?.POSTGRES_TEST_URL ?? '').startsWith('postgres://'), 'NODE_ENV=test + POSTGRES_TEST_URL');

  // --- hardening ---
  record('least-privilege-token', workflow?.permissions && Object.keys(workflow.permissions).length === 1 && workflow.permissions.contents === 'read', JSON.stringify(workflow?.permissions ?? null));
  record('no-pull-request-target', !JSON.stringify(workflow).includes('pull_request_target'), 'no pull_request_target trigger');
  const flattened = JSON.stringify(workflow);
  record('no-secret-echo', !/echo[^"]*secrets\./i.test(flattened) && !/run:\s*[^\n]*\$\{\{\s*secrets\./.test(workflowText), 'no secret values printed by run steps');

  // --- steps ---
  const steps = Array.isArray(job?.steps) ? job.steps : [];
  const runCommands = steps.map((step) => String(step?.run ?? '').trim()).filter(Boolean);
  const setupNode = steps.find((step) => String(step?.uses ?? '').startsWith('actions/setup-node'));
  record('setup-node-22', String(setupNode?.with?.['node-version']) === '22' && setupNode?.with?.cache === 'npm', `node ${setupNode?.with?.['node-version']} cache=${setupNode?.with?.cache ?? 'none'}`);
  record('uses-locked-install', runCommands.some((command) => command.startsWith('npm ci')), runCommands.find((command) => command.startsWith('npm ci')) ?? 'missing npm ci');
  const availableScripts = await scriptNames();
  const referencedScripts = [];
  for (const command of runCommands) {
    const match = command.match(/^npm run ([a-zA-Z0-9:_-]+)$/);
    if (match) referencedScripts.push(match[1]);
  }
  const missingScripts = referencedScripts.filter((name) => !availableScripts.has(name));
  record('workflow-scripts-exist', missingScripts.length === 0, missingScripts.length ? `missing: ${missingScripts.join(', ')}` : referencedScripts.join(', '));
  record('runs-syntax-and-tests', referencedScripts.includes('check:syntax') && runCommands.some((command) => command === 'npm test'), `scripts=${referencedScripts.join(',')} + npm test`);
  record('runs-dependency-audit', runCommands.some((command) => /^npm audit --omit=dev --audit-level=high$/.test(command)), 'npm audit --omit=dev --audit-level=high');
  record('runs-checksums-verify', referencedScripts.includes('checksums:verify'), `scripts=${referencedScripts.join(',')}`);
  const gateStep = steps.find((step) => String(step?.run ?? '').includes('gate:acceptance'));
  record('gate-step-non-blocking', Boolean(gateStep) && gateStep['continue-on-error'] === true, gateStep ? `continue-on-error=${gateStep['continue-on-error']}` : 'gate step missing');

  // --- local equivalent execution ---
  const environment = { nodeVersion: process.version, platform: `${process.platform}/${process.arch}` };
  let postgresVersion = null;
  try {
    const { default: pg } = await import('pg');
    const client = new pg.Client({ connectionString: testUrl, connectionTimeoutMillis: 5_000 });
    await client.connect();
    const result = await client.query('SELECT version()');
    postgresVersion = String(result.rows[0].version).split(',')[0];
    await client.end();
  } catch (error) {
    record('local-postgres-reachable', false, String(error?.message).slice(0, 160));
  }
  record('local-postgres-reachable', postgresVersion !== null, postgresVersion ?? 'unreachable');

  const executed = [];
  const scripts = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).scripts ?? {};
  const env = { ...process.env, NODE_ENV: 'test', POSTGRES_TEST_URL: testUrl };
  const workflowSteps = [
    ['Check JavaScript syntax', 'check:syntax', 'LOCAL_SYNTAX_OUTPUT.txt'],
    ['Run complete suite including real PostgreSQL integration', 'test', 'LOCAL_TEST_OUTPUT.txt'],
  ];
  // `checksums:verify` is validated structurally above but not replayed here: this script rewrites
  // artifacts/ci-local during the replay, which would invalidate the committed SHA256SUMS snapshot
  // mid-run. The final verification is `npm run checksums:verify` after all evidence is regenerated.
  for (const [workflowStep, scriptName, outputName] of workflowSteps) {
    const command = scripts[scriptName];
    if (!command) {
      record(`local-step:${workflowStep}`, false, `package.json script "${scriptName}" is missing`);
      continue;
    }
    const startedAt = Date.now();
    const result = spawnSync(command, { cwd: root, env, encoding: 'utf8', shell: true, timeout: 600_000, maxBuffer: 40 * 1024 * 1024 });
    const durationMs = Date.now() - startedAt;
    const stdout = result.stdout ?? '';
    const stderr = result.stderr ?? '';
    executed.push({ workflowStep, localCommand: command, exitCode: result.status, durationMs });
    const outputFile = join(artifactsDir, outputName);
    await writeFile(outputFile, `${stdout}\n${stderr}`, 'utf8');
    record(`local-step:${workflowStep}`, result.status === 0, `exit=${result.status} durationMs=${durationMs} output=${outputFile.slice(root.length + 1)}`);
  }

  const allValidationsPassed = validations.every((item) => item.ok);
  const evidence = {
    schemaVersion: 1,
    kind: 'local-equivalent-ci',
    generatedAt: new Date().toISOString(),
    allValidationsPassed,
    ciPlatformRecord: false,
    workflow: {
      path: '.github/workflows/ci.yml',
      sha256: workflowSha256,
      nodeVersion: setupNode?.with?.['node-version'] ?? null,
      runner: job?.['runs-on'] ?? null,
      postgresImage: postgres?.image ?? null,
      permissions: workflow?.permissions ?? null,
    },
    validations,
    executed,
    environment: { ...environment, postgresVersion },
    note: '本地等价执行：结构与命令按 ci.yml 校验并在本机重放；它不是 GitHub Actions 记录，不能替代 CI 平台证据。',
    limitations: [
      '未在 GitHub Actions 平台执行；workflow 文件与本地重放不等于 CI 通过记录。',
      '本地 PostgreSQL 为便携版 16.x（与 CI 的 postgres:16-alpine 同大版本但镜像不同）。',
    ],
  };
  await writeFile(join(artifactsDir, 'CI_LOCAL_EQUIVALENT_EVIDENCE.json'), JSON.stringify(evidence, null, 2) + '\n', 'utf8');
  if (!allValidationsPassed || executed.some((step) => step.exitCode !== 0)) {
    console.error('CI LOCAL EQUIVALENT: FAILED');
    process.exitCode = 1;
  } else {
    console.log('CI LOCAL EQUIVALENT: ALL CHECKS PASSED (ciPlatformRecord=false)');
  }
}

await main();
