# 步骤 23 基线与交接说明

## 当前基线

步骤 23 在步骤 22（真实 PostgreSQL 隔离演练）基础上，补齐**运行时健康探针、指标与优雅关闭**：

- 新增 `src/http/probe-endpoints.js`：`/healthz`（存活）、`/readyz`（就绪，有界超时）、`/metrics`（Prometheus 文本格式）。
- 新增 `src/observability/metrics.js`：零依赖指标注册表，固定指标清单，标签转义与确定性渲染。
- 新增 `src/http/shutdown.js`：幂等优雅关闭，停监听 → 等请求 → 超时强制断开 → 关资源；错误上报并脱敏。
- 三类仓储适配器新增 `checkReadiness()`；契约新增 `supportsReadiness` 能力位（不扩大必需数据方法）。
- 新增配置 `SHUTDOWN_TIMEOUT_MS`（默认 10000）、`READINESS_TIMEOUT_MS`（默认 2000）。
- 新增 `src/version.js`（`APP_VERSION`），测试强制与 `package.json` 一致。
- `openapi.yaml` 增补三个探针契约；`server.js` 组装指标、探针与关闭器，监听失败回滚数据库资源。
- 新增测试 26 项（共 118 项）；新增 `npm run evidence:step23` 与 `artifacts/step23/` 证据。
- 新增 `docs/release/SECURITY_REVIEW_PREP.md`：为关闭切换门禁最后一项准备审查材料（草稿，非审查结论）。

## 验证记录（实测）

- Node.js v24.21.0；PostgreSQL 16.14（本地便携版，127.0.0.1:55432）。
- `POSTGRES_TEST_URL=… node --test`：**118 项 / 118 通过 / 0 失败 / 0 跳过**（真实集成测试实际执行）。
- `POSTGRES_DRILL_URL=… npm run evidence:step23`：**12 项断言全部通过**（输出 `STEP 23 EVIDENCE: ALL CHECKS PASSED`）。
- `npm run evidence:step22`：15 项断言仍全部通过（回归）。
- `npm run check:syntax`：通过。
- `npm run preacceptance:check`：退出码 2、`NOT_READY_FOR_ACCEPTANCE`（预期；剩余阻塞为安全审查、CI/staging 记录、人工批准）。
- `npm run checksums:verify`：交付物 SHA256 全部通过。

## 重要边界

1. 指标为**单进程内存聚合**；多实例需网关/共享指标系统汇总。
2. 无告警规则、仪表盘、分布式追踪、日志聚合、负载压测。
3. 探针端点**无鉴权**，必须置于私有网络或网关白名单后；暴露公网属部署错误。
4. 本轮证据来自本地隔离运行时，不是 staging/生产，不构成验收通过；切换门禁最后一项目前仍未关闭。

## 下一步（步骤 24 候选）

1. CI 平台执行 `.github/workflows/ci.yml`：归档真实 PostgreSQL + 118 测试通过记录。
2. 按 `SECURITY_REVIEW_PREP.md` 完成 TLS/最小权限/秘密管理联合审查，关闭切换门禁最后一项。
3. 生产化补充：多实例共享指标、告警规则与仪表盘、压测与容量评估、日志聚合与追踪。
4. 正式 staging 复跑 `evidence:step22` + `evidence:step23`，取得产品/安全/运维签署与独立人员批准。
