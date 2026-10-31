'use strict';
/**
 * server.js — 教室端 HTTP 服务（纯 Node 模块）
 * - Electron 主进程：require 本模块，传入 onDisplay 回调（弹大屏）
 * - 独立模式：node src/server.js（调试/测试，显示回调打印日志）
 * v0.2 起无 WebSocket：办公室发布面板 = 浏览器直连本服务的 HTTP API。
 */
const http = require('http');
const https = require('https');
const os = require('os');
const fs = require('fs');
const path = require('path');

const store = require('./store');
const schedule = require('./schedule');
const httpApi = require('./http');
const CONFIG = require('../config.json');
const pkg = require('../package.json');

// ---------- GitHub 更新源（源码仓库 + VERSION 版本号 + app/ 源码清单） ----------
const UPDATE_OWNER = 'EmkingZhang';
const UPDATE_REPO = 'class-buddy-classroom';
const UPDATE_BRANCH = 'main';
const UPDATE_RAW = 'https://raw.githubusercontent.com/' + UPDATE_OWNER + '/' + UPDATE_REPO + '/' + UPDATE_BRANCH;

/** 更新清单：resources\app 下需随版本更新的文件（相对路径） */
const UPDATE_FILES = [
  'package.json',
  'config.json',
  'main.js',
  'preload.js',
  'window.html',
  'corner.html',
  'public/index.html',
  'public/app.js',
  'public/style.css',
  'public/settings.html',
  'public/settings.js',
  'src/server.js',
  'src/store.js',
  'src/schedule.js',
  'src/http.js'
];

/** GET（跟随重定向），返回 Buffer */
function httpsGet(url, redirects) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'class-buddy-updater' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if ((redirects || 0) >= 4) return reject(new Error('重定向过多'));
        return resolve(httpsGet(res.headers.location, (redirects || 0) + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(new Error('请求超时')); });
  });
}

/** 版本比较：返回 a-b（1.0.26 vs 1.0.27 → -1） */
function cmpVersion(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

/** 检查 GitHub 最新版本 */
async function checkUpdateInfo() {
  try {
    const buf = await httpsGet(UPDATE_RAW + '/VERSION');
    const latest = buf.toString('utf8').trim();
    if (!latest) return { ok: false, error: '获取最新版本失败（VERSION 为空）' };
    return {
      ok: true,
      hasUpdate: cmpVersion(latest, pkg.version) > 0,
      current: pkg.version,
      latest
    };
  } catch (e) {
    return { ok: false, error: '连接 GitHub 失败：' + String((e && e.message) || e) };
  }
}

/** 领取更新：逐文件下载到程序目录旁 update\staging，并生成一键更新 update.bat（结束程序→替换→重启） */
async function doUpdate() {
  const info = await checkUpdateInfo();
  if (!info.ok) return info;
  if (!info.hasUpdate) return info; // 已是最新
  const baseDir = path.dirname(process.execPath); // Electron 下 = win-unpacked
  const upDir = path.join(baseDir, 'update');
  const staging = path.join(upDir, 'staging');
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  let downloaded = 0;
  for (const rel of UPDATE_FILES) {
    const buf = await httpsGet(UPDATE_RAW + '/app/' + rel);
    const dest = path.join(staging, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, buf);
    downloaded++;
  }
  const exe = path.basename(process.execPath);
  const batPath = path.join(upDir, 'update.bat');
  const bat = [
    '@echo off',
    'chcp 65001 >nul',
    'echo [Class Buddy] 正在结束教室端程序...',
    'taskkill /f /im ' + exe + ' >nul 2>&1',
    'timeout /t 2 /nobreak >nul',
    'echo [Class Buddy] 正在替换程序文件（v' + info.latest + '）...',
    'set "STG=%~dp0staging"',
    'set "APP=%~dp0..\\resources\\app"',
    'xcopy "%STG%" "%APP%" /E /Y /I /Q >nul',
    'echo [Class Buddy] 更新完成，正在启动...',
    'start "" "%~dp0..\\' + exe + '"',
    'exit'
  ].join('\r\n');
  fs.writeFileSync(batPath, bat, 'utf8');
  return {
    ok: true,
    hasUpdate: true,
    current: pkg.version,
    latest: info.latest,
    downloaded,
    batPath
  };
}

function lanIPv4() {
  const list = [];
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const ni of ifs[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal) list.push(ni.address);
    }
  }
  return list;
}

function createClassroomServer(options) {
  options = options || {};
  const config = Object.assign({}, CONFIG, options.config || {});
  store.load(config);
  const onDisplay = options.onDisplay || ((rec) => console.log('[display] ' + rec.id + ' ' + rec.level + ' ' + rec.title));
  const onRollCall = options.onRollCall || ((gender) => console.log('[rollcall] ' + gender));
  const onUpdate = options.onUpdate || doUpdate;
  const onUpdateCheck = options.onUpdateCheck || checkUpdateInfo;

  /** 连接码：IP:端口-TOKEN */
  function getCode() {
    const ips = lanIPv4();
    const ip = ips.find((x) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(x)) || ips[0] || '127.0.0.1';
    return ip + ':' + config.port + '-' + store.getToken();
  }

  function display(rec) {
    // 已过期的不展示
    if (rec.expireAt && Date.parse(rec.expireAt) <= Date.now()) {
      store.setStatus(rec.id, 'expired');
      return;
    }
    try {
      onDisplay(rec);
    } catch (e) {
      console.error('[display] 回调异常:', e && e.message);
    }
    store.setStatus(rec.id, 'shown', { shownAt: new Date().toISOString() });
  }

  /** 发布入口：先入库；定时未到则等定时，否则立即显示。返回完整记录（含 role 等字段） */
  function publish(input) {
    const rec = store.addAnnouncement({ ...input, status: 'created' });
    if (input.sendAt && Date.parse(input.sendAt) > Date.now() + 1000) {
      store.setStatus(rec.id, 'scheduled');
      return Object.assign({}, rec);
    }
    display(rec);
    return Object.assign({}, rec);
  }

  const server = http.createServer((req, res) => {
    httpApi.handle(req, res, { store, schedule, publish, getCode, onRollCall, onUpdate, onUpdateCheck, publicDir: options.publicDir }).catch((err) => {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: String((err && err.message) || err) }));
    });
  });

  // 定时发送 + 过期清理（每 1s）
  const timer = setInterval(() => {
    const now = Date.now();
    for (const a of store.listAnnouncements(200)) {
      if (a.status === 'scheduled' && a.sendAt && Date.parse(a.sendAt) <= now) {
        display(a);
      } else if (a.status === 'scheduled' && a.expireAt && Date.parse(a.expireAt) <= now) {
        store.setStatus(a.id, 'expired');
      }
    }
  }, 1000);

  return {
    server,
    store,
    config,
    getCode,
    lanIPv4,
    start: () => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.port, () => resolve(server.address().port));
    }),
    stop: () => {
      clearInterval(timer);
      return new Promise((resolve) => server.close(resolve));
    }
  };
}

// 独立模式（调试 / 测试）
if (require.main === module) {
  const inst = createClassroomServer();
  inst.start().then((port) => {
    console.log('==============================================');
    console.log('  Class Buddy 教室端（独立模式）已启动');
    console.log('  连接码      : ' + inst.getCode());
    console.log('  发布面板    : http://' + inst.lanIPv4()[0] + ':' + port + '  （办公室浏览器打开）');
    console.log('  本机面板    : http://localhost:' + port);
    console.log('==============================================');
  }).catch((e) => {
    console.error('启动失败:', e.message);
    process.exit(1);
  });
}

module.exports = { createClassroomServer, lanIPv4 };
