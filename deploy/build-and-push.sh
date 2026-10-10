#!/usr/bin/env bash
# 在没有本地 Docker 的环境里，用集群内的 docker:dind Pod 构建并推送镜像。
#
#   ./deploy/build-and-push.sh [tag]
#
# 依赖：kubectl 已指向目标集群；目标命名空间内存在镜像仓库的 dockerconfigjson 凭证。
#
# 可用环境变量覆盖：
#   NAMESPACE=ai-monitor              目标命名空间
#   REGISTRY=registry.example.com/library   镜像仓库前缀
#   CRED_SECRET=registry-credentials  含推送权限的 dockerconfigjson Secret 名
#   DIND_IMAGE=docker:28-dind         构建用 dind 镜像
set -euo pipefail

NAMESPACE="${NAMESPACE:-ai-monitor}"
REGISTRY="${REGISTRY:-registry.example.com/library}"
IMAGE="${REGISTRY}/ai-monitor"
TAG="${1:-$(date +%Y%m%d-%H%M%S)}"
BUILDER="ai-monitor-builder"
CRED_SECRET="${CRED_SECRET:-registry-credentials}"
DIND_IMAGE="${DIND_IMAGE:-docker:28-dind}"
PLATFORM="${PLATFORM:-linux/amd64}"
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
      image: ${DIND_IMAGE}
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
  docker build --pull --platform "${PLATFORM}" -t "${IMAGE}:${TAG}" -t "${IMAGE}:latest" /workspace

echo "==> docker push"
kubectl exec -n "${NAMESPACE}" "${BUILDER}" -- docker push "${IMAGE}:${TAG}"
kubectl exec -n "${NAMESPACE}" "${BUILDER}" -- docker push "${IMAGE}:latest"

echo
echo "构建完成：${IMAGE}:${TAG}"
echo "更新 Deployment："
echo "  kubectl -n ${NAMESPACE} set image deployment/ai-monitor ai-monitor=${IMAGE}:${TAG}"
