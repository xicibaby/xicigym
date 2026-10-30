# 健康运动 Skill｜统一记录模块步骤 14：PostgreSQL 集成验证准备与适配器加固

状态：本地参考实现；自动化测试已运行。真实 PostgreSQL 集成测试仍需在提供 PostgreSQL 服务的环境中执行；尚未部署到生产环境。

## 本阶段新增

- `src/infrastructure/sqlite-backup.js`：使用 `node:sqlite` 的 backup API 生成一致性快照；备份后执行 `PRAGMA integrity_check` 和必需表结构检查；拒绝覆盖已有备份。
- 安全恢复：恢复前验证备份完整性，写入新路径，拒绝覆盖现有目标；通过同目录暂存文件和原子 no-overwrite 发布，失败时清理暂存文件。
- `src/maintenance.js`：数据库维护命令行入口。
- 迁移保护：如果数据库记录的迁移版本高于当前代码支持的最高版本，启动时拒绝继续，避免旧代码静默操作新版本数据库。
- SQLite `busy_timeout=5000`：降低短暂写锁竞争时立即失败的概率；这不是多实例生产级并发策略。

## 运行环境

需要 Node.js 22（本实现使用 `node:sqlite`，当前 Node 22 会显示实验性提示）。

```bash
npm test
npm start
```

## 数据库维护命令

检查数据库完整性：

```bash
npm run db:maintenance -- check ./health-records.sqlite
```

创建一致性备份（备份路径必须不存在）：

```bash
npm run db:maintenance -- backup ./health-records.sqlite ./backups/records-20261025.sqlite
```

恢复到新路径（目标必须不存在）：

```bash
npm run db:maintenance -- restore ./backups/records-20261025.sqlite ./health-records-restored.sqlite
```

恢复到正式数据库路径前：先停止服务；把现有数据库文件和相关 `-wal`、`-shm` 文件整体移到安全位置；完成恢复后检查数据与权限，再启动服务。工具不会覆盖已有目标，也不会自动删除旧数据。

## 当前测试结果

步骤 11 当前共 **58 项自动化测试通过，0 项失败**（Node.js 22.16.0）。新增测试覆盖：备份恢复后记录和历史保留、拒绝覆盖已有备份、拒绝覆盖恢复目标、损坏备份拒绝恢复、数据库完整性检查、未知更高迁移版本拒绝启动。

## 生产限制

1. 备份文件包含敏感健康数据，必须设置严格文件权限、加密静态存储、限制访问，并制定保留/销毁策略。当前代码不提供备份加密、云端复制、自动轮换或异地灾备。
2. 恢复流程要求写入新路径；没有在运行中的正式服务上执行切换或停机恢复。
3. SQLite 和进程内限流仍是本地参考实现；生产数据库、共享限流、真实身份提供方及部署尚未完成。
4. `node:sqlite` 在当前 Node 22 环境仍可能显示实验性警告；正式上线前应评估运行时支持策略。
5. 不要将此本地参考实现直接暴露到公网。


## 步骤 12：仓储契约与并发控制

- `src/infrastructure/record-repository-contract.js` 定义共享仓储端口，检查基础方法，并能强制要求生产仓储实现原子确认能力。
- 内存仓储现在执行 `expectedRevision` 乐观并发校验；同一版本的并发更新只允许一个成功。
- 内存幂等结果拒绝将同一个幂等键绑定到另一条记录。
- 新增仓储契约一致性测试与并发草稿编辑测试。
- 当前参考实现依旧使用 SQLite；尚未实现 PostgreSQL/托管数据库适配器，也没有进行多进程/多实例压测。

## 步骤 13：PostgreSQL 仓储适配器与迁移基线

- 新增 `src/infrastructure/postgres-record-repository.js`：实现共享仓储端口，使用参数化 SQL、乐观版本更新、事务历史快照及原子幂等确认。
- 新增 `src/infrastructure/postgres-migrations.js`：PostgreSQL 版本化迁移，使用事务级 advisory lock 避免多个实例同时初始化迁移；遇到高于代码支持范围的数据库版本时拒绝继续。
- 适配器接受 `pg` 兼容的 Pool 实例注入，不会自动替换现有 SQLite 启动路径。实际接入时需选择托管 PostgreSQL 服务并安装/配置驱动，例如 `npm install pg`，随后由部署工程创建 Pool 并传给 `PostgresRecordRepository.connect({ pool, migrate: true })`。
- `npm run test:postgres-adapter` 使用可控的 fake Pool 验证 SQL 调用顺序、事务提交/回滚、乐观锁冲突、幂等重放和迁移版本保护。

### 重要验证边界

本轮**没有连接真实 PostgreSQL 实例**，也没有执行生产数据库迁移、负载测试或灾难恢复演练。fake Pool 测试能验证适配器的预期控制流，但不能替代真实 PostgreSQL 集成测试。正式接入前必须在临时 PostgreSQL 实例中执行迁移、并发确认/更新、唯一约束竞争、JSONB 查询、连接池故障与恢复测试；还需配置 TLS、最小权限数据库账号、连接池上限、备份加密和恢复演练。


## 步骤 14 更新

本版本延续步骤 13 的统一记录模块基线，补充 PostgreSQL 适配器安全边界和真实数据库测试入口。详见 `POSTGRESQL_STEP14_GUIDE.md` 与 `STEP14_TEST_REPORT.md`。默认 `npm test` 包含真实 PostgreSQL 测试，但没有设置 `POSTGRES_TEST_URL` 时会将其标记为跳过；这不代表真实数据库通过。

## SQLite → PostgreSQL migration (Step 15)
See `SQLITE_TO_POSTGRES_MIGRATION_GUIDE.md`. Dry-run is the default; actual target writes require explicit `--apply`, a disposable/approved PostgreSQL target, and an externally installed `pg` package. This tool does not switch application traffic or support online dual-write.

## 步骤 18–20：CI 与验收前准备

- `.github/workflows/ci.yml`：在 CI 中启动 PostgreSQL 16 服务，运行真实数据库集成测试和全量测试。
- `test/postgres-real.integration.test.js`：默认拒绝未标记为 test/temp/sandbox/ci 的数据库名，降低误连生产库的风险；仅在明确审查后才可通过 `POSTGRES_TEST_ALLOW_NON_DISPOSABLE=1` 覆盖。
- `scripts/preacceptance-check.js`：执行 JS 语法与必需交付物检查，并可运行完整测试、生成验收前报告。
- `docs/release/CI_AND_STAGING_RUNBOOK.md`：CI / staging 数据库运行步骤。
- `docs/release/PREACCEPTANCE_CHECKLIST.md`：数据库迁移、备份恢复、安全、运行时与人工验收前清单。

执行：

```bash
npm run check:syntax
npm run preacceptance:check
```

验收前报告会写入 `artifacts/preacceptance/`。配置 `POSTGRES_TEST_URL` 或保留步骤 22 的 `artifacts/step22/RUNTIME_EVIDENCE.json` 后，检查器会依据真实 PostgreSQL 证据判断；但安全审查、CI/staging 记录和人工批准未完成前，`preacceptance:check` 仍按设计返回阻塞状态（退出码 2），这不是验收通过。


## Runtime database backend (step 21)

- Development defaults to SQLite (`DATABASE_BACKEND=sqlite`, `DATABASE_PATH=...`).
- Staging can select PostgreSQL with `DATABASE_BACKEND=postgres` and `POSTGRES_URL` injected from a secret manager.
- Production requires `DATABASE_BACKEND=postgres` and `POSTGRES_SSL=true`; TLS certificate validation remains enabled.
- PostgreSQL migrations are not automatically applied at service startup unless `POSTGRES_AUTO_MIGRATE=true` is explicitly set. Prefer a separately approved migration window and keep it `false` for normal deployment.
- `pg` is a declared runtime dependency; `package-lock.json` pins `pg@8.16.3` (generated in step 22).
- Runtime PostgreSQL integration **has** been executed in a local isolated environment (step 22); see the step 22 and step 23 sections below. Formal acceptance is still blocked on security review, CI/staging records and human sign-off.


## Step 22: real PostgreSQL drill evidence (local isolated instance)

Step 22 closes the "adapter exists but never ran against a real database" gap **in a local isolated environment only**:

- `npm install` ran in a network-enabled environment, so `package-lock.json` now pins `pg@8.16.3` and its transitive dependencies.
- `npm test` ran against a real PostgreSQL 16.14 instance: **92 tests, 92 passed, 0 failed, 0 skipped** (the real integration test is no longer skipped).
- `npm run evidence:step22` performs a repeatable drill: seed SQLite through the service layer → consistent backup → restore to a new path → reset a disposable PostgreSQL target → migration dry-run + `--apply` + idempotent replay → row-level reconciliation (zero diff) → boot the HTTP runtime with `DATABASE_BACKEND=postgres` → graceful shutdown → roll back to SQLite → evaluate the cutover gate.
- Evidence lives in `artifacts/step22/`. Reproduction steps: `docs/release/REAL_POSTGRES_DRILL_GUIDE.md`.

Boundaries that remain open:

- No TLS, least-privilege account, secret-management, backup-encryption or retention review has been completed; the cutover gate therefore stays **BLOCKED** on security review.
- Nothing ran on a CI platform or a real staging environment; the local drill is not formal acceptance and no production traffic was switched.
- `STEP22_REAL_POSTGRES_REPORT.md` records the actual commands, versions and results.


## Step 23: runtime probes, metrics and graceful shutdown

- `GET /healthz` — liveness; never touches the database, no authentication.
- `GET /readyz` — readiness; bounded dependency check (connection + supported schema version) for SQLite/PostgreSQL, returns 503 with a reason code on failure.
- `GET /metrics` — Prometheus text exposition of aggregate values only: request counters by method/status, in-flight requests, readiness gauge, schema version and uptime.
- `createGracefulShutdown` in `src/http/shutdown.js`: idempotent stop → drain in-flight requests → bounded timeout with forced socket close → close database resources. Errors are reported (redacted), not thrown.
- New settings: `SHUTDOWN_TIMEOUT_MS` (100–120000, default 10000), `READINESS_TIMEOUT_MS` (100–30000, default 2000).
- `npm run evidence:step23` runs 12 assertions against real SQLite and PostgreSQL runtimes, including a simulated database outage (`/readyz` 503 while `/healthz` stays 200). Evidence: `artifacts/step23/`.
- 118 tests pass (0 skipped) with real PostgreSQL; `STEP23_RUNTIME_OBSERVABILITY_REPORT.md` has details.

Boundaries: probes are intentionally unauthenticated, so restrict them to a private network or gateway allow-list. Metrics are single-process only (no cross-instance aggregation); alerting, dashboards, tracing and load testing are not implemented. Security review materials are drafted in `docs/release/SECURITY_REVIEW_PREP.md` — the cutover gate still stays **BLOCKED** until real reviewers sign off.


## Step 24: external acceptance evidence — executable paths and a fail-closed gate

Step 24 turns the four remaining external blockers into repeatable, auditable workflows. It does **not** fabricate the external evidence itself.

| Area | Command | What it produces |
|---|---|---|
| CI (local equivalent) | `npm run evidence:ci-local` | parses/hardens `ci.yml` (13 checks), replays `check:syntax` + `npm test` locally (16 assertions); explicitly `ciPlatformRecord=false` |
| CI (real record) | `npm run archive:ci-record -- --run-url … --commit … --tests-total … --tests-passed …` | `artifacts/ci/CI_PLATFORM_RECORD.json`; rejects placeholders/failed counts |
| staging rehearsal | `npm run evidence:staging-rehearsal` (local) / `node scripts/staging-rehearsal.mjs --environment=staging` (real) | 9 assertions; `kind=local-rehearsal` vs `kind=staging` strictly separated |
| security controls | `npm run security:baseline` (+ `npm run security:db-privileges`) | 26 technical-control checks + 21 least-privilege checks; `humanReviewSigned=false` |
| acceptance gate | `npm run gate:acceptance` | aggregates CI platform record, staging drill, human security review, four-party approvals and the cutover gate; 30-day freshness, placeholder/self-approval rejection |

Production config now requires `sslmode=verify-full` (or `verify-ca`) in `POSTGRES_URL` in addition to `POSTGRES_SSL=true`. CI installs with `npm ci` from the committed lockfile.

Current gate verdict: **BLOCKED with 5 precise items** — real CI platform record, real staging evidence (`kind=staging`), human-signed security review, product/security/operations + independent approvals, cutover gate eligibility. `npm run preacceptance:check` now derives its blockers from this gate instead of hand-written text. 128 tests pass on real PostgreSQL; review notes per area are in `STEP24_REVIEW_LOG.md`.


## Step 25: human-action navigator and action pack

The remaining five blockers are irreducible human/external steps. Step 25 makes them executable instead of abstract:

- `npm run action:next` reads the gate result and prints the **next** action card: owner, estimate, why blocked, exact commands, required evidence file, verification command, manual. `--all` lists all five; `--json` for automation.
- `行动包/` contains five action cards plus fill-in templates for the human security review and the four-party approval record.
- `gate:acceptance --evidence-dir <dir>` evaluates a handoff bundle or rehearsal copy without touching the real `artifacts/` tree.
- The staging drill gained a **dry-run mode** (`STAGING_DRY_RUN_ALLOW_LOCALHOST=1`): it exercises the staging code path against a local disposable PostgreSQL and local HTTP probes, writes `kind=staging-dry-run`, and the gate explicitly rejects that kind — a rehearsal can never masquerade as staging evidence.
- Verified this step: staging dry-run 6/6 assertions pass; gate flips to `READY_FOR_MANUAL_FINAL_REVIEW` in an isolated DEMO evidence bundle (data marked DEMO, never shipped); the real gate still reports `BLOCKED / 5`.

Five human actions remain: real CI run + archive, real staging drill, human security sign-off, four-party approvals, cutover gate recomputation. See `STEP25_HUMAN_ACTION_REPORT.md` and `行动包/README_真人动作行动包.md`.

## Step 26: data safety and operations hardening

- Encrypted backups: `src/infrastructure/backup-crypto.js` (AES-256-GCM, `HSB1` container, header authenticated as AAD). SQLite `db:maintenance backup/restore/check` transparently encrypts/decrypts when `BACKUP_ENCRYPTION_KEY` (32-byte base64) or `BACKUP_PASSPHRASE_FILE` is present.
- PostgreSQL logical backup/restore: `src/infrastructure/postgres-backup.js` + `src/postgres-maintenance.js` (`backup/check/restore`). Restore requires an empty target with matching migration versions, re-reads rows and re-checks the SHA-256 before commit, and rolls back on any mismatch.
- Load smoke: `npm run load:smoke` fires 200 HTTP requests at concurrency 20 against a real PostgreSQL runtime, records p50/p90/p95/p99 and verifies the rate limiter returns 429 + Retry-After. It is a smoke test, not a capacity test.
- Alerting: `ops/prometheus/alerts.yml` ships four starting rules (readiness down, 5xx ratio, schema version missing, 429 ratio).
- CI hardening: dependency audit (`npm audit --omit=dev --audit-level=high`), delivery checksum verification, and non-blocking acceptance-gate evidence generation.
- Verified: **136 tests pass (0 skipped)**, `npm run evidence:step26` 16/16 assertions, load smoke 200/200 with p95 36 ms. See `STEP26_DATA_SAFETY_REPORT.md`.
- Boundaries: logical backups are for small/medium disaster-recovery drills (production should still use pg_dump/physical/vendor backups); encryption keys are ephemeral in the drill and must be managed by a secret manager in production; alert thresholds need tuning in the real monitoring stack.
