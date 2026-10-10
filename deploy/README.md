# Kubernetes 部署说明

把下面的命名空间、域名、Ingress Class、镜像仓库替换成你自己的环境即可。示例使用 `ai-monitor` 命名空间、`ai-monitor.example.com` 域名、`nginx` Ingress Class。

## 资源清单

| 文件 | 内容 |
| --- | --- |
| `01-pvc.yaml` | `ai-monitor-data`（1Gi，storageClass 按集群实际情况修改），持久化 `data/accounts.json` |
| `02-deployment.yaml` | 单副本 Deployment，健康检查、资源限制、只读根文件系统（镜像地址需替换） |
| `03-service.yaml` | ClusterIP Service：80 → 8787 |
| `04-ingress.yaml` | Ingress：`ai-monitor.example.com` |
| `secret.example.yaml` | 访问令牌 Secret 示例（实际值不入库） |
| `build-and-push.sh` | 无可用的本地 Docker 时，用集群内 dind Pod 构建并推送镜像（也可直接用 `docker build` + `docker push`） |

## 首次部署

```bash
# 1. 访问令牌（记下来，页面首次访问要输入）
kubectl create secret generic ai-monitor-secrets -n ai-monitor \
  --from-literal=access-token="$(openssl rand -hex 16)" \
  --dry-run=client -o yaml | kubectl apply -f -

# 2. 构建并推送镜像（返回镜像 tag）
./deploy/build-and-push.sh

# 3. 部署
kubectl apply -f deploy/01-pvc.yaml -f deploy/02-deployment.yaml \
  -f deploy/03-service.yaml -f deploy/04-ingress.yaml

# 4. 查看状态
kubectl -n ai-monitor rollout status deployment/ai-monitor
kubectl -n ai-monitor get ingress ai-monitor
```

## 发布新版本

```bash
./deploy/build-and-push.sh                 # 生成时间戳 tag
kubectl -n ai-monitor set image deployment/ai-monitor \
  ai-monitor=registry.example.com/library/ai-monitor:<tag>
kubectl -n ai-monitor rollout status deployment/ai-monitor
```

## 访问

- 页面：`https://ai-monitor.example.com`（若前面有网关做 HTTP → HTTPS 跳转，建议同时设置 `AIMONITOR_SECURE_COOKIE=1`）
- 首次授权：`https://ai-monitor.example.com/?token=<access-token>`（授权后写入 httpOnly + Secure Cookie，浏览器地址栏会自动清理 token）
- 关闭鉴权：删除 `AIMONITOR_TOKEN` 环境变量（不建议，接口会变成同网段可写）

获取当前令牌：

```bash
kubectl -n ai-monitor get secret ai-monitor-secrets -o jsonpath='{.data.access-token}' | base64 -d; echo
```

## 运维要点

- **单副本**：账户数据是单文件 JSON，多副本会互相覆盖；`strategy: Recreate` 避免 PVC 挂载冲突。若要多副本，需要先把存储换成数据库或改用共享配置。
- **持久化**：`/app/data` 挂 `ai-monitor-data`，Pod 重建后账户与密钥不丢。
- **密钥**：账户密钥只存在 `accounts.json`（0600）与 Secret 中，接口只返回掩码。
- **出网**：Pod 需要能访问 New API / Sub2API / OpenCode 等上游地址；若集群出网受限，可在 Deployment 中配置代理环境变量（`HTTPS_PROXY`）。

## 常见问题

- **镜像架构不匹配**：若基础镜像与节点架构不一致，构建时用 `PLATFORM` 指定，例如 `PLATFORM=linux/amd64 ./deploy/build-and-push.sh`；也可在 Dockerfile 里把 `NODE_IMAGE` 指向对应架构的标签。
- **推送权限**：`build-and-push.sh` 需要目标命名空间内存在一个有推送权限的 dockerconfigjson Secret（默认名 `registry-credentials`，可用 `CRED_SECRET` 覆盖）。只读凭证不能用于推送。
- **Cookie 的 Secure 标记**：当负载均衡/网关不向 Ingress 传递 `X-Forwarded-Proto` 时，服务无法自动判断请求是 HTTPS。此时显式设置 `AIMONITOR_SECURE_COOKIE=1`（Deployment 中已给出示例）。
