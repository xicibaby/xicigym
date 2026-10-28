/**
 * Human-action navigator (step 25).
 *
 * Turns the acceptance gate blockers into one concrete, ordered action card for the human
 * who can unblock it. Machine-checkable work is already automated; this script only points
 * at the irreducible human/external steps and the exact evidence file each one must produce.
 *
 * Usage:
 *   node scripts/next-human-action.mjs          # next single action
 *   node scripts/next-human-action.mjs --all    # all pending actions in order
 *   node scripts/next-human-action.mjs --json
 */
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const gatePath = join(root, 'artifacts', 'acceptance', 'ACCEPTANCE_GATE_RESULT.json');
const jsonMode = process.argv.includes('--json');
const showAll = process.argv.includes('--all');

const ACTIONS = {
  'ci-platform-record': {
    order: 1,
    title: '在 GitHub Actions 真实跑一次 CI 并归档记录',
    owner: '研发（有仓库推送权限）',
    estimate: '20–40 分钟（含等待 CI）',
    blockedBy: '本地等价 CI 不是平台记录；门禁只认真实 run URL + commit + 全通过测试计数。',
    steps: [
      '把当前源码推到 GitHub（如未建仓）：git init && git add . && git commit -m "health-skill record module" && git remote add origin <repo-url> && git push -u origin main',
      '打开 Actions 页面确认 record-module-ci 运行；确认 PostgreSQL 16 服务启动、真实集成测试未被跳过、128 项全部通过。',
      '复制该次运行的 run URL 与 commit SHA。',
      '执行：npm run archive:ci-record -- --run-url <run-url> --commit <sha> --tests-total 128 --tests-passed 128 --node-version 22 --postgres-version 16-alpine',
    ],
    evidence: 'artifacts/ci/CI_PLATFORM_RECORD.json',
    verify: 'npm run gate:acceptance',
    help: 'docs/release/CI_EVIDENCE_ARCHIVE_GUIDE.md',
  },
  'staging-record': {
    order: 2,
    title: '在真实 staging 环境执行演练（kind=staging）',
    owner: '运维 + 研发',
    estimate: '30–60 分钟',
    blockedBy: '现有 staging 证据为本地 rehearsal；门禁要求 kind="staging" 且来自 https staging 环境。',
    steps: [
      '准备 staging 环境变量：STAGING_BASE_URL（https、非 localhost）、STAGING_DATABASE_URL（演练库）、STAGING_OPERATOR（真实姓名）、可选 STAGING_SOURCE_SQLITE。',
      '如演练库尚未迁移且已获批准：export STAGING_APPLY_MIGRATION=1（仅此时允许写入）。',
      '执行：node scripts/staging-rehearsal.mjs --environment=staging',
      '确认 7 项断言全部通过，并把证据归档到 artifacts/staging-rehearsal/STAGING_REHEARSAL_EVIDENCE.json。',
    ],
    evidence: 'artifacts/staging-rehearsal/STAGING_REHEARSAL_EVIDENCE.json（kind=staging）',
    verify: 'npm run gate:acceptance',
    help: 'docs/release/STAGING_REHEARSAL_RUNBOOK.md',
  },
  'security-review': {
    order: 3,
    title: '安全/运维负责人完成人工审查并签署',
    owner: '安全负责人 + 运维负责人',
    estimate: '1–2 小时（首次审查）',
    blockedBy: '自动化技术控制审查不等于人工审查；门禁要求真人签署的 HUMAN_SECURITY_REVIEW.json。',
    steps: [
      '打开 行动包/03_安全审查动作卡.md，按 8 个审查域逐项核对。',
      '重点确认：TLS 证书链与 sslmode、最小权限账号、秘密管理与轮换、探针网关白名单、日志脱敏、备份加密与保留、OIDC/CORS、健康数据合规。',
      '填写 artifacts/security-baseline/HUMAN_SECURITY_REVIEW.json（模板见 行动包/安全审查记录模板.json），签署人必须与自动化报告区分。',
      '如任一项不通过：记录问题与整改项，不得把 signed 置为 true。',
    ],
    evidence: 'artifacts/security-baseline/HUMAN_SECURITY_REVIEW.json（humanReviewSigned=true）',
    verify: 'npm run gate:acceptance',
    help: 'docs/release/SECURITY_REVIEW_PREP.md',
  },
  'human-approvals': {
    order: 4,
    title: '产品 / 安全 / 运维 + 独立审批四方签署',
    owner: '产品负责人、安全负责人、运维负责人、独立审批人',
    estimate: '30–60 分钟（会议签署）',
    blockedBy: '门禁要求 4 个不同个人签署，且签署人不得是交付作者本人（禁止自批）。',
    steps: [
      '使用 行动包/审批记录模板.json 或 examples/approval-record.template.json。',
      '收集四方签署：role=product / security / operations，另有 independentApproval（必须第 4 个不同的人）。',
      '填写 release 版本、commit、证据包文件名与 SHA256；签署时间用带时区的 ISO 时间。',
      '保存为 artifacts/acceptance/APPROVALS.json。',
    ],
    evidence: 'artifacts/acceptance/APPROVALS.json（4 个不同签署人）',
    verify: 'npm run gate:acceptance',
    help: 'docs/release/ACCEPTANCE_EVIDENCE_GATE.md',
  },
  'cutover-gate': {
    order: 5,
    title: '安全审查通过后重算迁移切换门禁至可人工批准',
    owner: '安全负责人 + 独立审批人',
    estimate: '15–30 分钟',
    blockedBy: '切换门禁 evidence 里 securityReviewPassed=false；只有真人审查通过后才能由签署人置 true。',
    steps: [
      '在 cutover 证据中补齐 securityReviewPassed=true（须与 HUMAN_SECURITY_REVIEW.json 的签署一致）与 approvedBy。',
      '执行：node scripts/migration-cutover-gate.js --evidence <cutover-evidence.json>，确认 decision=ELIGIBLE_FOR_MANUAL_APPROVAL。',
      '把输出保存为 artifacts/acceptance/CUTOVER_GATE_RESULT.json。',
      '最后执行 npm run gate:acceptance，期望 READY_FOR_MANUAL_FINAL_REVIEW。',
    ],
    evidence: 'artifacts/acceptance/CUTOVER_GATE_RESULT.json（eligible=true）',
    verify: 'npm run gate:acceptance',
    help: 'MIGRATION_CUTOVER_GATE_GUIDE.md',
  },
};

let gate = null;
try { gate = JSON.parse(await readFile(gatePath, 'utf8')); }
catch { gate = null; }

if (!gate) {
  console.error('缺少 artifacts/acceptance/ACCEPTANCE_GATE_RESULT.json；请先执行：npm run gate:acceptance');
  process.exitCode = 2;
  process.exit();
}

const pendingItems = (gate.items ?? []).filter((item) => item.status !== 'PASS');
const pendingKeys = pendingItems.map((item) => item.item).filter((key) => ACTIONS[key]).sort((a, b) => ACTIONS[a].order - ACTIONS[b].order);
const pendingUnknown = pendingItems.map((item) => item.item).filter((key) => !ACTIONS[key]);

const statusTable = [
  { order: 1, item: 'ci-platform-record', label: '真实 CI 平台记录' },
  { order: 2, item: 'staging-record', label: '真实 staging 演练' },
  { order: 3, item: 'security-review', label: '人工安全审查签署' },
  { order: 4, item: 'human-approvals', label: '四方签署' },
  { order: 5, item: 'cutover-gate', label: '切换门禁批准' },
].map((entry) => {
  const found = (gate.items ?? []).find((item) => item.item === entry.item);
  return { ...entry, status: found?.status ?? 'MISSING', detail: found?.detail ?? '' };
});

function printAction(key) {
  const action = ACTIONS[key];
  const status = statusTable.find((entry) => entry.item === key);
  console.log('');
  console.log(`▶ 第 ${action.order} 项：${action.title}`);
  console.log(`  当前状态：${status.status} — ${status.detail}`);
  console.log(`  负责角色：${action.owner}`);
  console.log(`  预计耗时：${action.estimate}`);
  console.log(`  为什么阻塞：${action.blockedBy}`);
  console.log('  执行步骤：');
  action.steps.forEach((step, index) => console.log(`   ${index + 1}. ${step}`));
  console.log(`  需要的证据文件：${action.evidence}`);
  console.log(`  验证命令：${action.verify}`);
  console.log(`  操作手册：${action.help}`);
}

if (jsonMode) {
  const payload = {
    decision: gate.decision,
    blockingCount: gate.blockingCount,
    items: statusTable,
    next: pendingKeys.length ? { key: pendingKeys[0], ...ACTIONS[pendingKeys[0]] } : null,
  };
  console.log(JSON.stringify(payload, null, 2));
} else {
  console.log(`验收门禁：${gate.decision}（待办 ${gate.blockingCount} 项）`);
  console.log('');
  console.log('序号  动作项                     状态');
  console.log('----  -------------------------  --------');
  for (const entry of statusTable) console.log(` ${entry.order}    ${entry.label.padEnd(26, ' ')} ${entry.status}`);
  if (pendingKeys.length === 0 && pendingUnknown.length === 0) {
    console.log('');
    console.log('全部外部证据已齐：进入人工最终复核，确认证据原件后由独立审批人批准发布。');
  } else {
    if (pendingUnknown.length) console.log(`\n门禁还有未登记的动作项：${pendingUnknown.join(', ')}（请检查门禁输出）`);
    const targets = showAll ? pendingKeys : pendingKeys.slice(0, 1);
    for (const key of targets) printAction(key);
    if (!showAll && pendingKeys.length > 1) {
      console.log('');
      console.log(`还有 ${pendingKeys.length - 1} 项待办；执行 npm run action:next -- --all 查看全部动作卡。`);
    }
  }
}
