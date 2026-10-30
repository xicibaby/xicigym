# 验收前检查清单（步骤 26 更新）

本清单用于正式验收前的最后准备，不是验收通过声明。所有复选项必须由真实证据支持，禁止仅将字段改为 `true`。
标记为 `[x]` 的条目由本地隔离演练、自动审查或可复核脚本产生；**本地证据 ≠ CI/staging 证据 ≠ 人工签署**。
外部证据的最终判定以 `npm run gate:acceptance` 的结果为准。

## A. 本地可重复检查
- [x] `npm test` 完整通过：128 项、128 通过、0 失败、0 跳过（真实 PostgreSQL 16.14 下执行）。
- [x] `npm run check:syntax` 通过（含 `.js`/`.mjs`）。
- [x] 生成并复核 `artifacts/preacceptance/PREACCEPTANCE_REPORT.md` 与 `PREACCEPTANCE_RESULT.json`。
- [x] `npm run evidence:step22` 15 项断言通过（`artifacts/step22/RUNTIME_EVIDENCE.json`）。
- [x] `npm run evidence:step23` 12 项断言通过（`artifacts/step23/RUNTIME_LIFECYCLE_EVIDENCE.json`）。
- [x] `npm run evidence:ci-local` 16 项校验通过，且明确标注 `ciPlatformRecord=false`（本地等价，不是 CI 记录）。
- [x] `npm run evidence:staging-rehearsal` 9 项断言通过（`kind=local-rehearsal`，不是 staging）。
- [x] `npm run security:baseline` 26 项技术控制通过；`npm run security:db-privileges` 21 项最小权限通过。
- [x] `npm run gate:acceptance` 已能给出精确阻塞项（CI 完成后当前 `BLOCKED`，4 项）。
- [x] `npm run action:next` 可输出下一项真人动作卡（负责角色、命令、证据文件、验证方式）。
- [x] staging 剧本已本地预演通过（6 项断言，`kind=staging-dry-run`；门禁明确拒绝该 kind）。
- [x] 门禁正向路径已在隔离 DEMO 证据目录演示（BLOCKED → READY_FOR_MANUAL_FINAL_REVIEW，演示数据不入交付包）。
- [x] 已在真实 GitHub Actions 平台跑通并归档：https://github.com/xicibaby/xicigym/actions/runs/40715156762（success，128/128，0 跳过，`artifacts/ci/CI_PLATFORM_RECORD.json`）。

## B. 数据库与迁移
- [x] 在隔离、可销毁的 PostgreSQL 环境执行迁移；保存版本与日志（PostgreSQL 16.14，证据含版本与计数）。
- [x] 验证 JSONB、唯一约束、事务回滚、并发乐观锁、历史快照、幂等重放、用户隔离（真实集成测试 + 迁移重放）。
- [x] 在停写窗口或一致性快照下执行 SQLite → PostgreSQL 迁移（演练期间源库由脚本独占）。
- [x] 运行逐记录对账；`records`、`record_revisions`、`idempotency_results` 差异均为零（`mismatchCount=0`）。
- [x] 验证迁移失败重跑策略、重复执行策略和目标库恢复策略（重复执行已验；步骤 26 完成 PostgreSQL 逻辑备份 → 重建 schema → 恢复 → 零差异对账演练）。

## C. 备份、恢复与回滚
- [x] 生成迁移前备份并验证完整性（`PRAGMA integrity_check=ok`）；步骤 26 增加 AES-256-GCM 加密备份与恢复演练（`npm run evidence:step26`）。
- [x] 在隔离路径完成恢复演练，记录实际恢复耗时与校验结果（见证据 `restore.durationMs`）。
- [ ] 验证回滚步骤、责任人、触发条件及回滚后数据一致性方案（已做技术回切 SQLite 演练，责任人/触发条件未定义）。
- [x] 确认迁移期间源库写入冻结/一致性快照方案（演练层面已确认；生产停写窗口仍需运维执行）。

## D. 安全与运行时
- [x] 已实现 `DATABASE_BACKEND=sqlite|postgres` 运行时选择；生产环境强制 PostgreSQL。
- [x] 生产环境强制 `POSTGRES_SSL=true` **且** `POSTGRES_URL` 带 `sslmode=verify-full`（或 `verify-ca`），弱配置被拒绝。
- [x] 在真实 PostgreSQL 环境验证启动、迁移、API 端到端（未认证 401 fail-closed）和优雅关闭（监听关闭 + 连接池释放）。
- [x] 已用最小权限角色（`health_skill_app`）验证 21 项权限约束：非超管、无 CREATEDB/CREATEROLE/BYPASSRLS、不拥有表、DDL/TRUNCATE 被拒绝。
- [x] 自动化安全技术控制审查 26 项通过（`artifacts/security-baseline/SECURITY_BASELINE_REPORT.json`）。
- [x] 已实现 `/healthz`、`/readyz`、`/metrics` 并在真实 SQLite/PostgreSQL 运行时验证（含数据库故障时 `/readyz` 503、`/healthz` 仍 200）。
- [ ] 真实 TLS 握手、证书链、托管服务网络策略与备份加密执行通过安全/运维负责人审查（人工审查未完成）。
- [ ] OIDC issuer/audience/JWKS、CORS、限流与 HTTPS 按部署环境验证（探针需置于私有网络/网关白名单后）。
- [ ] 确认敏感健康数据的备份加密、访问控制、保留期限与销毁流程（演练备份未加密）。

## E. 人工验收与发布决策
- [ ] 在真实 staging 环境执行演练并产出 `kind=staging` 证据（见 staging 演练手册）。
- [ ] 安全/运维负责人签署人工安全审查 `artifacts/security-baseline/HUMAN_SECURITY_REVIEW.json`。
- [ ] 产品/安全/运维 + 独立批准四方签署 `artifacts/acceptance/APPROVALS.json`（4 个不同个人，禁止自批）。
- [ ] `npm run gate:acceptance` 返回 `READY_FOR_MANUAL_FINAL_REVIEW`。
- [ ] 迁移切换门禁达到 `ELIGIBLE_FOR_MANUAL_APPROVAL` 并取得独立人员批准。
- [ ] 明确上线观察期、告警阈值、事故联系人与回滚决策人。

## 当前已知阻塞（步骤 26 结束状态，由验收门禁生成，4 项）
1. `staging-record`：现有 staging 证据为 `kind=local-rehearsal`，必须是 `kind=staging`。
2. `security-review`：缺少人类安全审查记录（自动化技术控制审查不等于人工签署）。
3. `human-approvals`：缺少产品/安全/运维 + 独立批准的四方签署。
4. `cutover-gate`：迁移切换门禁未达可人工批准状态（安全审查未通过）。

其他生产化缺口：单进程内存指标、无告警/仪表盘/追踪/压测、备份加密与保留策略未落地、无健康检查网关配置。

以上阻塞未解除前，项目状态应为"验收前准备中"，而不是"验收通过"或"可生产上线"。
