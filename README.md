# zcode-docker

> 面向 [ZCode](https://github.com/zai-org/ZCode)（Z.ai 出品的 AI 编程工作台）的**开箱即用容器化套件**。
> 一个端口、一套口令，同时提供 **Web 工作区 / Web 控制台 / noVNC 虚拟桌面** 三入口。
>
> 本项目的控制台、登录认证、初始化向导与快照备份能力，继承自同源项目
> [`deepseek-harness-docker`](../deepseek-harness-docker)，把被封装的核心从 DeepSeek Harness 换成 ZCode。

---

## 1. 它是什么

| 能力 | 说明 |
|---|---|
| 🖥️ **ZCode Web 工作区** | 上游 ZCode 的浏览器界面（`zcode --web`），由容器内 `zcode-manager` 守护与探活 |
| 🎛️ **Web 控制台** | 版本管理（安装/切换/回滚）、插件、桌面、快照、系统设置五大面板 |
| 🪟 **noVNC 虚拟桌面** | Xvfb + x11vnc + noVNC，桌面里默认用 **Chromium 打开 ZCode Web**；也可切换为 **ZCode Electron 客户端** |
| 🔐 **统一认证** | 单口令保护全部入口；口令留空时首次访问进入「初始化向导」，凭据以 `0600` 持久化 |
| 📦 **快照与备份** | 配置快照的创建/列表/探测/下载/导入/还原（支持「仅配置」与「完整全量」两种范围） |
| 🔄 **版本热切换** | 多版本运行时库 + 原子置换 + 单槽位回滚 + 中断自愈（`ZCODE_DIST_URL` 可选） |
| 🧩 **原生插件** | 直接驱动 `zcode plugins list/install/enable/disable/uninstall/update`；套件自带 **ZCode 原生浏览器插件**（见 §9） |

---

## 2. 架构

```
                        宿主机 :3080（唯一暴露端口）
                                  │
        ┌─────────────────────────▼──────────────────────────┐
        │  gateway（Node，http + http-proxy，无框架）          │
        │  · 统一认证：登录页 / 会话 Cookie / 首次初始化向导     │
        │  · /            → ZCode Web   (127.0.0.1:3030)       │
        │  · /admin/      → Web 控制台（静态 + REST API）        │
        │  · /vnc/        → noVNC → x11vnc → Xvfb :99          │
        │  · /healthz、/logout、/__api/desktop/*、内部接口       │
        └───┬──────────────────────┬───────────────────┬──────┘
            │                      │                   │
   ZCode Web (3030)         控制台 API / 静态      虚拟桌面 :99
   zcode-manager 守护       快照 / 版本 / 插件      ├─ browser：Chromium → ZCode Web
   （探活 + 自愈 + 日志）                          └─ client ：ZCode Electron 客户端

   卷：/root/.zcode（数据） /root/.zcode-snapshots（快照+版本库）
       /workspace（工作区）  /root/.config/chromium（浏览器数据）
```

---

## 3. 快速开始

### 3.1 环境要求
- Docker Engine 24+（含 BuildKit）、Docker Compose v2+
- 构建镜像需要能访问 GitHub 与 npm 源；内存建议 ≥ 4 GB

### 3.2 一键启动

```bash
cp .env.example .env          # 可选：改 PROXY_PORT / AUTH_TOKEN；留空则首次访问进初始化向导
./build.sh                    # 构建镜像（国内默认走镜像加速）
docker compose up -d
docker compose logs -f
```

访问：

| 入口 | 地址 |
|---|---|
| Web 工作区 | `http://<服务器IP>:3080/` |
| Web 控制台 | `http://<服务器IP>:3080/admin/` |
| 虚拟桌面（noVNC） | `http://<服务器IP>:3080/vnc/` |

### 3.3 单行 docker run（等价的 compose 替代）

```bash
docker run -d --name zcode --restart unless-stopped -p 3080:3080 \
  -e AUTH_TOKEN=your-strong-token \
  -v $(pwd)/data/zcode:/root/.zcode \
  -v $(pwd)/workspace:/workspace \
  -v $(pwd)/data/snapshots:/root/.zcode-snapshots \
  -v $(pwd)/data/browser:/root/.config/chromium \
  zcode-docker:latest
```

### 3.4 常驻编排部署（推荐，已在服务器实测）

```bash
cd /path/to/zcode-docker
cp .env.example .env                       # 至少设置 AUTH_TOKEN 与 PROXY_PORT
mkdir -p data/zcode data/snapshots data/browser workspace
docker compose up -d                       # 编排启动（restart: unless-stopped，开机自启）
docker compose ps                          # 应显示 (healthy)
bash scripts/remote-compose-verify.sh 3080 "<你的AUTH_TOKEN>"   # 编排验收：19 项
```

要点：
- `PROXY_PORT` 同时决定 **宿主映射端口** 与 **容器内监听端口**，改一处即可（避免映射错位）。
- 数据落在 `./data/*` 与 `./workspace`，容器重建/升级镜像不丢数据。
- 容器内置 `HEALTHCHECK`（`/healthz`），`docker compose ps` 直接可见健康状态。
- 升级：`docker compose pull`（若用远程镜像）或重新 `./build.sh` 后 `docker compose up -d`。

---

## 4. 虚拟桌面的两种模式

由 `ZCODE_DESKTOP_MODE` 选择，也可在控制台「桌面」页运行时切换（切换后需重启桌面生效）：

| 模式 | 桌面里显示什么 | 说明 |
|---|---|---|
| `browser`（默认） | 容器内 **Chromium**，**默认打开空白页 `about:blank`** | 起始地址由 `ZCODE_DESKTOP_START_URL` 决定（见下）；默认开启 CDP（9222）便于自动化 |
| `client` | **ZCode Electron 桌面客户端** | 需镜像以 `--with-desktop-client` 构建（额外数百 MB），或设置 `ZCODE_CLIENT_BIN` 指向已有客户端 |

`ZCODE_DESKTOP_START_URL` 取值规则（`browser` 模式）：

| 取值 | 效果 |
|---|---|
| 空 / 未设置 / `about:blank` | 打开干净空白页（**默认，不会自动打开 ZCode Web**） |
| `zcode` / `zcode-web` | 打开容器内 ZCode Web（`http://127.0.0.1:3030/`，启用内部令牌时自动带 `?token=`） |
| `http(s)://...` | 打开指定网址 |

其余桌面能力：分辨率热切换（`ZCODE_DESKTOP_WIDTH/HEIGHT`）、空闲休眠（`ZCODE_IDLE_TIMEOUT_MINUTES`，0=常驻）、
CDP 开关与端口（`ZCODE_ENABLE_CDP` / `ZCODE_CDP_PORT`）、kiosk 全屏（`ZCODE_DESKTOP_KIOSK=1`，仅对非空白起始地址生效）、
AI 截图默认画质与目录。

> 「添加项目」的目录浏览器默认起始目录由 `ZCODE_BROWSE_ROOT` 控制（默认 `/workspace`），
> 实现方式见 [`scripts/patch-zcode-runtime.mjs`](scripts/patch-zcode-runtime.mjs)（构建期给运行时打一处最小补丁，不改 `HOME`）。

---

## 5. 环境变量

完整清单见 [`.env.example`](.env.example) 与契约 [`doc/api-contract.md`](doc/api-contract.md) §2，常用项：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `AUTH_TOKEN` | *空* | 统一访问口令；留空 → 首次访问进初始化向导并持久化 |
| `PROXY_PORT` | `3080` | 唯一对外端口（Web / 控制台 / 桌面共用） |
| `ADMIN_PATH` / `VNC_PATH` | `/admin` / `/vnc` | 控制台与桌面路径（可在控制台热改并持久化） |
| `ZCODE_WORKSPACE` | `/workspace` | AI 工作区 |
| `ZCODE_HOME` | `/root` | 运行根目录（非 root 部署可改 `/home/zcode`） |
| `ZCODE_DESKTOP_ENABLED` | `1` | 虚拟桌面总开关 |
| `ZCODE_DESKTOP_MODE` | `browser` | `browser` \| `client` |
| `ZCODE_DESKTOP_START_URL` | *空* | 桌面浏览器起始地址：空=`about:blank`；`zcode`=容器内 ZCode Web；`http(s)://…`=指定网址 |
| `ZCODE_BROWSE_ROOT` | `/workspace` | ZCode Web「添加项目」目录浏览器的默认起始目录 |
| `ZCODE_IDLE_TIMEOUT_MINUTES` | `30` | 桌面空闲休眠（0=不休眠） |
| `ZCODE_INTERNAL_TOKEN` | `0` | `1` 时网关为上游注入内部令牌（`?token=` + `zcode_lite_token` Cookie） |
| `ZCODE_DIST_URL` | *空* | 运行时版本下载基址；留空则禁用在线版本切换（只读当前版本） |
| `ZCODE_VERSIONS_MIN_FREE_MB` | `1536` | 版本切换前磁盘水位 |
| `TRUST_PROXY` / `PUBLIC_HOST` | `0` / *空* | 反代信任与 WebSocket 同源白名单 |
| `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` / `NO_PROXY` | *空* | 出站代理（自动大小写归一化） |

---

## 6. 数据卷

| 宿主路径 | 容器内 | 内容 |
|---|---|---|
| `./data/zcode` | `/root/.zcode` | 配置、会话、凭据、插件状态、日志（`logs/`） |
| `./workspace` | `/workspace` | AI 生成的项目代码与文档 |
| `./data/snapshots` | `/root/.zcode-snapshots` | 快照归档 + `versions/` 多版本运行时库 |
| `./data/browser` | `/root/.config/chromium` | 浏览器登录态与缓存 |

> 快照默认只覆盖 `/root/.zcode`（「仅配置」排除 `logs/`、`workspace/`）；`/workspace` 属用户资产，不进入快照。

---

## 7. 开发与验证

本仓库自带可复现的验证链路（脚本均在 [`scripts/`](scripts/)）：

| 脚本 | 作用 | 需要 Docker |
|---|---|---|
| [`local-build-zcode.sh`](scripts/local-build-zcode.sh) | 在本机构建 ZCode 发行包（`pnpm install` + 预编译基础包 + `pnpm build:zcode`），产物落 `.build/zcode-<v>.tar.gz` | 否 |
| [`e2e-local.sh`](scripts/e2e-local.sh) | 本地等效端到端：真实网关 + 真实上游，覆盖认证/反代/控制台 API/快照全链路 | 否 |
| [`desktop-logic-test.mjs`](scripts/desktop-logic-test.mjs) | 虚拟桌面编排逻辑（桩进程）：启动顺序、browser/client 模式、起始地址、热更新重启、回收 | 否 |
| [`validate-browser-plugin.sh`](scripts/validate-browser-plugin.sh) | 用 ZCode CLI 校验自带插件清单 | 否 |
| [`patch-zcode-runtime.mjs`](scripts/patch-zcode-runtime.mjs) | 构建期给运行时打最小补丁（`ZCODE_BROWSE_ROOT` 默认目录），幂等、可容忍失配 | 否 |

```bash
# 1) 构建 ZCode 发行包（产出 .build/zcode-<version>.tar.gz）
bash scripts/local-build-zcode.sh

# 2) 本地等效 E2E（拉起真实网关与真实上游）
bash scripts/e2e-local.sh

# 3) 桌面编排逻辑测试（桩进程，无需 X 服务器）
node scripts/desktop-logic-test.mjs

# 4) 插件清单校验
bash scripts/validate-browser-plugin.sh
```

镜像级验收：在任意具备 Docker 的机器上执行 `./build.sh && docker compose up -d`，
然后按 §3 的三个入口人工验证；`/healthz` 可用于自动化探活（容器已内置 `HEALTHCHECK`）。

---

## 8. 目录结构

```
zcode-docker/
├── Dockerfile                # 多阶段：Stage1 编译 ZCode 发行包，Stage2 运行时（Chromium/VNC/网关）
├── docker-compose.yml
├── .env.example
├── build.sh                  # 一键构建 + 多标签 + 运行指引
├── version.json              # 套件版本与兼容矩阵
├── gateway/                  # 统一网关（认证/反代/控制台 API/桌面/快照/版本/插件）
│   ├── index.js              # 路由与 REST API
│   ├── zcode-manager.js      # ZCode 运行时守护、版本库、原子置换、回滚、自愈
│   ├── desktop-manager.js    # Xvfb/x11vnc/noVNC/Chromium/客户端 编排
│   ├── backup-service.js     # 快照创建/还原/导入导出（.zcode 域）
│   ├── snapshot-manifest.js  # 快照清单与归档成员安全校验
│   ├── plugin-manager.js     # zcode plugins CLI 封装
│   ├── version-service.js    # 套件/上游版本信息与目标版本评估
│   ├── auth.js / internal-token.js / ws-origin.js / token-crawler.js
│   └── public/               # admin.html / login.html / setup.html / desktop-starting.html
├── plugins/                  # ZCode 原生插件
│   ├── marketplace.json      # 本地插件市场清单（供 zcode plugins marketplace add 使用）
│   └── zcode-browser-desktop/# 容器浏览器插件（MCP 工具 + Skill）
├── scripts/                  # entrypoint、运行时补丁、构建与验证脚本
└── doc/                      # 契约、上游事实、验证报告与截图
```

---

## 9. 自带插件：`zcode-browser-desktop`（ZCode 原生）

把参考项目的 DSH 版容器浏览器插件重写为 **ZCode 原生插件**（MCP + Skill，零第三方依赖），
给 Agent 提供：`browser_status` / `browser_open` / `browser_screenshot` / `browser_click` / `browser_type` / `browser_wait`，
底层驱动容器内 Chromium 的 CDP(9222) 与网关桌面接口。

```bash
# 校验插件清单（ZCode 原生规范）
bash scripts/validate-browser-plugin.sh

# 安装到运行中的容器（本地目录市场）
docker exec <容器名> node /opt/zcode/bin/zcode.mjs plugins marketplace add /path/to/plugins --scope user
docker exec <容器名> node /opt/zcode/bin/zcode.mjs plugins install zcode-browser-desktop@zcode-docker-local
docker exec <容器名> node /opt/zcode/bin/zcode.mjs plugins list --json
```

安装后可在控制台「插件管理」页看到 `zcode-browser-desktop`（状态：已启用）。
详见 [`plugins/zcode-browser-desktop/README.md`](plugins/zcode-browser-desktop/README.md)。

---

## 9. 与参考项目的映射

| 参考项目（DSH 版） | 本项目（ZCode 版） |
|---|---|
| `dsh-manager.js`（DSH 版本矩阵/熔断） | `zcode-manager.js`（运行时守护 + 版本库 + 原子置换 + 回滚） |
| `backup-service.js`（`.dsh` 配置世代模型） | `backup-service.js`（`.zcode` 域，保留安全校验与还原范围） |
| `plugin-manager.js`（DSH 插件体系） | `plugin-manager.js`（`zcode plugins` CLI） |
| `version-service.js`（DSH Releases + version.json 矩阵） | `version-service.js`（`zai-org/ZCode` Releases + 自建 dist 索引） |
| `/root/.dsh`、`/root/.dsh-snapshots` | `/root/.zcode`、`/root/.zcode-snapshots` |
| DSH Web（3079） | ZCode Web（3030） |
| `dsh-browser-desktop` 插件驱动的浏览器桌面 | 桌面默认即打开 ZCode Web；支持 Electron 客户端模式 |

---

## 10. FAQ 与排障

**Q1 首次访问没有登录页？** 说明 `AUTH_TOKEN` 为空且尚未初始化口令，会自动进入 `/setup` 向导；设置后凭据持久化在数据卷。

**Q2 控制台显示「运行时未就绪」？** 查看 `/root/.zcode/logs/zcode-web.log`（或控制台「版本」页日志）；
常见原因是工作区权限或出站代理导致上游启动失败。

**Q3 桌面打开是黑屏？** 确认 `ZCODE_DESKTOP_ENABLED=1` 且容器内 Xvfb 正常；控制台「桌面」页可查看进程状态并一键重启。
`client` 模式下若镜像未打包客户端，会给出明确错误并提示改用 `browser`。

**Q4 如何升级 ZCode 运行时？** 配置 `ZCODE_DIST_URL` 指向发行包索引（`<base>/latest.json` 与
`<base>/releases/<v>/zcode-<v>.tar.gz`），然后在控制台「版本」页一键安装并切换；切换前会自动保存回滚点。

**Q5 端口/路径能改吗？** 能。`PROXY_PORT` 由 `.env` 决定宿主映射；`ADMIN_PATH`、`VNC_PATH` 可在控制台热改并持久化。

**Q6 安全基线？** `docker-compose.yml` 默认 `no-new-privileges:true` + `cap_drop: ALL` + 最小 `cap_add`；
入口脚本会强制收紧数据卷与凭据文件权限（`0700`/`0600`）。

---

## 11. 许可与声明

本项目为 ZCode 的**非官方容器化封装**，ZCode 本体版权归其作者所有（见 [zai-org/ZCode](https://github.com/zai-org/ZCode)）。
容器内的 ZCode 发行包在构建时从上游源码编译，遵循上游许可。
