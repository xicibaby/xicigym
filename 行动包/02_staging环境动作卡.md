# 动作卡 2｜真实 staging 演练

**负责角色**：运维（环境与凭据）+ 研发（演练执行）
**预计耗时**：30–60 分钟（预演 10 分钟 + staging 20–40 分钟）
**产出的证据**：`artifacts/staging-rehearsal/STAGING_REHEARSAL_EVIDENCE.json`（`kind=staging`）
**门禁角色**：第 2 项阻塞；本地 rehearsal 与 dry-run 都不能替代。

## 1. 先本地预演（10 分钟，零风险）

预演用本地隔离 PostgreSQL + 本地 HTTP 探针，验证 staging 剧本代码路径：

```bash
# 启动本地隔离 PG（仅回环）与本地 API（见 docs/release/STAGING_REHEARSAL_RUNBOOK.md 的本地预演段）
STAGING_BASE_URL=http://127.0.0.1:<port> \
STAGING_DATABASE_URL='postgres://<user>:<pwd>@127.0.0.1:55432/<disposable_db>' \
STAGING_OPERATOR='<你的名字>' \
STAGING_SOURCE_SQLITE='<一份 SQLite 快照>' \
STAGING_APPLY_MIGRATION=1 \
STAGING_POSTGRES_SSL=false \
STAGING_DRY_RUN_ALLOW_LOCALHOST=1 \
node scripts/staging-rehearsal.mjs --environment=staging
```

期望 `STAGING DRY RUN (kind=staging-dry-run): ALL CHECKS PASSED`。证据 `kind=staging-dry-run`，门禁会拒绝它——这是刻意的安全设计。

## 2. 准备 staging 变量

| 变量 | 要求 |
|---|---|
| `STAGING_BASE_URL` | 已部署 staging API 的 **https** 地址，不能是 localhost |
| `STAGING_DATABASE_URL` | staging 演练库连接串；**不要用生产库** |
| `STAGING_OPERATOR` | 真实执行人姓名/工号，禁止占位符 |
| `STAGING_SOURCE_SQLITE` | 可选；提供时执行迁移 dry-run + 逐记录对账 |
| `STAGING_APPLY_MIGRATION` | 仅在"已批准写 staging"时设为 `1`；否则只读校验 |
| `STAGING_POSTGRES_SSL` | 默认 `true`（校验证书）；仅当环境明确不校验时才设 `false` 并记录原因 |
| `STAGING_ALLOW_NON_DISPOSABLE` | 仅当库名不含 test/temp/sandbox/ci 且完成审批时设 `1` |

凭据通过秘密管理器或临时 shell 注入，绝不写入仓库、交付包或聊天记录。

## 3. 执行真实演练

```bash
export STAGING_BASE_URL='https://staging.<domain>'
export STAGING_DATABASE_URL="$(secret-tool lookup service staging-db)"   # 示例
export STAGING_OPERATOR='<真实姓名>'
export STAGING_SOURCE_SQLITE='/secure/path/source-snapshot.sqlite'
# export STAGING_APPLY_MIGRATION=1    # 仅在批准后
node scripts/staging-rehearsal.mjs --environment=staging
```

脚本会拒绝：非 https / localhost / 占位符执行人 / 未批准的非可销毁库。

## 4. 预期结果（7 项断言）

1. `/healthz` 200
2. `/readyz` 200 且 `backend=postgres`
3. `/metrics` 200 且含请求计数
4. 目标 PostgreSQL 版本可读取
5. 迁移 dry-run 通过（提供源库时）
6. 逐记录对账 `mismatchCount=0`（提供源库时）
7. 证据写入 `artifacts/staging-rehearsal/STAGING_REHEARSAL_EVIDENCE.json`，`kind=staging`

## 5. 验证与交回

```bash
npm run gate:acceptance     # staging-record 应变 PASS
npm run action:next         # 指向下一项动作
```

同时把 staging 演练结果（执行人、时间、环境名、对账结论）记入变更单或工单。

## 6. 失败处理

| 现象 | 处理 |
|---|---|
| `readyz` 503 | 先查 staging 数据库连通性与 `schema_migrations`；修复后复跑 |
| 对账有差异 | 不得继续；停止并保留现场，按迁移手册排查源/目标数据 |
| TLS 证书报错 | 补齐 CA/证书链，禁止把 `STAGING_POSTGRES_SSL=false` 当默认 |
| 误连生产库 | 立即停止操作，按事故流程上报；门禁不接受该证据 |

## 7. 交付物清单

- [ ] `artifacts/staging-rehearsal/STAGING_REHEARSAL_EVIDENCE.json`（`kind=staging`、`allChecksPassed=true`）
- [ ] 演练执行记录（环境、执行人、时间、对账结论）
- [ ] `npm run gate:acceptance` 中 `staging-record` = PASS
