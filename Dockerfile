FROM node:20-slim

WORKDIR /app

# better-sqlite3 安装时需从源码编译，slim 镜像默认不带工具链，先装好
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# 先装依赖，利用 Docker 层缓存
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

ENV PORT=3000 \
    DATA_DIR=/app/data \
    NODE_ENV=production

EXPOSE 3000

VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://localhost:' + (process.env.PORT || 3000) + '/api/health').then(r => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))"

CMD ["npm", "start"]
