#!/usr/bin/env bash
#
# deploy.sh 本地沙盘自检：用「假 ssh / 假 scp / 假 firewall-cmd」把部署脚本完整跑一遍，
# 断言生成的远端配置里真的带上了预期参数（重点是 READONLY_PORT 只读端口），
# 并断言「默认不动远端 config.json」这条升级安全线（唯一例外是显式 -f）。
#
# 为什么需要它：deploy.sh 的产物（systemd 单元、compose 叠加文件、防火墙命令）只在远端存在，
# 改完脚本想验证就得真找一台机器登一次。这个沙盘把远端命令全部拦截并落到 $OUT 里，
# 直接在本地断言，**不碰任何真实服务器、不需要网络**。
#
# 用法：
#   tools/verify-deploy.sh                    # 先静态扫「变量紧跟全角字符」，再跑四个标准场景
#                                             #   systemd+18081 / docker+18081 / 不配只读端口 / 加 -f
#   tools/verify-deploy.sh systemd 18081       # 单场景：模式 systemd|docker，只读端口 18081|off
#   tools/verify-deploy.sh docker off          # 容器模式且不启用只读端口
#   tools/verify-deploy.sh systemd 18081 yes yes   # 第 4 个参数 = 加 -f（会覆盖 config.json）
#
# 产物（便于人工核对）：$OUT/{cmd.log, service.unit, docker-compose.readonly.yml, scp.log, deploy.log}
#   OUT 默认 ${TMPDIR:-/tmp}/mock-deploy-harness/out
#
set -uo pipefail

SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJ_DIR="$(cd "$SELF_DIR/.." && pwd)"
H="${TMPDIR:-/tmp}/mock-deploy-harness"
OUT="$H/out"
BIN="$H/bin"
PORT=18080

# ---------------------------------------------------------------- 沙盘搭建
setup() {
  rm -rf "$OUT" "$BIN"
  mkdir -p "$BIN" "$OUT"

  # 假 ssh：按远端命令原文分流。危险命令（systemctl / 装服务）一律不执行。
  cat > "$BIN/ssh" <<'EOF'
#!/usr/bin/env bash
OUT="${HARNESS_OUT:?}"
eval "cmd=\${$#}"
printf '%s\n' "$cmd" >> "$OUT/cmd.log"
case "$cmd" in
  *'bash -s'*) cat >/dev/null; cat "$HARNESS_PROBE"; exit 0 ;;
  *'cat > /tmp/mock-server.service'*) cat > "$OUT/service.unit"; exit 0 ;;
  *'ss -lnt'*|*'netstat -lnt'*) exit 1 ;;                        # 模拟端口空闲
  *_admin/health*) echo 200; exit 0 ;;
  *firewall-cmd*) PATH="$HARNESS_BIN:$PATH" bash -c "$cmd"; exit 0 ;;
  *systemctl*|*'/etc/systemd'*) exit 0 ;;
  *) exit 0 ;;
esac
EOF

  # 假 scp：把生成的 compose 叠加文件抄回来，便于断言端口映射
  cat > "$BIN/scp" <<'EOF'
#!/usr/bin/env bash
OUT="${HARNESS_OUT:?}"
eval "src=\${$(( $# - 1 ))}"
eval "dst=\${$#}"
printf 'scp %s -> %s\n' "$src" "$dst" >> "$OUT/scp.log"
case "$dst" in
  *docker-compose.readonly.yml*) cp "$src" "$OUT/docker-compose.readonly.yml" ;;
esac
exit 0
EOF

  cat > "$BIN/firewall-cmd" <<'EOF'
#!/usr/bin/env bash
echo "    firewalld 已放行(沙盘) $*"
EOF
  cat > "$BIN/systemctl" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
  chmod +x "$BIN"/*

  export HARNESS_OUT="$OUT" HARNESS_PROBE="$H/probe.txt" HARNESS_BIN="$BIN"
}

# 假远端探测输出：node=yes 走 systemd，node=no 走 docker
write_probe() {
  if [ "$1" = "yes" ]; then
    cat > "$H/probe.txt" <<'EOF'
NODE_BIN=/usr/local/nodejs/bin/node
NODE_VER=v16.20.2
HAS_SYSTEMD=yes
HAS_DOCKER=no
COMPOSE_KIND=none
RUN_USER=root
EOF
  else
    cat > "$H/probe.txt" <<'EOF'
NODE_BIN=
NODE_VER=
HAS_SYSTEMD=yes
HAS_DOCKER=yes
COMPOSE_KIND=v2
RUN_USER=root
EOF
  fi
}

# ------------------------------------------- 0. 全角变量静态自检（bash 3.2 locale 陷阱）
# `$VAR` 紧跟中文/全角标点（如 `$PORT（主）`）时，macOS 自带 bash 3.2 在 **UTF-8 locale**
# 下会把标点字节吞进变量名，直到运行时才报 `VAR?: unbound variable`（退出码 1）。
# 这种错误 `bash -n` 查不出、默认 C locale 也不复现，所以必须先静态拦住。
scan_wide_vars() {
  local hits
  hits="$(LC_ALL=C grep -nE '\$[A-Za-z_][A-Za-z0-9_]*[^ -~]|\$[0-9@*?#!$-][^ -~]' "$PROJ_DIR/deploy.sh" \
          | grep -vE '^[0-9]+:[[:space:]]*#' || true)"
  if [ -n "$hits" ]; then
    echo "FAIL deploy.sh 存在「变量紧跟全角字符」（UTF-8 locale 下会 unbound variable）："
    printf '%s\n' "$hits" | sed 's/^/       /'
    echo "       修法：写成 \${VAR}（如 \${PORT}）；特殊参数也要写 \${?}"
    return 1
  fi
  echo "OK   无「变量紧跟全角字符」（注释行不计）"
  return 0
}

# ---------------------------------------------------------------- 单场景
run_case() {
  local MODE="$1" RO="$2" NODE="$3" FORCE="${4:-no}" FAIL=0
  local ARGS=() EXPECT
  [ "$MODE" = "docker" ] && ARGS+=(-m docker)
  [ "$RO" != "off" ] && ARGS+=(-r "$RO")
  [ "$FORCE" = "yes" ] && ARGS+=(-f)

  setup
  write_probe "$NODE"
  echo "==== 场景：mode=$MODE readonly=$RO node=$NODE force=$FORCE ===="
  # 必须带 LANG=en_US.UTF-8 跑：全角字符紧跟变量（`$VAR（`）只在 UTF-8 locale 下才会被
  # bash 3.2 吞进变量名并报 unbound；默认 C locale 会漏过这类错误（沙箱里 LANG 常为空）。
  ( cd "$PROJ_DIR" && LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 PATH="$BIN:$PATH" ./deploy.sh root@192.0.2.10 ${ARGS[@]+"${ARGS[@]}"} ) > "$OUT/deploy.log" 2>&1
  echo "    deploy.sh 退出码=${?}（日志：${OUT}/deploy.log）"
  if grep -qE "unbound variable|command not found|syntax error" "$OUT/deploy.log"; then
    echo "FAIL deploy.sh 运行时报错："
    grep -nE "unbound variable|command not found|syntax error" "$OUT/deploy.log" | sed 's/^/       /'
    FAIL=1
  fi

  # 1) systemd 单元
  if [ -f "$OUT/service.unit" ]; then
    if [ "$RO" = "off" ]; then
      grep -q "READONLY_PORT" "$OUT/service.unit" \
        && { echo "FAIL unit 不该出现 READONLY_PORT"; FAIL=1; } \
        || echo "OK   unit 不含 READONLY_PORT（未配）"
    else
      grep -q "Environment=READONLY_PORT=$RO" "$OUT/service.unit" \
        && echo "OK   unit 含 Environment=READONLY_PORT=$RO" \
        || { echo "FAIL unit 缺 Environment=READONLY_PORT=$RO"; FAIL=1; }
    fi
  fi

  # 2) docker 叠加文件
  if [ -f "$OUT/docker-compose.readonly.yml" ]; then
    if [ "$RO" = "off" ]; then
      echo "FAIL 未配只读端口却生成叠加文件"; FAIL=1
    else
      grep -q "MOCK_RO_PORT:-$RO}:18081" "$OUT/docker-compose.readonly.yml" \
        && echo "OK   compose 叠加：宿主机 $RO -> 容器 18081" \
        || { echo "FAIL compose 叠加端口映射不对"; FAIL=1; }
    fi
  fi

  # 3) 端口占用检查 + 防火墙放行列表（直接读远端命令原文）
  EXPECT="$PORT"; [ "$RO" != "off" ] && EXPECT="$PORT $RO"
  grep -qF "[:.]$PORT[[:space:]]" "$OUT/cmd.log" \
    && echo "OK   占用检查含主端口 $PORT" \
    || { echo "FAIL 占用检查缺 $PORT"; FAIL=1; }
  if [ "$RO" = "off" ]; then
    grep -qF "for p in $PORT " "$OUT/cmd.log" \
      && { echo "FAIL 未配只读端口却出现双端口放行列表"; FAIL=1; } \
      || echo "OK   未配只读端口 -> 只放行主端口（向后兼容）"
  else
    grep -qF "[:.]$RO[[:space:]]" "$OUT/cmd.log" \
      && echo "OK   占用检查含只读端口 $RO" \
      || { echo "FAIL 占用检查缺只读端口 $RO"; FAIL=1; }
    grep -qF "for p in $EXPECT;" "$OUT/cmd.log" \
      && echo "OK   防火墙放行列表 = '$EXPECT'" \
      || { echo "FAIL 防火墙放行列表不等于 '$EXPECT'"; FAIL=1; }
  fi

  # 4) 未配只读端口时不能静默通过（免密场景应给出提醒）
  if [ "$RO" = "off" ]; then
    grep -q "免密部署但未指定只读端口" "$OUT/deploy.log" \
      && echo "OK   免密+无只读端口时打印了风险提醒" \
      || echo "（本次可能开了登录保护，未触发免密提醒）"
  fi

  # 5) 升级安全：默认绝不覆盖远端 config.json（规则/用户/分享令牌都在里面），只有 -f 才传
  if [ "$FORCE" = "yes" ]; then
    grep -q "config.json" "$OUT/scp.log" \
      && echo "OK   -f：config.json 确实被上传（显式覆盖）" \
      || { echo "FAIL -f 却未上传 config.json"; FAIL=1; }
  else
    grep -q "config.json" "$OUT/scp.log" \
      && { echo "FAIL 未加 -f 却上传了 config.json（会冲掉远端规则）"; FAIL=1; } \
      || echo "OK   未加 -f -> config.json 未上传（远端配置保留）"
    grep -q "保留不动" "$OUT/deploy.log" \
      && echo "OK   日志明确提示「config.json 远端已存在 -> 保留不动」" \
      || { echo "FAIL 未见配置保留提示"; FAIL=1; }
  fi

  [ "$FAIL" = 0 ] && echo "RESULT: PASS" || echo "RESULT: FAIL"
  return "$FAIL"
}

# ---------------------------------------------------------------- 主流程
if [ "$#" -ge 1 ]; then
  scan_wide_vars || exit 1
  echo
  run_case "${1:-systemd}" "${2:-18081}" "${3:-yes}" "${4:-no}"
  exit $?
fi

RC=0
scan_wide_vars || RC=1
echo
run_case systemd 18081 yes || RC=1
echo
run_case docker 18081 no || RC=1
echo
run_case systemd off yes || RC=1
echo
run_case systemd 18081 yes yes || RC=1     # 显式 -f：验证「唯一会覆盖配置」的开关
echo
if [ "$RC" = 0 ]; then
  echo "######## 四个场景全部 PASS ########"
else
  echo "######## 存在 FAIL，见上 ########"
fi
exit "$RC"
