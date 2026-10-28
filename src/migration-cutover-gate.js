import { readFile } from 'node:fs/promises';

const REQUIRED_TRUE = [
  ['automatedTestsPassed', '自动化测试未通过或缺少结果'],
  ['realPostgresIntegrationPassed', '真实 PostgreSQL 集成测试未通过或未执行'],
  ['backupVerified', '迁移前备份未验证'],
  ['restoreDrillPassed', '备份恢复演练未通过'],
  ['sourceWriteFreezeConfirmed', '尚未确认源库停写或一致性快照'],
  ['rollbackPlanVerified', '回滚方案未验证'],
  ['securityReviewPassed', '数据库权限、TLS 与凭据审查未通过'],
];

export function evaluateCutoverEvidence(evidence) {
  const blockers = [];
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    return { schemaVersion: 1, eligible: false, blockers: ['证据必须是 JSON 对象'] };
  }
  for (const [key, message] of REQUIRED_TRUE) {
    if (evidence[key] !== true) blockers.push(message);
  }
  if (evidence.reconciliation?.match !== true) blockers.push('逐记录对账未明确通过');
  if (!Number.isInteger(evidence.reconciliation?.mismatchCount) || evidence.reconciliation.mismatchCount !== 0) {
    blockers.push('对账差异数量必须是整数 0');
  }
  if (typeof evidence.targetPostgresVersion !== 'string' || !evidence.targetPostgresVersion.trim()) {
    blockers.push('缺少实际验证的 PostgreSQL 版本');
  }
  if (typeof evidence.reportPath !== 'string' || !evidence.reportPath.trim()) {
    blockers.push('缺少可复核的证据报告路径或归档标识');
  }
  if (evidence.approvedBy && typeof evidence.approvedBy !== 'string') blockers.push('approvedBy 必须是字符串');
  return {
    schemaVersion: 1,
    eligible: blockers.length === 0,
    blockers,
    decision: blockers.length === 0 ? 'ELIGIBLE_FOR_MANUAL_APPROVAL' : 'BLOCKED',
    note: '该结果只检查提交的证据字段，不会连接数据库，也不会自动切换流量或修改数据。最终切换仍需人工批准。',
  };
}

export async function evaluateCutoverEvidenceFile(filename) {
  let evidence;
  try { evidence = JSON.parse(await readFile(filename, 'utf8')); }
  catch (error) { return { schemaVersion: 1, eligible: false, decision: 'BLOCKED', blockers: [`无法读取/解析证据文件：${error.message}`] }; }
  return evaluateCutoverEvidence(evidence);
}
