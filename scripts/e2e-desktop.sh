#!/usr/bin/env bash
# ========================================================
# zcode-docker 虚拟桌面（VNC）本地验证
# --------------------------------------------------------
# 验证 desktop-manager 能在 Xvfb 上拉起 x11vnc/noVNC，并让 Chromium 打开
# 容器内的 ZCode Web（browser 模式），最终产出一张桌面截图作为证据。
#
# 前置：.build/zcode-<version>.tar.gz 存在（scripts/local-build-zcode.sh）
#      本机需有 Xvfb / x11vnc / websockify / chromium / openbox / xdpyinfo
# 用法：bash scripts/e2e-desktop.sh [--keep] [--mode browser|client]
# ========================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
E2E_DIR="${ROOT}/.build/e2e-desktop"
LOG_DIR="${E2E_DIR}/logs"
SHOT_DIR="${ROOT}/doc"
PROXY_PORT="${E2E_PROXY_PORT:-3080}"
UPSTREAM_PORT="${E2E_UPSTREAM_PORT:-3034}"
VNC_HTTP_PORT="${E2E_VNC_PORT:-6081}"
AUTH_TOKEN="${E2E_AUTH_TOKEN:-e2e-desktop-token}"
MODE="browser"
KEEP=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --keep) KEEP=1; shift ;;
    --mode) MODE="$2"; shift 2 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done

mkdir -p "${E2E_DIR}" "${LOG_DIR}" "${SHOT_DIR}"

GW_PID=""
cleanup() {
  if [[ "${KEEP}" == "1" ]]; then
    echo "[desktop-e2e] --keep：保留网关 PID ${GW_PID}"
    return
  fi
  echo "[desktop-e2e] 清理..."
  [[ -n "${GW_PID}" ]] && kill "${GW_PID}" 2>/dev/null || true
  sleep 2
  [[ -n "${GW_PID}" ]] && kill -9 "${GW_PID}" 2>/dev/null || true
  pkill -f "Xvfb :99" 2>/dev/null || true
  pkill -f "x11vnc -display :99" 2>/dev/null || true
  pkill -f "websockify --web=/usr/share/novnc" 2>/dev/null || true
}
trap cleanup EXIT

# 1. 准备本地可执行包装器（容器内由 Dockerfile 安装到 /usr/local/bin）
BIN_DIR="${E2E_DIR}/bin"
mkdir -p "${BIN_DIR}"
install -m 0755 "${ROOT}/scripts/chromium-docker" "${BIN_DIR}/chromium-docker"
export PATH="${BIN_DIR}:${PATH}"

# 2. 准备运行时
RUNTIME_DIR="${E2E_DIR}/runtime"
if [[ ! -f "${RUNTIME_DIR}/bin/zcode.mjs" ]]; then
  TARBALL="$(ls -1t "${ROOT}"/.build/zcode-*.tar.gz 2>/dev/null | head -n 1 || true)"
  [[ -z "${TARBALL}" ]] && { echo "未找到 .build/zcode-*.tar.gz" >&2; exit 1; }
  rm -rf "${RUNTIME_DIR}"
  mkdir -p "${RUNTIME_DIR}"
  tar -xzf "${TARBALL}" -C "${RUNTIME_DIR}"
  if [[ ! -f "${RUNTIME_DIR}/bin/zcode.mjs" && -d "${RUNTIME_DIR}/zcode" ]]; then
    mv "${RUNTIME_DIR}/zcode" "${E2E_DIR}/runtime-tmp"
    rm -rf "${RUNTIME_DIR}"
    mv "${E2E_DIR}/runtime-tmp" "${RUNTIME_DIR}"
  fi
fi

rm -rf "${E2E_DIR}/home" "${E2E_DIR}/ws"
mkdir -p "${E2E_DIR}/home" "${E2E_DIR}/ws"

# 3. 启动网关（含虚拟桌面）
export PROXY_PORT ZCODE_PORT="${UPSTREAM_PORT}" VNC_PORT="${VNC_HTTP_PORT}" \
       ZCODE_VNC_RFB_PORT="${E2E_RFB_PORT:-5901}" \
       ZCODE_CDP_PORT="${E2E_CDP_PORT:-9223}" \
       ZCODE_HOME="${E2E_DIR}/home" \
       ZCODE_DATA_BASE_DIR="${E2E_DIR}/home" \
       ZCODE_DIR="${E2E_DIR}/home/.zcode" \
       ZCODE_SNAPSHOT_DIR="${E2E_DIR}/home/.zcode-snapshots" \
       ZCODE_VERSIONS_DIR="${E2E_DIR}/home/.zcode-snapshots/versions" \
       ZCODE_RUNTIME_DIR="${RUNTIME_DIR}" \
       ZCODE_RUNTIME_PARENT="${E2E_DIR}" \
       ZCODE_WORKSPACE="${E2E_DIR}/ws" \
       CHROME_USER_DATA_DIR="${E2E_DIR}/home/.config/chromium" \
       AUTH_TOKEN="${AUTH_TOKEN}" \
       ZCODE_DESKTOP_ENABLED=1 \
       ZCODE_DESKTOP_MODE="${MODE}" \
       ZCODE_DESKTOP_WIDTH="${E2E_WIDTH:-1280}" \
       ZCODE_DESKTOP_HEIGHT="${E2E_HEIGHT:-800}" \
       ZCODE_IDLE_TIMEOUT_MINUTES=0 \
       DISPLAY="${E2E_DISPLAY:-:77}" \
       GATEWAY_CONFIG_FILE="${E2E_DIR}/home/gateway.config.json"
node "${ROOT}/gateway/index.js" >"${LOG_DIR}/gateway-desktop.log" 2>&1 &
GW_PID=$!

for _ in $(seq 1 60); do
  curl -fsS -o /dev/null --max-time 2 "http://127.0.0.1:${PROXY_PORT}/healthz" 2>/dev/null && break
  sleep 0.5
done
echo "[desktop-e2e] 网关已启动 (PID ${GW_PID})"

JAR="${E2E_DIR}/cookies.txt"
rm -f "${JAR}"
curl -s -o /dev/null -c "${JAR}" -X POST -H 'Content-Type: application/json' \
  -d "{\"token\":\"${AUTH_TOKEN}\"}" "http://127.0.0.1:${PROXY_PORT}/__auth/verify"

# 4. 等待桌面就绪（只看 desktop.running，避免误匹配 core.running）
DESKTOP_OK=0
for _ in $(seq 1 90); do
  STATUS="$(curl -s --max-time 5 -b "${JAR}" "http://127.0.0.1:${PROXY_PORT}/admin/api/status" || true)"
  RUNNING="$(echo "${STATUS}" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);process.stdout.write(String(Boolean(j.desktop&&j.desktop.running)))}catch(e){process.stdout.write('false')}})" 2>/dev/null || echo false)"
  if [[ "${RUNNING}" == "true" ]]; then DESKTOP_OK=1; break; fi
  sleep 1
done

echo "[desktop-e2e] 桌面状态:"
curl -s -b "${JAR}" "http://127.0.0.1:${PROXY_PORT}/admin/api/status" | head -c 900
echo

if [[ "${DESKTOP_OK}" != "1" ]]; then
  echo "[desktop-e2e] ❌ 桌面未就绪，日志尾部：" >&2
  tail -30 "${LOG_DIR}/gateway-desktop.log" >&2
  exit 1
fi

# 5. 校验 noVNC 入口
VNC_CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -b "${JAR}" "http://127.0.0.1:${PROXY_PORT}/vnc/vnc.html" || true)"
echo "[desktop-e2e] /vnc/vnc.html → HTTP ${VNC_CODE}"

# 6. 抓取桌面截图（Xvfb :99）
sleep 8
SHOT="${SHOT_DIR}/12-vnc-desktop-${MODE}.png"
if command -v import >/dev/null 2>&1; then
  import -display :99 -window root "${SHOT}" && echo "[desktop-e2e] ✅ 桌面截图: ${SHOT}"
elif command -v scrot >/dev/null 2>&1; then
  DISPLAY=:99 scrot "${SHOT}" && echo "[desktop-e2e] ✅ 桌面截图: ${SHOT}"
else
  echo "[desktop-e2e] ⚠️ 未找到截图工具（import/scrot）" >&2
fi

# 7. 校验 Chromium 是否真的打开了 ZCode Web（通过 CDP 查询目标 URL）
CDP_PORT="${E2E_CDP_PORT:-9223}"
TARGETS="$(curl -s --max-time 5 "http://127.0.0.1:${CDP_PORT}/json/list" || true)"
if echo "${TARGETS}" | grep -q "127.0.0.1:${UPSTREAM_PORT}"; then
  echo "[desktop-e2e] ✅ Chromium 已打开 ZCode Web (127.0.0.1:${UPSTREAM_PORT})"
else
  echo "[desktop-e2e] ⚠️ 未从 CDP 观察到 ZCode Web 目标（CDP 可能未开启）"
fi

echo "[desktop-e2e] 完成。日志: ${LOG_DIR}"
