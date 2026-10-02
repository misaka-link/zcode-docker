# ========================================================
# Dockerfile: zcode-docker
# Integrated ZCode AI Programming Workspace with Browser Desktop & Unified Gateway
# Runtime base: Debian Trixie (glibc 2.41) & Node 24
# ========================================================

ARG NODE_IMAGE=node:24-trixie

# --------------------------------------------------------
# Stage 1: builder (编译 ZCode 发行包或拉取预编译包)
# --------------------------------------------------------
FROM ${NODE_IMAGE} AS builder

LABEL maintainer="ZCode Community"
LABEL description="Builder stage for ZCode runtime distribution"

ENV DEBIAN_FRONTEND=noninteractive

# 镜像加速开关 (默认 1 使用 USTC 镜像与 npmmirror，CI 或海外构建设为 0)
ARG USE_CHINA_MIRROR=1
RUN if [ "$USE_CHINA_MIRROR" = "1" ] || [ "$USE_CHINA_MIRROR" = "true" ]; then \
      sed -i 's/deb.debian.org/mirrors.ustc.edu.cn/g' /etc/apt/sources.list.d/debian.sources 2>/dev/null || \
      sed -i 's/deb.debian.org/mirrors.ustc.edu.cn/g' /etc/apt/sources.list 2>/dev/null || true; \
      npm config set registry https://registry.npmmirror.com; \
    fi

# 安装编译依赖与工具
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash \
    curl \
    wget \
    git \
    ca-certificates \
    python3 \
    build-essential \
    tar \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# 启用 corepack 并锁定 pnpm 版本（匹配 ZCode mise.toml 规范）
RUN corepack enable && corepack prepare pnpm@10.33.2 --activate

# 构建参数
ARG ZCODE_REF=v3.14.3
ARG ZCODE_DIST_URL=""
ARG WITH_DESKTOP_CLIENT=0

# 执行构建：优先使用离线 URL（若提供），否则从源码克隆编译
RUN mkdir -p /out /out/desktop-client \
    && if [ -n "${ZCODE_DIST_URL}" ]; then \
         echo "===> 使用离线分发 URL: ${ZCODE_DIST_URL}"; \
         VER="${ZCODE_REF#v}"; \
         case "${ZCODE_DIST_URL}" in \
           *.tar.gz) \
             curl -fsSL "${ZCODE_DIST_URL}" -o /out/zcode-runtime.tar.gz; \
             ;; \
           *) \
             DIST_BASE="${ZCODE_DIST_URL%/}"; \
             curl -fsSL "${DIST_BASE}/releases/${VER}/zcode-${VER}.tar.gz" -o /out/zcode-runtime.tar.gz; \
             ;; \
         esac; \
         echo "${VER}" > /out/zcode-version.txt; \
       else \
         echo "===> 从源码克隆并编译 ZCode (ref: ${ZCODE_REF})..."; \
         git clone --depth 1 --branch "${ZCODE_REF}" https://github.com/zai-org/ZCode.git /src/ZCode; \
         cd /src/ZCode; \
         if [ "$USE_CHINA_MIRROR" = "1" ] || [ "$USE_CHINA_MIRROR" = "true" ]; then \
           pnpm config set registry https://registry.npmmirror.com; \
         fi; \
         pnpm install --frozen-lockfile; \
         echo "===> 预编译无独立 build 脚本的 workspace 包 (shared/services/client)..."; \
         pnpm exec tsc -b packages/shared packages/services packages/client; \
         pnpm build:zcode --base-url https://example.invalid/zcode/; \
         TARBALL=$(ls -1 /src/ZCode/dist/zcode/releases/*/zcode-*.tar.gz 2>/dev/null | head -n 1); \
         if [ -z "${TARBALL}" ] || [ ! -f "${TARBALL}" ]; then \
           echo "错误: 未找到 ZCode 构建产物 tarball" >&2; \
           exit 1; \
         fi; \
         cp "${TARBALL}" /out/zcode-runtime.tar.gz; \
         if [ -f /src/ZCode/dist/zcode/latest.json ]; then \
           node -e "const j=JSON.parse(require('fs').readFileSync('/src/ZCode/dist/zcode/latest.json'));process.stdout.write(j.version);" > /out/zcode-version.txt; \
         else \
           echo "${ZCODE_REF#v}" > /out/zcode-version.txt; \
         fi; \
         if [ "$WITH_DESKTOP_CLIENT" = "1" ] || [ "$WITH_DESKTOP_CLIENT" = "true" ]; then \
           echo "===> 编译 Electron 桌面客户端..."; \
           pnpm bundle:desktop -- --os linux; \
           cp -r packages/desktop/dist/* /out/desktop-client/ 2>/dev/null || true; \
         fi; \
       fi

# --------------------------------------------------------
# Stage 2: runtime (运行环境)
# --------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime

LABEL maintainer="ZCode Community"
LABEL description="Production Docker image for ZCode AI Programming Workspace"

ENV DEBIAN_FRONTEND=noninteractive \
    PROXY_PORT=3080 \
    ZCODE_PORT=3030 \
    VNC_PORT=6080 \
    ZCODE_HOME=/root \
    ZCODE_WORKSPACE=/workspace \
    ZCODE_BROWSE_ROOT=/workspace \
    NOVNC_ASSET_REVISION=1.6.0 \
    DISPLAY=:99 \
    LANG=zh_CN.UTF-8 \
    LANGUAGE=zh_CN:zh \
    LC_ALL=zh_CN.UTF-8

# 镜像加速配置
ARG USE_CHINA_MIRROR=1
RUN if [ "$USE_CHINA_MIRROR" = "1" ] || [ "$USE_CHINA_MIRROR" = "true" ]; then \
      sed -i 's/deb.debian.org/mirrors.ustc.edu.cn/g' /etc/apt/sources.list.d/debian.sources 2>/dev/null || \
      sed -i 's/deb.debian.org/mirrors.ustc.edu.cn/g' /etc/apt/sources.list 2>/dev/null || true; \
      npm config set registry https://registry.npmmirror.com; \
    fi

# 安装运行时依赖、虚拟桌面 (Xvfb/VNC) 与 Chromium 浏览器
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash \
    curl \
    wget \
    git \
    openssh-client \
    ca-certificates \
    procps \
    psmisc \
    iproute2 \
    locales \
    python3 \
    # 常用实用 CLI 研发工具
    file \
    jq \
    less \
    ripgrep \
    rsync \
    zip \
    unzip \
    # 快照/备份与运行时置换必需（backup-service 依赖 tar）
    tar \
    gzip \
    # X11 虚拟显示与桌面
    xvfb \
    x11-utils \
    openbox \
    x11vnc \
    novnc \
    websockify \
    # X11 截屏兜底引擎（CDP 不可用时 browser_screenshot 降级使用）
    scrot \
    # 容器 Chromium 浏览器及运行库
    chromium \
    libnss3 \
    fontconfig \
    fonts-noto-cjk \
    fonts-wqy-zenhei \
    fonts-wqy-microhei \
    fonts-noto-color-emoji \
    && echo "zh_CN.UTF-8 UTF-8" >> /etc/locale.gen \
    && locale-gen zh_CN.UTF-8 \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# noVNC 静态资源版本化隔离：网关会 302 到 /vnc/novnc-<NOVNC_ASSET_REVISION>/vnc.html
RUN novnc_copy="$(mktemp -d)" \
    && cp -a /usr/share/novnc/. "${novnc_copy}/" \
    && mkdir -p "/usr/share/novnc/novnc-${NOVNC_ASSET_REVISION}" \
    && cp -a "${novnc_copy}/." "/usr/share/novnc/novnc-${NOVNC_ASSET_REVISION}/" \
    && rm -rf "${novnc_copy}" \
    && if [ ! -e /usr/share/novnc/index.html ]; then ln -s vnc.html /usr/share/novnc/index.html; fi

# 解压 Stage 1 产出的 ZCode 运行时到 /opt/zcode
COPY --from=builder /out/zcode-runtime.tar.gz /tmp/zcode-runtime.tar.gz
COPY --from=builder /out/zcode-version.txt /opt/zcode-version.txt
COPY --from=builder /out/desktop-client/ /opt/zcode-desktop/
RUN mkdir -p /tmp/zcode-extract \
    && tar -xzf /tmp/zcode-runtime.tar.gz -C /tmp/zcode-extract \
    && rm -f /tmp/zcode-runtime.tar.gz \
    && mkdir -p /opt/zcode \
    && if [ -f /tmp/zcode-extract/bin/zcode.mjs ]; then \
         cp -a /tmp/zcode-extract/. /opt/zcode/; \
       elif [ -d /tmp/zcode-extract/zcode ]; then \
         cp -a /tmp/zcode-extract/zcode/. /opt/zcode/; \
       else \
         first_dir=$(find /tmp/zcode-extract -mindepth 1 -maxdepth 1 -type d | head -n 1); \
         cp -a "${first_dir}"/. /opt/zcode/; \
       fi \
    && rm -rf /tmp/zcode-extract \
    && chmod +x /opt/zcode/bin/zcode.mjs

# 运行时补丁：支持通过 ZCODE_BROWSE_ROOT 定制 Web 目录浏览器默认根目录
COPY scripts/patch-zcode-runtime.mjs /opt/zcode-docker/patch-zcode-runtime.mjs
RUN node /opt/zcode-docker/patch-zcode-runtime.mjs --runtime /opt/zcode

# 复制版本元数据与统一网关代码并安装生产依赖
COPY version.json* /opt/
COPY version.json* /opt/zcode-gateway/
COPY gateway/ /opt/zcode-gateway/
RUN cd /opt/zcode-gateway && npm install --omit=dev

# 内置插件市场（开箱即用：容器启动时自动首装，见 entrypoint 第 10.5 步）
COPY plugins/ /opt/zcode-docker/plugins/

# 复制容器入口脚本与 Chromium 启动包装器并赋予可执行权限
COPY scripts/entrypoint.sh /opt/zcode-docker/entrypoint.sh
COPY scripts/chromium-docker /opt/zcode-docker/chromium-docker
RUN chmod +x /opt/zcode-docker/entrypoint.sh /opt/zcode-docker/chromium-docker \
    && ln -sf /opt/zcode-docker/chromium-docker /usr/local/bin/chromium-docker

# 工作目录与数据卷声明
WORKDIR /workspace
VOLUME ["/root/.zcode", "/root/.zcode-snapshots", "/workspace", "/root/.config/chromium"]

# 暴露对外统一端口
EXPOSE 3080

# 健康检查：统一网关提供免鉴权 /healthz
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3080/healthz || exit 1

ENTRYPOINT ["/opt/zcode-docker/entrypoint.sh"]
