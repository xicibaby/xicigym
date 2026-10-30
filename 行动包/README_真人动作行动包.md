# 真人动作行动包（步骤 25）

> 目的：把验收门禁剩下的 5 项**只能由真人/真实环境完成**的动作，变成"谁来做、多久、怎么做、做完拿什么文件来验证"的行动卡。
> 机器能做的已经全部自动化（128 测试、47 项安全控制、52 项演练断言、门禁判定）；这里只列不可替代的人工环节。

## 0. 先看一个命令

```bash
npm run action:next            # 告诉我下一件该做的事
npm run action:next -- --all   # 列出全部 5 件待办动作卡
```

`action:next` 会读取最新门禁结果，按依赖顺序打印：负责角色、预计耗时、为什么阻塞、逐条命令、需要的证据文件、验证命令、对应手册。

## 1. 当前待办总览（门禁 BLOCKED，5 项）

| # | 动作 | 负责角色 | 预计 | 需要产出的证据 |
|---:|---|---|---|---|
| 1 ✅ | 真实 CI 平台跑通并归档（**已完成**） | 研发（有推送权限） | 20–40 分钟 | `artifacts/ci/CI_PLATFORM_RECORD.json` ✅ |
| 2 | 真实 staging 演练（kind=staging） | 运维 + 研发 | 30–60 分钟 | `artifacts/staging-rehearsal/STAGING_REHEARSAL_EVIDENCE.json` |
| 3 | 人工安全审查并签署 | 安全 + 运维负责人 | 1–2 小时 | `artifacts/security-baseline/HUMAN_SECURITY_REVIEW.json` |
| 4 | 产品/安全/运维 + 独立四方签署 | 四位负责人 | 30–60 分钟 | `artifacts/acceptance/APPROVALS.json` |
| 5 | 切换门禁达可人工批准 | 安全 + 独立审批人 | 15–30 分钟 | `artifacts/acceptance/CUTOVER_GATE_RESULT.json` |

> 动作 1 已完成：仓库 https://github.com/xicibaby/xicigym ，CI run https://github.com/xicibaby/xicigym/actions/runs/40715156762
> （success，128/128 通过、0 跳过）。当前门禁 `BLOCKED / 4`，下一步是动作 2。

依赖关系：3 → 5；2、4 可并行；全部完成后跑 `npm run gate:acceptance`，期望 `READY_FOR_MANUAL_FINAL_REVIEW`。

## 2. 建议排期（剩余 4 项，约 1 个工作日）

| 时间 | 谁 | 做什么 | 完成标志 |
|---|---|---|---|
| D1 上午 | 运维 + 研发 | 动作 2：先本地预演（dry-run），再到真实 staging 执行 | 证据 `kind=staging` |
| D1 下午 | 安全 + 运维 | 动作 3：安全审查会 + 签署 | `humanReviewSigned=true` |
| D1 下午 | 产品/安全/运维/独立 | 动作 4：四方签署；动作 5：重算切换门禁 | 门禁返回 `READY_FOR_MANUAL_FINAL_REVIEW` |

## 3. 每步完成后的验证方式（任何人都能复核）

```bash
npm run gate:acceptance    # 看对应项是否 PASS、剩余阻塞是否减少
npm run action:next        # 看下一件该做的事
npm run checksums:verify   # 改动证据文件后校验交付物完整性
```

## 4. 行动卡索引

| 文件 | 内容 |
|---|---|
| `01_CI平台动作卡.md` | 推仓库 → 跑 CI → 归档 run URL/commit |
| `02_staging环境动作卡.md` | 本地预演 → 真实 staging 演练与安全护栏 |
| `03_安全审查动作卡.md` | 8 个审查域逐项核对 + 签署文件填写 |
| `04_四方签署动作卡.md` | 4 个不同个人、禁止自批、签署文件填写 |
| `05_门禁复核与发布动作卡.md` | 重算门禁 → 人工最终复核 → 发布/回滚 |
| `安全审查记录模板.json` | 复制到 `artifacts/security-baseline/HUMAN_SECURITY_REVIEW.json` 后填写 |
| `审批记录模板.json` | 复制到 `artifacts/acceptance/APPROVALS.json` 后填写 |

## 5. 已为你预演/预校验的部分（减少真人环境风险）

- **staging 剧本本地预演已通过**：用本地隔离 PostgreSQL + 本地 HTTP 探针跑通 `--environment=staging` 全流程（6 项断言），证据 `kind=staging-dry-run`；门禁明确拒绝该 kind，证明"预演不会冒充 staging"。
- **门禁正向路径已演示**：在隔离演示目录中补齐 5 类证据后，门禁返回 `READY_FOR_MANUAL_FINAL_REVIEW`；演示数据标注 DEMO、位于 `.local-tools`，不进入交付包。
- **CI 本地等价执行**：`npm run evidence:ci-local` 校验 workflow 结构并本机重放语法检查与全量测试，保证推到 GitHub 后大概率一次通过。
- **安全技术控制**：47 项自动审查已通过，人工审查只需核对真实环境相关项（见动作卡 3）。

## 6. 安全与合规提醒

1. 真实 staging/生产凭据不得写入仓库、交付包、聊天记录或本报告；用秘密管理器/临时环境变量。
2. 签署必须真人操作；AI 不得代签，代码也不得把 `humanReviewSigned` 或 `decision: approved` 预填为真。
3. 任何一项审查不通过时，保持门禁 BLOCKED 并记录整改项，不得为了过门禁修改规则或伪造证据。
4. 门禁通过后仍需人工最终复核与独立批准；门禁不会自动改数据或切流量。
