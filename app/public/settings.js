'use strict';
(function () {
  const TOKEN_KEY = 'cb_token';
  const $ = (id) => document.getElementById(id);
  const MAX_MB = 5;

  let token = localStorage.getItem(TOKEN_KEY) || '';

  function api(path, opts) {
    const headers = Object.assign({ 'Content-Type': 'application/json' }, (opts && opts.headers) || {});
    if (token) headers['X-Token'] = token;
    return fetch(path, Object.assign({}, opts, { headers })).then(async (r) => {
      if (r.status === 401) throw new Error('Token 无效，请回发布面板重新输入连接码');
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
      return data;
    });
  }

  // ---------- 更换背景（大屏弹窗） ----------
  function bindUpload(fileId, prevId, btnId, msgId, target) {
    let file = null;
    $(fileId).addEventListener('change', () => {
      const f = $(fileId).files && $(fileId).files[0];
      file = f || null;
      const img = $(prevId);
      if (f) {
        img.src = URL.createObjectURL(f);
        img.style.display = 'block';
      } else {
        img.style.display = 'none';
      }
      $(msgId).textContent = '';
    });
    $(btnId).addEventListener('click', () => {
      const f = file || ($(fileId).files && $(fileId).files[0]);
      const msg = $(msgId);
      if (!f) { msg.textContent = '请先选择图片'; msg.style.color = '#c0392b'; return; }
      if (f.size > MAX_MB * 1024 * 1024) {
        msg.textContent = '图片超过 ' + MAX_MB + 'MB'; msg.style.color = '#c0392b'; return;
      }
      const fr = new FileReader();
      fr.onload = () => {
        const data = String(fr.result || '').split(',')[1] || '';
        api('/api/background', { method: 'POST', body: JSON.stringify({ target, data }) })
          .then((d) => {
            msg.textContent = '保存成功（' + Math.round(d.bytes / 1024) + 'KB）。' +
              (target === 'display' ? '下次大屏弹窗立即生效。' : '发布面板刷新页面后生效。');
            msg.style.color = '#0e7a41';
          })
          .catch((e) => { msg.textContent = '保存失败：' + e.message; msg.style.color = '#c0392b'; });
      };
      fr.readAsDataURL(f);
    });
  }
  bindUpload('file-display', 'prev-display', 'btn-display-save', 'msg-display', 'display');

  // ---------- 重置连接码 ----------
  $('btn-token-save').addEventListener('click', () => {
    const t = $('token-new').value.trim();
    if (t.length < 4) { $('token-msg').textContent = 'Token 至少 4 位'; return; }
    api('/api/settings', { method: 'POST', body: JSON.stringify({ token: t }) })
      .then((d) => {
        localStorage.setItem(TOKEN_KEY, t);
        token = t;
        $('token-msg').textContent = '已重置。新连接码：' + (d.code || 'IP:端口-' + t) + '（教室屏幕角落会自动同步）';
        $('token-msg').style.color = '#0e7a41';
        $('token-new').value = '';
      })
      .catch((e) => {
        $('token-msg').textContent = '重置失败：' + e.message;
        $('token-msg').style.color = '#c0392b';
      });
  });
})();
