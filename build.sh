#!/bin/bash
set -eo pipefail

# ========================================================
# ZCode Docker 镜像构建工具 (build.sh)
#
# 支持参数:
#   --tag, -t <tag>         追加额外镜像标签 (支持多次指定)
#   --no-cache              禁用 Docker 构建缓存
#   --with-desktop-client   在构建阶段同时编译 Electron Linux 客户端
#   --dist-url <url>        使用预编译归档 URL，跳过源码 clone 与编译
#   --china-mirror=0|1      是否开启中国境内源加速 (默认 1)
#   --ref <ref>             指定构建的 ZCode Git ref (tag 或 commit，默认 v3.14.3)
#   -h, --help              查看帮助
# ========================================================

IMAGE_NAME="zcode-docker"
NODE_IMAGE="${NODE_IMAGE:-node:24-trixie}"
ZCODE_REF="${ZCODE_REF:-v3.14.3}"
ZCODE_DIST_URL="${ZCODE_DIST_URL:-}"
WITH_DESKTOP_CLIENT=0
USE_CHINA_MIRROR=1
NO_CACHE_FLAG=""
EXTRA_TAGS=()

# 读取套件自身版本号 (PROJECT_VERSION)
PROJ_VER="0.1.0"
if [ -f "version.json" ]; then
  PROJ_VER=$(node -e "try{const v=require('./version.json');process.stdout.write(String(v.version||'0.1.0'))}catch(e){process.stdout.write('0.1.0')}" 2>/dev/null || echo "0.1.0")
fi

print_usage() {
  cat <<USAGE
ZCode Docker 镜像构建脚本

用法:
  ./build.sh [选项]

选项:
  -t, --tag <tag>           追加镜像额外标签 (可多次传入)
  --no-cache                构建时不使用缓存
  --with-desktop-client     构建时一并打包 Electron Linux 客户端 (镜像体积增加)
  --dist-url <url>          指定离线发行包下载基址或 tarball 地址 (跳过源码编译)
  --china-mirror=<0|1>      配置国内镜像加速 (默认 1，0 为关闭)
  --ref <ref>               指定上游 Git 分支或标签 (默认: v3.14.3)
  --node-image <image>      指定 Node 基础镜像 (默认: node:24-trixie)
  -h, --help                显示此帮助信息
USAGE
}

# 参数解析
while [ $# -gt 0 ]; do
  case "$1" in
    --tag|-t)
      if [ -z "${2:-}" ] || [[ "$2" == --* ]]; then
        echo "错误: --tag 参数缺少值" >&2; exit 1
      fi
      EXTRA_TAGS+=("$2")
      shift 2
      ;;
    --tag=*)
      EXTRA_TAGS+=("${1#*=}")
      shift
      ;;
    --no-cache)
      NO_CACHE_FLAG="--no-cache"
      shift
      ;;
    --with-desktop-client)
      WITH_DESKTOP_CLIENT=1
      shift
      ;;
    --dist-url)
      if [ -z "${2:-}" ] || [[ "$2" == --* ]]; then
        echo "错误: --dist-url 参数缺少值" >&2; exit 1
      fi
      ZCODE_DIST_URL="$2"
      shift 2
      ;;
    --dist-url=*)
      ZCODE_DIST_URL="${1#*=}"
      shift
      ;;
    --china-mirror=*)
      USE_CHINA_MIRROR="${1#*=}"
      shift
      ;;
    --china-mirror)
      if [ -z "${2:-}" ] || [[ "$2" == --* ]]; then
        echo "错误: --china-mirror 参数缺少值" >&2; exit 1
      fi
      USE_CHINA_MIRROR="$2"
      shift 2
      ;;
    --ref)
      if [ -z "${2:-}" ] || [[ "$2" == --* ]]; then
        echo "错误: --ref 参数缺少值" >&2; exit 1
      fi
      ZCODE_REF="$2"
      shift 2
      ;;
    --ref=*)
      ZCODE_REF="${1#*=}"
      shift
      ;;
    --node-image)
      if [ -z "${2:-}" ] || [[ "$2" == --* ]]; then
        echo "错误: --node-image 参数缺少值" >&2; exit 1
      fi
      NODE_IMAGE="$2"
      shift 2
      ;;
    --node-image=*)
      NODE_IMAGE="${1#*=}"
      shift
      ;;
    -h|--help)
      print_usage
      exit 0
      ;;
    *)
      echo "错误: 未知参数: $1" >&2
      print_usage
      exit 1
      ;;
  esac
done

CORE_VER="${ZCODE_REF#v}"

# 构建标签集合
TAG_ARGS=(
  -t "${IMAGE_NAME}:latest"
  -t "${IMAGE_NAME}:${PROJ_VER}"
  -t "${IMAGE_NAME}:v${PROJ_VER}"
  -t "${IMAGE_NAME}:zcode-${CORE_VER}"
  -t "${IMAGE_NAME}:${CORE_VER}"
)

if [ "${WITH_DESKTOP_CLIENT}" = "1" ]; then
  TAG_ARGS+=(
    -t "${IMAGE_NAME}:latest-desktop"
    -t "${IMAGE_NAME}:v${PROJ_VER}-desktop"
  )
fi

for extra in "${EXTRA_TAGS[@]}"; do
  TAG_ARGS+=(-t "${IMAGE_NAME}:${extra}")
done

echo "========================================================="
echo " 开始构建 ZCode Docker 镜像"
echo " 镜像名称:          ${IMAGE_NAME}"
echo " 套件版本 (PROJ):   ${PROJ_VER}"
echo " 核心版本 (CORE):   ${CORE_VER} (${ZCODE_REF})"
echo " 基础镜像:          ${NODE_IMAGE}"
echo " 编译桌面客户端:    $([ "${WITH_DESKTOP_CLIENT}" = "1" ] && echo '是' || echo '否')"
echo " 离线分发 URL:      ${ZCODE_DIST_URL:-<源码在线编译>}"
echo " 国内源加速:        $([ "${USE_CHINA_MIRROR}" = "1" ] && echo '开启' || echo '关闭')"
echo " 缓存控制:          $([ -n "${NO_CACHE_FLAG}" ] && echo '无缓存' || echo '使用缓存')"
echo "========================================================="

docker build \
  ${NO_CACHE_FLAG} \
  --build-arg NODE_IMAGE="${NODE_IMAGE}" \
  --build-arg ZCODE_REF="${ZCODE_REF}" \
  --build-arg ZCODE_DIST_URL="${ZCODE_DIST_URL}" \
  --build-arg WITH_DESKTOP_CLIENT="${WITH_DESKTOP_CLIENT}" \
  --build-arg USE_CHINA_MIRROR="${USE_CHINA_MIRROR}" \
  "${TAG_ARGS[@]}" \
  .

echo ""
echo "========================================================="
echo ">>> ✅ 镜像构建完成！已产出标签:"
for i in "${!TAG_ARGS[@]}"; do
  if [ "${TAG_ARGS[$i]}" = "-t" ]; then
    echo "    - ${TAG_ARGS[$((i+1))]}"
  fi
done
echo ""
echo ">>> 运行配置静态语法校验 (验证 docker-compose.yml 与环境变量):"
echo "    docker compose config"
echo ""
echo ">>> 一键启动运行:"
echo "    docker compose up -d"
echo ""
echo ">>> 查看运行日志:"
echo "    docker compose logs -f"
echo "========================================================="
