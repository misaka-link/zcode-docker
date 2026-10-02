#!/bin/bash
set -eo pipefail

# ========================================================
# ZCode Docker 容器统一入口脚本 (entrypoint)
# ========================================================

# 1. 导出环境变量默认值（契约 §2）
export ZCODE_WORKSPACE="${ZCODE_WORKSPACE:-/workspace}"
export ZCODE_BROWSE_ROOT="${ZCODE_BROWSE_ROOT:-/workspace}"
export PROXY_PORT="${PROXY_PORT:-3080}"
export ZCODE_PORT="${ZCODE_PORT:-3030}"
export VNC_PORT="${VNC_PORT:-6080}"
export NOVNC_ASSET_REVISION="${NOVNC_ASSET_REVISION:-1.6.0}"
export ZCODE_HOME="${ZCODE_HOME:-/root}"
export ZCODE_DATA_BASE_DIR="${ZCODE_DATA_BASE_DIR:-${ZCODE_HOME}}"
export ZCODE_DIR="${ZCODE_DIR:-${ZCODE_HOME}/.zcode}"
export ZCODE_SNAPSHOT_DIR="${ZCODE_SNAPSHOT_DIR:-${ZCODE_HOME}/.zcode-snapshots}"
export ZCODE_VERSIONS_DIR="${ZCODE_VERSIONS_DIR:-${ZCODE_SNAPSHOT_DIR}/versions}"
export ZCODE_RUNTIME_DIR="${ZCODE_RUNTIME_DIR:-/opt/zcode}"
export ZCODE_RUNTIME_PARENT="${ZCODE_RUNTIME_PARENT:-/opt}"
export CHROME_USER_DATA_DIR="${CHROME_USER_DATA_DIR:-${ZCODE_HOME}/.config/chromium}"
export DISPLAY="${DISPLAY:-:99}"
export ZCODE_DESKTOP_ENABLED="${ZCODE_DESKTOP_ENABLED:-1}"
export ZCODE_DESKTOP_MODE="${ZCODE_DESKTOP_MODE:-browser}"
export ZCODE_DESKTOP_WIDTH="${ZCODE_DESKTOP_WIDTH:-1920}"
export ZCODE_DESKTOP_HEIGHT="${ZCODE_DESKTOP_HEIGHT:-1080}"
export ZCODE_DESKTOP_DEPTH="${ZCODE_DESKTOP_DEPTH:-24}"
export ZCODE_IDLE_TIMEOUT_MINUTES="${ZCODE_IDLE_TIMEOUT_MINUTES:-30}"
export ZCODE_WEB_LOG="${ZCODE_WEB_LOG:-${ZCODE_DIR}/logs/zcode-web.log}"
export ZCODE_WEB_LOG_MAX_BYTES="${ZCODE_WEB_LOG_MAX_BYTES:-10485760}"
export ZCODE_GATEWAY_LOG="${ZCODE_GATEWAY_LOG:-${ZCODE_DIR}/logs/gateway.log}"
export ZCODE_VERSIONS_MIN_FREE_MB="${ZCODE_VERSIONS_MIN_FREE_MB:-1536}"
export NODE_OPTIONS="${NODE_OPTIONS:-} --no-deprecation"

# 2. ADMIN_PATH / VNC_PATH 仅在显式设置时导出（契约 §2，保证管理控制台持久化配置生效）
if [ -n "${ADMIN_PATH:-}" ]; then export ADMIN_PATH; fi
if [ -n "${VNC_PATH:-}" ]; then export VNC_PATH; fi

# 3. 出站网络代理环境变量大小写归一化
[ -n "$HTTP_PROXY" ] && export HTTP_PROXY="$HTTP_PROXY" http_proxy="${http_proxy:-$HTTP_PROXY}"
[ -n "$HTTPS_PROXY" ] && export HTTPS_PROXY="$HTTPS_PROXY" https_proxy="${https_proxy:-$HTTPS_PROXY}"
[ -n "$ALL_PROXY" ] && export ALL_PROXY="$ALL_PROXY" all_proxy="${all_proxy:-$ALL_PROXY}"
[ -n "$NO_PROXY" ] && export NO_PROXY="$NO_PROXY" no_proxy="${no_proxy:-$NO_PROXY}"

# 4. 信号转发与优雅停机
child_pid=""

stop_all() {
  echo "[entrypoint] 收到停止信号，正在退出..."
  if [ -n "$child_pid" ] && kill -0 "$child_pid" 2>/dev/null; then
    kill -TERM "$child_pid" 2>/dev/null || true
    wait "$child_pid" 2>/dev/null || true
  fi
  exit 0
}

trap stop_all SIGINT SIGTERM SIGHUP

# 5. 打印启动横幅
echo "========================================================"
echo "       🚀 ZCode Docker Suite 启动中..."
echo "========================================================"
echo "  - Web 工作区: http://127.0.0.1:${PROXY_PORT}/"
echo "  - 管理控制台: http://127.0.0.1:${PROXY_PORT}${ADMIN_PATH:-/admin}/"
echo "  - 虚拟桌面:   http://127.0.0.1:${PROXY_PORT}${VNC_PATH:-/vnc}/"
echo "========================================================"

# 6. 确保必要目录就绪
mkdir -p "${ZCODE_WORKSPACE}" "${ZCODE_DIR}" "${ZCODE_SNAPSHOT_DIR}" "${ZCODE_VERSIONS_DIR}/.staging" "${CHROME_USER_DATA_DIR}" "/tmp/zcode-desktop"
mkdir -p "$(dirname "${ZCODE_WEB_LOG}")" 2>/dev/null || true
mkdir -p "$(dirname "${ZCODE_GATEWAY_LOG}")" 2>/dev/null || true

# 7. 日志轮转 (ZCODE_WEB_LOG 大于 10MB 时轮转为 .1)
if [ -f "${ZCODE_WEB_LOG}" ]; then
  _log_size=$(wc -c < "${ZCODE_WEB_LOG}" 2>/dev/null || echo 0)
  if [ "${_log_size:-0}" -gt "${ZCODE_WEB_LOG_MAX_BYTES}" ]; then
    mv -f "${ZCODE_WEB_LOG}" "${ZCODE_WEB_LOG}.1" 2>/dev/null || true
  fi
fi
touch "${ZCODE_WEB_LOG}"

# 8. 修复数据卷与敏感凭据权限 (ZCode 凭据强制要求安全权限)
if [ -d "${ZCODE_DIR}" ]; then
  chmod 700 "${ZCODE_DIR}" 2>/dev/null || true
  find "${ZCODE_DIR}" -type f \( -name "*credentials*" -o -name "*token*" -o -name "*auth*" -o -name "session_secret" -o -name ".internal_upstream_token" -o -name "*secret*" \) -exec chmod 600 {} + 2>/dev/null || true
fi

# 9. 运行时中断自愈与残留清理（契约 §7）
# 9.1 中断自愈：若活动运行时目录缺失，从临时或受保护回滚点恢复
if [ ! -d "${ZCODE_RUNTIME_DIR}" ]; then
  _rb="$(ls -1d "${ZCODE_RUNTIME_PARENT}"/.zcode-rollback-tmp-* 2>/dev/null | sort | tail -1 || true)"
  if [ -z "${_rb}" ] || [ ! -d "${_rb}" ]; then
    if [ -d "${ZCODE_RUNTIME_PARENT}/.zcode-rollback-preserved" ]; then
      _rb="${ZCODE_RUNTIME_PARENT}/.zcode-rollback-preserved"
    fi
  fi
  if [ -n "${_rb}" ] && [ -d "${_rb}" ]; then
    echo "[entrypoint] ⚠️ 检测到活动运行时缺失，正在从回滚点恢复: ${_rb}"
    # overlayfs 上跨层 rename 可能返回 EXDEV，故 mv 失败时退化为「复制 + 删除」
    if ! mv "${_rb}" "${ZCODE_RUNTIME_DIR}" 2>/dev/null; then
      echo "[entrypoint] mv 失败（可能为 overlayfs 跨层），改用 cp -a 复制恢复..."
      rm -rf "${ZCODE_RUNTIME_DIR}" 2>/dev/null || true
      cp -a "${_rb}" "${ZCODE_RUNTIME_DIR}" 2>/dev/null && rm -rf "${_rb}" 2>/dev/null || true
    fi
  fi
fi

# 9.2 清理过期 staging / rollback 残留（>60 分钟），不触碰活动运行时与受保护回滚点
find "${ZCODE_RUNTIME_PARENT}" -maxdepth 1 -name ".zcode-staging-*" -type d -mmin +60 -exec rm -rf {} + 2>/dev/null || true
find "${ZCODE_RUNTIME_PARENT}" -maxdepth 1 -name ".zcode-rollback-*" ! -name ".zcode-rollback-preserved" -type d -mmin +60 -exec rm -rf {} + 2>/dev/null || true
find "${ZCODE_VERSIONS_DIR}/.staging" -maxdepth 1 -mindepth 1 -mmin +60 -exec rm -rf {} + 2>/dev/null || true

# 10. 校验运行时完整性（契约 §1、§7）
missing_items=()
[ ! -f "${ZCODE_RUNTIME_DIR}/bin/zcode.mjs" ] && missing_items+=("bin/zcode.mjs")
[ ! -f "${ZCODE_RUNTIME_DIR}/server/entry-http.js" ] && missing_items+=("server/entry-http.js")
[ ! -d "${ZCODE_RUNTIME_DIR}/web" ] && missing_items+=("web/")

if [ ${#missing_items[@]} -gt 0 ]; then
  echo "========================================================" >&2
  echo "[entrypoint] ❌ 运行时完整性校验失败！" >&2
  echo "[entrypoint] 缺少核心文件/目录: ${missing_items[*]}" >&2
  echo "[entrypoint] 当前运行时路径: ${ZCODE_RUNTIME_DIR}" >&2
  echo "[entrypoint] 指引：请检查 Docker 镜像构建或版本置换流程是否完整，" >&2
  echo "[entrypoint] 或通过管理控制台版本管理重新安装有效版本。" >&2
  echo "========================================================" >&2
  exit 1
fi

# 10.5 内置插件首装/升级（幂等，网关启动前完成，避免运行时重启才生效）
#     - 镜像内置本地市场 /opt/zcode-docker/plugins，遍历其中的插件目录逐个对账；
#     - 已安装同版本或更新版本 → 跳过（不打扰用户自选来源，如工作区仓库市场）；
#     - 未安装 → 注册市场（仅首个插件 add 一次）并首装；已装旧版本 → 刷新市场并升级；
#     - 只做 install/update，绝不调用 enable/disable，尊重用户启用位；
#     - 任何一步失败仅打 ⚠️ 警告并继续启动，绝不能因插件问题阻塞网关拉起。
if [ "${ZCODE_BUILTIN_PLUGINS:-1}" = "0" ]; then
  echo "[entrypoint] ZCODE_BUILTIN_PLUGINS=0，跳过内置插件首装/升级"
elif [ -d /opt/zcode-docker/plugins ]; then
  _bp_reg="${ZCODE_DIR}/cli/plugins/installed_plugins.json"
  _bp_market="$(node -e 'try{process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1])).name||"zcode-docker-local")}catch(e){}' /opt/zcode-docker/plugins/marketplace.json 2>/dev/null || true)"
  _bp_market="${_bp_market:-zcode-docker-local}"
  _bp_added=0
  for _bp_dir in /opt/zcode-docker/plugins/*/; do
    [ -d "${_bp_dir}" ] || continue
    if [ ! -f "${_bp_dir}package.json" ]; then
      echo "[entrypoint] ⚠️ 内置插件目录缺少 package.json，跳过: ${_bp_dir}"
      continue
    fi
    _bp_meta="$(node -e 'try{const j=JSON.parse(require("fs").readFileSync(process.argv[1]));process.stdout.write((j.name||"")+"\t"+(j.version||""))}catch(e){}' "${_bp_dir}package.json" 2>/dev/null || true)"
    _bp_name="${_bp_meta%%$'\t'*}"
    _bp_built="${_bp_meta##*$'\t'}"
    if [ -z "${_bp_name}" ] || [ -z "${_bp_built}" ]; then
      echo "[entrypoint] ⚠️ 内置插件 package.json 缺少 name/version，跳过: ${_bp_dir}"
      continue
    fi
    _bp_inst="$(node -e 'try{const n=process.argv[1];const j=JSON.parse(require("fs").readFileSync(process.argv[2]));const p=(j.plugins||[]).filter(function(x){return x.name===n}).pop();process.stdout.write((p&&p.version)||"")}catch(e){}' "${_bp_name}" "${_bp_reg}" 2>/dev/null || true)"

    # 分支 a：已安装同版本 → 跳过
    if [ "${_bp_inst}" = "${_bp_built}" ]; then
      echo "[entrypoint] 内置插件 ${_bp_name} 已是最新版 ${_bp_inst}，跳过"
      continue
    fi
    # 分支 a'：已安装版本比内置更新（用户自选来源） → 跳过
    if [ -n "${_bp_inst}" ] && [ "$(printf '%s\n%s\n' "${_bp_built}" "${_bp_inst}" | sort -V | head -n 1)" = "${_bp_built}" ]; then
      echo "[entrypoint] 内置插件 ${_bp_name} 已安装更新版本 ${_bp_inst}（内置 ${_bp_built}），跳过"
      continue
    fi

    if [ -z "${_bp_inst}" ]; then
      # 分支 b：未安装 → 注册内置本地市场（多插件仅首个触发一次 add）并首装
      if [ "${_bp_added}" = "0" ]; then
        echo "[entrypoint] 注册内置插件市场 ${_bp_market}: /opt/zcode-docker/plugins"
        if ! node /opt/zcode/bin/zcode.mjs plugins marketplace add /opt/zcode-docker/plugins --scope user; then
          echo "[entrypoint] ⚠️ 内置插件市场注册失败，跳过插件 ${_bp_name}"
          continue
        fi
        _bp_added=1
      fi
      echo "[entrypoint] 首装内置插件 ${_bp_name} ${_bp_built}..."
      if ! node /opt/zcode/bin/zcode.mjs plugins install "${_bp_name}@${_bp_market}"; then
        echo "[entrypoint] ⚠️ 内置插件 ${_bp_name} 首装失败，继续启动容器"
      fi
    else
      # 分支 c：已安装旧版本 → 刷新市场元数据并升级
      echo "[entrypoint] 升级内置插件 ${_bp_name}: ${_bp_inst} -> ${_bp_built}..."
      if ! node /opt/zcode/bin/zcode.mjs plugins marketplace update "${_bp_market}"; then
        echo "[entrypoint] ⚠️ 内置插件市场刷新失败，跳过插件 ${_bp_name} 升级"
        continue
      fi
      if ! node /opt/zcode/bin/zcode.mjs plugins update "${_bp_name}"; then
        echo "[entrypoint] ⚠️ 内置插件 ${_bp_name} 升级失败，继续启动容器"
      fi
    fi
  done
fi

# 11. 启动统一网关守护循环
#     - 采用守护重启循环而非单一 exec：支持管理面板在线热重启网关，且具备瞬时故障自愈能力
#     - 指数退避 (1s -> 2s -> ... -> 30s)；连续 10 次启动失败则退出容器交由编排层介入
attempt=0
backoff=1
while true; do
  echo "[entrypoint] 启动统一网关服务 (node /opt/zcode-gateway/index.js)..."
  start_ts=$(date +%s)
  NODE_ENV=production node /opt/zcode-gateway/index.js &
  child_pid=$!
  code=0
  wait "$child_pid" || code=$?
  child_pid=""
  ran=$(( $(date +%s) - start_ts ))

  # 稳定运行超过 60 秒视为一次成功启动：重置退避计数
  if [ "$ran" -ge 60 ]; then
    attempt=0
    backoff=1
  fi

  attempt=$((attempt + 1))
  if [ "$attempt" -ge 10 ]; then
    echo "[entrypoint] ❌ 网关已连续退出 ${attempt} 次（最近退出码 ${code}，运行 ${ran}s），放弃重启并退出容器" >&2
    exit 1
  fi
  echo "[entrypoint] 网关进程已退出 (code=${code}，运行 ${ran}s)，${backoff}s 后重启（第 ${attempt} 次）..."
  sleep "$backoff"
  backoff=$(( backoff * 2 ))
  [ "$backoff" -gt 30 ] && backoff=30
done
