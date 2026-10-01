/**
 * token-crawler.js
 * ------------------------------------------------------------------
 * ZCode 版「上游令牌」辅助模块。
 *
 * 参考项目需要从 DSH Web 页面里爬取一次性 launch token 并合成上游 Cookie；
 * ZCode 不需要这种「爬取」：网关与上游同机回环，令牌由 zcode-manager 统一生成并持久化，
 * 因此这里只保留等价的最小接口，保证网关调用面一致：
 *   - getLaunchToken()            → 当前内部上游令牌（未启用时为空串）
 *   - ensureUpstreamCookie(origin)→ `zcode_lite_token=<T>`（未启用时为 null）
 *   - getCachedUpstreamCookie()   → 同上（无缓存语义，直接取当前值）
 *   - injectPolyfill(html)        → 注入极小的 randomUUID 兜底 polyfill（老浏览器兼容）
 *
 * 契约：doc/api-contract.md §4.3
 */
'use strict';

const crypto = require('crypto');

const INTERNAL_TOKEN_ENABLED = process.env.ZCODE_INTERNAL_TOKEN === '1';

const RANDOM_UUID_POLYFILL = `<script>
(function () {
  try {
    if (typeof crypto !== 'undefined' && crypto && typeof crypto.randomUUID !== 'function' && typeof crypto.getRandomValues === 'function') {
      crypto.randomUUID = function () {
        var b = crypto.getRandomValues(new Uint8Array(16));
        b[6] = (b[6] & 0x0f) | 0x40;
        b[8] = (b[8] & 0x3f) | 0x80;
        var h = [];
        for (var i = 0; i < 16; i++) h.push((b[i] + 0x100).toString(16).slice(1));
        return h.slice(0, 4).join('') + '-' + h.slice(4, 6).join('') + '-' + h.slice(6, 8).join('') + '-' + h.slice(8, 10).join('') + '-' + h.slice(10, 16).join('');
      };
    }
  } catch (e) {}
})();
</script>`;

let cachedToken = null;

function getLaunchToken() {
  if (!INTERNAL_TOKEN_ENABLED) return '';
  if (cachedToken) return cachedToken;
  try {
    // 复用 zcode-manager 的持久化令牌（延迟 require，避免循环依赖）
    const manager = require('./zcode-manager');
    if (manager && typeof manager.getUpstreamToken === 'function') {
      cachedToken = manager.getUpstreamToken() || '';
      return cachedToken;
    }
  } catch {}
  cachedToken = crypto.randomBytes(32).toString('base64url');
  return cachedToken;
}

function ensureUpstreamCookie() {
  const token = getLaunchToken();
  return token ? `zcode_lite_token=${encodeURIComponent(token)}` : null;
}

function getCachedUpstreamCookie() {
  return ensureUpstreamCookie();
}

function injectPolyfill(html) {
  if (typeof html !== 'string' || !html) return html;
  const headIdx = html.toLowerCase().indexOf('<head');
  if (headIdx !== -1) {
    const endIdx = html.indexOf('>', headIdx);
    if (endIdx !== -1) return html.slice(0, endIdx + 1) + RANDOM_UUID_POLYFILL + html.slice(endIdx + 1);
  }
  return RANDOM_UUID_POLYFILL + html;
}

module.exports = {
  getLaunchToken,
  ensureUpstreamCookie,
  getCachedUpstreamCookie,
  RANDOM_UUID_POLYFILL,
  injectPolyfill,
  INTERNAL_TOKEN_ENABLED,
};
