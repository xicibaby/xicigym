# 项目交接：步骤 16

当前基线：步骤 16，统一记录模块 SQLite → PostgreSQL 逐记录只读对账。

- 上一阶段：步骤 15 SQLite 到 PostgreSQL 迁移工具。
- 本阶段新增：`src/infrastructure/sqlite-postgres-reconciliation.js`、`src/reconcile-sqlite-postgres.js`、`test/sqlite-postgres-reconciliation.test.js`、对账指南与测试报告。
- 自动化测试：81 passed / 0 failed / 1 skipped（真实 PostgreSQL 测试环境未配置）。
- 操作默认只读，不会自动修复差异，不会触发迁移。
- 下一阶段建议：真实 PostgreSQL staging 数据库端到端演练，验证只读权限、时区/JSONB 规范化、差异退出码、报告归档和切换门禁；之后再处理生产切换清单。

不要将该参考实现描述为已部署或生产验收。对账报告可能包含敏感标识和数据摘要，应安全保存。
