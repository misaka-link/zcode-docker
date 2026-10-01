# ZCode 容器浏览器与虚拟桌面原生插件 (`zcode-browser-desktop`)

面向 ZCode 的容器图形浏览器与虚拟桌面集成插件。通过 Chromium Chrome DevTools Protocol (CDP: 9222) 与网关内部管理接口，为 ZCode Coding Agent 提供完整的网页浏览、DOM 交互、元素输入、无损截屏与桌面状态控制能力。

---

## 特性亮点

- **ZCode 原生规范**：采用 ZCode 标准插件清单（`.zcode-plugin/plugin.json`）、技能（`skills/`）与 MCP 服务（`mcpServers`），完全脱离 DSH 的 Cordis 补丁机制（`cordis.patch.yml`）。
- **零外部依赖**：服务端全部采用 Node.js 原生模块与内置 API（Node 22/24 内置 `WebSocket`、`fetch`、`http`），无需在容器内 `npm install` 任何第三方包。
- **双引擎截屏**：优先使用 CDP 网页级高清截屏（支持 PNG 原图与 JPEG 画质调节），在 CDP 不可达时自动降级到 X11 原生 `scrot` 屏幕截取。
- **智能资源调度**：支持自动唤醒虚拟桌面、空闲自动休眠、心跳延长、以及标签页智能复用（优先复用空白页与已有页面，避免容器内存泄漏）。
- **完整交互工具集**：提供状态查询、打开网页、实时截屏、元素/坐标点击、表单输入、等待等 6 大核心 MCP 工具。

---

## 插件结构

```text
plugins/zcode-browser-desktop/
├── .zcode-plugin/
│   └── plugin.json           # ZCode 原生插件清单
├── .mcp.json                 # MCP 标准配置文件
├── package.json              # NPM 元数据
├── README.md                 # 插件说明文档
├── mcp-server/
│   ├── index.mjs             # MCP stdio JSON-RPC 服务入口（支持 --help）
│   ├── tools.mjs             # 6 大工具定义与执行派发
│   ├── cdp-client.mjs        # Chromium CDP(9222) 与 WebSocket 客户端封装
│   └── desktop-client.mjs    # 网关内部桌面管理接口客户端
└── skills/
    └── browser/
        └── SKILL.md          # 容器浏览器使用指南（提供给 Agent 上下文）
```

---

## 安装与配置方式

### 方式一：本地校验与开发使用（推荐）

1. **校验插件完整性与规范合规性**：
   ```bash
   zcode plugins validate plugins/zcode-browser-desktop
   # 或者使用仓库内置脚本：
   ./scripts/validate-browser-plugin.sh
   ```

2. **在项目或用户配置中挂载插件**：
   在工作区的 `.zcode/config.json` 或用户的 `~/.zcode/config.json` 中配置插件目录：
   ```json
   {
     "plugins": {
       "dirs": [
         "/workspace/zcode-docker/plugins/zcode-browser-desktop"
       ]
     }
   }
   ```

3. **直接作为独立 MCP 服务引入（兼容模式）**：
   在工作区的 `.mcp.json` 或客户端 MCP 设置中直接添加：
   ```json
   {
     "mcpServers": {
       "browser": {
         "command": "node",
         "args": [
           "/workspace/zcode-docker/plugins/zcode-browser-desktop/mcp-server/index.mjs"
         ]
       }
     }
   }
   ```

### 方式二：通过插件市场安装

当插件目录发布到本地或远程插件市场（Marketplace）后：

1. 添加市场源：
   ```bash
   zcode plugins marketplace add ./plugins
   ```
2. 安装并启用插件：
   ```bash
   zcode plugins install zcode-browser-desktop
   zcode plugins enable zcode-browser-desktop
   ```

---

## 暴露的 MCP 工具清单

| 工具名称 | 输入参数 | 功能说明 |
| :--- | :--- | :--- |
| `browser_status` | 无 | 获取容器虚拟桌面与 Chromium 状态（分辨率、CDP 端口、noVNC 访问路径、打开的标签页列表） |
| `browser_open` | `url` (必填), `newTab`, `tabId`, `resolution`, `durationMinutes` | 打开指定 URL。自动唤醒桌面；优先复用空白或已有标签页；支持自定义分辨率与活跃时长 |
| `browser_screenshot` | `path`, `quality` (high/medium/low), `tabId` | 实时截屏保存至指定文件。优先 CDP 网页高清截图，失败时自动降级到 X11 scrot 截屏 |
| `browser_click` | `selector`, `x`, `y`, `tabId`, `button`, `clickCount` | 在页面上点击元素（CSS 选择器自动滚动聚焦并点击）或屏幕坐标 |
| `browser_type` | `text` (必填), `selector`, `clear`, `pressEnter`, `tabId` | 向页面焦点或指定 CSS 选择器输入框输入文本，支持先清空与回车提交 |
| `browser_wait` | `ms`, `selector`, `timeoutMs`, `tabId` | 延时等待（默认 1000ms）或等待指定 CSS 选择器元素渲染就绪 |

---

## 命令行调试与自测

1. **查看 MCP 服务帮助与工具清单**：
   ```bash
   node plugins/zcode-browser-desktop/mcp-server/index.mjs --help
   ```

2. **测试 MCP stdio JSON-RPC 握手**：
   ```bash
   printf '%s\n%s\n' \
     '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}' \
     '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' | \
   node plugins/zcode-browser-desktop/mcp-server/index.mjs
   ```

3. **测试状态查询工具调用**：
   ```bash
   printf '%s\n%s\n' \
     '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}' \
     '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"browser_status","arguments":{}}}' | \
   node plugins/zcode-browser-desktop/mcp-server/index.mjs
   ```

---

## 与参考实现（DSH 版）的架构差异

1. **框架机制解耦**：
   - **DSH 版**：强依赖 Cordis 框架（`cordis.patch.yml`、`apply(ctx)`、`ctx.tools.register`、`@deepseek-ai/schemastery`），只能在 DSH 容器环境内运行。
   - **ZCode 原生版**：完全脱离 Cordis 补丁机制，基于业界通用与 ZCode 原生支持的 **MCP (Model Context Protocol)** 协议标准，通过标准 stdio JSON-RPC 暴露工具，任何兼容 MCP 的 Coding Agent / CLI 均可直接调用。
2. **能力承载形态**：
   - **DSH 版**：工具直接挂载在 DSH 运行时内核中，提示词通过 `ctx.systemPrompt` 动态拼接。
   - **ZCode 原生版**：工具通过 `mcpServers` 声明，提示词与使用最佳实践通过标准 `skills/browser/SKILL.md` 注入给 Agent。
3. **依赖与体积**：
   - **DSH 版**：依赖 `@deepseek-ai/schemastery` 等私有包。
   - **ZCode 原生版**：100% 零第三方依赖，纯 Node.js 内置模块实现。
