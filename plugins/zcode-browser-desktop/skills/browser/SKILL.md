---
name: browser
description: "操作容器内置的 Chromium 图形浏览器与虚拟桌面，支持打开网页、交互点击、输入表单、无损截屏、DOM 等待与桌面状态查询。"
---

# 容器浏览器与虚拟桌面使用指南 (Container Browser & Desktop)

当任务涉及网页打开、前端页面验证、Web UI 交互测试、表单填写、页面截屏或通过 noVNC 实时查看桌面时，使用本技能提供的容器浏览器 MCP 工具。

## 核心能力与工具清单

插件通过 MCP 服务提供以下标准工具：

1. **`browser_status`**
   - **用途**：查看虚拟桌面与 Chromium 浏览器的当前状态，包括桌面是否运行、分辨率、CDP 端口、noVNC 访问路径以及当前打开的所有页面标签列表。
   - **何时调用**：在开始一系列浏览器操作前了解现状，或需要获取已打开页面的 `tabId` 时调用。

2. **`browser_open(url, newTab?, tabId?, resolution?, durationMinutes?)`**
   - **用途**：在容器内的 Chromium 浏览器中打开指定目标 URL。
   - **智能行为**：
     - 若容器桌面未启动，会自动调用网关管理接口拉起虚拟桌面并等待 CDP(9222) 就绪；
     - 默认优先复用现有的空白标签页（如 `about:blank`）或活跃标签页进行导航，以节约容器资源；
     - 显式传入 `newTab: true` 时会在新标签页中打开；
     - 可自主指定分辨率（如 `"1920x1080"`, `"1440x900"`）及桌面活跃保持时长 `durationMinutes`（默认 30 分钟）。
   - **返回**：包含目标 URL、页面 `tabId`、是否复用 `reused` 以及 noVNC 访问地址。

3. **`browser_screenshot(path?, quality?, tabId?)`**
   - **用途**：对当前活跃页面或指定 `tabId` 的标签页执行实时截屏。
   - **画质选择**：
     - `high`（默认）：PNG 无损原图，适合精准视觉对比与排版检查；
     - `medium`：JPEG (80 质量)，平衡画质与体积；
     - `low`：JPEG (40 质量)，适合粗略布局确认。
   - **路径规则**：
     - 强烈建议传入具有业务含义的相对路径（如 `"screenshot.png"`, `"doc/preview.png"`），将基于当前工作区保存；
     - 若未传 `path`，会自动在工作区生成带唯一时间戳的文件（如 `screenshot-20261001120000.png`），绝不覆盖历史截图；
     - 双引擎兜底：优先使用 CDP 网页级高清截屏，CDP 不可用时自动降级到 X11 scrot 截屏。

4. **`browser_click(selector?, x?, y?, tabId?, button?, clickCount?)`**
   - **用途**：在页面上点击指定元素或屏幕坐标。
   - **使用方式**：
     - **CSS 选择器**：传入 `selector`（如 `"#submit-btn"`, `"button.login"`, `"a[href='/doc']"`）。工具会自动将元素滚动至视口中央、计算其中心坐标并触发真实的鼠标点击与 DOM 点击；
     - **屏幕坐标**：同时传入 `x` 和 `y` 数值进行绝对坐标点击；
     - 支持 `button`（`"left"`/`"middle"`/`"right"`）和 `clickCount`（1 为单击，2 为双击）。

5. **`browser_type(text, selector?, clear?, pressEnter?, tabId?)`**
   - **用途**：在目标输入框或当前焦点中输入文本。
   - **使用方式**：
     - 传入 `text`（必填）；
     - 可选 `selector`：先自动聚焦该元素；
     - 可选 `clear: true`：在输入新文本前先清空已有内容并触发 input/change 事件；
     - 可选 `pressEnter: true`：输入完成后自动按下 Enter 键（如提交搜索或表单）。

6. **`browser_wait(ms?, selector?, timeoutMs?, tabId?)`**
   - **用途**：延时等待或等待指定 DOM 元素出现。
   - **使用方式**：
     - 固定延时：传入 `ms`（如 `2000` 表示等待 2 秒）；
     - 等待元素：传入 `selector` 与可选的 `timeoutMs`（默认 10000 毫秒），工具将持续轮询直到元素渲染完成。

---

## 推荐操作流程与模式

### 场景 A：网页访问与视觉验证
1. 调用 `browser_open({ url: "https://example.com" })` 打开目标网页；
2. 调用 `browser_wait({ selector: "main, .content", timeoutMs: 5000 })` 或 `browser_wait({ ms: 2000 })` 确保异步内容加载完成；
3. 调用 `browser_screenshot({ path: "doc/preview.png", quality: "high" })` 截图；
4. 在最终回复中使用 Markdown 呈现图片：`![页面预览](<doc/preview.png>)`。

### 场景 B：表单输入与交互提交
1. 调用 `browser_open` 打开目标页面；
2. 调用 `browser_type({ selector: "#username", text: "admin", clear: true })` 填写用户名；
3. 调用 `browser_type({ selector: "#password", text: "secret123", clear: true })` 填写密码；
4. 调用 `browser_click({ selector: "button[type='submit']" })` 点击提交按钮；
5. 调用 `browser_wait({ ms: 2000 })` 等待跳转完成；
6. 调用 `browser_screenshot({ path: "login-success.png" })` 记录交互后的状态。

### 场景 C：桌面实时监视
- 任何时候均可调用 `browser_status` 获取当前 `vncUrl`；
- 用户可通过网关提供的 `/vnc/` 路径在宿主浏览器中直接看到容器内 Chromium 浏览器的实时交互画面。
