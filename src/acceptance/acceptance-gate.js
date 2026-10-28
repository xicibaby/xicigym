/**
 * Acceptance evidence gate (step 24, area 4/4).
 *
 * Pure evaluation logic: decides whether the *external* acceptance evidence is complete
 * and trustworthy. It deliberately cannot be satisfied by local rehearsals:
 *
 *   - ciPlatformRecord:      a real CI platform run (not the local equivalent replay)
 *   - stagingRecord:         a real staging environment drill (kind === 'staging')
 *   - securityReview:        human-signed security review (not the automated baseline)
 *   - humanApprovals:        product + security + operations + independent approver
 *   - cutoverGate:           migration-cutover evidence that reached manual-approval eligibility
 *
 * Rules: missing / stale / placeholder / self-approved evidence keeps the gate BLOCKED.
 * This module performs no I/O so it is unit-testable and cannot be tricked by filesystem state.
 */
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_EVIDENCE_AGE_DAYS = 30;
const REQUIRED_ROLES = ['product', 'security', 'operations'];
const PLACEHOLDER_PATTERN = /^(?:<[^>]*>|tbd|todo|pending|none|n\/a|change ?me|example|xxx+)$/i;
const EMAIL_OR_URL_PATTERN = /^(?:https?:\/\/\S+|[^\s@]+@[^\s@]+\.[^\s@]+)$/;

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}
function isPlaceholder(value) {
  return !isNonEmptyString(value) || PLACEHOLDER_PATTERN.test(value.trim());
}
function parseTime(value) {
  if (!isNonEmptyString(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
function ageDays(isoValue, now) {
  const date = parseTime(isoValue);
  if (!date) return null;
  return (now.getTime() - date.getTime()) / DAY_MS;
}
function freshEnough(isoValue, now) {
  const age = ageDays(isoValue, now);
  return age !== null && age >= -1 && age <= MAX_EVIDENCE_AGE_DAYS;
}

function evaluateCiPlatformRecord(record, now) {
  const item = { item: 'ci-platform-record', status: 'MISSING', detail: '' };
  if (!record) { item.detail = '缺少 artifacts/ci/CI_PLATFORM_RECORD.json（本地等价执行不能替代 CI 平台记录）'; return item; }
  if (record.kind === 'local-equivalent-ci' || record.ciPlatformRecord === false) {
    item.status = 'INVALID';
    item.detail = '提交的是本地等价执行证据，不是 CI 平台记录';
    return item;
  }
  if (record.status !== 'success') { item.status = 'INVALID'; item.detail = `CI 记录状态为 ${record.status ?? 'unknown'}，必须为 success`; return item; }
  if (!isNonEmptyString(record.runUrl) || !/^https:\/\//.test(record.runUrl)) { item.status = 'INVALID'; item.detail = '缺少可核验的 https runUrl'; return item; }
  if (!isNonEmptyString(record.commit) || isPlaceholder(record.commit)) { item.status = 'INVALID'; item.detail = '缺少 CI 实际运行的 commit'; return item; }
  if (!freshEnough(record.recordedAt, now)) { item.status = 'STALE'; item.detail = `CI 记录时间缺失或超过 ${MAX_EVIDENCE_AGE_DAYS} 天`; return item; }
  if (!(Number(record.tests?.failed) === 0) || !(Number(record.tests?.passed) > 0)) { item.status = 'INVALID'; item.detail = 'CI 记录缺少全通过的测试计数'; return item; }
  item.status = 'PASS';
  item.detail = `run=${record.runUrl} tests=${record.tests.passed}/${record.tests.tests ?? record.tests.passed}`;
  return item;
}

function evaluateStagingRecord(record, now) {
  const item = { item: 'staging-record', status: 'MISSING', detail: '' };
  if (!record) { item.detail = '缺少 artifacts/staging-rehearsal/STAGING_REHEARSAL_EVIDENCE.json（本地演练不能替代 staging）'; return item; }
  if (record.kind !== 'staging') { item.status = 'INVALID'; item.detail = `证据 kind=${record.kind ?? 'unknown'}，必须是 staging`; return item; }
  if (record.allChecksPassed !== true) { item.status = 'INVALID'; item.detail = 'staging 演练存在未通过断言'; return item; }
  if (!freshEnough(record.generatedAt, now)) { item.status = 'STALE'; item.detail = `staging 证据缺失或超过 ${MAX_EVIDENCE_AGE_DAYS} 天`; return item; }
  if (!isNonEmptyString(record.environment?.baseUrl) || !/^https:\/\//.test(record.environment.baseUrl)) { item.status = 'INVALID'; item.detail = '缺少 staging baseUrl'; return item; }
  if (isPlaceholder(record.environment?.operator)) { item.status = 'INVALID'; item.detail = '缺少 staging 演练执行人'; return item; }
  item.status = 'PASS';
  item.detail = `${record.environment.baseUrl} operator=${record.environment.operator}`;
  return item;
}

function evaluateSecurityReview(record) {
  const item = { item: 'security-review', status: 'MISSING', detail: '' };
  if (!record) { item.detail = '缺少人类安全审查记录（自动化基线审查不等于人工审查）'; return item; }
  if (record.humanReviewSigned !== true && record.signed !== true) { item.status = 'INVALID'; item.detail = '安全审查未由真人签署'; return item; }
  if (isPlaceholder(record.reviewer) || isPlaceholder(record.reviewedAt)) { item.status = 'INVALID'; item.detail = '缺少审查人姓名或审查时间'; return item; }
  if (!Array.isArray(record.scope) || record.scope.length === 0) { item.status = 'INVALID'; item.detail = '缺少审查范围'; return item; }
  item.status = 'PASS';
  item.detail = `reviewer=${record.reviewer} scope=${record.scope.length}`;
  return item;
}

function evaluateHumanApprovals(record) {
  const item = { item: 'human-approvals', status: 'MISSING', detail: '' };
  if (!record) { item.detail = '缺少 artifacts/acceptance/APPROVALS.json（需产品/安全/运维签署 + 独立批准）'; return item; }
  const approvals = Array.isArray(record.approvals) ? record.approvals : [];
  const byRole = new Map();
  for (const approval of approvals) {
    if (!approval || typeof approval !== 'object') continue;
    byRole.set(approval.role, approval);
  }
  const problems = [];
  const names = [];
  for (const role of REQUIRED_ROLES) {
    const approval = byRole.get(role);
    if (!approval) { problems.push(`缺少 ${role} 签署`); continue; }
    if (approval.decision !== 'approved') problems.push(`${role} 未批准`);
    if (isPlaceholder(approval.name)) problems.push(`${role} 签署人姓名为空或占位符`);
    if (isPlaceholder(approval.signedAt) || !parseTime(approval.signedAt)) problems.push(`${role} 签署时间无效`);
    names.push(String(approval.name ?? '').trim());
  }
  const independent = record.independentApproval;
  if (!independent || independent.required !== true) problems.push('缺少独立批准要求记录');
  else {
    if (independent.decision !== 'approved') problems.push('独立批准未通过');
    if (isPlaceholder(independent.name)) problems.push('独立批准人姓名为空或占位符');
    if (!parseTime(independent.signedAt)) problems.push('独立批准时间无效');
    names.push(String(independent.name ?? '').trim());
  }
  const author = record.author?.name;
  const distinctApprovers = new Set(names.filter(Boolean));
  if (distinctApprovers.size < 4) problems.push(`签署人必须为 4 个不同个人（当前 ${distinctApprovers.size}）`);
  if (isNonEmptyString(author) && names.includes(author.trim())) problems.push('签署人不得包含交付作者本人（禁止自批）');
  if (problems.length) { item.status = 'INVALID'; item.detail = problems.join('；'); return item; }
  item.status = 'PASS';
  item.detail = `approvers=${distinctApprovers.size} 独立批准=是`;
  return item;
}

function evaluateCutoverGate(record) {
  const item = { item: 'cutover-gate', status: 'MISSING', detail: '' };
  if (!record) { item.detail = '缺少迁移切换门禁结果（需 securityReviewPassed/rollbackPlanVerified 等字段为 true）'; return item; }
  if (record.eligible !== true || record.decision !== 'ELIGIBLE_FOR_MANUAL_APPROVAL') {
    item.status = 'INVALID';
    item.detail = `门禁未达可人工批准状态：${(record.blockers ?? []).join('；') || record.decision || 'unknown'}`;
    return item;
  }
  item.status = 'PASS';
  item.detail = '门禁达到 ELIGIBLE_FOR_MANUAL_APPROVAL';
  return item;
}

function evaluateLocalSupportingEvidence(localCi, baseline) {
  return {
    item: 'supporting-local-evidence',
    status: localCi?.allValidationsPassed === true && baseline?.technicalControlsPass === true ? 'PASS' : 'MISSING',
    detail: `本地等价 CI=${localCi?.allValidationsPassed === true ? '通过' : '缺失'}；安全技术控制=${baseline?.technicalControlsPass === true ? '通过' : '缺失'}（仅支撑材料，不解除阻塞）`,
    blocking: false,
  };
}

/**
 * @param {{ciPlatformRecord?: any, stagingRecord?: any, securityReview?: any, approvals?: any, cutoverGate?: any, localCi?: any, securityBaseline?: any}} evidence
 * @param {{now?: Date}} [options]
 */
export function evaluateAcceptanceEvidence(evidence = {}, { now = new Date() } = {}) {
  const items = [
    evaluateCiPlatformRecord(evidence.ciPlatformRecord, now),
    evaluateStagingRecord(evidence.stagingRecord, now),
    evaluateSecurityReview(evidence.securityReview),
    evaluateHumanApprovals(evidence.approvals),
    evaluateCutoverGate(evidence.cutoverGate),
  ];
  const blockingItems = items.filter((item) => item.status !== 'PASS');
  const ready = blockingItems.length === 0;
  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    decision: ready ? 'READY_FOR_MANUAL_FINAL_REVIEW' : 'BLOCKED',
    blockingCount: blockingItems.length,
    blockers: blockingItems.map((item) => `${item.item}: ${item.detail}`),
    items,
    supporting: evaluateLocalSupportingEvidence(evidence.localCi, evidence.securityBaseline),
    note: '该门禁只检查外部证据是否齐全、新鲜、非占位、非自批；通过后仍需人工最终复核与独立批准，不会自动切换流量。',
    maxEvidenceAgeDays: MAX_EVIDENCE_AGE_DAYS,
  };
}

export const ACCEPTANCE_REQUIRED_ROLES = Object.freeze(REQUIRED_ROLES);
export { MAX_EVIDENCE_AGE_DAYS, EMAIL_OR_URL_PATTERN };
