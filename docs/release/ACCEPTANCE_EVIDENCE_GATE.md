# 验收证据门禁说明（步骤 24）

`npm run gate:acceptance` 把项目验收所需的**外部证据**汇总为一个 fail-closed 判定。
它只检查证据是否齐全、新鲜、非占位、非自批；通过后仍需人工最终复核与独立批准，不会自动切换流量。

## 1. 输入文件

| 证据项 | 文件 | 说明 |
|---|---|---|
| CI 平台记录 | `artifacts/ci/CI_PLATFORM_RECORD.json` | 由 `npm run archive:ci-record` 在真实 CI 成功后归档 |
| staging 演练 | `artifacts/staging-rehearsal/STAGING_REHEARSAL_EVIDENCE.json` | 必须 `kind="staging"`（见 staging 演练手册） |
| 人工安全审查 | `artifacts/security-baseline/HUMAN_SECURITY_REVIEW.json` | 真人签署：`humanReviewSigned: true`、reviewer、reviewedAt、scope |
| 人类签署 | `artifacts/acceptance/APPROVALS.json` | 产品/安全/运维 + 独立批准，模板见 `examples/approval-record.template.json` |
| 迁移切换门禁 | `artifacts/acceptance/CUTOVER_GATE_RESULT.json`（缺失时自动用 `artifacts/step22/cutover-evidence.json` 现场评估） | 必须 `eligible: true`、`decision: ELIGIBLE_FOR_MANUAL_APPROVAL` |

支撑材料（不解除阻塞）：`artifacts/ci-local/CI_LOCAL_EQUIVALENT_EVIDENCE.json`、`artifacts/security-baseline/SECURITY_BASELINE_REPORT.json`。

## 2. 审查规则

1. **来源真实**：`kind=local-equivalent-ci` 不能满足 CI 项；`kind=local-rehearsal` 不能满足 staging 项；自动化报告不能满足人工安全审查项。
2. **新鲜度**：CI 记录与 staging 证据必须在 30 天内（`recordedAt`/`generatedAt`）。
3. **非占位符**：`<...>`、`tbd`、`todo`、`pending`、`none`、`example` 等一律视为缺失。
4. **禁止自批**：签署人姓名必须 4 个不同个人，且不得包含 `author.name`。
5. **CI 测试必须全通过**：`failed === 0` 且 `passed > 0`。
6. **runUrl 必须 https**：审核人需打开链接核对真实运行。
7. **门禁未达可批状态直接阻塞**：切换门禁 `BLOCKED` 时验收项也阻塞。

## 3. 命令与退出码

```bash
npm run gate:acceptance            # 人类可读 + JSON
npm run gate:acceptance -- --json  # 仅 JSON 摘要
```

- 退出码 `0`：`READY_FOR_MANUAL_FINAL_REVIEW`（进入人工最终复核）
- 退出码 `2`：`BLOCKED`（附精确阻塞项）

结果写入 `artifacts/acceptance/ACCEPTANCE_GATE_RESULT.json`，并被 `npm run preacceptance:check` 读取生成验收前阻塞清单。

## 4. 通过之后

1. 人工最终复核证据原件（CI 运行、staging 记录、安全审查、签署）；
2. 独立审批人确认切换窗口与回滚方案；
3. 由运维执行上线；上线观察期内保留回滚触发器；
4. 本门禁**不会**自动修改数据或切换流量。

## 5. 当前状态（步骤 24 结束）

`BLOCKED`，5 项精确阻塞：CI 平台记录缺失、staging 证据为本地 rehearsal、人工安全审查缺失、四方签署缺失、切换门禁未达可人工批准状态。所有阻塞都需要真人/真实环境完成。
