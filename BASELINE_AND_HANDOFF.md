# 健康运动 Skill 项目交接 — 步骤 15

当前开发基线：步骤 15（统一记录模块的 SQLite → PostgreSQL 迁移与对账工具）。

## 本轮交付
- 只读一致性检查与 dry-run
- 显式 `--apply` 的 PostgreSQL 事务迁移
- records / record_revisions / idempotency_results 三类数据保留
- 目标同内容重放可识别；目标同键异内容会整笔事务回滚
- 迁移指南与测试报告

## 验证状态
`node --test`：77 passed / 0 failed / 1 skipped。真实 PostgreSQL 测试因缺少 `POSTGRES_TEST_URL` 未执行。不要将本轮报告解释为生产迁移已验收。

## 下一步
在隔离的真实 PostgreSQL 实例执行适配器集成测试和迁移演练；随后增加迁移前后逐记录校验摘要/CSV 对账输出，再评审停写窗口、备份恢复、应用切换和回滚流程。当前工具不支持在线双写，也不会自动切换应用数据库。
