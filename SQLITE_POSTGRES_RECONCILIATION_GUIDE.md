# 步骤 16：SQLite → PostgreSQL 逐记录对账

## 目标

在迁移后以只读方式逐表、逐键比较 SQLite 源库与 PostgreSQL 目标库，输出可审计的 JSON 报告。对账覆盖 `records`、`record_revisions`、`idempotency_results`，包括数量、每行 SHA-256、缺失行、多余行和内容不同的行。

## 安全特性

- 仅执行 `SELECT`；不运行迁移、不插入/更新/删除目标数据。
- SQLite 通过只读方式和一致性事务快照读取，并先执行完整性及内部一致性校验。
- JSON 对象键顺序不影响摘要；时间字段归一化为 ISO 8601 UTC 字符串。
- 发现差异时 CLI 以退出码 `2` 结束，报告仍输出到标准输出，便于保存和自动化处理。
- 对账期间应冻结写入或使用可保证一致性的快照，避免两边数据在读取过程中变化。

## 运行

Node.js 20+；CLI 写法需要项目可用的 `pg` 包。设置环境变量：

```bash
export SQLITE_SOURCE_PATH=/absolute/path/to/source.sqlite
export POSTGRES_URL='postgresql://readonly_user:password@localhost:5432/health_skill'
# 若使用 TLS：
export POSTGRES_SSL=true
npm run db:reconcile:postgres > reconciliation-report.json
```

建议为对账创建只读 PostgreSQL 账号，只授予三个业务表的 `SELECT` 权限。不要将真实凭据写入源码、交接包或报告。报告可能包含记录 ID、用户 ID 和内容摘要，应按敏感运维资料保管。

## 报告解读

- `match: true` 且 `mismatchCount: 0`：本次读取的三个表逐键内容匹配。
- `tables.*.missing`：源库有、目标库没有。
- `tables.*.extra`：目标库有、源库没有。
- `tables.*.different`：同一键两侧内容不同；提供两侧行摘要用于定位。
- `sourceHash` / `targetHash`：对排序后的键与行内容计算 SHA-256，用于比较本次读取结果。

## 限制

SHA-256 是内容差异检测工具，不证明数据来源真实性，也不等同于备份恢复演练。当前实现把 `records`、`record_revisions`、`idempotency_results` 作为本模块迁移范围；其他业务表、附件对象存储、外部服务状态不在范围内。必须在真实 PostgreSQL 实例执行一次后，才能认定真实数据库对账流程通过。
