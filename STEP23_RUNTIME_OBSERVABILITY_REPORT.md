# 步骤 23：运行时健康探针、指标与优雅关闭报告

状态：**本地隔离环境完成；正式验收门禁仍关闭。** 本报告只记录实际实现与实测结果，不声明生产部署、staging 演练或人工验收已完成。

## 1. 本轮目标

步骤 22 结束时，验收前清单还剩一条纯代码项未做：**"无健康检查/就绪探针端点、无指标告警"**。步骤 23 把它拆成可本地完成的部分并落地：

1. `/healthz` 存活探针、`/readyz` 就绪探针、`/metrics` Prometheus 指标；
2. 三种仓储适配器的就绪检查（SQLite / PostgreSQL / 内存），版本与错误原因码；
3. 可幂等、带超时兜底的优雅关闭（先停监听 → 等在途请求 → 关数据库）；
4. 配置项 `SHUTDOWN_TIMEOUT_MS`、`READINESS_TIMEOUT_MS`；
5. 补测试、OpenAPI、文档与可复核证据。

## 2. 实现内容

| 文件 | 作用 |
|---|---|
| `src/http/probe-endpoints.js` | `/healthz`（不查库）、`/readyz`（有界超时依赖检查）、`/metrics`；无鉴权、支持 GET/HEAD、其余方法 405 |
| `src/observability/metrics.js` | 零依赖指标注册表 + Prometheus 文本格式渲染，标签转义、名称校验、确定性排序 |
| `src/http/shutdown.js` | 幂等优雅关闭：停监听 → 空闲连接清扫 → 在途请求等待 → 超时强制断开 → 关闭资源；错误只上报不外抛、凭据脱敏 |
| `src/infrastructure/sqlite-record-repository.js` | `checkReadiness()`：`SELECT 1` + schema 版本范围检查 |
| `src/infrastructure/postgres-record-repository.js` | `checkReadiness()`：`SELECT 1` + `schema_migrations` 版本范围检查，失败只回原因码 |
| `src/infrastructure/in-memory-record-repository.js` | `checkReadiness()` 占位实现（探针一致性） |
| `src/infrastructure/record-repository-contract.js` | `inspectRecordRepository` 新增 `supportsReadiness`（不扩大必需数据方法集） |
| `src/server.js` | 组装指标/探针/关闭器；监听失败时回滚数据库资源；信号处理等待关闭结果 |
| `src/config/runtime-config.js` | 新增 `shutdownTimeoutMs`（100–120000，默认 10000）、`readinessTimeoutMs`（100–30000，默认 2000） |
| `src/version.js` | `APP_VERSION` 单一来源，测试强制与 `package.json` 一致 |
| `openapi.yaml` | 新增 `/healthz`、`/readyz`、`/metrics` 契约（`security: []`） |

指标清单（全部为聚合值，不含记录内容、用户标识或连接串）：

```
health_skill_http_requests_total{method,status}  counter
health_skill_http_in_flight_requests             gauge
health_skill_ready                               gauge   （0/1，最近一次就绪探测结果）
health_skill_db_schema_version                   gauge
health_skill_uptime_seconds                      gauge
```

## 3. 实测验证

### 3.1 自动化测试

```bash
POSTGRES_TEST_URL=postgres://…@127.0.0.1:55432/health_skill_test node --test
```

结果：**118 项 / 118 通过 / 0 失败 / 0 跳过**（步骤 22 为 92 项，本轮新增 26 项；真实 PostgreSQL 集成测试仍然实际执行）。

新增测试文件：`test/health-probes.test.js`、`test/readiness.test.js`、`test/graceful-shutdown.test.js`、`test/metrics.test.js`、`test/version.test.js`；`test/runtime-config.test.js` 增补超时配置断言。

### 3.2 运行时生命周期证据

```bash
POSTGRES_DRILL_URL=postgres://…@127.0.0.1:55432/health_skill_migration_test npm run evidence:step23
```

**12 项断言全部通过**：

| # | 断言（证据中的 check 名） | 结果 |
|---:|---|---|
| 1 | `runtime-sqlite-listening`：SQLite 运行时启动并监听 | 通过，版本 0.23.0 |
| 2 | `healthz-liveness`：`/healthz` 无需鉴权、不触发数据库检查 | 200，`version=0.23.0` |
| 3 | `readyz-sqlite-ready`：`/readyz` 报告 backend/schemaVersion/latency | 200，`backend=sqlite`，`schemaVersion=1` |
| 4 | `record-api-still-fails-closed`：记录 API 仍 fail-closed | 401 |
| 5 | `probe-head-and-404`：HEAD 探针与未知路径 | HEAD 200、未知路径 404 |
| 6 | `metrics-exposition`：`/metrics` 暴露计数/在途/就绪/运行时长且无敏感信息 | 通过，`leaks=false` |
| 7 | `graceful-shutdown-sqlite`：优雅关闭（SQLite） | `closed=true`、`timedOut=false`、幂等、关闭后请求失败 |
| 8 | `readyz-postgres-ready`：`/readyz` 对接真实 PostgreSQL | 200，`backend=postgres`，`schemaVersion=1` |
| 9 | `healthz-postgres-liveness`：PG 后端下存活探针 | 200 |
| 10 | `readiness-detects-database-outage`：模拟数据库外泄故障 | `/readyz` 503（`postgres_unavailable`），`/healthz` 仍 200 |
| 11 | `metrics-readiness-gauge-drops`：就绪指标随故障下降 | `health_skill_ready 0` |
| 12 | `graceful-shutdown-postgres-after-outage`：故障后仍能优雅关闭 | `closed=true`、资源关闭失败 0 |

"无敏感信息泄漏"作为断言 6 的一部分校验（指标文本中不出现连接串、密码、用户标识或记录内容）。

证据文件：`artifacts/step23/RUNTIME_LIFECYCLE_EVIDENCE.json`；完整输出：`artifacts/step23/STEP23_EVIDENCE_OUTPUT.txt`。

### 3.3 回归验证

- `npm run evidence:step22`：15 项断言仍全部通过（未被本轮运行时改动破坏）。
- `npm run check:syntax`：通过（含新增 `.js`/`.mjs` 文件）。
- `npm run preacceptance:check`：退出码 2、`NOT_READY_FOR_ACCEPTANCE`（预期，剩余阻塞未清零）。

## 4. 阻塞变化

| 事项 | 步骤 22 | 步骤 23 |
|---|---|---|
| 健康检查/就绪探针 | 缺失 | **已实现并实测**（含数据库故障场景） |
| 指标端点 | 缺失 | **已实现并实测**（Prometheus 文本格式） |
| 优雅关闭 | 有雏形但不返回结果、无超时兜底 | **已硬化并测试**（幂等、超时强制断开、资源错误上报） |
| TLS/最小权限/秘密审查 | 未完成 | 未完成（门禁仍 `BLOCKED`）→ 已准备审查材料 `docs/release/SECURITY_REVIEW_PREP.md` |
| CI/staging 记录与人工签署 | 未完成 | 未完成 |

## 5. 已知限制（必须随报告传播）

1. 指标是**单进程内存聚合**；多实例部署需网关或共享指标系统汇总，当前不解决跨实例一致性。
2. 未实现告警规则、仪表盘、分布式追踪、日志聚合。
3. `/healthz`、`/readyz`、`/metrics` **按设计不鉴权**，必须通过私有网络或网关白名单限制访问；暴露到公网属于部署错误。
4. 未做负载/并发压测；SQLite 侧仍是单进程参考实现。
5. 本轮证据来自本地隔离运行时，不是 staging/生产，不构成验收通过。

## 6. 下一步建议（步骤 24 候选）

1. 在 CI 平台执行 `.github/workflows/ci.yml` 并归档真实 PostgreSQL + 118 测试通过记录。
2. 按 `SECURITY_REVIEW_PREP.md` 完成 TLS/最小权限/秘密管理联合审查，关闭切换门禁最后一项。
3. 若面向生产：补多实例共享指标、告警规则、仪表盘与压测方案。
4. 在正式 staging 复跑 `evidence:step22` + `evidence:step23`，取得签署与独立批准。
