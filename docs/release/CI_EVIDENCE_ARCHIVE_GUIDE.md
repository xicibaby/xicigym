# CI 证据归档指南（步骤 24）

验收门禁只接受**真实 CI 平台记录**；本地等价执行（`npm run evidence:ci-local`）只能作为支撑材料。

## 1. 让工作流真实跑一次

仓库推送到 GitHub 后，`.github/workflows/ci.yml` 会在 push / PR / 手动触发时执行：

- 一次性 PostgreSQL 16 服务（`postgres:16-alpine`，带 `pg_isready` 健康检查）；
- `npm ci` 安装已锁定依赖；
- `npm run check:syntax`、`npm test`（真实集成测试不应跳过）；
- 无论成功失败都上传 `artifacts/` 产物。

工作流已加固：`permissions: contents: read`、无 `pull_request_target`、`npm ci`、并发去重。

## 2. 归档记录

在 Actions 页面打开成功的那次运行，取得 run URL 和 commit SHA：

```bash
npm run archive:ci-record -- \
  --run-url https://github.com/<owner>/<repo>/actions/runs/<id> \
  --commit <40位sha> \
  --tests-total 128 --tests-passed 128 \
  --node-version 22 --postgres-version 16-alpine
```

产物：`artifacts/ci/CI_PLATFORM_RECORD.json`。归档脚本会拒绝：

- 非 https 的 run URL；
- 非 hex 的 commit；
- `tests-passed ≠ tests-total`（不允许跳过/失败）；
- 缺失 node/postgres 版本信息。

## 3. 门禁如何审查 CI 记录

验收门禁要求：

1. `kind` 不是 `local-equivalent-ci`，且 `ciPlatformRecord !== false`；
2. `status === "success"`；
3. `runUrl` 为 https 链接（审核人必须自己打开核对）；
4. `commit` 为真实 SHA（非占位符）；
5. `recordedAt` 在 30 天内；
6. 测试计数存在且 `failed === 0`、`passed > 0`。

## 4. 注意

- 归档脚本**不访问远端**校验运行状态；"人工核对 runUrl"是流程要求。
- 若工作流在 CI 上因环境差异失败（Node 22 与本地 Node 24 行为差异等），以 CI 结果为准并修复，不得修改记录掩盖失败。
- 每次重新发布都需重新归档（门禁有 30 天新鲜度限制）。
