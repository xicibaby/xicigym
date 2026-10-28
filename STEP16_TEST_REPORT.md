# 步骤 16 测试报告

## 实现

- 新增 `src/infrastructure/sqlite-postgres-reconciliation.js`：只读目标查询、按主键/复合键逐行比较、规范化 JSON、时间戳归一化、SHA-256 摘要、缺失/多余/内容差异明细。
- 新增 `src/reconcile-sqlite-postgres.js`：环境变量配置 CLI；差异时返回退出码 `2`。
- 新增 `npm run db:reconcile:postgres` 和 `npm run test:reconciliation`。
- 新增 `SQLITE_POSTGRES_RECONCILIATION_GUIDE.md`。

## 自动化验证

在 Node.js 环境执行 `npm test`：

- 82 项测试总数
- 81 passed
- 0 failed
- 1 skipped（真实 PostgreSQL 集成测试需要 `POSTGRES_TEST_URL`）

新增 4 项测试覆盖：匹配数据及 JSON 键顺序归一化、缺失/多余/差异报告、只读查询行为、缺少 Pool 时快速失败。

## 真实数据库状态

真实 PostgreSQL 集成测试本轮仍因未配置 `POSTGRES_TEST_URL` 而跳过。以上通过项包括单元测试和使用受控假 Pool 的只读查询测试，不能替代真实 PostgreSQL 实例验证。生产切换前应使用只读账号对真实测试目标运行对账，并保留报告；若报告有差异，禁止切换并先调查。
