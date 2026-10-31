'use strict';
/**
 * main.js — 教室端主进程（v0.2）
 * 职责：
 *  1. 启动内置 HTTP 服务（发布面板 + API，自动生成连接码）
 *  2. 全屏置顶隐藏窗口：收到发布即弹大屏
 *  3. 角落小窗常驻显示「连接码」+ 托盘可重新显示
 *  4. 开机自启、防学生退出（Ctrl+Shift+Q + 密码）
 */
const { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

const CONFIG = require('./config.json');

// 打包后把数据目录放到用户数据目录（asar 内只读）；必须在加载服务端前设置
process.env.CB_DATA_DIR = path.join(app.getPath('userData'), 'data');
const { createClassroomServer } = require('./src/server');

let displayWin = null;
let cornerWin = null;
let tray = null;
let quitRequested = false;
let pendingNotice = null;
let pendingRollCall = null;
let displayReady = false;

const bundle = createClassroomServer({
  onDisplay: (rec) => showNotice(rec),
  onRollCall: (gender) => {
    if (displayWin && !displayWin.isDestroyed() && displayReady) {
      displayWin.webContents.send('roll-call-start', { gender });
    }
  }
});
const { store, config, getCode, lanIPv4 } = bundle;

// ---------- 全屏置顶弹窗 ----------
function createDisplayWindow() {
  const { width, height } = screen.getPrimaryDisplay().bounds;
  displayWin = new BrowserWindow({
    width,
    height,
    x: 0,
    y: 0,
    frame: false,
    fullscreen: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    show: false,
    backgroundColor: '#0b0e17',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  displayWin.setAlwaysOnTop(true, 'screen-saver');
  displayWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  displayWin.on('close', (e) => {
    if (!quitRequested) {
      e.preventDefault();
      displayWin.hide();
    }
  });
  displayWin.webContents.on('did-finish-load', () => {
    displayReady = true;
    if (pendingNotice) {
      const p = pendingNotice;
      pendingNotice = null;
      pushNotice(p);
    }
    if (pendingRollCall) {
      const g = pendingRollCall;
      pendingRollCall = null;
      rollCallStart(g);
    }
  });
  displayWin.loadFile('window.html');
}

/** 随机点名（托盘入口）：显示大屏并触发点名动画 */
function rollCallStart(gender) {
  if (!displayWin || displayWin.isDestroyed()) return;
  if (!displayReady) {
    pendingRollCall = gender;
    return;
  }
  displayWin.setFullScreen(true);
  displayWin.webContents.send('roll-call-start', { gender });
  displayWin.show();
  displayWin.focus();
}

function showNotice(rec) {
  if (!displayWin || displayWin.isDestroyed()) return;
  const payload = {
    id: rec.id,
    level: rec.level,
    title: rec.title,
    body: rec.body,
    sound: rec.sound,
    ttsText: rec.ttsText,
    ttsLoop: rec.ttsLoop,
    senderName: (store.getSenders()[rec.senderIp] || '').trim() || null,
    displaySeconds: rec.displaySeconds == null ? null : Number(rec.displaySeconds),
    autoCloseSeconds: config.normalSeconds || 20,
    urgentSound: !!config.urgentSound
  };
  if (!displayReady) {
    pendingNotice = payload;
    return;
  }
  pushNotice(payload);
}

function pushNotice(payload) {
  // 全屏置顶窗口在 Windows 上先置全屏再显示，隐藏时先退全屏再 hide（保证 hide 可靠生效）
  displayWin.setFullScreen(true);
  displayWin.webContents.send('announcement', payload);
  displayWin.show();
  displayWin.focus();
}

// ---------- 角落连接码小窗 ----------
function createCornerWindow() {
  const wa = screen.getPrimaryDisplay().workArea;
  cornerWin = new BrowserWindow({
    width: 430,
    height: 168,
    x: wa.x + wa.width - 450,
    y: wa.y + 16,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: true,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  cornerWin.setAlwaysOnTop(true, 'screen-saver');
  cornerWin.loadFile('corner.html', { query: { port: String(config.port) } });
}

// ---------- 托盘 ----------
function createTray() {
  // 纯代码生成 16x16 图标，避免依赖图片资源
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    buf[i * 4] = 255;     // R
    buf[i * 4 + 1] = 140; // G
    buf[i * 4 + 2] = 0;   // B
    buf[i * 4 + 3] = 255; // A
  }
  const icon = nativeImage.createFromBitmap(buf, { width: size, height: size });
  tray = new Tray(icon);
  tray.setToolTip('Class Buddy 教室端 · ' + getCode());
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示连接码', click: () => { if (cornerWin && !cornerWin.isDestroyed()) cornerWin.show(); } },
    { label: '重置连接码', click: () => {
        const newToken = store.genToken(4);
        store.setToken(newToken);
        writeCodeFile();
        tray.setToolTip('Class Buddy 教室端 · ' + getCode());
      } },
    { type: 'separator' },
    { label: '随机点名', submenu: [
        { label: '全部同学', click: () => rollCallStart('all') },
        { label: '男生', click: () => rollCallStart('male') },
        { label: '女生', click: () => rollCallStart('female') }
      ] },
    { type: 'separator' },
    { label: '退出', click: () => { quitRequested = true; app.quit(); } }
  ]));
}

function writeCodeFile() {
  try {
    const file = path.join(app.getPath('userData'), '连接码.txt');
    const content =
      'Class Buddy 教室端 · 连接码\n' +
      '=====================================\n' +
      '连接码：' + getCode() + '\n' +
      '使用：办公室电脑浏览器打开 http://' + getCode().split('-')[0] + ' ，输入连接码即可发布\n' +
      '（IP 变化时以屏幕右下角显示为准）\n';
    fs.writeFileSync(file, content, 'utf8');
    console.log('[code] 连接码已写入: ' + file);
  } catch (e) {
    console.error('[code] 写入连接码文件失败:', e.message);
  }
}

// ---------- IPC ----------
ipcMain.handle('get-info', () => ({
  roomId: store.getRoomId(),
  code: getCode(),
  port: config.port,
  ips: lanIPv4()
}));

ipcMain.on('hide-corner', () => {
  if (cornerWin && !cornerWin.isDestroyed()) cornerWin.hide();
});

ipcMain.on('hide-display', () => {
  if (displayWin && !displayWin.isDestroyed()) {
    displayWin.setFullScreen(false);
    displayWin.hide();
  }
});

ipcMain.handle('exit', () => {
  quitRequested = true;
  setTimeout(() => app.quit(), 100);
  return true;
});

ipcMain.handle('roll-call', () => {
  // 随机点名：名单由主进程取（含鉴权），页面只收匿名化姓名
  return store.getStudents().map((s) => ({ name: s.name, gender: s.gender }));
});

// ---------- 单实例 ----------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (cornerWin && !cornerWin.isDestroyed()) cornerWin.show();
  });
}

// ---------- 启动 ----------
app.whenReady().then(async () => {
  try {
    const port = await bundle.start();
    console.log('[server] 服务已启动，端口 ' + port + '，连接码 ' + getCode());
  } catch (e) {
    console.error('[server] 启动失败（端口 ' + config.port + ' 可能被占用）:', e.message);
    app.quit();
    return;
  }
  createDisplayWindow();
  if (config.showCorner) createCornerWindow();
  createTray();
  writeCodeFile();

  if (config.autoStart && process.platform === 'win32') {
    try {
      app.setLoginItemSettings({ openAtLogin: true, path: process.execPath });
    } catch (e) {
      console.error('[autostart] 设置开机自启失败:', e.message);
    }
  }
});

app.on('window-all-closed', () => {
  // 常驻，不退出
});
