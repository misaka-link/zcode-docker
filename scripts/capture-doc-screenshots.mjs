#!/usr/bin/env node
/**
 * capture-doc-screenshots.mjs — 用无头 Chromium + CDP 抓取文档用截图
 * ------------------------------------------------------------------
 * 复用与容器内相同的方式（CDP Network.setCookie + Page.captureScreenshot），
 * 抓取：登录页、控制台、Web 工作区。
 *
 * 用法：node scripts/capture-doc-screenshots.mjs <baseUrl> <authToken> [outDir]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';

const BASE = (process.argv[2] || 'http://127.0.0.1:3085').replace(/\/$/, '');
const TOKEN = process.argv[3] || '';
const OUT_DIR = process.argv[4] || path.resolve('doc');
const CDP_PORT = Number(process.env.DOC_CDP_PORT) || 9333;
const PROFILE = path.resolve('.build', 'doc-shot-profile');

const require = createRequire('/opt/zcode/');
let WebSocket;
try { WebSocket = require('ws'); } catch { WebSocket = require('/opt/zcode/node_modules/ws'); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.rmSync(PROFILE, { recursive: true, force: true });

const chrome = spawn('chromium', [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
  '--window-size=1440,900', `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${PROFILE}`, 'about:blank',
], { stdio: 'ignore' });

const getJson = (p) => new Promise((resolve, reject) => {
  const req = http.get({ host: '127.0.0.1', port: CDP_PORT, path: p, timeout: 5000 }, (res) => {
    let d = '';
    res.on('data', (c) => { d += c; });
    res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
  });
  req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  req.on('error', reject);
});

// 等待 CDP 就绪
let targets = null;
for (let i = 0; i < 60; i += 1) {
  try { targets = await getJson('/json/list'); break; } catch { await sleep(500); }
}
if (!targets) { console.error('CDP 未就绪'); process.exit(1); }
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 512 * 1024 * 1024 });
let id = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const mid = ++id;
  pending.set(mid, { resolve, reject });
  ws.send(JSON.stringify({ id: mid, method, params }));
});
ws.on('message', (raw) => {
  let m; try { m = JSON.parse(raw.toString()); } catch { return; }
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) reject(new Error(JSON.stringify(m.error))); else resolve(m.result);
  }
});
await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
await send('Page.enable');
await send('Network.enable');

// 取会话 Cookie
let cookieHeader = null;
if (TOKEN) {
  const res = await fetch(`${BASE}/__auth/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: TOKEN }),
  });
  const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean);
  cookieHeader = raw.map((c) => c.split(';')[0]).join('; ');
  console.log(`登录: HTTP ${res.status}  cookie: ${cookieHeader ? '已获取' : '无'}`);
  const m = /zcode_auth_session=([^;]+)/.exec(cookieHeader || '');
  if (m) {
    await send('Network.setCookie', { name: 'zcode_auth_session', value: m[1], domain: '127.0.0.1', path: '/' });
  }
}

async function shoot(url, file, { waitMs = 4000, fullPage = false } = {}) {
  await send('Page.navigate', { url });
  await sleep(waitMs);
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: fullPage });
  const out = path.join(OUT_DIR, file);
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log(`  → ${out} (${fs.statSync(out).size} bytes)`);
}

await shoot(`${BASE}/login`, '01-login.png', { waitMs: 2500 });
await shoot(`${BASE}/admin/`, '02-admin-console.png', { waitMs: 6000 });
await shoot(`${BASE}/`, '03-zcode-web.png', { waitMs: 8000 });

ws.close();
chrome.kill('SIGKILL');
console.log('完成');
process.exit(0);
