# 步骤 14：PostgreSQL 集成验证与适配器加固

## 本步骤改动

- 更新记录时不再改写 `user_id`；SQL 同时检查记录 ID、归属用户和预期版本。
- 原子确认时读取并核对归属用户，最终 UPDATE 也带用户条件。
- 注入式 Pool 默认由调用方管理；`close()` 不会意外关闭共享 Pool，只有显式 `close({ endPool: true })` 才会结束连接池。
- 列表总数以文本读取并检查 JavaScript 安全整数范围，避免大数据量计数被静默舍入。
- 迁移启动时检查已应用版本是否受支持且连续，发现版本缺口时失败关闭，不静默修补。
- 新增可选真实 PostgreSQL 集成测试，覆盖迁移、JSONB 读写、用户分页、乐观锁、历史、幂等确认和用户归属保护。

## 当前默认测试

```bash
npm test
npm run test:postgres-adapter
npm run test:postgres-integration
```

`test:postgres-integration` 在未设置 `POSTGRES_TEST_URL` 时会明确标记为 skipped。它不是模拟成功，也不会自行创建远程数据库。

## 在可运行 Docker Compose 的开发环境执行真实 PostgreSQL 测试

此流程仅适用于本地、一次性测试数据库，不要连接生产数据库：

```bash
docker compose -f docker-compose.postgres-test.yml up -d --wait
npm install --no-save pg
POSTGRES_TEST_URL='postgres://health_skill_test:local-test-only@127.0.0.1:55432/health_skill_test' npm run test:postgres-integration
docker compose -f docker-compose.postgres-test.yml down -v
```

测试数据库是临时容器，`down -v` 会删除其数据。若需要保留测试结果，请先保存日志；不要把测试账号或连接串用于生产。

## 边界

当前交付环境未检测到 `psql`、`pg_isready`、Docker 或 Podman，因此本轮不能声称真实 PostgreSQL SQL 已执行通过。这里新增的是可执行的真实数据库测试入口；在具备 PostgreSQL 和 `pg` 驱动的环境中执行后，才能记录真实集成测试结果。SQLite 仍是默认运行路径，生产切换尚未完成。
