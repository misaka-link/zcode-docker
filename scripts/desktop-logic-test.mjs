#!/usr/bin/env node
/**
 * desktop-logic-test.mjs
 * ------------------------------------------------------------------
 * 虚拟桌面编排逻辑的「无 X 服务器」验证。
 *
 * 背景：部分开发/沙箱环境无法运行真实 Xvfb（xkbcomp 需要写入 /var/lib/xkb），
 * 因此这里用**桩可执行文件**替换 Xvfb / openbox / x11vnc / websockify / chromium-docker / xdpyinfo，
 * 只验证 desktop-manager 的编排逻辑本身：
 *   1. 启动顺序与进程数量（Xvfb → openbox → x11vnc → websockify → 前端）；
 *   2. browser 模式下 Chromium 的启动参数默认指向 about:blank（支持自定义 startUrl）；
 *   3. client 模式下改为拉起 Electron 客户端，且缺客户端时给出明确错误；
 *   4. 状态上报（mode/running/分辨率/CDP/空闲/startUrl）与 stop() 的完整回收。
 *
 * 真实 X 渲染 / noVNC 画面需在 Docker 镜像内验证（见 doc/verification-report.md）。
 *
 * 用法：node scripts/desktop-logic-test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = path.join(ROOT, '.build', 'desktop-logic-test');
const BIN = path.join(TMP, 'bin');
const ARGS_LOG = path.join(TMP, 'argv.log');

fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(BIN, { recursive: true });

// ── 桩可执行文件：把 argv 记录到 argv.log，然后安静地睡（直到被 kill） ──
function makeStub(name) {
  const file = path.join(BIN, name);
  fs.writeFileSync(
    file,
    `#!/bin/sh\necho "${name} $*" >> "${ARGS_LOG}"\nsleep 600\n`,
    { mode: 0o755 },
  );
}
for (const name of ['Xvfb', 'openbox', 'x11vnc', 'websockify', 'chromium-docker', 'zcode-client-stub']) {
  makeStub(name);
}
// xdpyinfo 需要「探测成功」：直接 exit 0
fs.writeFileSync(path.join(BIN, 'xdpyinfo'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });

// ── 环境 ──
const PORT = 3030;
process.env.PATH = `${BIN}:${process.env.PATH}`;
process.env.DISPLAY = ':99';
process.env.VNC_PORT = '6080';
process.env.ZCODE_PORT = String(PORT);
process.env.ZCODE_HOME = path.join(TMP, 'home');
process.env.ZCODE_DIR = path.join(TMP, 'home', '.zcode');
process.env.CHROME_USER_DATA_DIR = path.join(TMP, 'home', '.config', 'chromium');
process.env.ZCODE_DESKTOP_ENABLED = '1';
process.env.ZCODE_DESKTOP_WIDTH = '1440';
process.env.ZCODE_DESKTOP_HEIGHT = '900';
process.env.ZCODE_IDLE_TIMEOUT_MINUTES = '0';
process.env.ZCODE_DESKTOP_MODE = 'browser';

const require = createRequire(import.meta.url);
const desktop = require(path.join(ROOT, 'gateway', 'desktop-manager.js'));

let pass = 0;
let fail = 0;
const check = (label, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✅ ${label}`); }
  else { fail += 1; console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ''}`); }
};
const readArgv = () => {
  try { return fs.readFileSync(ARGS_LOG, 'utf8').trim().split('\n'); } catch { return []; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('▶ browser 模式编排');
const startRes = await desktop.start({ width: 1440, height: 900 });
await sleep(400);
const argv = readArgv();
check('start() 返回 ok', startRes && startRes.ok === true, JSON.stringify(startRes).slice(0, 160));
check('拉起 Xvfb', argv.some((l) => l.startsWith('Xvfb ')));
check('拉起 openbox', argv.some((l) => l.startsWith('openbox')));
check('拉起 x11vnc（本地回环 + RFB 端口）', argv.some((l) => l.startsWith('x11vnc ') && l.includes('-localhost')));
check('拉起 websockify（noVNC 静态目录）', argv.some((l) => l.startsWith('websockify ') && l.includes('/usr/share/novnc')));
const chromeLine = argv.find((l) => l.startsWith('chromium-docker ')) || '';
check('browser 模式拉起 Chromium', Boolean(chromeLine), chromeLine);
check('默认（未设置 ZCODE_DESKTOP_START_URL）时 Chromium 打开 about:blank', chromeLine.includes('about:blank') && !chromeLine.includes('--app='), chromeLine);
check('Chromium 携带 CDP 调试端口', chromeLine.includes('--remote-debugging-port='), chromeLine);

const st = desktop.getStatus();
check('status.mode = browser', st.mode === 'browser', st.mode);
check('status.running = true', st.running === true);
check('status.startUrl 默认上报 about:blank', st.startUrl === 'about:blank', st.startUrl);
check('status 分辨率正确', st.width === 1440 && st.height === 900, `${st.width}x${st.height}`);
check('status 上报 CDP 端口', typeof st.cdpPort === 'number');

console.log('▶ startUrl 自定义地址验证');
// 1. 设置 ZCODE_DESKTOP_START_URL=zcode 并通过 restart 验证
desktop.updateConfig({ startUrl: 'zcode' });
fs.writeFileSync(ARGS_LOG, '');
const zcodeRestart = await desktop.restart();
await sleep(400);
check('startUrl=zcode restart() 返回 ok', zcodeRestart && zcodeRestart.ok === true, JSON.stringify(zcodeRestart).slice(0, 160));
const zcodeChrome = readArgv().find((l) => l.startsWith('chromium-docker ')) || '';
check(`设置 ZCODE_DESKTOP_START_URL=zcode 时 Chromium 打开 http://127.0.0.1:${PORT}/`, zcodeChrome.includes(`http://127.0.0.1:${PORT}/`), zcodeChrome);
check('status.startUrl 解析为容器内 ZCode Web', desktop.getStatus().startUrl.startsWith(`http://127.0.0.1:${PORT}/`), desktop.getStatus().startUrl);

// 2. updateConfig 设置 startUrl=https://example.com/ 并通过 restart 验证
desktop.updateConfig({ startUrl: 'https://example.com/' });
fs.writeFileSync(ARGS_LOG, '');
const restartRes = await desktop.restart();
await sleep(400);
check('startUrl=https://example.com/ restart() 返回 ok', restartRes && restartRes.ok === true, JSON.stringify(restartRes).slice(0, 160));
const exampleChrome = readArgv().find((l) => l.startsWith('chromium-docker ')) || '';
check('设置 ZCODE_DESKTOP_START_URL=https://example.com/ 时打开该地址', exampleChrome.includes('https://example.com/'), exampleChrome);
check('status.startUrl 解析为 https://example.com/', desktop.getStatus().startUrl === 'https://example.com/', desktop.getStatus().startUrl);

// 3. 起始地址解析函数验证（四类取值）
check('_resolveStartUrl("") 返回 about:blank', desktop._resolveStartUrl('') === 'about:blank');
check('_resolveStartUrl("about:blank") 返回 about:blank', desktop._resolveStartUrl('about:blank') === 'about:blank');
check('_resolveStartUrl("zcode") 返回容器内 ZCode Web', desktop._resolveStartUrl('zcode').startsWith(`http://127.0.0.1:${PORT}/`));
check('_resolveStartUrl("zcode-web") 返回容器内 ZCode Web', desktop._resolveStartUrl('zcode-web').startsWith(`http://127.0.0.1:${PORT}/`));
check('_resolveStartUrl("http://custom.local:8080/app") 原样返回', desktop._resolveStartUrl('http://custom.local:8080/app') === 'http://custom.local:8080/app');
check('_resolveStartUrl("https://example.com/test") 原样返回', desktop._resolveStartUrl('https://example.com/test') === 'https://example.com/test');

// 恢复 startUrl 为空，以便后续运行期配置热更新测试
desktop.updateConfig({ startUrl: '' });

console.log('▶ 运行期配置热更新');
const changed = desktop.applyConfig({ width: 1024, height: 768 });
// 重启是异步的（内部需先等待旧显示释放），轮询等待第二次 Xvfb 出现
let xvfbCount = 0;
for (let i = 0; i < 40; i += 1) {
  await sleep(500);
  xvfbCount = readArgv().filter((l) => l.startsWith('Xvfb ')).length;
  if (xvfbCount >= 2) break;
}
const argv2 = readArgv();
await sleep(1500); // 等待本次重启把全部子进程拉完，避免污染下一段断言
check('applyConfig 识别到分辨率变更', changed && changed.width === 1024 && changed.height === 768, JSON.stringify(changed));
check('分辨率变更触发桌面重启（出现第二次 Xvfb）', argv2.filter((l) => l.startsWith('Xvfb ')).length >= 2);

console.log('▶ stop() 回收');
await desktop.stop();
const stopped = desktop.getStatus();
check('stop() 后 running = false', stopped.running === false);

console.log('▶ client 模式');
desktop.updateConfig({ mode: 'client', clientBin: path.join(BIN, 'zcode-client-stub') });
fs.writeFileSync(ARGS_LOG, '');
const clientRes = await desktop.start();
await sleep(400);
const argv3 = readArgv();
check('client 模式启动成功', clientRes && clientRes.ok === true, JSON.stringify(clientRes).slice(0, 160));
check('拉起 Electron 客户端而非 Chromium', argv3.some((l) => l.startsWith('zcode-client-stub')) && !argv3.some((l) => l.startsWith('chromium-docker ')), argv3.join(' | ').slice(0, 200));
check('status.mode = client', desktop.getStatus().mode === 'client');
await desktop.stop();

console.log('▶ client 模式缺失客户端时应明确报错');
desktop.updateConfig({ clientBin: path.join(BIN, 'not-exists-binary') });
const missingRes = await desktop.start();
check('缺客户端时 start() 返回 ok=false', missingRes && missingRes.ok === false, JSON.stringify(missingRes).slice(0, 200));
check('错误信息包含指引', Boolean(missingRes && /客户端|ZCODE_CLIENT_BIN|browser/.test(String(missingRes.error || ''))), String(missingRes && missingRes.error));
await desktop.stop();

console.log('');
console.log(`  通过: ${pass}   失败: ${fail}`);
process.exit(fail === 0 ? 0 : 1);
