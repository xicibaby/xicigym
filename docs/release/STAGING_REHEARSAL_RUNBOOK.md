# staging 演练执行手册（步骤 24）

本手册用于在真实 staging 环境执行迁移/对账/探针冒烟演练，并产出验收门禁认可的 `kind=staging` 证据。
本地演练（`npm run evidence:staging-rehearsal`）只证明剧本可执行，**不能替代**真实 staging。

## 1. 前置条件

| 项 | 要求 |
|---|---|
| 服务入口 | 已部署的 staging API，`https://`，非 localhost |
| 数据库 | staging 专用库；数据库名含 `test`/`temp`/`sandbox`/`ci` 时视为可销毁；否则需显式设置 `STAGING_ALLOW_NON_DISPOSABLE=1` 并完成审批 |
| 迁移角色 | 演练若需写入，必须显式 `STAGING_APPLY_MIGRATION=1`；否则只做 dry-run + 对账 |
| 源库 | 可选的 SQLite 快照路径（`STAGING_SOURCE_SQLITE`），用于迁移 dry-run 与逐记录对账 |
| 执行人 | `STAGING_OPERATOR` 填真实姓名/工号，禁止占位符 |
| TLS | 默认 `rejectUnauthorized: true`；仅当显式 `STAGING_POSTGRES_SSL=false` 时才不校验（不建议，应记录原因） |

## 2. 执行步骤

```bash
export STAGING_BASE_URL='https://staging.<domain>'
export STAGING_DATABASE_URL='postgres://<drill_role>:<secret>@<host>:5432/<staging_db>'
export STAGING_OPERATOR='<真实执行人>'
export STAGING_SOURCE_SQLITE='/secure/path/source-snapshot.sqlite'   # 可选
export STAGING_POSTGRES_SSL=true                                      # 默认校验证书
# 仅在审批通过、需要实际写入 staging 库时：
# export STAGING_APPLY_MIGRATION=1
# 仅当数据库名不含 test/temp/sandbox/ci 且已完成审批时：
# export STAGING_ALLOW_NON_DISPOSABLE=1

node scripts/staging-rehearsal.mjs --environment=staging
```

脚本会执行并断言：

1. `GET /healthz` 200；
2. `GET /readyz` 200 且 `backend=postgres`；
3. `GET /metrics` 200 且含请求计数；
4. 目标 PostgreSQL 版本可读取；
5. 源 SQLite 迁移 dry-run（提供源库时）；
6. 逐记录对账零差异（提供源库时）；
7. 证据写入 `artifacts/staging-rehearsal/STAGING_REHEARSAL_EVIDENCE.json`，`kind=staging`。

## 3. 安全护栏

脚本会拒绝以下情况（exit 2）：

- `STAGING_BASE_URL` 不是 https 或指向 localhost/127.0.0.1；
- 缺少 `STAGING_DATABASE_URL`/`STAGING_OPERATOR`；
- 执行人是占位符（如 `<name>`/`TBD`/`example`）；
- 数据库名不可销毁且未显式设置 `STAGING_ALLOW_NON_DISPOSABLE=1`；
- 未使用 `--environment=staging`（本地 rehearsal 不会写 `kind=staging`）。

## 4. 演练后

1. 归档 `artifacts/staging-rehearsal/STAGING_REHEARSAL_EVIDENCE.json`（随发布包或证据库保存）；
2. 若 `STAGING_APPLY_MIGRATION=1`，记录写入前后的对账结果与操作人；
3. 更新 `artifacts/acceptance/APPROVALS.json` 中的 `stagingRecord` 字段；
4. 运行 `npm run gate:acceptance` 确认 staging 项变为 PASS（其余外部证据仍需补齐）。

## 5. 注意

- 本脚本**不切换生产流量**，也不做双写；正式切换仍走 `migration-cutover-gate` + 人工批准。
- 演练证据只代表执行当时的 staging 状态；超过 30 天门禁视为过期，需要复跑。
- 不要在 staging 演练中使用生产数据库或生产凭据。
