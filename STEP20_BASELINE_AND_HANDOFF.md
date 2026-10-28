# 步骤 20 基线与交接说明

## 当前基线
步骤 20 在步骤 17 迁移切换门禁基础上新增：
- 步骤 18：GitHub Actions PostgreSQL 16 CI 工作流与真实集成测试入口。
- 步骤 19：staging 演练 runbook、测试数据库名称保护。
- 步骤 20：语法/交付物/自动化测试检查器、验收前报告与正式验收清单。

## 验证记录
- Node.js v22.16.0。
- `npm run check:syntax`：通过，44 个 JS 文件。
- `npm test`：90 项，89 passed，0 failed，1 skipped。
- `npm run preacceptance:check`：退出码 2，结果 `NOT_READY_FOR_ACCEPTANCE`；这是因为真实 PostgreSQL 未配置、运行时仍固定 SQLite、真实迁移/恢复/安全审查/审批证据尚缺。
- 本地没有执行真实 PostgreSQL 测试，也没有执行 CI workflow。

## 重要边界
PostgreSQL 仓储适配器与迁移工具仍是参考实现/演练资产；HTTP 启动入口目前固定使用 SQLite。不得声称 PostgreSQL 已成为生产运行时后端，不得声称生产迁移、部署或正式验收完成。

## 下一步仅在外部环境可用时继续
1. 在一次性 PostgreSQL 16 服务中执行真实集成测试并取得 CI 记录。
2. 设计并实现正式运行时数据库选择与关闭/健康检查生命周期。
3. 在 staging 完成迁移、对账、恢复和回滚演练。
4. 完成安全/运维审查及人工验收。
