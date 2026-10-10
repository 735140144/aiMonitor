#!/usr/bin/env bash
# 在没有本地 Docker 的环境里，用集群内的 docker:dind Pod 构建并推送镜像。
#
#   ./deploy/build-and-push.sh [tag]
#
# 依赖：kubectl 已指向目标集群；etl 命名空间内存在 harbor-registry 拉取凭证。
set -euo pipefail

NAMESPACE="${NAMESPACE:-etl}"
REGISTRY="${REGISTRY:-hub.luckydcms.com/library}"
IMAGE="${REGISTRY}/ai-monitor"
TAG="${1:-$(date +%Y%m%d-%H%M%S)}"
BUILDER="ai-monitor-builder"
# 推送凭证：hub 是拥有 library 项目写权限的账号，harbor-registry 为只读机器人账号。
CRED_SECRET="${CRED_SECRET:-hub}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cleanup() {
  kubectl delete pod "${BUILDER}" -n "${NAMESPACE}" --ignore-not-found --wait=false >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "==> 启动构建 Pod (${BUILDER})"
kubectl delete pod "${BUILDER}" -n "${NAMESPACE}" --ignore-not-found --wait=true >/dev/null 2>&1 || true
cat <<YAML | kubectl apply -f -
apiVersion: v1
kind: Pod
metadata:
  name: ${BUILDER}
  namespace: ${NAMESPACE}
  labels:
    app.kubernetes.io/name: ai-monitor-builder
spec:
  restartPolicy: Never
  containers:
    - name: dind
      image: hub.luckydcms.com/library/docker:28-dind-20260808
      securityContext:
        privileged: true
      command: ["dockerd-entrypoint.sh"]
      args: ["--host=unix:///var/run/docker.sock"]
      volumeMounts:
        - name: docker-storage
          mountPath: /var/lib/docker
        - name: registry-cred
          mountPath: /root/.docker/config.json
          subPath: .dockerconfigjson
  volumes:
    - name: docker-storage
      emptyDir: {}
    - name: registry-cred
      secret:
        secretName: ${CRED_SECRET}
YAML

kubectl wait --for=condition=Ready "pod/${BUILDER}" -n "${NAMESPACE}" --timeout=180s

echo "==> 等待 Docker Daemon"
for _ in $(seq 1 60); do
  if kubectl exec -n "${NAMESPACE}" "${BUILDER}" -- docker info >/dev/null 2>&1; then break; fi
  sleep 2
done
kubectl exec -n "${NAMESPACE}" "${BUILDER}" -- docker info >/dev/null

echo "==> 上传构建上下文"
kubectl exec -n "${NAMESPACE}" "${BUILDER}" -- mkdir -p /workspace
tar -C "${ROOT_DIR}" -czf - \
  --exclude ./data \
  --exclude ./node_modules \
  --exclude ./.git \
  --exclude './deploy' \
  Dockerfile .dockerignore package.json server.js src public \
  | kubectl exec -i -n "${NAMESPACE}" "${BUILDER}" -- tar -xzf - -C /workspace

echo "==> docker build ${IMAGE}:${TAG}"
kubectl exec -n "${NAMESPACE}" "${BUILDER}" -- \
  docker build --pull --platform linux/amd64 -t "${IMAGE}:${TAG}" -t "${IMAGE}:latest" /workspace

echo "==> docker push"
kubectl exec -n "${NAMESPACE}" "${BUILDER}" -- docker push "${IMAGE}:${TAG}"
kubectl exec -n "${NAMESPACE}" "${BUILDER}" -- docker push "${IMAGE}:latest"

echo
echo "构建完成：${IMAGE}:${TAG}"
echo "更新 Deployment："
echo "  kubectl -n ${NAMESPACE} set image deployment/ai-monitor ai-monitor=${IMAGE}:${TAG}"
