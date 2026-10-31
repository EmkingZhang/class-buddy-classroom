'use strict';
/**
 * http.js — 静态页面（发布面板）+ REST API（v0.2，无 WebSocket、无 target 概念）
 * 教室端就是服务端：办公室浏览器直接访问本服务完成发布。
 */
const fs = require('fs');
const path = require('path');
const url = require('url');
const pkg = require('../package.json');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon'
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let tooBig = false;
    req.on('data', (c) => {
      if (!tooBig) {
        body += c;
        if (body.length > 15 * 1024 * 1024) tooBig = true; // 15MB：背景图 base64 需要大请求体
      }
    });
    req.on('end', () => {
      if (tooBig) {
        const e = new Error('body too large');
        e.status = 413;
        reject(e);
      } else {
        resolve(body);
      }
    });
    req.on('error', reject);
  });
}

function json(res, code, obj) {
  const payload = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload)
  });
  res.end(payload);
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Token');
}

function isAuthed(req, store) {
  const u = url.parse(req.url, true);
  const token = req.headers['x-token'] || u.query.token;
  return !!token && token === store.getToken();
}

/** 请求来源 IP（IPv4 直连 / 经 IPv6 映射） */
function clientIpOf(req) {
  return String((req.socket && req.socket.remoteAddress) || '127.0.0.1').replace(/^::ffff:/, '');
}

function serveStatic(req, res, pathname, publicDir) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const resolved = path.resolve(publicDir, rel);
  if (resolved !== publicDir && !resolved.startsWith(publicDir + path.sep)) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  fs.readFile(resolved, (err, buf) => {
    if (err) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    const ext = path.extname(resolved).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(buf);
  });
}

/**
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {object} ctx { store, schedule, publish, getCode }
 */
async function handle(req, res, ctx) {
  cors(res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  const { store, schedule, publish, getCode } = ctx;
  const publicDir = ctx.publicDir || path.join(__dirname, '..', 'public');
  const u = url.parse(req.url, true);
  let pathname;
  try {
    pathname = decodeURIComponent(u.pathname);
  } catch (e) {
    pathname = u.pathname;
  }

  // ---- 静态页面 ----
  if (!pathname.startsWith('/api/')) return serveStatic(req, res, pathname, publicDir);

  // ---- GET /api/status ----
  if (pathname === '/api/status' && req.method === 'GET') {
    const inClass = schedule.inClassTime(new Date(), store.getSchedule());
    return json(res, 200, {
      roomId: store.getRoomId(),
      version: pkg.version,
      inClass,
      schedule: store.getSchedule(),
      code: getCode(),
      clientIp: clientIpOf(req),
      senders: store.getSenders(),
      classrooms: store.getClassrooms(),
      now: new Date().toISOString()
    });
  }

  // ---- GET /api/records ----
  if (pathname === '/api/records' && req.method === 'GET') {
    const limit = Math.min(Number(u.query.limit) || 50, 500);
    return json(res, 200, { records: store.listAnnouncements(limit) });
  }

  // ---- POST /api/records/delete（删除单条发送记录） ----
  if (pathname === '/api/records/delete' && req.method === 'POST') {
    if (!isAuthed(req, store)) return json(res, 401, { error: 'unauthorized' });
    let body = {};
    try { body = JSON.parse((await readBody(req)) || '{}'); } catch (e) {
      return json(res, 400, { error: 'invalid json' });
    }
    const id = String(body.id || '').trim();
    if (!id) return json(res, 400, { error: 'id required' });
    return json(res, 200, { ok: store.deleteAnnouncement(id), id });
  }

  // ---- POST /api/records/clear（清空发送记录） ----
  if (pathname === '/api/records/clear' && req.method === 'POST') {
    if (!isAuthed(req, store)) return json(res, 401, { error: 'unauthorized' });
    const count = store.clearAnnouncements();
    return json(res, 200, { ok: true, cleared: count });
  }

  // ---- POST /api/verify-token ----
  if (pathname === '/api/verify-token' && req.method === 'POST') {
    let body = {};
    try { body = JSON.parse((await readBody(req)) || '{}'); } catch (e) { /* ignore */ }
    return json(res, 200, { ok: !!body.token && body.token === store.getToken() });
  }

  // ---- POST /api/publish ----
  if (pathname === '/api/publish' && req.method === 'POST') {
    if (!isAuthed(req, store)) return json(res, 401, { error: 'unauthorized' });
    let body = {};
    try { body = JSON.parse((await readBody(req)) || '{}'); } catch (e) {
      return json(res, 400, { error: 'invalid json' });
    }
    const { level, title, body: text, expireAt, sendAt, sound, ttsText, ttsLoop, displaySeconds, classroomIp } = body;
    if (level !== 'normal' && level !== 'urgent') return json(res, 400, { error: 'invalid level' });
    if (!title || !String(title).trim()) return json(res, 400, { error: 'title required' });
    if (String(title).trim().length > 50) return json(res, 400, { error: 'title too long (<=50)' });
    if (String(text || '').trim().length > 500) return json(res, 400, { error: 'body too long (<=500)' });
    const SOUNDS = ['none', 'dingdong', 'bell', 'alarm', 'tts'];
    if (sound && !SOUNDS.includes(sound)) return json(res, 400, { error: 'invalid sound' });
    if (String(ttsText || '').trim().length > 200) return json(res, 400, { error: 'ttsText too long (<=200)' });
    const loop = ttsLoop === undefined ? 0 : Number(ttsLoop);
    if (!Number.isInteger(loop) || loop < 0 || loop > 10) return json(res, 400, { error: 'ttsLoop must be 0-10' });
    const dsec = displaySeconds === undefined ? null : Number(displaySeconds);
    if (dsec !== null && (!Number.isInteger(dsec) || dsec < 0 || dsec > 3600)) {
      return json(res, 400, { error: 'displaySeconds must be 0-3600 (0=不限时)' });
    }
    return json(res, 200, publish({
      level,
      title: String(title).trim(),
      body: String(text || '').trim(),
      expireAt: expireAt || null,
      sendAt: sendAt || null,
      // 未显式指定声音时：普通无声、紧急默认警报（兼容旧行为）
      sound: sound || (level === 'urgent' ? 'alarm' : 'none'),
      ttsText: String(ttsText || '').trim() || null,
      ttsLoop: loop,
      displaySeconds: dsec,
      senderIp: clientIpOf(req),
      classroomIp: String(classroomIp || '').trim() || null
    }));
  }

  // ---- POST /api/sender（昵称绑定 IP，昵称可留空=不绑定） ----
  if (pathname === '/api/sender' && req.method === 'POST') {
    if (!isAuthed(req, store)) return json(res, 401, { error: 'unauthorized' });
    let body = {};
    try { body = JSON.parse((await readBody(req)) || '{}'); } catch (e) {
      return json(res, 400, { error: 'invalid json' });
    }
    const ip = String(body.ip || '').trim();
    const nickname = String(body.nickname || '').trim();
    if (!ip) return json(res, 400, { error: 'ip required' });
    if (nickname.length > 20) return json(res, 400, { error: 'nickname too long (<=20)' });
    return json(res, 200, { ok: true, senders: store.setSender(ip, nickname) });
  }

  // ---- POST /api/classroom（班级名绑定被控端 IP，留空=解除） ----
  if (pathname === '/api/classroom' && req.method === 'POST') {
    if (!isAuthed(req, store)) return json(res, 401, { error: 'unauthorized' });
    let body = {};
    try { body = JSON.parse((await readBody(req)) || '{}'); } catch (e) {
      return json(res, 400, { error: 'invalid json' });
    }
    const ip = String(body.ip || '').trim();
    const name = String(body.name || '').trim();
    if (!ip) return json(res, 400, { error: 'ip required' });
    if (name.length > 20) return json(res, 400, { error: 'class name too long (<=20)' });
    return json(res, 200, { ok: true, classrooms: store.setClassroom(ip, name) });
  }

  // ---- GET /api/students / POST /api/students（班级名单，覆盖导入） ----
  if (pathname === '/api/students' && req.method === 'GET') {
    if (!isAuthed(req, store)) return json(res, 401, { error: 'unauthorized' });
    return json(res, 200, { students: store.getStudents() });
  }
  if (pathname === '/api/students' && req.method === 'POST') {
    if (!isAuthed(req, store)) return json(res, 401, { error: 'unauthorized' });
    let body = {};
    try { body = JSON.parse((await readBody(req)) || '{}'); } catch (e) {
      return json(res, 400, { error: 'invalid json' });
    }
    const list = Array.isArray(body.students) ? body.students : null;
    if (!list) return json(res, 400, { error: 'students array required' });
    if (list.length > 2000) return json(res, 400, { error: 'too many students (<=2000)' });
    const mode = body.mode === 'append' ? 'append' : 'overwrite';
    const cleaned = [];
    for (const s of list) {
      const no = String((s && s.no) || '').trim();
      const name = String((s && s.name) || '').trim();
      const gender = String((s && s.gender) || '').trim();
      if (!no && !name) continue;
      if (String(name).length > 20) return json(res, 400, { error: 'student name too long' });
      if (gender && gender !== 'male' && gender !== 'female') return json(res, 400, { error: 'gender must be male/female' });
      cleaned.push({ no: no.slice(0, 20), name: name.slice(0, 20), gender: gender || 'male' });
    }
    return json(res, 200, { ok: true, count: store.setStudents(cleaned, mode) });
  }

  // ---- POST /api/background（更换背景图：panel=发布面板 / display=大屏弹窗） ----
  if (pathname === '/api/background' && req.method === 'POST') {
    if (!isAuthed(req, store)) return json(res, 401, { error: 'unauthorized' });
    let body = {};
    try { body = JSON.parse((await readBody(req)) || '{}'); } catch (e) {
      return json(res, 400, { error: 'invalid json' });
    }
    const target = body.target === 'display' ? 'display' : 'panel';
    const data = String(body.data || '');
    if (!data) return json(res, 400, { error: 'image data required' });
    const buf = Buffer.from(data, 'base64');
    if (buf.length === 0) return json(res, 400, { error: 'empty image' });
    if (buf.length > 5 * 1024 * 1024) return json(res, 400, { error: 'image too large (<=5MB)' });
    const isJpeg = buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
    const isPng = buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
    if (!isJpeg && !isPng) return json(res, 400, { error: 'only jpg/png allowed' });
    try {
      fs.mkdirSync(publicDir, { recursive: true });
      fs.writeFileSync(path.join(publicDir, 'bg-' + target + '.jpg'), buf);
      return json(res, 200, { ok: true, target, bytes: buf.length });
    } catch (e) {
      return json(res, 500, { error: 'write failed: ' + (e.message || e) });
    }
  }

  // ---- POST /api/rollcall（控制端发起随机点名：all/male/female） ----
  if (pathname === '/api/rollcall' && req.method === 'POST') {
    if (!isAuthed(req, store)) return json(res, 401, { error: 'unauthorized' });
    let body = {};
    try { body = JSON.parse((await readBody(req)) || '{}'); } catch (e) {
      return json(res, 400, { error: 'invalid json' });
    }
    const gender = String(body.gender || 'all');
    if (!['all', 'male', 'female'].includes(gender)) return json(res, 400, { error: 'invalid gender' });
    try { ctx.onRollCall(gender); } catch (e) { /* 回调异常不影响响应 */ }
    return json(res, 200, { ok: true, gender });
  }

  // ---- GET/POST/DELETE /api/schedule ----
  if (pathname === '/api/schedule' && req.method === 'GET') {
    return json(res, 200, { schedule: store.getSchedule() });
  }
  if (pathname === '/api/schedule' && req.method === 'POST') {
    if (!isAuthed(req, store)) return json(res, 401, { error: 'unauthorized' });
    let body = {};
    try { body = JSON.parse((await readBody(req)) || '{}'); } catch (e) {
      return json(res, 400, { error: 'invalid json' });
    }
    const weekday = Number(body.weekday);
    const start = String(body.start || '');
    const end = String(body.end || '');
    if (!weekday || weekday < 1 || weekday > 7) return json(res, 400, { error: 'weekday 1-7' });
    if (!/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(end)) {
      return json(res, 400, { error: 'time format HH:mm' });
    }
    if (start >= end) return json(res, 400, { error: 'start must < end' });
    return json(res, 200, { schedule: store.upsertSchedule({ id: body.id, weekday, start, end }) });
  }
  if (pathname === '/api/schedule' && req.method === 'DELETE') {
    if (!isAuthed(req, store)) return json(res, 401, { error: 'unauthorized' });
    if (!u.query.id) return json(res, 400, { error: 'id required' });
    return json(res, 200, { schedule: store.deleteSchedule(u.query.id) });
  }

  // ---- POST /api/update（检查/领取更新：GitHub 仓库 VERSION + update 包） ----
  if (pathname === '/api/update' && req.method === 'POST') {
    if (!isAuthed(req, store)) return json(res, 401, { error: 'unauthorized' });
    let body = {};
    try { body = JSON.parse((await readBody(req)) || '{}'); } catch (e) { /* ignore */ }
    try {
      const r = body.action === 'check'
        ? await ctx.onUpdateCheck()
        : await ctx.onUpdate();
      return json(res, 200, r);
    } catch (e) {
      return json(res, 200, { ok: false, error: String((e && e.message) || e) });
    }
  }

  // ---- POST /api/settings（重置 Token，返回新连接码） ----
  if (pathname === '/api/settings' && req.method === 'POST') {
    if (!isAuthed(req, store)) return json(res, 401, { error: 'unauthorized' });
    let body = {};
    try { body = JSON.parse((await readBody(req)) || '{}'); } catch (e) {
      return json(res, 400, { error: 'invalid json' });
    }
    const t = String(body.token || '');
    if (t.length < 4) return json(res, 400, { error: 'token too short (>=4)' });
    store.setToken(t);
    return json(res, 200, { ok: true, code: getCode() });
  }

  return json(res, 404, { error: 'not found' });
}

module.exports = { handle };
