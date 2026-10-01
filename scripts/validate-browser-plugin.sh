#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# validate-browser-plugin.sh
# 调用 ZCode CLI 对 zcode-browser-desktop 插件目录执行 plugins validate 规范校验
# ==============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

DEFAULT_PLUGIN_DIR="${REPO_ROOT}/plugins/zcode-browser-desktop"
TARGET_PLUGIN="${1:-${DEFAULT_PLUGIN_DIR}}"

# 如果第一个参数是 -h 或 --help，打印帮助信息
if [[ "${TARGET_PLUGIN}" == "-h" || "${TARGET_PLUGIN}" == "--help" ]]; then
  echo "用法: $0 [插件目录路径] [可选额外参数...]"
  echo "默认校验路径: ${DEFAULT_PLUGIN_DIR}"
  exit 0
fi

# 检查目标插件目录是否存在
if [[ ! -d "${TARGET_PLUGIN}" ]]; then
  echo "[错误] 插件目录不存在: ${TARGET_PLUGIN}" >&2
  exit 1
fi

# 检查 Node.js 环境
if ! command -v node >/dev/null 2>&1; then
  echo "[错误] 系统未安装 Node.js，无法运行校验工具。" >&2
  exit 1
fi

# 探测可用的 ZCode CLI 运行时
ZCODE_RUNNER=""
PROBED_PATHS=()

# 1. 优先使用环境变量指定路径
if [[ -n "${ZCODE_CLI_BIN:-}" ]]; then
  PROBED_PATHS+=("${ZCODE_CLI_BIN}")
  if [[ -f "${ZCODE_CLI_BIN}" || -x "${ZCODE_CLI_BIN}" ]]; then
    ZCODE_RUNNER="${ZCODE_CLI_BIN}"
  fi
fi

# 2. 本地 E2E 构建运行时
if [[ -z "${ZCODE_RUNNER}" ]]; then
  CANDIDATE_PATHS=(
    "${REPO_ROOT}/.build/e2e/runtime/bin/zcode.mjs"
    "${REPO_ROOT}/.build/e2e-desktop/runtime/bin/zcode.mjs"
    "/opt/zcode/bin/zcode.mjs"
    "/opt/zcode/zcode.mjs"
  )
  for candidate in "${CANDIDATE_PATHS[@]}"; do
    PROBED_PATHS+=("${candidate}")
    if [[ -f "${candidate}" ]]; then
      ZCODE_RUNNER="${candidate}"
      break
    fi
  done
fi

# 3. 系统全局命令
if [[ -z "${ZCODE_RUNNER}" ]]; then
  if command -v zcode >/dev/null 2>&1; then
    ZCODE_RUNNER="$(command -v zcode)"
  else
    PROBED_PATHS+=("zcode (PATH)")
  fi
fi

# 若未能找到 ZCode CLI 运行时，输出明确提示并退出
if [[ -z "${ZCODE_RUNNER}" ]]; then
  echo "================================================================================" >&2
  echo "[错误] 未检测到可用的 ZCode CLI 运行时环境！" >&2
  echo "================================================================================" >&2
  echo "已检索以下候选路径，但均未找到可执行的 ZCode CLI:" >&2
  for p in "${PROBED_PATHS[@]}"; do
    echo "  - ${p}" >&2
  done
  echo "" >&2
  echo "解决建议:" >&2
  echo "  1. 若在本地开发环境，请先运行: bash scripts/local-build-zcode.sh 构建 E2E 运行时；" >&2
  echo "  2. 或通过环境变量指定现有运行时路径: export ZCODE_CLI_BIN=/path/to/zcode.mjs" >&2
  echo "  3. 若在已安装 ZCode 的系统上，请确保 zcode 在 PATH 环境变量中。" >&2
  echo "================================================================================" >&2
  exit 2
fi

echo "[INFO] 使用 ZCode CLI 运行时: ${ZCODE_RUNNER}"
echo "[INFO] 校验目标插件目录: ${TARGET_PLUGIN}"

# 根据文件类型决定调用方式
shift || true
if [[ "${ZCODE_RUNNER}" == *.mjs || "${ZCODE_RUNNER}" == *.js ]]; then
  node "${ZCODE_RUNNER}" plugins validate "${TARGET_PLUGIN}" "$@"
else
  "${ZCODE_RUNNER}" plugins validate "${TARGET_PLUGIN}" "$@"
fi
