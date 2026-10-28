# 步骤 22：真实 PostgreSQL 隔离演练报告

状态：**本地隔离环境演练完成；正式验收门禁仍保持关闭。** 本报告记录实际执行的命令与结果，不声明生产部署、正式 staging 演练或人工验收已经完成。
演练日期：2026-10-28（本机时钟）；代码版本 `package.json` 0.22.0。

## 1. 本轮目标

步骤 21 结束时，代码已支持 `DATABASE_BACKEND=sqlite|postgres`，但交接索引列出的四条阻塞全部停留在"未执行"：
真实 PostgreSQL 集成测试未跑、迁移与逐记录对账未做、备份恢复/回滚演练未做、TLS/最小权限/人工批准未完成。

步骤 22 的定位是：**把前三类"未执行"变成"已执行（本地隔离环境）"，并如实保留未完成部分。** 不因演练通过而降低验收标准。

## 2. 实际环境

| 项 | 实测值 |
|---|---|
| Node.js | v24.21.0（CI 目标仍为 22） |
| PostgreSQL | 16.14（便携版二进制，直接从 npm registry 的 `@embedded-postgres/windows-x64` 16.14.0 包解包） |
| 监听地址 | `127.0.0.1:55432`，仅回环，非生产网络 |
| 数据库 | `health_skill_test`、`health_skill_migration_test`（可销毁，名称通过安全守卫校验） |
| 依赖锁 | 已执行 `npm install`，生成 `package-lock.json`（`pg@8.16.3` 及 13 个传递依赖） |
| Docker / psql | 本机无可用 Docker 守护进程；便携版只提供 `initdb`/`postgres` 服务端二进制，建库通过 Node.js + `pg` 完成 |

## 3. 执行记录

### 3.1 依赖安装（解除"无锁文件"阻塞）

```bash
npm install --ignore-scripts --no-audit --no-fund
# added 14 packages in 6s -> package-lock.json
```

### 3.2 真实 PostgreSQL 全量测试

```bash
POSTGRES_TEST_URL=postgres://…@127.0.0.1:55432/health_skill_test node --test
```

结果：**92 项 / 92 通过 / 0 失败 / 0 跳过**。其中真实集成测试用例 `REAL PostgreSQL: migrations, JSONB, optimistic locking, history, idempotency and ownership guards` 实际执行（非跳过）。
完整输出：`artifacts/step22/STEP22_FULL_TEST_OUTPUT.txt`。

### 3.3 迁移 / 对账 / 备份恢复 / 运行时 / 回切演练

```bash
POSTGRES_DRILL_URL=postgres://…@127.0.0.1:55432/health_skill_migration_test npm run evidence:step22
```

15 项断言全部通过：

| # | 断言 | 结果 |
|---:|---|---|
| 1 | SQLite 源库经真实服务层写入（草稿编辑 + 原子确认 + 幂等重放） | records=3, revisions=6, idempotency=2 |
| 2 | 一致性备份并 `PRAGMA integrity_check` | ok，36864 字节，耗时 8 ms |
| 3 | 备份恢复到新路径 | schemaVersion=1，integrity=ok，耗时 6 ms |
| 4 | 恢复副本与源库行数一致 | 一致 |
| 5 | 可销毁目标库 schema 重置 | 通过 |
| 6 | 迁移 dry-run 只校验源库 | 通过 |
| 7 | 迁移 `--apply` 三类数据计数一致 | 3/6/2 → 3/6/2 |
| 8 | 迁移重复执行幂等 | inserted 全 0，alreadyPresent 3/6/2 |
| 9 | 逐记录对账零差异 | `mismatchCount=0` |
| 10 | `DATABASE_BACKEND=postgres` 运行时启动 | 监听成功 |
| 11 | 未认证请求 fail-closed | HTTP 401 |
| 12 | 运行时确实读取 PostgreSQL 目标库 | count=3 |
| 13 | 优雅关闭 | 监听关闭 + 连接池已释放 |
| 14 | 回切 `DATABASE_BACKEND=sqlite` | 服务可用，源库计数未变 |
| 15 | 切换门禁评估 | `BLOCKED`，仅剩安全审查 1 项 |

证据文件：`artifacts/step22/RUNTIME_EVIDENCE.json`、`cutover-evidence.json`、`CUTOVER_GATE_RESULT.json`。
复现步骤：`docs/release/REAL_POSTGRES_DRILL_GUIDE.md`。

### 3.4 切换门禁

```bash
node scripts/migration-cutover-gate.js --evidence artifacts/step22/cutover-evidence.json
```

输出：`decision=BLOCKED`，阻塞项为"数据库权限、TLS 与凭据审查未通过"（`securityReviewPassed=false`）。
这是**预期且如实**的结果：步骤 22 没有伪造安全审查字段来让门禁变绿。

### 3.5 验收前检查器更新

`scripts/preacceptance-check.js` 新增读取 `artifacts/step22/RUNTIME_EVIDENCE.json`：

- 有真实 PostgreSQL 演练证据时，不再把"未配置 POSTGRES_TEST_URL"计为阻塞；
- 缺少证据或证据断言失败时按 fail-closed 记为 FAIL；
- 仍固定追加"安全审查未完成""CI/staging 与人工批准缺失"两条阻塞。

因此 `preacceptance:check` 仍返回退出码 2、判定 `NOT_READY_FOR_ACCEPTANCE`——这是设计预期。

### 3.6 Node.js 24 兼容性修复

步骤 20–21 的检查器只在 Node 22 上验证过。本次在 Node 24.21.0 上复跑时发现两处兼容性问题，已修复：

1. **测试 reporter 变化**：`node --test` 在 stdout 被管道捕获时，Node 22 输出 TAP，Node 24 输出 `spec`；旧解析器只认 TAP 的 `# tests N`，导致把已通过的测试判成 `parsed: false`。现改为显式指定 `--test-reporter=tap`，并让解析器同时兼容 `#` 与 `ℹ` 两种前缀。
2. 解析器容忍 180 秒超时（原 120 秒），避免较慢环境下误判超时。

修复后 `node scripts/preacceptance-check.js` 输出 `localChecksPass=true`、`testSummary={tests:92, passed:92, failed:0, skipped:0}`，退出码仍为 2（阻塞项未清零），符合 fail-closed 设计。


## 4. 本轮解除 / 未解除的阻塞

| 步骤 21 阻塞 | 步骤 22 状态 | 依据 |
|---|---|---|
| ① 真实 PostgreSQL 集成测试未执行 | **已解除（本地隔离）** | 92/92 通过、0 跳过 |
| ② 迁移与逐记录对账未执行 | **已解除（本地隔离）** | 迁移 3/6/2、重放幂等、零差异 |
| ③ 备份恢复/回滚演练未执行 | **部分解除** | 备份/恢复/回切已演练；演练耗时已记录；生产停写窗口与责任人未定 |
| ④ TLS/最小权限/秘密管理审查、人工签署 | **未解除** | 门禁仍 `BLOCKED` |
| 附：无锁文件 | **已解除** | `package-lock.json` 已生成 |
| 附：CI 平台记录 | **未解除** | 本机无法运行 GitHub Actions |

## 5. 边界与已知限制（必须随报告一起传播）

1. 演练在**本地隔离**便携版 PostgreSQL 上进行，不是 staging、不是生产，也不构成 CI 平台记录。
2. 未做 TLS、最小权限账号、秘密管理、备份加密、保留与销毁策略审查。
3. 无健康检查/就绪探针端点，无指标与告警；生产可观测性未实现。
4. 未做负载/并发压测与灾备演练；SQLite 侧仍为单进程参考实现。
5. 演练备份文件含敏感结构示例，仅存于本地工作区，不应外发。
6. 不可把本报告解释为"验收通过""可生产上线"或"PostgreSQL 已在生产运行"。

## 6. 下一步建议（步骤 23 候选）

1. 在 CI 平台运行 `.github/workflows/ci.yml` 并归档真实 PostgreSQL 16 通过记录。
2. 增加 `/healthz`、`/readyz` 探针与关键指标（启动探测、迁移版本、连接池状态），并补测试。
3. 制定最小权限账号与 TLS 配置文档，做一次安全/运维联合审查以关闭门禁最后一项。
4. 在正式 staging 复跑 `evidence:step22` 并归档，交由产品/安全/运维签署。
