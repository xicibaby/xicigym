# 步骤 24：外部验收证据推进与项目落地报告

状态：**外部证据的"可执行路径 + 门禁"已全部落地；四项外部证据本身仍未取得（需要真实 CI、staging、安全审查人与签署人）。** 本报告不声明验收通过，也不把本地等价证据冒充外部证据。

## 1. 本轮目标

步骤 23 结束时还剩 4 类"外部证据"阻塞：CI 平台记录、真实 staging 演练、人工安全审查、人工签署与独立批准。步骤 24 的做法是：

1. 把每一类外部证据**变成可一键执行/可一键归档的流程**，并给出真实证据的文件契约；
2. 在每类证据上**加机器审查**（结构、新鲜度、占位符、自批、真假来源），防止用本地演练或占位内容蒙混过关；
3. 用统一的**验收证据门禁**汇总判定，README/清单/门禁只认真实外部证据；
4. 每个环节都做一次独立审查并记录到 `STEP24_REVIEW_LOG.md`。

## 2. 四个环节的落地内容

### 环节 1：CI 记录（可执行 + 可归档，不能伪造）

| 产出 | 说明 |
|---|---|
| `.github/workflows/ci.yml` 加固 | `permissions: contents: read`、`npm ci`（使用已提交锁文件）、`setup-node` 缓存、测试产物上传、并发去重 |
| `npm run evidence:ci-local` | 用 `yaml` 解析 ci.yml，**13 项结构/加固校验 + 1 项本地数据库可达 + 2 项本地重放**（`check:syntax`、`npm test`），共 16 项断言 |
| `npm run archive:ci-record` | CI 平台真实跑通后，把 runUrl/commit/测试计数归档为 `artifacts/ci/CI_PLATFORM_RECORD.json`，拒绝占位符与失败计数 |
| 门禁规则 | 本地等价证据 `ciPlatformRecord=false`，**永远不能**满足 CI 平台证据项 |

### 环节 2：staging 演练（剧本可执行，本地/真实双模式）

| 产出 | 说明 |
|---|---|
| `npm run evidence:staging-rehearsal` | 本地隔离演练：种子 SQLite → 备份/恢复 → 迁移/幂等重放 → 零差异对账 → PG 运行时 + 探针冒烟 → 优雅关闭，**9 项断言** |
| `node scripts/staging-rehearsal.mjs --environment=staging` | 真实 staging 模式：要求 `https` base URL、真实执行人、可销毁/显式批准的数据库；拒绝 localhost 与占位符；输出 `kind=staging` 证据 |
| 门禁规则 | 本地演练 `kind=local-rehearsal` **永远不能**满足 staging 证据项 |

### 环节 3：安全审查（技术控制自动审 + 人工签署分离）

| 产出 | 说明 |
|---|---|
| `npm run security:baseline` | **26 项**技术控制审查：生产配置 fail-closed、TLS `sslmode=verify-full` 强制、错误/日志脱敏、仓库密钥扫描（35 文件）、探针暴露默认值、锁文件完整性、CI 加固、审批模板 |
| `npm run security:db-privileges` | **21 项**数据库最小权限审查：非超管、无 CREATEDB/CREATEROLE/BYPASSRLS、不拥有表、仅必要表读写、无 TRUNCATE/TRIGGER、DDL 全部被 PostgreSQL 拒绝 |
| 配置加固 | 生产环境强制 `POSTGRES_URL` 带 `sslmode=verify-full`（或 `verify-ca`）；非生产 `sslmode=disable` 与 `POSTGRES_SSL=true` 矛盾直接拒绝 |
| 门禁规则 | 自动化报告 `humanReviewSigned=false`；人类审查必须另签 `artifacts/security-baseline/HUMAN_SECURITY_REVIEW.json` |

### 环节 4：人工签署与统一门禁

| 产出 | 说明 |
|---|---|
| `examples/approval-record.template.json` | 产品/安全/运维 + 独立批准 四类签署字段模板 |
| `npm run gate:acceptance` | 汇总五类外部证据，执行**新鲜度（≤30 天）、占位符、自批、来源类型**审查，输出 `READY_FOR_MANUAL_FINAL_REVIEW` 或带精确阻塞项的 `BLOCKED` |
| 单元测试 | `test/acceptance-gate.test.js` 9 个用例覆盖：本地演练冒充 staging、本地 CI 冒充平台记录、自动化冒充人工审查、过期证据、占位符、4 人不同签署、作者自批、门禁未达可批状态 |

## 3. 实测结果（本机真实执行）

| 检查 | 结果 |
|---|---|
| `npm test`（真实 PostgreSQL 16.14） | **128 项 / 128 通过 / 0 失败 / 0 跳过** |
| `npm run evidence:ci-local` | 16/16 校验通过 + 2 个本地重放步骤 exit 0；`ciPlatformRecord=false` |
| `npm run evidence:staging-rehearsal` | 9/9 断言通过；`kind=local-rehearsal` |
| `npm run security:baseline` | 26/26 技术控制通过；`humanReviewSigned=false` |
| `npm run security:db-privileges` | 21/21 通过（角色 `health_skill_app`；超管账号运行会失败，反向验证有效） |
| `npm run gate:acceptance` | `BLOCKED`，5 项阻塞（见下） |
| 切换门禁（步骤 22 证据） | 仍 `BLOCKED`，仅剩安全审查 1 项 |
| `npm run checksums:verify` | 交付物全部文件通过 |

`gate:acceptance` 当前精确阻塞项（这是**预期且如实**的结果）：

1. `ci-platform-record`：缺少 `artifacts/ci/CI_PLATFORM_RECORD.json`（本地等价不能替代）
2. `staging-record`：现有证据 `kind=local-rehearsal`，必须是 `kind=staging`
3. `security-review`：缺少人类安全审查记录（自动化基线不等于人工签署）
4. `human-approvals`：缺少 `artifacts/acceptance/APPROVALS.json`（产品/安全/运维 + 独立批准）
5. `cutover-gate`：切换门禁未达可人工批准状态（安全审查未通过）

## 4. 受控的"本地模拟验收"演示（证明门禁逻辑正确）

为证明门禁不是"永远 BLOCKED 的摆设"，单元测试用**内存中构造、明确标注为演示**的证据跑通了正向路径（不落盘、不写入交付包、不作为证据）：

- 构造一组完整且互相独立的证据 → 门禁返回 `READY_FOR_MANUAL_FINAL_REVIEW`；
- 把其中任一项换成"本地演练/占位符/同一人自称独立/过期"→ 门禁回到 `BLOCKED` 并给出对应原因。

该演示由 `test/acceptance-gate.test.js` 的 9 个用例覆盖，因此交付包里不会出现任何伪造的验收证据。

## 5. 剩余外部证据的获取方式（一次一个人的动作）

```bash
# ① CI 平台真实跑通后（GitHub Actions 页面取 run URL 与 commit）
npm run archive:ci-record -- \
  --run-url https://github.com/<owner>/<repo>/actions/runs/<id> \
  --commit <40位sha> --tests-total 128 --tests-passed 128 \
  --node-version 22 --postgres-version 16-alpine

# ② 在真实 staging 环境（先按 docs/release/STAGING_REHEARSAL_RUNBOOK.md 准备变量）
STAGING_BASE_URL=https://staging.<domain> \
STAGING_DATABASE_URL='postgres://<drill_role>:<secret>@<host>:5432/<db>' \
STAGING_OPERATOR='<真实姓名>' STAGING_SOURCE_SQLITE=/path/to/source.sqlite \
node scripts/staging-rehearsal.mjs --environment=staging

# ③ 安全负责人按 docs/release/SECURITY_REVIEW_PREP.md 审查后签署
#    写入 artifacts/security-baseline/HUMAN_SECURITY_REVIEW.json（humanReviewSigned=true）

# ④ 产品/安全/运维/独立批准 按 examples/approval-record.template.json 填写
#    写入 artifacts/acceptance/APPROVALS.json

# ⑤ 用真实安全审查结果重算切换门禁证据，再统一判定
npm run gate:acceptance
```

## 6. 边界与限制（必须随报告传播）

1. 本轮只让"外部证据"**可执行、可归档、可审查**，没有、也无法在本地产生真实 CI 平台记录、真实 staging 演练、真人审查与签署。
2. `evidence:ci-local`、`local-rehearsal`、`security:baseline` 都是**支撑材料**，门禁明确不认它们抵消外部阻塞项。
3. 技术控制审查不等于安全审查；数据库最小权限审查只验证了角色权限，不验证真实 TLS 握手、证书链、网络策略与备份加密执行。
4. 指标仍是单进程内存聚合；无告警、仪表盘、追踪、压测。
5. 验收结论仍为 `NOT_READY_FOR_ACCEPTANCE`，不得宣称可上线。

## 7. 每环节审查记录

见 `STEP24_REVIEW_LOG.md`：每个环节列出审查对象、审查方法、实际命令、结论、遗留风险。
