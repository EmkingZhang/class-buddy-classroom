# Class Buddy · 开屏通知（教室端）

局域网教室大屏弹窗通知 / 随机点名 / 班级名单 教学助手（Electron 免安装，零手动配置）。

## 功能
- 大屏弹窗通知：标题/正文、提示音（无声/叮咚/上课铃/警报/AI 语音朗读）、显示时长倒计时
- 发送记录：分页、IP/昵称/班级绑定、重发/删除/清空
- 班级名单：CSV/Excel 导入、按学号排序、追加/覆盖、复制/清空
- 随机点名：/name 点名册多选、托盘随机点名（全部/男生/女生）、数量 1/2/5/10/自定义、不重复、掷色子音效
- 连接码：自动生成 IP:端口-TOKEN，浏览器输码即发布
- 检查更新：控制面板「检查更新」从本仓库拉取最新版

## 目录结构
- main.js / preload.js：Electron 主进程 / 预加载
- window.html：大屏弹窗 + 随机点名动画
- corner.html：角标连接码小窗
- public/：发布面板（index.html / app.js / style.css / settings.html / settings.js）
- src/：HTTP 服务（server.js / http.js）、数据（store.js）、课时（schedule.js）

## 使用
解压完整安装包（ClassBuddy-Classroom-<版本>-win64.zip，交付时随包提供）→ 双击 ClassBuddy.exe。
办公室浏览器打开 http://<连接码IP>:8787 → 输入连接码发布。

## 更新
1. 控制面板点「检查更新」
2. 发现新版本后，教室端自动下载到程序目录 update\staging
3. 完全退出教室端（托盘右键退出），双击 update\update.bat，自动替换并重启

## 版本
当前版本：1.0.27（见 VERSION）
