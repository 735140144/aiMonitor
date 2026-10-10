# 集群节点是 amd64，仓库里 node:20-alpine 实际是 arm64 架构，因此固定使用 amd64 标签。
FROM hub.luckydcms.com/library/node:20-alpine-amd64

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
