/**
 * Archive a real CI platform record for the acceptance gate.
 *
 * The acceptance gate only accepts a genuine CI platform run (kind="ci-platform-record").
 * After the workflow succeeds on the platform, copy the run URL and test summary here:
 *
 *   node scripts/archive-ci-record.mjs \
 *     --run-url https://github.com/<owner>/<repo>/actions/runs/<id> \
 *     --commit <40-hex-sha> --tests-total 118 --tests-passed 118 \
 *     --node-version 22 --postgres-version 16-alpine
 *
 * Output: artifacts/ci/CI_PLATFORM_RECORD.json
 * Refuses placeholders, non-https URLs, unknown status and failed test counts.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);

function arg(name) {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

const runUrl = arg('run-url');
const commit = arg('commit');
const testsTotal = Number(arg('tests-total'));
const testsPassed = Number(arg('tests-passed'));
const nodeVersion = arg('node-version');
const postgresVersion = arg('postgres-version');
const problems = [];
if (!runUrl || !/^https:\/\/[^\s]+$/.test(runUrl)) problems.push('--run-url must be an https CI run URL');
if (!commit || !/^[0-9a-f]{7,40}$/i.test(commit)) problems.push('--commit must be a 7-40 hex git SHA');
if (!Number.isInteger(testsTotal) || testsTotal < 1) problems.push('--tests-total must be a positive integer');
if (!Number.isInteger(testsPassed) || testsPassed < 0) problems.push('--tests-passed must be a non-negative integer');
if (Number.isInteger(testsTotal) && Number.isInteger(testsPassed) && testsPassed !== testsTotal) problems.push('--tests-passed must equal --tests-total (no skipped/failed tests allowed)');
if (!nodeVersion) problems.push('--node-version is required');
if (!postgresVersion) problems.push('--postgres-version is required');
if (problems.length) {
  console.error(`REFUSED: ${problems.join('; ')}`);
  process.exitCode = 2;
  process.exit();
}

const artifactsDir = join(root, 'artifacts', 'ci');
await mkdir(artifactsDir, { recursive: true });
const record = {
  schemaVersion: 1,
  kind: 'ci-platform-record',
  status: 'success',
  runUrl,
  commit,
  nodeVersion,
  postgresVersion,
  tests: { tests: testsTotal, passed: testsPassed, failed: 0, skipped: 0 },
  recordedAt: new Date().toISOString(),
  source: 'scripts/archive-ci-record.mjs',
  note: '由人工在 CI 平台成功运行后归档；归档脚本不验证远端运行状态，审核人必须自行打开 runUrl 核对。',
};
await writeFile(join(artifactsDir, 'CI_PLATFORM_RECORD.json'), JSON.stringify(record, null, 2) + '\n', 'utf8');
console.log(JSON.stringify({ written: 'artifacts/ci/CI_PLATFORM_RECORD.json', runUrl, commit, tests: record.tests }, null, 2));
