/**
 * desktop-client.mjs
 * 容器桌面管理与网关内部接口客户端
 */
import fs from 'node:fs';

const DEFAULT_GATEWAY_PORT = 3080;
const REQUEST_TIMEOUT_MS = 15000;

const TOKEN_CANDIDATE_PATHS = [
  process.env.ZCODE_INTERNAL_TOKEN_FILE,
  '/root/.zcode/.internal-api-token',
  process.env.DSH_INTERNAL_TOKEN_FILE,
  '/root/.dsh/.internal-api-token'
].filter(Boolean);

let cachedToken = null;

export function getInternalToken() {
  if (cachedToken) return cachedToken;
  for (const tokenPath of TOKEN_CANDIDATE_PATHS) {
    try {
      if (fs.existsSync(tokenPath)) {
        const token = fs.readFileSync(tokenPath, 'utf8').trim();
        if (token) {
          cachedToken = token;
          return token;
        }
      }
    } catch {
      // 忽略无法读取的路径，继续尝试下一个候选路径
    }
  }
  return null;
}

export function getGatewayBaseUrl() {
  const port = process.env.PROXY_PORT || process.env.GATEWAY_PORT || DEFAULT_GATEWAY_PORT;
  return `http://127.0.0.1:${port}`;
}

/**
 * 调用网关桌面管理内部接口 (/__internal/desktop/:endpoint)
 */
export async function callDesktopInternal(endpoint, body = {}) {
  const baseUrl = getGatewayBaseUrl();
  const token = getInternalToken();
  const headers = { 'Content-Type': 'application/json' };
  if (token) {
    headers['x-zcode-internal-token'] = token;
    headers['x-dsh-internal-token'] = token;
  }

  try {
    const res = await fetch(`${baseUrl}/__internal/desktop/${endpoint}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });

    let data = null;
    try {
      data = await res.json();
    } catch {
      // 响应体可能非 JSON
    }

    if (!res.ok) {
      const errMsg = data?.error || `HTTP ${res.status}`;
      return { ok: false, error: errMsg, status: res.status };
    }

    return data ?? { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * 获取当前桌面运行状态
 */
export async function getDesktopStatus() {
  const internalRes = await callDesktopInternal('status');
  if (internalRes.ok !== false && (internalRes.running !== undefined || internalRes.enabled !== undefined)) {
    return internalRes;
  }

  // 降级使用公开接口 GET /__api/desktop/status
  try {
    const baseUrl = getGatewayBaseUrl();
    const res = await fetch(`${baseUrl}/__api/desktop/status`, {
      method: 'GET',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    if (res.ok) {
      return await res.json();
    }
  } catch {
    // 忽略降级错误
  }

  return internalRes;
}

/**
 * 唤醒或启动虚拟桌面
 */
export async function startDesktop(options = {}) {
  const internalRes = await callDesktopInternal('start', options);
  if (internalRes.ok !== false) {
    return internalRes;
  }

  // 降级使用公开接口 POST /__api/desktop/start
  try {
    const baseUrl = getGatewayBaseUrl();
    const res = await fetch(`${baseUrl}/__api/desktop/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(options),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    if (res.ok) {
      return await res.json();
    }
  } catch {
    // 忽略降级错误
  }

  return internalRes;
}

/**
 * 延长桌面活跃工作时长
 */
export async function keepaliveDesktop(durationMinutes = 30) {
  return await callDesktopInternal('keepalive', { durationMinutes });
}
