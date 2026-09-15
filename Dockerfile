FROM node:20-alpine

# 零依赖服务，不需要 npm install
WORKDIR /app

COPY server.js config.json ./
COPY public ./public

ENV PORT=18080
EXPOSE 18080

# config.json 建议用卷挂载出来，界面保存才能落到宿主机
CMD ["node", "server.js"]
