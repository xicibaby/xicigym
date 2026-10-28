# CI 与 staging 数据库演练说明（步骤 18–19）

## 自动化 CI

`.github/workflows/ci.yml` 在 GitHub Actions 中启动一次性 PostgreSQL 16 服务，安装项目声明的 `pg` 驱动，然后运行 JavaScript 语法检查和完整测试套件。CI 使用专用临时数据库，不应改为生产连接串。

## 本地真实 PostgreSQL 演练

需要 Docker Compose、Node.js 22 和可安装的 `pg` 驱动：

```bash
docker compose -f docker-compose.postgres-test.yml up -d --wait
npm install --no-save pg@8.16.3
POSTGRES_TEST_URL=postgres://health_skill_test:local-test-only@127.0.0.1:55432/health_skill_test npm run test:postgres-integration
POSTGRES_TEST_URL=postgres://health_skill_test:local-test-only@127.0.0.1:55432/health_skill_test npm test
docker compose -f docker-compose.postgres-test.yml down -v
```

集成测试会执行数据库迁移，并写入/删除以随机 ID 标记的测试记录。仅使用一次性、可销毁的测试库。测试默认拒绝数据库名没有 `test`、`temp`、`sandbox` 或 `ci` 标记的连接串；只有完成独立风险审查后才可显式设置 `POSTGRES_TEST_ALLOW_NON_DISPOSABLE=1`。该变量不能用于常规生产验证。

## 验收前检查

```bash
npm run check:syntax
npm run preacceptance:check
```

`preacceptance:check` 生成 `artifacts/preacceptance/PREACCEPTANCE_REPORT.md`、`PREACCEPTANCE_RESULT.json` 和自动化测试输出。若真实 PostgreSQL 环境缺失或仍有外部证据未完成，命令返回 `2` 并写出阻塞清单；这是预期的 fail-closed 行为，不是“验收通过”。

## PostgreSQL 运行时配置

开发环境默认 SQLite。要在 staging 启用 PostgreSQL，请设置 `DATABASE_BACKEND=postgres`、通过秘密管理器注入 `POSTGRES_URL`，并设置 `POSTGRES_SSL=true`（生产环境强制要求）。数据库迁移默认不随服务启动自动执行；先在变更窗口执行 `npm run db:migrate:postgres`，确认迁移结果后再启动 API。生产启动使用 PostgreSQL TLS 证书校验，不应设置为忽略证书错误。

示例环境变量（禁止把真实凭据提交到仓库）：

```bash
DATABASE_BACKEND=postgres
POSTGRES_URL=<由秘密管理器注入的连接串>
POSTGRES_SSL=true
POSTGRES_AUTO_MIGRATE=false
```

## 重要边界

CI 工作流文件仅在实际 CI 平台执行后才能成为 CI 通过证据。运行时已实现 SQLite/PostgreSQL 后端选择，但真实 PostgreSQL 集成测试、迁移对账、备份恢复、安全审查和人工批准仍需实际环境证据；不可仅凭适配器或模拟测试宣称验收通过。

## 步骤 22：本地隔离 PostgreSQL 演练结果

步骤 22 在没有 Docker 的环境下用便携版 PostgreSQL 16.14 完成了真实演练，复现步骤见 `docs/release/REAL_POSTGRES_DRILL_GUIDE.md`，结果见 `STEP22_REAL_POSTGRES_REPORT.md` 与 `artifacts/step22/`：

- `npm test` 在真实 PostgreSQL 下 92 项全部通过、0 跳过。
- `npm run evidence:step22` 的 15 项断言全部通过（备份/恢复、迁移与重放、零差异对账、运行时启动与优雅关闭、回切 SQLite）。
- 切换门禁仍为 `BLOCKED`：只剩 TLS/最小权限/秘密管理审查这一项未完成，且仍需 CI/staging 记录与人工批准。

该结果只属于隔离演练，不能替代 CI 记录、正式 staging 演练或生产切换批准。

## 步骤 23：探针、指标与优雅关闭（staging 必读）

### 探针与指标端点

| 端点 | 用途 | 鉴权 | 说明 |
|---|---|---|---|
| `GET /healthz` | 存活探针 | 无 | 只证明进程能响应，不查数据库；不要用作就绪判断 |
| `GET /readyz` | 就绪探针 | 无 | 检查数据库连通 + schema 版本，失败返回 503 与原因码（`postgres_unavailable` 等） |
| `GET /metrics` | Prometheus 指标 | 无 | 聚合值：请求计数、在途请求、就绪状态、schema 版本、运行时长 |

部署要求：

1. 三个端点必须限制在**私有网络或网关白名单**后，禁止公网可达；它们按设计不鉴权。
2. 编排平台（K8s/ECS 等）用 `/readyz` 决定是否摘流量，用 `/healthz` 决定是否重启容器；就绪探测超时建议 ≥ `READINESS_TIMEOUT_MS` + 余量。
3. 优雅关闭依赖编排平台发送 SIGTERM 并给予 ≥ `SHUTDOWN_TIMEOUT_MS` 的宽限期（默认 10s）；服务会先停监听、等在途请求、再关数据库，超时则强制断开。
4. 指标为**单进程内存聚合**，多实例部署需由 Prometheus 逐实例抓取后聚合；不要假设跨实例计数一致。

### staging 冒烟命令

```bash
BASE=https://<staging-host>
curl -fsS "$BASE/healthz"            # 期望 200 {"status":"ok",...}
curl -fsS "$BASE/readyz"             # 期望 200 {"status":"ready","backend":"postgres","schemaVersion":1}
curl -fsS "$BASE/metrics" | head -40 # 期望 Prometheus 文本格式
```

数据库维护窗口前后各抓一次 `/readyz`，确认切换期间返回 503 而不是超时挂死。

### 关闭验证

```bash
# 在 staging 触发一次滚动重启，确认：
# 1) 新请求被导流到其他实例；2) 在途请求完成；3) 进程在 SHUTDOWN_TIMEOUT_MS 内退出
```

## 步骤 23 本地验证结果

- `npm test`：118 项、118 通过、0 失败、0 跳过（真实 PostgreSQL 16.14）。
- `npm run evidence:step23`：12 项断言全部通过（探针、指标、数据库故障降级、优雅关闭）。
- `npm run evidence:step22`：15 项断言回归通过。
- 细节见 `STEP23_RUNTIME_OBSERVABILITY_REPORT.md` 与 `artifacts/step23/`。以上均为本地隔离环境结果，不构成 staging 或验收通过。


