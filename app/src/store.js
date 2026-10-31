'use strict';
/**
 * store.js — JSON 文件持久化（v0.2）
 * 关键变化：Token 首次启动自动生成（4 位，存 data/config.json），无需手动配置。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// 打包后 __dirname 位于只读 asar 内，数据目录由主进程通过 CB_DATA_DIR 重定向到 userData
const DATA_DIR = process.env.CB_DATA_DIR || path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'store.json');
const MAX_RECORDS = 500;

let data = null;

function uid() {
  return 'N' + Date.now().toString(36).toUpperCase() + crypto.randomBytes(3).toString('hex').toUpperCase();
}

/** 生成连接码用 Token：4 位，去掉易混淆字符（0/O/1/I） */
function genToken(len) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < (len || 4); i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function defaultStore(config) {
  return {
    settings: { token: genToken(4), roomId: config.roomId || 'room-1' },
    schedule: (config.defaultSchedule || []).map((s) => ({ id: uid(), ...s })),
    announcements: []
  };
}

function load(config) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DATA_FILE)) {
    try {
      data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    } catch (e) {
      console.warn('[store] 数据文件损坏，已重建默认数据');
      data = null;
    }
  }
  if (!data || typeof data !== 'object') data = defaultStore(config);
  // 设置兜底：Token 自动生成（旧版本默认值 class-buddy 也视为未设置，重新生成）
  data.settings = Object.assign({}, data.settings);
  if (!data.settings.token || data.settings.token === 'class-buddy' || data.settings.token.length !== 4) {
    data.settings.token = genToken(4);
  }
  if (!data.settings.roomId) data.settings.roomId = config.roomId || 'room-1';
  data.schedule = Array.isArray(data.schedule)
    ? data.schedule.map((s) => (s && s.id ? s : { id: uid(), ...s }))
    : [];
  data.announcements = Array.isArray(data.announcements) ? data.announcements : [];
  data.senders = (data.senders && typeof data.senders === 'object') ? data.senders : {};
  data.classrooms = (data.classrooms && typeof data.classrooms === 'object') ? data.classrooms : {};
  data.students = Array.isArray(data.students) ? data.students : [];
  save();
  return data;
}

function save() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// ---- 设置 ----
function getToken() { return data.settings.token; }
function setToken(t) { data.settings.token = t; save(); return t; }
function getRoomId() { return data.settings.roomId; }

// ---- 上课时段 ----
function getSchedule() { return data.schedule.slice(); }

function upsertSchedule(item) {
  const row = {
    id: item.id || uid(),
    weekday: Number(item.weekday),
    start: String(item.start || '08:00'),
    end: String(item.end || '18:00')
  };
  const idx = data.schedule.findIndex((s) => s.id === row.id);
  if (idx >= 0) data.schedule[idx] = row;
  else data.schedule.push(row);
  data.schedule.sort((a, b) => a.weekday - b.weekday || a.start.localeCompare(b.start));
  save();
  return getSchedule();
}

function deleteSchedule(id) {
  data.schedule = data.schedule.filter((s) => s.id !== id);
  save();
  return getSchedule();
}

// ---- 通知 ----
function addAnnouncement(a) {
  const rec = {
    id: uid(),
    level: a.level === 'urgent' ? 'urgent' : 'normal',
    title: String(a.title || '').trim(),
    body: String(a.body || '').trim(),
    expireAt: a.expireAt || null,
    sendAt: a.sendAt || null,
    sound: a.sound || 'none',
    ttsText: a.ttsText || null,
    ttsLoop: a.ttsLoop == null ? 0 : Number(a.ttsLoop),
    role: (a.role && typeof a.role === 'object') ? a.role : null,
    senderIp: a.senderIp || null,
    classroomIp: a.classroomIp || null,
    displaySeconds: a.displaySeconds == null ? null : Number(a.displaySeconds),
    status: a.status || 'created',
    createdAt: new Date().toISOString(),
    shownAt: null
  };
  data.announcements.unshift(rec);
  if (data.announcements.length > MAX_RECORDS) data.announcements.length = MAX_RECORDS;
  save();
  return rec;
}

function listAnnouncements(limit) {
  return data.announcements.slice(0, limit || 50);
}

function findAnnouncement(id) {
  return data.announcements.find((a) => a.id === id);
}

function deleteAnnouncement(id) {
  const before = data.announcements.length;
  data.announcements = data.announcements.filter((a) => a.id !== id);
  const removed = before - data.announcements.length;
  if (removed > 0) save();
  return removed > 0;
}

function clearAnnouncements() {
  const count = data.announcements.length;
  data.announcements = [];
  if (count > 0) save();
  return count;
}

function setStatus(id, status, extra) {
  const a = findAnnouncement(id);
  if (!a) return null;
  a.status = status;
  if (extra) Object.assign(a, extra);
  save();
  return a;
}

// ---- 发送者昵称（IP 绑定昵称，留空 = 不绑定） ----
function getSenders() {
  return Object.assign({}, data.senders);
}

function setSender(ip, nickname) {
  data.senders[ip] = nickname || '';
  save();
  return getSenders();
}

// ---- 班级名（被控端 IP 绑定班级名，留空 = 解除） ----
function getClassrooms() {
  return Object.assign({}, data.classrooms);
}

function setClassroom(ip, name) {
  data.classrooms[ip] = name || '';
  save();
  return getClassrooms();
}

// ---- 学生名单（学号/姓名/性别，覆盖导入或追加；始终按学号排序） ----
function sortStudents(list) {
  return list.slice().sort((a, b) => String(a.no || '').localeCompare(String(b.no || ''), 'zh-Hans-CN', { numeric: true }));
}

function getStudents() {
  return sortStudents(data.students).map((s) => ({ no: s.no || '', name: s.name || '', gender: s.gender || 'male' }));
}

function setStudents(list, mode) {
  const clean = list.map((s) => ({ no: s.no || '', name: s.name || '', gender: s.gender || 'male' }));
  if (mode === 'append') {
    // 追加模式：按 学号（无学号按姓名）去重合并，已存在的条目被新导入覆盖
    const map = new Map(data.students.map((s) => [s.no || s.name, s]));
    for (const s of clean) map.set(s.no || s.name, s);
    data.students = Array.from(map.values());
  } else {
    data.students = clean;
  }
  data.students = sortStudents(data.students);
  save();
  return data.students.length;
}

module.exports = {
  load, save, uid, genToken,
  getToken, setToken, getRoomId,
  getSchedule, upsertSchedule, deleteSchedule,
  addAnnouncement, listAnnouncements, findAnnouncement, setStatus,
  deleteAnnouncement, clearAnnouncements,
  getSenders, setSender,
  getClassrooms, setClassroom,
  getStudents, setStudents
};
