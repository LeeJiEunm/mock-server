#!/usr/bin/env bash
#
# 一键部署：把零依赖的挡板服务装到远端机器并拉起
# （不需要 npm install，整个服务只用 Node 内置模块）
#
# 用法：
#   ./deploy.sh <user@host> [选项]
#
# 选项：
#   -d, --dir  <路径>   远端安装目录（默认 /opt/mock-server）
#   -p, --port <端口>   监听端口（默认 18080）
#   -r, --readonly-port <端口>
#                       只读隔离端口（默认不启用）。免密部署必须配它才允许生成
#                       分享链接；分享 URL 会指向这个端口，对方去掉 ?share= 也只读。
#   -m, --mode <模式>   systemd | plain | docker（默认自动判断，优先 systemd）
#   -f, --force         连 config.json 一起覆盖
#                       （默认保留远端已有的 config.json —— 那是你配好的规则，别冲掉）
#   -h, --help          显示本帮助
#
# 例子：
#   ./deploy.sh root@<HOST_IP>
#   ./deploy.sh root@<HOST_IP> -p 18081
#   ./deploy.sh root@<HOST_IP> -d /data/mock-server -p 9090
#   ./deploy.sh root@<HOST_IP> -r 18081                # 免密 + 只读端口 18081
#   ./deploy.sh root@<HOST_IP> -m docker -p 7773 -d <INSTALL_DIR>
#     ↑ 机器上没装 node 时走容器：宿主机不用有 node，容器里自带
#
set -euo pipefail

LOCAL_DIR="$(cd "$(dirname "$0")" && pwd)"
TARGET=""
REMOTE_DIR="/opt/mock-server"
PORT="18080"
MODE="auto"
FORCE_CONFIG="no"
SERVICE_NAME="mock-server"
# 只读隔离端口：命令行 -r/--readonly-port 优先，其次环境变量 READONLY_PORT；空=不启用
RO_PORT="${READONLY_PORT:-}"
# 容器方式下「容器内」的只读端口（容器内主端口固定 18080，只读端口必须与它不同）
CONTAINER_RO_PORT="18081"
# 控制台登录：MOCK_ADMIN_PASS 给了才开启；MOCK_ADMIN_USER 不给则默认 admin
ADMIN_USER="${MOCK_ADMIN_USER:-admin}"
ADMIN_PASS="${MOCK_ADMIN_PASS:-}"

usage() {
  cat <<'USAGE'
用法：./deploy.sh <user@host> [选项]

选项：
  -d, --dir  <路径>   远端安装目录（默认 /opt/mock-server）
  -p, --port <端口>   监听端口（默认 18080）
  -r, --readonly-port <端口>
                      只读隔离端口（默认不启用；免密部署配它才允许生成分享链接）
  -m, --mode <模式>   systemd | plain | docker（默认自动判断）
  -f, --force         连 config.json 一起覆盖（默认保留远端的）
                      环境变量 MOCK_ADMIN_PASS 可启用控制台登录保护
  -h, --help          显示本帮助

例子：
  ./deploy.sh root@<HOST_IP>
  ./deploy.sh root@<HOST_IP> -p 18081
  ./deploy.sh root@<HOST_IP> -d /data/mock-server -p 9090
  ./deploy.sh root@<HOST_IP> -r 18081
    ↑ 免密部署 + 只读端口 18081：分享链接走 18081，去掉 ?share= 也只读
  ./deploy.sh root@<HOST_IP> -m docker -p 7773 -d <INSTALL_DIR>
    ↑ 机器上没装 node 时用容器（宿主机不需要 node）
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    -d|--dir)   REMOTE_DIR="${2:?--dir 后面要跟目录}"; shift 2 ;;
    -p|--port)  PORT="${2:?--port 后面要跟端口}"; shift 2 ;;
    -r|--readonly-port) RO_PORT="${2:?--readonly-port 后面要跟端口}"; shift 2 ;;
    -m|--mode)  MODE="${2:?--mode 后面要跟模式}"; shift 2 ;;
    -f|--force) FORCE_CONFIG="yes"; shift ;;
    -h|--help)  usage; exit 0 ;;
    -*)         echo "未知选项：$1"; echo; usage; exit 1 ;;
    *)          TARGET="$1"; shift ;;
  esac
done

if [ -z "$TARGET" ]; then
  echo "缺少目标机器（形如 root@<HOST_IP>）"; echo
  usage
  exit 1
fi

case "$PORT" in
  ''|*[!0-9]*) echo "端口必须是数字：$PORT"; exit 1 ;;
esac
if [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
  echo "端口超出范围（1-65535）：$PORT"; exit 1
fi

# 只读端口：空=不启用（记 0）。给了就校验，且不能和主端口相同——
# 相同的话 server.js 会静默不启用只读监听（`RO_PORT !== port` 守卫），部署出来看着成功实际没隔离。
if [ -z "$RO_PORT" ]; then
  RO_PORT="0"
else
  case "$RO_PORT" in
    *[!0-9]*) echo "只读端口必须是数字：$RO_PORT"; exit 1 ;;
  esac
  if [ "$RO_PORT" -lt 1 ] || [ "$RO_PORT" -gt 65535 ]; then
    echo "只读端口超出范围（1-65535）：$RO_PORT"; exit 1
  fi
  if [ "$RO_PORT" -eq "$PORT" ]; then
    echo "只读端口不能和主端口相同（都是 ${PORT}）：相同则不启用只读隔离，分享链接会指向可编辑的主端口。"
    exit 1
  fi
fi

# 免密部署（没给 MOCK_ADMIN_PASS）却没配只读端口：分享功能会被服务端 403 挡住，
# 这里提前提醒，省得部署完在界面上点分享才发现。
if [ -z "$ADMIN_PASS" ] && [ "$RO_PORT" = "0" ]; then
  echo "!! 免密部署但未指定只读端口：控制台任何人都能改规则，且「生成分享链接」会被拒绝（403）。"
  echo "   要免密 + 可分享，请带 -r <端口>（例：-r 18081）；要控制访问，请带 MOCK_ADMIN_PASS。"
  echo "   继续部署（Ctrl+C 可中断）..."
  sleep 3
fi

HOST="${TARGET#*@}"

# SSH 连接复用：第一次认证后开主连接，后续 ssh/scp 全部复用，
# 免密码 auth 下每条命令都重输密码（单次部署只输一次）。
mkdir -p "$HOME/.ssh"
SSH_SOCK="$HOME/.ssh/mock-deploy-%r@%h:%p"
SSH_OPTS="-o ControlMaster=auto -o ControlPath=$SSH_SOCK -o ControlPersist=120"

# ---------------------------------------------------------------- 1. 探测远端
echo "==> 1/7 探测远端环境：$TARGET"
REMOTE_ENV="$(ssh $SSH_OPTS "$TARGET" 'bash -s' <<'REMOTE_PROBE'
NODE_BIN="$(command -v node 2>/dev/null || true)"
NODE_VER=""
[ -n "$NODE_BIN" ] && NODE_VER="$("$NODE_BIN" -v 2>/dev/null || echo unknown)"
HAS_SYSTEMD=no
[ -d /run/systemd/system ] && HAS_SYSTEMD=yes
HAS_DOCKER=no
command -v docker >/dev/null 2>&1 && HAS_DOCKER=yes
# compose 有两代命令行：v2 是 docker 的子命令 `docker compose`，v1 是独立的 `docker-compose`
COMPOSE_KIND=none
if docker compose version >/dev/null 2>&1; then
  COMPOSE_KIND=v2
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE_KIND=v1
fi
RUN_USER="$(whoami)"
echo "NODE_BIN=$NODE_BIN"
echo "NODE_VER=$NODE_VER"
echo "HAS_SYSTEMD=$HAS_SYSTEMD"
echo "HAS_DOCKER=$HAS_DOCKER"
echo "COMPOSE_KIND=$COMPOSE_KIND"
echo "RUN_USER=$RUN_USER"
REMOTE_PROBE
)"
eval "$REMOTE_ENV"

# 先决定用哪种方式装，再按方式决定"要不要 node"。
# docker 方式不需要宿主机装 node（node 在容器里），所以模式判断必须排在 node 检查前面，
# 否则「没 node 的机器想用 docker」会被 node 检查直接拦死。
if [ "$MODE" = "auto" ]; then
  if [ -z "${NODE_BIN:-}" ] && [ "$HAS_DOCKER" = "yes" ]; then
    MODE="docker"          # 宿主机没 node，只能走容器
  elif [ "$HAS_SYSTEMD" = "yes" ]; then
    MODE="systemd"
  elif [ "$HAS_DOCKER" = "yes" ]; then
    MODE="docker"
  else
    MODE="plain"
  fi
fi

# 统一成一条命令：v2 用 `docker compose`，v1 用 `docker-compose`
case "${COMPOSE_KIND:-none}" in
  v2) COMPOSE_CMD="docker compose" ;;
  v1) COMPOSE_CMD="docker-compose" ;;
  *)  COMPOSE_CMD="" ;;
esac

if [ "$MODE" = "docker" ]; then
  if [ "$HAS_DOCKER" != "yes" ]; then
    echo "!! 指定了 docker 方式，但远端没有 docker 命令"
    echo "    装好 docker 再试；或去掉 -m docker 让脚本自动选（systemd/plain 需要 node）"
    exit 1
  fi
  if [ "${COMPOSE_KIND:-none}" = "none" ]; then
    echo "!! 远端有 docker，但 compose 用不了（docker compose / docker-compose 都没有）"
    echo "    CentOS: yum install -y docker-compose，或把 docker 升到自带 compose v2 的版本"
    exit 1
  fi
  if [ -n "${NODE_BIN:-}" ]; then
    echo "    node   : $NODE_BIN  ($NODE_VER)  [docker 方式不需要，仅记录]"
  else
    echo "    node   : 宿主机未安装  [docker 方式不需要，node 在容器里]"
  fi
else
  if [ -z "${NODE_BIN:-}" ]; then
    echo "!! 远端没有 node。装一个再来（本服务需要 Node >= 16）："
    echo "     CentOS 7（glibc 2.17，装不了 18 以上）——用 16.x 的 tar 包，不碰 yum："
    echo "        cd /tmp && curl -LO https://npmmirror.com/mirrors/node/v16.20.2/node-v16.20.2-linux-x64.tar.xz"
    echo "        mkdir -p /usr/local/nodejs && tar -xf node-v16.20.2-linux-x64.tar.xz -C /usr/local/nodejs --strip-components=1"
    echo "        ln -sf /usr/local/nodejs/bin/node /usr/local/bin/node"
    echo "        ln -sf /usr/local/nodejs/bin/npm  /usr/local/bin/npm"
    echo "     CentOS 8+ / Ubuntu：yum install -y nodejs  或  apt install -y nodejs"
    echo "   或者改用容器（宿主机不用装 node）：./deploy.sh $TARGET -m docker"
    exit 1
  fi
  NODE_MAJOR="${NODE_VER#v}"
  NODE_MAJOR="${NODE_MAJOR%%.*}"
  case "$NODE_MAJOR" in ''|*[!0-9]*) NODE_MAJOR=0 ;; esac
  # 下限取 16 而不是 18：Node 18+ 的官方二进制要求 glibc >= 2.28，
  # CentOS 7 是 2.17，装了只会报 "GLIBC_2.28 not found"；
  # 而本服务只用 Node 内置模块，实测在 Node 14 上就能完整跑，所以 16 这个下限安全且够用。
  if [ "$NODE_MAJOR" -lt 16 ]; then
    echo "!! 远端 node 不可用或版本过低（${NODE_VER}），本服务需要 >= 16"
    echo "   如果是在 glibc 老系统（CentOS 7）上装了 18+ 的包，会报 GLIBC_2.28 not found ——"
    echo "   先删掉软链：rm -f /usr/local/bin/node /usr/local/bin/npm && rm -rf /usr/local/nodejs"
    echo "   再按上面的 16.x tar 包方式重装。"
    exit 1
  fi
  echo "    node   : $NODE_BIN  ($NODE_VER)"
fi

echo "    运行用户: $RUN_USER"
echo "    安装方式: ${MODE}（systemd=$HAS_SYSTEMD  docker=${HAS_DOCKER}）"
if [ "$MODE" = "docker" ]; then
  echo "    compose: $COMPOSE_CMD"
fi

SUDO=""
[ "$RUN_USER" != "root" ] && SUDO="sudo "

# ------------------------------------------------- 2. 停掉旧实例（升级场景）
echo "==> 2/7 停掉可能存在的旧实例"
if [ "$MODE" = "systemd" ]; then
  ssh $SSH_OPTS "$TARGET" "${SUDO}systemctl stop $SERVICE_NAME >/dev/null 2>&1 || true"
elif [ "$MODE" = "plain" ]; then
  ssh $SSH_OPTS "$TARGET" "pkill -f 'node .*server\.js' >/dev/null 2>&1 || true"
elif [ "$MODE" = "docker" ]; then
  ssh $SSH_OPTS "$TARGET" "cd '$REMOTE_DIR' 2>/dev/null && $SUDO $COMPOSE_CMD down >/dev/null 2>&1 || true"
fi
sleep 1

# --------------------------------------------------------------- 3. 端口检查
# 主端口 + 只读端口都要查：只读端口被占时 server.js 只在日志里打一行错误，
# 部署脚本会以为成功（界面正常但分享链接打不开），所以这里必须先拦住。
CHECK_PORTS="$PORT"
[ "$RO_PORT" != "0" ] && CHECK_PORTS="$PORT $RO_PORT"
for p in $CHECK_PORTS; do
  if ssh $SSH_OPTS "$TARGET" "(ss -lnt 2>/dev/null || netstat -lnt 2>/dev/null) | grep -qE '[:.]$p[[:space:]]'"; then
    echo "!! 远端 $p 已被别的进程占用："
    ssh $SSH_OPTS "$TARGET" "(ss -lntp 2>/dev/null || netstat -lntp 2>/dev/null) | grep -E '[:.]$p[[:space:]]' || true"
    if [ "$p" = "$PORT" ]; then
      echo "   换一个端口（例如 -p 18081），或先停掉占用它的进程。"
    else
      echo "   只读端口被占：换一个（例如 -r 3778），或先停掉占用它的进程。"
    fi
    exit 1
  fi
done
if [ "$RO_PORT" != "0" ]; then
  echo "    端口 ${PORT}（主）/ ${RO_PORT}（只读）均可用"
else
  echo "    端口 $PORT 可用"
fi

# ------------------------------------------------------------------- 4. 上传
echo "==> 3/7 上传文件 -> $TARGET:$REMOTE_DIR"
ssh $SSH_OPTS "$TARGET" "mkdir -p '$REMOTE_DIR'"
scp $SSH_OPTS -q "$LOCAL_DIR/server.js" "$TARGET:$REMOTE_DIR/server.js"
scp $SSH_OPTS -qr "$LOCAL_DIR/public" "$TARGET:$REMOTE_DIR/"
scp $SSH_OPTS -qr "$LOCAL_DIR/lib" "$TARGET:$REMOTE_DIR/"
# config.example.json 必须一起传：远端缺 config.json 时由 server.js 复制它来生成，
# docker 模式的 Dockerfile 也要 COPY 它（不传的话 docker 构建会直接失败）。
[ -f "$LOCAL_DIR/config.example.json" ] && scp $SSH_OPTS -q "$LOCAL_DIR/config.example.json" "$TARGET:$REMOTE_DIR/config.example.json"
[ -f "$LOCAL_DIR/README.md" ] && scp $SSH_OPTS -q "$LOCAL_DIR/README.md" "$TARGET:$REMOTE_DIR/README.md"
# 带上用户管理脚本：远端可直接 `cd $REMOTE_DIR && node tools/add-user.js 用户名 密码`
ssh $SSH_OPTS "$TARGET" "mkdir -p '$REMOTE_DIR/tools'"
scp $SSH_OPTS -qr "$LOCAL_DIR/tools/lib" "$TARGET:$REMOTE_DIR/tools/"
for f in add-user.js gen-pass.js; do
  [ -f "$LOCAL_DIR/tools/$f" ] && scp $SSH_OPTS -q "$LOCAL_DIR/tools/$f" "$TARGET:$REMOTE_DIR/tools/$f"
done
echo "    server.js / lib / public / tools 已同步"

# config.json 默认不覆盖：远端那份是你在界面上配好的规则
# 本地可能压根没有 config.json（它是运行数据、不入库），那就先拿示例顶上。
LOCAL_CONFIG="$LOCAL_DIR/config.json"
if [ ! -f "$LOCAL_CONFIG" ]; then
  LOCAL_CONFIG="$LOCAL_DIR/config.example.json"
  echo "    本地没有 config.json，改用 config.example.json（示例数据）"
fi
if [ "$FORCE_CONFIG" = "yes" ] || ! ssh $SSH_OPTS "$TARGET" "test -f '$REMOTE_DIR/config.json'"; then
  scp $SSH_OPTS -q "$LOCAL_CONFIG" "$TARGET:$REMOTE_DIR/config.json"
  echo "    config.json 已写入"
else
  echo "    config.json 远端已存在 -> 保留不动（要强制覆盖加 -f）"
fi

# ------------------------------------------------------------------- 5. 安装
echo "==> 4/7 安装并启动（模式：${MODE}）"

if [ "$MODE" = "systemd" ]; then
  SERVICE_TMP="$(mktemp)"
  cat > "$SERVICE_TMP" <<EOF
[Unit]
Description=Mock Server - 带界面的动态挡板服务
Documentation=file:$REMOTE_DIR/README.md
After=network.target
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
WorkingDirectory=$REMOTE_DIR
Environment=PORT=$PORT
EOF
  [ -n "$ADMIN_PASS" ] && cat >> "$SERVICE_TMP" <<EOF
Environment=MOCK_ADMIN_PASS=$ADMIN_PASS
EOF
  [ "$RO_PORT" != "0" ] && cat >> "$SERVICE_TMP" <<EOF
Environment=READONLY_PORT=$RO_PORT
EOF
  cat >> "$SERVICE_TMP" <<EOF
ExecStart=$NODE_BIN $REMOTE_DIR/server.js
Restart=always
RestartSec=3
User=$RUN_USER

[Install]
WantedBy=multi-user.target
EOF
  ssh $SSH_OPTS "$TARGET" "cat > /tmp/$SERVICE_NAME.service" < "$SERVICE_TMP"
  rm -f "$SERVICE_TMP"
  ssh $SSH_OPTS "$TARGET" "${SUDO}mv /tmp/$SERVICE_NAME.service /etc/systemd/system/$SERVICE_NAME.service"
  ssh $SSH_OPTS "$TARGET" "${SUDO}systemctl daemon-reload"
  ssh $SSH_OPTS "$TARGET" "${SUDO}systemctl enable $SERVICE_NAME >/dev/null 2>&1"
  ssh $SSH_OPTS "$TARGET" "${SUDO}systemctl restart $SERVICE_NAME"

elif [ "$MODE" = "plain" ]; then
  # 没有 systemd：nohup 起，配 crontab @reboot 才能开机自启
  ssh $SSH_OPTS "$TARGET" "cd '$REMOTE_DIR' && MOCK_ADMIN_USER='$ADMIN_USER' MOCK_ADMIN_PASS='$ADMIN_PASS' PORT=$PORT READONLY_PORT=$RO_PORT nohup '$NODE_BIN' server.js > mock-server.log 2>&1 & sleep 1; echo '   已后台启动（日志：$REMOTE_DIR/mock-server.log）'"
  ssh $SSH_OPTS "$TARGET" "(crontab -l 2>/dev/null | grep -v '$REMOTE_DIR/server.js'; echo '@reboot cd $REMOTE_DIR && MOCK_ADMIN_USER=$ADMIN_USER MOCK_ADMIN_PASS=$ADMIN_PASS PORT=$PORT READONLY_PORT=$RO_PORT $NODE_BIN server.js >> mock-server.log 2>&1') | crontab -" 
  echo "   已写入 crontab @reboot（开机自启）"

elif [ "$MODE" = "docker" ]; then
  # 这里不要再传 config.json：第 4 步已按「远端存在则保留」处理过，
  # 在这里无条件覆盖会把用户在界面上配好的规则冲掉。
  # build 上下文就是 $REMOTE_DIR，Dockerfile 里 COPY 的 server.js / config.example.json / public 都在。
  for f in Dockerfile docker-compose.yml; do
    [ -f "$LOCAL_DIR/$f" ] && scp $SSH_OPTS -q "$LOCAL_DIR/$f" "$TARGET:$REMOTE_DIR/$f"
  done
  # 只读端口：容器内主端口固定 18080，只读端口用 18081，宿主机端口靠端口映射暴露。
  # 用「叠加 compose 文件」而不是给 docker-compose.yml 硬加一行——
  # 硬加的话未启用只读端口时会出现 `0:18081`（随机宿主机端口），反而添乱。
  COMPOSE_FILES="-f docker-compose.yml"
  if [ "$RO_PORT" != "0" ]; then
    RO_OVERRIDE_TMP="$(mktemp)"
    cat > "$RO_OVERRIDE_TMP" <<EOF
# deploy.sh 自动生成：只读隔离端口叠加配置（请勿手改，重跑 ./deploy.sh 会覆盖）
services:
  mock-server:
    ports:
      - "\${MOCK_RO_PORT:-$RO_PORT}:$CONTAINER_RO_PORT"
    environment:
      - READONLY_PORT=$CONTAINER_RO_PORT
EOF
    scp $SSH_OPTS -q "$RO_OVERRIDE_TMP" "$TARGET:$REMOTE_DIR/docker-compose.readonly.yml"
    rm -f "$RO_OVERRIDE_TMP"
    COMPOSE_FILES="$COMPOSE_FILES -f docker-compose.readonly.yml"
  else
    # 上次部署可能留了叠加文件；本次没开只读端口，去掉它避免以后手跑 compose 时被自动带上
    ssh $SSH_OPTS "$TARGET" "rm -f '$REMOTE_DIR/docker-compose.readonly.yml'" || true
  fi
  ssh $SSH_OPTS "$TARGET" "cd '$REMOTE_DIR' && MOCK_ADMIN_USER='$ADMIN_USER' MOCK_ADMIN_PASS='$ADMIN_PASS' MOCK_PORT=$PORT MOCK_RO_PORT=$RO_PORT $SUDO $COMPOSE_CMD $COMPOSE_FILES up -d --build"
fi

# --------------------------------------------------------------- 6. 健康检查
echo "==> 5/7 健康检查"
HEALTH_OK="no"
# 注意：开了控制台登录（MOCK_ADMIN_USER/MOCK_ADMIN_PASS 或 config.json 的 users）时，
# /_admin/health 会返回 401 —— 那说明「服务活着，只是需要登面板」，同样算就绪。
for _ in 1 2 3 4 5 6 7 8 9 10; do
  CODE="$(ssh $SSH_OPTS "$TARGET" "command -v curl >/dev/null 2>&1 && curl -sS -o /dev/null -m 3 -w '%{http_code}' http://127.0.0.1:$PORT/_admin/health 2>/dev/null || true")"
  case "$CODE" in
    200|401) HEALTH_OK="yes"; break ;;
  esac
  sleep 1
done

if [ "$HEALTH_OK" = "yes" ]; then
  if [ "$CODE" = "401" ]; then
    echo "    服务已就绪（控制台已开启登录保护，未登录访问 /_admin/health 返回 401 属正常）"
  else
    echo "    服务已就绪"
    ssh $SSH_OPTS "$TARGET" "command -v curl >/dev/null 2>&1 && curl -fsS -m 3 http://127.0.0.1:$PORT/_admin/health" || true
  fi
  echo
else
  echo "    !! 健康检查没通过。已尝试抓取最近日志："
  if [ "$MODE" = "systemd" ]; then
    echo "    --- systemctl status ---"
    ssh $SSH_OPTS "$TARGET" "${SUDO}systemctl status $SERVICE_NAME -l --no-pager | head -60 || true"
    echo "    --- journalctl 最近 50 行 ---"
    ssh $SSH_OPTS "$TARGET" "${SUDO}journalctl -u $SERVICE_NAME -n 50 --no-pager || true"
    echo "    --- 排查命令 ---"
    echo "       ssh $TARGET '${SUDO}systemctl status $SERVICE_NAME -l --no-pager'"
    echo "       ssh $TARGET '${SUDO}journalctl -u $SERVICE_NAME -n 50 --no-pager'"
  elif [ "$MODE" = "docker" ]; then
    echo "    --- compose ps ---"
    ssh $SSH_OPTS "$TARGET" "cd '$REMOTE_DIR' && ${SUDO}${COMPOSE_CMD} ps || true"
    echo "    --- compose logs 最近 50 行 ---"
    ssh $SSH_OPTS "$TARGET" "cd '$REMOTE_DIR' && ${SUDO}${COMPOSE_CMD} logs --tail=50 || true"
    echo "       ssh $TARGET 'cd $REMOTE_DIR && ${SUDO}${COMPOSE_CMD} ps'"
    echo "       ssh $TARGET 'cd $REMOTE_DIR && ${SUDO}${COMPOSE_CMD} logs --tail=50'"
    echo "     常见原因：宿主机拉不到 node:20-alpine 镜像（内网需先 docker load 离线包）"
  else
    echo "    --- mock-server.log 最近 50 行 ---"
    ssh $SSH_OPTS "$TARGET" "tail -50 '$REMOTE_DIR/mock-server.log' || true"
    echo "       ssh $TARGET 'tail -50 $REMOTE_DIR/mock-server.log'"
  fi
fi

# --------------------------------------------------------------- 7. 防火墙
echo "==> 6/7 放行端口"
FIREWALL_PORTS="$PORT"
[ "$RO_PORT" != "0" ] && FIREWALL_PORTS="$PORT $RO_PORT"
ssh $SSH_OPTS "$TARGET" "if command -v firewall-cmd >/dev/null 2>&1 && systemctl is-active firewalld >/dev/null 2>&1; then for p in $FIREWALL_PORTS; do firewall-cmd --add-port=\$p/tcp --permanent >/dev/null && echo '    firewalld 已放行 '\$p'/tcp'; done; firewall-cmd --reload >/dev/null; else echo '    （没启用 firewalld，跳过）'; fi"

echo "==> 7/7 完成"
cat <<EOF

  管理界面     http://$HOST:$PORT/
  服务根地址   http://$HOST:$PORT
  接口调用格式 http://$HOST:$PORT/{模块}/{接口路径}
  举例         http://$HOST:$PORT/demo/sample

  改规则        界面里改完点保存 -> 立刻生效，不用重启
EOF

if [ "$RO_PORT" != "0" ]; then
  cat <<EOF
  只读端口      http://$HOST:$RO_PORT/
                （分享链接专用：访问者去掉 URL 上的 ?share= 也是只读，露出不了可编辑主端口）
  生成分享      管理界面右上角「分享」图标 -> 填写备注 -> 生成
EOF
else
  cat <<EOF
  只读端口      未启用（未配置 READONLY_PORT）
EOF
fi

if [ -n "$ADMIN_PASS" ]; then
  cat <<EOF
  控制台登录    已开启，账号 ${ADMIN_USER}（改账号/密码：改环境变量后重跑 ./deploy.sh）
EOF
else
  cat <<EOF
  控制台登录    未开启（面板任何人可访问）
EOF
  if [ "$RO_PORT" = "0" ]; then
    cat <<EOF
  !! 提醒       免密 + 无只读端口：界面上「生成分享链接」会被拒绝（403），
                且任何能访问 $PORT 的人都能改规则。建议重跑并带 -r <端口>。
EOF
  else
    cat <<EOF
  !! 提醒       免密部署下 $PORT 主端口无任何保护（能访问者即可改规则）——
                建议用防火墙把主端口限定到你/内网网段，只对测试同学放行 ${RO_PORT}。
EOF
  fi
fi

# 后续运维命令按安装方式给：docker 部署没有 systemd 服务，不能照抄 systemctl
if [ "$MODE" = "systemd" ]; then
  cat <<EOF
  重启服务      ssh $TARGET '${SUDO}systemctl restart $SERVICE_NAME'
  开机自启      ssh $TARGET 'systemctl is-enabled $SERVICE_NAME'
  看日志        ssh $TARGET '${SUDO}journalctl -u $SERVICE_NAME -n 50 --no-pager'
EOF
elif [ "$MODE" = "docker" ]; then
  cat <<EOF
  重启服务      ssh $TARGET 'cd $REMOTE_DIR && ${SUDO}${COMPOSE_CMD} $COMPOSE_FILES up -d --build'
  开机自启      容器的 restart 策略是 unless-stopped，宿主机重启后会自动拉起
  看日志        ssh $TARGET 'cd $REMOTE_DIR && ${SUDO}${COMPOSE_CMD} logs -f --tail=50'
EOF
else
  cat <<EOF
  重启服务      ssh $TARGET 'pkill -f "[s]erver.js"; cd $REMOTE_DIR && PORT=$PORT READONLY_PORT=$RO_PORT nohup $NODE_BIN server.js >> mock-server.log 2>&1 &'
  开机自启      已写入 crontab @reboot（ssh $TARGET 'crontab -l' 可查）
  看日志        ssh $TARGET 'tail -f $REMOTE_DIR/mock-server.log'
EOF
fi

# 关闭 SSH 复用主连接（不强制）
ssh -O exit $SSH_OPTS "$TARGET" >/dev/null 2>&1 || true
