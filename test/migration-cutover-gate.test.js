import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCutoverEvidence } from '../src/migration-cutover-gate.js';

const readyEvidence = () => ({
  automatedTestsPassed: true,
  realPostgresIntegrationPassed: true,
  backupVerified: true,
  restoreDrillPassed: true,
  sourceWriteFreezeConfirmed: true,
  rollbackPlanVerified: true,
  securityReviewPassed: true,
  reconciliation: { match: true, mismatchCount: 0 },
  targetPostgresVersion: 'PostgreSQL 17.x (replace with observed version)',
  reportPath: 'reports/migration-evidence.json',
});

test('cutover gate fails closed for missing evidence', () => {
  const result = evaluateCutoverEvidence({});
  assert.equal(result.eligible, false);
  assert.equal(result.decision, 'BLOCKED');
  assert.ok(result.blockers.length >= 10);
});

test('cutover gate blocks if real database tests were not run', () => {
  const evidence = readyEvidence();
  evidence.realPostgresIntegrationPassed = false;
  const result = evaluateCutoverEvidence(evidence);
  assert.equal(result.eligible, false);
  assert.ok(result.blockers.some((item) => item.includes('真实 PostgreSQL')));
});

test('cutover gate blocks even when counts match but row reconciliation has mismatches', () => {
  const evidence = readyEvidence();
  evidence.reconciliation = { match: false, mismatchCount: 1 };
  const result = evaluateCutoverEvidence(evidence);
  assert.equal(result.eligible, false);
  assert.ok(result.blockers.some((item) => item.includes('逐记录对账')));
});

test('complete evidence permits manual review but never claims an automatic cutover', () => {
  const result = evaluateCutoverEvidence(readyEvidence());
  assert.equal(result.eligible, true);
  assert.equal(result.decision, 'ELIGIBLE_FOR_MANUAL_APPROVAL');
  assert.match(result.note, /不会自动切换流量/);
});

test('cutover gate requires reconciliation mismatch count to be exactly integer zero', () => {
  const evidence = readyEvidence();
  evidence.reconciliation.mismatchCount = '0';
  const result = evaluateCutoverEvidence(evidence);
  assert.equal(result.eligible, false);
});
