/**
 * version-service.js
 * ------------------------------------------------------------------
 * 版本信息服务：
 *   - 本套件（zcode-docker）工程版本：来自根目录 version.json；
 *   - 上游 ZCode 运行时版本：来自活动运行时 package.json；
 *   - 远端元数据：GitHub Releases（zai-org/ZCode），带 TTL 缓存；
 *   - 目标版本评估：仅做「提示级」判断（是否可在线安装 / 是否需要重建镜像）。
 *
 * 契约：doc/api-contract.md §5.5
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const RUNTIME_DIR = process.env.ZCODE_RUNTIME_DIR || '/opt/zcode';
const REPO = process.env.ZCODE_REPO || 'zai-org/ZCode';
const CACHE_TTL_MS = Number(process.env.ZCODE_VERSION_CACHE_TTL_MS) || 30 * 60 * 1000;
const DIST_URL = (process.env.ZCODE_DIST_URL || '').replace(/\/+$/, '');

let cache = { at: 0, data: null, error: null };

function getLocalProjectVersion() {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'version.json'), 'utf8'));
    return meta.version || '0.0.0';
  } catch { return '0.0.0'; }
}

function getProjectMeta() {
  try { return JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'version.json'), 'utf8')); } catch { return {}; }
}

function getLocalCoreVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(RUNTIME_DIR, 'package.json'), 'utf8'));
    return pkg.version || null;
  } catch { return null; }
}

function fetchJson(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.get(url, { timeout: timeoutMs, headers: { 'user-agent': 'zcode-docker', accept: 'application/json' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return fetchJson(res.headers.location, timeoutMs).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')); });
    req.on('error', reject);
  });
}

function parseVersion(v) {
  const m = String(v || '').trim().replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)(?:[-+](.*))?$/);
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] || '' };
}

function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;
  for (const k of ['major', 'minor', 'patch']) {
    if (pa[k] !== pb[k]) return pa[k] > pb[k] ? 1 : -1;
  }
  if (pa.pre === pb.pre) return 0;
  if (!pa.pre) return 1;
  if (!pb.pre) return -1;
  return pa.pre > pb.pre ? 1 : -1;
}

/** 拉取远端元数据（GitHub Releases + 可选 dist 索引） */
async function fetchRemoteMeta({ force = false } = {}) {
  if (!force && cache.data && Date.now() - cache.at < CACHE_TTL_MS) return cache.data;
  const meta = {
    repo: REPO,
    releasesUrl: `https://github.com/${REPO}/releases`,
    latest: null,
    recent: [],
    distUrl: DIST_URL || null,
    distVersions: [],
    fetchedAt: new Date().toISOString(),
  };
  try {
    const releases = await fetchJson(`https://api.github.com/repos/${REPO}/releases?per_page=10`);
    if (Array.isArray(releases)) {
      meta.recent = releases.map((r) => ({
        tag: r.tag_name,
        name: r.name,
        publishedAt: r.published_at,
        url: r.html_url,
        prerelease: !!r.prerelease,
        assets: (r.assets || []).map((a) => ({ name: a.name, size: a.size, url: a.browser_download_url })),
      }));
      const stable = meta.recent.find((r) => !r.prerelease) || meta.recent[0] || null;
      meta.latest = stable ? stable.tag.replace(/^v/, '') : null;
    }
  } catch (err) {
    meta.error = err.message;
  }
  if (DIST_URL) {
    try {
      const index = await fetchJson(`${DIST_URL}/latest.json`);
      const list = Array.isArray(index) ? index : (index && index.versions) || [];
      meta.distVersions = list
        .map((item) => (typeof item === 'string' ? item : item && item.version))
        .filter(Boolean)
        .map(String);
    } catch (err) {
      meta.distError = err.message;
    }
  }
  cache = { at: Date.now(), data: meta, error: meta.error || null };
  return meta;
}

function isUsingRemoteMeta() {
  return Boolean(cache.data && !cache.error);
}

/** 综合版本状态 */
async function check({ force = false } = {}) {
  const meta = await fetchRemoteMeta({ force });
  const coreVersion = getLocalCoreVersion();
  const projectVersion = getLocalProjectVersion();
  const latest = meta.latest;
  return {
    ok: true,
    project: { version: projectVersion, meta: getProjectMeta() },
    core: {
      version: coreVersion,
      installable: Boolean(DIST_URL),
      updateAvailable: Boolean(latest && coreVersion && compareVersions(latest, coreVersion) > 0),
    },
    remote: meta,
    evaluated: latest ? evaluateTargetVersion(latest) : null,
  };
}

/**
 * 评估目标运行时版本是否可安装。
 * @returns {{level:'ok'|'warn'|'danger', installable:boolean, message:string}}
 */
function evaluateTargetVersion(version) {
  const local = getLocalCoreVersion();
  if (!version) return { level: 'danger', installable: false, message: '未指定版本' };
  if (local && String(version) === String(local)) {
    return { level: 'ok', installable: false, message: `当前已运行 ZCode ${local}` };
  }
  if (!DIST_URL) {
    return {
      level: 'warn',
      installable: false,
      message: '未配置 ZCODE_DIST_URL：无法在线下载运行时，请在宿主机构建发行包后挂载进版本库，或重新构建镜像',
    };
  }
  const cmp = local ? compareVersions(version, local) : 0;
  if (cmp > 0) return { level: 'ok', installable: true, message: `可升级到 ZCode ${version}` };
  if (cmp < 0) return { level: 'warn', installable: true, message: `将降级到 ZCode ${version}（注意会话与配置的向后兼容）` };
  return { level: 'ok', installable: true, message: `可安装 ZCode ${version}` };
}

module.exports = {
  check,
  fetchRemoteMeta,
  isUsingRemoteMeta,
  getLocalProjectVersion,
  getLocalCoreVersion,
  getProjectMeta,
  evaluateTargetVersion,
  compareVersions,
};
