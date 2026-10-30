# 监控与告警（Prometheus）

本目录提供记录模块的最小监控接入物：指标端点契约 + 告警规则样例。
它是"可接入"的起点，不是生产监控方案本身。

## 指标端点

`GET /metrics`（Prometheus 文本格式，`text/plain; version=0.0.4`），只暴露聚合值：

| 指标 | 类型 | 含义 |
|---|---|---|
| `health_skill_http_requests_total{method,status}` | counter | 按方法与状态码的请求数 |
| `health_skill_http_in_flight_requests` | gauge | 当前在途请求数 |
| `health_skill_ready` | gauge | 最近一次就绪探测结果（1/0） |
| `health_skill_db_schema_version` | gauge | 最近一次就绪探测读到的迁移版本 |
| `health_skill_uptime_seconds` | gauge | 进程运行秒数 |

注意：探针与指标端点**无鉴权**，必须通过私有网络或网关白名单访问；不要暴露公网。

## Scrape 配置示例

```yaml
scrape_configs:
  - job_name: health-skill-record-api
    metrics_path: /metrics
    static_configs:
      - targets: ['10.0.0.12:3000', '10.0.0.13:3000']
```

多实例部署时每实例单独抓取；单进程内存聚合不能跨实例汇总。

## 告警规则

`alerts.yml` 提供 4 条起点规则：就绪失败、5xx 比例、schema 版本缺失、指标采集中断。
阈值与 `for` 时长必须按真实流量调整；上线前需接入告警路由与值班表。

```bash
promtool check rules alerts.yml   # 在部署环境执行
```

## 未覆盖（仍属生产化缺口）

- 无仪表盘模板（Grafana）与 SLO 定义。
- 无分布式追踪与日志聚合接入。
- 无长期容量趋势与压测基线；`npm run load:smoke` 只是轻量冒烟。
