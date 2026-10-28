# 步骤 17 基线与交接

- 基线：步骤 16 全量交接包 `健康运动Skill_项目全量交接包_20261025_步骤16更新.zip`。
- 本步骤：增加迁移切换证据门禁模块、命令行入口、5 项测试、证据模板和操作指南。
- 包版本：`health-exercise-skill-record-module-step17` / `0.17.0`。
- 门禁只评估证据 JSON，不执行数据库连接、迁移、回滚或流量切换。
- 后续建议：配置隔离 PostgreSQL 实例并运行 `npm run test:postgres-integration`；完成备份恢复演练；归档逐记录对账 JSON；最后再由人工审批决定是否切换。
