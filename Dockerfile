# 基础镜像可用 --build-arg NODE_IMAGE=... 覆盖：
#  - 公共 Docker Hub：node:20-alpine（多架构，默认）
#  - 内网私有仓库：改成你自己的地址，必要时显式指定架构标签（如 node:20-alpine-amd64）
ARG NODE_IMAGE=node:20-alpine
FROM ${NODE_IMAGE}

ENV NODE_ENV=production \
    AIMONITOR_HOST=0.0.0.0 \
    AIMONITOR_PORT=8787 \
    AIMONITOR_DATA=/app/data

WORKDIR /app

COPY package.json ./
COPY server.js ./
COPY src ./src
COPY public ./public

RUN mkdir -p /app/data && chown -R node:node /app

USER node

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.AIMONITOR_PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
