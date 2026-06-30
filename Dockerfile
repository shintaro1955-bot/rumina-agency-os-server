# Rumina 代理店開拓OS — 本番サーバー(アプリ＋API＋DB 同梱)
FROM node:20-slim

# better-sqlite3 のビルドに必要(prebuilt が無い場合の保険)
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .

ENV NODE_ENV=production
ENV PORT=8080
# SQLite の保存先(永続ディスクにマウントする)
ENV DB_FILE=/data/rumina.db
EXPOSE 8080
CMD ["node", "server.js"]
