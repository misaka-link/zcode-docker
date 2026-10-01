/**
 * backup-service.js
 * ------------------------------------------------------------------
 * ZCode 配置快照与还原服务（替代参考项目的 backup-service.js）。
 *
 * 与参考项目的差异：
 *   - 备份域从 `.dsh` 换成 `.zcode`（ZCODE_DIR）；
 *   - 去掉了 DSH 特有的「配置世代 / settings.yaml / cordis.patch.yml」兼容层，
 *     改为 ZCode 语义的「运行时版本」元数据 + 提示级兼容性判断；
 *   - 保留参考项目真正有价值的部分：归档成员安全校验（路径穿越 / 逃逸软链 /
 *     成员数上限）、还原范围选择、还原前自动安全快照、导入导出。
 *
 * 契约：doc/api-contract.md §5.3 / §6
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const manifestLib = require('./snapshot-manifest');

const ZCODE_HOME = process.env.ZCODE_HOME || '/root';
const DATA_DIR = process.env.ZCODE_DIR || path.join(ZCODE_HOME, '.zcode');
const SNAPSHOTS_DIR = process.env.ZCODE_SNAPSHOT_DIR || path.join(ZCODE_HOME, '.zcode-snapshots');
const MAX_MEMBERS = Number(process.env.ZCODE_MAX_ARCHIVE_MEMBERS) > 0
  ? Number(process.env.ZCODE_MAX_ARCHIVE_MEMBERS)
  : 1000000;
const PROJECT_VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'version.json'), 'utf8')).version || '0.0.0';
  } catch { return '0.0.0'; }
})();

const ROOT_NAME = manifestLib.ARCHIVE_ROOT_NAME;              // '.zcode'
const META_REL = `${ROOT_NAME}/.zcode-meta`;                  // 归档内元数据目录
const CONFIG_SCOPE_EXCLUDES = [`${ROOT_NAME}/logs`, `${ROOT_NAME}/workspace`];

fs.mkdirSync(SNAPSHOTS_DIR, { recursive: true });

// ── 工具 ──────────────────────────────────────────────────────────────────
function nowStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function safeLabel(label) {
  const raw = String(label || '').trim();
  if (!raw) return '';
  return raw.replace(/[^0-9A-Za-z\u4e00-\u9fa5._-]+/g, '-').slice(0, 40).replace(/^-+|-+$/g, '');
}

/** 只允许快照目录内的普通文件名（防目录穿越） */
function resolveSnapshotFile(file) {
  const name = path.basename(String(file || ''));
  if (!name || name.startsWith('.')) return null;
  if (!/\.tar\.gz$/i.test(name)) return null;
  const full = path.join(SNAPSHOTS_DIR, name);
  if (!full.startsWith(path.resolve(SNAPSHOTS_DIR) + path.sep)) return null;
  return fs.existsSync(full) ? full : null;
}

function runTar(args, options = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn('tar', args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (c) => { stdout += c; });
    proc.stderr.on('data', (c) => { stderr += c; });
    proc.on('error', reject);
    proc.on('exit', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`tar 执行失败 (code=${code}): ${stderr.trim().split('\n').slice(-3).join(' | ')}`));
    });
  });
}

function currentCoreVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.env.ZCODE_RUNTIME_DIR || '/opt/zcode', 'package.json'), 'utf8'));
    return pkg.version || null;
  } catch { return null; }
}

function readManifestFromArchive(file) {
  // 归档内清单是普通成员，用 tar -xzOf 直接读出，无需整包解压
  return new Promise((resolve) => {
    const proc = spawn('tar', ['-xzOf', file, manifestLib.MANIFEST_RELATIVE], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    proc.stdout.on('data', (c) => { out += c; });
    proc.on('exit', () => resolve(manifestLib.parseManifest(out)));
    proc.on('error', () => resolve(null));
  });
}

async function listArchiveMembers(file) {
  const { stdout } = await runTar(['-tzf', file]);
  return stdout.split('\n').map((s) => s.trim()).filter(Boolean);
}

/** 列出软链成员及目标（tar -tvzf 中形如 `... name -> target`） */
async function listArchiveLinks(file) {
  const { stdout } = await runTar(['-tvzf', file]);
  const links = [];
  for (const line of stdout.split('\n')) {
    const m = line.match(/\s(\S+)\s+->\s+(.+)$/);
    if (m) links.push({ member: m[1], target: m[2].trim() });
  }
  return links;
}

async function validateArchive(file) {
  const members = await listArchiveMembers(file);
  const check = manifestLib.validateMembers(members, { maxMembers: MAX_MEMBERS, rootName: ROOT_NAME });
  if (!check.ok) throw new Error(check.error);
  const links = await listArchiveLinks(file);
  for (const link of links) {
    if (!manifestLib.isSafeSymlinkTarget(link.member, link.target, ROOT_NAME)) {
      throw new Error(`归档包含逃逸软链: ${link.member} -> ${link.target}`);
    }
  }
  return { members, count: check.count, links: links.length };
}

function sizeLabel(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

/** 当前会话数量（ZCode 会话位于 <数据根>/v2/sessions/<workspaceHash>/） */
function countCurrentSessions() {
  const dir = path.join(DATA_DIR, 'v2', 'sessions');
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).length;
  } catch { return 0; }
}

/** 归档内是否包含会话/工作区数据（用于推断「仅配置」还是「完整」快照） */
function archiveHasSessions(members) {
  const prefix = `${ROOT_NAME}/workspace/`;
  return members.some((m) => String(m).startsWith(prefix));
}

function toSnapshotItem({ filename, size, mtime, label, scope, meta }) {
  const type = scope === 'full' ? 'full' : 'config';
  return {
    filename,
    file: filename,
    type,
    scope: type,
    typeLabel: type === 'config' ? '仅配置' : '完整全量',
    label: label || '',
    createdAt: mtime instanceof Date ? mtime.toISOString() : String(mtime || ''),
    size,
    sizeLabel: sizeLabel(size),
    meta: meta || null,
    coreVersion: (meta && meta.coreVersion) || null,
    projectVersion: (meta && meta.projectVersion) || null,
  };
}

// ── 对外接口 ──────────────────────────────────────────────────────────────
async function listBackups() {
  let entries = [];
  try { entries = fs.readdirSync(SNAPSHOTS_DIR, { withFileTypes: true }); } catch {
    return { ok: true, snapshots: [], activeTask: null };
  }
  const snapshots = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!/\.tar\.gz$/i.test(entry.name)) continue;
    const full = path.join(SNAPSHOTS_DIR, entry.name);
    let stat = null;
    try { stat = fs.statSync(full); } catch { continue; }
    const meta = await readManifestFromArchive(full);
    const m = entry.name.match(/^zcode-(config|snapshot|imported)-(\d{8}-\d{6})(?:-(.+))?\.tar\.gz$/);
    const inferredScope = meta && meta.scope ? meta.scope : (m && m[1] === 'config' ? 'config' : 'full');
    snapshots.push(toSnapshotItem({
      filename: entry.name,
      size: stat.size,
      mtime: stat.mtime,
      label: (meta && meta.label) || (m && m[3]) || '',
      scope: inferredScope,
      meta,
    }));
  }
  snapshots.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return { ok: true, snapshots, activeTask: null };
}

async function createBackup(label = '', scope = 'config') {
  const normalizedScope = scope === 'full' ? 'full' : 'config';
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(SNAPSHOTS_DIR, { recursive: true });

  // 1. 写入清单（归档内成员，便于跨机追溯）
  const manifest = manifestLib.createManifest({
    label: safeLabel(label),
    scope: normalizedScope,
    coreVersion: currentCoreVersion(),
    projectVersion: PROJECT_VERSION,
    host: os.hostname(),
  });
  const metaDir = path.join(DATA_DIR, '.zcode-meta');
  fs.mkdirSync(metaDir, { recursive: true });
  fs.writeFileSync(path.join(metaDir, 'snapshot.json'), JSON.stringify(manifest, null, 2));

  // 2. 打包
  const stamp = nowStamp();
  const suffix = manifest.label ? `-${manifest.label}` : '';
  const kind = normalizedScope === 'config' ? 'config' : 'snapshot';
  const filename = `zcode-${kind}-${stamp}${suffix}.tar.gz`;
  const finalPath = path.join(SNAPSHOTS_DIR, filename);
  const tmpPath = path.join(SNAPSHOTS_DIR, `.tmp-${crypto.randomBytes(6).toString('hex')}.tar.gz`);

  const args = ['-czf', tmpPath, '-C', ZCODE_HOME];
  if (normalizedScope === 'config') {
    for (const ex of CONFIG_SCOPE_EXCLUDES) args.push(`--exclude=${ex}`);
  }
  args.push(ROOT_NAME);
  try {
    await runTar(args);
    fs.renameSync(tmpPath, finalPath);
  } catch (err) {
    try { fs.rmSync(tmpPath, { force: true }); } catch {}
    throw err;
  }

  const stat = fs.statSync(finalPath);
  const snapshot = toSnapshotItem({
    filename,
    size: stat.size,
    mtime: stat.mtime,
    label: manifest.label,
    scope: normalizedScope,
    meta: manifest,
  });
  return { ok: true, filename, snapshot };
}

async function inspectSnapshot(file) {
  const full = resolveSnapshotFile(file);
  if (!full) return { ok: false, error: '快照文件不存在或非法' };
  try {
    const validation = await validateArchive(full);
    const meta = await readManifestFromArchive(full);
    const compatibility = manifestLib.compareCompatibility(meta, { coreVersion: currentCoreVersion() });
    const hasSessions = archiveHasSessions(validation.members);
    const top = new Set();
    for (const member of validation.members) {
      const seg = member.split('/').filter(Boolean);
      if (seg.length >= 2) top.add(seg.slice(0, 2).join('/'));
    }
    return {
      ok: true,
      filename: path.basename(full),
      file: path.basename(full),
      size: fs.statSync(full).size,
      meta,
      hasSessions,
      current: { sessionCount: countCurrentSessions() },
      members: validation.count,
      links: validation.links,
      topLevel: [...top].slice(0, 50),
      compatibility,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function getBackupPath(file) {
  return resolveSnapshotFile(file);
}

async function deleteBackup(file) {
  const full = resolveSnapshotFile(file);
  if (!full) return { ok: false, error: '快照文件不存在或非法' };
  fs.rmSync(full, { force: true });
  return { ok: true, filename: path.basename(full) };
}

async function importBackupStream(stream, filename = 'imported-snapshot.tar.gz') {
  const safeName = path.basename(String(filename)).replace(/[^0-9A-Za-z._-]+/g, '-');
  const name = /\.tar\.gz$/i.test(safeName) ? safeName : `${safeName}.tar.gz`;
  const tmpPath = path.join(SNAPSHOTS_DIR, `.import-${crypto.randomBytes(6).toString('hex')}.tar.gz`);
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(tmpPath);
    stream.pipe(out);
    out.on('finish', resolve);
    out.on('error', reject);
    stream.on('error', reject);
  });
  try {
    await validateArchive(tmpPath);
  } catch (err) {
    try { fs.rmSync(tmpPath, { force: true }); } catch {}
    throw new Error(`导入的归档校验失败: ${err.message}`);
  }
  const finalName = `zcode-imported-${nowStamp()}-${name}`;
  const finalPath = path.join(SNAPSHOTS_DIR, finalName);
  fs.renameSync(tmpPath, finalPath);
  const stat = fs.statSync(finalPath);
  const meta = await readManifestFromArchive(finalPath);
  const snapshot = toSnapshotItem({
    filename: finalName,
    size: stat.size,
    mtime: stat.mtime,
    label: (meta && meta.label) || '',
    scope: (meta && meta.scope) || 'full',
    meta,
  });
  return { ok: true, filename: finalName, snapshot };
}

/**
 * 还原快照。
 * @param {string} file 快照文件名
 * @param {object} manager ZCode 运行时管理器（提供 stop()/boot()，可为 null）
 * @param {{mode?:'full'|'config-only'}} options
 */
async function restoreBackup(file, manager = null, options = {}) {
  const mode = options.mode === 'config-only' ? 'config-only' : 'full';
  const full = resolveSnapshotFile(file);
  if (!full) throw new Error('快照文件不存在或非法');

  const validation = await validateArchive(full);
  const meta = await readManifestFromArchive(full);
  const compatibility = manifestLib.compareCompatibility(meta, { coreVersion: currentCoreVersion() });

  // 1. 还原前安全快照（避免误操作不可逆）
  let safety = null;
  try {
    safety = await createBackup('pre-restore', 'config');
    console.log('[backup-service] 已创建还原前安全快照:', safety.filename || safety.file);
  } catch (err) {
    console.warn('[backup-service] 安全快照创建失败(继续还原):', err.message);
  }

  // 2. 解压到 staging
  const staging = fs.mkdtempSync(path.join(SNAPSHOTS_DIR, '.restore-'));
  try {
    await runTar(['-xzf', full, '-C', staging]);
    const stagedData = path.join(staging, ROOT_NAME);
    if (!fs.existsSync(stagedData)) throw new Error(`归档中未找到 ${ROOT_NAME}/ 目录`);

    // 3. 停止运行时（尽量）
    if (manager && typeof manager.stop === 'function') {
      await manager.stop().catch((e) => console.warn('[backup-service] 停止运行时失败(继续):', e.message));
    }

    // 4. 应用
    const keep = mode === 'config-only' ? ['logs', 'workspace'] : [];
    const stagedEntries = fs.readdirSync(stagedData, { withFileTypes: true });
    for (const entry of fs.readdirSync(DATA_DIR, { withFileTypes: true })) {
      if (keep.includes(entry.name)) continue;
      fs.rmSync(path.join(DATA_DIR, entry.name), { recursive: true, force: true });
    }
    for (const entry of stagedEntries) {
      if (keep.includes(entry.name)) continue;
      const src = path.join(stagedData, entry.name);
      const dest = path.join(DATA_DIR, entry.name);
      fs.cpSync(src, dest, { recursive: true, dereference: false, force: true });
    }
    console.log(`[backup-service] 已按 ${mode} 范围还原 ${path.basename(full)}（保留: ${keep.join(', ') || '无'}）`);

    // 5. 重启运行时
    if (manager && typeof manager.boot === 'function') {
      const boot = await manager.boot().catch((e) => ({ ok: false, error: e.message }));
      if (!boot || boot.ok !== true) {
        console.warn('[backup-service] 还原后启动运行时未通过探活，请检查控制台');
      }
    }

    return {
      ok: true,
      restored: path.basename(full),
      filename: path.basename(full),
      mode,
      members: validation.count,
      repairedLinks: 0,
      safetySnapshot: safety ? safety.filename || safety.file : null,
      compatibility,
    };
  } finally {
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch {}
  }
}

module.exports = {
  DATA_DIR,
  SNAPSHOTS_DIR,
  listBackups,
  createBackup,
  restoreBackup,
  deleteBackup,
  getBackupPath,
  inspectSnapshot,
  importBackupStream,
  validateArchive,
};
