# 步骤 24 审查记录（每环节一次审查）

> 说明：本轮要求的"每个环节都要进行一次审查"落实为**工程审查 + 自动审查**，每次审查记录审查对象、方法、实际命令、结论与遗留风险。
> 这些审查**不能替代**安全/运维/产品负责人的人类审查与签署；人类审查仍是验收门禁的第 3、4 项阻塞。
>
> 审查日期：2026-10-28；审查环境：Node v24.21.0、PostgreSQL 16.14（本地便携版，127.0.0.1:55432）、Windows。

## 审查 1：CI 工作流与本地等价执行

| 项 | 内容 |
|---|---|
| 审查对象 | `.github/workflows/ci.yml`、`scripts/ci-local-evidence.mjs`、`scripts/archive-ci-record.mjs` |
| 审查方法 | 用 `yaml` 解析工作流并断言 13 项结构/加固；在本机按 ci.yml 的脚本重放两个步骤；验证归档脚本拒绝占位符/失败计数 |
| 实际命令 | `npm run evidence:ci-local`；`node scripts/archive-ci-record.mjs --run-url http://x --commit zzz`（应拒绝） |
| 结论 | **通过（本地等价）**：16/16 断言通过，2 个重放步骤 exit 0；`ciPlatformRecord=false` 明确标注 |
| 遗留风险 | 未在 GitHub Actions 真实执行；本地 PostgreSQL 为便携版而非 `postgres:16-alpine` 镜像；`upload-artifact` 行为未实测 |

## 审查 2：staging 演练剧本与安全护栏

| 项 | 内容 |
|---|---|
| 审查对象 | `scripts/staging-rehearsal.mjs`、`docs/release/STAGING_REHEARSAL_RUNBOOK.md` |
| 审查方法 | 本地完整跑一遍 rehearsal；审查 staging 模式的拒绝条件（localhost、http、占位执行人、非可销毁库名）；确认证据 `kind` 区分 |
| 实际命令 | `npm run evidence:staging-rehearsal`；`node scripts/staging-rehearsal.mjs --environment=staging`（无变量时应拒绝） |
| 结论 | **本地剧本通过（9/9 断言）**；staging 模式护栏有效，缺变量时 exit 2 拒绝 |
| 遗留风险 | 未在真实 staging 执行；staging 模式的迁移写入需要显式 `STAGING_APPLY_MIGRATION=1`，该路径未实测 |

## 审查 3：数据库最小权限

| 项 | 内容 |
|---|---|
| 审查对象 | `scripts/check-db-privileges.mjs`、本地角色 `health_skill_app` 授权 |
| 审查方法 | 用最小权限角色运行 21 项检查；反向用超管账号运行验证检查器能识别越权；DDL 尝试全部在事务中回滚 |
| 实际命令 | `POSTGRES_APP_URL=postgres://health_skill_app:… npm run security:db-privileges`（21/21 PASS）；改用 `postgres` 超管运行（应 FAIL） |
| 结论 | **通过**：只读审查；超管会因 superuser/所有权/DDL 可执行等项失败，说明检查有效 |
| 遗留风险 | 只覆盖权限，不覆盖 TLS 握手、网络策略、行级安全与审计日志；未在真实托管实例执行 |

## 审查 4：生产配置 fail-closed 与 TLS 证书校验

| 项 | 内容 |
|---|---|
| 审查对象 | `src/config/runtime-config.js`、`test/runtime-config.test.js` |
| 审查方法 | 8 类非法生产配置逐一断言必须抛错；合法生产配置必须通过；新增 `sslmode=verify-full/verify-ca` 强制规则与矛盾配置拒绝 |
| 实际命令 | `node --test test/runtime-config.test.js`（含新增 TLS 用例）；`npm run security:baseline` 的 S1/S3 项 |
| 结论 | **通过**：弱 TLS（require/disable/缺失）均被拒绝；`POSTGRES_SSL=true` 与 `sslmode=disable` 矛盾被拒绝 |
| 遗留风险 | 未做真实 TLS 握手与证书链验证；私有 CA 注入流程未实现，需部署环境确认 |

## 审查 5：秘密卫生与错误/日志脱敏

| 项 | 内容 |
|---|---|
| 审查对象 | `scripts/security-baseline-check.mjs` 的 S4、`src/http/shutdown.js`、`src/server.js` |
| 审查方法 | 扫描 `src/`、`.github/workflows/`、`examples/`、`openapi.yaml`、`package.json` 共 35 个文件；用含连接串的失败消息验证脱敏；用不可达 PG 验证启动失败信息不含连接串 |
| 实际命令 | `npm run security:baseline`（S4 三项 PASS） |
| 结论 | **通过**：未发现硬编码密钥；关闭异常与启动失败均不回显连接串/密码 |
| 遗留风险 | 扫描规则为已知模式（URL 密码、AWS key、私钥块、通用 token 赋值），不覆盖所有密钥形态；生产日志平台侧脱敏未验证 |

## 审查 6：探针暴露面与契约

| 项 | 内容 |
|---|---|
| 审查对象 | `src/http/probe-endpoints.js`、`openapi.yaml`、`docs/release/SECURITY_REVIEW_PREP.md` |
| 审查方法 | 断言默认绑定回环地址；OpenAPI 三个探针契约存在；安全审查材料写明网关白名单要求 |
| 实际命令 | `npm run security:baseline`（S5 三项 PASS）；`npm run evidence:step23`（探针行为回归） |
| 结论 | **通过**：探针无鉴权但默认回环、文档要求网关白名单；`/readyz` 故障降级行为有测试 |
| 遗留风险 | 生产网关/编排配置不在本仓库；公网暴露属部署错误，需运维审查时确认 |

## 审查 7：依赖锁与供应链

| 项 | 内容 |
|---|---|
| 审查对象 | `package.json`、`package-lock.json`、`.github/workflows/ci.yml` |
| 审查方法 | 断言 `lockfileVersion=3`、`pg` 版本与声明一致、所有依赖解析来源均为 `registry.npmjs.org`；CI 使用 `npm ci` |
| 实际命令 | `npm run security:baseline`（S6/S7 项 PASS） |
| 结论 | **通过**：锁文件完整、来源单一、CI 使用锁定安装 |
| 遗留风险 | 未做依赖漏洞扫描（无网络/无审计服务）；`yaml` 为新增 devDependency，仅用于工具脚本 |

## 审查 8：验收证据门禁逻辑

| 项 | 内容 |
|---|---|
| 审查对象 | `src/acceptance/acceptance-gate.js`、`scripts/acceptance-gate.mjs`、`test/acceptance-gate.test.js` |
| 审查方法 | 9 个单元用例覆盖"本地冒充外部、自动化冒充人工、过期、占位符、4 人不同、作者自批、门禁未达可批"；CLI 实测当前 5 项阻塞 |
| 实际命令 | `node --test test/acceptance-gate.test.js`；`npm run gate:acceptance`（BLOCKED 5 项） |
| 结论 | **通过**：正向路径只在全部真实证据齐全时成立；当前如实 BLOCKED，阻塞项可操作 |
| 遗留风险 | 门禁不校验 CI runUrl 的远端真实性（归档脚本注明需人工核对）；签署真实性依赖组织流程 |

## 审查 9：文档与证据一致性（事实审计）

| 项 | 内容 |
|---|---|
| 审查对象 | `STEP24_EXTERNAL_EVIDENCE_REPORT.md`、`STEP23_RUNTIME_OBSERVABILITY_REPORT.md`、`README.md`、`docs/release/PREACCEPTANCE_CHECKLIST.md` |
| 审查方法 | 从证据 JSON 直接取数交叉核对报告中的计数（测试数、断言数、检查数、阻塞项）；核对门禁结论与证据文件一致 |
| 实际命令 | 用 Node 读取 `artifacts/**/*.json` 输出计数：security=26、dbp=21、ci=16、staging=9、acceptance=BLOCKED/5、tests=128 |
| 结论 | **通过（修正后）**：发现并修正两处表述（ci-local 断言构成、模拟验收演示措辞），当前文档数字与证据一致 |
| 遗留风险 | 人工阅读层面的措辞一致性无法完全自动化；每次重跑证据后需重新核对（`checksums:verify` 可发现文件级不一致） |

## 审查 10：验收门禁与预验收检查器串联

| 项 | 内容 |
|---|---|
| 审查对象 | `scripts/preacceptance-check.js` 与 `artifacts/acceptance/ACCEPTANCE_GATE_RESULT.json` 的集成 |
| 审查方法 | 预验收检查器读取门禁结果，把 5 项阻塞逐条写入报告；本地检查（语法/测试/证据）与外部阻塞严格分离；`localChecksPass` 不受外部 BLOCKED 影响 |
| 实际命令 | `npm run preacceptance:check`（退出码 2，`NOT_READY_FOR_ACCEPTANCE`，阻塞项来自门禁） |
| 结论 | **通过**：本地检查全绿与外部证据 BLOCKED 同时如实呈现，不再手写阻塞文案 |
| 遗留风险 | 门禁结果文件缺失时预验收按 fail-closed 记阻塞；CI 上需先生成门禁结果再跑预验收 |

## 审查总结

- 10 个环节全部完成一次工程/自动审查，结论均为"通过"或"本地通过（外部证据待补）"。
- 本轮未发现需要回滚的代码缺陷；发现并修正 2 处文档表述、3 处脚本初版缺陷（YAML 数字类型比较、staging 修订计数预期、pg 池二次关闭容错）。
- **仍需人类完成的审查**：安全/运维负责人签署、产品验收、独立切换批准。这些不会被自动化审查替代。
