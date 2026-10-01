# zcode-docker 网关契约（v1，冻结版）

> 本文件是 `zcode-docker` 各模块之间的**唯一接口契约**。任何模块实现都必须严格遵循本文件的路径、环境变量、导出接口与行为。
> 参考实现（模板）：`/workspace/deepseek-harness-docker/gateway/`
> 上游源码（只读）：`/workspace/zcode-docker/.upstream/ZCode`（zai-org/ZCode v3.14.3）

---

## 0. 命名总则

- 参考项目中所有 `dsh` / `DSH` 概念，在本项目中一律替换为 `zcode` / `ZCode`。
- 管理 API 前缀由 `/api/dsh/` 改为 **`/api/zcode/`**（其余 `/api/*` 保持不变）。
- 套件自身版本变量：`PROJECT_VERSION`（见 `version.json`），核心运行时版本：`coreVersion`。

---

## 1. 上游 ZCode 启动契约（实测）

发行包布局（构建产物 `dist/zcode/releases/<v>/zcode-<v>.tar.gz` 解压后）：

```
<runtime>/bin/zcode.mjs        # runner：--web / TUI
<runtime>/server/entry-http.js # HTTP + WebSocket 服务
<runtime>/agent/zcode.cjs      # Agent
<runtime>/web/                 # 静态前端（ZCODE_WEB_STATIC_ROOT）
<runtime>/package.json         # { version }
```

启动方式（网关只使用 Web 模式）：

```bash
node <runtime>/bin/zcode.mjs --web \
  --host 127.0.0.1 --port 3030 \
  --workspace /workspace --no-open --no-token
```

runner 会为子进程注入：`PORT`、`ZCODE_SERVER_HOST`、`ZCODE_SERVER_WORKSPACE`、`ZCODE_WEB_STATIC_ROOT`、
`ZCODE_SERVER_AUTH_TOKEN`、`ZCODE_AGENT_SERVER_COMMAND`、`ZCODE_AGENT_SERVER_ARGS_JSON`。

- 上游鉴权：`?token=<T>` 查询参数 或 cookie `zcode_lite_token`（`packages/server/src/http.ts`）。
- 网关与上游同机回环，**默认以 `--no-token` 启动**（`ZCODE_SERVER_AUTH_TOKEN=""`），由网关统一认证；
  若 `ZCODE_INTERNAL_TOKEN=1`，则网关生成内部令牌并以 `?token=` / cookie 注入（见 §4.3）。
- 健康检查：`GET http://127.0.0.1:<ZCODE_PORT>/` 返回 200 即视为就绪（静态页）。

数据目录（`packages/services/src/paths.ts`）：

| 用途 | 路径 |
|---|---|
| 数据根 | `$ZCODE_DATA_BASE_DIR/.zcode`（默认 `$HOME/.zcode` → `/root/.zcode`） |
| 配置目录 | `<数据根>/v2` |
| 默认会话工作区 | `<数据根>/workspace/default` |

---

## 2. 环境变量（网关与入口脚本共同契约）

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PROXY_PORT` | `3080` | 网关唯一对外端口（env 显式设置优先于持久化配置） |
| `ZCODE_PORT` | `3030` | 上游 ZCode Web 端口（仅回环） |
| `VNC_PORT` | `6080` | websockify 端口（仅回环） |
| `ZCODE_HOME` | `/root` | 运行根目录（非 root 部署可设 `/home/zcode`） |
| `ZCODE_DIR` | `${ZCODE_HOME}/.zcode` | ZCode 数据目录（挂载卷） |
| `ZCODE_SNAPSHOT_DIR` | `${ZCODE_HOME}/.zcode-snapshots` | 快照与版本库（挂载卷） |
| `ZCODE_VERSIONS_DIR` | `${ZCODE_SNAPSHOT_DIR}/versions` | 多版本运行时库 |
| `ZCODE_RUNTIME_DIR` | `/opt/zcode` | 当前活动运行时（原子置换） |
| `ZCODE_RUNTIME_PARENT` | `/opt` | 置换/回滚点的父目录 |
| `ZCODE_WORKSPACE` | `/workspace` | AI 工作区 |
| `ZCODE_DIST_URL` | 空 | 版本下载基址（`<base>/releases/<v>/zcode-<v>.tar.gz`）；空则禁用在线安装 |
| `ADMIN_PATH` | `/admin` | 控制台路径 |
| `VNC_PATH` | `/vnc` | 桌面路径 |
| `AUTH_TOKEN` | 空 | 访问口令；空 → 首次访问进初始化向导 |
| `TRUST_PROXY` | `0` | 是否信任 `X-Forwarded-For` |
| `PUBLIC_HOST` | 空 | WebSocket 同源白名单（逗号分隔） |
| `ZCODE_DESKTOP_ENABLED` | `1` | 虚拟桌面总开关 |
| `ZCODE_DESKTOP_MODE` | `browser` | `browser`=Chromium 指向 ZCode Web；`client`=Electron 客户端 |
| `ZCODE_DESKTOP_WIDTH` / `_HEIGHT` / `_DEPTH` | `1920` / `1080` / `24` | 分辨率 |
| `ZCODE_IDLE_TIMEOUT_MINUTES` | `30` | 空闲休眠（0=不休眠） |
| `ZCODE_SCREENSHOT_QUALITY` | `high` | AI 截图默认画质 |
| `ZCODE_SCREENSHOT_DIR` | 空 | AI 截图默认子目录 |
| `CHROME_USER_DATA_DIR` | `${ZCODE_HOME}/.config/chromium` | 浏览器用户数据 |
| `ZCODE_WEB_LOG` | `${ZCODE_DIR}/logs/zcode-web.log` | 上游日志（10MB 轮转） |
| `ZCODE_GATEWAY_LOG` | `${ZCODE_DIR}/logs/gateway.log` | 网关日志 |
| `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`/`NO_PROXY` | 空 | 出站代理（含小写归一化） |

---

## 3. HTTP 路由表（网关 `gateway/index.js`）

认证前（白名单）：

| 方法 | 路径 | 行为 |
|---|---|---|
| GET | `/login` | 登录页（`public/login.html`） |
| POST | `/__auth/verify` | 口令校验，下发会话 Cookie |
| GET | `/logout` | 清会话 |
| GET | `/setup` | 初始化向导页（仅未设置口令时） |
| POST | `/__auth/setup` | 写入初始口令（0600 持久化） |
| GET | `/healthz` | `{ ok, version, core:{...} }` |
| GET | `/favicon.svg` `/favicon.ico` | 图标 |

认证后：

| 方法 | 路径 | 行为 |
|---|---|---|
| GET | `/` 及其它 | 反代到 `http://127.0.0.1:${ZCODE_PORT}`（含 WebSocket `/ws`） |
| GET | `${ADMIN_PATH}` `/` | `public/admin.html`（注入 `__ZCODE_ADMIN_PATH__` 等占位符） |
| * | `${ADMIN_PATH}/api/*` | 管理 REST（见 §4） |
| * | `${VNC_PATH}/*` | noVNC 静态 + `/vnc.html` |
| WS | `/websockify`、`${VNC_PATH}/websockify` | VNC WebSocket |
| GET | `/__api/desktop/status` | 稳定桌面状态接口（插件用） |
| POST | `/__api/desktop/start` | 唤醒桌面 |
| * | `/__internal/desktop/*` | 内部接口，需 `internal-token` |

`/__api/desktop/status` 返回：

```json
{ "enabled": true, "running": true, "starting": false, "mode": "browser",
  "width": 1920, "height": 1080, "cdpPort": 9222, "idleTimeoutMinutes": 30,
  "vncPath": "/vnc", "paths": { "admin": "/admin", "vnc": "/vnc", "proxyPort": 3080 } }
```

---

## 4. 管理 REST API（`${ADMIN_PATH}/api/...`）

统一返回 `{ ok: true, ... }` 或 `{ ok: false, error: "..." }`；SSE 接口返回 `text/event-stream`。

### 4.1 状态与版本

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/status` | `{ ok, project:{version}, core:{version,running,ready,port,pid,manualStopped,lastExit}, desktop:{...}, auth:{enabled,source}, paths:{admin,vnc,proxyPort}, disk:{freeMB} }` |
| GET | `/api/version/check?refresh=1` | 套件/上游版本检查（`version-service`） |
| GET | `/api/zcode/versions?refresh=1` | 可安装运行时版本列表 + 本地已缓存 |
| GET | `/api/zcode/versions/stats` | 版本库磁盘占用 |
| POST | `/api/zcode/versions/gc` | LRU 清理（保留 `keep` 个） |
| DELETE | `/api/zcode/versions/:version` | 删除本地缓存版本 |
| GET | `/api/zcode/rollback` | 当前回滚点信息 |
| DELETE | `/api/zcode/rollback` | 丢弃回滚点 |
| POST | `/api/zcode/rollback/restore` | 就地回滚（SSE） |
| GET | `/api/zcode/logs?lines=200` | 运行日志尾部 |
| POST | `/api/zcode/install` | 安装/切换版本（SSE；body `{version}`） |
| POST | `/api/zcode/start` / `stop` / `restart` | 进程控制 |
| POST | `/api/zcode/auto-heal/clear` | 清空自动隔离事件 |

### 4.2 桌面 / 快照 / 插件 / 配置

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/desktop/master` | `{enabled}` 桌面总开关 |
| POST | `/api/desktop/config` | `{mode,width,height,idleTimeoutMinutes,enableCdp,cdpPort,screenshotQuality,screenshotDir}` |
| POST | `/api/desktop/start` / `stop` / `restart` / `keepalive` | 桌面生命周期 |
| GET | `/api/snapshots` | 快照列表（含创建环境版本元数据） |
| POST | `/api/snapshots/create` | `{label}` 创建快照 |
| GET | `/api/snapshots/inspect?file=` | 快照内容摘要 |
| POST | `/api/snapshots/restore` | `{filename, mode:"full"\|"config-only"}`（内部 `restoreBackup(filename, zcodeManager, {mode})`，超时 ≥600s） |
| POST | `/api/snapshots/import` | 上传归档导入 |
| POST | `/api/snapshots/delete` | `{file}` |
| GET | `/api/snapshots/download?file=` | 下载归档 |
| GET | `/api/plugins` | 插件列表（来自 `zcode plugins list --json`） |
| POST | `/api/plugins/toggle` | `{id,enabled}` → `zcode plugins enable/disable` |
| POST | `/api/plugins/uninstall` | `{id}` |
| POST | `/api/plugins/install` | `{source}`（SSE；`source` = `name` 或 `name@marketplace`） |
| POST | `/api/config/save` | `{proxyPort?,adminPath?,vncPath?,desktop?{},trustProxy?,publicHost?}` |

### 4.3 上游令牌注入

- 默认：上游 `--no-token`，网关不做注入。
- 当 `ZCODE_INTERNAL_TOKEN=1`：网关生成 32 字节令牌（持久化 `${ZCODE_DIR}/.internal_upstream_token`，0600），
  以 `--token` 启动上游；反代时为 HTML 导航注入 `?token=`，并在响应 `Set-Cookie: zcode_lite_token=<T>`（`Path=/; HttpOnly; SameSite=Lax`）。

---

## 5. 模块接口契约（Node CommonJS）

### 5.1 `gateway/zcode-manager.js`（单例，替换 `dsh-manager.js`）

```js
module.exports = {
  // 生命周期
  async boot(),                       // 启动上游；就绪后 resolve
  async stop(),                       // 停止上游（幂等）
  async restart(),
  isRunning(),                        // boolean
  getStatus(),                        // { version, running, ready, port, pid, manualStopped, lastExit, mode }
  getRecentLogs(lines),               // string

  // 版本库（目录见 §2）
  async fetchAvailableVersions(force),// [{version, size, url, cached, installed}]
  async installVersion(version, onEvent), // 下载→校验→解压→原子置换；onEvent({type,message,percent})
  isValidVersion(v),                  // boolean
  async getVersionsStoreStats(),      // { count, bytes, versions:[...] }
  async gcVersions(keep),             // { removed:[...] }
  async deleteCachedVersion(v),       // boolean

  // 回滚点（单槽位）
  getRollbackPoint(),                 // { version, path, createdAt } | null
  async restoreRollbackPoint(onEvent),// 就地还原（SSE 事件流）
  async deleteRollbackPoint(),

  // 自愈
  autoHealEnabled, maxAutoHealPerBoot,
  setAutoHeal(enabled),
  getAutoIsolatedEvents(),
  clearAutoIsolatedEvents(),

  // 快照代理（透传给 backup-service）
  ensureDefaultSnapshot(), listSnapshots(), restoreSnapshot(f), deleteSnapshot(f), getSnapshotPath(f),
};
```

### 5.2 `gateway/desktop-manager.js`（单例）

```js
module.exports = {
  isEnabled(), setEnabled(bool),
  async start(), async stop(), async restart(),
  getStatus(),  // { enabled, running, starting, mode, width, height, depth, cdpPort, enableCdp, idleTimeoutMinutes, screenshotQuality, screenshotDir, lastActivity }
  updateConfig(patch), applyConfig(patch), touchActivity(),
};
```

### 5.3 `gateway/backup-service.js`（已实现，ZCode 原生）

```js
module.exports = {
  DATA_DIR, SNAPSHOTS_DIR,
  async listBackups(),                     // [{ file, size, mtime, label, scope, meta }]
  async createBackup(label, scope),        // scope: 'config' | 'full'（默认 'config'）
  async restoreBackup(file, manager, {mode}), // mode: 'full' | 'config-only'（默认 'full'）；manager 传 zcodeManager
  async deleteBackup(file),
  getBackupPath(file),
  async inspectSnapshot(file),             // { ok, file, size, meta, members, links, topLevel, compatibility }
  async importBackupStream(stream, filename),
  async validateArchive(file),
};
```

### 5.4 `gateway/plugin-manager.js`（已实现，走 `zcode plugins` CLI）

```js
module.exports = {
  async getPlugins(),           // { ok, plugins:[{id,name,version,enabled,source,marketplace,description}], source }
  async getPluginsOverview(),   // { ok, installed, available, diagnostics }
  async togglePlugin(id, enabled),
  async uninstallPlugin(id),
  async installPlugin(source, onEvent),
  async updatePlugin(id),
  async listMarketplaces(),
  runCli(args, opts),
};
```

### 5.5 `gateway/version-service.js`（已实现）

```js
module.exports = {
  async check({force}),            // { ok, project:{version,meta}, core:{version,installable,updateAvailable}, remote, evaluated }
  async fetchRemoteMeta({force}),
  isUsingRemoteMeta(),
  getLocalProjectVersion(),
  getLocalCoreVersion(),
  getProjectMeta(),
  evaluateTargetVersion(v),        // { level:'ok'|'warn'|'danger', installable, message }
  compareVersions(a, b),
};
```

### 5.6 `gateway/snapshot-manifest.js`（已实现，供 backup-service 使用）

```js
module.exports = { ARCHIVE_ROOT_NAME, MANIFEST_RELATIVE, createManifest, parseManifest, validateMembers, isSafeSymlinkTarget, compareCompatibility };
```

### 5.7 `gateway/token-crawler.js`（已实现，ZCode 版最小接口）

```js
module.exports = { getLaunchToken, ensureUpstreamCookie, getCachedUpstreamCookie, RANDOM_UUID_POLYFILL, injectPolyfill, INTERNAL_TOKEN_ENABLED };
```

---

## 6. 快照与备份范围

| 快照范围 | 内容 |
|---|---|
| `config` | `$ZCODE_DIR` 下除 `logs/`、`workspace/` 外的配置与会话元数据 |
| `full` | `$ZCODE_DIR` 全量（含 `workspace/default`） |

归档格式：`tar.gz`，根目录 `.zcode/`，附 `manifest.json`（`{ createdAt, label, coreVersion, projectVersion, scope, members, sha256 }`）。
还原前校验：成员数上限、路径逃逸（含软链）、版本兼容性提示。工作区 `/workspace` 不进入快照（用户数据，单独挂载）。

---

## 7. 版本库与原子置换

- 版本库：`${ZCODE_VERSIONS_DIR}/<version>/`（解压后的运行时）。
- 安装：下载 → `sha256` 校验（若有）→ 解压到 `${ZCODE_VERSIONS_DIR}/.staging/<rand>` → 自检（`bin/zcode.mjs`、`server/entry-http.js`、`web/`、`package.json` 版本匹配）→
  停止上游 → 现有 `${ZCODE_RUNTIME_DIR}` 原子移动为 `${ZCODE_RUNTIME_PARENT}/.zcode-rollback-preserved` → `mv` 新目录为 `${ZCODE_RUNTIME_DIR}` → 启动 → 探活失败则自动回滚。
- 磁盘水位：切换前要求 `${ZCODE_VERSIONS_MIN_FREE_MB}`（默认 1536MB）空闲，否则拒绝并提示。
- 中断自愈：容器启动时若 `${ZCODE_RUNTIME_DIR}` 缺失，从 `.zcode-rollback-preserved` 或 `.zcode-rollback-tmp-*` 恢复。

---

## 8. 容器内路径约定（Docker）

| 路径 | 内容 |
|---|---|
| `/opt/zcode` | 活动运行时（`ZCODE_RUNTIME_DIR`） |
| `/opt/zcode-gateway` | 网关代码（只读） |
| `/root/.zcode` | 数据卷（配置/会话/日志） |
| `/root/.zcode-snapshots` | 快照卷（含 `versions/`） |
| `/workspace` | 工作区卷 |
| `/root/.config/chromium` | 浏览器卷 |
| `/var/log/zcode-docker/` | entrypoint 启动日志 |
