'use strict';
/**
 * schedule.js — 课时判断（仅提示用，不做硬限制）
 */
const { store } = require('./store');

function inClassNow() {
  try {
    const list = store.getSchedule() || [];
    if (!list.length) return false;
    const now = new Date();
    const wd = now.getDay() === 0 ? 7 : now.getDay(); // 周一=1 … 周日=7
    const hm = now.getHours() * 60 + now.getMinutes();
    for (const item of list) {
      if (Number(item.weekday) !== wd) continue;
      const [sh, sm] = String(item.start || '00:00').split(':').map((n) => parseInt(n, 10) || 0);
      const [eh, em] = String(item.end || '23:59').split(':').map((n) => parseInt(n, 10) || 0);
      const s = sh * 60 + sm;
      const e = eh * 60 + em;
      if (hm >= s && hm < e) return true;
    }
    return false;
  } catch (e) {
    return false;
  }
}

module.exports = { inClassNow };
