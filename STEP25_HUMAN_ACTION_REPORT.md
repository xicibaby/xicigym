# 步骤 25：「真人动作」推进报告

状态：**五件真人/真实环境动作已全部变成可执行行动卡；其中第 1 件（GitHub 发布 + 真实 CI）已由 AI 使用短期令牌执行完成，其余 4 件仍需真人执行。** 本报告不声明验收通过。

## 1. 本轮目标

步骤 24 结束时，门禁 `BLOCKED` 的 5 项全部是"只有真人/真实环境才能补"的证据。步骤 25 做三件事：

1. **降低真人动作的摩擦**：每项动作给出负责角色、耗时、逐条命令、需要的证据文件、验证命令、失败处理；
2. **把能提前验证的都验证掉**：staging 剧本本地预演、门禁正向路径演示、CI 本地等价复核；
3. **让"下一步做什么"可被任何接手人一眼看到**：`npm run action:next` 直接输出下一张动作卡。

## 2. 新增能力

| 能力 | 说明 |
|---|---|
| `npm run action:next` | 读取门禁结果，按依赖顺序输出"下一项真人动作"：负责角色、耗时、命令、证据文件、验证方式；`--all` 看全部 5 项，`--json` 给自动化用 |
| `gate:acceptance --evidence-dir <dir>` | 门禁可对任意证据目录求值，便于评审交接包/演练副本而不污染真实 `artifacts/` |
| staging 剧本 `STAGING_DRY_RUN_ALLOW_LOCALHOST=1` | 本地预演 staging 代码路径，证据 `kind=staging-dry-run`；门禁明确拒绝该 kind，防止预演冒充真实 staging |
| `行动包/`（7 份文档 + 2 份模板） | 5 张动作卡 + 索引 + 安全审查记录模板 + 审批记录模板 |
| `STEP25_HUMAN_ACTION_REPORT.md`（本文件） | 汇总与边界说明 |

## 3. 实测结果

### 3.1 staging 剧本本地预演（新增验证）

用本地隔离 PostgreSQL 16.14 + 本地 HTTP 探针（API 以 `DATABASE_BACKEND=postgres` 启动）执行 `--environment=staging`：

- 6 项断言全部通过：healthz 200、readyz 200(backend=postgres)、metrics 200、迁移 dry-run、迁移 apply、逐记录对账 `mismatchCount=0`；
- 证据 `kind="staging-dry-run"`、`dryRun=true`；
- 门禁随即把它判为 `INVALID（kind=staging-dry-run，必须是 staging）`——**证明预演无法冒充真实 staging**。

### 3.2 门禁正向路径演示（证明"补齐就会变绿"）

在隔离目录 `.local-tools/gate-ready-demo/`（全部数据标注 `DEMO DATA`，不进入交付包）补齐 5 类证据后：

```
ACCEPTANCE GATE: READY_FOR_MANUAL_FINAL_REVIEW (blocking items: 0)
- [PASS] ci-platform-record ... tests=128/128
- [PASS] staging-record ... operator=demo-ops
- [PASS] security-review ... scope=6
- [PASS] human-approvals ... approvers=4 独立批准=是
- [PASS] cutover-gate ... ELIGIBLE_FOR_MANUAL_APPROVAL
```

说明：门禁不是"永远 BLOCKED 的摆设"；只要 5 类真实证据齐全且合法，判定会翻转为可人工复核。

### 3.3 当前真实门禁状态（未变）

```
ACCEPTANCE GATE: BLOCKED (blocking items: 5)   # CI 完成前的快照；CI 归档后为 4，见第 5 节
- [MISSING] ci-platform-record
- [INVALID] staging-record（当前为 local-rehearsal；dry-run 也会被拒）
- [MISSING] security-review
- [MISSING] human-approvals
- [INVALID] cutover-gate（securityReviewPassed=false）
```

### 3.4 自动化基线未回退

- `npm test`：**128 项 / 128 通过 / 0 失败 / 0 跳过**（真实 PostgreSQL 16.14）；
- `npm run evidence:ci-local`：16 项断言通过；
- `npm run security:baseline`：26 项技术控制通过，`humanReviewSigned=false`；
- `npm run security:db-privileges`：21 项通过（最小权限角色 `health_skill_app`）。

## 4. 行动包内容（本轮交付的人类执行入口）

```
行动包/
├── README_真人动作行动包.md        # 总览、依赖关系、1–2 天排期、验证方式
├── 01_CI平台动作卡.md              # 推仓库 → 跑 CI → 归档 run URL/commit
├── 02_staging环境动作卡.md         # 本地预演 → 真实 staging 演练（7 项断言）
├── 03_安全审查动作卡.md            # 8 个审查域逐项核对 + 签署
├── 04_四方签署动作卡.md            # 4 个不同个人、禁止自批、会议议程
├── 05_门禁复核与发布动作卡.md      # 重算门禁 → 人工最终复核 → 发布/回滚
├── 安全审查记录模板.json           # → artifacts/security-baseline/HUMAN_SECURITY_REVIEW.json
└── 审批记录模板.json               # → artifacts/acceptance/APPROVALS.json
```

每张卡固定包含：负责角色、预计耗时、前置条件、逐条命令、预期输出、失败处理、交付物清单。

## 5. 真人动作 1 已完成：GitHub 发布 + 真实 CI 记录

2026-10-28 已由 AI 使用用户提供的短期令牌完成动作 1（不是用户手动操作，也不是本地等价执行）：

| 项 | 值 |
|---|---|
| 仓库 | https://github.com/xicibaby/xicigym （public） |
| 首次提交 | `1e5543b4157aa924f731302e30958215e8c08d59` |
| CI run | https://github.com/xicibaby/xicigym/actions/runs/40715156762 （success） |
| CI 测试 | **128 项 / 128 通过 / 0 失败 / 0 跳过**（PostgreSQL 16-alpine 服务） |
| 归档证据 | `artifacts/ci/CI_PLATFORM_RECORD.json` |
| 门禁变化 | 阻塞 **5 → 4**；`ci-platform-record` = PASS |

发布方式：无 git 二进制，改用 GitHub Git Data API 单次提交（169 文件）；空仓库先经 Contents API 落 README 首提交。
CI 记录由脚本从 job 日志解析真实测试计数，全通过才归档；令牌文件用后已删除。

## 6. 仍待真人执行的 4 件事（唯一剩余路径）

| # | 动作 | 负责角色 | 预计 | 完成后证据 |
|---:|---|---|---|---|
| 2 | 真实 staging 演练（kind=staging） | 运维 + 研发 | 30–60 min | `artifacts/staging-rehearsal/STAGING_REHEARSAL_EVIDENCE.json` |
| 3 | 人工安全审查签署 | 安全 + 运维 | 1–2 h | `artifacts/security-baseline/HUMAN_SECURITY_REVIEW.json` |
| 4 | 四方签署 | 4 位负责人 | 30–60 min | `artifacts/acceptance/APPROVALS.json` |
| 5 | 切换门禁重算至可批准 | 安全 + 独立审批人 | 15–30 min | `artifacts/acceptance/CUTOVER_GATE_RESULT.json` |

当前门禁：`BLOCKED / 4`；`npm run action:next` 已指向第 2 项（staging）。
每完成一项跑 `npm run gate:acceptance`，阻塞数应减少；全部完成后 `npm run action:next` 应提示"全部外部证据已齐"。

## 7. 本轮审查记录（工程审查）

| 审查对象 | 方法 | 结论 |
|---|---|---|
| staging dry-run 模式 | 实跑 6 项断言；核对 kind 与门禁拒绝逻辑 | 通过：代码路径已验证，kind 隔离有效 |
| 门禁 `--evidence-dir` | 用隔离演示目录实跑 BLOCKED→READY，不影响真实 artifacts | 通过：默认路径行为不变 |
| `action:next` | 对当前 BLOCKED 状态实跑单条/全部/JSON 三种输出，核对与门禁一致 | 通过：输出 5 项状态与 5 张动作卡匹配 |
| 行动包事实一致性 | 逐条核对命令、脚本参数、证据路径、断言数（128/26/21/16/9/6）与代码/证据 | 通过：命令均可执行，参数与脚本一致 |
| 回归 | `npm test` + 既有 evidence 脚本 | 通过：128/128、0 跳过 |

## 7. 边界

1. 第 1 项（CI 平台记录）已真实完成；其余 4 项仍需真人/真实环境，本地/演示证据不能替代。
2. 门禁 READY 演示使用 DEMO 数据，仅证明逻辑；交付包内不存在伪造证据。
3. staging 预演不是 staging 演练；真实 staging 仍需 https 环境、真实执行人与数据库。
4. 安全技术控制 47 项通过不等于人工审查通过；人工签署不可代签。
5. 验收结论仍为 `NOT_READY_FOR_ACCEPTANCE`，不可宣称可上线。
