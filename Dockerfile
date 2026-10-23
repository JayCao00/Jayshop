FROM node:20-slim

WORKDIR /app

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
