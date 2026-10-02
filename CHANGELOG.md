# 更新日志 (Changelog)

本文件记录 zcode-docker 套件的实质性功能变更与缺陷修复。

## v0.1.2

### 新增

- **插件 `zcode-browser-desktop` 内置镜像开箱即用**：Dockerfile 将 `plugins/` 本地插件市场 COPY 进镜像（`/opt/zcode-docker/plugins`），`entrypoint.sh` 新增第 10.5 步在网关启动前幂等完成首装/升级（未安装则 `marketplace add` + `plugins install`，已装旧版本则 `marketplace update` + `plugins update`，已装同版本或更新版本则跳过、绝不触碰 enable/disable 启用位），部署后无需再手动两步安装，也不触发「待重启生效」中间态；新增环境变量 `ZCODE_BUILTIN_PLUGINS`（默认 `1`，设 `0` 关闭）可禁用该行为；CI 冒烟测试新增内置插件就位断言（重试至多 ~30s），`on.push.paths` 过滤器补 `plugins/**`。

## v0.1.1

### 修复

- **浏览器插件截图失效**：`zcode-browser-desktop` 的 `browser_screenshot` 工具因 `mcp-server/tools.mjs` 漏导入 `isCdpAlive`（该函数在 `cdp-client.mjs` 已导出），调用时必然抛出 `isCdpAlive is not defined`，CDP 网页截屏完全不可用。已补齐导入。
- **截图降级链路断死**：镜像未安装 X11 截屏工具 `scrot`，`browser_screenshot` 中「CDP 失败时降级到 scrot」的兜底分支因缺少二进制而直接失败。Dockerfile 增加 `scrot` 依赖，CDP 与 X11 两级截屏兜底均可用。
- **插件版本未递增，修复无法送达已部署环境**：上述代码修复落地后 `zcode-browser-desktop` 插件版本号仍停留在 `1.0.0`，而 ZCode CLI 的插件缓存按「插件名/版本」存放，目录市场重装时同版本会被视为「已是最新」而跳过覆盖，已安装环境将继续命中旧缓存、`browser_screenshot` 仍报 `isCdpAlive is not defined`。插件版本 `1.0.0` → `1.0.1`（`package.json`、`.zcode-plugin/plugin.json`、`marketplace.json` 与 MCP `SERVER_VERSION` 同步递增），配套 6dc918b 的代码修复方能送达存量部署。

### 新增

- **插件管理页「待重启生效」中间态提示**：插件启用位写入 CLI 配置是即时的，但 ZCode 运行时仅在启动（bootstrap）阶段解析一次插件组件，因此此前存在「配置已改、运行时仍按旧配置加载」却无任何界面提示的盲区。
  - 运行时每次启动成功时记录当时的插件启用位快照（`cli/plugin-runtime-snapshot.json`）；
  - 管理台 `GET /api/plugins` 返回当前配置与快照的比对结果；
  - 插件管理页对不一致的插件显示橙色「待重启生效」徽标，并标注差异（如「配置：已停用 · 运行时仍加载中」），同时在页面顶部给出汇总横幅引导重启；重启后徽标自动消失。
  - 覆盖「已停用未生效」与「已启用未加载」两个方向。

## v0.1.0

- 首个正式版本：内置官方 ZCode `3.14.3`，单端口聚合 Web 工作区 / 管理控制台 / noVNC 虚拟桌面三入口。
- 统一访问认证、初始化向导、Web Admin 控制台（版本 / 插件 / 桌面 / 快照 / 设置）。
- 虚拟桌面：Xvfb + x11vnc + websockify/noVNC + Chromium。
- 快照与备份：创建 / 列表 / 探测 / 下载 / 导入 / 还原。
- 运行时多版本在线热切换与原子置换、中断自愈。
- 自带 ZCode 原生插件 `zcode-browser-desktop`（MCP 六工具 + Skill，零第三方依赖）。
- 容器加固：`no-new-privileges` + `cap_drop: ALL` + 最小 `cap_add`。
