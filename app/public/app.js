'use strict';
(function () {
  const TOKEN_KEY = 'cb_token';
  const PAGE_SIZE = 10;
  const $ = (id) => document.getElementById(id);

  const params = new URLSearchParams(location.search);
  let token = params.get('token') || localStorage.getItem(TOKEN_KEY) || '';
  let records = [];
  let page = 1;

  // ---------- API ----------
  function api(path, opts) {
    const headers = Object.assign({ 'Content-Type': 'application/json' }, (opts && opts.headers) || {});
    if (token) headers['X-Token'] = token;
    return fetch(path, Object.assign({}, opts, { headers })).then(async (r) => {
      if (r.status === 401) throw new Error('unauthorized');
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
      return data;
    });
  }

  // ---------- 连接码 ----------
  function showConnectModal() {
    $('connect-modal').classList.remove('hidden');
    $('connect-input').focus();
  }

  function doConnect(raw) {
    raw = (raw || '').trim();
    if (!raw) { alert('请输入连接码'); return; }
    const m = raw.match(/^([\d.]+):(\d+)-([A-Za-z0-9]+)$/);
    if (m) {
      const ip = m[1];
      const port = m[2];
      const tk = m[3];
      // 与本页地址不同 → 跳到对应教室的面板页面并带上 Token
      if (ip !== location.hostname && !['localhost', '127.0.0.1'].includes(location.hostname)) {
        location.href = 'http://' + ip + ':' + port + '/?token=' + encodeURIComponent(tk);
        return;
      }
      verifyAndSave(tk);
    } else {
      // 只输入了 Token（本页已是目标教室）
      verifyAndSave(raw);
    }
  }

  function verifyAndSave(tk) {
    fetch('/api/verify-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: tk })
    }).then((r) => r.json()).then((d) => {
      if (d.ok) {
        token = tk;
        localStorage.setItem(TOKEN_KEY, tk);
        if (params.get('token')) history.replaceState(null, '', location.pathname);
        $('connect-modal').classList.add('hidden');
        $('connect-input').value = '';
        refreshAll();
      } else {
        alert('连接码不正确，请核对后重试');
      }
    }).catch(() => alert('无法连接教室，请检查网络与连接码'));
  }

  $('btn-connect').addEventListener('click', showConnectModal);
  $('btn-connect-cancel').addEventListener('click', () => $('connect-modal').classList.add('hidden'));
  $('btn-connect-ok').addEventListener('click', () => doConnect($('connect-input').value));
  $('connect-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('btn-connect-ok').click();
  });

  // ---------- 状态 ----------
  function renderConn(ok, code) {
    const badge = $('conn-badge');
    const txt = $('conn-text');
    if (ok && code) {
      badge.className = 'badge online';
      txt.textContent = '已连接 ' + code.split('-')[0];
    } else {
      badge.className = 'badge offline';
      txt.textContent = ok ? '已连接（码获取中）' : '无法连接教室';
    }
  }

  // ---------- 记录（本地时区 + 分页，每页 10 条） ----------
  const STATUS_TEXT = { created: '处理中', shown: '已显示', scheduled: '已定时', expired: '已过期' };

  function fmtLocal(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso).replace('T', ' ').slice(0, 16);
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
      ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  let senders = {};
  let classrooms = {};
  let clientIp = '';
  let classIp = ''; // 始终取当前连接教室（连接码 IP），与浏览器从哪台机器打开无关

  function senderLabel(ip) {
    if (!ip) return '—';
    return (senders[ip] && senders[ip].trim()) ? senders[ip] : ip;
  }

  function classLabel(ip) {
    if (!ip) return '—';
    return (classrooms[ip] && classrooms[ip].trim()) ? classrooms[ip] : ip;
  }

  function renderRecords() {
    const totalPages = Math.max(1, Math.ceil(records.length / PAGE_SIZE));
    if (page > totalPages) page = totalPages;
    if (page < 1) page = 1;
    const slice = records.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
    const tbody = $('records-body');
    tbody.innerHTML = '';
    $('records-empty').style.display = records.length ? 'none' : '';
    for (const r of slice) {
      const tr = document.createElement('tr');
      tr.innerHTML =
        '<td>' + fmtLocal(r.createdAt) + '</td>' +
        '<td title="' + esc(classLabel(r.classroomIp)) + '">' + esc(classLabel(r.classroomIp)) + '</td>' +
        '<td title="' + esc(senderLabel(r.senderIp)) + '">' + esc(senderLabel(r.senderIp)) + '</td>' +
        '<td title="' + esc(r.title) + '">' + esc(r.title) + '</td>' +
        '<td><span class="st-badge st-' + r.status + '">' + (STATUS_TEXT[r.status] || r.status) + '</span></td>' +
        '<td><button class="btn secondary sm tight btn-repost" data-id="' + r.id + '">重发</button> ' +
        '<button class="btn danger sm tight btn-rec-del" data-id="' + r.id + '">删除</button></td>';
      tbody.appendChild(tr);
    }
    $('pg-prev').disabled = page <= 1;
    $('pg-next').disabled = page >= totalPages;
    $('pg-info').textContent = '第 ' + page + '/' + totalPages + ' 页 · 共 ' + records.length + ' 条';
  }

  $('pg-prev').addEventListener('click', () => { if (page > 1) { page--; renderRecords(); } });
  $('pg-next').addEventListener('click', () => {
    if (page < Math.ceil(records.length / PAGE_SIZE)) { page++; renderRecords(); }
  });

  // ---------- 删除单条记录 / 清空记录 ----------
  $('records-body').addEventListener('click', (e) => {
    const btn = e.target.closest('.btn-rec-del');
    if (!btn) return;
    const rec = records.find((r) => r.id === btn.dataset.id);
    if (!rec) return;
    if (!confirm('确认删除这条发送记录？\n「' + rec.title + '」')) return;
    api('/api/records/delete', { method: 'POST', body: JSON.stringify({ id: rec.id }) })
      .then((d) => {
        if (!d.ok) { alert('删除失败'); return; }
        refreshAll();
      })
      .catch((e) => alert('删除失败：' + e.message));
  });

  $('btn-records-clear').addEventListener('click', () => {
    if (!records.length) return;
    if (!confirm('确认清空全部 ' + records.length + ' 条发送记录？此操作不可恢复。')) return;
    api('/api/records/clear', { method: 'POST', body: '{}' })
      .then((d) => {
        if (!d.ok) { alert('清空失败'); return; }
        refreshAll();
      })
      .catch((e) => alert('清空失败：' + e.message));
  });

  // ---------- 再发一次（重新发布同一条通知，产生新记录） ----------
  $('records-body').addEventListener('click', (e) => {
    const btn = e.target.closest('.btn-repost');
    if (!btn) return;
    const rec = records.find((r) => r.id === btn.dataset.id);
    if (!rec) return;
    const payload = {
      level: 'normal',
      title: rec.title,
      body: rec.body || '',
      sound: rec.sound && rec.sound !== 'none' ? rec.sound : null,
      ttsText: rec.ttsText || null,
      ttsLoop: rec.ttsLoop || 0,
      displaySeconds: rec.displaySeconds == null ? 30 : rec.displaySeconds,
      classroomIp: rec.classroomIp || null
    };
    api('/api/publish', { method: 'POST', body: JSON.stringify(payload) })
      .then((res) => {
        alert('已重新发布（状态：' + (STATUS_TEXT[res.status] || res.status) + '）');
        refreshAll();
      })
      .catch((e) => alert('发布失败：' + e.message));
  });

  // ---------- 点名指令：输入 /name 打开点名册，选中名字以名字框插入输入框 ----------
  let pickAll = [];       // 点名册名单快照
  let pickSel = {};       // 弹框内临时选中（key: 学号）
  let pickField = null;   // 触发点名的输入框外层（#f-title / #f-body，名字追加到其 .names-zone）

  function renderPickGrid() {
    const box = $('pick-list');
    box.innerHTML = '';
    for (const s of pickAll) {
      const item = document.createElement('div');
      item.className = 'pick-item' + (pickSel[s.no] ? ' sel' : '');
      item.textContent = s.name;
      item.addEventListener('click', () => {
        if (pickSel[s.no]) delete pickSel[s.no]; else pickSel[s.no] = true;
        renderPickGrid();
        $('pick-count').textContent = '已选 ' + Object.keys(pickSel).length + ' 人';
      });
      box.appendChild(item);
    }
  }

  // 在 div 内按全局字符偏移定位文本节点位置（用于删除 /name、插入名字）
  function findTextPos(node, offset) {
    let remaining = offset;
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    let tn;
    while ((tn = walker.nextNode())) {
      const len = tn.data.length;
      if (remaining <= len) return { node: tn, offset: remaining };
      remaining -= len;
    }
    return { node: node, offset: node.textContent ? node.textContent.length : 0 };
  }

  // 提取输入框纯文本（名字区 .names-zone 的名字文字 + 文本区 .text-zone 内容，跳过 × 按钮）
  // 名字区与文本区间以一个空格分隔，发布内容如"钟馗、狄仁杰 请到办公室"
  function fieldText(field) {
    let out = '';
    const nz = field.querySelector('.names-zone');
    const tz = field.querySelector('.text-zone');
    if (nz) {
      for (const node of nz.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) out += node.data;
        else if (node.nodeType === Node.ELEMENT_NODE && node.classList && node.classList.contains('name-tag')) {
          const t = node.querySelector('.name-tag-text');
          if (t) out += t.textContent;
        }
      }
    }
    const tzText = tz ? tz.textContent : '';
    if (out && tzText) out += ' ' + tzText; else out += tzText;
    return out;
  }

  // 删除名字框：连同相邻顿号分隔符一起移除；焦点回到文本区（保持继续输入）
  function removeNameTag(chip) {
    const parent = chip.parentNode;
    if (!parent) return;
    let prev = chip.previousSibling;
    let next = chip.nextSibling;
    parent.removeChild(chip);
    if (prev && prev.nodeType === Node.TEXT_NODE && prev.data === '、') parent.removeChild(prev);
    else if (next && next.nodeType === Node.TEXT_NODE && next.data === '、') parent.removeChild(next);
    const field = parent.parentNode;
    if (field) {
      const tz = field.querySelector('.text-zone');
      if (tz) tz.focus();
    }
  }

  // 确定选择：把所有选中名字追加到输入框的名字区（.names-zone）。
  // 名字区与文本区是并列兄弟元素——光标永远只在文本区（纯可编辑），不接触名字区，
  // 彻底避免 Chromium 把光标吸附到不可编辑名字框边界导致的输入/中文输入法异常。
  function insertPickedNames() {
    const picked = pickAll.filter((s) => pickSel[s.no]);
    $('pick-modal').classList.add('hidden');
    const field = pickField;
    pickField = null;
    if (!picked.length || !field) return;
    const nz = field.querySelector('.names-zone');
    if (!nz) return;
    picked.forEach((s, i) => {
      if (i > 0) nz.appendChild(document.createTextNode('、')); // 名字间用顿号分隔
      const chip = document.createElement('span');
      chip.className = 'name-tag';
      chip.setAttribute('contenteditable', 'false'); // 名字区整体不可编辑
      const txt = document.createElement('span');
      txt.className = 'name-tag-text';
      txt.textContent = s.name;
      const x = document.createElement('span');
      x.className = 'name-x';
      x.textContent = '×';
      x.title = '删除';
      x.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        removeNameTag(chip);
      });
      chip.appendChild(txt);
      chip.appendChild(x);
      nz.appendChild(chip);
    });
    // 光标保持/回到文本区（不设置名字区位置，天然在框外）
    const tz = field.querySelector('.text-zone');
    if (tz) tz.focus();
  }

  // 从指定文本节点+偏移起，精确删除 n 个字符（可跨文本节点）
  // 原因：/name 可能因输入法/粘贴/编辑操作被拆成多个文本节点（如 "/"+"name"），
  // 只删第一个节点内的部分会残留 "name"。
  function deleteChars(field, startNode, startOffset, n) {
    const range = document.createRange();
    range.setStart(startNode, startOffset);
    let node = startNode;
    let off = startOffset + n;
    while (node && off > node.data.length) {
      off -= node.data.length;
      let next = node.nextSibling;
      while (next && next.nodeType !== Node.TEXT_NODE) next = next.nextSibling;
      node = next;
    }
    if (!node) {
      range.setEnd(startNode, startNode.data ? startNode.data.length : 0);
    } else {
      range.setEnd(node, off);
    }
    range.deleteContents();
    return range; // 删除后 collapsed 在原 /name 位置
  }

  // 检测 /name 指令：立即删除文本区内的指令并打开点名册（取消不残留，可继续正常输入）
  // tz = 文本区（.text-zone）；名字追加到外层输入框的名字区
  function handleNameCmd(tz) {
    const text = tz.textContent;
    const idx = text.indexOf('/name');
    if (idx < 0) return false;
    const start = findTextPos(tz, idx);
    deleteChars(tz, start.node, start.offset, 5); // 删除 '/name'（跨节点，覆盖输入法拆分节点的情况）
    const sel = window.getSelection();
    const caret = document.createRange();
    caret.selectNodeContents(tz);
    caret.collapse(false);
    sel.removeAllRanges();
    sel.addRange(caret); // 光标回到文本区末尾（弹窗期间输入框不被打扰）
    api('/api/students').then((d) => {
      pickAll = (d.students || []).slice();
      if (!pickAll.length) { alert('名单为空，请先到「班级名单」添加学生'); return; }
      pickField = tz.parentNode; // 外层输入框（#f-title / #f-body）
      pickSel = {};
      $('pick-empty').style.display = 'none';
      renderPickGrid();
      $('pick-count').textContent = '已选 0 人';
      $('pick-modal').classList.remove('hidden');
    }).catch((e) => alert('读取名单失败：' + e.message));
    return true;
  }

  // 两个输入框共用：文本区绑定输入事件。名字区与文本区结构分离，光标只会在文本区内
  function bindEditable(id, maxLen) {
    const field = $(id);
    const tz = field.querySelector('.text-zone');
    if (!tz) return;
    // 点击输入框任意处 → 聚焦文本区（名字区不可编辑）
    field.addEventListener('click', () => tz.focus());
    // 输入法组合状态跟踪：某些输入法下 keydown 的 isComposing 不可靠，
    // 组合结束（compositionend）后必须补一次 /name 检测，否则中文输入法输入的 /name
    // （shift 切英文/Enter 确认候选等场景）不会弹出点名册
    let composing = false;
    let lastCompEnd = 0;
    tz.addEventListener('compositionstart', () => { composing = true; });
    tz.addEventListener('compositionend', () => {
      composing = false;
      lastCompEnd = Date.now();
      handleNameCmd(tz); // 组合结束补检测（/name 已被上屏到 DOM，此时删除并弹点名册）
    });
    tz.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter') return;
      // 组合中、或组合刚结束（IME 确认候选词的 Enter，keydown 的 isComposing 可能已是 false）：
      // 一律不换行
      if (composing || ev.isComposing || ev.keyCode === 229 || Date.now() - lastCompEnd < 500) {
        ev.preventDefault();
        return;
      }
      if (id === 'f-title') { ev.preventDefault(); return; } // 标题单行
      // 正文：手动插入换行（不依赖浏览器默认 Enter 行为，行为一致可控）
      ev.preventDefault();
      document.execCommand('insertLineBreak');
    });
    tz.addEventListener('input', (ev) => {
      // IME 组合中不修改 DOM（避免打断输入法组合）；组合结束会再触发一次 input 正常处理
      if (ev.isComposing) return;
      if (handleNameCmd(tz)) return;
      const text = fieldText(field);
      if (text.length > maxLen) {
        // 超长静默截断（不弹窗打断输入）：只截文本区末尾，名字区不动
        const cur = tz.textContent;
        const over = text.length - maxLen;
        if (over > 0) {
          tz.textContent = cur.slice(0, Math.max(0, cur.length - over));
          const sel = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(tz);
          range.collapse(false);
          sel.removeAllRanges();
          sel.addRange(range);
        }
      }
    });
  }
  bindEditable('f-title', 50);
  bindEditable('f-body', 500);

  $('btn-pick-cancel').addEventListener('click', () => {
    $('pick-modal').classList.add('hidden');
    pickField = null;
  });
  $('btn-pick-ok').addEventListener('click', insertPickedNames);

  // ---------- 发布 ----------
  function doPublish() {
    const payload = {
      level: 'normal',
      title: fieldText($('f-title')).trim(),
      body: fieldText($('f-body')).trim(),
      sendAt: $('f-sendat').value ? new Date($('f-sendat').value).toISOString() : null,
      sound: (document.querySelector('input[name="sound"]:checked') || {}).value || null,
      ttsText: $('f-tts').value.trim() || null,
      ttsLoop: Number((document.querySelector('input[name="ttsloop"]:checked') || {}).value) || 0,
      displaySeconds: Number((document.querySelector('input[name="display"]:checked') || {}).value) || 0,
      classroomIp: classIp || null
    };
    api('/api/publish', { method: 'POST', body: JSON.stringify(payload) })
      .then((res) => {
        alert('已发布（状态：' + (STATUS_TEXT[res.status] || res.status) + '）');
        refreshAll();
      })
      .catch((e) => alert('发布失败：' + e.message));
  }

  $('btn-publish').addEventListener('click', () => {
    const title = fieldText($('f-title')).trim();
    if (!title) { alert('请输入标题'); return; }
    doPublish();
  });

  // ---------- 昵称绑定 IP ----------
  function renderNick() {
    $('nick-info').textContent = clientIp
      ? '当前本机 IP：' + clientIp + (senders[clientIp] ? ' · 已绑定昵称「' + senders[clientIp] + '」' : ' · 未绑定昵称（记录将显示 IP）')
      : '';
    const cur = senders[clientIp];
    if ($('f-nick').value === '' && cur) $('f-nick').value = cur;
  }

  $('btn-nick-save').addEventListener('click', () => {
    if (!clientIp) { alert('尚未获取本机 IP，请先连接教室'); return; }
    const nickname = $('f-nick').value.trim();
    api('/api/sender', { method: 'POST', body: JSON.stringify({ ip: clientIp, nickname }) })
      .then((d) => {
        senders = d.senders || {};
        $('nick-info').textContent = nickname
          ? '已绑定：' + clientIp + ' → ' + nickname
          : '已解除绑定：' + clientIp + '（记录将显示 IP）';
        refreshAll();
      })
      .catch((e) => alert('保存失败：' + e.message));
  });

  // ---------- 班级绑定（始终绑定当前连接的教室 IP，与打开机器无关） ----------
  function renderClass() {
    $('class-info').textContent = '当前教室 IP：' + classIp +
      (classrooms[classIp] ? ' · 已绑定「' + classrooms[classIp] + '」' : ' · 未绑定班级名（记录显示 IP）');
    const cur = classrooms[classIp];
    if ($('f-class').value === '' && cur) $('f-class').value = cur;
  }

  $('btn-class-save').addEventListener('click', () => {
    const name = $('f-class').value.trim();
    api('/api/classroom', { method: 'POST', body: JSON.stringify({ ip: classIp, name }) })
      .then((d) => {
        classrooms = d.classrooms || {};
        $('class-info').textContent = name
          ? '已绑定：' + classIp + ' → ' + name
          : '已解除绑定：' + classIp + '（记录显示 IP）';
        refreshAll();
      })
      .catch((e) => alert('保存失败：' + e.message));
  });

  // ---------- 班级名单（随机点名） ----------
  function refreshStudents() {
    api('/api/students').then((d) => {
      const list = (d.students || []).slice();
      const body = $('students-body');
      body.innerHTML = '';
      $('students-table').style.display = list.length ? '' : 'none';
      $('students-count').textContent = String(list.length);
      $('students-info').textContent = list.length ? '已导入 ' + list.length + ' 人' : '未导入名单';
      for (const s of list) {
        const tr = document.createElement('tr');
        tr.innerHTML = '<td>' + esc(s.no) + '</td><td>' + esc(s.name) + '</td><td>' + (s.gender === 'female' ? '女' : '男') + '</td>';
        body.appendChild(tr);
      }
    }).catch(() => {});
  }

  // rows: 二维数组，每行 [学号,姓名,性别]；自动跳过表头行与空行
  function parseRows(rows) {
    const out = [];
    for (const cells of rows) {
      const c = cells.map((s) => String(s == null ? '' : s).trim());
      if (!c.join('')) continue;
      if (/学号/.test(c[0])) continue; // 表头行
      const no = c[0] || '';
      const name = c[1] || '';
      const g = c[2] || '';
      if (!name) continue;
      const gender = (g === '女' || g === 'female' || g === 'F' || g === 'f') ? 'female' : 'male';
      out.push({ no, name, gender });
    }
    return out;
  }

  function parseStudents(text) {
    const rows = String(text || '').split(/\r?\n/).map((line) => line.split(/[,，\t\s]+/));
    return parseRows(rows);
  }

  // ---------- 添加名单（弹框：手动输入 / CSV/Excel 导入 → 显示在输入框 → 追加/覆盖保存） ----------
  function openStudentsModal() {
    $('students-modal').classList.remove('hidden');
    $('m-file-info').textContent = '';
    $('m-students').focus();
  }
  function closeStudentsModal() { $('students-modal').classList.add('hidden'); }

  function saveStudents(mode) {
    const students = parseStudents($('m-students').value);
    if (!students.length) { alert('未解析到有效名单：每行格式 学号,姓名,性别'); return; }
    api('/api/students', { method: 'POST', body: JSON.stringify({ students, mode }) })
      .then(() => {
        $('m-students').value = '';
        $('m-file-info').textContent = '';
        closeStudentsModal();
        alert(mode === 'overwrite' ? '已覆盖保存，共 ' + students.length + ' 人' : '已追加 ' + students.length + ' 人（学号重复自动覆盖）');
        refreshAll();
      })
      .catch((e) => alert('保存失败：' + e.message));
  }

  $('btn-students-add').addEventListener('click', openStudentsModal);
  $('btn-m-cancel').addEventListener('click', closeStudentsModal);
  $('btn-m-append').addEventListener('click', () => saveStudents('append'));
  $('btn-m-overwrite').addEventListener('click', () => saveStudents('overwrite'));

  // 文件导入：解析后填入输入框（不直接提交），用户确认后点 追加/覆盖 保存
  $('btn-m-file').addEventListener('click', () => $('m-students-file').click());
  $('m-students-file').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = ''; // 允许重复选择同一文件
    if (!file) return;
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    const done = (text) => {
      $('m-students').value = text;
      const n = parseStudents(text).length;
      $('m-file-info').textContent = '已解析 ' + n + ' 人，填入上方输入框，确认后点「追加保存」或「覆盖保存」';
      $('m-students').focus();
    };
    if (ext === 'csv') {
      // 中文 Windows 导出的 CSV 常为 GBK/ANSI 编码：先按 UTF-8 读，发现乱码字符则按 GB18030 重读
      const reader = new FileReader();
      reader.onload = () => {
        const text = String(reader.result || '');
        if (text.indexOf('\uFFFD') >= 0) {
          const r2 = new FileReader();
          r2.onload = () => done(String(r2.result || ''));
          r2.readAsText(file, 'gb18030');
        } else {
          done(text);
        }
      };
      reader.readAsText(file, 'UTF-8');
    } else if (ext === 'xlsx' || ext === 'xls') {
      if (typeof XLSX === 'undefined') { alert('Excel 解析库未加载，请刷新页面重试'); return; }
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const wb = XLSX.read(new Uint8Array(reader.result), { type: 'array' });
          const rows = [];
          for (const sheetName of wb.SheetNames) {
            const aoa = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: '' });
            rows.push(...aoa);
          }
          const text = parseRows(rows)
            .map((s) => [s.no, s.name, s.gender === 'female' ? '女' : '男'].join(','))
            .join('\n');
          done(text);
        } catch (err) {
          alert('Excel 解析失败：' + (err && err.message ? err.message : err));
        }
      };
      reader.readAsArrayBuffer(file);
    } else {
      alert('仅支持 .csv / .xlsx / .xls 文件');
    }
  });

  $('btn-students-copy').addEventListener('click', () => {
    api('/api/students').then((d) => {
      const list = (d.students || []).slice();
      if (!list.length) { alert('名单为空，无可复制'); return; }
      const text = list.map((s) => [s.no, s.name, s.gender === 'female' ? '女' : '男'].join(',')).join('\n');
      const done = () => alert('已复制 ' + list.length + ' 人名单到剪贴板');
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
      } else {
        fallbackCopy(text, done);
      }
    }).catch((e) => alert('读取名单失败：' + e.message));
  });

  function fallbackCopy(text, done) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      done();
    } catch (e) { alert('复制失败，请手动复制'); }
  }

  $('btn-students-clear').addEventListener('click', () => {
    if (!confirm('确认清空班级名单？')) return;
    api('/api/students', { method: 'POST', body: JSON.stringify({ students: [] }) })
      .then(() => refreshAll())
      .catch((e) => alert('清空失败：' + e.message));
  });

  // ---------- 刷新 ----------
  function refreshAll() {
    api('/api/status')
      .then((d) => {
        renderConn(true, d.code);
        if (d.version) $('ver-badge').textContent = 'v' + d.version;
        if (d.code) classIp = String(d.code).split('-')[0]; // 当前连接的教室 IP（连接码 IP），与本机打开无关
        senders = d.senders || {};
        classrooms = d.classrooms || {};
        if (d.clientIp) clientIp = d.clientIp;
        renderNick();
        renderClass();
      })
      .catch(() => renderConn(false, null));
    api('/api/records?limit=500').then((d) => {
      records = (d.records || []).slice();
      renderRecords();
    }).catch(() => {});
    refreshStudents();
  }

  // ---------- 检查 / 领取更新（GitHub 仓库） ----------
  $('btn-update').addEventListener('click', () => {
    const btn = $('btn-update');
    const info = $('update-info');
    if (btn.dataset.busy) return;
    btn.dataset.busy = '1';
    btn.textContent = '检查中…';
    info.textContent = '';
    api('/api/update', { method: 'POST', body: JSON.stringify({ action: 'update' }) })
      .then((r) => {
        if (!r.ok) { info.textContent = r.error || '检查更新失败'; return; }
        if (!r.hasUpdate) { info.textContent = '已是最新版本 v' + r.current; return; }
        info.textContent = '发现新版本 v' + r.latest + '，更新包已下载到教室端，退出程序后双击 update.bat 完成更新';
      })
      .catch((e) => { info.textContent = '检查更新失败：' + e.message; })
      .finally(() => { btn.dataset.busy = ''; btn.textContent = '检查更新'; });
  });

  // ---------- 工具 ----------
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function toLocalInput(d) {
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  // ---------- 初始化 ----------
  function init() {
    if (params.get('token')) {
      // 从连接码带过来的 Token：直接校验
      verifyAndSave(token);
    } else if (token) {
      refreshAll();
    } else {
      showConnectModal();
    }
    setInterval(refreshAll, 5000);
  }

  init();
})();
