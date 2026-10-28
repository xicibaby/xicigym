import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateAcceptanceEvidence } from '../src/acceptance/acceptance-gate.js';

const NOW = new Date('2026-10-28T12:00:00.000Z');
const fresh = (offsetDays = -2) => new Date(NOW.getTime() + offsetDays * 24 * 60 * 60 * 1000).toISOString();

function validEvidence() {
  return {
    ciPlatformRecord: {
      kind: 'ci-platform-record',
      status: 'success',
      runUrl: 'https://github.com/example/repo/actions/runs/123456',
      commit: '0123456789abcdef0123456789abcdef01234567',
      recordedAt: fresh(),
      tests: { tests: 118, passed: 118, failed: 0, skipped: 0 },
    },
    stagingRecord: {
      kind: 'staging',
      allChecksPassed: true,
      generatedAt: fresh(),
      environment: { baseUrl: 'https://staging.example.test', operator: 'ops-oncall' },
    },
    securityReview: {
      humanReviewSigned: true,
      reviewer: 'security-lead',
      reviewedAt: fresh(),
      scope: ['tls', 'least-privilege', 'secrets'],
    },
    approvals: {
      approvals: [
        { role: 'product', name: 'product-owner', decision: 'approved', signedAt: fresh() },
        { role: 'security', name: 'security-lead', decision: 'approved', signedAt: fresh() },
        { role: 'operations', name: 'ops-lead', decision: 'approved', signedAt: fresh() },
      ],
      independentApproval: { required: true, name: 'independent-reviewer', decision: 'approved', signedAt: fresh() },
      author: { name: 'author-agent' },
    },
    cutoverGate: { eligible: true, decision: 'ELIGIBLE_FOR_MANUAL_APPROVAL', blockers: [] },
    localCi: { allValidationsPassed: true },
    securityBaseline: { technicalControlsPass: true },
  };
}

test('acceptance gate is READY only when every external evidence item is valid', () => {
  const result = evaluateAcceptanceEvidence(validEvidence(), { now: NOW });
  assert.equal(result.decision, 'READY_FOR_MANUAL_FINAL_REVIEW');
  assert.equal(result.blockingCount, 0);
  assert.equal(result.supporting.status, 'PASS');
  assert.equal(result.supporting.blocking, false);
});

test('acceptance gate blocks an empty evidence bundle with actionable items', () => {
  const result = evaluateAcceptanceEvidence({}, { now: NOW });
  assert.equal(result.decision, 'BLOCKED');
  assert.equal(result.blockingCount, 5);
  assert.ok(result.blockers.some((blocker) => blocker.startsWith('ci-platform-record')));
  assert.ok(result.blockers.some((blocker) => blocker.startsWith('staging-record')));
  assert.ok(result.blockers.some((blocker) => blocker.startsWith('security-review')));
  assert.ok(result.blockers.some((blocker) => blocker.startsWith('human-approvals')));
  assert.ok(result.blockers.some((blocker) => blocker.startsWith('cutover-gate')));
});

test('local equivalent CI replay can never satisfy the CI platform requirement', () => {
  const evidence = validEvidence();
  evidence.ciPlatformRecord = { kind: 'local-equivalent-ci', ciPlatformRecord: false, allValidationsPassed: true, generatedAt: fresh() };
  const result = evaluateAcceptanceEvidence(evidence, { now: NOW });
  assert.equal(result.decision, 'BLOCKED');
  assert.equal(result.items.find((item) => item.item === 'ci-platform-record').status, 'INVALID');
});

test('local rehearsal evidence can never satisfy the staging requirement', () => {
  const evidence = validEvidence();
  evidence.stagingRecord = { kind: 'local-rehearsal', allChecksPassed: true, generatedAt: fresh(), environment: { baseUrl: 'http://127.0.0.1:3000', operator: 'local' } };
  const result = evaluateAcceptanceEvidence(evidence, { now: NOW });
  assert.equal(result.decision, 'BLOCKED');
  assert.equal(result.items.find((item) => item.item === 'staging-record').status, 'INVALID');
});

test('automated security baseline alone cannot satisfy the human security review', () => {
  const evidence = validEvidence();
  evidence.securityReview = { technicalControlsPass: true, humanReviewSigned: false };
  const result = evaluateAcceptanceEvidence(evidence, { now: NOW });
  assert.equal(result.decision, 'BLOCKED');
  assert.match(result.items.find((item) => item.item === 'security-review').detail, /未由真人签署/);
});

test('stale evidence is rejected', () => {
  const evidence = validEvidence();
  evidence.stagingRecord.generatedAt = fresh(-45);
  evidence.ciPlatformRecord.recordedAt = fresh(-45);
  const result = evaluateAcceptanceEvidence(evidence, { now: NOW });
  assert.equal(result.decision, 'BLOCKED');
  assert.equal(result.items.find((item) => item.item === 'staging-record').status, 'STALE');
  assert.equal(result.items.find((item) => item.item === 'ci-platform-record').status, 'STALE');
});

test('placeholder approvals and missing roles keep the gate blocked', () => {
  const evidence = validEvidence();
  evidence.approvals.approvals = [
    { role: 'product', name: '<real reviewer name>', decision: 'approved', signedAt: fresh() },
    { role: 'security', name: 'security-lead', decision: 'approved', signedAt: fresh() },
  ];
  const result = evaluateAcceptanceEvidence(evidence, { now: NOW });
  const item = result.items.find((entry) => entry.item === 'human-approvals');
  assert.equal(item.status, 'INVALID');
  assert.match(item.detail, /operations/);
  assert.match(item.detail, /占位符/);
});

test('four approvals must come from four distinct people and never include the author', () => {
  const evidence = validEvidence();
  evidence.approvals.approvals[2].name = 'security-lead';
  let result = evaluateAcceptanceEvidence(evidence, { now: NOW });
  assert.equal(result.items.find((item) => item.item === 'human-approvals').status, 'INVALID');

  const selfApproved = validEvidence();
  selfApproved.approvals.approvals[0].name = 'author-agent';
  result = evaluateAcceptanceEvidence(selfApproved, { now: NOW });
  assert.match(result.items.find((item) => item.item === 'human-approvals').detail, /禁止自批/);
});

test('cutover gate must reach manual-approval eligibility', () => {
  const evidence = validEvidence();
  evidence.cutoverGate = { eligible: false, decision: 'BLOCKED', blockers: ['数据库权限、TLS 与凭据审查未通过'] };
  const result = evaluateAcceptanceEvidence(evidence, { now: NOW });
  assert.equal(result.decision, 'BLOCKED');
  assert.match(result.items.find((item) => item.item === 'cutover-gate').detail, /TLS/);
});
