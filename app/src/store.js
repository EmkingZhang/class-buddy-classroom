'use strict';
/**
 * store.js — 教室端数据存储（连接码 Token / 发送记录 / 班级名单 / 昵称 / 班级绑定 / 课时）
 * 数据目录：env CB_DATA_DIR 或 app 目录下 data（未设环境变量时）
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

let DATA_DIR = process.env.CB_DATA_DIR || path.join(__dirname, '..', 'data');
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) { /* 忽略 */ }

const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const RECORDS_FILE = path.join(DATA_DIR, 'records.json');
const STUDENTS_FILE = path.join(DATA_DIR, 'students.json');
const SENDERS_FILE = path.join(DATA_DIR, 'senders.json');
const CLASSROOMS_FILE = path.join(DATA_DIR, 'classrooms.json');
const SCHEDULE_FILE = path.join(DATA_DIR, 'schedule.json');

const DEFAULT_CONFIG = {
  port: 8787,
  roomId: 'room-1',
  normalSeconds: 20,
  urgentSeconds: 0,
  urgentSound: true,
  autoStart: true,
  showCorner: true,
  defaultSchedule: [
    { weekday: 1, start: '08:00', end: '12:00' },
    { weekday: 1, start: '14:00', end: '17:30' },
    { weekday: 2, start: '08:00', end: '12:00' },
    { weekday: 2, start: '14:00', end: '17:30' },
    { weekday: 3, start: '08:00', end: '12:00' },
    { weekday: 3, start: '14:00', end: '17:30' },
    { weekday: 4, start: '08:00', end: '12:00' },
    { weekday: 4, start: '14:00', end: '17:30' },
    { weekday: 5, start: '08:00', end: '12:00' },
    { weekday: 5, start: '14:00', end: '17:30' }
  ]
};

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return fallback;
  }
}

function writeJson(file, obj) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
  } catch (e) { /* 忽略 */ }
}

let config = readJson(CONFIG_FILE, {});
config = Object.assign({}, DEFAULT_CONFIG, config);

let token = '';
let records = readJson(RECORDS_FILE, []);
let students = readJson(STUDENTS_FILE, []);
let senders = readJson(SENDERS_FILE, {});
let classrooms = readJson(CLASSROOMS_FILE, {});
let schedule = readJson(SCHEDULE_FILE, []);
if (!schedule.length) schedule = config.defaultSchedule.slice();

// ---------- 工具 ----------
function lanIPv4() {
  const out = [];
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const ni of ifs[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

function genToken(len) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  const bytes = crypto.randomBytes(len || 4);
  for (let i = 0; i < (len || 4); i++) out += chars[bytes[i] % chars.length];
  return out;
}

function genCode() {
  const ips = lanIPv4();
  const ip = ips[0] || '127.0.0.1';
  return ip + ':' + config.port + '-' + token;
}

// ---------- 读写 ----------
function getRoomId() { return config.roomId; }
function setRoomId(id) { config.roomId = id; saveConfig(); }

function getToken() { return token; }
function setToken(t) {
  token = String(t || '').trim();
  if (token) saveConfig();
}

function saveConfig() {
  writeJson(CONFIG_FILE, config);
}

function getRecords() { return records; }
function addRecord(r) { records.push(r); writeJson(RECORDS_FILE, records); }
function removeRecord(id) { records = records.filter((r) => r.id !== id); writeJson(RECORDS_FILE, records); }
function clearRecords() { records = []; writeJson(RECORDS_FILE, records); }

function getStudents() {
  // 始终按学号排序（数字在前，字母按字典序）
  return students.slice().sort((a, b) => {
    const na = String(a.no || '');
    const nb = String(b.no || '');
    const xa = parseInt(na, 10);
    const xb = parseInt(nb, 10);
    if (!isNaN(xa) && !isNaN(xb)) return xa - xb;
    if (na < nb) return -1;
    if (na > nb) return 1;
    return 0;
  });
}

function saveStudents(list, mode) {
  if (mode === 'overwrite') {
    students = list.slice();
  } else {
    // 追加：学号重复自动覆盖
    const map = {};
    for (const s of students) map[s.no] = s;
    for (const s of list) map[s.no] = s;
    students = Object.keys(map).map((no) => map[no]);
  }
  writeJson(STUDENTS_FILE, students);
}

function getSenders() { return senders; }
function setSender(ip, nickname) {
  if (nickname) senders[ip] = String(nickname).trim();
  else delete senders[ip];
  writeJson(SENDERS_FILE, senders);
}

function getClassrooms() { return classrooms; }
function setClassroom(ip, name) {
  if (name) classrooms[ip] = String(name).trim();
  else delete classrooms[ip];
  writeJson(CLASSROOMS_FILE, classrooms);
}

function getSchedule() { return schedule; }
function setSchedule(list) {
  schedule = (list || []).slice();
  writeJson(SCHEDULE_FILE, schedule);
}

module.exports = {
  store: {
    getRoomId, setRoomId,
    getToken, setToken, genToken,
    getRecords, addRecord, removeRecord, clearRecords,
    getStudents, saveStudents,
    getSenders, setSender,
    getClassrooms, setClassroom,
    getSchedule, setSchedule,
    saveConfig
  },
  config,
  lanIPv4,
  genCode,
  genToken
};
