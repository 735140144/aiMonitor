# 内部集群部署说明

目标环境：`etl` 命名空间，域名 `balance.lucky37.cn`，Ingress Class `lucky37`，镜像仓库 `hub.luckydcms.com/library`。

## 资源清单

| 文件 | 内容 |
| --- | --- |
| `01-pvc.yaml` | `ai-monitor-data`（nfs1，1Gi），持久化 `data/accounts.json` |
| `02-deployment.yaml` | 单副本 Deployment，健康检查、资源限制、只读根文件系统 |
| `03-service.yaml` | ClusterIP Service：80 → 8787 |
| `04-ingress.yaml` | Ingress：`balance.lucky37.cn` |
| `secret.example.yaml` | 访问令牌 Secret 示例（实际值不入库） |
| `build-and-push.sh` | 用集群内 dind Pod 构建并推送镜像 |

## 首次部署

```bash
# 1. 访问令牌（记下来，页面首次访问要输入）
kubectl create secret generic ai-monitor-secrets -n etl \
  --from-literal=access-token="$(openssl rand -hex 16)" \
  --dry-run=client -o yaml | kubectl apply -f -

# 2. 构建并推送镜像（返回镜像 tag）
./deploy/build-and-push.sh

# 3. 部署
kubectl apply -f deploy/01-pvc.yaml -f deploy/02-deployment.yaml \
  -f deploy/03-service.yaml -f deploy/04-ingress.yaml

# 4. 查看状态
kubectl -n etl rollout status deployment/ai-monitor
kubectl -n etl get ingress ai-monitor
```

## 发布新版本

```bash
./deploy/build-and-push.sh                 # 生成时间戳 tag
kubectl -n etl set image deployment/ai-monitor \
  ai-monitor=hub.luckydcms.com/library/ai-monitor:<tag>
kubectl -n etl rollout status deployment/ai-monitor
```

## 访问

- 页面：`https://balance.lucky37.cn`（网关会把 `http://` 301 到 `https://`）
- 首次授权：`https://balance.lucky37.cn/?token=<access-token>`（授权后写入 httpOnly + Secure Cookie，浏览器地址栏会自动清理 token）
- 关闭鉴权：删除 `AIMONITOR_TOKEN` 环境变量（不建议，接口会变成同网段可写）

获取当前令牌：

```bash
kubectl -n etl get secret ai-monitor-secrets -o jsonpath='{.data.access-token}' | base64 -d; echo
```

## 运维要点

- **单副本**：账户数据是单文件 JSON，多副本会互相覆盖；`strategy: Recreate` 避免 PVC 挂载冲突。若要多副本，需要先把存储换成数据库或改用共享配置。
- **持久化**：`/app/data` 挂 `ai-monitor-data`，Pod 重建后账户与密钥不丢。
- **密钥**：账户密钥只存在 `accounts.json`（0600）与 Secret 中，接口只返回掩码。
- **出网**：Pod 需要能访问 New API / Sub2API / OpenCode 等上游地址；若集群出网受限，可在 Deployment 中配置代理环境变量（`HTTPS_PROXY`）。

## 已知环境差异

- Harbor 里 `library/node:20-alpine` 是 **arm64** 镜像，集群节点是 amd64，因此 Dockerfile 固定使用 `library/node:20-alpine-amd64`；本地构建若报 `exec format error` 同理。
- 推送镜像需要 `library` 项目写权限：构建脚本默认用 `etl/hub` 凭证（`CRED_SECRET` 可覆盖），`etl/harbor-registry` 是只读机器人账号，只能用于拉取。
- 外层 openresty 网关不向 ingress-nginx 传递 `X-Forwarded-Proto`，所以 Cookie 的 `Secure` 由 `AIMONITOR_SECURE_COOKIE=1` 显式控制。
