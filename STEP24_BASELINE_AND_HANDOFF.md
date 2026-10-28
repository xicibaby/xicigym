# 步骤 24 基线与交接说明

## 当前基线

步骤 24 在步骤 23（探针/指标/优雅关闭）基础上，把 4 类**外部验收证据**从"待办事项"推进为"可执行流程 + 可归档契约 + 机器审查门禁"：

- **CI**：`ci.yml` 加固（least-privilege token、`npm ci`、产物上传、并发去重）；`npm run evidence:ci-local` 做 13 项结构/加固校验 + 1 项数据库可达 + 2 项本地重放；`npm run archive:ci-record` 归档真实 CI 记录（拒绝占位符）。
- **staging**：`scripts/staging-rehearsal.mjs` 双模式——本地 rehearsal（9 项断言）与真实 staging 演练（要求 https、真实执行人、可销毁/显式批准库；拒绝 localhost 与占位符）；证据 `kind` 严格区分。
- **安全**：`npm run security:baseline` 26 项技术控制审查（生产配置 fail-closed、TLS `sslmode=verify-full` 强制、脱敏、密钥扫描、探针暴露、锁文件、CI 加固、审批模板）；`npm run security:db-privileges` 21 项最小权限审查。
- **验收门禁**：`npm run gate:acceptance` 统一汇总五类外部证据（CI 平台记录、staging、人工安全审查、四方签署、切换门禁），审查新鲜度（≤30 天）、占位符、自批、来源类型；`test/acceptance-gate.test.js` 9 个用例。
- 预验收检查器改为**读取验收门禁结果**生成阻塞项，不再手写外部阻塞文案。

## 验证记录（实测）

- Node.js v24.21.0；PostgreSQL 16.14（本地便携版）。
- `npm test`：**128 项 / 128 通过 / 0 失败 / 0 跳过**。
- `npm run evidence:ci-local`：16/16 通过，`ciPlatformRecord=false`。
- `npm run evidence:staging-rehearsal`：9/9 通过，`kind=local-rehearsal`。
- `npm run security:baseline`：26/26 通过，`humanReviewSigned=false`。
- `npm run security:db-privileges`：21/21 通过（角色 `health_skill_app`；超管反向验证失败）。
- `npm run gate:acceptance`：`BLOCKED`，5 项阻塞（CI 平台记录 / staging / 人工安全审查 / 四方签署 / 切换门禁）。
- `npm run preacceptance:check`：退出码 2、`NOT_READY_FOR_ACCEPTANCE`，本地检查全绿。
- 负向护栏实测：`archive:ci-record` 非法参数 exit 2；`staging-rehearsal --environment=staging` 缺变量 exit 2。

## 当前验收状态（必须如实传播）

| 证据项 | 状态 |
|---|---|
| CI 平台记录 | **缺失**（本地等价证据不能替代） |
| 真实 staging 演练 | **缺失**（只有 `kind=local-rehearsal`） |
| 人工安全审查 | **缺失**（只有自动技术控制审查） |
| 产品/安全/运维/独立批准 | **缺失** |
| 迁移切换门禁 | `BLOCKED`（安全审查未通过） |

因此统一门禁判定为 `BLOCKED`，项目状态仍是"验收前准备中"，**不是验收通过，也不可上线**。

## 下一步（需要真人/真实环境执行）

1. 把仓库推到 GitHub，让 `ci.yml` 真实跑一次，用 `npm run archive:ci-record` 归档。
2. 按 `docs/release/STAGING_REHEARSAL_RUNBOOK.md` 在真实 staging 执行演练。
3. 按 `docs/release/SECURITY_REVIEW_PREP.md` 完成安全/运维审查，写入 `HUMAN_SECURITY_REVIEW.json`。
4. 按 `examples/approval-record.template.json` 收集四方签署 `APPROVALS.json`。
5. 重算切换门禁证据后用 `npm run gate:acceptance` 汇总；只有 `READY_FOR_MANUAL_FINAL_REVIEW` 才进入人工最终复核与发布。

## 重要边界

1. 本轮没有产生任何真实外部证据；所有"通过"均标注为本地/支撑材料。
2. 自动化审查 ≠ 人工审查；技术控制通过 ≠ 安全审查通过。
3. 门禁通过后仍需人工最终复核与独立批准，不会自动切换流量。
4. 仍有生产化缺口：单进程指标、无告警/仪表盘/追踪/压测、备份加密与保留策略未落地。
