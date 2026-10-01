/**
 * snapshot-manifest.js
 * ------------------------------------------------------------------
 * ZCode 快照清单（manifest）与归档成员校验。
 *
 * 与参考项目不同：ZCode 没有 DSH 那种「配置世代 / settings.yaml / cordis.patch.yml」
 * 的多版本配置模型，因此这里只保留真正必要的能力：
 *   1. 生成 / 解析快照清单（版本元数据 + 归档统计）；
 *   2. 归档成员安全校验（路径穿越、绝对路径、逃逸软链、成员数上限）；
 *   3. 版本兼容性提示（快照创建时的运行时版本 vs 当前版本）。
 */
'use strict';

const path = require('path');

const ARCHIVE_ROOT_NAME = '.zcode';
const MANIFEST_RELATIVE = `${ARCHIVE_ROOT_NAME}/.zcode-meta/snapshot.json`;

/** 生成清单对象 */
function createManifest(ctx = {}) {
  return {
    schema: 1,
    createdAt: new Date().toISOString(),
    label: ctx.label || '',
    scope: ctx.scope || 'config',
    coreVersion: ctx.coreVersion || null,
    projectVersion: ctx.projectVersion || null,
    host: ctx.host || null,
    archiveRoot: ARCHIVE_ROOT_NAME,
    note: 'zcode-docker snapshot manifest',
  };
}

/** 解析清单（容错：非法 JSON 返回 null） */
function parseManifest(raw) {
  if (!raw) return null;
  try {
    const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!data || typeof data !== 'object') return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * 校验归档成员列表。
 * @param {string[]} members 形如 ['', '.zcode/', '.zcode/v2/config.json', ...]
 * @param {{maxMembers?:number, rootName?:string}} options
 * @returns {{ok:boolean, error?:string, count:number}}
 */
function validateMembers(members, options = {}) {
  const rootName = options.rootName || ARCHIVE_ROOT_NAME;
  const maxMembers = Number(options.maxMembers) > 0 ? Number(options.maxMembers) : 1000000;
  const list = Array.isArray(members) ? members.filter((m) => m !== '') : [];
  if (list.length > maxMembers) {
    return { ok: false, count: list.length, error: `归档成员数 ${list.length} 超过上限 ${maxMembers}` };
  }
  for (const raw of list) {
    const member = String(raw);
    if (member.includes('\0')) {
      return { ok: false, count: list.length, error: '归档成员包含空字节' };
    }
    if (member.startsWith('/')) {
      return { ok: false, count: list.length, error: `归档包含绝对路径成员: ${member}` };
    }
    const segments = member.split('/').filter((s) => s.length > 0);
    if (segments.includes('..') || segments.includes('.')) {
      return { ok: false, count: list.length, error: `归档成员包含非法路径段: ${member}` };
    }
    if (segments[0] !== rootName) {
      return { ok: false, count: list.length, error: `归档成员逃出根目录 ${rootName}/: ${member}` };
    }
  }
  return { ok: true, count: list.length };
}

/**
 * 校验符号链接目标是否安全（不得逃出归档根）。
 * @param {string} member 软链自身路径
 * @param {string} target 软链目标
 */
function isSafeSymlinkTarget(member, target, rootName = ARCHIVE_ROOT_NAME) {
  if (!target) return false;
  if (path.posix.isAbsolute(target)) return false;
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(member), target));
  if (resolved === '..' || resolved.startsWith('../')) return false;
  return resolved === rootName || resolved.startsWith(`${rootName}/`);
}

/**
 * 版本兼容性比较：只做「提示级」判断，不阻断还原。
 * @returns {{level:'ok'|'info'|'warn', message:string}}
 */
function compareCompatibility(snapshotMeta, current = {}) {
  const snap = snapshotMeta && snapshotMeta.coreVersion;
  const cur = current.coreVersion;
  if (!snap || !cur) {
    return { level: 'info', message: '快照未记录运行时版本，还原前请自行确认兼容性' };
  }
  if (snap === cur) return { level: 'ok', message: `快照与当前运行时版本一致（${cur}）` };
  return {
    level: 'warn',
    message: `快照创建于 ZCode ${snap}，当前运行时为 ${cur}；跨版本还原后建议重启并检查会话与配置`,
  };
}

module.exports = {
  ARCHIVE_ROOT_NAME,
  MANIFEST_RELATIVE,
  createManifest,
  parseManifest,
  validateMembers,
  isSafeSymlinkTarget,
  compareCompatibility,
};
