# 验收前检查报告

- 生成时间：2026-10-29T14:23:59.612Z
- Node.js：v24.21.0
- 本地检查：通过
- 真实 PostgreSQL URL：已配置（不输出凭据）
- 项目内真实 PostgreSQL 演练证据：存在且通过（artifacts/step22/RUNTIME_EVIDENCE.json）
- 运行时生命周期证据：存在且通过（artifacts/step23/RUNTIME_LIFECYCLE_EVIDENCE.json）
- 运行时探针：/healthz、/readyz、/metrics 已接入
- 外部验收证据门禁：BLOCKED（阻塞 4 项）
- 判定：**NOT_READY_FOR_ACCEPTANCE**

## 自动化测试

- 总数：136；通过：136；失败：0；跳过：0

## 检查结果

- PASS: required:README.md
- PASS: required:openapi.yaml
- PASS: required:MIGRATION_CUTOVER_GATE_GUIDE.md
- PASS: required:SQLITE_TO_POSTGRES_MIGRATION_GUIDE.md
- PASS: required:POSTGRESQL_ADAPTER_GUIDE.md
- PASS: required:STEP17_TEST_REPORT.md
- PASS: required:STEP22_REAL_POSTGRES_REPORT.md
- PASS: required:STEP22_BASELINE_AND_HANDOFF.md
- PASS: required:STEP23_RUNTIME_OBSERVABILITY_REPORT.md
- PASS: required:STEP23_BASELINE_AND_HANDOFF.md
- PASS: required:STEP24_EXTERNAL_EVIDENCE_REPORT.md
- PASS: required:STEP24_BASELINE_AND_HANDOFF.md
- PASS: required:STEP24_REVIEW_LOG.md
- PASS: required:STEP25_HUMAN_ACTION_REPORT.md
- PASS: required:scripts/next-human-action.mjs
- PASS: required:STEP26_DATA_SAFETY_REPORT.md
- PASS: required:scripts/step26-evidence.mjs
- PASS: required:scripts/load-smoke.mjs
- PASS: required:src/infrastructure/backup-crypto.js
- PASS: required:src/infrastructure/postgres-backup.js
- PASS: required:src/postgres-maintenance.js
- PASS: required:ops/prometheus/alerts.yml
- PASS: required:ops/prometheus/README.md
- PASS: required:行动包/README_真人动作行动包.md
- PASS: required:行动包/01_CI平台动作卡.md
- PASS: required:行动包/02_staging环境动作卡.md
- PASS: required:行动包/03_安全审查动作卡.md
- PASS: required:行动包/04_四方签署动作卡.md
- PASS: required:行动包/05_门禁复核与发布动作卡.md
- PASS: required:行动包/安全审查记录模板.json
- PASS: required:行动包/审批记录模板.json
- PASS: required:docs/release/REAL_POSTGRES_DRILL_GUIDE.md
- PASS: required:scripts/step22-runtime-evidence.mjs
- PASS: required:scripts/step23-runtime-evidence.mjs
- PASS: required:docs/release/SECURITY_REVIEW_PREP.md
- PASS: required:docs/release/CI_EVIDENCE_ARCHIVE_GUIDE.md
- PASS: required:docs/release/STAGING_REHEARSAL_RUNBOOK.md
- PASS: required:docs/release/ACCEPTANCE_EVIDENCE_GATE.md
- PASS: required:src/server.js
- PASS: required:src/http/probe-endpoints.js
- PASS: required:src/http/shutdown.js
- PASS: required:src/observability/metrics.js
- PASS: required:src/acceptance/acceptance-gate.js
- PASS: required:scripts/ci-local-evidence.mjs
- PASS: required:scripts/staging-rehearsal.mjs
- PASS: required:scripts/security-baseline-check.mjs
- PASS: required:scripts/check-db-privileges.mjs
- PASS: required:scripts/acceptance-gate.mjs
- PASS: required:scripts/archive-ci-record.mjs
- PASS: required:examples/approval-record.template.json
- PASS: required:src/infrastructure/postgres-record-repository.js
- PASS: required:src/infrastructure/sqlite-postgres-reconciliation.js
- PASS: required:src/infrastructure/postgres-test-safety.js
- PASS: required:src/migration-cutover-gate.js
- PASS: required:test/postgres-real.integration.test.js
- PASS: required:.github/workflows/ci.yml
- PASS: required:docs/release/PREACCEPTANCE_CHECKLIST.md
- PASS: javascript-syntax
- PASS: automated-test-suite
- PASS: step22-runtime-evidence
- PASS: step23-runtime-lifecycle
- PASS: ci-local-equivalent
- PASS: step26-data-safety
- PASS: load-smoke
- PASS: staging-rehearsal
- PASS: security-technical-controls
- BLOCKED: acceptance-evidence-gate

## 验收前阻塞项

- [ ] 验收证据：staging-record: 证据 kind=local-rehearsal，必须是 staging
- [ ] 验收证据：security-review: 缺少人类安全审查记录（自动化基线审查不等于人工审查）
- [ ] 验收证据：human-approvals: 缺少 artifacts/acceptance/APPROVALS.json（需产品/安全/运维签署 + 独立批准）
- [ ] 验收证据：cutover-gate: 门禁未达可人工批准状态：数据库权限、TLS 与凭据审查未通过

## 边界说明

本报告只记录本地可重复检查结果；外部证据门禁为 BLOCKED 时不得宣称验收通过。
