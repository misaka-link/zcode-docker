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
    return { ok: true, plugins: parsed.map(normalizePlugin).filter(Boolean), source: 'cli' };
  } catch (err) {
    return { ok: false, plugins: [], error: err.message };
  }
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
  runCli,
};
