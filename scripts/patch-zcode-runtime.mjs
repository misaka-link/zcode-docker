#!/usr/bin/env node
/**
 * patch-zcode-runtime.mjs
 * 
 * 在镜像构建期或本地准备期对 ZCode 运行时应用补丁：
 * 让 systemService.info() 的 homedir 字段支持环境变量 ZCODE_BROWSE_ROOT 覆盖。
 * 未设置该环境变量时回退至原系统 homedir 表达式，行为完全不变。
 * 
 * 特性：
 * 1. 幂等：若已打补丁（检测到 ZCODE_BROWSE_ROOT）则跳过并提示 already patched。
 * 2. 容错：若未匹配到目标片段，打印醒目 WARN 并以退出码 0 退出，不阻断构建流程。
 * 3. 支持 --check 模式输出 JSON 状态供检测与排障。
 */

import fs from 'node:fs';
import path from 'node:path';

// 匹配形如 homedir:homedir(),platform:process.platform 的结构及其压缩与别名变体
const TARGET_REGEX = /homedir\s*:\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\(\s*\)|(?:\(0\s*,\s*)?[A-Za-z0-9_$.]+\)?\(\s*\))\s*,\s*platform\s*:/g;

function parseArgs(argv) {
  let runtimeDir = '/opt/zcode';
  let checkMode = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--check') {
      checkMode = true;
    } else if (arg === '--runtime') {
      if (i + 1 >= argv.length) {
        console.error('Error: --runtime option requires a directory path');
        process.exit(1);
      }
      runtimeDir = argv[++i];
    } else if (arg.startsWith('--runtime=')) {
      runtimeDir = arg.slice('--runtime='.length);
    } else if (arg === '-h' || arg === '--help') {
      console.log('Usage: node patch-zcode-runtime.mjs [--runtime <dir>] [--check]');
      process.exit(0);
    }
  }

  return {
    runtimeDir: path.resolve(process.cwd(), runtimeDir),
    checkMode,
  };
}

function findJsFiles(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findJsFiles(fullPath));
    } else if (entry.isFile() && (entry.name.endsWith('.js') || entry.name.endsWith('.cjs'))) {
      results.push(fullPath);
    }
  }
  return results;
}

function locateCandidateFiles(runtimeDir) {
  const primary = path.join(runtimeDir, 'server', 'entry-http.js');
  if (fs.existsSync(primary)) {
    return [primary];
  }

  const serverDir = path.join(runtimeDir, 'server');
  if (fs.existsSync(serverDir)) {
    return findJsFiles(serverDir);
  }

  return [];
}

function run() {
  const { runtimeDir, checkMode } = parseArgs(process.argv.slice(2));
  const primaryTarget = path.join(runtimeDir, 'server', 'entry-http.js');
  const candidateFiles = locateCandidateFiles(runtimeDir);

  if (candidateFiles.length === 0) {
    const message = `未找到运行时入口文件（预期路径: ${primaryTarget}），未打补丁，默认目录仍为 HOME。`;
    if (checkMode) {
      console.log(JSON.stringify({
        runtime: runtimeDir,
        targetFile: primaryTarget,
        patched: false,
        patchable: false,
        matchCount: 0,
        status: 'file_not_found',
        message,
      }, null, 2));
      process.exit(0);
    }
    console.warn(`[WARN] ${message}`);
    console.log('\nSummary:');
    console.log(`- Target file: ${primaryTarget}`);
    console.log('- Matches found: 0');
    console.log('- Status: unpatched (file not found)');
    console.log('- Already patched (skipped): false');
    process.exit(0);
  }

  // 1. 优先检查是否已经打过补丁（幂等性）
  for (const filePath of candidateFiles) {
    let content = '';
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }

    if (content.includes('ZCODE_BROWSE_ROOT')) {
      if (checkMode) {
        console.log(JSON.stringify({
          runtime: runtimeDir,
          targetFile: filePath,
          patched: true,
          patchable: false,
          matchCount: 0,
          status: 'already_patched',
          message: `File ${filePath} is already patched`,
        }, null, 2));
        process.exit(0);
      }
      console.log(`[patch-zcode-runtime] Runtime already patched (detected ZCODE_BROWSE_ROOT in ${filePath}). Skipping.`);
      console.log('\nSummary:');
      console.log(`- Target file: ${filePath}`);
      console.log('- Matches found: 0');
      console.log('- Status: already patched');
      console.log('- Already patched (skipped): true');
      process.exit(0);
    }
  }

  // 2. 定位包含目标片段的文件并应用补丁
  for (const filePath of candidateFiles) {
    let content = '';
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }

    const matches = content.match(TARGET_REGEX);
    const matchCount = matches ? matches.length : 0;

    if (matchCount > 0) {
      if (checkMode) {
        console.log(JSON.stringify({
          runtime: runtimeDir,
          targetFile: filePath,
          patched: false,
          patchable: true,
          matchCount,
          status: 'patchable',
          message: `Found ${matchCount} match(es) in ${filePath}`,
        }, null, 2));
        process.exit(0);
      }

      const patchedContent = content.replace(
        TARGET_REGEX,
        (_match, originalExpr) => `homedir:((process.env.ZCODE_BROWSE_ROOT||"").trim()||${originalExpr}),platform:`
      );

      fs.writeFileSync(filePath, patchedContent, 'utf8');

      console.log(`[patch-zcode-runtime] Applied patch to: ${filePath}`);
      console.log(`[patch-zcode-runtime] Patched ${matchCount} occurrence(s) with ZCODE_BROWSE_ROOT fallback.`);
      console.log('\nSummary:');
      console.log(`- Target file: ${filePath}`);
      console.log(`- Matches found: ${matchCount}`);
      console.log('- Status: patched');
      console.log('- Already patched (skipped): false');
      process.exit(0);
    }
  }

  // 3. 未找到目标片段（容错退出）
  const warnMsg = `在扫描的文件中未找到目标片段 (homedir:homedir(),platform:...)；未打补丁，默认目录仍为 HOME。`;
  if (checkMode) {
    console.log(JSON.stringify({
      runtime: runtimeDir,
      targetFile: candidateFiles[0] || primaryTarget,
      patched: false,
      patchable: false,
      matchCount: 0,
      status: 'target_not_found',
      message: warnMsg,
    }, null, 2));
    process.exit(0);
  }

  console.warn(`[WARN] ${warnMsg}`);
  console.log('\nSummary:');
  console.log(`- Target file: ${candidateFiles[0] || primaryTarget}`);
  console.log('- Matches found: 0');
  console.log('- Status: unpatched (target not found)');
  console.log('- Already patched (skipped): false');
  process.exit(0);
}

run();
