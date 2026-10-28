# 步骤 17：迁移切换门禁指南

## 目的

切换门禁采用 fail-closed 方式：证据缺失、真实 PostgreSQL 集成测试未通过、备份/恢复演练未通过、未确认源库停写、回滚计划未验证、权限/TLS 审查未通过或逐记录对账存在差异时，一律输出 `BLOCKED` 并返回退出码 `2`。

本工具只验证人工提交的 JSON 证据，不连接数据库、不执行迁移、不改变流量，也不代替人工审批。填写 `true` 不是自动证明；每项必须有独立测试记录或可审计证据支持。

## 使用步骤

1. 在隔离的临时 PostgreSQL 实例上执行真实集成测试：`POSTGRES_TEST_URL=... npm run test:postgres-integration`。
2. 在停写窗口或一致性快照下完成迁移；保存迁移日志。
3. 运行逐记录对账：设置 `SQLITE_SOURCE_PATH`、`POSTGRES_URL` 后执行 `npm run db:reconcile:postgres`，将 JSON 输出归档。
4. 验证 SQLite 备份文件，并在隔离路径完成恢复演练；记录操作者、时间、校验结果。
5. 审查最小权限、TLS、凭据存储、连接池和回滚路径。
6. 按真实证据填写 `examples/cutover-evidence.template.json` 的副本；不要把模板中的 false 改成 true 来代替测试。
7. 执行 `npm run gate:cutover -- --evidence ./migration-evidence.json`。输出 `ELIGIBLE_FOR_MANUAL_APPROVAL` 仅表示字段门禁满足，仍需人工批准。

## 退出码

- `0`：证据字段齐全且满足门禁，可进入人工审批。
- `2`：证据缺失、无效或未通过；禁止切换。

## 重要限制

- 当前工作环境没有发现 `psql`、`pg_isready`、Docker 或 Podman，且未配置 `POSTGRES_TEST_URL`；因此本轮未执行真实 PostgreSQL 集成测试。
- 门禁不会验证证据声明的真实性，也不会自动从日志签名或数据库中采证。生产流程应将证据归档、审批身份和时间戳接入受控发布系统。
- 当前不能据此宣布生产迁移通过、数据库已切换或服务已上线。
