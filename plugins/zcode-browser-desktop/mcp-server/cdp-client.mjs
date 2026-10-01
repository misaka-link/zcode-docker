/**
 * cdp-client.mjs
 * Chromium Chrome DevTools Protocol (CDP) 客户端与 WebSocket 会话封装
 */
import { createRequire } from 'node:module';

const DEFAULT_CDP_PORT = 9222;
const COMMAND_TIMEOUT_MS = 15000;

export function getCdpPort() {
  return Number(process.env.ZCODE_CDP_PORT) || DEFAULT_CDP_PORT;
}

export function getCdpBaseUrl(port = getCdpPort()) {
  return `http://127.0.0.1:${port}`;
}

/**
 * 检查 CDP 调试端口是否可用
 */
export async function isCdpAlive(port = getCdpPort()) {
  try {
    const res = await fetch(`${getCdpBaseUrl(port)}/json/version`, {
      signal: AbortSignal.timeout(1500)
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * 等待 CDP 服务启动并就绪
 */
export async function waitForCdp(port = getCdpPort(), maxWaitMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    if (await isCdpAlive(port)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/**
 * 获取当前所有页面级别的标签页列表
 */
export async function listPages(port = getCdpPort()) {
  try {
    const res = await fetch(`${getCdpBaseUrl(port)}/json/list`, {
      signal: AbortSignal.timeout(3000)
    });
    if (!res.ok) return [];
    const all = await res.json();
    return Array.isArray(all) ? all.filter((item) => item.type === 'page') : [];
  } catch {
    return [];
  }
}

/**
 * 在 CDP 中新建标签页
 */
export async function newTab(url = 'about:blank', port = getCdpPort()) {
  const endpoint = `${getCdpBaseUrl(port)}/json/new?${encodeURIComponent(url)}`;
  const res = await fetch(endpoint, {
    method: 'PUT',
    signal: AbortSignal.timeout(5000)
  });
  if (!res.ok) {
    throw new Error(`创建标签页失败: HTTP ${res.status}`);
  }
  return await res.json();
}

/**
 * 激活指定标签页
 */
export async function activateTab(tabId, port = getCdpPort()) {
  try {
    await fetch(`${getCdpBaseUrl(port)}/json/activate/${encodeURIComponent(tabId)}`, {
      signal: AbortSignal.timeout(3000)
    });
  } catch {
    // 忽略激活失败
  }
}

/**
 * 关闭指定标签页
 */
export async function closeTab(tabId, port = getCdpPort()) {
  try {
    await fetch(`${getCdpBaseUrl(port)}/json/close/${encodeURIComponent(tabId)}`, {
      signal: AbortSignal.timeout(3000)
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * 获取 WebSocket 构造函数（优先 Node.js 内置 globalThis.WebSocket，降级引用 ws）
 */
function resolveWebSocketClass() {
  if (typeof globalThis.WebSocket === 'function') {
    return globalThis.WebSocket;
  }
  try {
    const req = createRequire(import.meta.url);
    return req('ws');
  } catch {
    try {
      const optReq = createRequire('/opt/zcode/');
      return optReq('ws');
    } catch {
      throw new Error('当前环境缺少可用 WebSocket 实现 (需要 Node.js 22+ 或 ws 库)');
    }
  }
}

/**
 * CDP 会话类，通过 WebSocket 与指定目标标签页交互
 */
export class CdpSession {
  constructor(webSocketDebuggerUrl) {
    this.wsUrl = webSocketDebuggerUrl;
    this.ws = null;
    this.seqId = 0;
    this.pending = new Map();
  }

  async connect(timeoutMs = 5000) {
    const WS = resolveWebSocketClass();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.close();
        reject(new Error(`连接 CDP WebSocket 超时 (${timeoutMs}ms)`));
      }, timeoutMs);

      try {
        this.ws = new WS(this.wsUrl);
      } catch (err) {
        clearTimeout(timer);
        return reject(err);
      }

      const onOpen = () => {
        clearTimeout(timer);
        this.ws.removeEventListener?.('open', onOpen);
        resolve(this);
      };

      const onError = (err) => {
        clearTimeout(timer);
        reject(err);
      };

      if (typeof this.ws.addEventListener === 'function') {
        this.ws.addEventListener('open', onOpen);
        this.ws.addEventListener('error', onError);
        this.ws.addEventListener('message', (event) => this._handleMessage(event.data));
      } else {
        this.ws.once('open', onOpen);
        this.ws.once('error', onError);
        this.ws.on('message', (data) => this._handleMessage(data.toString()));
      }
    });
  }

  _handleMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.id && this.pending.has(msg.id)) {
      const { resolve, reject, timer } = this.pending.get(msg.id);
      clearTimeout(timer);
      this.pending.delete(msg.id);
      if (msg.error) {
        reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      } else {
        resolve(msg.result);
      }
    }
  }

  async send(method, params = {}, timeoutMs = COMMAND_TIMEOUT_MS) {
    if (!this.ws) throw new Error('CDP 会话未连接');
    const id = ++this.seqId;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP 命令 ${method} 超时 (${timeoutMs}ms)`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });

      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  async navigate(url) {
    await this.send('Page.enable').catch(() => {});
    return await this.send('Page.navigate', { url });
  }

  async captureScreenshot({ format = 'png', quality = 95 } = {}) {
    await this.send('Page.enable').catch(() => {});
    const params = { format, captureBeyondViewport: false };
    if (format === 'jpeg') {
      params.quality = Math.max(10, Math.min(100, quality));
    }
    const res = await this.send('Page.captureScreenshot', params);
    if (!res || !res.data) throw new Error('CDP 截屏未返回图像数据');
    return Buffer.from(res.data, 'base64');
  }

  async evaluate(expression) {
    await this.send('Runtime.enable').catch(() => {});
    const res = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    });
    if (res?.exceptionDetails) {
      const desc = res.exceptionDetails.exception?.description || res.exceptionDetails.text;
      throw new Error(`页面执行表达式错误: ${desc}`);
    }
    return res?.result?.value;
  }

  async clickSelector(selector, { button = 'left', clickCount = 1 } = {}) {
    const expr = `
      (function(sel) {
        const el = document.querySelector(sel);
        if (!el) return { found: false };
        if (typeof el.scrollIntoViewIfNeeded === 'function') {
          el.scrollIntoViewIfNeeded();
        } else {
          el.scrollIntoView({ block: 'center', inline: 'center' });
        }
        const r = el.getBoundingClientRect();
        try { el.focus(); } catch {}
        try { el.click(); } catch {}
        return {
          found: true,
          x: Math.round(r.left + r.width / 2),
          y: Math.round(r.top + r.height / 2),
          width: r.width,
          height: r.height
        };
      })(${JSON.stringify(selector)})
    `;
    const res = await this.evaluate(expr);
    if (!res || !res.found) {
      throw new Error(`未找到匹配选择器的元素: ${selector}`);
    }

    const { x, y } = res;
    await this.clickCoordinates(x, y, { button, clickCount });
    return { success: true, clickedAt: { x, y }, selector };
  }

  async clickCoordinates(x, y, { button = 'left', clickCount = 1 } = {}) {
    await this.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: Math.round(x),
      y: Math.round(y),
      button,
      clickCount
    });
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: Math.round(x),
      y: Math.round(y),
      button,
      clickCount
    });
    return { success: true, clickedAt: { x, y } };
  }

  async typeText(text, { selector, clear = false, pressEnter = false } = {}) {
    if (selector) {
      const expr = `
        (function(sel, doClear) {
          const el = document.querySelector(sel);
          if (!el) return { found: false };
          if (typeof el.scrollIntoViewIfNeeded === 'function') {
            el.scrollIntoViewIfNeeded();
          } else {
            el.scrollIntoView({ block: 'center', inline: 'center' });
          }
          el.focus();
          if (doClear) {
            if ('value' in el) {
              el.value = '';
            } else if (el.isContentEditable) {
              el.innerText = '';
            }
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }
          return { found: true };
        })(${JSON.stringify(selector)}, ${Boolean(clear)})
      `;
      const res = await this.evaluate(expr);
      if (!res || !res.found) {
        throw new Error(`未找到输入框元素: ${selector}`);
      }
    }

    await this.send('Input.insertText', { text });

    if (pressEnter) {
      await this.send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13
      });
      await this.send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13
      });
    }

    return { success: true, textLength: text.length, selector };
  }

  async waitForSelector(selector, timeoutMs = 10000) {
    const expr = `Boolean(document.querySelector(${JSON.stringify(selector)}))`;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const found = await this.evaluate(expr);
        if (found) return true;
      } catch {
        // 忽略轮询错误
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`等待选择器超时 (${timeoutMs}ms): ${selector}`);
  }

  close() {
    for (const [id, req] of this.pending) {
      clearTimeout(req.timer);
      req.reject(new Error('CDP 会话已关闭'));
    }
    this.pending.clear();

    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // 忽略关闭异常
      }
      this.ws = null;
    }
  }
}
