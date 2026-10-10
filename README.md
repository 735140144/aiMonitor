# AI 账户余额面板

一个本地运行的 AI 账户 / 套餐余量面板：通过 HTTP 接口聚合多平台余额，支持 **New API**、**Sub2API**、**OpenCode Go** 以及任意**自定义三方接口**，界面为深色玻璃质感，支持多账户、自动刷新与重置倒计时。

## 快速开始

```bash
npm start           # 仅本机访问：http://127.0.0.1:8787
npm run start:lan   # 局域网访问：监听 0.0.0.0，启动时会打印可用 IP
npm test            # 运行适配器与 HTTP 接口测试
```

### 局域网访问

```bash
# 推荐：带访问令牌启动（令牌自己替换）
AIMONITOR_TOKEN=$(openssl rand -hex 16) npm run start:lan
```

启动后会打印本机可用地址，例如：

```
AI 账户余额面板已启动：
  http://127.0.0.1:8787
  http://<你的局域网IP>:8787
```

在手机 / 其它电脑上打开 `http://<你的局域网IP>:8787` 即可。若设置了 `AIMONITOR_TOKEN`，首次打开会弹出「访问令牌」输入框；也可以直接用一次
`http://<ip>:8787/?token=<AIMONITOR_TOKEN>` 完成授权（授权后会写入 httpOnly Cookie，之后该设备直接打开即可，地址栏里的 token 会自动清除）。

不设置令牌时任何人都能在局域网内查看并修改账户配置，服务启动时也会打印安全提示；令牌可通过页面上方的钥匙图标随时更换或清除。

需要 Node.js >= 20（内置 `fetch`，无第三方依赖）。

环境变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `AIMONITOR_PORT` | `8787` | 监听端口（被占用时自动顺延，除非显式指定） |
| `AIMONITOR_HOST` | `127.0.0.1` | 监听地址，改为 `0.0.0.0` 可供局域网访问 |
| `AIMONITOR_DATA` | `./data` | 账户配置文件目录 |
| `AIMONITOR_TIMEOUT_MS` | `15000` | 上游接口超时 |
| `AIMONITOR_CACHE_MS` | `10000` | 余额结果内存缓存时间 |
| `AIMONITOR_TOKEN` | 空 | 设置后 `/api/*` 需要访问令牌（`Authorization: Bearer`、`X-Access-Token`、`?token=` 或授权 Cookie） |
| `AIMONITOR_CORS` | 空 | 需要跨源调用接口时显式放行，例如 `https://dash.example.com` 或 `*`；默认不下发 CORS 头 |
| `AIMONITOR_NOTIFY_INTERVAL_MS` | `60000` | 阈值巡检间隔；定时汇总的时间点判断不受影响 |

## 支持的上游接口

### New API

- 在 New API 的个人设置中生成**系统访问令牌**（要求可访问 `/api/user/self`），填入「密钥」。
- 读取 `GET /api/user/self` 的 `quota` / `used_quota`，并调用 `GET /api/status` 获取 `quota_per_unit` 与 `quota_display_type` 做货币换算。
- 默认 `500000 配额 = $1`，可在「配额单位 / 货币」中覆盖。

### Sub2API

默认使用 **API 密钥 + `GET /v1/usage`**（Sub2API 网关自带接口），一次请求即可拿到余额与用量，无需面板登录：

| 上游返回模式 | 解析结果 |
| --- | --- |
| `unrestricted` + `planName: 钱包余额` | 钱包余额：`balance`/`remaining` 作为剩余，`usage.total.actual_cost`（回退 `cost`）作为已用；`daily_usage`、`model_stats`、`usage.total` 汇总成卡片上的用量信息 |
| `unrestricted` + `subscription` | 订阅分组：`subscription.{daily,weekly,monthly}_limit_usd` 与对应 `_usage_usd` 渲染日 / 周 / 月额度条、剩余与到期时间 |
| `quota_limited` | 额度密钥：`quota.{limit,used,remaining}` 作为总额度，`rate_limits[5h/1d/7d]` 渲染 5 小时 / 日 / 周限额与重置倒计时 |

认证方式可选：

- **API 密钥（默认）**：填 Sub2API 网关密钥，请求 `{baseUrl}/v1/usage`（`Authorization: Bearer`）。
- **面板令牌**：填面板登录后的 `access_token`，读取 `/api/v1/user/profile` 与 `/api/v1/subscriptions/progress`。
- **面板邮箱 + 密码**：服务端自动登录并在内存中缓存令牌，过期后重新登录。

`isValid: false` 会直接报「密钥不可用」；若地址没有 `/v1/usage`（404）会提示改选面板令牌。

### OpenCode Go

- 填入 OpenCode Zen 的 API Key，默认请求 `https://opencode.ai/zen/go/v1/usage`，展示 5 小时 / 周 / 月用量百分比与重置时间。

### 自定义三方接口

填写完整接口地址（或「服务地址 + 请求路径」）、认证方式（Bearer / x-api-key / URL 参数 / 无）与可选请求头。返回 JSON 会按以下顺序解析：

1. 有「字段映射」JSON 时按映射取值；
2. 否则自动识别常见字段：
   - 余额：`balance` / `remaining` / `available` / `credit` / `used` / `total` / `quota`；
   - 周期额度：`quota_5h`、`quota_daily`、`quota_weekly`、`quota_monthly` 与对应的 `used_*`、`reset_*_at`；
   - 百分比窗口：`usage.rolling` / `usage.weekly` / `usage.monthly` 中的 `percent`、`resetsAt`；
   - 套餐：`plan_name` / `plan_type` / `has_active_plan` / `expire_at`；
   - 自动充值：`auto_reload_enabled` / `auto_reload_threshold` / `auto_reload_amount`。

例如下面这个响应无需任何配置即可识别：

```json
{
  "currency": "CNY",
  "plan_name": "示例套餐 A",
  "plan_type": "quota_subscription",
  "has_active_plan": true,
  "expire_at": "2026-10-20T13:31:14.171139Z",
  "quota_5h": "39",
  "used_5h": "15.62613328",
  "reset_5h_at": "2026-10-10T13:31:14.171139Z",
  "quota_weekly": "99",
  "used_weekly": "59.1221858",
  "reset_weekly_at": "2026-10-12T10:42:25.745196Z",
  "quota_monthly": "299",
  "used_monthly": "299.0907776",
  "reset_monthly_at": "2026-10-20T13:31:14.171139Z"
}
```

字段映射示例（嵌套结构时使用）：

```json
{
  "root": "data",
  "balanceRemaining": "credit.left",
  "balanceUsed": "credit.spent",
  "currency": "unit",
  "planName": "plan.title",
  "windows": {
    "monthly": { "limit": "plan.quota", "used": "plan.used", "resetAt": "plan.reset_at" }
  }
}
```

## HTTP 接口

面板自身也提供 JSON 接口，便于脚本或其它看板消费：

```bash
curl http://127.0.0.1:8787/api/accounts                     # 账户列表（密钥掩码）
curl -X POST http://127.0.0.1:8787/api/accounts \
  -H 'Content-Type: application/json' \
  -d '{"type":"opencode","name":"OpenCode Go","key":"sk-xxx"}'
curl http://127.0.0.1:8787/api/balances                     # 聚合余额（10s 缓存，?force=1 强制刷新）
curl http://127.0.0.1:8787/api/accounts/<id>/balance        # 单个账户余额
curl -X PUT http://127.0.0.1:8787/api/accounts/<id> -H 'Content-Type: application/json' -d '{"name":"新名称"}'
curl -X DELETE http://127.0.0.1:8787/api/accounts/<id>
```

设置了 `AIMONITOR_TOKEN` 时，以上请求需带上 `-H 'Authorization: Bearer <token>'`（或 `?token=<token>`）。

`/api/balances` 返回统一结构：`balance`（剩余 / 已用 / 总额）、`windows`（5 小时、日、周、月额度与重置时间）、`plan`、`autoReload`、`raw`（上游原始响应）。

## 安全说明

- 密钥保存在 `data/accounts.json`（权限 `0600`），仅在服务端使用；页面与 `/api/accounts` 只返回掩码。
- 默认只监听 `127.0.0.1`；`npm run start:lan` 会监听所有网卡，此时建议同时设置 `AIMONITOR_TOKEN`。
- 静态页面不含任何密钥，始终可访问；所有 `/api/*` 数据接口在设置令牌后都要求授权。
- 默认不下发 CORS 头，浏览器里其它站点无法读取本机余额接口；确需跨源时用 `AIMONITOR_CORS` 指定来源。
- 如需暴露到公网，请在前面再加一层反向代理与 HTTPS。

## 目录结构

```
server.js            HTTP 服务：静态资源 + 账户 / 余额接口
src/adapters.js      各平台适配器与自定义字段识别
src/store.js         账户持久化与校验
public/              前端页面（原生 JS + 玻璃质感样式）
test/                适配器与 HTTP 接口测试
Dockerfile           容器镜像（node:20-alpine-amd64，非 root 运行）
deploy/              Kubernetes 清单与构建脚本
```

## Webhook 通知

支持钉钉、企业微信、飞书机器人，页面上方铃铛图标进入「通知设置」。

### 阈值告警

- **套餐账户**：5 小时 / 周 / 月窗口的余量**首次低于阈值**（默认 20%）时各推送一次，三个窗口独立计数互不影响。
- **钱包类账户**：余额**首次低于金额阈值**（默认 10）时推送。
- 计数归零的条件：对应窗口重置（余量回到阈值之上，或上游 `resetAt` 前进到新一轮），或钱包余额回升到阈值之上。之后再次跌破会重新推送。
- **上游数据未刷新时不会重复告警**：例如 5 小时窗口已重置、但上游返回的月用量仍是旧值时，月窗口会保持“已通知”状态，不会因为其它窗口刷新而反复触发；等月数据真正刷新后才重新计数。
- 单账户可在 `accounts.json` 里加 `thresholds: { windowPercent: 10, balanceAmount: 5 }` 覆盖全局阈值（接口同样支持）。

### 定时汇总

- 在设置里填写时间点（如 `09:00, 18:00`）与时区，到点推送全局余量。
- 内容按**分组**（账户表单里的「分组」字段，留空按账户类型归组）组织，排序为：**有效账户在前、余量低的在前、限额的在后**，请求失败的排在最后。
- 每个时间点当天只推一次；服务重启后 30 分钟内的槽位会补发，超过则记为跳过。

### 机器人配置

| 平台 | 地址 | 加签 |
| --- | --- | --- |
| 钉钉 | 机器人 Webhook（含 `access_token`） | 可选，填「加签」密钥；签名 key=secret、data=`timestamp\nsecret` |
| 企业微信 | 群机器人 Webhook（含 `key`） | 不需要 |
| 飞书 | 自定义机器人 Webhook | 可选，填签名校验密钥；签名 key=`timestamp\nsecret`、data 为空（时间戳单位为秒） |

通知设置保存在 `data/notifications.json`（0600），页面与接口只返回掩码后的地址。

### 相关接口

```bash
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8787/api/notifications           # 读取设置
curl -X PUT -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"rules":{"windowPercent":20,"balanceAmount":10},"digest":{"times":["09:00"],"timezone":"Asia/Shanghai"},"webhooks":[{"type":"wecom","name":"运维群","url":"https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx"}]}' \
  http://127.0.0.1:8787/api/notifications
curl -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"webhookId":"<id>"}' http://127.0.0.1:8787/api/notifications/test             # 发送测试消息
curl -H "Authorization: Bearer $TOKEN" 'http://127.0.0.1:8787/api/notifications/preview?kind=digest'  # 预览汇总内容
```

后台巡检间隔通过 `AIMONITOR_NOTIFY_INTERVAL_MS` 调整（默认 60000 毫秒）。

## 部署

### 容器镜像

```bash
docker build -t ai-monitor:latest .
docker run -d --name ai-monitor -p 8787:8787 \
  -v "$PWD/data:/app/data" \
  -e AIMONITOR_TOKEN="$(openssl rand -hex 16)" \
  ai-monitor:latest
```

### Kubernetes

`deploy/` 下提供一套清单（PVC / Deployment / Service / Ingress），把命名空间、域名、镜像仓库替换成你自己的环境即可：

```bash
kubectl -n <namespace> set image deployment/ai-monitor \
  ai-monitor=<registry>/ai-monitor:<tag>
kubectl -n <namespace> rollout status deployment/ai-monitor
```

没有可用的本地 Docker 时，也可以用 `deploy/build-and-push.sh` 借集群内的 dind Pod 构建推送。

详见 [deploy/README.md](deploy/README.md)。
