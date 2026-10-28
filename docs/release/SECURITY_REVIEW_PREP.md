# 安全/运维审查准备材料（步骤 23 草稿）

> 状态：**准备材料，不是审查结论，也不是审查通过声明。** 本文档列出关闭迁移切换门禁最后一项
> （`securityReviewPassed`）所需的材料、待确认项与签署栏。审查必须由真实的安全/运维负责人完成；
> 代码或 AI 不得自行把该项置为 `true`。

## 1. 审查范围

| # | 范围 | 证据来源 | 待确认 |
|---:|---|---|---|
| 1 | 数据库 TLS 与证书校验 | `src/server.js`（`ssl: { rejectUnauthorized: true }`）、`src/config/runtime-config.js`（生产强制 `POSTGRES_SSL=true`） | 托管实例是否强制 TLS；`sslmode`/CA 配置；证书轮换流程 |
| 2 | 最小权限数据库账号 | `docs/release/PREACCEPTANCE_CHECKLIST.md` D 节 | 应用账号仅 INSERT/UPDATE/SELECT/DELETE；迁移账号独立且仅在变更窗口使用；对账账号只读 |
| 3 | 秘密管理 | `.env.example`、`docs/release/CI_AND_STAGING_RUNBOOK.md` | `POSTGRES_URL` 由秘密管理器注入；不写入镜像/仓库/日志；轮换与泄漏处置流程 |
| 4 | 探针与指标暴露面 | `src/http/probe-endpoints.js`、`openapi.yaml` | `/healthz`、`/readyz`、`/metrics` 无鉴权，必须限制在私有网络/网关白名单；不得公网可达 |
| 5 | 日志与错误脱敏 | `src/http/shutdown.js`（连接串脱敏）、`src/server.js`（启动错误只给原因码） | 应用日志不含健康数据明文、令牌、连接串；日志平台访问控制 |
| 6 | 备份加密与保留 | `src/infrastructure/sqlite-backup.js`、`docs/release/REAL_POSTGRES_DRILL_GUIDE.md` | 备份文件权限；静态加密；异地/多副本；保留期限与销毁流程 |
| 7 | 身份与访问控制 | `src/http/oidc-bearer-auth.js`、`src/http/security.js` | OIDC issuer/audience/JWKS 与真实提供方一致；CORS 精确白名单；网关共享限流 |
| 8 | 敏感健康数据合规 | 全项目 | 数据分类、访问审计、导出与删除流程、保留期限 |

## 2. 建议的数据库账号划分（示例，需 DBA 按实际实例调整）

```sql
-- 应用账号：只做行级读写，不建表、不改 schema、不删表
GRANT CONNECT ON DATABASE <db> TO <app_role>;
GRANT USAGE ON SCHEMA public TO <app_role>;
GRANT SELECT, INSERT, UPDATE, DELETE ON records, record_revisions, idempotency_results TO <app_role>;
-- 就绪探针需要读取迁移版本
GRANT SELECT ON schema_migrations TO <app_role>;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;  -- 防止任何账号在 public 建对象

-- 迁移账号：仅在受控变更窗口临时授予 CREATE/ALTER，迁移后回收
-- 对账账号：只读，仅 SELECT 三张表与 schema_migrations
GRANT SELECT ON records, record_revisions, idempotency_results, schema_migrations TO <reconcile_role>;
```

上述权限可用 `npm run security:db-privileges`（`POSTGRES_APP_URL` 指向应用角色）自动核验：
非超管、无 CREATEDB/CREATEROLE/BYPASSRLS、不拥有表、DDL/TRUNCATE 被 PostgreSQL 拒绝。

注意：迁移执行 `pg_advisory_xact_lock`，迁移账号需要能执行该函数（PostgreSQL 内置权限即可），不需要超级用户。

## 3. TLS 参考配置

```
DATABASE_BACKEND=postgres
POSTGRES_URL=postgres://<app_role>:<secret>@<host>:5432/<db>?sslmode=verify-full
POSTGRES_SSL=true
```

- 生产环境 `POSTGRES_SSL=true` 已被配置校验强制；代码使用 `rejectUnauthorized: true`，不得改为忽略证书错误。
- 若托管服务使用私有 CA，需把 CA 注入运行时信任链（容器内挂载），无此配置时应以 `sslmode=verify-full` 失败关闭。
- 探针与业务共用同一入口；网关只允许内网访问 `/healthz`、`/readyz`、`/metrics`。

## 4. 需要随审查提交的证据

1. `artifacts/step22/RUNTIME_EVIDENCE.json`：迁移、对账、运行时与回切演练（PostgreSQL 16.14）。
2. `artifacts/step23/RUNTIME_LIFECYCLE_EVIDENCE.json`：探针、指标、优雅关闭与数据库故障演练。
3. `artifacts/preacceptance/PREACCEPTANCE_RESULT.json`：当前本地可重复检查结论（`NOT_READY_FOR_ACCEPTANCE`，阻塞项如实列出）。
4. 测试输出：`artifacts/step22/STEP22_FULL_TEST_OUTPUT.txt`、`artifacts/step23/STEP23_EVIDENCE_OUTPUT.txt`。
5. CI 与 staging 记录（**待补**）：CI 平台真实 PostgreSQL 通过记录、staging 复跑 `evidence:step22`/`evidence:step23` 输出。

## 5. 审查结论签署栏（由真人填写）

| 项 | 结论 | 负责人 | 日期 | 备注 |
|---|---|---|---|---|
| TLS 与证书校验 | ☐ 通过 ☐ 不通过 | | | |
| 最小权限账号 | ☐ 通过 ☐ 不通过 | | | |
| 秘密管理与轮换 | ☐ 通过 ☐ 不通过 | | | |
| 探针/指标暴露面 | ☐ 通过 ☐ 不通过 | | | |
| 日志与错误脱敏 | ☐ 通过 ☐ 不通过 | | | |
| 备份加密与保留 | ☐ 通过 ☐ 不通过 | | | |
| 身份与访问控制 | ☐ 通过 ☐ 不通过 | | | |
| 健康数据合规 | ☐ 通过 ☐ 不通过 | | | |

签署完成后，把结论写入迁移切换证据的 `securityReviewPassed` 字段（由签署人操作），再运行：

```bash
node scripts/migration-cutover-gate.js --evidence <最终的 cutover-evidence.json>
```

只有门禁返回 `ELIGIBLE_FOR_MANUAL_APPROVAL` 且取得独立人员批准，才允许切换流量。

## 6. 当前未完成项（本稿状态）

- 未取得任何真实安全/运维审查结论（`securityReviewPassed=false`）。
- 未在 CI 平台与正式 staging 执行。
- 未完成备份加密、保留/销毁流程的落地实现。
- 未完成多实例共享限流与指标汇总（当前为单进程实现）。
