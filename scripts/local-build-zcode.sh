#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
UPSTREAM_DIR="${WORKSPACE_ROOT}/.upstream/ZCode"
BUILD_DIR="${WORKSPACE_ROOT}/.build"
LOGS_DIR="${BUILD_DIR}/logs"

FORCE=0
BASE_URL="https://example.invalid/zcode/"
PATCH_RUNTIME_DIR=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --force)
      FORCE=1
      shift
      ;;
    --base-url)
      BASE_URL="$2"
      shift 2
      ;;
    --base-url=*)
      BASE_URL="${1#*=}"
      shift
      ;;
    --patch-runtime)
      PATCH_RUNTIME_DIR="$2"
      shift 2
      ;;
    --patch-runtime=*)
      PATCH_RUNTIME_DIR="${1#*=}"
      shift
      ;;
    -h|--help)
      echo "Usage: $0 [--force] [--base-url <url>] [--patch-runtime <dir>]"
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

patch_runtime_if_needed() {
  local target_dir=""
  if [[ -n "${PATCH_RUNTIME_DIR}" ]]; then
    target_dir="${PATCH_RUNTIME_DIR}"
  elif [[ -d "${BUILD_DIR}/e2e/runtime" ]]; then
    target_dir="${BUILD_DIR}/e2e/runtime"
  fi

  if [[ -n "${target_dir}" ]]; then
    echo "--- Applying runtime patch (target: ${target_dir}) ---"
    node "${WORKSPACE_ROOT}/scripts/patch-zcode-runtime.mjs" --runtime "${target_dir}"
  fi
}

mkdir -p "${LOGS_DIR}"

if [[ ! -f "${UPSTREAM_DIR}/package.json" ]]; then
  echo "Error: Upstream ZCode not found at ${UPSTREAM_DIR}" >&2
  exit 1
fi

VERSION="$(node -e 'const pkg = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); console.log(pkg.version);' "${UPSTREAM_DIR}/package.json")"
TARGET_TARBALL="${BUILD_DIR}/zcode-${VERSION}.tar.gz"
VERSION_FILE="${BUILD_DIR}/zcode-version.txt"

if [[ ${FORCE} -eq 0 && -f "${TARGET_TARBALL}" && -f "${VERSION_FILE}" ]]; then
  echo "[build] Artifact already exists: ${TARGET_TARBALL}"
  echo "[build] Version file content: $(cat "${VERSION_FILE}")"
  echo "[build] Skipping build (use --force to rebuild)."
  patch_runtime_if_needed
  exit 0
fi

START_TIME=$(date +%s)
echo "=== Starting ZCode build (version: ${VERSION}) at $(date -u '+%Y-%m-%d %H:%M:%S UTC') ==="

# Environment optimizations and sandbox compatibility
export COREPACK_HOME="${COREPACK_HOME:-/tmp/corepack}"
export XDG_CACHE_HOME="${XDG_CACHE_HOME:-/tmp/cache}"
export npm_config_cache="${npm_config_cache:-/tmp/npm-cache}"
export TURBO_CACHE_DIR="${TURBO_CACHE_DIR:-/tmp/turbo-cache}"
export HUSKY=0
export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"

mkdir -p "${COREPACK_HOME}" "${XDG_CACHE_HOME}" "${npm_config_cache}" "${TURBO_CACHE_DIR}" /tmp/corepack-bin

# Step 1: Corepack setup for pnpm@10.33.2
echo "--- Step 1: Configuring Corepack and pnpm@10.33.2 ---"
corepack enable --install-directory /tmp/corepack-bin pnpm
export PATH="/tmp/corepack-bin:${PATH}"
corepack prepare pnpm@10.33.2 --activate

PNPM_VERSION="$(pnpm -v)"
echo "Active pnpm version: ${PNPM_VERSION}"
if [[ "${PNPM_VERSION}" != "10.33.2" ]]; then
  echo "Error: Expected pnpm 10.33.2, got ${PNPM_VERSION}" >&2
  exit 1
fi

# Step 2: pnpm install in .upstream/ZCode
echo "--- Step 2: Running pnpm install in ${UPSTREAM_DIR} ---"
cd "${UPSTREAM_DIR}"

INSTALL_LOG="${LOGS_DIR}/pnpm-install.log"
echo "Logging install to ${INSTALL_LOG}"

# Try install using current registry (default npmmirror), fall back to official registry if needed
set +e
pnpm install --frozen-lockfile --child-concurrency=2 2>&1 | tee "${INSTALL_LOG}"
INSTALL_STATUS=${PIPESTATUS[0]}
set -e

if [[ ${INSTALL_STATUS} -ne 0 ]]; then
  echo "pnpm install failed with current registry. Retrying with official registry (https://registry.npmjs.org)..."
  set +e
  pnpm install --frozen-lockfile --registry https://registry.npmjs.org --child-concurrency=2 2>&1 | tee -a "${INSTALL_LOG}"
  INSTALL_STATUS=${PIPESTATUS[0]}
  set -e
  if [[ ${INSTALL_STATUS} -ne 0 ]]; then
    echo "Error: pnpm install failed even with official registry. See ${INSTALL_LOG}" >&2
    exit ${INSTALL_STATUS}
  fi
fi

# Step 2.5: Compile packages that lack individual "build" scripts in package.json
# (Specifically @zcode/shared, @zcode/services, @zcode/client which are required during SEA/TUI packaging)
echo "--- Step 2.5: Compiling prerequisite packages (@zcode/shared, @zcode/services, @zcode/client) ---"
pnpm exec tsc -b packages/shared packages/services packages/client 2>&1 | tee -a "${INSTALL_LOG}"

# Step 3: pnpm build:zcode
echo "--- Step 3: Running pnpm build:zcode --base-url ${BASE_URL} ---"
BUILD_LOG="${LOGS_DIR}/pnpm-build.log"
echo "Logging build to ${BUILD_LOG}"

set +e
pnpm build:zcode --base-url "${BASE_URL}" 2>&1 | tee "${BUILD_LOG}"
BUILD_STATUS=${PIPESTATUS[0]}
set -e

if [[ ${BUILD_STATUS} -ne 0 ]]; then
  echo "Error: pnpm build:zcode failed. See ${BUILD_LOG}" >&2
  exit ${BUILD_STATUS}
fi

# Step 4: Verify and copy output artifact
echo "--- Step 4: Copying build artifact to ${BUILD_DIR} ---"
UPSTREAM_TARBALL="${UPSTREAM_DIR}/dist/zcode/releases/${VERSION}/zcode-${VERSION}.tar.gz"

if [[ ! -f "${UPSTREAM_TARBALL}" ]]; then
  echo "Error: Expected upstream tarball not found at ${UPSTREAM_TARBALL}" >&2
  exit 1
fi

cp -f "${UPSTREAM_TARBALL}" "${TARGET_TARBALL}"
echo "${VERSION}" > "${VERSION_FILE}"

# Step 5: Patch runtime if specified or if E2E runtime directory exists
patch_runtime_if_needed

END_TIME=$(date +%s)
DURATION=$((END_TIME - START_TIME))

echo "=== Build finished successfully in ${DURATION} seconds ==="
echo "Artifact: ${TARGET_TARBALL}"
echo "Size: $(ls -lh "${TARGET_TARBALL}" | awk '{print $5}')"
echo "SHA256: $(sha256sum "${TARGET_TARBALL}" | awk '{print $1}')"
echo "Version file: ${VERSION_FILE} ($(cat "${VERSION_FILE}"))"
