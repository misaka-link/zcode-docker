/**
 * zcode-manager.js
 * ------------------------------------------------------------------
 * ZCode 运行时管理器（替代参考项目的 dsh-manager.js）
 *
 * 职责：
 *   1. 进程守护：启动/停止/重启 ZCode Web（server/entry-http.js），健康探活，日志轮转；
 *   2. 版本库：多版本运行时缓存、在线下载安装、原子置换、单槽位回滚；
 *   3. 自愈：非人工停止导致的异常退出按预算自动重启并记录隔离事件；
 *   4. 快照代理：把快照相关调用透传给 backup-service。
 *
 * 契约：doc/api-contract.md §2 / §5.1 / §7
 * 上游启动契约：doc/api-contract.md §1（server/entry-http.js + env）
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const crypto = require('crypto');

const backupService = require('./backup-service');
const pluginManager = require('./plugin-manager');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 路径与环境 ────────────────────────────────────────────────────────────
const ZCODE_HOME = process.env.ZCODE_HOME || '/root';
const ZCODE_DIR = process.env.ZCODE_DIR || path.join(ZCODE_HOME, '.zcode');
const SNAPSHOT_DIR = process.env.ZCODE_SNAPSHOT_DIR || path.join(ZCODE_HOME, '.zcode-snapshots');
const VERSIONS_DIR = process.env.ZCODE_VERSIONS_DIR || path.join(SNAPSHOT_DIR, 'versions');
const RUNTIME_DIR = process.env.ZCODE_RUNTIME_DIR || '/opt/zcode';
const RUNTIME_PARENT = process.env.ZCODE_RUNTIME_PARENT || path.dirname(RUNTIME_DIR);
const ROLLBACK_DIR = path.join(RUNTIME_PARENT, '.zcode-rollback-preserved');
const WORKSPACE = process.env.ZCODE_WORKSPACE || '/workspace';
const PORT = Number(process.env.ZCODE_PORT) || 3030;
const DIST_URL = (process.env.ZCODE_DIST_URL || '').replace(/\/+$/, '');
const MIN_FREE_MB = Number(process.env.ZCODE_VERSIONS_MIN_FREE_MB) || 1536;
const WEB_LOG = process.env.ZCODE_WEB_LOG || path.join(ZCODE_DIR, 'logs', 'zcode-web.log');
const WEB_LOG_MAX_BYTES = Number(process.env.ZCODE_WEB_LOG_MAX_BYTES) || 10 * 1024 * 1024;
const UPSTREAM_TOKEN_FILE = path.join(ZCODE_DIR, '.internal_upstream_token');
const INTERNAL_TOKEN_ENABLED = process.env.ZCODE_INTERNAL_TOKEN === '1';
const GC_KEEP_DEFAULT = Number(process.env.ZCODE_VERSIONS_KEEP) || 3;
const AUTO_HEAL_DEFAULT = process.env.ZCODE_AUTO_HEAL !== '0';
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/;

function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
}

function isValidVersion(value) {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  if (!VERSION_RE.test(v)) return false;
  if (v.includes('..')) return false;
  return true;
}

/** 断言 resolved 路径落在 dir 之内（防目录穿越） */
function resolveWithin(dir, name) {
  const target = path.resolve(dir, name);
  const base = path.resolve(dir) + path.sep;
  if (!target.startsWith(base)) throw new Error(`路径越界: ${name}`);
  return target;
}

function dirSizeBytes(dir) {
  let total = 0;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) total += dirSizeBytes(p);
    else if (entry.isFile()) { try { total += fs.statSync(p).size; } catch {} }
    else if (entry.isSymbolicLink()) { /* 软链不计入 */ }
  }
  return total;
}

function freeMb(target) {
  try {
    const stat = fs.statfsSync ? fs.statfsSync(target) : null;
    if (stat) return Math.floor((stat.bavail * stat.bsize) / (1024 * 1024));
  } catch {}
  return null;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function tailFile(file, lines) {
  try {
    const buf = fs.readFileSync(file, 'utf8');
    const arr = buf.split('\n');
    return arr.slice(Math.max(0, arr.length - lines - 1)).join('\n');
  } catch { return ''; }
}

function rotateLogIfNeeded() {
  try {
    if (!fs.existsSync(WEB_LOG)) return;
    const size = fs.statSync(WEB_LOG).size;
    if (size > WEB_LOG_MAX_BYTES) fs.renameSync(WEB_LOG, WEB_LOG + '.1');
  } catch {}
}

// ── 管理器 ────────────────────────────────────────────────────────────────
class ZCodeManager {
  constructor() {
    this.proc = null;
    this.running = false;
    this.ready = false;
    this.manualStopped = false;
    this.installing = false;
    this.lastExitInfo = null;
    this.startedAt = null;
    this.autoHealEnabled = AUTO_HEAL_DEFAULT;
    this.maxAutoHealPerBoot = Number(process.env.ZCODE_AUTO_HEAL_MAX) || 5;
    this.autoHealCount = 0;
    this.autoIsolatedEvents = [];
    this._opChain = Promise.resolve();
    this._lastLogCheck = 0;
    this._bootedAt = Date.now();

    ensureDir(ZCODE_DIR);
    ensureDir(VERSIONS_DIR);
    ensureDir(path.dirname(WEB_LOG));
    ensureDir(RUNTIME_PARENT);
  }

  _enqueue(task) {
    const run = this._opChain.then(task, task);
    this._opChain = run.then(() => {}, () => {});
    return run;
  }

  // ── 内部令牌（契约 §4.3）───────────────────────────────────────────────
  getUpstreamToken() {
    if (!INTERNAL_TOKEN_ENABLED) return '';
    try {
      const existing = fs.readFileSync(UPSTREAM_TOKEN_FILE, 'utf8').trim();
      if (existing) return existing;
    } catch {}
    const token = crypto.randomBytes(32).toString('base64url');
    try {
      fs.writeFileSync(UPSTREAM_TOKEN_FILE, token, { mode: 0o600 });
    } catch (err) {
      console.warn('[zcode-manager] 内部令牌落盘失败:', err.message);
    }
    return token;
  }

  // ── 版本信息 ──────────────────────────────────────────────────────────
  getCurrentVersion() {
    const pkg = readJson(path.join(RUNTIME_DIR, 'package.json'));
    return pkg && pkg.version ? String(pkg.version) : null;
  }

  getStatus() {
    return {
      version: this.getCurrentVersion(),
      running: this.running && !!this.proc && this.proc.exitCode === null,
      ready: this.ready,
      port: PORT,
      pid: this.proc && this.proc.pid ? this.proc.pid : null,
      manualStopped: this.manualStopped,
      lastExit: this.lastExitInfo,
      installing: this.installing,
      workspace: WORKSPACE,
      runtimeDir: RUNTIME_DIR,
      uptimeSeconds: this.startedAt ? Math.floor((Date.now() - this.startedAt) / 1000) : 0,
      autoHeal: { enabled: this.autoHealEnabled, max: this.maxAutoHealPerBoot, used: this.autoHealCount },
      diskFreeMb: freeMb(ZCODE_DIR),
    };
  }

  getRecentLogs(count = 150) {
    return tailFile(WEB_LOG, count);
  }

  setAutoHeal(enabled, maxPerBoot = this.maxAutoHealPerBoot) {
    this.autoHealEnabled = !!enabled;
    if (Number.isFinite(maxPerBoot) && maxPerBoot > 0) this.maxAutoHealPerBoot = maxPerBoot;
    return { enabled: this.autoHealEnabled, max: this.maxAutoHealPerBoot };
  }

  getAutoIsolatedEvents() { return this.autoIsolatedEvents.slice(-50); }
  clearAutoIsolatedEvents() { this.autoIsolatedEvents = []; return true; }
  isValidVersion(value) { return isValidVersion(value); }

  // ── 启动 / 停止 ───────────────────────────────────────────────────────
  boot() { return this._enqueue(() => this._bootInternal()); }
  stop() { return this._enqueue(() => this._stopInternal()); }
  restart() { return this._enqueue(async () => { await this._stopInternal(); await sleep(300); return this._bootInternal(); }); }

  _spawnEnv(extra = {}) {
    const token = this.getUpstreamToken();
    const agentEntry = path.join(RUNTIME_DIR, 'agent', 'zcode.cjs');
    return {
      ...process.env,
      ...extra,
      // 数据根：显式锁定到 ZCODE_HOME，避免继承到宿主/测试环境的 HOME 漂移
      ZCODE_DATA_BASE_DIR: process.env.ZCODE_DATA_BASE_DIR || ZCODE_HOME,
      HOME: process.env.HOME || ZCODE_HOME,
      PORT: String(PORT),
      ZCODE_SERVER_HOST: '127.0.0.1',
      ZCODE_SERVER_WORKSPACE: WORKSPACE,
      ZCODE_WEB_STATIC_ROOT: path.join(RUNTIME_DIR, 'web'),
      // 显式空串 = 关闭上游鉴权（网关统一认证）；启用内部令牌时传入令牌
      ZCODE_SERVER_AUTH_TOKEN: token || '',
      ZCODE_AGENT_SERVER_COMMAND: process.execPath,
      ZCODE_AGENT_SERVER_ARGS_JSON: JSON.stringify([agentEntry, 'app-server', '--stdio']),
    };
  }

  _runtimeEntry() {
    const entry = path.join(RUNTIME_DIR, 'server', 'entry-http.js');
    if (fs.existsSync(entry)) return entry;
    const runner = path.join(RUNTIME_DIR, 'bin', 'zcode.mjs');
    if (fs.existsSync(runner)) return runner;
    return null;
  }

  async _bootInternal() {
    if (this.running && this.proc && this.proc.exitCode === null) {
      return { ok: true, alreadyRunning: true, status: this.getStatus() };
    }
    const entry = this._runtimeEntry();
    if (!entry) {
      const err = `未找到 ZCode 运行时入口（${RUNTIME_DIR}/server/entry-http.js）`;
      console.error('[zcode-manager]', err);
      return { ok: false, error: err, status: this.getStatus() };
    }

    this.manualStopped = false;
    rotateLogIfNeeded();
    ensureDir(path.dirname(WEB_LOG));

    // 在 spawn 之前读取插件启用位：这才是本次运行时 bootstrap 将读到的那份配置。
    // 探活成功后再落盘为「运行时快照」，供插件管理页识别「配置已改、尚未重启」的中间态。
    let pluginEnabledAtBoot = null;
    try {
      pluginEnabledAtBoot = await pluginManager.readEnabledMap();
    } catch (err) {
      console.warn('[zcode-manager] 读取插件启用位失败(跳过快照):', (err && err.message) || err);
    }
    const logFd = fs.openSync(WEB_LOG, 'a');

    // 使用 runner 时补上 --web 参数（runner 会自行 fork 真正的服务进程）
    const isRunner = entry.endsWith('zcode.mjs');
    const args = isRunner
      ? [entry, '--web', '--host', '127.0.0.1', '--port', String(PORT), '--workspace', WORKSPACE,
         '--no-open', this.getUpstreamToken() ? '--token' : '--no-token']
      : [entry];

    console.log(`[zcode-manager] 启动 ZCode Web: ${process.execPath} ${args.join(' ')}`);
    const proc = spawn(process.execPath, args, {
      cwd: WORKSPACE,
      env: this._spawnEnv(),
      stdio: ['ignore', logFd, logFd],
      detached: false,
    });
    try { fs.closeSync(logFd); } catch {}
    this.proc = proc;
    this.running = true;
    this.ready = false;
    this.startedAt = Date.now();

    proc.on('exit', (code, signal) => this._onExit(code, signal));
    proc.on('error', (err) => {
      console.error('[zcode-manager] 子进程启动错误:', err.message);
      this.running = false;
      this.ready = false;
      this.lastExitInfo = { code: null, signal: null, at: Date.now(), error: err.message };
    });

    const probe = await this.waitReady(Number(process.env.ZCODE_READY_TIMEOUT_MS) || 90000);
    this.ready = probe.ok;
    if (!probe.ok) console.warn('[zcode-manager] 启动后探活未通过:', probe.error || probe.status);
    // 探活通过（或至少进程已拉起）才落盘快照：记录运行时本次实际加载的插件生效态
    if (probe.ok && pluginEnabledAtBoot) {
      const snap = pluginManager.writeRuntimeSnapshot(pluginEnabledAtBoot);
      if (!snap.ok) console.warn('[zcode-manager] 写入插件运行时快照失败:', snap.error);
    }
    return { ok: probe.ok, ready: this.ready, status: this.getStatus() };
  }

  async _stopInternal() {
    this.manualStopped = true;
    if (!this.proc || this.proc.exitCode !== null) {
      this.running = false;
      this.ready = false;
      return { ok: true, alreadyStopped: true, status: this.getStatus() };
    }
    const proc = this.proc;
    console.log('[zcode-manager] 正在停止 ZCode Web...');
    await new Promise((resolve) => {
      let settled = false;
      const done = () => { if (!settled) { settled = true; resolve(); } };
      proc.once('exit', done);
      try { proc.kill('SIGTERM'); } catch {}
      const t1 = setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 5000);
      const t2 = setTimeout(done, 8000);
      if (t1.unref) t1.unref();
      if (t2.unref) t2.unref();
    });
    this.running = false;
    this.ready = false;
    this.proc = null;
    await this._waitPortFree(PORT, 5000);
    return { ok: true, status: this.getStatus() };
  }

  _onExit(code, signal) {
    const wasManual = this.manualStopped;
    this.running = false;
    this.ready = false;
    this.lastExitInfo = { code, signal, at: Date.now(), manual: wasManual };
    console.warn(`[zcode-manager] ZCode Web 退出 (code=${code}, signal=${signal}, manual=${wasManual})`);
    this.proc = null;
    if (wasManual) return;

    // 自愈：非人工停止 → 记录隔离事件并按预算重启
    this.autoIsolatedEvents.push({ at: new Date().toISOString(), code, signal });
    if (!this.autoHealEnabled) return;
    if (this.autoHealCount >= this.maxAutoHealPerBoot) {
      console.error('[zcode-manager] 自愈次数已达上限，停止自动重启（请检查日志或切换版本）');
      return;
    }
    this.autoHealCount += 1;
    console.log(`[zcode-manager] 触发自愈重启 (${this.autoHealCount}/${this.maxAutoHealPerBoot})`);
    setTimeout(() => { this.boot().catch((e) => console.error('[zcode-manager] 自愈重启失败:', e.message)); }, 1500);
  }

  // ── 健康探活 ──────────────────────────────────────────────────────────
  _probeOnce() {
    return new Promise((resolve) => {
      const req = http.request(
        { host: '127.0.0.1', port: PORT, path: '/', method: 'GET', timeout: 3000 },
        (res) => { res.resume(); resolve(res.statusCode && res.statusCode < 500); },
      );
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.on('error', () => resolve(false));
      req.end();
    });
  }

  async waitReady(timeoutMs = 90000) {
    const deadline = Date.now() + timeoutMs;
    let lastStatus = 0;
    while (Date.now() < deadline) {
      if (this.proc && this.proc.exitCode !== null) {
        return { ok: false, error: `进程已退出 (code=${this.proc.exitCode})` };
      }
      if (await this._probeOnce()) return { ok: true };
      await sleep(500);
      lastStatus += 1;
    }
    return { ok: false, error: '探活超时', attempts: lastStatus };
  }

  _waitPortFree(port, ms) {
    const net = require('net');
    const deadline = Date.now() + ms;
    return new Promise((resolve) => {
      const attempt = () => {
        const srv = net.createServer();
        srv.once('error', () => {
          if (Date.now() >= deadline) return resolve(false);
          setTimeout(attempt, 300);
        });
        srv.once('listening', () => srv.close(() => resolve(true)));
        try { srv.listen(port, '127.0.0.1'); } catch { resolve(false); }
      };
      attempt();
    });
  }

  // ── 版本库 ────────────────────────────────────────────────────────────
  getCachedVersions() {
    const out = [];
    let entries = [];
    try { entries = fs.readdirSync(VERSIONS_DIR, { withFileTypes: true }); } catch {}
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.')) continue;
      const dir = path.join(VERSIONS_DIR, entry.name);
      const pkg = readJson(path.join(dir, 'package.json'));
      const version = (pkg && pkg.version) || entry.name;
      let mtime = 0;
      try { mtime = fs.statSync(dir).mtimeMs; } catch {}
      out.push({
        version,
        dir,
        bytes: dirSizeBytes(dir),
        mtime,
        complete: fs.existsSync(path.join(dir, 'server', 'entry-http.js')),
      });
    }
    return out.sort((a, b) => b.mtime - a.mtime);
  }

  /** 远端可下载版本：优先 ZCODE_DIST_URL/latest.json，其次 GitHub Releases */
  async fetchAvailableVersions(force = false) {
    const cached = this.getCachedVersions();
    const cachedSet = new Set(cached.map((v) => v.version));
    const current = this.getCurrentVersion();
    const result = { remote: [], cached, current, source: null, error: null };

    if (DIST_URL) {
      try {
        const meta = await this._fetchJson(`${DIST_URL}/latest.json`);
        const list = Array.isArray(meta) ? meta : (meta && meta.versions) || (meta && meta.version ? [meta] : []);
        result.remote = list
          .map((item) => (typeof item === 'string' ? { version: item } : item))
          .filter((item) => item && isValidVersion(item.version))
          .map((item) => ({
            version: String(item.version),
            size: item.size || null,
            url: item.url || `${DIST_URL}/releases/${item.version}/zcode-${item.version}.tar.gz`,
            cached: cachedSet.has(String(item.version)),
            installed: current === String(item.version),
          }));
        result.source = 'dist';
        return result;
      } catch (err) {
        result.error = `dist 索引获取失败: ${err.message}`;
      }
    }

    // 回退：GitHub Releases（ZCode 官方只发布桌面端产物，此处仅用于展示上游最新版本号）
    try {
      const releases = await this._fetchJson('https://api.github.com/repos/zai-org/ZCode/releases?per_page=20');
      if (Array.isArray(releases)) {
        result.remote = releases
          .map((r) => String(r.tag_name || '').replace(/^v/, ''))
          .filter(isValidVersion)
          .map((v) => ({ version: v, size: null, url: null, cached: cachedSet.has(v), installed: current === v, downloadable: false }));
        result.source = 'github';
      }
    } catch (err) {
      result.error = (result.error ? result.error + '; ' : '') + `GitHub 获取失败: ${err.message}`;
    }
    return result;
  }

  _fetchJson(url) {
    return new Promise((resolve, reject) => {
      const req = http.get(url, { timeout: 15000, headers: { 'user-agent': 'zcode-docker' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return this._fetchJson(res.headers.location).then(resolve, reject);
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

  _download(url, dest, onEvent = () => {}) {
    return new Promise((resolve, reject) => {
      const file = fs.createWriteStream(dest);
      const req = http.get(url, { timeout: 120000, headers: { 'user-agent': 'zcode-docker' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          file.close();
          return this._download(res.headers.location, dest, onEvent).then(resolve, reject);
        }
        if (res.statusCode !== 200) { res.resume(); file.close(); return reject(new Error(`HTTP ${res.statusCode}`)); }
        const total = Number(res.headers['content-length']) || 0;
        let received = 0;
        res.on('data', (chunk) => {
          received += chunk.length;
          if (total) onEvent({ type: 'progress', percent: Math.floor((received / total) * 100) });
        });
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve({ bytes: received })));
      });
      req.on('timeout', () => { req.destroy(); reject(new Error('下载超时')); });
      req.on('error', (err) => { file.close(); reject(err); });
    });
  }

  _extractTarGz(tarball, destDir) {
    return new Promise((resolve, reject) => {
      ensureDir(destDir);
      const proc = spawn('tar', ['-xzf', tarball, '-C', destDir], { stdio: 'ignore' });
      proc.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`tar 解压失败 (code=${code})`))));
      proc.on('error', reject);
    });
  }

  /** 在解压目录中定位运行时根（包含 bin/zcode.mjs 或 server/entry-http.js 的目录） */
  _locateRuntimeRoot(dir) {
    const isRoot = (d) =>
      fs.existsSync(path.join(d, 'server', 'entry-http.js')) || fs.existsSync(path.join(d, 'bin', 'zcode.mjs'));
    if (isRoot(dir)) return dir;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const child = path.join(dir, entry.name);
      if (isRoot(child)) return child;
    }
    return null;
  }

  _assertDiskSpace(needMb) {
    const free = freeMb(VERSIONS_DIR) ?? freeMb(RUNTIME_PARENT) ?? freeMb('/');
    if (free !== null && free < needMb) {
      throw new Error(`磁盘空间不足：可用 ${free}MB < 需求 ${needMb}MB（可用 ZCODE_VERSIONS_MIN_FREE_MB 调整阈值）`);
    }
  }

  /**
   * 跨层安全的目录搬迁。
   *
   * 为什么需要它：容器根文件系统是 overlayfs，镜像层里的目录（如 COPY 出来的 /opt/zcode）
   * 在未开启 redirect_dir 的 overlay2 上执行 rename() 会直接返回 EXDEV（cross-device link）。
   * 因此先尝试 rename（同层时最快且原子），失败则退化为「复制 + 删除」。
   */
  _moveDirSync(src, dest) {
    try {
      fs.renameSync(src, dest);
      return 'rename';
    } catch (err) {
      if (err && (err.code === 'EXDEV' || err.code === 'EPERM' || err.code === 'ENOTEMPTY')) {
        fs.rmSync(dest, { recursive: true, force: true });
        fs.cpSync(src, dest, { recursive: true, dereference: false });
        fs.rmSync(src, { recursive: true, force: true });
        return 'copy';
      }
      throw err;
    }
  }

  /**
   * 安装/切换版本。
   * @param {string} version
   * @param {(evt:object)=>void} onEvent SSE 事件回调
   */
  async installVersion(version, onEvent = () => {}) {
    return this._enqueue(() => this._installInternal(version, onEvent));
  }

  async _installInternal(version, onEvent) {
    const emit = (payload) => { try { onEvent(payload); } catch {} };
    if (!isValidVersion(version)) throw new Error(`非法版本号: ${version}`);
    if (this.installing) throw new Error('已有安装任务在进行中');
    this.installing = true;
    const stagingRoot = path.join(VERSIONS_DIR, '.staging');
    const stagingDir = path.join(stagingRoot, `${version}-${Date.now()}`);
    let swapped = false;
    let wasRunning = this.running;
    try {
      emit({ type: 'log', message: `开始安装 ZCode ${version}` });
      this._assertDiskSpace(MIN_FREE_MB);
      ensureDir(stagingRoot);

      // 1. 取得运行时目录（本地缓存优先）
      const cached = this.getCachedVersions().find((v) => v.version === version && v.complete);
      let sourceDir = cached ? cached.dir : null;

      if (!sourceDir) {
        if (!DIST_URL) {
          throw new Error('未配置 ZCODE_DIST_URL，无法在线安装该版本；请先在宿主机构建并把发行包放入版本库');
        }
        const url = `${DIST_URL}/releases/${version}/zcode-${version}.tar.gz`;
        const tarball = path.join(stagingRoot, `zcode-${version}.tar.gz`);
        emit({ type: 'log', message: `下载 ${url}` });
        await this._download(url, tarball, emit);
        emit({ type: 'log', message: '解压发行包…' });
        const extractDir = path.join(stagingDir, 'extract');
        await this._extractTarGz(tarball, extractDir);
        const root = this._locateRuntimeRoot(extractDir);
        if (!root) throw new Error('发行包结构异常：未找到 server/entry-http.js 或 bin/zcode.mjs');
        sourceDir = root;
        try { fs.unlinkSync(tarball); } catch {}
      } else {
        emit({ type: 'log', message: `使用本地缓存版本: ${cached.dir}` });
      }

      // 2. 自检
      const pkg = readJson(path.join(sourceDir, 'package.json'));
      if (!pkg || !pkg.version) throw new Error('运行时 package.json 缺失或无法解析');
      if (String(pkg.version) !== String(version)) {
        emit({ type: 'warn', message: `版本号不一致：请求 ${version}，实际 ${pkg.version}` });
      }
      if (!fs.existsSync(path.join(sourceDir, 'web'))) throw new Error('运行时缺少 web/ 静态资源');

      // 3. 就绪到 staging
      const prepared = path.join(stagingDir, 'runtime');
      if (path.resolve(sourceDir) !== path.resolve(prepared)) {
        fs.cpSync(sourceDir, prepared, { recursive: true, dereference: false });
      }
      emit({ type: 'log', message: '运行时自检通过，准备原子置换' });

      // 4. 停服 → 原子置换
      wasRunning = this.running;
      await this._stopInternal();
      const previous = this.getCurrentVersion();
      if (fs.existsSync(RUNTIME_DIR)) {
        try { fs.rmSync(ROLLBACK_DIR, { recursive: true, force: true }); } catch {}
        const moved = this._moveDirSync(RUNTIME_DIR, ROLLBACK_DIR);
        emit({ type: 'log', message: `已保存回滚点: ${previous || 'unknown'}（${moved === 'rename' ? '原子重命名' : '跨层复制'}）` });
      }
      this._moveDirSync(prepared, RUNTIME_DIR);
      swapped = true;

      // 5. 启动并探活
      const boot = await this._bootInternal();
      if (!boot.ok) {
        emit({ type: 'warn', message: `新版本探活失败，自动回滚：${boot.status && boot.status.lastExit ? JSON.stringify(boot.status.lastExit) : ''}` });
        await this._rollbackSwap(emit);
        throw new Error('新版本启动探活失败，已回滚到上一版本');
      }

      // 6. 缓存归档（把新版本登记进版本库）
      const cachedDir = path.join(VERSIONS_DIR, version);
      if (!fs.existsSync(cachedDir)) {
        try { fs.cpSync(RUNTIME_DIR, cachedDir, { recursive: true, dereference: false }); } catch (err) {
          emit({ type: 'warn', message: `版本入库失败（不影响运行）: ${err.message}` });
        }
      }
      this._touchVersionUsage(version);
      emit({ type: 'done', version, message: `ZCode ${version} 已生效` });
      return { ok: true, version, previous };
    } catch (err) {
      if (swapped) {
        try { await this._rollbackSwap(emit); } catch (e) { console.error('[zcode-manager] 回滚失败:', e.message); }
      } else if (wasRunning && !this.running) {
        // 置换尚未发生就失败（如下载/校验/搬迁异常）：把原有运行时重新拉起来，避免服务处于停止态
        emit({ type: 'warn', message: '安装未完成，正在恢复原有运行时…' });
        try { await this._bootInternal(); } catch (e) { console.error('[zcode-manager] 恢复运行时失败:', e.message); }
      }
      emit({ type: 'error', message: err.message });
      throw err;
    } finally {
      this.installing = false;
      try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch {}
    }
  }

  _touchVersionUsage(version) {
    try {
      const stamp = path.join(VERSIONS_DIR, '.usage.json');
      const data = readJson(stamp) || {};
      data[version] = Date.now();
      fs.writeFileSync(stamp, JSON.stringify(data, null, 2));
    } catch {}
  }

  async _rollbackSwap(emit = () => {}) {
    await this._stopInternal();
    if (fs.existsSync(ROLLBACK_DIR)) {
      try { fs.rmSync(RUNTIME_DIR, { recursive: true, force: true }); } catch {}
      this._moveDirSync(ROLLBACK_DIR, RUNTIME_DIR);
      emit({ type: 'log', message: '已从回滚点恢复运行时' });
    }
    return this._bootInternal();
  }

  // ── 回滚点 ────────────────────────────────────────────────────────────
  getRollbackPoint() {
    if (!fs.existsSync(ROLLBACK_DIR)) return null;
    const pkg = readJson(path.join(ROLLBACK_DIR, 'package.json'));
    let createdAt = null;
    try { createdAt = fs.statSync(ROLLBACK_DIR).mtime.toISOString(); } catch {}
    return { version: (pkg && pkg.version) || null, path: ROLLBACK_DIR, createdAt };
  }

  async deleteRollbackPoint() {
    if (!fs.existsSync(ROLLBACK_DIR)) return { ok: true, alreadyGone: true };
    fs.rmSync(ROLLBACK_DIR, { recursive: true, force: true });
    return { ok: true };
  }

  async restoreRollbackPoint(onEvent = () => {}) {
    return this._enqueue(async () => {
      const emit = (payload) => { try { onEvent(payload); } catch {} };
      const point = this.getRollbackPoint();
      if (!point) throw new Error('当前没有可用的回滚点');
      emit({ type: 'log', message: `就地回滚到 ${point.version || '上一版本'}` });
      const result = await this._rollbackSwap(emit);
      emit({ type: 'done', message: '回滚完成' });
      return { ok: true, restored: point.version, boot: result };
    });
  }

  // ── 版本库统计 / 清理 ─────────────────────────────────────────────────
  async getVersionsStoreStats() {
    const cached = this.getCachedVersions();
    return {
      count: cached.length,
      bytes: cached.reduce((sum, v) => sum + (v.bytes || 0), 0),
      current: this.getCurrentVersion(),
      versions: cached.map((v) => ({ version: v.version, bytes: v.bytes, mtime: v.mtime, complete: v.complete })),
      rollbackPoint: this.getRollbackPoint(),
      diskFreeMb: freeMb(VERSIONS_DIR),
    };
  }

  async gcVersions(options = {}) {
    const keepN = Number(options.keepN ?? options.keep ?? GC_KEEP_DEFAULT) || GC_KEEP_DEFAULT;
    const current = this.getCurrentVersion();
    const cached = this.getCachedVersions();
    const keep = new Set([current].filter(Boolean));
    for (const item of cached) {
      if (keep.size >= keepN) break;
      keep.add(item.version);
    }
    const removed = [];
    for (const item of cached) {
      if (keep.has(item.version)) continue;
      if (options.dryRun) { removed.push(item.version); continue; }
      try { fs.rmSync(item.dir, { recursive: true, force: true }); removed.push(item.version); } catch {}
    }
    this.cleanupStagingOrphans();
    return { removed, kept: [...keep] };
  }

  cleanupStagingOrphans(maxAgeMs = 3600 * 1000) {
    const stagingRoot = path.join(VERSIONS_DIR, '.staging');
    let entries = [];
    try { entries = fs.readdirSync(stagingRoot, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const p = path.join(stagingRoot, entry.name);
      try {
        const st = fs.statSync(p);
        if (Date.now() - st.mtimeMs > maxAgeMs) fs.rmSync(p, { recursive: true, force: true });
      } catch {}
    }
  }

  async deleteCachedVersion(version) {
    if (!isValidVersion(version)) throw new Error(`非法版本号: ${version}`);
    if (version === this.getCurrentVersion()) throw new Error('不能删除当前正在运行的版本');
    const dir = resolveWithin(VERSIONS_DIR, version);
    if (!fs.existsSync(dir)) return { ok: false, error: '版本不存在' };
    fs.rmSync(dir, { recursive: true, force: true });
    return { ok: true, version };
  }

  // ── 快照代理（透传 backup-service）────────────────────────────────────
  ensureDefaultSnapshot() {
    try {
      const list = backupService.listBackups ? backupService.listBackups() : [];
      if (Array.isArray(list) && list.length === 0) {
        console.log('[zcode-manager] 首次启动，创建初始配置快照');
        return backupService.createBackup ? backupService.createBackup({ label: 'initial' }) : null;
      }
    } catch (err) {
      console.warn('[zcode-manager] 初始快照创建失败(忽略):', err.message);
    }
    return null;
  }

  listSnapshots() { return backupService.listBackups(); }
  restoreSnapshot(file, options) { return backupService.restoreBackup(file, options); }
  deleteSnapshot(file) { return backupService.deleteBackup(file); }
  getSnapshotPath(file) { return backupService.getBackupPath(file); }
}

const instance = new ZCodeManager();
module.exports = instance;
