# PostgreSQL 适配器接入指南（步骤 13）

## 当前状态

这是面向 `pg` 兼容连接池的仓储适配器和迁移基线。步骤 14 新增了可选的真实 PostgreSQL 集成测试，但本交付环境没有可用的 PostgreSQL 服务，因此尚未连接真实 PostgreSQL；不要将其视为已部署的生产数据库。

## 设计要点

- 所有用户数据查询通过参数化 SQL 执行；记录更新会将用户归属作为 SQL 条件并保持 `user_id` 不可变。
- `replace()` 使用 `WHERE record_id = $n AND user_id = $n AND revision = $n` 做乐观并发控制；没有更新行时回滚并返回冲突/不存在错误。
- `confirmAtomically()` 在单个事务内竞争幂等键、锁定记录、校验状态和版本、更新记录、写入历史快照。事务失败时幂等声明也会回滚。
- `applyPostgresMigrations()` 使用 `pg_advisory_xact_lock` 序列化迁移，迁移 DDL 和迁移版本记录放在同一事务。
- 列表查询始终要求 `user_id`，但 API 层仍应保留用户身份范围服务，不能只依赖客户端传入用户 ID。

## 接入步骤

1. 选定托管 PostgreSQL 供应商与目标版本，创建独立数据库和最小权限应用账号。
2. 在项目部署环境安装 `pg`，通过环境变量注入连接参数；不要把密码写入仓库或 ZIP。
3. 在启动流程中创建 Pool，设置 `connectionTimeoutMillis`、`idleTimeoutMillis`、`max` 与 TLS 验证配置。
4. 通过 `PostgresRecordRepository.connect({ pool, migrate: true })` 执行迁移；生产迁移应由单独发布步骤控制，而不是让每个应用实例无条件执行。
5. 将仓储实例注入现有 `RecordService` / `UserScopedRecordService`，并确认 `assertRecordRepository(repo, { requireAtomicConfirm: true })` 通过。
6. 在临时 PostgreSQL 环境运行迁移和真实集成测试，再进行并发、故障注入、备份与恢复演练。
7. 通过灰度/双写或离线导入方案迁移现有 SQLite 数据；执行总量、用户归属、记录版本、历史快照和幂等键对账后才切换读写流量。

## 发布前必测

- 两个连接同时更新同一 revision，仅一个成功。
- 相同幂等键并发确认时仅产生一个确认结果和一个历史版本。
- 同一幂等键跨记录使用时返回冲突。
- 更新记录成功但历史写入失败时，记录更新应整体回滚。
- 数据库断连、连接池耗尽、迁移失败和版本超前时应用应安全失败。
- RLS（如启用）、备份加密、恢复时间目标（RTO）与恢复点目标（RPO）按部署方案验证。

## 当前限制

SQLite 仍是现有默认启动路径；本步骤没有更改默认数据库，没有添加真实 `pg` 依赖，也没有宣称真实 PostgreSQL 集成测试通过。生产接入需要实际环境配置与独立验证。


连接池由注入方拥有。`repo.close()` 默认不关闭共享 Pool；只有显式调用 `repo.close({ endPool: true })` 才会结束连接池。列表总数超出 JavaScript 安全整数范围时会报错，不会返回舍入后的计数。
