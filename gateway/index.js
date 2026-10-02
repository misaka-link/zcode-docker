/**
 * zcode-docker 统一网关
 * ------------------------------------------------------------------
 * 单端口对外，承载四个入口：
 *   1) 统一认证：登录页 / 会话 Cookie / 首次访问初始化向导
 *   2) `/`          → 反代上游 ZCode Web（默认 http://127.0.0.1:${ZCODE_PORT}）
 *   3) `${ADMIN_PATH}` → 控制台静态页 + 管理 REST API（前缀 `/api/zcode/`）
 *   4) `${VNC_PATH}`   → noVNC 虚拟桌面（静态 + WebSocket 升级）
 *
 * 改造自「参考项目」的网关实现（静态页服务、登录/初始化/会话、频率限制、
 * 静态资源缓存头、noVNC 路由、内部接口、优雅退出、未捕获异常处理等成熟逻辑保留），
 * 按 doc/api-contract.md 的契约替换为 ZCode 语义。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const httpProxy = require('http-proxy');

const {
  isAuthEnabled,
  isSetupRequired,
  isWeakPassword,
  verifyToken,
  checkRequestAuth,
  setAuthCookie,
  clearAuthCookie,
  checkRateLimit,
  recordAuthAttempt,
  resolveClientIp,
  setTrustProxy,
  updateAuthToken,
  getAuthToken
} = require('./auth');

const desktopManager = require('./desktop-manager');
const zcodeManager = require('./zcode-manager');
const backupService = require('./backup-service');
const pluginManager = require('./plugin-manager');
const versionService = require('./version-service');
const { getInternalToken, verifyInternalToken } = require('./internal-token');
const wsOrigin = require('./ws-origin');

// ── 运行根目录与数据目录（契约 §2）────────────────────────────
// 网关自身只需要知道「数据卷在哪」：用于持久化配置文件与磁盘水位展示。
const ZCODE_HOME = process.env.ZCODE_HOME || '/root';
const ZCODE_DIR = process.env.ZCODE_DIR || path.join(ZCODE_HOME, '.zcode');
const ZCODE_SNAPSHOT_DIR = process.env.ZCODE_SNAPSHOT_DIR || path.join(ZCODE_HOME, '.zcode-snapshots');

// ── 配置文件持久化与动态读取 ──────────────────────────────────
const CONFIG_FILE = process.env.GATEWAY_CONFIG_FILE || path.join(ZCODE_DIR, 'gateway.config.json');

function loadPersistedConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      console.log('[gateway] 成功加载持久化网关配置文件:', CONFIG_FILE);
      return data;
    }
  } catch (err) {
    console.warn('[gateway] 读取持久化配置失败:', err.message);
  }
  return {};
}

function savePersistedConfig(cfg) {
  try {
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
    // 该文件包含 authToken 等敏感字段：写入即收紧为 0600（仅属主可读写）
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(CONFIG_FILE, 0o600); } catch {}
    return true;
  } catch (err) {
    console.error('[gateway] 保存持久化配置失败:', err.message);
    return false;
  }
}

/**
 * 回给控制台的错误文案：抹掉宿主绝对路径等内部细节，完整错误只写服务端日志。
 * 管理 API 本身在鉴权之后，这里防的是"错误串里带出宿主目录/内部路径"这类信息外溢。
 */
function safeErrMsg(err) {
  const raw = err && err.message ? String(err.message) : String(err ?? '未知错误');
  console.error('[gateway] API 错误:', raw);
  return raw.replace(/(?:\/[\w.@%+-]+){2,}/g, '<path>').slice(0, 300);
}

// 局部合并写入持久化配置的 desktop 段（供「彻底开关」等运行时开关使用，不影响其它字段）
function persistDesktopConfig(patch = {}) {
  try {
    const cfg = loadPersistedConfig();
    cfg.desktop = { ...(cfg.desktop || {}), ...patch };
    cfg.savedAt = new Date().toISOString();
    if (!savePersistedConfig(cfg)) return null;
    console.log('[gateway] 已持久化桌面配置:', JSON.stringify(patch));
    return cfg;
  } catch (err) {
    console.error('[gateway] 持久化桌面配置异常:', err.message);
    return null;
  }
}

// 桌面运行参数补丁的规范化（enabled 除外，总开关走专用接口）
// 字段与契约 §4.2 的 `/api/desktop/config` 请求体一一对应，另含 desktop.mode（browser|client）。
function normalizeDesktopConfigPatch(input = {}) {
  const patch = {};
  if (typeof input.mode === 'string' && ['browser', 'client'].includes(input.mode)) {
    patch.mode = input.mode;
  }
  const w = Number(input.width), h = Number(input.height);
  if (w > 0) patch.width = w;
  if (h > 0) patch.height = h;
  if (typeof input.idleTimeoutMinutes === 'number') patch.idleTimeoutMinutes = input.idleTimeoutMinutes;
  if (typeof input.enableCdp === 'boolean') patch.enableCdp = input.enableCdp;
  const cdp = Number(input.cdpPort);
  if (cdp > 0) patch.cdpPort = cdp;
  if (typeof input.screenshotQuality === 'string' && ['high', 'medium', 'low'].includes(input.screenshotQuality)) {
    patch.screenshotQuality = input.screenshotQuality;
  }
  if (typeof input.screenshotDir === 'string') patch.screenshotDir = input.screenshotDir.trim();
  return patch;
}

// 桌面运行参数的唯一写入路径：持久化 + 应用（控制台页与内部插件共用）
function applyDesktopConfigPatch(input = {}) {
  const patch = normalizeDesktopConfigPatch(input);
  if (!Object.keys(patch).length) return { ok: false, error: '没有可应用的配置项' };
  if (!persistDesktopConfig(patch)) return { ok: false, error: '桌面配置持久化失败，操作已取消' };
  const changed = desktopManager.applyConfig(patch);
  return { ok: true, changed, desktop: desktopManager.getStatus() };
}

// 桌面总开关的唯一写入路径：持久化 + 立即启停
async function applyDesktopMaster(enabled, opts = {}) {
  const next = enabled !== false;
  const startNow = opts.startNow !== false; // 启用时默认立即拉起桌面；镜像调用可传 false 只改状态
  if (!persistDesktopConfig({ enabled: next })) {
    return { ok: false, error: '桌面总开关持久化失败，操作已取消' };
  }
  desktopManager.setEnabled(next);
  let r = { ok: true, skipped: true };
  if (next && startNow) r = await desktopManager.start();
  else if (!next) r = await desktopManager.stop();
  return { ok: true, enabled: next, result: r, desktop: desktopManager.getStatus() };
}

// 桌面被「彻底停用」后访问 VNC 的提示页（避免只看到黑屏 / 连接失败而无解释）
function serveDesktopDisabledPage(res) {
  const adminPath = ADMIN_PATH || '/admin';
  const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>虚拟桌面已停用</title>
<style>
  body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#0f1115;color:#e5e7eb;font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
  .box{max-width:560px;padding:32px 36px;border:1px solid #2c2c2e;border-radius:14px;background:#1b1b1c;text-align:center}
  h1{font-size:18px;margin:0 0 12px}
  p{font-size:13px;line-height:1.8;color:#9ca3af;margin:0 0 20px}
  a{display:inline-block;padding:9px 18px;border-radius:8px;background:#4176e6;color:#fff;text-decoration:none;font-size:13px}
</style></head>
<body><div class="box">
  <h1>🖥️ 虚拟桌面当前不可用</h1>
  <p>原因：桌面已在控制台被「彻底停用」。<br>当前容器不会启动 Xvfb / Chromium 桌面，因此 VNC 无法连接。<br>如需继续使用，请在控制台「桌面」页点击「启用桌面」。</p>
  <a href="${adminPath}/">前往控制台启用</a>
</div></body></html>`;
  res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store, no-cache' });
  res.end(html);
}

// 是否为「浏览器直接导航」（HTML 页面请求）。用于在桌面尚未就绪时返回可自动刷新的页面，
// 而不是把 HTML 塞进资源请求、或让用户看到裸 JSON / 502。
function isHtmlNavigation(req) {
  return !!req && req.method === 'GET' && String(req.headers.accept || '').includes('text/html');
}

// 桌面/浏览器「启动中」独立页面：默认 3 秒后自动刷新，桌面就绪后无感进入 noVNC。
// 页面文件：gateway/public/desktop-starting.html（零外部依赖，可单独打开预览）。
// 占位符使用宽松的 `/__<TAG>_ADMIN_PATH__/` 形式匹配，兼容 `__ZCODE_*__` 与历史命名。
const ADMIN_PATH_PLACEHOLDER_RE = /__[A-Z0-9_]+_ADMIN_PATH__/g;
const RETRY_SECONDS_PLACEHOLDER_RE = /__[A-Z0-9_]+_RETRY_SECONDS__/g;

function serveDesktopStartingPage(res, { retrySeconds = 3 } = {}) {
  const seconds = Number(retrySeconds) > 0 ? Number(retrySeconds) : 3;
  let html;
  try {
    html = fs.readFileSync(path.join(__dirname, 'public', 'desktop-starting.html'), 'utf8')
      .replace(ADMIN_PATH_PLACEHOLDER_RE, ADMIN_PATH)
      .replace(RETRY_SECONDS_PLACEHOLDER_RE, String(seconds));
  } catch (err) {
    // 兜底：页面文件缺失也绝不回退到裸 JSON / 502
    html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta http-equiv="refresh" content="${seconds}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>虚拟桌面正在启动</title></head>
<body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#f8fafc;color:#0f172a;font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif">
<div style="text-align:center;font-size:14px">🖥️ 虚拟桌面正在启动，${seconds} 秒后自动刷新…</div>
</body></html>`;
  }
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    Pragma: 'no-cache',
    Expires: '0'
  });
  res.end(html);
}

const persisted = loadPersistedConfig();

// 是否信任反向代理（决定限流 IP 取 XFF 还是 socket 对端）：配置显式值优先于环境变量
if (persisted.trustProxy !== undefined) {
  setTrustProxy(persisted.trustProxy === true || persisted.trustProxy === '1' || persisted.trustProxy === 'true');
}

// 应用持久化认证码与桌面设置
// 显式环境变量 AUTH_TOKEN 优先于持久化口令 —— 否则在 .env 里轮换口令不生效
// （容器里会继续用数据卷中的旧口令，运维会以为已经换掉了）。
const AUTH_TOKEN_SOURCE = (process.env.AUTH_TOKEN || process.env.ACCESS_CODE || '').trim()
  ? 'env'
  : (persisted.authToken !== undefined ? 'persisted' : 'default');
if (AUTH_TOKEN_SOURCE !== 'env' && persisted.authToken !== undefined) {
  updateAuthToken(persisted.authToken);
}
if (AUTH_TOKEN_SOURCE === 'env') {
  console.log('[gateway] 认证口令来源: 环境变量 AUTH_TOKEN（优先于持久化配置）');
}
// 环境变量与持久化配置不一致时给出显式告警，避免"面板改了没生效"的静默困惑
function warnConfigConflict(label, envValue, persistedValue) {
  if (envValue === undefined || envValue === '' || persistedValue === undefined) return;
  if (String(envValue) !== String(persistedValue)) {
    console.warn(`[gateway] 配置冲突: ${label} 环境变量(${envValue}) 与持久化配置(${persistedValue}) 不一致，以环境变量为准`);
  }
}
warnConfigConflict('PROXY_PORT', process.env.PROXY_PORT, persisted.proxyPort);
warnConfigConflict('ADMIN_PATH', process.env.ADMIN_PATH, persisted.adminPath);
warnConfigConflict('VNC_PATH', process.env.VNC_PATH, persisted.vncPath);
if (persisted.desktop) {
  desktopManager.updateConfig(persisted.desktop);
}
// 启动崩溃自愈与故障插件自动隔离（默认开启，单次启动周期上限默认 5 个，允许用户自定义）
const autoHealEnabled = persisted.autoHealPlugins !== false;
const autoHealMaxPerBoot = Math.max(1, Math.min(50, Number(persisted.autoHealMaxPerBoot) || 5));
applyAutoHealConfig(autoHealEnabled, autoHealMaxPerBoot);

// ── 端口与动态路径配置 ───────────────────────────────────────
// 显式环境变量优先于持久化配置（否则 .env 里的 PROXY_PORT 成了"死配置"，
// 面板改过端口后 compose 的 3080:3080 会静默失配）。
const PROXY_PORT_SOURCE = process.env.PROXY_PORT ? 'env' : (persisted.proxyPort ? 'persisted' : 'default');
const PROXY_PORT = Number(process.env.PROXY_PORT || persisted.proxyPort) || 3080;
process.env.PROXY_PORT = String(PROXY_PORT);
// 上游 ZCode Web 端口（仅回环）：契约 §2 默认 3030
const ZCODE_PORT_SOURCE = process.env.ZCODE_PORT ? 'env' : 'default';
const ZCODE_PORT = Number(process.env.ZCODE_PORT) || 3030;
const VNC_PORT = Number(process.env.VNC_PORT) || 6080;

function normalizeRoutePath(raw, defaultPath) {
  let p = (raw || defaultPath).trim();
  if (!p.startsWith('/')) p = '/' + p;
  p = p.replace(/\/+$/, '');
  return p.length === 0 ? defaultPath : p;
}

const ADMIN_PATH_SOURCE = process.env.ADMIN_PATH ? 'env' : (persisted.adminPath ? 'persisted' : 'default');
const VNC_PATH_SOURCE = process.env.VNC_PATH ? 'env' : (persisted.vncPath ? 'persisted' : 'default');
const ADMIN_PATH = normalizeRoutePath(process.env.ADMIN_PATH || persisted.adminPath, '/admin');
const VNC_PATH = normalizeRoutePath(process.env.VNC_PATH || persisted.vncPath, '/vnc');
// 供「页面/iframe 基地址」使用的带尾斜杠形式：消费者直接拼相对路径也不会把基准解析错。
// 注意：JSON 接口（契约 §3 / §4.1）返回的 paths.vnc 保持无尾斜杠的 VNC_PATH。
const VNC_PATH_HREF = VNC_PATH + '/';

const ZCODE_TARGET = 'http://127.0.0.1:' + ZCODE_PORT;
const VNC_TARGET = 'http://127.0.0.1:' + VNC_PORT;

// 上游令牌注入开关（契约 §4.3）：默认关闭（上游以 --no-token 启动，网关不做注入）。
const ZCODE_INTERNAL_TOKEN_ENABLED = process.env.ZCODE_INTERNAL_TOKEN === '1'
  || process.env.ZCODE_INTERNAL_TOKEN === 'true';
// 上游鉴权 Cookie 名（packages/server/src/http.ts）
const UPSTREAM_TOKEN_COOKIE = 'zcode_lite_token';

// 对外主机名白名单（WebSocket 同源校验用）：配置 / 环境变量里的显式值，逗号分隔。
const PUBLIC_HOSTS = String(persisted.publicHost || process.env.PUBLIC_HOST || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const PUBLIC_PATHS = new Set([
  '/login',
  '/favicon.ico',
  '/favicon.svg',
  '/manifest.webmanifest'
]);

// ── 反向代理实例与容错处理 ─────────────────────────────────
const zcodeProxy = httpProxy.createProxyServer({
  target: ZCODE_TARGET,
  ws: true,
  changeOrigin: true
});

const vncProxy = httpProxy.createProxyServer({
  target: VNC_TARGET,
  ws: true,
  changeOrigin: true
});

// 上游核心状态（契约 §5.1 getStatus）：网关只读该权威快照，不触碰内部字段
function getRawCoreStatus() {
  try {
    return zcodeManager.getStatus() || {};
  } catch (err) {
    console.warn('[gateway] 读取上游状态失败:', (err && err.message) || err);
    return {};
  }
}

function getCoreStatus() {
  const raw = getRawCoreStatus();
  const lastExit = raw.lastExit !== undefined ? raw.lastExit : (raw.lastExitInfo || null);
  return {
    version: raw.version || null,
    running: !!raw.running,
    ready: !!raw.ready,
    port: Number(raw.port) || ZCODE_PORT,
    pid: raw.pid !== undefined ? raw.pid : null,
    manualStopped: !!raw.manualStopped,
    lastExit,
    mode: raw.mode
  };
}

// 磁盘水位（契约 §4.1 disk.freeMB）：优先取快照卷所在文件系统
function getDiskFreeMB() {
  for (const target of [ZCODE_SNAPSHOT_DIR, ZCODE_DIR, '/']) {
    if (!target) continue;
    try {
      const st = fs.statfsSync(target);
      const free = Number(st.bsize) * Number(st.bavail);
      if (Number.isFinite(free)) return Math.round(free / (1024 * 1024));
    } catch {}
  }
  return null;
}

// 自愈策略的唯一写入路径（契约 §5.1：setAutoHeal(enabled) + maxAutoHealPerBoot 属性）
function applyAutoHealConfig(enabled, maxPerBoot) {
  const max = Math.max(1, Math.min(50, Number(maxPerBoot) || 5));
  try { zcodeManager.setAutoHeal(enabled !== false); } catch (err) {
    console.warn('[gateway] 设置自愈开关失败:', (err && err.message) || err);
  }
  try { zcodeManager.maxAutoHealPerBoot = max; } catch {}
  return { enabled: enabled !== false, maxPerBoot: max };
}

function getAutoIsolatedEvents() {
  try {
    const list = zcodeManager.getAutoIsolatedEvents();
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

zcodeProxy.on('error', (err, req, res) => {
  console.warn('[zcode-proxy] 上游连接等待中 (ZCode 启动/停止阶段):', err.message);
  if (res && typeof res.writeHead === 'function' && !res.headersSent) {
    const core = getCoreStatus();
    let errorMsg = 'ZCode Web 正在启动就绪中，请稍候数秒后刷新';
    if (core.manualStopped) {
      errorMsg = 'ZCode 服务当前处于手动停止状态。如需使用，请前往控制台手动点击【启动 ZCode】。';
    } else if (core.lastExit && !core.running) {
      errorMsg = `ZCode 启动异常退出 (代码: ${core.lastExit.code || -1})。请前往控制台查看详细日志排查。`;
    }

    const isHtml = (req && req.headers && req.headers.accept || '').includes('text/html');
    if (isHtml) {
      res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta http-equiv="refresh" content="5" />
  <title>ZCode Web - 启动就绪中</title>
  <style>
    body { font-family: -apple-system, sans-serif; background: #f8fafc; color: #0f172a; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .box { background: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 32px; max-width: 480px; box-shadow: 0 10px 25px -5px rgba(0,0,0,0.08); text-align: center; }
    h2 { font-size: 18px; margin-bottom: 12px; color: #1677ff; }
    p { font-size: 13px; color: #64748b; line-height: 1.6; margin-bottom: 20px; }
    .btn { display: inline-block; padding: 8px 16px; border-radius: 8px; background: #0f172a; color: #ffffff; text-decoration: none; font-size: 13px; font-weight: 600; }
  </style>
</head>
<body>
  <div class="box">
    <h2>⚡ ZCode Web 启动就绪中</h2>
    <p>${errorMsg}<br/>页面将在 5 秒后自动刷新检测...</p>
    <a href="${ADMIN_PATH}/" class="btn">前往控制台查看实时日志 ↗</a>
  </div>
</body>
</html>`);
    } else {
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: errorMsg, lastExit: core.lastExit }));
    }
  }
});

vncProxy.on('error', (err, req, res) => {
  console.warn('[vnc-proxy] 上游连接等待中 (VNC 启动阶段):', err.message);
  if (res && typeof res.writeHead === 'function' && !res.headersSent) {
    // 浏览器直接导航（noVNC 页面本身）时返回独立的「启动中」页（3s 自动刷新），
    // 避免用户看到原始 JSON 502 而误以为"桌面连不上"。
    if (isHtmlNavigation(req)) {
      return serveDesktopStartingPage(res);
    }
    res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: 'VNC 图形桌面正在就绪中，请稍候数秒后刷新' }));
  }
});

vncProxy.on('proxyRes', (proxyRes, req, res) => {
  const ct = String(proxyRes.headers['content-type'] || '').toLowerCase();
  // 针对 noVNC 的 html 页面严禁客户端持久强缓存，保证镜像或版本更新后即刻拉取最新版本化入口
  if (ct.includes('text/html')) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
});

// ── 上游令牌注入（契约 §4.3）────────────────────────────────
// 令牌来自 zcodeManager.getUpstreamToken()（可选接口：尚未提供时静默降级，不影响启动）。
function getUpstreamToken() {
  try {
    if (typeof zcodeManager.getUpstreamToken === 'function') {
      return String(zcodeManager.getUpstreamToken() || '');
    }
  } catch (err) {
    console.warn('[gateway] 获取上游内部令牌失败:', (err && err.message) || err);
  }
  return '';
}

// 为 HTML 导航请求补上 ?token=（URL 中已有 token 则不覆盖）
function injectUpstreamToken(req) {
  if (!ZCODE_INTERNAL_TOKEN_ENABLED) return;
  if (!isHtmlNavigation(req)) return;
  const token = getUpstreamToken();
  if (!token) return;

  const raw = req.url || '/';
  const qIndex = raw.indexOf('?');
  const pathname = qIndex === -1 ? raw : raw.slice(0, qIndex);
  const params = new URLSearchParams(qIndex === -1 ? '' : raw.slice(qIndex + 1));
  if (params.get('token')) return;
  params.set('token', token);
  req.url = pathname + '?' + params.toString();
}

zcodeProxy.on('proxyRes', (proxyRes, req, res) => {
  const ct = String(proxyRes.headers['content-type'] || '').toLowerCase();

  // 契约 §4.3：启用内部令牌时，为 HTML 导航响应补发上游鉴权 Cookie
  if (ZCODE_INTERNAL_TOKEN_ENABLED && isHtmlNavigation(req)) {
    const token = getUpstreamToken();
    if (token) {
      const cookie = `${UPSTREAM_TOKEN_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax`;
      const prev = proxyRes.headers['set-cookie'];
      const list = Array.isArray(prev) ? prev.slice() : (prev ? [prev] : []);
      if (!list.some(c => String(c).startsWith(UPSTREAM_TOKEN_COOKIE + '='))) list.push(cookie);
      proxyRes.headers['set-cookie'] = list;
    }
  }

  if (ct.includes('text/html')) {
    delete proxyRes.headers['content-length'];
    res.removeHeader('content-length');

    // 严禁浏览器缓存 HTML 主入口，确保每次加载均获取最新组合包版本 (彻底消除 rev 过期 404)
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
});

async function alignHeadersForUpstream(req) {
  req.headers['host'] = '127.0.0.1:' + ZCODE_PORT;
  if (req.headers['origin']) req.headers['origin'] = ZCODE_TARGET;
  if (req.headers['sec-fetch-site'] === 'cross-site') req.headers['sec-fetch-site'] = 'same-origin';

  const pathname = (req.url || '').split('?')[0];
  if (pathname.endsWith('.js') || pathname.endsWith('.html') || pathname === '/' || pathname.startsWith('/plugins/')) {
    req.headers['accept-encoding'] = 'identity';
  }

  // 上游令牌注入（默认关闭；仅 HTML 导航）
  injectUpstreamToken(req);
}

function serveStaticHtml(res, filename) {
  const filePath = path.join(__dirname, 'public', filename);
  try {
    const html = fs.readFileSync(filePath, 'utf8');
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store'
    });
    res.end(html);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('无法加载页面: ' + filename);
  }
}

// 控制台页面：注入契约 §3 约定的占位符（沿用参考实现的字符串替换写法）
function serveAdminHtml(res) {
  const filePath = path.join(__dirname, 'public', 'admin.html');
  let html;
  try {
    html = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('无法加载页面: admin.html');
  }
  const coreVersion = getCoreStatus().version || '';
  const projectVersion = versionService.getLocalProjectVersion() || '';
  html = html
    .replace(/__ZCODE_ADMIN_PATH__/g, ADMIN_PATH)
    .replace(/__ZCODE_VNC_PATH__/g, VNC_PATH_HREF)
    .replace(/__ZCODE_PROXY_PORT__/g, String(PROXY_PORT))
    .replace(/__ZCODE_PROJECT_VERSION__/g, String(projectVersion))
    .replace(/__ZCODE_CORE_VERSION__/g, String(coreVersion));
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(html);
}

function getClientIp(req) {
  // 限流用 IP 的解析策略见 auth.resolveClientIp：默认只用 socket 对端地址，
  // 仅当显式信任代理（TRUST_PROXY / gateway.config.json trustProxy）时才采用 XFF。
  return resolveClientIp(req);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1024 * 512) {
        req.destroy(new Error('Payload too large'));
        reject(new Error('请求体过大 (超过 512KB)'));
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(new Error('JSON 格式错误'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(data));
}

// ── SSE 长任务（安装 / 回滚还原 / 快照还原 / 插件安装）──────────
// 事件流格式沿用参考实现：`data: {json}\n\n`，事件体形如
//   { type: 'log'|'progress'|'done'|'error', ... }
// 默认超时放宽到 ≥600s（见 server.requestTimeout）。
const SSE_TIMEOUT_MS = 900000;

function sseHead() {
  return {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    // 禁止反向代理缓冲，保证进度/日志实时逐条下发（Nginx 等）
    'X-Accel-Buffering': 'no'
  };
}

function openSseStream(res) {
  res.writeHead(200, sseHead());
  return (data) => {
    try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch {}
  };
}

/**
 * 长任务 SSE 包装：转发上游事件，并保证「终态事件」只发一次。
 * 安装 / 回滚还原的事件回调自身会以 `type: done|error` 收尾；快照还原与插件安装
 * 没有事件回调，由本包装补发终态事件。
 */
function openTaskSse(res) {
  const write = openSseStream(res);
  let terminalSent = false;
  return {
    send(evt) {
      if (evt && typeof evt === 'object' && (evt.type === 'done' || evt.type === 'error')) terminalSent = true;
      write(evt);
    },
    finish(result, err) {
      if (!terminalSent) {
        if (err) write({ type: 'error', message: safeErrMsg(err) });
        else write({ type: 'done', ...(result && typeof result === 'object' ? result : { ok: result !== false }) });
      }
      try { res.end(); } catch {}
    }
  };
}

// 版本类长任务（安装 / 回滚还原）的网关级互斥：避免并发切换造成运行时目录错乱
let versionTaskBusy = false;

// ── 控制台 API 处理器（前缀 `${ADMIN_PATH}/api/`）──────────────
async function handleAdminApi(req, res, pathname, query) {
  const subPath = pathname.slice(ADMIN_PATH.length);

  try {
    // 1. 全局状态（契约 §4.1）
    if (subPath === '/api/status' && req.method === 'GET') {
      const raw = getRawCoreStatus();
      const core = getCoreStatus();
      const freeMB = getDiskFreeMB();
      return sendJson(res, 200, {
        ok: true,
        project: {
          version: versionService.getLocalProjectVersion()
        },
        core,
        desktop: desktopManager.getStatus(),
        auth: {
          enabled: isAuthEnabled(),
          source: AUTH_TOKEN_SOURCE
        },
        paths: {
          admin: ADMIN_PATH,
          vnc: VNC_PATH,
          proxyPort: PROXY_PORT
        },
        disk: {
          freeMB: freeMB !== null ? freeMB : (Number(raw.diskFreeMb) || null)
        },
        // 自愈相关附加字段：控制台需要读取自动隔离事件（清理接口见 /api/zcode/auto-heal/clear）
        autoHealEnabled: zcodeManager.autoHealEnabled !== false,
        autoHealMaxPerBoot: zcodeManager.maxAutoHealPerBoot,
        autoIsolatedEvents: getAutoIsolatedEvents()
      });
    }

    // 1.1 套件/上游版本检查（契约 §5.5：versionService.check({force})）
    if (subPath === '/api/version/check' && req.method === 'GET') {
      const force = query.get('refresh') === '1';
      const checkRes = await versionService.check({ force });
      checkRes.isRemoteMeta = versionService.isUsingRemoteMeta();
      return sendJson(res, 200, checkRes);
    }

    // 2. ZCode 运行时版本列表（可安装 + 本地已缓存）
    if (subPath === '/api/zcode/versions' && req.method === 'GET') {
      const force = query.get('refresh') === '1';
      const raw = await zcodeManager.fetchAvailableVersions(force);
      const payload = (raw && !Array.isArray(raw) && typeof raw === 'object') ? { ...raw } : {};
      // 兼容不同返回形态：数组 / {versions} / {remote, cached}
      const versions = Array.isArray(raw)
        ? raw
        : (Array.isArray(payload.versions) ? payload.versions
          : (Array.isArray(payload.remote) ? payload.remote : []));
      payload.ok = true;
      payload.versions = versions;
      payload.cached = Array.isArray(payload.cached) ? payload.cached : [];
      // 控制台兼容字段：本地已缓存版本号列表（兼容对象/字符串两种形态）
      payload.cachedVersions = payload.cached.map((v) => (typeof v === 'string' ? v : (v && v.version) || '')).filter(Boolean);
      payload.versionEvaluations = {};
      for (const item of versions) {
        const ver = typeof item === 'string' ? item : (item && item.version);
        if (!ver) continue;
        try {
          payload.versionEvaluations[ver] = versionService.evaluateTargetVersion(ver);
        } catch {}
      }
      payload.isRemoteMeta = versionService.isUsingRemoteMeta();
      return sendJson(res, 200, payload);
    }

    // 2.0 版本库磁盘占用 / LRU 清理 / 删除本地缓存版本（契约 §4.1）
    if (subPath === '/api/zcode/versions/stats' && req.method === 'GET') {
      const r = await zcodeManager.getVersionsStoreStats();
      return sendJson(res, 200, { ok: true, ...(r && typeof r === 'object' ? r : {}) });
    }

    if (subPath === '/api/zcode/versions/gc' && req.method === 'POST') {
      const body = await readJsonBody(req).catch(() => ({}));
      const keepRaw = Number(body && (body.keep !== undefined ? body.keep : body.keepN));
      const keep = Number.isFinite(keepRaw) && keepRaw > 0 ? Math.floor(keepRaw) : null;
      // 契约 §4.1：LRU 清理（保留 keep 个）；keep 缺省时由管理器决定默认保留数
      const r = await zcodeManager.gcVersions(keep === null ? {} : { keep });
      return sendJson(res, 200, { ok: true, ...(r && typeof r === 'object' ? r : {}) });
    }

    if (subPath.startsWith('/api/zcode/versions/') && req.method === 'DELETE') {
      const ver = decodeURIComponent(subPath.slice('/api/zcode/versions/'.length));
      if (!ver || ver.includes('/')) return sendJson(res, 400, { ok: false, error: '版本号不合法' });
      if (!zcodeManager.isValidVersion(ver)) {
        return sendJson(res, 400, { ok: false, error: '版本号格式不合法' });
      }
      let removed;
      try {
        removed = await zcodeManager.deleteCachedVersion(ver);
      } catch (err) {
        return sendJson(res, 409, { ok: false, error: safeErrMsg(err) });
      }
      if (removed === false || (removed && typeof removed === 'object' && removed.ok === false)) {
        return sendJson(res, 404, { ok: false, error: (removed && removed.error) || '本地未缓存该版本' });
      }
      return sendJson(res, 200, { ok: true, ...(removed && typeof removed === 'object' ? removed : {}), version: ver });
    }

    // 2.05 回滚点（单槽位）查询 / 丢弃 / 就地还原
    if (subPath === '/api/zcode/rollback' && req.method === 'GET') {
      const rb = zcodeManager.getRollbackPoint();
      return sendJson(res, 200, { ok: true, exists: !!rb, rollback: rb || null });
    }

    if (subPath === '/api/zcode/rollback' && req.method === 'DELETE') {
      if (versionTaskBusy) {
        return sendJson(res, 409, { ok: false, error: '版本切换或还原进行中，禁止删除回滚点' });
      }
      const current = zcodeManager.getRollbackPoint();
      if (!current) {
        return sendJson(res, 404, { ok: false, error: '回滚点不存在或已被清理' });
      }
      const r = await zcodeManager.deleteRollbackPoint();
      if (r === false) return sendJson(res, 500, { ok: false, error: '回滚点删除失败' });
      if (r && typeof r === 'object' && r.ok === false) {
        const msg = String(r.error || '');
        if (msg.includes('进行中')) return sendJson(res, 409, r);
        if (msg.includes('不存在')) return sendJson(res, 404, r);
        return sendJson(res, 500, r);
      }
      return sendJson(res, 200, { ok: true, ...(r && typeof r === 'object' ? r : {}) });
    }

    if (subPath === '/api/zcode/rollback/restore' && req.method === 'POST') {
      if (versionTaskBusy) {
        return sendJson(res, 409, { ok: false, error: '已有版本切换或还原任务正在进行中' });
      }
      const current = zcodeManager.getRollbackPoint();
      if (!current) {
        return sendJson(res, 404, { ok: false, error: '回滚点备件不存在，无法还原' });
      }

      const sse = openTaskSse(res);
      sse.send({ type: 'log', message: `[就地还原] 开始还原回滚点备件 (v${current.version || 'unknown'})...` });

      versionTaskBusy = true;
      let result = null;
      let failure = null;
      try {
        result = await zcodeManager.restoreRollbackPoint((evt) => sse.send(evt));
      } catch (err) {
        failure = err;
      } finally {
        versionTaskBusy = false;
      }
      sse.finish(result, failure);
      return;
    }

    // 2.1 ZCode 实时日志与崩溃信息
    if (subPath === '/api/zcode/logs' && req.method === 'GET') {
      const count = Math.min(Number(query.get('lines')) || 200, 300);
      const core = getCoreStatus();
      const lastExit = core.lastExit || (zcodeManager.getStatus && zcodeManager.getStatus().lastExit) || null;
      let exitInfo = null;
      if (lastExit && typeof lastExit === 'object') {
        let timeStr = null;
        if (lastExit.at) {
          try {
            const d = new Date(lastExit.at);
            if (!isNaN(d.getTime())) timeStr = d.toISOString();
          } catch {}
        } else if (lastExit.time) {
          try {
            const d = new Date(lastExit.time);
            if (!isNaN(d.getTime())) timeStr = d.toISOString();
          } catch {}
        }
        exitInfo = {
          code: lastExit.code !== undefined ? lastExit.code : null,
          sig: lastExit.signal !== undefined ? lastExit.signal : (lastExit.sig !== undefined ? lastExit.sig : null),
          time: timeStr
        };
      }

      const rawLogs = zcodeManager.getRecentLogs(count);
      let recentLogs = [];
      if (typeof rawLogs === 'string') {
        const lines = rawLogs.split('\n').map(line => line.endsWith('\r') ? line.slice(0, -1) : line);
        while (lines.length > 0 && lines[lines.length - 1] === '') {
          lines.pop();
        }
        recentLogs = lines;
      } else if (Array.isArray(rawLogs)) {
        const lines = rawLogs.map(item => {
          const s = (item == null ? '' : String(item));
          return s.endsWith('\r') ? s.slice(0, -1) : s;
        });
        while (lines.length > 0 && lines[lines.length - 1] === '') {
          lines.pop();
        }
        recentLogs = lines;
      }

      return sendJson(res, 200, {
        ok: true,
        running: core.running,
        ready: core.ready,
        pid: core.pid,
        manualStopped: core.manualStopped,
        port: core.port,
        version: core.version,
        exitInfo,
        recentLogs
      });
    }

    // 3. 安装/切换 ZCode 运行时版本（SSE 流式推送详细日志）
    if (subPath === '/api/zcode/install' && req.method === 'POST') {
      if (versionTaskBusy) {
        return sendJson(res, 409, { ok: false, error: '已有版本切换或还原任务正在进行中' });
      }
      const body = await readJsonBody(req);
      const version = String(body.version || '').trim();
      if (!version) return sendJson(res, 400, { ok: false, error: '版本号不能为空' });
      // 强校验：版本号必须是合法 semver（阻断 `../` 目录穿越与 npm 说明符注入）
      if (!zcodeManager.isValidVersion(version)) {
        return sendJson(res, 400, { ok: false, error: '版本号格式不合法（仅允许形如 3.14.3 的版本号）' });
      }

      // 安全闸门：拒绝在线热切换存在破坏性架构变更的版本（danger 级别）
      const evalRes = versionService.evaluateTargetVersion(version);
      if (evalRes && evalRes.level === 'danger') {
        return sendJson(res, 400, {
          ok: false,
          error: evalRes.message || '该版本存在重大破坏性架构变更，禁止在线热切换，必须重新拉取最新 Docker 镜像。'
        });
      }

      const sse = openTaskSse(res);
      sse.send({ type: 'log', message: `[安装] 目标版本 v${version}` });

      versionTaskBusy = true;
      let result = null;
      let failure = null;
      try {
        result = await zcodeManager.installVersion(version, (evt) => sse.send(evt));
      } catch (err) {
        failure = err;
      } finally {
        versionTaskBusy = false;
      }
      sse.finish(result, failure);
      return;
    }

    // 4. ZCode 服务启停与重启控制（manualStopped 由 zcodeManager 在 boot/stop 内部维护）
    if (subPath === '/api/zcode/start' && req.method === 'POST') {
      const r = await zcodeManager.boot();
      const ok = !(r && r.ok === false);
      return sendJson(res, ok ? 200 : 500, { ok, ...(r && typeof r === 'object' ? r : {}) });
    }

    if (subPath === '/api/zcode/stop' && req.method === 'POST') {
      const r = await zcodeManager.stop();
      return sendJson(res, 200, { ok: true, ...(r && typeof r === 'object' ? r : {}) });
    }

    if (subPath === '/api/zcode/restart' && req.method === 'POST') {
      const r = await zcodeManager.restart();
      const ok = !(r && r.ok === false);
      return sendJson(res, ok ? 200 : 500, { ok, ...(r && typeof r === 'object' ? r : {}) });
    }

    if (subPath === '/api/zcode/auto-heal/clear' && req.method === 'POST') {
      zcodeManager.clearAutoIsolatedEvents();
      return sendJson(res, 200, { ok: true });
    }

    // 5. 桌面启停控制
    // 5.1 「彻底开关」总开关：持久化，停用后连网关/容器重启也不再自动启动
    if (subPath === '/api/desktop/master' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const r = await applyDesktopMaster(body && body.enabled !== false);
      if (!r.ok) return sendJson(res, 500, r);
      // 桌面模式/工具菜单可能在重启后生效：restart=true 时立即重启上游
      if (body && body.restart === true) {
        console.log('[gateway] 桌面总开关已切换，正在重启 ZCode 以同步运行环境...');
        const rr = await zcodeManager.restart().catch(err => ({ ok: false, error: safeErrMsg(err) }));
        r.coreRestarted = !!(rr && rr.ok);
        if (!r.coreRestarted) r.warning = '状态已保存且桌面已停用，但 ZCode 重启失败：' + ((rr && rr.error) || '未知错误');
      }
      return sendJson(res, 200, r);
    }

    // 5.2 桌面运行参数（模式/分辨率/休眠/CDP/截图默认值）：
    //     控制台「桌面」页是唯一权威写入点，直接持久化到 gateway.config.json
    if (subPath === '/api/desktop/config' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const r = applyDesktopConfigPatch(body);
      return sendJson(res, r.ok ? 200 : (r.error && r.error.includes('没有可应用') ? 400 : 500), r);
    }

    if (subPath === '/api/desktop/start' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const r = await desktopManager.start(body);
      return sendJson(res, r.ok ? 200 : 500, r);
    }

    if (subPath === '/api/desktop/stop' && req.method === 'POST') {
      const r = await desktopManager.stop();
      return sendJson(res, 200, r);
    }

    if (subPath === '/api/desktop/restart' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const r = await desktopManager.restart(body);
      return sendJson(res, r.ok ? 200 : 500, r);
    }

    if (subPath === '/api/desktop/keepalive' && req.method === 'POST') {
      const body = await readJsonBody(req);
      desktopManager.applyConfig(body);
      desktopManager.touchActivity(body.durationMinutes);
      return sendJson(res, 200, { ok: true, status: desktopManager.getStatus() });
    }

    // 6. 配置快照备份、恢复与导入 (完全与 Web 服务解耦，异步非阻塞执行)
    if (subPath === '/api/snapshots' && req.method === 'GET') {
      const list = await backupService.listBackups();
      if (list && typeof list === 'object' && !Array.isArray(list)) return sendJson(res, 200, list);
      return sendJson(res, 200, { ok: true, snapshots: Array.isArray(list) ? list : [], activeTask: null });
    }

    if (subPath === '/api/snapshots/create' && req.method === 'POST') {
      const body = await readJsonBody(req);
      try {
        const label = body && body.label ? String(body.label) : '';
        const scope = body && body.scope === 'full' ? 'full' : 'config';
        const r = await backupService.createBackup(label, scope);
        return sendJson(res, 200, { ok: true, ...(r && typeof r === 'object' ? r : {}) });
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: safeErrMsg(err) });
      }
    }

    if (subPath === '/api/snapshots/inspect' && req.method === 'GET') {
      const file = query.get('file') || '';
      if (!file) {
        return sendJson(res, 400, { ok: false, error: '缺少 file 参数' });
      }
      try {
        const r = await backupService.inspectSnapshot(file);
        if (r && typeof r === 'object' && r.ok === false) {
          return sendJson(res, 404, r);
        }
        return sendJson(res, 200, { ok: true, ...(r && typeof r === 'object' ? r : {}) });
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: safeErrMsg(err) });
      }
    }

    if (subPath === '/api/snapshots/restore' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const file = String((body && (body.filename || body.file)) || '');
      if (!file) return sendJson(res, 400, { ok: false, error: '缺少 filename 参数' });
      // 兼容两套命名：控制台用 scope:'config'|'full'，契约用 mode:'full'|'config-only'
      const rawScope = String((body && (body.mode || body.scope)) || 'full').trim();
      const mode = rawScope === 'config' ? 'config-only' : rawScope;
      if (mode !== 'full' && mode !== 'config-only') {
        return sendJson(res, 400, { ok: false, error: `非法还原范围: ${rawScope}（仅支持 'full' 或 'config-only'/'config'）` });
      }

      const sse = openTaskSse(res);
      sse.send({ type: 'log', message: `[快照还原] 文件: ${file}  范围: ${mode}` });
      let result = null;
      let failure = null;
      try {
        result = await backupService.restoreBackup(file, zcodeManager, { mode });
      } catch (err) {
        failure = err;
      }
      sse.finish(result, failure);
      return;
    }

    if (subPath === '/api/snapshots/import' && req.method === 'POST') {
      const filename = query.get('filename') || req.headers['x-filename'] || 'imported-snapshot.tar.gz';
      try {
        const r = await backupService.importBackupStream(req, filename);
        return sendJson(res, 200, { ok: true, ...(r && typeof r === 'object' ? r : {}) });
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: safeErrMsg(err) });
      }
    }

    if (subPath === '/api/snapshots/delete' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const file = String((body && (body.filename || body.file)) || '');
      if (!file) return sendJson(res, 400, { ok: false, error: '缺少 filename 参数' });
      const r = await backupService.deleteBackup(file);
      if (r === false || (r && typeof r === 'object' && r.ok === false)) {
        return sendJson(res, 500, { ok: false, error: (r && r.error) || '快照删除失败' });
      }
      return sendJson(res, 200, { ok: true, ...(r && typeof r === 'object' ? r : {}) });
    }

    if (subPath === '/api/snapshots/download' && req.method === 'GET') {
      const file = query.get('file') || '';
      const filePath = backupService.getBackupPath(file);
      if (!filePath) return sendJson(res, 404, { ok: false, error: '快照文件未找到' });

      res.writeHead(200, {
        'Content-Type': 'application/gzip',
        'Content-Disposition': 'attachment; filename="' + path.basename(filePath) + '"'
      });
      // 兜底：归档在读取前被并发删除时，绝不让流错误冒泡成未捕获异常（会拖垮整个网关）
      const stream = fs.createReadStream(filePath);
      stream.on('error', (err) => {
        console.error('[gateway] 快照下载失败:', (err && err.message) || err);
        try { res.end(); } catch {}
      });
      return stream.pipe(res);
    }

    // 6.5 ZCode 插件识别、启用/禁用与清理卸载
    if (subPath === '/api/plugins' && req.method === 'GET') {
      try {
        const r = await pluginManager.getPlugins();
        const plugins = Array.isArray(r) ? r : (r && Array.isArray(r.plugins) ? r.plugins : []);
        // 附带运行时快照元信息：供管理页展示「上次运行时加载时刻」与是否已有权威基线
        const snap = pluginManager.getRuntimeSnapshot();
        const core = getRawCoreStatus();
        return sendJson(res, 200, {
          ok: true,
          plugins,
          runtime: {
            running: core.running === true,
            ready: core.ready === true,
            uptimeSeconds: core.uptimeSeconds || 0,
            snapshotAt: snap.ok ? snap.capturedAt : null,
            snapshotKnown: snap.ok,
          },
        });
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: safeErrMsg(err) });
      }
    }

    if (subPath === '/api/plugins/toggle' && req.method === 'POST') {
      const body = await readJsonBody(req);
      try {
        const id = String((body && body.id) || '');
        if (!id) throw new Error('缺少插件 id');
        const r = await pluginManager.togglePlugin(id, body.enabled !== false);
        return sendJson(res, 200, { ok: true, ...(r && typeof r === 'object' ? r : {}) });
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: safeErrMsg(err) });
      }
    }

    if (subPath === '/api/plugins/uninstall' && req.method === 'POST') {
      const body = await readJsonBody(req);
      try {
        const id = String((body && body.id) || '');
        if (!id) throw new Error('缺少插件 id');
        const r = await pluginManager.uninstallPlugin(id);
        return sendJson(res, 200, { ok: true, ...(r && typeof r === 'object' ? r : {}) });
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: safeErrMsg(err) });
      }
    }

    if (subPath === '/api/plugins/install' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const source = String((body && body.source) || '').trim();
      if (!source) return sendJson(res, 400, { ok: false, error: '缺少插件来源 source' });

      const sse = openTaskSse(res);
      sse.send({ type: 'log', message: `[插件安装] 来源: ${source}` });
      let result = null;
      let failure = null;
      try {
        result = await pluginManager.installPlugin(source, (evt) => sse.send(evt));
      } catch (err) {
        failure = err;
      }
      sse.finish(result, failure);
      return;
    }

    // 7. 保存网关与系统配置并立即重启
    if (subPath === '/api/config/save' && req.method === 'POST') {
      const body = await readJsonBody(req);

      const newPort = Number(body.proxyPort) || PROXY_PORT;
      if (newPort < 1 || newPort > 65535) {
        return sendJson(res, 400, { ok: false, error: '端口号必须在 1 ~ 65535 范围内' });
      }

      const newAdmin = normalizeRoutePath(body.adminPath, ADMIN_PATH);
      const newVnc = normalizeRoutePath(body.vncPath, VNC_PATH);
      if (newAdmin === newVnc) {
        return sendJson(res, 400, { ok: false, error: '控制台路径与桌面路径不能相同' });
      }

      // 访问口令：沿用参考项目的管理入口（初始化向导之外的口令轮换路径）
      let updatedToken = getAuthToken();
      if (body.clearAuthToken === true) {
        updatedToken = '';
      } else if (body.authToken !== undefined && body.authToken !== '' && body.authToken !== '******') {
        updatedToken = String(body.authToken).trim();
      }
      // 口令强度校验：拒绝弱口令（与初始化向导同一套规则）
      if (updatedToken && updatedToken !== getAuthToken() && isWeakPassword(updatedToken)) {
        return sendJson(res, 400, { ok: false, error: '访问口令过弱：长度至少 6 位，且不要使用 admin / password 等常见弱口令' });
      }

      // 自愈策略
      const newAutoHeal = body.autoHealPlugins !== false;
      const newAutoHealMax = Math.max(1, Math.min(50, Number(body.autoHealMaxPerBoot) || 5));
      applyAutoHealConfig(newAutoHeal, newAutoHealMax);

      // 桌面运行参数：desktop 段是控制台「桌面」页的权威；此处接受可选 patch 一并应用
      let desktopPatch = {};
      if (body.desktop && typeof body.desktop === 'object') {
        desktopPatch = normalizeDesktopConfigPatch(body.desktop);
        if (Object.keys(desktopPatch).length) {
          persistDesktopConfig(desktopPatch);
          desktopManager.applyConfig(desktopPatch);
        }
        if (typeof body.desktop.enabled === 'boolean') {
          persistDesktopConfig({ enabled: body.desktop.enabled });
          desktopManager.setEnabled(body.desktop.enabled);
        }
      }

      const trustProxy = body.trustProxy !== undefined
        ? (body.trustProxy === true || body.trustProxy === '1' || body.trustProxy === 'true')
        : undefined;
      if (trustProxy !== undefined) setTrustProxy(trustProxy);

      const publicHost = body.publicHost !== undefined
        ? String(body.publicHost).split(',').map(s => s.trim()).filter(Boolean).join(',')
        : undefined;

      // 桌面运行参数以 DesktopManager 当前值为准（权威在控制台「桌面」页）
      const ds = desktopManager.getStatus();

      const newCfg = {
        proxyPort: newPort,
        adminPath: newAdmin,
        vncPath: newVnc,
        authToken: updatedToken,
        autoHealPlugins: newAutoHeal,
        autoHealMaxPerBoot: newAutoHealMax,
        desktop: {
          // 桌面运行参数一律以 DesktopManager 当前值为准（权威在控制台「桌面」页），
          // 此处保存网关/系统配置时不得覆盖，避免形成第二个写入点；
          // 本请求显式提交的 desktop patch 叠加在最上层（保证新字段如 mode 一定落盘）。
          enabled: desktopManager.isEnabled(),
          mode: ds.mode,
          width: ds.width,
          height: ds.height,
          enableCdp: ds.enableCdp,
          cdpPort: ds.cdpPort,
          idleTimeoutMinutes: ds.idleTimeoutMinutes,
          screenshotQuality: ds.screenshotQuality,
          screenshotDir: ds.screenshotDir,
          ...desktopPatch
        },
        savedAt: new Date().toISOString()
      };
      if (trustProxy !== undefined) newCfg.trustProxy = trustProxy;
      if (publicHost !== undefined) newCfg.publicHost = publicHost;

      const saved = savePersistedConfig(newCfg);
      if (!saved) {
        return sendJson(res, 500, { ok: false, error: '持久化配置文件写入失败' });
      }

      const logSafeCfg = {
        ...newCfg,
        authToken: newCfg.authToken ? '******' : ''
      };
      console.log('[gateway] 控制台提交新配置:', logSafeCfg);

      // 返回跳转新 URL 信息
      sendJson(res, 200, {
        ok: true,
        message: '配置已持久化保存，网关服务将在 1 秒后重启生效...',
        newPort,
        newAdminPath: newAdmin,
        newVncPath: newVnc
      });

      // 延迟触发重启
      setTimeout(async () => {
        console.log('[gateway] 执行重启以应用新网关配置...');
        // 先优雅停止桌面并等待进程真正退出，避免新网关启动时撞上未退场的旧进程
        await desktopManager.stop();
        await zcodeManager.stop();
        process.exit(0);
      }, 800);

      return;
    }

    return sendJson(res, 404, { ok: false, error: '接口不存在' });
  } catch (err) {
    return sendJson(res, 500, { ok: false, error: safeErrMsg(err) });
  }
}

// ── 内部桌面控制 API (供容器内插件调用) ───────────────────────
async function handleInternalDesktopApi(req, res, pathname) {
  try {
    const action = pathname.replace('/__internal/desktop/', '').trim();
    // 附带网关权威的 VNC 路径，供插件生成正确的 vncUrl（避免沿用过期的本地配置）
    if (action === 'status') return sendJson(res, 200, { ...desktopManager.getStatus(), vncPath: VNC_PATH_HREF });

    const body = await readJsonBody(req);
    // 内部（loopback）权威写入路径：供插件做一次性迁移 / 与控制台保持同一权威
    if (action === 'config') {
      const r = applyDesktopConfigPatch(body);
      return sendJson(res, r.ok ? 200 : 400, r);
    }
    if (action === 'master') {
      const r = await applyDesktopMaster(body && body.enabled !== false);
      return sendJson(res, r.ok ? 200 : 500, r);
    }
    if (action === 'start') {
      const r = await desktopManager.start(body);
      return sendJson(res, 200, r);
    }
    if (action === 'stop') {
      const r = await desktopManager.stop();
      return sendJson(res, 200, r);
    }
    if (action === 'restart') {
      const r = await desktopManager.restart(body);
      return sendJson(res, 200, r);
    }
    if (action === 'keepalive') {
      desktopManager.applyConfig(body);
      desktopManager.touchActivity(body.durationMinutes);
      return sendJson(res, 200, { ok: true, status: desktopManager.getStatus() });
    }
    return sendJson(res, 404, { ok: false, error: '未知操作' });
  } catch (err) {
    return sendJson(res, 500, { ok: false, error: safeErrMsg(err) });
  }
}

function handleAuthVerify(req, res) {
  const clientIp = getClientIp(req);
  const rateLimit = checkRateLimit(clientIp);
  if (!rateLimit.allowed) {
    res.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ ok: false, error: rateLimit.error }));
  }

  let body = '';
  req.on('data', chunk => {
    body += chunk;
    if (body.length > 1024 * 64) req.destroy();
  });
  req.on('end', () => {
    try {
      const data = JSON.parse(body);
      const token = (data.token || '').trim();
      if (verifyToken(token)) {
        recordAuthAttempt(clientIp, true);
        setAuthCookie(res, req);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } else {
        recordAuthAttempt(clientIp, false);
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: '认证码错误，请重新输入' }));
      }
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: '请求数据格式错误' }));
    }
  });
}

// 初始化向导提交：设置访问口令（仅在"尚未设置"时可用）
function handleSetupSubmit(req, res) {
  if (!isSetupRequired()) {
    return sendJson(res, 409, { ok: false, error: '访问口令已设置；如需修改请前往控制台' });
  }
  const clientIp = getClientIp(req);
  const rateLimit = checkRateLimit(clientIp);
  if (!rateLimit.allowed) return sendJson(res, 429, { ok: false, error: rateLimit.error });

  let body = '';
  req.on('data', chunk => {
    body += chunk;
    if (body.length > 1024 * 64) req.destroy();
  });
  req.on('end', () => {
    try {
      const data = JSON.parse(body);
      const pwd = typeof data.password === 'string' ? data.password : '';
      const confirm = typeof data.confirm === 'string' ? data.confirm : '';
      if (!pwd || !confirm) return sendJson(res, 400, { ok: false, error: '请填写口令并二次确认' });
      if (pwd !== confirm) return sendJson(res, 400, { ok: false, error: '两次输入的口令不一致' });
      if (isWeakPassword(pwd)) return sendJson(res, 400, { ok: false, error: '口令过弱：长度至少 6 位，且不要使用常见弱口令' });

      // 合并写回，避免覆盖 desktop/paths 等其它持久化字段
      const cfg = loadPersistedConfig();
      cfg.authToken = pwd;
      cfg.savedAt = new Date().toISOString();
      if (!savePersistedConfig(cfg)) {
        return sendJson(res, 500, { ok: false, error: '口令持久化失败，请检查数据卷权限后重试' });
      }
      updateAuthToken(pwd);
      recordAuthAttempt(clientIp, true);
      setAuthCookie(res, req);
      console.log('[gateway] 已通过初始化向导设置访问口令');
      return sendJson(res, 200, { ok: true });
    } catch {
      return sendJson(res, 400, { ok: false, error: '请求数据格式错误' });
    }
  });
}

/**
 * WebSocket 同源校验（防 CSWSH）：实现见 ws-origin.js。
 * 关键点：**绝不采用 `x-forwarded-host`** —— 该头可被客户端伪造（或经代理原样透传），
 * 攻击者只要把它设成自己页面的域名，Origin 校验就会被绕过。
 * 现在只认「真实 `host` 头」+「显式配置的对外主机名」。
 */
function isAllowedWsOrigin(req) {
  return wsOrigin.isAllowedWsOrigin(req, PUBLIC_HOSTS);
}

// ── 主 HTTP 路由调度 ─────────────────────────────────────────
async function handleHttpRequest(req, res) {
  const rawUrl = req.url || '/';
  const safePath = '/' + rawUrl.replace(/^\/+/, '');
  const parsedUrl = new URL(safePath, 'http://127.0.0.1');
  const pathname = parsedUrl.pathname;
  req.url = pathname + parsedUrl.search;

  // 1. 公开路径白名单
  //    未设置访问口令时，登录页改为"初始化向导"，其余请求一律被引导到 /setup
  if (pathname === '/login') {
    if (isSetupRequired()) { res.writeHead(302, { Location: '/setup' }); return res.end(); }
    return serveStaticHtml(res, 'login.html');
  }
  if (pathname === '/__auth/verify' && req.method === 'POST') return handleAuthVerify(req, res);
  if (pathname === '/logout') {
    clearAuthCookie(res);
    res.writeHead(302, { Location: isSetupRequired() ? '/setup' : '/login' });
    return res.end();
  }
  if (pathname === '/setup' && req.method === 'GET') {
    // 口令已设置后不再展示初始化向导：否则会留下一个"看着能用、提交必然失败"的僵尸表单
    if (!isSetupRequired()) { res.writeHead(302, { Location: '/login' }); return res.end(); }
    return serveStaticHtml(res, 'setup.html');
  }
  if (pathname === '/__auth/setup' && req.method === 'POST') return handleSetupSubmit(req, res);

  // 免鉴权健康检查：供 Docker HEALTHCHECK / 负载均衡探活使用（不泄漏任何敏感信息）
  if (pathname === '/healthz') {
    const ds = desktopManager.getStatus();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({
      ok: true,
      version: versionService.getLocalProjectVersion(),
      uptimeSeconds: Math.floor(process.uptime()),
      port: PROXY_PORT,
      authEnabled: isAuthEnabled(),
      setupRequired: isSetupRequired(),
      // 回显"实际生效值 + 来源"，便于排查 .env / 持久化配置 / 默认值之间的漂移
      configSource: {
        port: PROXY_PORT_SOURCE,
        adminPath: ADMIN_PATH_SOURCE,
        vncPath: VNC_PATH_SOURCE,
        authToken: AUTH_TOKEN_SOURCE,
        upstreamPort: ZCODE_PORT_SOURCE
      },
      adminPath: ADMIN_PATH,
      vncPath: VNC_PATH,
      core: getCoreStatus(),
      desktop: { enabled: !!ds.enabled, running: !!ds.running }
    }));
  }

  if (pathname === '/favicon.svg' || pathname === '/favicon.ico') {
    const staticFile = path.join(__dirname, 'public', pathname.slice(1));
    if (fs.existsSync(staticFile)) {
      res.writeHead(200, {
        'Content-Type': pathname.endsWith('.svg') ? 'image/svg+xml' : 'image/x-icon',
        'Cache-Control': 'public, max-age=86400'
      });
      return fs.createReadStream(staticFile).pipe(res);
    }
  }

  // 2. 本地回环 + 内部共享密钥的内部接口 (供容器内插件工具通信)
  //    仅凭"来源是回环"不够：网关若位于反向代理之后，外部请求的对端地址也会是 127.0.0.1。
  //    因此追加共享密钥校验（见 internal-token.js）。
  if (pathname.startsWith('/__internal/desktop/')) {
    const peer = wsOrigin.normalizeIp(req.socket && req.socket.remoteAddress);
    const isLoopbackReq = peer === '127.0.0.1' || peer === '::1';
    if (isLoopbackReq && verifyInternalToken(req)) {
      return handleInternalDesktopApi(req, res, pathname);
    }
    return sendJson(res, 403, { ok: false, error: '内部接口拒绝访问（需要回环来源 + 内部密钥）' });
  }

  // 3. 初始化闸门：未设置访问口令前，除上面的公开路径外一律不放行
  if (isSetupRequired()) {
    if (pathname.startsWith(ADMIN_PATH + '/api/') || pathname.startsWith('/__api/')) {
      return sendJson(res, 401, { ok: false, error: '尚未设置访问口令，请先访问 /setup 完成初始化', setupRequired: true });
    }
    const wantsHtml = req.method === 'GET' && (req.headers.accept || '').includes('text/html');
    if (wantsHtml) {
      res.writeHead(302, { Location: '/setup' });
      return res.end();
    }
    return sendJson(res, 401, { ok: false, error: '尚未设置访问口令，请先访问 /setup 完成初始化', setupRequired: true });
  }

  if (PUBLIC_PATHS.has(pathname)) {
    await alignHeadersForUpstream(req);
    return zcodeProxy.web(req, res);
  }

  // 4. 统一身份鉴权校验 (未通过则统一拦截)
  if (!checkRequestAuth(req)) {
    const isHtmlNav = (req.headers.accept || '').includes('text/html') && req.method === 'GET';
    if (isHtmlNav) {
      const redirectTarget = encodeURIComponent(req.url || '/');
      res.writeHead(302, { Location: '/login?redirect=' + redirectTarget });
      return res.end();
    } else {
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: false, error: '未授权，请先登录' }));
    }
  }

  // 4.5 稳定桌面插件接口 (经鉴权后可用，提供与控制台路径解耦的稳定基准路径)
  if (pathname === '/__api/desktop/status' && req.method === 'GET') {
    const st = desktopManager.getStatus();
    return sendJson(res, 200, {
      ...st,
      vncPath: VNC_PATH,
      paths: { admin: ADMIN_PATH, vnc: VNC_PATH, proxyPort: PROXY_PORT },
      desktop: st
    });
  }
  if (pathname === '/__api/desktop/start' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const r = await desktopManager.start(body);
    return sendJson(res, r.ok ? 200 : 500, r);
  }

  // 5. 自定义控制台路由 (ADMIN_PATH)
  if (pathname === ADMIN_PATH || pathname === ADMIN_PATH + '/') {
    return serveAdminHtml(res);
  }
  if (pathname.startsWith(ADMIN_PATH + '/api/')) {
    return handleAdminApi(req, res, pathname, parsedUrl.searchParams);
  }

  // 6. 自定义 VNC 路由 (VNC_PATH)
  if (pathname === VNC_PATH || pathname.startsWith(VNC_PATH + '/')) {
    // 桌面被控制台「彻底停用」时，给出明确提示页而不是让 noVNC 黑屏
    if (!desktopManager.isEnabled()) {
      return serveDesktopDisabledPage(res);
    }
    // 自动唤醒桌面：
    //   用「健康感知」的 getStatus().running 判断，而不是原始 running 标志。
    //   这样即使 Xvfb/Chromium 等关键进程已退出（例如用户把浏览器最后一个标签页/窗口关掉
    //   导致 Chromium 退出），打开 /vnc 也能自愈重启，而不是停在"空桌面"上。
    if (!desktopManager.getStatus().running) {
      desktopManager.start().catch(() => {});
      // 桌面尚未就绪：HTML 导航直接返回「启动中」独立页（3s 自动刷新），
      // 不再转发给还没监听的 websockify —— 从根上消除 502 / 裸 JSON / 黑屏。
      if (isHtmlNavigation(req)) {
        return serveDesktopStartingPage(res);
      }
    } else {
      desktopManager.touchActivity();
    }

    const novncRevision = process.env.NOVNC_ASSET_REVISION || '1.6.0';
    const versionedVncPath = `/novnc-${novncRevision}/vnc.html`;
    // websockify 端点必须下发【绝对路径】。noVNC 在浏览器侧用 `new URL(path, location.href)`
    // 解析 path 参数；由于 vnc.html 位于版本化子目录 (/vnc/novnc-<rev>/vnc.html)，
    // 相对路径 "vnc/websockify" 会被解析成 /vnc/novnc-<rev>/vnc/websockify（网关不认），
    // 导致 WebSocket 握手被拒 (1006)，页面显示 "Failed to connect"。
    const websockifyPath = `${VNC_PATH}/websockify`;

    // 6.1 访问桌面根入口 (如 /vnc 或 /vnc/) -> 302 自动重定向至带版本隔离的 vnc.html (附带防缓存头)
    if (pathname === VNC_PATH || pathname === VNC_PATH + '/') {
      res.writeHead(302, {
        Location: `${VNC_PATH}${versionedVncPath}?autoconnect=1&resize=scale&view_only=0&reconnect=1&path=${websockifyPath}`,
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        Pragma: 'no-cache',
        Expires: '0'
      });
      return res.end();
    }

    // 6.2 兼容直接访问旧版未版本化路径 /vnc/vnc.html -> 自动无感重定向至最新版本化路径
    if (pathname === `${VNC_PATH}/vnc.html`) {
      const search = parsedUrl.search || `?autoconnect=1&resize=scale&view_only=0&reconnect=1&path=${websockifyPath}`;
      res.writeHead(302, {
        Location: `${VNC_PATH}${versionedVncPath}${search}`,
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        Pragma: 'no-cache',
        Expires: '0'
      });
      return res.end();
    }

    // 重写前缀发给 noVNC 静态服务
    req.url = req.url.slice(VNC_PATH.length) || '/';
    return vncProxy.web(req, res);
  }

  // 7. ZCode 主服务转发 (/*)
  await alignHeadersForUpstream(req);
  zcodeProxy.web(req, res);
}

// 请求级异常兜底：单个请求出错只影响该请求，绝不拖垮整个网关进程
function handleRequestCrash(err, req, res) {
  console.error('[gateway] HTTP 请求处理异常:', (err && err.stack) || err);
  try {
    if (res && !res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: '网关内部错误' }));
    } else if (res && typeof res.end === 'function') {
      res.end();
    }
  } catch {}
}

const server = http.createServer((req, res) => {
  handleHttpRequest(req, res).catch((err) => handleRequestCrash(err, req, res));
});

// 请求级超时：防慢速请求长期占用连接（SSE / WebSocket 不受影响）。
// SSE 长任务（安装 / 回滚还原 / 快照还原 / 插件安装）默认允许 ≥600s。
server.headersTimeout = 20000;
server.keepAliveTimeout = 15000;
server.requestTimeout = SSE_TIMEOUT_MS; // ≥600s：允许大快照上传与长任务，但仍有上界
// headersTimeout 的生效依赖周期性检查，默认间隔 30s 会导致"最坏要等 ~50s 才断开"；
// 收紧到 5s，让慢速请求在 ~20s 内被及时断开。
server.connectionsCheckingInterval = 5000;
// 补充：Node 的 headersTimeout 对"连上但一个字节都没发"的连接不生效（实测 40s 仍未断），
// 这里显式加连接级守卫——建立后 20s 内没有任何数据即断开；一旦开始发送数据就交给正常超时体系。
server.on('connection', (socket) => {
  try {
    socket.setTimeout(20000, () => { try { socket.destroy(); } catch {} });
    socket.once('data', () => { try { socket.setTimeout(0); } catch {} });
  } catch {}
});

// ── WebSocket 升级握手调度 ───────────────────────────────────
async function handleUpgrade(req, socket, head) {
  const rawUrl = req.url || '/';
  const safePath = '/' + rawUrl.replace(/^\/+/, '');
  const parsedUrl = new URL(safePath, 'http://127.0.0.1');
  const pathname = parsedUrl.pathname;
  req.url = pathname + parsedUrl.search;

  // 1. 跨站 CSWSH 校验
  if (!isAllowedWsOrigin(req)) {
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    return;
  }

  // 2. 身份认证检查
  if (!checkRequestAuth(req)) {
    socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    return;
  }

  // 3. VNC WebSocket 握手 (兼容版本化路径、相对路径与自定义前缀)
  const vncWsPath = VNC_PATH + '/websockify';
  // 只精确匹配已知的 websockify 端点（过宽的 endsWith 会把任何同后缀路径都当作桌面 WS 代理）
  if (pathname === vncWsPath || pathname === '/websockify') {
    // 桌面被彻底停用时不再转发 VNC WebSocket（与 /vnc 提示页保持一致）
    if (!desktopManager.isEnabled()) {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      return;
    }
    desktopManager.touchActivity();
    // 与 /vnc 一致：若关键进程已退出（例如最后一个标签页被关掉导致 Chromium 退出），
    // 借着这次 WS 连接自愈重启，避免用户停在"空桌面"上。
    if (!desktopManager.getStatus().running) desktopManager.start().catch(() => {});
    req.url = '/websockify' + (parsedUrl.search || '');
    return vncProxy.ws(req, socket, head);
  }

  // 4. ZCode WebSocket 握手 (/ws 等)：与 HTTP 反代同源、同目标
  await alignHeadersForUpstream(req);
  zcodeProxy.ws(req, socket, head);
}

server.on('upgrade', (req, socket, head) => {
  handleUpgrade(req, socket, head).catch((err) => {
    console.error('[gateway] WebSocket 升级处理异常:', (err && err.stack) || err);
    try { socket.end('HTTP/1.1 500 Internal Server Error\r\nConnection: close\r\n\r\n'); } catch {}
  });
});

// ── 服务自举与平滑关闭 ───────────────────────────────────────
async function bootstrap() {
  // 内部接口共享密钥：启动即生成并落盘（0600），保证插件在任何一次工具调用前都能读到
  try {
    const tokenPath = require('./internal-token').tokenFilePath();
    getInternalToken();
    console.log('[gateway] 内部接口密钥已就绪:', tokenPath);
  } catch (err) {
    console.warn('[gateway] 内部接口密钥初始化失败:', err.message);
  }

  server.listen(PROXY_PORT, '0.0.0.0', () => {
    console.log('==================================================');
    console.log('  ZCode 网关已启动');
    console.log('  监听端口: 0.0.0.0:' + PROXY_PORT + ' (来源: ' + PROXY_PORT_SOURCE + ')');
    console.log('  控制台路径: ' + ADMIN_PATH + ' (来源: ' + ADMIN_PATH_SOURCE + ')  桌面路径: ' + VNC_PATH + ' (来源: ' + VNC_PATH_SOURCE + ')');
    console.log('  认证口令来源: ' + AUTH_TOKEN_SOURCE);
    console.log('  认证状态: ' + (isAuthEnabled() ? '已启用认证码保护 (AUTH_TOKEN)' : '未启用认证 (无感直通)'));
    console.log('  ZCode Web 工作区: http://127.0.0.1:' + PROXY_PORT + '/');
    console.log('  ZCode 控制台:     http://127.0.0.1:' + PROXY_PORT + ADMIN_PATH + '/');
    console.log('  noVNC 桌面:       http://127.0.0.1:' + PROXY_PORT + VNC_PATH + '/');
    console.log('  上游 ZCode Web:   ' + ZCODE_TARGET + ' (ZCODE_PORT 来源: ' + ZCODE_PORT_SOURCE + ')');
    console.log('  上游令牌注入:     ' + (ZCODE_INTERNAL_TOKEN_ENABLED ? '已启用 (ZCODE_INTERNAL_TOKEN=1)' : '未启用 (上游以 --no-token 启动)'));
    console.log('==================================================');
  });

  // 首次启动即落盘配置文件：保证「gateway.config.json = 单一权威」始终存在
  if (!fs.existsSync(CONFIG_FILE)) {
    const ds0 = desktopManager.getStatus();
    savePersistedConfig({
      proxyPort: PROXY_PORT,
      adminPath: ADMIN_PATH,
      vncPath: VNC_PATH,
      autoHealPlugins: autoHealEnabled,
      autoHealMaxPerBoot,
      desktop: {
        enabled: ds0.enabled, mode: ds0.mode, width: ds0.width, height: ds0.height,
        enableCdp: ds0.enableCdp, cdpPort: ds0.cdpPort,
        idleTimeoutMinutes: ds0.idleTimeoutMinutes,
        screenshotQuality: ds0.screenshotQuality, screenshotDir: ds0.screenshotDir
      },
      savedAt: new Date().toISOString()
    });
    console.log('[gateway] 已生成初始配置文件:', CONFIG_FILE);
  }

  // 启动虚拟桌面 (尊重控制台「彻底开关」与环境变量；任一处显式关闭则不启动)
  if (!desktopManager.isEnabled()) {
    console.log('[desktop-manager] 虚拟桌面已被控制台彻底停用，跳过开机自动启动');
  } else {
    await desktopManager.start().catch(err => console.error('[desktop-manager] 启动失败:', err.message));
  }

  // 启动 ZCode 核心服务
  await zcodeManager.boot().catch(err => console.error('[zcode-manager] 启动失败:', err.message));

  // 默认首次启动自动创建初始配置快照 (自动防重复创建)
  try {
    await zcodeManager.ensureDefaultSnapshot();
  } catch (err) {
    console.warn('[gateway] 初始快照创建失败(忽略):', (err && err.message) || err);
  }
}

async function shutdown(exitCode = 0) {
  const code = typeof exitCode === 'number' ? exitCode : 0;
  console.log('\n[gateway] 正在退出，关闭桌面与 ZCode 进程...');
  // 兜底：无论如何 8 秒内必须退出，避免关机流程自身卡死
  const hardTimer = setTimeout(() => { console.error('[gateway] 退出超时，强制结束'); process.exit(code); }, 8000);
  if (hardTimer.unref) hardTimer.unref();
  try { await desktopManager.stop(); } catch (e) { console.warn('[gateway] 关闭桌面异常(忽略):', e && e.message); }
  try { await zcodeManager.stop(); } catch (e) { console.warn('[gateway] 关闭 ZCode 异常(忽略):', e && e.message); }
  process.exit(code);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
// 未处理的 Promise 拒绝：记录但【不退出】，避免单个后台任务异常拖垮唯一入口
process.on('unhandledRejection', (reason) => {
  console.error('[gateway] 未处理的 Promise 拒绝（已忽略，进程继续运行）:', (reason && reason.stack) || reason);
});
// 未捕获同步异常：记录后优雅退出，交由 entrypoint 守护循环重启
process.on('uncaughtException', (err) => {
  console.error('[gateway] 未捕获异常，优雅退出以交由守护进程重启:', (err && err.stack) || err);
  shutdown(1).catch(() => process.exit(1));
});

if (require.main === module) {
  bootstrap();
}

module.exports = {
  server,
  bootstrap,
  handleAdminApi,
  getCoreStatus
};
