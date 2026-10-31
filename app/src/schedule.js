'use strict';
/**
 * schedule.js — 上课时段判断（与 v0.1 一致）
 * weekday 内部约定：1=周一 ... 7=周日
 */

function jsDayToWeekday(date) {
  return ((date.getDay() + 6) % 7) + 1;
}

function toMinutes(hhmm) {
  const parts = String(hhmm || '00:00').split(':');
  return Number(parts[0]) * 60 + Number(parts[1] || 0);
}

function inClassTime(date, scheduleRows) {
  if (!Array.isArray(scheduleRows) || scheduleRows.length === 0) return null;
  const wd = jsDayToWeekday(date);
  const now = date.getHours() * 60 + date.getMinutes();
  for (const row of scheduleRows) {
    if (Number(row.weekday) !== wd) continue;
    const start = toMinutes(row.start);
    const end = toMinutes(row.end);
    if (now >= start && now < end) {
      return { weekday: wd, start: row.start, end: row.end };
    }
  }
  return null;
}

module.exports = { inClassTime, jsDayToWeekday };
