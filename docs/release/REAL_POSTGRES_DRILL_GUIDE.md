# 真实 PostgreSQL 演练指南（步骤 22）

本指南说明如何在**隔离、可销毁**的 PostgreSQL 环境里复现步骤 22 的完整演练，并生成可复核的证据文件。
本指南不是上线手册，不包含生产切换步骤。

## 1. 前置条件

| 项 | 要求 |
|---|---|
| Node.js | >= 20（本次演练实测 v24.21.0；CI 使用 22） |
| PostgreSQL | 16.x（本次演练实测 16.14） |
| `pg` 驱动 | 已声明在 `package.json`，需在联网环境执行 `npm install` 生成锁文件 |
| 数据库名 | 必须带 `test` / `temp` / `sandbox` / `ci` 标记；否则工具链默认拒绝执行破坏性操作 |

## 2. 获取 PostgreSQL 的三种方式

### 方式 A：Docker Compose（推荐用于团队统一环境）

```bash
docker compose -f docker-compose.postgres-test.yml up -d --wait
```

### 方式 B：本地便携版二进制（无 Docker 时使用，本次步骤 22 实际采用）

1. 从 npm registry 下载 `@embedded-postgres/windows-x64` 对应 16.x 版本的 tarball，解包后得到完整 `native/bin` 目录（含 `initdb.exe`、`postgres.exe`）。
2. 初始化独立数据目录并启动，只监听回环地址：

```powershell
initdb.exe -D <dataDir> -U postgres --auth=trust --encoding=UTF8 --locale=C
postgres.exe -D <dataDir> -p 55432 -h 127.0.0.1
```

3. 创建可销毁角色与数据库（示例）：

```sql
CREATE ROLE health_skill_test LOGIN PASSWORD 'local-test-only' CREATEDB;
CREATE DATABASE health_skill_test OWNER health_skill_test;
CREATE DATABASE health_skill_migration_test OWNER health_skill_test;
```

> 注意：`pg_ctl.exe` 在受限令牌沙箱中会因 `could not create restricted token` 失败，此时可直接前台运行 `postgres.exe`。
> 便携版 `native/bin` 只带服务端二进制（无 `psql`），建库请用 Node.js + `pg` 脚本完成。

### 方式 C：已有托管测试实例

确认实例可销毁、账号权限最小化后，直接作为 `POSTGRES_DRILL_URL` 目标。

## 3. 执行演练

```bash
# 1) 真实集成测试（会执行迁移、写入并清理随机测试行）
POSTGRES_TEST_URL=postgres://health_skill_test:local-test-only@127.0.0.1:55432/health_skill_test npm test

# 2) 完整证据演练：种子数据 → 备份 → 恢复 → 迁移 → 对账 → 运行时启动 → 回切
POSTGRES_DRILL_URL=postgres://health_skill_test:local-test-only@127.0.0.1:55432/health_skill_migration_test npm run evidence:step22

# 3) 切换门禁评估（用演练生成的证据文件）
node scripts/migration-cutover-gate.js --evidence artifacts/step22/cutover-evidence.json
```

`evidence:step22` 会断言以下 15 项，任一失败即以非零退出码结束：

1. SQLite 源库按真实服务层写入（含草稿编辑、原子确认、幂等重放）
2. 一致性备份生成并通过 `PRAGMA integrity_check`
3. 备份恢复到新路径成功
4. 恢复副本与源库行数一致
5. 可销毁目标库 schema 重置
6. 迁移 dry-run 只校验源库
7. 迁移 `--apply` 三类数据计数一致
8. 迁移重复执行幂等（`alreadyPresent` 全等，`inserted` 全零）
9. 逐记录对账零差异
10. `DATABASE_BACKEND=postgres` 运行时启动并监听
11. 未认证请求 fail-closed 返回 401
12. 运行时确实读取 PostgreSQL 目标库
13. 优雅关闭后监听关闭且连接池已释放
14. 回切 `DATABASE_BACKEND=sqlite` 后服务可用且源库计数未变
15. 切换门禁按证据字段评估（安全审查未完成时保持 `BLOCKED`）

## 4. 产物

| 路径 | 内容 |
|---|---|
| `artifacts/step22/RUNTIME_EVIDENCE.json` | 15 项检查结果、计数、版本、门禁结论、边界说明 |
| `artifacts/step22/cutover-evidence.json` | 迁移切换门禁输入证据 |
| `artifacts/step22/CUTOVER_GATE_RESULT.json` | 门禁输出（决策与阻塞项） |
| `artifacts/step22/STEP22_FULL_TEST_OUTPUT.txt` | 真实 PostgreSQL 下的全量测试输出 |
| `artifacts/step22/source/`、`backup/` | 演练用 SQLite 源库、备份与恢复副本（含敏感结构示例，仅本地） |

## 5. 已知边界

- 演练只证明代码在隔离环境可完成迁移、对账、运行时启动与回切，**不构成正式验收**。
- 未覆盖：TLS、最小权限账号、秘密管理、备份加密、保留/销毁策略、负载与并发压测、灾备。
- 正式切换仍需停写窗口、运维 runbook、独立人员批准；`migration-cutover-gate` 在安全审查字段为 `false` 时保持关闭。
