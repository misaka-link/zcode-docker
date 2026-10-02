/**
 * plugin-manager.js
 * ------------------------------------------------------------------
 * ZCode 原生插件管理（替代参考项目里面向 DSH 插件体系的实现）。
 *
 * ZCode 自带插件体系与市场，命令面为：
 *   zcode plugins list [--json] [--available]
 *   zcode plugins install <plugin>[@marketplace] [-s user|project]
 *   zcode plugins uninstall <plugin> [--keep-data] [--force]
 *   zcode plugins enable|disable <plugin>
 *   zcode plugins update <plugin>
 *   zcode plugins marketplace list|add|remove|update
 *
 * 网关侧只做「执行 CLI + 结构化解析」，不重复实现插件语义。
 *
 * 契约：doc/api-contract.md §5.4
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const RUNTIME_DIR = process.env.ZCODE_RUNTIME_DIR || '/opt/zcode';
const WORKSPACE = process.env.ZCODE_WORKSPACE || '/workspace';
const CLI_TIMEOUT_MS = Number(process.env.ZCODE_CLI_TIMEOUT_MS) || 120000;

const ZCODE_HOME = process.env.ZCODE_HOME || '/root';
const ZCODE_DIR = process.env.ZCODE_DIR || path.join(ZCODE_HOME, '.zcode');
// CLI 侧插件配置（`zcode plugins enable/disable` 写入的权威启用位）
const CLI_CONFIG_FILE = path.join(ZCODE_DIR, 'cli', 'config.json');
// 运行时启动时刻的启用位快照：用于识别「配置已改、但运行时未重启」的中间态
const RUNTIME_SNAPSHOT_FILE = path.join(ZCODE_DIR, 'cli', 'plugin-runtime-snapshot.json');
const OFFICIAL_MARKETPLACE = 'zcode-plugins-official';

function cliEntry() {
  const runner = path.join(RUNTIME_DIR, 'bin', 'zcode.mjs');
  if (fs.existsSync(runner)) return runner;
  const agent = path.join(RUNTIME_DIR, 'agent', 'zcode.cjs');
  if (fs.existsSync(agent)) return agent;
  return null;
}

/**
 * 执行 `zcode <args...>`。
 * @returns {Promise<{code:number, stdout:string, stderr:string}>}
 */
function runCli(args, { timeoutMs = CLI_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const entry = cliEntry();
    if (!entry) return reject(new Error('未找到 ZCode 运行时，无法执行插件命令'));
    const proc = spawn(process.execPath, [entry, ...args], {
      cwd: fs.existsSync(WORKSPACE) ? WORKSPACE : '/',
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { proc.kill('SIGKILL'); } catch {}
      reject(new Error(`命令超时: zcode ${args.join(' ')}`));
    }, timeoutMs);
    if (timer.unref) timer.unref();

    proc.stdout.on('data', (c) => { stdout += c; });
    proc.stderr.on('data', (c) => { stderr += c; });
    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    proc.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code === null ? -1 : code, stdout, stderr });
    });
  });
}

function parseJsonLoose(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;
  try { return JSON.parse(trimmed); } catch {}
  // CLI 可能先输出告警行，再输出 JSON：尝试取第一个 '[' 或 '{' 起始的片段
  const indexes = [trimmed.indexOf('['), trimmed.indexOf('{')].filter((i) => i >= 0);
  if (!indexes.length) return null;
  const candidate = trimmed.slice(Math.min(...indexes));
  try { return JSON.parse(candidate); } catch { return null; }
}

function normalizePlugin(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = raw.id || raw.name;
  if (!id) return null;
  return {
    id: String(id),
    name: raw.name || String(id).split('/').pop(),
    version: raw.version || null,
    enabled: raw.enabled !== false,
    source: raw.source || raw.marketplace || null,
    marketplace: raw.marketplace || null,
    description: raw.description || '',
    rootPath: raw.rootPath || null,
    dataPath: raw.dataPath || null,
    diagnostics: Array.isArray(raw.diagnostics) ? raw.diagnostics : [],
  };
}

/** 已安装插件列表 */
async function getPlugins() {
  try {
    const { code, stdout, stderr } = await runCli(['plugins', 'list', '--json']);
    const parsed = parseJsonLoose(stdout);
    if (!Array.isArray(parsed)) {
      return { ok: false, plugins: [], error: stderr.trim() || `插件列表解析失败 (code=${code})` };
    }
    const plugins = parsed.map(normalizePlugin).filter(Boolean);
    return { ok: true, plugins: annotatePendingRestart(plugins), source: 'cli' };
  } catch (err) {
    return { ok: false, plugins: [], error: err.message };
  }
}

/**
 * 标注「已停用/启用但需重启才生效」的中间态。
 *
 * 原理：插件启用位由 CLI 配置（cli/config.json）即时写入并持久化，但 ZCode 运行时
 * 只在启动（bootstrap）时解析一次插件组件。因此运行时启动时刻的生效态才是「当前真正
 * 在跑」的状态；此后任何开关变更都处于「配置已改、运行时未重启」的中间态。
 *
 * 判定：拿运行时启动时的快照（plugin-runtime-snapshot.json）与当前实际生效态逐一比对，
 * 不一致即标记 pendingRestart=true，并回传 runtimeEnabled（运行时内真正生效的值）。
 */
function annotatePendingRestart(plugins) {
  const snapshot = readRuntimeSnapshot();
  if (!snapshot || !snapshot.enabled || typeof snapshot.enabled !== 'object') {
    // 无快照（从未记录过运行时启动态）：不臆测中间态，交由 UI 显示「未知」
    return plugins.map((p) => ({ ...p, pendingRestart: false, runtimeEnabled: null, runtimeKnown: false }));
  }
  const snapEnabled = snapshot.enabled;
  return plugins.map((p) => {
    const hasKey = Object.prototype.hasOwnProperty.call(snapEnabled, p.id);
    const runtimeEnabled = hasKey ? snapEnabled[p.id] === true : null;
    // 快照缺失该 id（运行时启动后才安装）同样属于「运行时未加载」，需重启
    const pendingRestart = !hasKey || runtimeEnabled !== p.enabled;
    return { ...p, pendingRestart, runtimeEnabled, runtimeKnown: true };
  });
}

function readRuntimeSnapshot() {
  try {
    const data = JSON.parse(fs.readFileSync(RUNTIME_SNAPSHOT_FILE, 'utf8'));
    if (data && data.enabled && typeof data.enabled === 'object') return data;
  } catch {
    // 无快照或损坏：视为未知
  }
  return null;
}

/**
 * 读取当前插件启用位映射（id -> enabled）。反映的是 CLI 配置的即时状态。
 */
async function readEnabledMap() {
  const { code, stdout } = await runCli(['plugins', 'list', '--json']);
  const parsed = parseJsonLoose(stdout);
  if (!Array.isArray(parsed)) {
    throw new Error(`插件列表解析失败 (code=${code})`);
  }
  const enabled = {};
  for (const raw of parsed) {
    const p = normalizePlugin(raw);
    if (p) enabled[p.id] = p.enabled;
  }
  return enabled;
}

/**
 * 写入「运行时启动时刻的插件生效态」快照。
 * 由 zcode-manager 在运行时 boot 成功时调用（唯一写入点）：
 * 在 spawn 前读取配置态、探活成功后落盘，确保记录的是运行时实际读到的那份配置，
 * 不受启动窗口期内用户改动的影响。
 */
function writeRuntimeSnapshot(enabled) {
  const payload = { capturedAt: new Date().toISOString(), enabled };
  try {
    fs.mkdirSync(path.dirname(RUNTIME_SNAPSHOT_FILE), { recursive: true });
    fs.writeFileSync(RUNTIME_SNAPSHOT_FILE, JSON.stringify(payload, null, 2) + '\n', {
      encoding: 'utf8',
      mode: 0o600,
    });
    return { ok: true, ...payload };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** 兼容入口：读取当前配置并立即落盘为运行时快照 */
async function captureRuntimeSnapshot() {
  try {
    return writeRuntimeSnapshot(await readEnabledMap());
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** 读取当前运行时快照（供 UI/排障） */
function getRuntimeSnapshot() {
  const snap = readRuntimeSnapshot();
  return snap ? { ok: true, ...snap } : { ok: false, capturedAt: null, enabled: null };
}

/** 已安装 + 市场可安装 */
async function getPluginsOverview() {
  try {
    const { code, stdout, stderr } = await runCli(['plugins', 'list', '--json', '--available']);
    const parsed = parseJsonLoose(stdout);
    if (!parsed || typeof parsed !== 'object') {
      return { ok: false, installed: [], available: [], error: stderr.trim() || `插件总览解析失败 (code=${code})` };
    }
    return {
      ok: true,
      installed: (parsed.installed || []).map(normalizePlugin).filter(Boolean),
      available: Array.isArray(parsed.available) ? parsed.available : [],
      diagnostics: Array.isArray(parsed.diagnostics) ? parsed.diagnostics : [],
      source: 'cli',
    };
  } catch (err) {
    return { ok: false, installed: [], available: [], error: err.message };
  }
}

async function togglePlugin(id, enabled) {
  if (!id) throw new Error('缺少插件 id');
  const action = enabled === false ? 'disable' : 'enable';
  const { code, stdout, stderr } = await runCli(['plugins', action, String(id)]);
  if (code !== 0) throw new Error(stderr.trim() || stdout.trim() || `${action} 失败 (code=${code})`);
  return { ok: true, id: String(id), enabled: enabled !== false };
}

async function uninstallPlugin(id, { keepData = false, force = true } = {}) {
  if (!id) throw new Error('缺少插件 id');
  const args = ['plugins', 'uninstall', String(id)];
  if (keepData) args.push('--keep-data');
  if (force) args.push('--force');
  const { code, stdout, stderr } = await runCli(args);
  if (code !== 0) throw new Error(stderr.trim() || stdout.trim() || `卸载失败 (code=${code})`);
  return { ok: true, id: String(id) };
}

async function installPlugin(source, onEvent = () => {}) {
  if (!source) throw new Error('缺少插件来源（name 或 name@marketplace）');
  const emit = (payload) => { try { onEvent(payload); } catch {} };
  emit({ type: 'log', message: `安装插件: ${source}` });
  const { code, stdout, stderr } = await runCli(['plugins', 'install', String(source)]);
  if (stdout.trim()) emit({ type: 'log', message: stdout.trim() });
  if (code !== 0) {
    emit({ type: 'error', message: stderr.trim() || `安装失败 (code=${code})` });
    throw new Error(stderr.trim() || stdout.trim() || `安装失败 (code=${code})`);
  }
  emit({ type: 'done', message: `插件 ${source} 安装完成` });
  return { ok: true, source: String(source) };
}

async function updatePlugin(id) {
  if (!id) throw new Error('缺少插件 id');
  const { code, stdout, stderr } = await runCli(['plugins', 'update', String(id)]);
  if (code !== 0) throw new Error(stderr.trim() || stdout.trim() || `更新失败 (code=${code})`);
  return { ok: true, id: String(id) };
}

async function listMarketplaces() {
  const { code, stdout, stderr } = await runCli(['plugins', 'marketplace', 'list', '--json']);
  const parsed = parseJsonLoose(stdout);
  if (!Array.isArray(parsed)) throw new Error(stderr.trim() || `市场列表解析失败 (code=${code})`);
  return { ok: true, marketplaces: parsed };
}

module.exports = {
  getPlugins,
  getPluginsOverview,
  togglePlugin,
  uninstallPlugin,
  installPlugin,
  updatePlugin,
  listMarketplaces,
  captureRuntimeSnapshot,
  getRuntimeSnapshot,
  readEnabledMap,
  writeRuntimeSnapshot,
  runCli,
};
