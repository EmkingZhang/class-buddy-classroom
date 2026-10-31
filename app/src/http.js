'use strict';
/**
 * http.js — 教室端 HTTP 路由与 API（无鉴权：GET /api/status、/api/records；
 * 需鉴权：/api/publish、/api/settings、/api/students、/api/background、/api/update 等）
 */
const fs = require('fs');
const path = require('path');
const { store, config, genCode } = require('./store');
const pkg = require('../package.json');

const ROOT = path.join(__dirname, '..');

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 8 * 1024 * 1024) { req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

function isAuthed(req) {
  const u = new URL(req.url, 'http://x');
  const tk = req.headers['x-token'] || u.searchParams.get('token') || '';
  return tk && tk === store.getToken();
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png'
};

function serveFile(req, res, rel) {
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT)) { json(res, 403, { ok: false, error: 'forbidden' }); return; }
  fs.readFile(file, (err, data) => {
    if (err) { json(res, 404, { ok: false, error: 'not found' }); return; }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': data.length
    });
    res.end(data);
  });
}

/** 判断当前是否在课时中（上课时间提醒，不做硬限制） */
function inClassNow() {
  const s = require('./schedule');
  return s.inClassNow();
}

function handle(req, res, listeners, deps) {
  const ctx = Object.assign({
    store, config, genCode,
    onDisplay: listeners.onDisplay,
    onRollCall: listeners.onRollCall,
    onUpdateCheck: deps.onUpdateCheck || (() => Promise.resolve({ ok: false, error: 'not supported' })),
    onUpdate: deps.onUpdate || (() => Promise.resolve({ ok: false, error: 'not supported' }))
  }, deps || {});
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  // ---------- 静态文件（发布面板等） ----------
  if (req.method === 'GET' && (p === '/' || p === '/index.html')) { serveFile(req, res, 'public/index.html'); return; }
  if (req.method === 'GET' && p === '/app.js') { serveFile(req, res, 'public/app.js'); return; }
  if (req.method === 'GET' && p === '/style.css') { serveFile(req, res, 'public/style.css'); return; }
  if (req.method === 'GET' && p === '/settings.html') { serveFile(req, res, 'public/settings.html'); return; }
  if (req.method === 'GET' && p === '/settings.js') { serveFile(req, res, 'public/settings.js'); return; }
  if (req.method === 'GET' && p === '/vendor/xlsx.full.min.js') { serveFile(req, res, 'public/vendor/xlsx.full.min.js'); return; }
  if (req.method === 'GET' && p === '/bg-display.jpg') { serveFile(req, res, 'public/bg-display.jpg'); return; }
  if (req.method === 'GET' && p === '/window.html') { serveFile(req, res, 'window.html'); return; }
  if (req.method === 'GET' && p === '/corner.html') { serveFile(req, res, 'corner.html'); return; }

  // ---------- 免鉴权 ----------
  if (req.method === 'GET' && p === '/api/status') {
    json(res, 200, {
      ok: true,
      version: pkg.version,
      roomId: store.getRoomId(),
      inClass: inClassNow(),
      schedule: store.getSchedule(),
      code: genCode(),
      clientIp: req.socket.remoteAddress ? String(req.socket.remoteAddress).replace(/^::ffff:/, '') : '',
      senders: store.getSenders(),
      classrooms: store.getClassrooms(),
      now: new Date().toISOString()
    });
    return;
  }

  if (req.method === 'POST' && p === '/api/verify-token') {
    return readBody(req).then((b) => {
      const ok = b.token === store.getToken();
      json(res, 200, { ok });
    });
  }

  if (req.method === 'GET' && p === '/api/records') {
    const limit = Math.min(1000, Math.max(1, parseInt(url.searchParams.get('limit') || '100', 10) || 100));
    json(res, 200, { ok: true, records: store.getRecords().slice(-limit).reverse() });
    return;
  }

  // ---------- 需鉴权 ----------
  if (!isAuthed(req)) { json(res, 401, { ok: false, error: 'unauthorized' }); return; }

  if (req.method === 'GET' && p === '/api/students') {
    json(res, 200, { ok: true, students: store.getStudents() });
    return;
  }

  if (req.method === 'POST' && p === '/api/students') {
    return readBody(req).then((b) => {
      const mode = b.mode === 'overwrite' ? 'overwrite' : 'append';
      store.saveStudents(b.students || [], mode);
      json(res, 200, { ok: true, students: store.getStudents() });
    });
  }

  if (req.method === 'POST' && p === '/api/publish') {
    return readBody(req).then((b) => {
      const title = String(b.title || '').trim().slice(0, 50);
      if (!title) { json(res, 400, { ok: false, error: '标题不能为空' }); return; }
      const body = String(b.body || '').trim().slice(0, 500);
      const sound = ['dingdong', 'bell', 'alarm', 'tts', 'none'].includes(b.sound) ? b.sound : 'none';
      const now = new Date();
      const rec = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        level: 'normal',
        title,
        body,
        sound,
        ttsText: String(b.ttsText || '').slice(0, 200) || null,
        ttsLoop: Number(b.ttsLoop) || 0,
        displaySeconds: b.displaySeconds == null || b.displaySeconds === '' ? null : Number(b.displaySeconds),
        sendAt: b.sendAt || null,
        senderIp: req.socket.remoteAddress ? String(req.socket.remoteAddress).replace(/^::ffff:/, '') : '',
        classroomIp: b.classroomIp || null,
        status: 'created',
        createdAt: now.toISOString(),
        displayAt: null
      };
      store.addRecord(rec);
      if (rec.sendAt) {
        const t = new Date(rec.sendAt).getTime() - now.getTime();
        if (t > 0) {
          rec.status = 'scheduled';
          setTimeout(() => {
            if (store.getRecords().find((r) => r.id === rec.id)) {
              rec.status = 'shown';
              rec.displayAt = new Date().toISOString();
              listeners.onDisplay(Object.assign({}, rec, { sound: sound === 'none' ? null : sound }));
            }
          }, Math.min(t, 24 * 3600 * 1000));
          json(res, 200, { ok: true, status: 'scheduled', id: rec.id });
          return;
        }
      }
      rec.status = 'shown';
      rec.displayAt = new Date().toISOString();
      listeners.onDisplay(Object.assign({}, rec, { sound: sound === 'none' ? null : sound }));
      json(res, 200, { ok: true, status: 'shown', id: rec.id });
    });
  }

  if (req.method === 'POST' && p === '/api/records/delete') {
    return readBody(req).then((b) => {
      store.removeRecord(b.id);
      json(res, 200, { ok: true });
    });
  }

  if (req.method === 'POST' && p === '/api/records/clear') {
    return readBody(req).then(() => {
      store.clearRecords();
      json(res, 200, { ok: true });
    });
  }

  if (req.method === 'POST' && p === '/api/sender') {
    return readBody(req).then((b) => {
      store.setSender(b.ip, b.nickname);
      json(res, 200, { ok: true, senders: store.getSenders() });
    });
  }

  if (req.method === 'POST' && p === '/api/classroom') {
    return readBody(req).then((b) => {
      store.setClassroom(b.ip, b.name);
      json(res, 200, { ok: true, classrooms: store.getClassrooms() });
    });
  }

  if (req.method === 'POST' && p === '/api/background') {
    return readBody(req).then((b) => {
      const target = b.target === 'display' ? 'display' : 'panel';
      const buf = Buffer.from(String(b.data || ''), 'base64');
      if (!buf.length) { json(res, 400, { ok: false, error: '图片为空' }); return; }
      if (buf.length > 5 * 1024 * 1024) { json(res, 400, { ok: false, error: '图片超过 5MB' }); return; }
      const file = path.join(ROOT, 'public', target === 'display' ? 'bg-display.jpg' : 'bg-panel.jpg');
      fs.writeFile(file, buf, (err) => {
        if (err) { json(res, 500, { ok: false, error: '写入失败' }); return; }
        json(res, 200, { ok: true, bytes: buf.length });
      });
    });
  }

  // ---------- 检查 / 领取更新（GitHub 仓库） ----------
  if (req.method === 'POST' && p === '/api/update') {
    return readBody(req).then((b) => {
      const action = b.action === 'update' ? 'update' : 'check';
      const fn = action === 'update' ? ctx.onUpdate : ctx.onUpdateCheck;
      Promise.resolve().then(() => fn()).then((r) => {
        json(res, 200, Object.assign({ ok: true }, r));
      }).catch((e) => {
        json(res, 200, { ok: false, error: String(e && e.message || e) });
      });
    });
  }

  if (req.method === 'POST' && p === '/api/settings') {
    return readBody(req).then((b) => {
      if (b.token) store.setToken(b.token);
      if (b.normalSeconds) config.normalSeconds = Number(b.normalSeconds);
      if (b.urgentSeconds != null) config.urgentSeconds = Number(b.urgentSeconds);
      if (b.autoStart != null) config.autoStart = !!b.autoStart;
      if (b.showCorner != null) config.showCorner = !!b.showCorner;
      if (b.schedule) store.setSchedule(b.schedule);
      store.saveConfig();
      json(res, 200, { ok: true, code: genCode() });
    });
  }

  json(res, 404, { ok: false, error: 'not found' });
}

module.exports = { handle };
