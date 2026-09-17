FROM node:20-alpine

# 零依赖服务，不需要 npm install
WORKDIR /app

# config.example.json 是入库的示例；config.json 是运行数据（不入库），
# 容器启动时若没有它，server.js 会自动从 config.example.json 复制一份。
# 所以这里只 COPY 示例，不 COPY config.json —— 后者应由卷挂载提供
# （见 docker-compose.yml；界面里改的规则要落到宿主机就得挂出来）。
COPY server.js config.example.json ./
COPY public ./public
COPY lib ./lib

ENV PORT=18080
# 只读分享端口：启用时加 -e READONLY_PORT=18081（容器内必须与 PORT 不同）。
# EXPOSE 只是声明「这个镜像会用这两个端口」，不会真的开放；真正暴露靠 -p / compose 的 ports。
# 需要分享链接又在用 docker compose 时，用 ./deploy.sh <user>@<host> -m docker -r <宿主机端口>
# 生成叠加文件，别手改 docker-compose.yml（见该文件里的注释）。
EXPOSE 18080 18081

# 界面保存的配置要落到宿主机，就得把 config.json 卷挂载出来（见 docker-compose.yml）
CMD ["node", "server.js"]
