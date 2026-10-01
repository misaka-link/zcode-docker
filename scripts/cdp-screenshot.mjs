#!/usr/bin/env node
/**
 * cdp-screenshot.mjs — 在容器内通过 CDP 抓取「虚拟桌面里那个 Chromium」的真实画面
 * ------------------------------------------------------------------
 * 这是「VNC 桌面显示 ZCode Web / 客户端」最直接的证据：截取的不是网关页面，
 * 而是运行在 Xvfb 上、由 desktop-manager 拉起的那个 Chromium 的实际渲染结果。
 *
 * 用法（容器内）：node cdp-screenshot.mjs <输出png路径> [url关键字]
 * 依赖：/opt/zcode/node_modules/ws（ZCode 运行时自带）
 */
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';

const OUT = process.argv[2] || '/tmp/cdp-shot.png';
const KEYWORD = process.argv[3] || '3030';
const CDP_PORT = process.env.ZCODE_CDP_PORT || '9222';

const require = createRequire('/opt/zcode/');
let WebSocket;
try {
  WebSocket = require('ws');
} catch {
  try { WebSocket = require('/opt/zcode/node_modules/ws'); } catch (e) {
    console.error('无法加载 ws 模块:', e.message);
    process.exit(1);
  }
}

const getJson = (path) => new Promise((resolve, reject) => {
  const req = http.get({ host: '127.0.0.1', port: CDP_PORT, path, timeout: 5000 }, (res) => {
    let data = '';
    res.on('data', (c) => { data += c; });
    res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
  });
  req.on('timeout', () => { req.destroy(); reject(new Error('CDP 请求超时')); });
  req.on('error', reject);
});

const targets = await getJson('/json/list');
const page = targets.find((t) => t.type === 'page' && String(t.url).includes(KEYWORD))
  || targets.find((t) => t.type === 'page');
if (!page || !page.webSocketDebuggerUrl) {
  console.error('未找到可截图的页面目标');
  process.exit(2);
}
console.log(`目标页面: ${page.url}`);

const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
let id = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const msgId = ++id;
  pending.set(msgId, { resolve, reject });
  ws.send(JSON.stringify({ id: msgId, method, params }));
});

ws.on('message', (raw) => {
  let msg;
  try { msg = JSON.parse(raw.toString()); } catch { return; }
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
  }
});

await new Promise((resolve, reject) => {
  ws.once('open', resolve);
  ws.once('error', reject);
});

await send('Page.enable');
await new Promise((r) => setTimeout(r, 3000)); // 给页面一点渲染时间
const isJpeg = /\.jpe?g$/i.test(OUT);
const shot = await send('Page.captureScreenshot', isJpeg
  ? { format: 'jpeg', quality: 85, captureBeyondViewport: false }
  : { format: 'png', captureBeyondViewport: false });
fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
console.log(`已保存截图: ${OUT} (${fs.statSync(OUT).size} bytes)`);
ws.close();
process.exit(0);
