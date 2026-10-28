# 步骤 22 基线与交接说明

## 当前基线

步骤 22 在步骤 21（PostgreSQL 可配置运行时后端）基础上，补齐了**真实 PostgreSQL 隔离演练证据**：

- 新增 `scripts/step22-runtime-evidence.mjs` 与 `npm run evidence:step22`：种子 SQLite → 一致性备份 → 恢复 → 重置可销毁 PostgreSQL 目标 → 迁移 dry-run/`--apply`/幂等重放 → 逐记录对账 → `DATABASE_BACKEND=postgres` 运行时启动 → 优雅关闭 → 回切 SQLite → 切换门禁评估。
- 新增 `package-lock.json`（`pg@8.16.3`），解除"无法生成锁文件"的旧阻塞。
- `scripts/preacceptance-check.js` 现在读取 `artifacts/step22/RUNTIME_EVIDENCE.json`，删除已被真实证据替代的旧阻塞，同时保留安全审查与人工批准阻塞。
- 新增 `docs/release/REAL_POSTGRES_DRILL_GUIDE.md`、`STEP22_REAL_POSTGRES_REPORT.md`、本文件；更新 README、staging runbook、验收前清单。

## 验证记录（实测）

- Node.js v24.21.0；PostgreSQL 16.14（本地便携版，127.0.0.1:55432）。
- `node scripts/preacceptance-check.js --syntax-only`：通过。
- `POSTGRES_TEST_URL=… node --test`：92 项、92 通过、0 失败、0 跳过（真实集成测试实际执行）。
- `POSTGRES_DRILL_URL=… npm run evidence:step22`：15 项断言全部通过。
- `node scripts/migration-cutover-gate.js --evidence artifacts/step22/cutover-evidence.json`：`BLOCKED`，仅剩安全审查 1 项。
- `node scripts/preacceptance-check.js`：退出码 2，`NOT_READY_FOR_ACCEPTANCE`（设计预期）。

完整输出见 `artifacts/step22/` 与 `artifacts/preacceptance/`。

## 重要边界

1. 演练是**本地隔离环境**，不代表 staging、CI 平台或生产已通过。
2. TLS、最小权限账号、秘密管理、备份加密与保留策略**未审查**；切换门禁保持关闭。
3. 无健康检查/就绪探针、无指标告警，生产可观测性未实现。
4. 不得声称"验收通过""可生产上线""PostgreSQL 已成为生产运行时后端"。

## 下一步（步骤 23 候选）

1. CI 平台执行 PostgreSQL 16 工作流并归档通过记录。
2. 增加 `/healthz`、`/readyz` 与连接池/迁移版本指标，并补对应测试。
3. 完成 TLS、最小权限账号与秘密管理审查，关闭切换门禁最后一项。
4. 在正式 staging 复跑 `evidence:step22` 并取得产品/安全/运维签署与独立人员批准。
5. 如需继续做代码交付，可考虑把演练脚本的 15 项断言纳入 `npm test` 的集成测试套件（当前需要外部数据库，默认不随 `npm test` 执行）。
