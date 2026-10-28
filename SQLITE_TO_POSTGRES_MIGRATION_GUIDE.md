# 步骤 15：SQLite → PostgreSQL 数据迁移工具

## 安全边界
- 源 SQLite 以只读方式打开，并在单个只读事务快照中读取；不会修改源库。
- 默认是 dry-run，只检查 SQLite 完整性、schema migration 版本、记录 JSON 与索引列一致性、历史快照及幂等结果格式。
- 只有显式传入 `--apply` 才会连接 PostgreSQL 并写入。需要在运行环境自行安装 `pg` 包，并使用临时/目标数据库的 `POSTGRES_URL`。
- 写入在一个 PostgreSQL 事务中完成。已存在且完全一致的行计为 alreadyPresent；已存在但内容不同则中止并回滚，不覆盖、不合并冲突数据。
- 迁移包含 `records`、`record_revisions`、`idempotency_results`，保留 revision、reason、created_at、user_id、JSON 内容和幂等键。
- 当前仅支持已核验的 SQLite schema migration 版本 1；未知版本或迁移历史缺口会停止。

## 1. 先做源库 dry-run

```bash
SQLITE_SOURCE_PATH=/absolute/path/health-records.sqlite npm run db:migrate:postgres
```

此步骤只验证源 SQLite，不会访问 PostgreSQL，也不会改写数据。请先备份源数据库并保存 dry-run 输出。

## 2. 目标数据库写入

在独立迁移环境安装 `pg`（本仓库不将其设为默认运行依赖），并配置目标数据库连接：

```bash
npm install --no-save pg
SQLITE_SOURCE_PATH=/absolute/path/health-records.sqlite \
POSTGRES_URL='postgresql://migration_user:***@host:5432/health_records' \
npm run db:migrate:postgres -- --apply
```

生产环境应通过 secret manager 注入连接串，不要把凭据提交到仓库或日志。若使用 TLS，可设置 `POSTGRES_SSL=true`；该选项启用证书校验，不应通过关闭证书校验规避连接问题。

## 3. 迁移后核对

- 比较输出中的源计数、目标计数、inserted 和 alreadyPresent。
- 使用只读 SQL 分别统计三张表，并按业务抽样核验用户归属、记录 JSON、每个 revision 快照和幂等结果。
- 执行真实 PostgreSQL 集成测试、备份恢复演练和应用层端到端测试。
- 只有完成业务对账、恢复演练及切换回滚演练后，才允许切换应用写入目标数据库。

## 限制
该工具不是在线双写或零停机切换器。迁移期间必须冻结源库写入，或在维护窗口中确保源数据不再变化；虽然源读取使用一致快照，但迁移后源库新增的写入不会自动同步。当前没有自动切换应用数据库、自动删除源库或自动回滚业务切换的功能。目标 PostgreSQL 的真实执行尚需在可用的真实实例上验证。
