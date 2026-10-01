#!/usr/bin/env bash
# ========================================================
# zcode-docker 本地等效端到端验证（无需 Docker）
# --------------------------------------------------------
# 用途：在开发机上用「已构建的 ZCode 发行包 + 真实网关 + 真实上游」跑一遍
#      认证 → 工作区反代 → 控制台 API → 快照 的完整链路，作为镜像构建前的
#      回归基线（镜像内的差异仅在于路径与进程编排）。
#
# 与容器内一致：上游 ZCode Web 由网关内的 zcode-manager 拉起与守护，
# 脚本不自行启动上游，从而同时覆盖「进程守护 + 就绪探活」路径。
#
# 前置：先执行 scripts/local-build-zcode.sh 产出 .build/zcode-<version>.tar.gz
# 用法：bash scripts/e2e-local.sh [--keep] [--runtime <dir>]
# ========================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
E2E_DIR="${ROOT}/.build/e2e"
LOG_DIR="${E2E_DIR}/logs"
PROXY_PORT="${E2E_PROXY_PORT:-3080}"
UPSTREAM_PORT="${E2E_UPSTREAM_PORT:-3031}"
AUTH_TOKEN="${E2E_AUTH_TOKEN:-e2e-test-token}"
KEEP=0
RUNTIME_DIR=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --keep) KEEP=1; shift ;;
    --runtime) RUNTIME_DIR="$2"; shift 2 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done

PASS=0
FAIL=0
declare -a RESULTS=()

ok()   { PASS=$((PASS+1)); RESULTS+=("PASS  $1"); echo "  ✅ $1"; }
bad()  { FAIL=$((FAIL+1)); RESULTS+=("FAIL  $1"); echo "  ❌ $1"; }
step() { echo; echo "▶ $1"; }

cleanup() {
  if [[ "${KEEP}" == "1" ]]; then
    echo "[e2e] --keep 指定，保留进程（网关 PID: ${GW_PID:-无}，上游端口: ${UPSTREAM_PORT}）"
    return
  fi
  echo
  echo "[e2e] 清理进程..."
  [[ -n "${GW_PID:-}" ]] && kill "${GW_PID}" 2>/dev/null || true
  sleep 2
  [[ -n "${GW_PID:-}" ]] && kill -9 "${GW_PID}" 2>/dev/null || true
  # 兜底回收网关拉起的上游进程
  local up_pid
  up_pid="$(ss -ltnp 2>/dev/null | awk "/:${UPSTREAM_PORT}/ {print \$NF}" | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2 || true)"
  [[ -n "${up_pid}" ]] && kill -9 "${up_pid}" 2>/dev/null || true
}
trap cleanup EXIT

# ── 0. 准备运行时 ─────────────────────────────────────────────
step "0/8 准备 ZCode 运行时"
mkdir -p "${E2E_DIR}" "${LOG_DIR}"
rm -rf "${E2E_DIR}/home" "${E2E_DIR}/ws" "${E2E_DIR}/runtime"
mkdir -p "${E2E_DIR}/home" "${E2E_DIR}/ws"

if [[ -z "${RUNTIME_DIR}" ]]; then
  TARBALL="$(ls -1t "${ROOT}"/.build/zcode-*.tar.gz 2>/dev/null | head -n 1 || true)"
  if [[ -z "${TARBALL}" ]]; then
    echo "未找到 .build/zcode-*.tar.gz，请先运行 scripts/local-build-zcode.sh" >&2
    exit 1
  fi
  echo "  使用发行包: ${TARBALL}"
  mkdir -p "${E2E_DIR}/runtime"
  tar -xzf "${TARBALL}" -C "${E2E_DIR}/runtime"
  if [[ ! -f "${E2E_DIR}/runtime/bin/zcode.mjs" && -d "${E2E_DIR}/runtime/zcode" ]]; then
    mv "${E2E_DIR}/runtime/zcode" "${E2E_DIR}/runtime-tmp"
    rm -rf "${E2E_DIR}/runtime"
    mv "${E2E_DIR}/runtime-tmp" "${E2E_DIR}/runtime"
  fi
  RUNTIME_DIR="${E2E_DIR}/runtime"
else
  echo "  使用外部运行时目录: ${RUNTIME_DIR}"
fi

for f in bin/zcode.mjs server/entry-http.js web; do
  if [[ -e "${RUNTIME_DIR}/${f}" ]]; then ok "运行时包含 ${f}"; else bad "运行时缺少 ${f}"; fi
done
CORE_VERSION="$(node -p "require('${RUNTIME_DIR}/package.json').version" 2>/dev/null || echo unknown)"
echo "  ZCode 运行时版本: ${CORE_VERSION}"

# ── 1. 启动统一网关（由网关内的 zcode-manager 拉起上游）────────
step "1/8 启动统一网关 (0.0.0.0:${PROXY_PORT})，由网关守护上游 ZCode Web"
export PROXY_PORT ZCODE_PORT="${UPSTREAM_PORT}" \
       ZCODE_HOME="${E2E_DIR}/home" \
       ZCODE_DATA_BASE_DIR="${E2E_DIR}/home" \
       ZCODE_DIR="${E2E_DIR}/home/.zcode" \
       ZCODE_SNAPSHOT_DIR="${E2E_DIR}/home/.zcode-snapshots" \
       ZCODE_VERSIONS_DIR="${E2E_DIR}/home/.zcode-snapshots/versions" \
       ZCODE_RUNTIME_DIR="${RUNTIME_DIR}" \
       ZCODE_RUNTIME_PARENT="${E2E_DIR}" \
       ZCODE_WORKSPACE="${E2E_DIR}/ws" \
       AUTH_TOKEN="${AUTH_TOKEN}" \
       ZCODE_DESKTOP_ENABLED=0 \
       GATEWAY_CONFIG_FILE="${E2E_DIR}/home/gateway.config.json"
node "${ROOT}/gateway/index.js" >"${LOG_DIR}/gateway.log" 2>&1 &
GW_PID=$!

GW_OK=0
for _ in $(seq 1 60); do
  if curl -fsS -o /dev/null --max-time 2 "http://127.0.0.1:${PROXY_PORT}/healthz" 2>/dev/null; then GW_OK=1; break; fi
  sleep 0.5
done
if [[ "${GW_OK}" == "1" ]]; then ok "网关已就绪"; else bad "网关未就绪（见 ${LOG_DIR}/gateway.log）"; fi

UP_OK=0
for _ in $(seq 1 120); do
  if curl -fsS -o /dev/null --max-time 2 "http://127.0.0.1:${UPSTREAM_PORT}/" 2>/dev/null; then UP_OK=1; break; fi
  sleep 0.5
done
if [[ "${UP_OK}" == "1" ]]; then ok "上游 ZCode Web 已由网关拉起并就绪"; else bad "上游 ZCode Web 未就绪（见 ${LOG_DIR}/gateway.log）"; fi

JAR="${E2E_DIR}/cookies.txt"
rm -f "${JAR}"

# ── 2. 认证链路 ───────────────────────────────────────────────
step "2/8 认证链路"
CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:${PROXY_PORT}/")"
if [[ "${CODE}" == "302" || "${CODE}" == "401" ]]; then ok "未登录访问 / 被拦截 (HTTP ${CODE})"; else bad "未登录访问 / 未被拦截 (HTTP ${CODE})"; fi

CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 -X POST -H 'Content-Type: application/json' \
  -d '{"token":"wrong-token"}' "http://127.0.0.1:${PROXY_PORT}/__auth/verify")"
if [[ "${CODE}" == "401" || "${CODE}" == "403" ]]; then ok "错误口令被拒绝 (HTTP ${CODE})"; else bad "错误口令未被拒绝 (HTTP ${CODE})"; fi

CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 -c "${JAR}" -X POST -H 'Content-Type: application/json' \
  -d "{\"token\":\"${AUTH_TOKEN}\"}" "http://127.0.0.1:${PROXY_PORT}/__auth/verify")"
if [[ "${CODE}" == "200" ]]; then ok "正确口令登录成功 (HTTP 200)"; else bad "正确口令登录失败 (HTTP ${CODE})"; fi
if grep -q "zcode_auth_session" "${JAR}" 2>/dev/null; then ok "会话 Cookie 已下发"; else bad "未收到会话 Cookie"; fi

# ── 3. 工作区反代 ─────────────────────────────────────────────
step "3/8 工作区反代（网关 → ZCode Web）"
WS_FILE="${E2E_DIR}/workspace-index.html"
WS_CODE="$(curl -s --max-time 15 -b "${JAR}" -o "${WS_FILE}" -w '%{http_code}' "http://127.0.0.1:${PROXY_PORT}/" || true)"
if grep -qi "<!doctype html" "${WS_FILE}" 2>/dev/null; then ok "反代返回 HTML 页面（HTTP ${WS_CODE}）"; else bad "反代未返回 HTML（HTTP ${WS_CODE}）"; fi
if grep -qi "zcode" "${WS_FILE}" 2>/dev/null; then ok "页面包含 ZCode 特征"; else bad "页面未包含 ZCode 特征"; fi

# ── 4. 控制台页面 ─────────────────────────────────────────────
step "4/8 控制台页面"
ADMIN_FILE="${E2E_DIR}/admin.html"
ADMIN_CODE="$(curl -s --max-time 20 -b "${JAR}" -o "${ADMIN_FILE}" -w '%{http_code}' "http://127.0.0.1:${PROXY_PORT}/admin/" || true)"
# 注意：控制台页面较大（>250KB），必须落盘后用 grep 文件，避免 `echo | grep -q` 触发 SIGPIPE + pipefail 误判
if [[ "${ADMIN_CODE}" == "200" ]] && grep -qi "zcode" "${ADMIN_FILE}"; then
  ok "控制台页面可访问且已注入 ZCode 品牌（$(wc -c < "${ADMIN_FILE}") 字节）"
else
  bad "控制台页面异常（HTTP ${ADMIN_CODE}）"
fi
if grep -q "__ZCODE_" "${ADMIN_FILE}" 2>/dev/null; then bad "控制台存在未替换的占位符"; else ok "占位符均已替换"; fi

# ── 5. 控制台 API ─────────────────────────────────────────────
step "5/8 控制台 API"
api_get() { curl -s --max-time 60 -b "${JAR}" "http://127.0.0.1:${PROXY_PORT}/admin$1"; }
api_post() { curl -s --max-time 180 -b "${JAR}" -X POST -H 'Content-Type: application/json' -d "$2" "http://127.0.0.1:${PROXY_PORT}/admin$1"; }

STATUS="$(api_get /api/status || true)"
if echo "${STATUS}" | grep -q '"core"'; then ok "/api/status 返回 core 状态"; else bad "/api/status 异常: ${STATUS:0:160}"; fi
if echo "${STATUS}" | grep -q "\"version\":\"${CORE_VERSION}\""; then ok "/api/status 报告运行时版本 ${CORE_VERSION}"; else bad "/api/status 未报告预期运行时版本"; fi

PLUGINS="$(api_get /api/plugins || true)"
if echo "${PLUGINS}" | grep -q '"plugins"'; then ok "/api/plugins 返回插件列表"; else bad "/api/plugins 异常: ${PLUGINS:0:160}"; fi

VCHECK="$(api_get /api/version/check || true)"
if echo "${VCHECK}" | grep -q '"project"'; then ok "/api/version/check 返回版本信息"; else bad "/api/version/check 异常: ${VCHECK:0:160}"; fi

# ── 6. 快照链路 ───────────────────────────────────────────────
step "6/8 快照链路（创建 → 列出 → 探测 → 还原）"
echo '{"probe":"e2e"}' > "${E2E_DIR}/home/.zcode/e2e-marker.json"
CREATE="$(api_post /api/snapshots/create '{"label":"e2e"}' || true)"
if echo "${CREATE}" | grep -q '"ok":true'; then ok "创建快照成功"; else bad "创建快照失败: ${CREATE:0:200}"; fi
SNAP="$(echo "${CREATE}" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);process.stdout.write((j.snapshot&&j.snapshot.filename)||j.filename||'')}catch(e){}})" 2>/dev/null || true)"
if [[ -n "${SNAP}" ]]; then ok "快照文件名: ${SNAP}"; else bad "未能解析快照文件名"; fi

LIST="$(api_get /api/snapshots || true)"
if echo "${LIST}" | grep -q '"snapshots"'; then ok "/api/snapshots 返回清单"; else bad "/api/snapshots 异常: ${LIST:0:160}"; fi

if [[ -n "${SNAP}" ]]; then
  INSPECT="$(api_get "/api/snapshots/inspect?file=${SNAP}" || true)"
  if echo "${INSPECT}" | grep -q '"hasSessions"'; then ok "快照探测返回 hasSessions"; else bad "快照探测异常: ${INSPECT:0:200}"; fi

  echo '{"probe":"mutated"}' > "${E2E_DIR}/home/.zcode/e2e-marker.json"
  RESTORE="$(api_post /api/snapshots/restore "{\"filename\":\"${SNAP}\",\"mode\":\"config-only\"}" || true)"
  if echo "${RESTORE}" | grep -q '"ok":true'; then ok "配置范围还原成功"; else bad "还原失败: ${RESTORE:0:200}"; fi
  if grep -q '"probe":"e2e"' "${E2E_DIR}/home/.zcode/e2e-marker.json" 2>/dev/null; then
    ok "还原后数据已回到快照状态"
  else
    bad "还原后数据未回到快照状态"
  fi
  if echo "${RESTORE}" | grep -q "repairedLinks"; then ok "还原响应包含 repairedLinks 字段"; else bad "还原响应缺少 repairedLinks"; fi
fi

# ── 7. 上游自愈与日志 ─────────────────────────────────────────
step "7/8 运行时自愈与日志接口"
LOGS="$(api_get '/api/zcode/logs?lines=50' || true)"
if echo "${LOGS}" | grep -q '"ok"'; then ok "/api/zcode/logs 可用"; else bad "/api/zcode/logs 异常: ${LOGS:0:160}"; fi
# 回归防护：控制台日志面板消费的是数组，后端必须返回 string[]（曾因返回字符串导致面板卡在「正在连接…」）
if echo "${LOGS}" | grep -q '"recentLogs":\['; then ok "/api/zcode/logs 的 recentLogs 为数组（控制台日志面板契约）"; else bad "/api/zcode/logs 的 recentLogs 不是数组: ${LOGS:0:160}"; fi
STATS="$(api_get /api/zcode/versions/stats || true)"
if echo "${STATS}" | grep -q '"count"'; then ok "/api/zcode/versions/stats 可用"; else bad "/api/zcode/versions/stats 异常: ${STATS:0:160}"; fi

# ── 8. 汇总 ───────────────────────────────────────────────────
step "8/8 结果汇总"
echo
printf '%s\n' "${RESULTS[@]}"
echo
echo "  通过: ${PASS}   失败: ${FAIL}"
echo "  日志: ${LOG_DIR}"
[[ "${FAIL}" == "0" ]] || exit 1
