/**
 * Acceptance evidence gate CLI (step 24, area 4/4; step 25 adds --evidence-dir).
 *
 * Reads the external evidence bundle and prints a fail-closed verdict. Relative paths:
 *
 *   <evidence-dir>/ci/CI_PLATFORM_RECORD.json                    real CI platform run
 *   <evidence-dir>/staging-rehearsal/STAGING_REHEARSAL_EVIDENCE.json real staging drill
 *   <evidence-dir>/security-baseline/HUMAN_SECURITY_REVIEW.json  human-signed security review
 *   <evidence-dir>/acceptance/APPROVALS.json                     product/security/ops + independent
 *   <evidence-dir>/acceptance/CUTOVER_GATE_RESULT.json           migration cutover gate >= eligible
 *
 * Supporting (non-blocking): <evidence-dir>/ci-local/, <evidence-dir>/security-baseline/SECURITY_BASELINE_REPORT.json
 *
 * Usage:
 *   node scripts/acceptance-gate.mjs [--json] [--evidence-dir <dir>]
 *
 * `--evidence-dir` lets reviewers evaluate an unpacked handoff bundle or a rehearsal copy
 * without touching the real artifacts/ tree. Defaults to <repo>/artifacts.
 *
 * Exit codes: 0 = READY_FOR_MANUAL_FINAL_REVIEW, 2 = BLOCKED.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateAcceptanceEvidence } from '../src/acceptance/acceptance-gate.js';
import { evaluateCutoverEvidence } from '../src/migration-cutover-gate.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const jsonOnly = args.includes('--json');
const evidenceDirFlagIndex = args.indexOf('--evidence-dir');
const evidenceDir = resolve(root, evidenceDirFlagIndex >= 0 && args[evidenceDirFlagIndex + 1] ? args[evidenceDirFlagIndex + 1] : 'artifacts');
const outputDir = join(evidenceDir, 'acceptance');

async function readJsonOrNull(relativePath) {
  try { return JSON.parse(await readFile(join(evidenceDir, relativePath), 'utf8')); }
  catch { return null; }
}

// Prefer an archived gate result; otherwise evaluate the cutover evidence directly so the
// acceptance gate always reports the *real* current DB-switch eligibility.
async function loadCutoverGate() {
  const archived = await readJsonOrNull('acceptance/CUTOVER_GATE_RESULT.json');
  if (archived) return archived;
  const evidence = await readJsonOrNull('step22/cutover-evidence.json');
  if (!evidence) return null;
  return evaluateCutoverEvidence(evidence);
}

const evidence = {
  ciPlatformRecord: await readJsonOrNull('ci/CI_PLATFORM_RECORD.json'),
  stagingRecord: await readJsonOrNull('staging-rehearsal/STAGING_REHEARSAL_EVIDENCE.json'),
  securityReview: await readJsonOrNull('security-baseline/HUMAN_SECURITY_REVIEW.json'),
  approvals: await readJsonOrNull('acceptance/APPROVALS.json'),
  cutoverGate: await loadCutoverGate(),
  localCi: await readJsonOrNull('ci-local/CI_LOCAL_EQUIVALENT_EVIDENCE.json'),
  securityBaseline: await readJsonOrNull('security-baseline/SECURITY_BASELINE_REPORT.json'),
};

const result = { ...evaluateAcceptanceEvidence(evidence), evidenceDir: evidenceDir === join(root, 'artifacts') ? 'artifacts' : evidenceDir };
await mkdir(outputDir, { recursive: true });
await writeFile(join(outputDir, 'ACCEPTANCE_GATE_RESULT.json'), JSON.stringify(result, null, 2) + '\n', 'utf8');

const summary = {
  decision: result.decision,
  blockingCount: result.blockingCount,
  blockers: result.blockers,
  supporting: result.supporting,
  evidenceDir: result.evidenceDir,
  resultFile: join(evidenceDir, 'acceptance', 'ACCEPTANCE_GATE_RESULT.json'),
};
if (!jsonOnly) {
  console.log(`ACCEPTANCE GATE: ${result.decision} (blocking items: ${result.blockingCount})`);
  for (const item of result.items) console.log(`- [${item.status}] ${item.item}: ${item.detail}`);
  console.log(`- [supporting] ${result.supporting.detail}`);
  console.log(JSON.stringify(summary, null, 2));
}
if (result.decision !== 'READY_FOR_MANUAL_FINAL_REVIEW') process.exitCode = 2;
