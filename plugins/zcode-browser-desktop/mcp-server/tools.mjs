/**
 * tools.mjs
 * MCP 浏览器工具声明与具体实现
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  getDesktopStatus,
  startDesktop,
  keepaliveDesktop
} from './desktop-client.mjs';
import {
  getCdpPort,
  isCdpAlive,
  waitForCdp,
  listPages,
  newTab,
  activateTab,
  CdpSession
} from './cdp-client.mjs';

function normalizeTargetUrl(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) throw new Error('URL 不能为空');
  const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s);
  const withScheme = hasScheme ? s : `https://${s}`;
  let parsed;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new Error(`URL 格式不合法: ${s.slice(0, 120)}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`仅支持 http/https 协议（已拒绝 ${parsed.protocol}）: ${s.slice(0, 120)}`);
  }
  if (!parsed.hostname) throw new Error(`URL 缺少主机名: ${s.slice(0, 120)}`);
  return parsed.toString();
}

async function resolveTargetPage(tabId) {
  const pages = await listPages();
  if (pages.length === 0) {
    throw new Error('未找到任何已打开的浏览器页面 (请先使用 browser_open 打开网页)');
  }
  if (tabId) {
    const matched = pages.find((p) => p.id === tabId);
    if (!matched) {
      throw new Error(`未找到指定 tabId 的页面: ${tabId}`);
    }
    return matched;
  }
  return pages[0];
}

export const TOOLS = [
  {
    name: 'browser_status',
    description: '获取容器桌面与 Chromium 浏览器的当前状态，包括桌面运行状态、分辨率、CDP端口、VNC路径以及打开的标签页列表。',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: 'browser_open',
    description: '在容器内置的 Chromium 图形浏览器中打开指定网页。默认优先智能复用当前空白或已有标签页以节约容器内存（可通过 newTab: true 显式新开标签页）。支持设置分辨率或工作时长。返回当前标签页信息。',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: '要打开的网页 URL（例如 https://github.com）'
        },
        newTab: {
          type: 'boolean',
          description: '可选：是否在新标签页中打开（默认 false，优先复用空白或已有标签页）'
        },
        tabId: {
          type: 'string',
          description: '可选：指定要复用或导航的已有标签页 ID'
        },
        resolution: {
          type: 'string',
          description: '可选：指定当前网页浏览的分辨率（如 "1920x1080", "1440x900", "1280x720"）'
        },
        durationMinutes: {
          type: 'number',
          description: '可选：指定允许浏览器工作并保持活跃的时长(分钟)，默认 30'
        }
      },
      required: ['url'],
      additionalProperties: false
    }
  },
  {
    name: 'browser_screenshot',
    description: '对容器内的 Chromium 浏览器或当前桌面进行实时截屏。支持自定义保存路径 savePath、画质（high/medium/low）及目标标签页 tabId。',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '可选：截图保存的文件路径（如 "screenshot.png", "doc/preview.png"）。留空则在当前工作区自动生成带时间戳的文件'
        },
        tabId: {
          type: 'string',
          description: '可选：指定要截屏的标签页 ID。未传时截取当前活跃的前台标签页或桌面'
        },
        quality: {
          type: 'string',
          enum: ['high', 'medium', 'low'],
          description: '可选：截图画质选择。可选 "high" (高画质/PNG无损原图，默认), "medium" (中画质/JPEG 80), "low" (低画质/JPEG 40)'
        }
      },
      additionalProperties: false
    }
  },
  {
    name: 'browser_click',
    description: '在页面上点击指定元素或屏幕坐标。支持传入 CSS 选择器或 (x, y) 坐标，支持指定鼠标按键与点击次数。',
    inputSchema: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: '可选：目标元素的 CSS 选择器（如 "#submit-btn", "button.login", "a[href=\"/about\"]"）'
        },
        x: {
          type: 'number',
          description: '可选：点击位置的 X 坐标（与 y 同时传入时生效）'
        },
        y: {
          type: 'number',
          description: '可选：点击位置的 Y 坐标（与 x 同时传入时生效）'
        },
        tabId: {
          type: 'string',
          description: '可选：目标标签页 ID，留空使用当前页面'
        },
        button: {
          type: 'string',
          enum: ['left', 'middle', 'right'],
          description: '可选：鼠标按键（默认 left）'
        },
        clickCount: {
          type: 'number',
          description: '可选：点击次数，1 为单击，2 为双击（默认 1）'
        }
      },
      additionalProperties: false
    }
  },
  {
    name: 'browser_type',
    description: '在页面当前焦点或指定输入框中输入文本。支持先聚焦指定选择器、先清空再输入以及输入后回车提交。',
    inputSchema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: '要输入的文本内容'
        },
        selector: {
          type: 'string',
          description: '可选：目标输入框的 CSS 选择器。若提供则先点击并聚焦该元素'
        },
        clear: {
          type: 'boolean',
          description: '可选：是否在输入前清空内容（默认 false）'
        },
        pressEnter: {
          type: 'boolean',
          description: '可选：输入完成后是否按下 Enter 键（默认 false）'
        },
        tabId: {
          type: 'string',
          description: '可选：目标标签页 ID，留空使用当前页面'
        }
      },
      required: ['text'],
      additionalProperties: false
    }
  },
  {
    name: 'browser_wait',
    description: '等待指定时间（毫秒）或等待指定 CSS 选择器的元素出现在页面 DOM 中。',
    inputSchema: {
      type: 'object',
      properties: {
        ms: {
          type: 'number',
          description: '可选：等待的毫秒数（默认 1000）'
        },
        selector: {
          type: 'string',
          description: '可选：等待直到该 CSS 选择器的元素在 DOM 中出现'
        },
        timeoutMs: {
          type: 'number',
          description: '可选：等待选择器超时的毫秒数（默认 10000）'
        },
        tabId: {
          type: 'string',
          description: '可选：目标标签页 ID，留空使用当前页面'
        }
      },
      additionalProperties: false
    }
  }
];

export async function executeTool(name, args = {}) {
  switch (name) {
    case 'browser_status':
      return await handleBrowserStatus();
    case 'browser_open':
      return await handleBrowserOpen(args);
    case 'browser_screenshot':
      return await handleBrowserScreenshot(args);
    case 'browser_click':
      return await handleBrowserClick(args);
    case 'browser_type':
      return await handleBrowserType(args);
    case 'browser_wait':
      return await handleBrowserWait(args);
    default:
      throw new Error(`未知的工具名称: ${name}`);
  }
}

async function handleBrowserStatus() {
  const desktop = await getDesktopStatus();
  const pages = await listPages();
  const cdpPort = getCdpPort();
  const vncUrl = desktop?.vncPath
    ? `${desktop.vncPath}?autoconnect=1&resize=scale&view_only=0&reconnect=1`
    : '/vnc/?autoconnect=1&resize=scale&view_only=0&reconnect=1';

  const statusData = {
    desktop: {
      running: desktop?.running ?? false,
      enabled: desktop?.enabled ?? true,
      mode: desktop?.mode || 'browser',
      width: desktop?.width || 1920,
      height: desktop?.height || 1080,
      cdpPort,
      vncPath: desktop?.vncPath || '/vnc/',
      vncUrl,
      uptimeSeconds: desktop?.uptimeSeconds ?? 0,
      remainingMinutes: desktop?.remainingMinutes ?? null
    },
    tabs: pages.map((p) => ({
      id: p.id,
      title: p.title,
      url: p.url
    }))
  };

  return JSON.stringify(statusData, null, 2);
}

async function handleBrowserOpen(args) {
  const targetUrl = normalizeTargetUrl(args.url);
  const durationMinutes = typeof args.durationMinutes === 'number' ? args.durationMinutes : 30;

  const startOpts = { durationMinutes };
  if (typeof args.resolution === 'string' && args.resolution.includes('x')) {
    const [w, h] = args.resolution.split('x').map((s) => parseInt(s, 10));
    if (w && h) {
      startOpts.width = w;
      startOpts.height = h;
    }
  }

  await startDesktop(startOpts);

  const cdpPort = getCdpPort();
  const cdpReady = await waitForCdp(cdpPort, 8000);
  if (!cdpReady) {
    throw new Error('CDP 调试端口未就绪，浏览器未能成功启动');
  }

  let tabId = null;
  let reused = false;
  const forceNewTab = args.newTab === true;

  if (!forceNewTab) {
    const pages = await listPages(cdpPort);
    let targetPage = null;
    if (args.tabId) {
      targetPage = pages.find((p) => p.id === args.tabId);
    }
    if (!targetPage && pages.length > 0) {
      targetPage = pages.find((p) => p.url === 'about:blank' || p.url.startsWith('chrome://newtab')) || pages[0];
    }

    if (targetPage && targetPage.webSocketDebuggerUrl) {
      const session = new CdpSession(targetPage.webSocketDebuggerUrl);
      try {
        await session.connect();
        await session.navigate(targetUrl);
        tabId = targetPage.id;
        reused = true;
        await activateTab(tabId, cdpPort);
      } catch (err) {
        console.error('[zcode-browser-desktop] 复用标签页失败，降级新建:', err.message);
      } finally {
        session.close();
      }
    }
  }

  if (!tabId) {
    const newPage = await newTab(targetUrl, cdpPort);
    tabId = newPage.id;
    reused = false;
    await activateTab(tabId, cdpPort);
  }

  if (durationMinutes > 0) {
    await keepaliveDesktop(durationMinutes);
  }

  const vncUrl = `/vnc/?autoconnect=1&resize=scale&view_only=0&reconnect=1`;
  const result = {
    status: reused ? 'navigated' : 'opened',
    url: targetUrl,
    tabId,
    reused,
    vncUrl
  };

  return `已在容器浏览器中打开 ${targetUrl} (标签页ID: ${tabId}, ${reused ? '复用已有标签页' : '新建标签页'})。\n可通过桌面 VNC 查看实时画面: ${vncUrl}\n\n详细信息:\n${JSON.stringify(result, null, 2)}`;
}

async function handleBrowserScreenshot(args) {
  const qualityLevel = (args.quality || 'high').toLowerCase();
  const isHigh = qualityLevel === 'high';
  const isLow = qualityLevel === 'low';
  const projectDir = process.cwd();

  let targetFile;
  if (typeof args.path === 'string' && args.path.trim()) {
    const rawPath = args.path.trim();
    targetFile = path.isAbsolute(rawPath) ? path.resolve(rawPath) : path.resolve(projectDir, rawPath);
    if (!path.extname(targetFile)) {
      targetFile += (isHigh ? '.png' : '.jpg');
    }
  } else {
    const ts = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
    targetFile = path.resolve(projectDir, `screenshot-${ts}.${isHigh ? 'png' : 'jpg'}`);
  }

  const ext = path.extname(targetFile).toLowerCase();
  const captureFormat = (ext === '.jpg' || ext === '.jpeg') ? 'jpeg' : 'png';
  const quality = isLow ? 40 : (isHigh ? 95 : 80);

  fs.mkdirSync(path.dirname(targetFile), { recursive: true });

  await startDesktop({});

  // 1. 尝试通过 CDP 网页截屏
  const cdpPort = getCdpPort();
  if (await isCdpAlive(cdpPort)) {
    try {
      const page = await resolveTargetPage(args.tabId);
      if (page.id) await activateTab(page.id, cdpPort);
      const session = new CdpSession(page.webSocketDebuggerUrl);
      try {
        await session.connect();
        const buf = await session.captureScreenshot({ format: captureFormat, quality });
        fs.writeFileSync(targetFile, buf);
        const stat = fs.statSync(targetFile);
        return `已完成页面截图 (CDP引擎)\n保存路径: ${targetFile}\n大小: ${stat.size} 字节\n画质: ${qualityLevel}\n页面URL: ${page.url}`;
      } finally {
        session.close();
      }
    } catch (err) {
      console.error('[zcode-browser-desktop] CDP 截屏失败，尝试降级到 X11 scrot:', err.message);
    }
  }

  // 2. 降级使用 X11 scrot 截屏
  const display = process.env.DISPLAY || ':99';
  const scrotArgs = captureFormat === 'png'
    ? ['-z', targetFile]
    : ['-q', String(quality), targetFile];

  const scrotRes = spawnSync('scrot', scrotArgs, {
    env: { ...process.env, DISPLAY: display }
  });

  if (scrotRes.status === 0 && fs.existsSync(targetFile)) {
    const stat = fs.statSync(targetFile);
    return `已完成桌面截图 (X11 scrot引擎)\n保存路径: ${targetFile}\n大小: ${stat.size} 字节\n画质: ${qualityLevel}`;
  }

  throw new Error(`截屏失败: CDP 与 scrot 均不可用 (${scrotRes.stderr?.toString() || '未知原因'})`);
}

async function handleBrowserClick(args) {
  const { selector, x, y, tabId, button = 'left', clickCount = 1 } = args;
  const hasSelector = typeof selector === 'string' && selector.trim().length > 0;
  const hasCoords = typeof x === 'number' && typeof y === 'number';

  if (!hasSelector && !hasCoords) {
    throw new Error('browser_click 必须提供 selector 或同时提供 x 与 y 坐标');
  }

  const page = await resolveTargetPage(tabId);
  const session = new CdpSession(page.webSocketDebuggerUrl);

  try {
    await session.connect();
    if (hasSelector) {
      const res = await session.clickSelector(selector.trim(), { button, clickCount });
      return `已点击元素 "${selector}" (坐标: ${res.clickedAt.x}, ${res.clickedAt.y})`;
    } else {
      await session.clickCoordinates(x, y, { button, clickCount });
      return `已在屏幕坐标 (${x}, ${y}) 执行点击`;
    }
  } finally {
    session.close();
  }
}

async function handleBrowserType(args) {
  const { text, selector, clear = false, pressEnter = false, tabId } = args;
  if (typeof text !== 'string') {
    throw new Error('text 参数必须是字符串');
  }

  const page = await resolveTargetPage(tabId);
  const session = new CdpSession(page.webSocketDebuggerUrl);

  try {
    await session.connect();
    const sel = typeof selector === 'string' && selector.trim().length > 0 ? selector.trim() : undefined;
    await session.typeText(text, { selector: sel, clear, pressEnter });
    const targetDesc = sel ? `输入框 "${sel}"` : '当前焦点';
    return `已向 ${targetDesc} 输入文本 (${text.length} 字符)${pressEnter ? '，并触发 Enter 提交' : ''}`;
  } finally {
    session.close();
  }
}

async function handleBrowserWait(args) {
  const { ms = 1000, selector, timeoutMs = 10000, tabId } = args;

  if (typeof selector === 'string' && selector.trim().length > 0) {
    const page = await resolveTargetPage(tabId);
    const session = new CdpSession(page.webSocketDebuggerUrl);
    try {
      await session.connect();
      await session.waitForSelector(selector.trim(), timeoutMs);
      return `元素 "${selector}" 已在页面中出现`;
    } finally {
      session.close();
    }
  }

  const sleepMs = Math.max(0, Number(ms) || 1000);
  await new Promise((r) => setTimeout(r, sleepMs));
  return `已等待 ${sleepMs} 毫秒`;
}
