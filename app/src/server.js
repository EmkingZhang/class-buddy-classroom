'use strict';
/**
 * server.js — 教室端 HTTP 服务（含 GitHub 检查更新 / 逐文件下载更新）
 * 依赖 http.js 的 handle() 组装路由；config.json 配置端口等。
 */
const http = require('http');
const https = require('https');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { store, config, lanIPv4, genCode } = require('./store');
const { handle } = require('./http');
const pkg = require('../package.json');

// ---------- GitHub 更新源（逐文件下载；公网 raw 直链） ----------
const UPDATE_OWNER = 'EmkingZhang';
const UPDATE_REPO = 'class-buddy-classroom';
const UPDATE_BRANCH = 'main';
const UPDATE_RAW = 'https://raw.githubusercontent.com/' + UPDATE_OWNER + '/' + UPDATE_REPO + '/' + UPDATE_BRANCH;
// 需要跟随更新的文件（相对仓库 app/ 目录；不含第三方库 vendor/xlsx.full.min.js）
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

/** HTTPS GET（跟随重定向，最多 4 跳；20s 超时；UA 标识） */
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const doGet = (u, hops) => {
      const req = https.get(u, {
        headers: { 'User-Agent': 'class-buddy-updater/1.0' },
        timeout: 20000
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops < 4) {
          res.resume();
          doGet(new URL(res.headers.location, u).href, hops + 1);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error('HTTP ' + res.statusCode));
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      });
      req.on('timeout', () => req.destroy(new Error('请求超时')));
      req.on('error', reject);
    };
    doGet(url, 0);
  });
}

/** 版本号比较：1.0.27 > 1.0.9；非法版本按 0 处理 */
function cmpVersion(a, b) {
  const pa = String(a || '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '').split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

/** 检查是否有新版本：GET {raw}/VERSION 对比当前 pkg.version */
function checkUpdateInfo() {
  return httpsGet(UPDATE_RAW + '/VERSION')
    .then((buf) => {
      const latest = String(buf).trim();
      if (!latest) return { ok: false, error: '远程版本为空' };
      const hasUpdate = cmpVersion(latest, pkg.version) > 0;
      return { ok: true, hasUpdate, current: pkg.version, latest };
    })
    .catch((e) => ({ ok: false, error: '无法访问更新源：' + e.message }));
}

/**
 * 领取更新：检查 → 逐文件下载到 update\staging → 生成 update\update.bat
 * 说明：Electron 运行时主程序/资源被占用，不能自替换；
 * 下载完成后提示用户「完全退出托盘 → 双击 update\update.bat」，
 * bat 负责 taskkill → 覆盖替换 → 重启。
 */
function doUpdate() {
  return checkUpdateInfo().then((info) => {
    if (!info.ok) return info;
    if (!info.hasUpdate) return info;
    const baseDir = path.dirname(process.execPath); // win-unpacked 目录
    const exe = path.basename(process.execPath);
    const staging = path.join(baseDir, 'update', 'staging');
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
    const seq = [];
    for (const rel of UPDATE_FILES) {
      seq.push(
        httpsGet(UPDATE_RAW + '/app/' + rel).then((buf) => {
          const target = path.join(staging, rel);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, buf);
        })
      );
    }
    return Promise.all(seq).then(() => {
      const batPath = path.join(baseDir, 'update', 'update.bat');
      const appDir = path.join(baseDir, 'resources', 'app');
      const lines = [
        '@echo off',
        'chcp 65001 >nul',
        'echo Class Buddy 更新中，请稍候…',
        'taskkill /f /im ' + exe + ' >nul 2>&1',
        'timeout /t 2 /nobreak >nul',
        'xcopy "' + staging + '" "' + appDir + '" /E /Y /I /Q',
        'start "" "' + process.execPath + '"',
        'exit'
      ];
      fs.writeFileSync(batPath, lines.join('\r\n'), 'utf8');
      return { ok: true, hasUpdate: true, current: pkg.version, latest: info.latest, downloaded: UPDATE_FILES.length, batPath };
    }).catch((e) => ({ ok: false, error: '下载更新失败：' + e.message }));
  });
}

// ---------- 服务 ----------
let server = null;
let listeners = {};

function createClassroomServer(opts) {
  opts = opts || {};
  listeners = {
    onDisplay: opts.onDisplay || (() => {}),
    onRollCall: opts.onRollCall || (() => {})
  };

  const bundle = {
    store,
    config,
    getCode: () => genCode(),
    lanIPv4,
    start: () => startServer(),
    stop: () => stopServer(),
    onUpdateCheck: () => checkUpdateInfo(),
    onUpdate: () => doUpdate()
  };

  return bundle;
}

function startServer() {
  return new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      try {
        handle(req, res, listeners, { store, config, genCode });
      } catch (e) {
        try {
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: String(e && e.message || e) }));
        } catch (e2) { /* 忽略 */ }
      }
    });
    server.on('error', (e) => reject(e));
    server.listen(config.port, '0.0.0.0', () => resolve(config.port));
  });
}

function stopServer() {
  return new Promise((resolve) => {
    if (!server) return resolve();
    server.close(() => resolve());
    server = null;
  });
}

module.exports = { createClassroomServer, checkUpdateInfo, doUpdate, cmpVersion, httpsGet };
