'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('announcer', {
  // 弹窗页
  onAnnouncement: (cb) => {
    ipcRenderer.on('announcement', (_e, payload) => cb(payload));
  },
  hideDisplay: () => ipcRenderer.send('hide-display'),
  // 角落窗
  getInfo: () => ipcRenderer.invoke('get-info'),
  hideCorner: () => ipcRenderer.send('hide-corner'),
  exit: () => ipcRenderer.invoke('exit'),
  // 随机点名：主进程提供匿名名单（姓名+性别）
  rollCall: () => ipcRenderer.invoke('roll-call'),
  onRollCallStart: (cb) => {
    ipcRenderer.on('roll-call-start', (_e, payload) => cb(payload));
  }
});
