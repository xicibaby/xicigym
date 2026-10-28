# 步骤 21：PostgreSQL 正式运行时接入与验收准备报告

## 本轮实现

- 运行时支持 `DATABASE_BACKEND=sqlite|postgres`；开发环境默认 SQLite。
- 生产环境强制 `DATABASE_BACKEND=postgres`、`POSTGRES_URL` 与 `POSTGRES_SSL=true`。
- PostgreSQL 连接通过环境变量注入；启动时执行连通性探测，错误信息不回显连接串。
- PostgreSQL 迁移默认不在服务启动时自动执行；仅在显式设置 `POSTGRES_AUTO_MIGRATE=true` 时执行。
- 增加 PostgreSQL 配置校验测试；更新 CI 安装声明依赖、staging runbook、验收前清单和预验收检查器。

## 本地实际验证

- `npm test`：92 项，91 passed，0 failed，1 skipped。
- `npm run check:syntax`：44 个 JavaScript 文件通过语法检查。
- `npm run preacceptance:check`：本地检查与测试汇总通过，但按 fail-closed 规则返回退出码 2，判定 `NOT_READY_FOR_ACCEPTANCE`。
- 跳过项为需要 `POSTGRES_TEST_URL` 的真实 PostgreSQL 集成测试。
- 当前容器无 Docker、Podman、psql、pg_isready；也无法访问 npm registry，因此未执行真实 PostgreSQL 集成测试，未生成 `package-lock.json`。

## 验收前剩余阻塞

1. 在联网 CI/开发环境安装 `pg` 并生成/审查锁文件。
2. 实际运行 `.github/workflows/ci.yml`，保留 PostgreSQL 16 集成测试未跳过的成功记录。
3. 在隔离 staging 执行迁移、SQLite → PostgreSQL 逐记录对账，并保存零差异报告。
4. 完成备份恢复/回滚演练，记录实际结果。
5. 完成 TLS、最小权限、秘密管理、健康数据备份与保留策略审查。
6. 产品负责人、安全/运维负责人完成签署，并由独立人员批准切换。

## 结论

步骤 21 已把 PostgreSQL 从“仅有适配器”推进到“可配置的 HTTP 运行时后端”，并由自动检查确认当前本地代码检查通过。但由于缺少真实数据库与外部审查证据，本报告不声明项目已可正式验收或可生产上线。正式验收门禁仍应保持关闭。
