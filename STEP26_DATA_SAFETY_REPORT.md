# 步骤 26：数据安全与运维加固报告

状态：**本地隔离环境验证完成；验收门禁仍为 BLOCKED / 4 项（外部证据未变）。** 本报告记录实际实现与实测结果，不声明生产就绪或验收通过。

## 1. 本轮目标

步骤 25 结束后，清单里剩余的可本地补齐的工程缺口集中在"数据安全与运维"：

- 目标 PostgreSQL 库的**备份/恢复演练**（此前只做了 SQLite 备份恢复）；
- 备份**加密**（此前备份为明文）；
- 轻量**负载冒烟**（此前完全未压测）；
- **告警规则**（此前只有指标端点，无告警）；
- **CI 加固**（依赖审计、交付物校验、门禁证据生成）。

## 2. 新增能力

| 能力 | 文件 | 说明 |
|---|---|---|
| 备份加密 | `src/infrastructure/backup-crypto.js` | AES-256-GCM；`HSB1` 容器格式；支持 32 字节密钥或口令（scrypt）；头部参与 AAD，篡改/错钥 fail-closed；密钥不落盘、不打印 |
| PostgreSQL 逻辑备份/恢复 | `src/infrastructure/postgres-backup.js` | 四张表一致性导出（REPEATABLE READ 只读事务）+ SHA-256 完整性哈希；恢复要求空目标、迁移版本一致、恢复后重读复校哈希、失败整笔回滚 |
| PostgreSQL 运维 CLI | `src/postgres-maintenance.js` | `backup / check / restore`，支持 `BACKUP_ENCRYPTION_KEY` 或 `BACKUP_PASSPHRASE_FILE`，恢复默认拒绝非空表 |
| 加密 SQLite 备份 | `src/maintenance.js`（增强） | 备份时若提供密钥 → 先一致性快照再加密（原子独占写入）；恢复/检查自动识别加密文件 |
| 负载冒烟 | `scripts/load-smoke.mjs` | HTTP + 真实 PostgreSQL；200 请求/并发 20；p50/p90/p95/p99；5xx、传输失败、限流 429+Retry-After 断言 |
| 告警规则 | `ops/prometheus/alerts.yml` + README | 4 条起点规则：就绪失败、5xx 比例 >1%、schema 版本缺失、429 比例 >20% |
| 数据安全演练 | `scripts/step26-evidence.mjs` | 16 项断言：加密 SQLite 备份/检查/恢复、PG 逻辑备份/加密/篡改/错钥/哈希校验、重建 schema 恢复、零差异对账、告警规则校验、密钥不泄漏 |
| CI 加固 | `.github/workflows/ci.yml` | 新增 `npm audit --omit=dev --audit-level=high`、`checksums:verify`、门禁证据生成（`continue-on-error`，不阻断构建） |

## 3. 实测结果（本机真实执行，PostgreSQL 16.14）

### 3.1 自动化测试

`npm test`（真实 PostgreSQL）：**136 项 / 136 通过 / 0 失败 / 0 跳过**（步骤 25 为 128 项，新增 8 项备份加密与备份恢复测试）。

新增测试：`test/backup-crypto.test.js`（4 项）、`test/maintenance-encryption.test.js`（3 项）、`test/postgres-backup.test.js`（1 项真实 PG 集成）。

### 3.2 数据安全演练（`npm run evidence:step26`）

16 项断言全部通过：

| 域 | 结果 |
|---|---|
| 加密 SQLite 备份 | 36913 B，`integrity_check=ok`，schemaVersion=1 |
| 加密 SQLite 检查/恢复 | 恢复副本可读、历史保留（2 个 revision） |
| PG 逻辑备份 | `counts={schema_migrations:1, records:2, record_revisions:3, idempotency_results:1}`，SHA-256 记录 |
| 加密与解密往返 | 3620 B 密文；解密后 SHA-256 一致 |
| 篡改检测 | 密文篡改、错误密钥、载荷哈希不一致均被拒绝 |
| 灾备恢复 | 重建空 schema → 恢复 → 记录/历史内容一致 |
| 恢复完整性 | 恢复后重读哈希与备份一致 |
| 逐记录对账 | `mismatchCount=0`（SQLite 源 vs 恢复后的 PostgreSQL） |
| 告警规则 | 1 组 4 条规则，表达式均引用导出指标 |
| 密钥卫生 | artifacts 中不含加密密钥明文 |

### 3.3 负载冒烟（`npm run load:smoke`）

| 指标 | 结果 |
|---|---|
| 请求 | 200/200 成功，0 个 5xx，0 传输失败 |
| 吞吐 | 370 ms 内完成 → 约 **540 req/s**（单进程、本地） |
| 延迟 | p50=12.2 ms，p95=36.3 ms，p99=243.3 ms |
| 限流 | 超过阈值返回 429 + `Retry-After: 60s` |

### 3.4 边界说明（不可省略）

- 这是一次**轻量冒烟**（200 请求/并发 20），不是容量压测、不是浸泡测试；生产容量必须在 staging 做正式压测。
- PostgreSQL 逻辑备份适合中小数据量灾备演练；**生产仍应使用 `pg_dump`/物理备份/云服务商备份**。
- 加密密钥在演练中临时生成且不落盘；生产必须由秘密管理器托管、演练轮换与销毁。
- 恢复演练在本地隔离实例上完成，不代表真实故障切换；TLS/网络/权限仍由人工安全审查确认。
- 告警规则只是起点，阈值与路由需在真实监控环境调优。

## 4. 清单变化

| 检查项 | 步骤 25 | 步骤 26 |
|---|---|---|
| 目标 PostgreSQL 库恢复演练（B5） | 未做 | **已做**（逻辑备份 → 重建 schema → 恢复 → 零差异对账） |
| 备份加密（D） | 未实现 | **已实现**（AES-256-GCM + 密钥来源约束），人工审查仍待签署 |
| 轻量负载验证 | 无 | **已做**（冒烟，非容量） |
| 告警规则 | 无 | **已提供**（Prometheus 规则样例） |
| CI 加固 | 基础 | **增加**依赖审计、交付物校验、门禁证据生成 |

## 5. 仍需真人/真实环境完成的 4 项（未变）

1. 真实 staging 演练（`kind=staging`）
2. 人工安全审查签署（含备份加密与密钥管理确认）
3. 产品/安全/运维 + 独立四方签署
4. 切换门禁重算至可人工批准

## 6. 下一步

- 把本步骤提交推送到 GitHub 并重跑 CI（新测试数 136、新增文件），重归档 `artifacts/ci/CI_PLATFORM_RECORD.json`；
- 按 `行动包/02_staging环境动作卡.md` 执行真实 staging 演练；
- 安全审查时重点确认：备份加密密钥托管与轮换、逻辑备份之外的物理/云备份策略、告警阈值与值班表。
