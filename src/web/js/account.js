/*!
 * NounKiller · account.js
 * 邮箱登录、云端题库同步、在线状态、用户与管理员留言。
 *
 * 只依赖 /api/*（Cloudflare Pages + D1）。原生壳从 file:// 打开时，
 * 接口固定走线上域名；Web 端与 Pages 预览域名自动同源。
 */
(function () {
  'use strict';

  var A = window.MJZ.app;
  if (!A) return;
  var h = A.h;

  var SESSION_KEY = 'nounkiller.session.v1';
  var NATIVE = location.protocol === 'file:' ||
    location.protocol === 'capacitor:' ||
    (location.protocol === 'https:' && location.hostname === 'localhost');
  var API_BASE = window.NK_API_BASE || (NATIVE ? 'https://nounkiller.pages.dev' : '');

  var session = null;
  var me = null;
  var cloudVersion = 0;
  var lastHash = '';
  var syncing = false;
  var syncNote = '尚未同步';
  var unread = 0;
  var heartbeatTimer = null;
  var syncTimer = null;
  var pollTimer = null;
  var threadUser = null;
  var syncPaused = false;
  var modalTimers = [];
  var groupPollTimer = null;

  function trackModalTimer(id) { modalTimers.push(id); return id; }

  /* ---------------- 基础 ---------------- */

  function $(sel, root) { return (root || document).querySelector(sel); }

  function loadSession() {
    try {
      var raw = localStorage.getItem(SESSION_KEY);
      var parsed = raw ? JSON.parse(raw) : null;
      if (parsed && parsed.token) return parsed;
    } catch (e) { /* ignore */ }
    return null;
  }

  function saveSession(next) {
    session = next;
    try {
      if (next) localStorage.setItem(SESSION_KEY, JSON.stringify(next));
      else localStorage.removeItem(SESSION_KEY);
    } catch (e) { /* ignore */ }
  }

  function api(path, opts) {
    opts = opts || {};
    var headers = { };
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    if (session && session.token) headers.authorization = 'Bearer ' + session.token;
    return fetch(API_BASE + path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      cache: 'no-store'
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) {
          var err = new Error(data.error || ('请求失败（' + res.status + '）'));
          err.status = res.status;
          err.data = data;
          throw err;
        }
        return data;
      });
    });
  }

  function fmtTime(ts) {
    if (!ts) return '—';
    var d = new Date(ts);
    var diff = Date.now() - ts;
    if (diff < 60 * 1000) return '刚刚';
    if (diff < 60 * 60 * 1000) return Math.floor(diff / 60000) + ' 分钟前';
    if (diff < 24 * 60 * 60 * 1000) return Math.floor(diff / 3600000) + ' 小时前';
    return (d.getMonth() + 1) + '月' + d.getDate() + '日';
  }

  function fmtDate(ts) {
    if (!ts) return '—';
    var d = new Date(ts);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function errText(error) {
    if (!error) return '操作失败';
    if (error.status === 401) return '登录已过期，请重新登录';
    if (error.message === 'Failed to fetch') return '连不上云端，请检查网络';
    return error.message || '操作失败';
  }

  function setBadge(n) {
    unread = n || 0;
    var btn = $('#accountBtn');
    if (!btn) return;
    var dot = btn.querySelector('.account-dot');
    if (!dot) {
      dot = h('i', { class: 'account-dot', 'aria-hidden': 'true' });
      btn.appendChild(dot);
    }
    dot.hidden = !unread;
    btn.setAttribute('aria-label', session
      ? '账号与云端' + (unread ? '，' + unread + ' 条未读留言' : '')
      : '登录账号');
  }

  function updateAccountBtn() {
    var btn = $('#accountBtn');
    if (!btn) return;
    btn.classList.toggle('signed-in', !!session);
    btn.setAttribute('aria-label', session ? ('账号：' + (me ? me.email : '')) : '登录账号');
    setBadge(unread);
  }

  /* ---------------- 登录 / 注册 ---------------- */

  function openAuth(mode) {
    var current = mode === 'register' ? 'register' : 'login';
    var body = h('div', { class: 'account-form' });
    var intro = h('p', { class: 'account-intro', text: '登录后，题库、进度、划线和收藏会同步到你的云端空间；换设备也能接着背。' });
    body.appendChild(intro);

    var tabs = h('div', { class: 'segmented account-tabs' });
    var loginTab = h('button', { type: 'button', text: '登录' });
    var regTab = h('button', { type: 'button', text: '注册' });
    tabs.appendChild(loginTab); tabs.appendChild(regTab);
    body.appendChild(tabs);

    var fieldEmail = h('div', { class: 'field' });
    fieldEmail.appendChild(h('label', { for: 'nkEmail', text: '邮箱' }));
    var email = h('input', { id: 'nkEmail', type: 'email', autocomplete: 'email', inputmode: 'email', placeholder: 'you@example.com' });
    fieldEmail.appendChild(email);
    body.appendChild(fieldEmail);

    var fieldPass = h('div', { class: 'field' });
    fieldPass.appendChild(h('label', { for: 'nkPassword', text: '密码' }));
    var pass = h('input', { id: 'nkPassword', type: 'password', autocomplete: 'current-password', placeholder: '至少 8 位' });
    fieldPass.appendChild(pass);
    var hint = h('p', { class: 'field-hint', text: '密码至少 8 位。注册不需要邮箱验证码。' });
    fieldPass.appendChild(hint);
    fieldPass.appendChild(h('button', {
      class: 'auth-link', type: 'button', text: '忘记密码？申请重置',
      onclick: function () { openResetFlow(email.value.trim()); }
    }));
    body.appendChild(fieldPass);

    var errorLine = h('p', { class: 'account-error', hidden: true });
    body.appendChild(errorLine);

    var submit = h('button', { class: 'primary-btn account-submit', type: 'button', text: '登录' });
    var form = h('form', { class: 'account-auth-form' });
    form.appendChild(body);
    var foot = document.createDocumentFragment();
    foot.appendChild(h('span', { class: 'foot-left' }));
    foot.appendChild(h('button', { class: 'ghost-btn', type: 'button', text: '取消', onclick: A.closeModal }));
    foot.appendChild(submit);

    function syncMode() {
      tabs.querySelectorAll('button').forEach(function (b) { b.classList.remove('active'); });
      (current === 'login' ? loginTab : regTab).classList.add('active');
      pass.autocomplete = current === 'login' ? 'current-password' : 'new-password';
      submit.textContent = current === 'login' ? '登录' : '注册并登录';
      hint.textContent = current === 'login' ? '没有账号？切到「注册」。' : '密码至少 8 位。注册不需要邮箱验证码。';
      errorLine.hidden = true;
    }
    loginTab.addEventListener('click', function () { current = 'login'; syncMode(); });
    regTab.addEventListener('click', function () { current = 'register'; syncMode(); });
    syncMode();

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var payload = { email: email.value.trim(), password: pass.value };
      if (!payload.email || !payload.password) {
        errorLine.textContent = '请填写邮箱和密码';
        errorLine.hidden = false;
        return;
      }
      submit.disabled = true;
      submit.textContent = current === 'login' ? '登录中…' : '注册中…';
      errorLine.hidden = true;
      api(current === 'login' ? '/api/auth/login' : '/api/auth/register', {
        method: 'POST',
        body: payload
      }).then(function (data) {
        saveSession({ token: data.token, user: data.user, email: payload.email });
        me = data.user;
        A.closeModal();
        updateAccountBtn();
        A.toast(current === 'login' ? '已登录，正在同步云端' : '注册成功，已登录');
        startCloud();
      }).catch(function (err) {
        errorLine.textContent = errText(err);
        errorLine.hidden = false;
        submit.disabled = false;
        syncMode();
      });
    });

    submit.addEventListener('click', function () { form.requestSubmit(); });
    A.openModal({ kicker: 'ACCOUNT', title: '登录 NounKiller', body: form, foot: foot, autofocus: false });
    setTimeout(function () { email.focus(); }, 60);
  }

  function openResetFlow(presetEmail) {
    var body = h('div', { class: 'account-form' });
    var foot = h('div', { class: 'modal-foot-row' });
    var email = presetEmail || '';

    function renderRequest() {
      body.innerHTML = '';
      foot.innerHTML = '';
      body.appendChild(h('p', { class: 'account-intro', text: '输入注册邮箱，验证码会自动发送，输入验证码即可重置密码。' }));
      var fieldEmail = h('div', { class: 'field' });
      fieldEmail.appendChild(h('label', { for: 'nkResetEmail', text: '注册邮箱' }));
      var input = h('input', { id: 'nkResetEmail', type: 'email', autocomplete: 'email', inputmode: 'email', placeholder: 'you@example.com', value: email });
      fieldEmail.appendChild(input);
      fieldEmail.appendChild(h('p', { class: 'field-hint', text: '验证码会自动发送到注册邮箱，10 分钟内有效。' }));
      body.appendChild(fieldEmail);
      var error = h('p', { class: 'account-error', hidden: true });
      body.appendChild(error);
      var submit = h('button', { class: 'primary-btn account-submit', type: 'button', text: '提交申请' });
      foot.appendChild(h('span', { class: 'foot-left' }));
      foot.appendChild(h('button', { class: 'ghost-btn', type: 'button', text: '取消', onclick: A.closeModal }));
      foot.appendChild(submit);
      function run() {
        var value = input.value.trim();
        if (!value) { error.textContent = '请输入注册邮箱'; error.hidden = false; return; }
        submit.disabled = true; submit.textContent = '提交中…'; error.hidden = true;
        api('/api/auth/forgot', { method: 'POST', body: { email: value } }).then(function () {
          email = value;
          renderCode();
        }).catch(function (err) {
          error.textContent = errText(err); error.hidden = false;
          submit.disabled = false; submit.textContent = '提交申请';
        });
      }
      submit.addEventListener('click', run);
      input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); run(); } });
      setTimeout(function () { input.focus(); }, 60);
    }

    function renderCode() {
      body.innerHTML = '';
      foot.innerHTML = '';
      body.appendChild(h('p', { class: 'account-intro', text: '验证码已发送到该邮箱，10 分钟内有效；没收到可检查垃圾箱后重新申请。' }));
      body.appendChild(h('p', { class: 'confirm-text', text: '接收邮箱：' + email }));
      var fieldCode = h('div', { class: 'field' });
      fieldCode.appendChild(h('label', { for: 'nkResetCode', text: '验证码' }));
      fieldCode.appendChild(h('input', { id: 'nkResetCode', inputmode: 'numeric', maxlength: '6', placeholder: '6 位数字' }));
      body.appendChild(fieldCode);
      var fieldPass = h('div', { class: 'field' });
      fieldPass.appendChild(h('label', { for: 'nkResetPassword', text: '新密码' }));
      fieldPass.appendChild(h('input', { id: 'nkResetPassword', type: 'password', autocomplete: 'new-password', placeholder: '至少 8 位' }));
      body.appendChild(fieldPass);
      var fieldAgain = h('div', { class: 'field' });
      fieldAgain.appendChild(h('label', { for: 'nkResetAgain', text: '再输一次' }));
      fieldAgain.appendChild(h('input', { id: 'nkResetAgain', type: 'password', autocomplete: 'new-password', placeholder: '再次输入新密码' }));
      body.appendChild(fieldAgain);
      var error = h('p', { class: 'account-error', hidden: true });
      body.appendChild(error);
      var submit = h('button', { class: 'primary-btn account-submit', type: 'button', text: '重置并登录' });
      var back = h('button', { class: 'ghost-btn', type: 'button', text: '重新申请', onclick: renderRequest });
      foot.appendChild(h('span', { class: 'foot-left' }));
      foot.appendChild(back);
      foot.appendChild(submit);
      function run() {
        var code = body.querySelector('#nkResetCode').value.trim();
        var pass = body.querySelector('#nkResetPassword').value;
        var again = body.querySelector('#nkResetAgain').value;
        if (!/^\d{6}$/.test(code)) { error.textContent = '请输入 6 位验证码'; error.hidden = false; return; }
        if (pass.length < 8) { error.textContent = '新密码至少 8 位'; error.hidden = false; return; }
        if (pass !== again) { error.textContent = '两次输入的密码不一致'; error.hidden = false; return; }
        submit.disabled = true; submit.textContent = '重置中…'; error.hidden = true;
        api('/api/auth/reset', { method: 'POST', body: { email: email, code: code, password: pass } }).then(function (data) {
          saveSession({ token: data.token, user: data.user, email: email });
          me = data.user;
          A.closeModal();
          updateAccountBtn();
          A.toast('密码已重置，已登录并同步云端');
          startCloud();
        }).catch(function (err) {
          error.textContent = errText(err); error.hidden = false;
          submit.disabled = false; submit.textContent = '重置并登录';
        });
      }
      submit.addEventListener('click', run);
      setTimeout(function () { var el = body.querySelector('#nkResetCode'); if (el) el.focus(); }, 60);
    }

    renderRequest();
    A.openModal({ kicker: 'ACCOUNT', title: '找回密码', body: body, foot: foot, autofocus: false });
  }

  function logout() {
    api('/api/auth/logout', { method: 'POST' }).catch(function () { /* ignore */ });
    saveSession(null);
    me = null;
    cloudVersion = 0;
    lastHash = '';
    syncing = false;
    syncNote = '已退出登录';
    stopTimers();
    updateAccountBtn();
    A.closeModal();
    A.toast('已退出登录，本机数据保留');
  }

  /* ---------------- 云端同步 ---------------- */

  function canonPayload(p) {
    if (!p || typeof p !== 'object') return p;
    return Object.assign({}, p, {
      cards: (Array.isArray(p.cards) ? p.cards : []).map(function (c) {
        return Object.assign({}, c, {
          fav: c.fav === true,
          highlights: Array.isArray(c.highlights) ? c.highlights : []
        });
      })
    });
  }

  function payloadOf() {
    var s = A.state;
    return canonPayload({
      version: s.version,
      createdAt: s.createdAt,
      activeDeckId: s.activeDeckId,
      decks: s.decks,
      cards: s.cards.map(function (c) {
        return Object.assign({}, c, {
          fav: c.fav === true,
          highlights: Array.isArray(c.highlights) ? c.highlights : []
        });
      }),
      stats: s.stats,
      settings: s.settings
    });
  }

  function hashOf(obj) { return JSON.stringify(obj); }

  function countLocal() {
    var s = A.state;
    return {
      decks: s.decks.length,
      cards: s.cards.length,
      favorites: s.cards.filter(function (c) { return c.fav; }).length
    };
  }

  function syncStatusText() {
    if (!session) return '未登录。登录后可以把数据同步到云端。';
    if (syncing) return '正在同步…';
    return syncNote;
  }

  function setNote(text) {
    if (text !== undefined) syncNote = text;
    var node = $('#nkSyncNote');
    if (node) node.textContent = syncStatusText();
  }

  function adoptCloud(payload, updatedAt) {
    A.replaceState(payload);
    cloudVersion = updatedAt || 0;
    lastHash = hashOf(payloadOf());
    syncNote = '已载入云端数据 · ' + fmtTime(updatedAt);
    setNote();
  }

  function askConflict(remote, localOnly) {
    syncPaused = true;
    var local = countLocal();
    var body = h('div');
    body.appendChild(h('p', {
      class: 'account-intro',
      text: '云端已有一份数据（更新于 ' + fmtTime(remote.updatedAt) + '）。要使用哪一份？'
    }));
    body.appendChild(h('p', {
      class: 'account-intro',
      text: '本机：' + local.decks + ' 个题库 · ' + local.cards + ' 条词条 · ' + local.favorites + ' 条收藏'
    }));
    var remoteCount = { decks: 0, cards: 0 };
    try {
      remoteCount.decks = (remote.payload.decks || []).length;
      remoteCount.cards = (remote.payload.cards || []).length;
    } catch (e) { /* ignore */ }
    body.appendChild(h('p', {
      class: 'account-intro',
      text: '云端：' + remoteCount.decks + ' 个题库 · ' + remoteCount.cards + ' 条词条'
    }));
    var foot = document.createDocumentFragment();
    foot.appendChild(h('span', { class: 'foot-left' }));
    foot.appendChild(h('button', {
      class: 'ghost-btn', type: 'button', text: '稍后再说', onclick: function () {
        A.closeModal();
        syncPaused = true;
        syncNote = '已暂停自动同步，点「立即同步」重新选择';
        setNote();
      }
    }));
    foot.appendChild(h('button', {
      class: 'ghost-btn', type: 'button', text: '用本机覆盖', onclick: function () {
        A.closeModal();
        syncPaused = false;
        cloudVersion = remote.updatedAt;
        pushNow(true);
      }
    }));
    foot.appendChild(h('button', {
      class: 'primary-btn', type: 'button', text: '载入云端', onclick: function () {
        A.closeModal();
        syncPaused = false;
        adoptCloud(remote.payload, remote.updatedAt);
        A.toast('已载入云端数据');
      }
    }));
    A.openModal({ kicker: 'SYNC', title: localOnly ? '选择云端数据' : '同步冲突', body: body, foot: foot, autofocus: false });
  }

  function pullCloud(first) {
    if (!session) return Promise.resolve();
    return api('/api/me/data').then(function (data) {
      if (!data.payload) {
        syncPaused = false;
        cloudVersion = 0;
        lastHash = '';
        syncNote = '云端还没有数据';
        setNote();
        var local = countLocal();
        if (local.cards > 0) return pushNow(true);
        return null;
      }
      cloudVersion = data.updatedAt;
      var local = countLocal();
      var remotePayload = canonPayload(data.payload);
      var same = hashOf(payloadOf()) === hashOf(remotePayload);
      if (same) {
        syncPaused = false;
        lastHash = hashOf(payloadOf());
        syncNote = '已同步 · ' + fmtTime(data.updatedAt);
        setNote();
        return null;
      }
      if (first) {
        if (local.cards === 0) {
          adoptCloud(remotePayload, data.updatedAt);
          A.toast('已载入云端数据');
        } else {
          askConflict({ payload: remotePayload, updatedAt: data.updatedAt }, true);
        }
        return null;
      }
      askConflict({ payload: remotePayload, updatedAt: data.updatedAt }, false);
      return null;
    }).catch(function (err) {
      if (err.status === 401) return handleExpired();
      syncNote = '同步失败：' + errText(err);
      setNote();
    });
  }

  function pushNow(force) {
    if (!session || syncing) return Promise.resolve();
    var payload = payloadOf();
    var hash = hashOf(payload);
    if (!force && (hash === lastHash || !lastHash || syncPaused)) return Promise.resolve();
    syncing = true;
    setNote();
    return api('/api/me/data', {
      method: 'PUT',
      body: { baseVersion: cloudVersion, payload: payload }
    }).then(function (data) {
      cloudVersion = data.updatedAt;
      lastHash = hash;
      syncNote = '已同步 · ' + fmtTime(data.updatedAt);
      syncing = false;
      setNote();
    }).catch(function (err) {
      syncing = false;
      if (err.status === 401) return handleExpired();
      if (err.status === 409 && err.data && err.data.payload) {
        syncPaused = true;
        askConflict({ payload: err.data.payload, updatedAt: err.data.updatedAt }, false);
        syncNote = '云端有新数据，等待选择';
        setNote();
        return;
      }
      syncNote = '同步失败：' + errText(err);
      setNote();
    });
  }

  function watchChanges() {
    if (!session || syncPaused) return;
    var hash = hashOf(payloadOf());
    if (hash !== lastHash && !syncing) pushNow(false);
  }

  function handleExpired() {
    saveSession(null);
    me = null;
    unread = 0;
    stopTimers();
    updateAccountBtn();
    A.toast('登录已过期，请重新登录');
  }

  function heartbeat() {
    if (!session) return;
    api('/api/presence', {
      method: 'POST',
      body: { state: document.visibilityState === 'hidden' ? 'away' : 'online' }
    }).then(function (data) {
      if (session && data && typeof data.unread === 'number') setBadge(data.unread);
    }).catch(function () { /* offline is fine */ });
  }

  function startTimers() {
    stopTimers();
    syncTimer = setInterval(watchChanges, 3000);
    heartbeatTimer = setInterval(heartbeat, 30000);
    document.addEventListener('visibilitychange', onVisibility);
  }

  function stopTimers() {
    if (syncTimer) clearInterval(syncTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (pollTimer) clearInterval(pollTimer);
    syncTimer = null;
    heartbeatTimer = null;
    pollTimer = null;
    document.removeEventListener('visibilitychange', onVisibility);
  }

  function onVisibility() {
    if (!session) return;
    heartbeat();
    if (document.visibilityState === 'visible') {
      fetchUnread();
      watchChanges();
    } else {
      pushNow(false);
    }
  }

  function fetchUnread() {
    if (!session) return;
    api('/api/me').then(function (data) {
      me = data.user;
      setBadge(data.unread);
    }).catch(function (err) {
      if (err.status === 401) handleExpired();
    });
  }

  function startCloud() {
    startTimers();
    heartbeat();
    fetchUnread();
    pullCloud(true);
  }

  /* ---------------- 账号面板 ---------------- */

  function manualSync() {
    if (!session) return openAuth('login');
    syncPaused = false;
    A.toast('正在检查云端…');
    pullCloud(false).then(function () {
      if (!syncPaused) pushNow(true);
    });
  }

  function openAccount() {
    if (!session) return openAuth('login');
    var body = h('div', { class: 'account-panel' });
    var local = countLocal();
    body.appendChild(h('div', { class: 'account-head' }));
    var head = body.firstChild;
    head.appendChild(h('div', { class: 'account-email', text: me ? me.email : session.email }));
    head.appendChild(h('div', {
      class: 'account-role',
      text: me && me.isAdmin ? '管理员' : '已登录'
    }));

    var status = h('div', { class: 'account-status' });
    status.appendChild(h('i', { class: 'cloud-dot', 'aria-hidden': 'true' }));
    status.appendChild(h('span', { id: 'nkSyncNote', text: syncStatusText() }));
    body.appendChild(status);

    var stats = h('div', { class: 'account-stats' });
    [['题库', local.decks], ['词条', local.cards], ['收藏', local.favorites]].forEach(function (item) {
      var cell = h('div', { class: 'account-stat' });
      cell.appendChild(h('strong', { text: String(item[1]) }));
      cell.appendChild(h('span', { text: item[0] }));
      stats.appendChild(cell);
    });
    body.appendChild(stats);

    var actions = h('div', { class: 'account-actions' });
    actions.appendChild(h('button', {
      class: 'ghost-btn', type: 'button', text: '立即同步',
      onclick: manualSync
    }));
    actions.appendChild(h('button', {
      class: 'ghost-btn', type: 'button', text: unread ? '留言（' + unread + '）' : '留言',
      onclick: openMessages
    }));
    if (me && me.isAdmin) {
      actions.appendChild(h('button', {
        class: 'ghost-btn', type: 'button', text: '管理后台',
        onclick: openAdmin
      }));
    }
    body.appendChild(actions);

    body.appendChild(h('p', {
      class: 'account-foot-note',
      text: '云端保存题库、词条、SRS 进度、划线、收藏与设置。换设备登录后选择「载入云端」即可接着背。'
    }));

    var foot = document.createDocumentFragment();
    foot.appendChild(h('span', { class: 'foot-left' }));
    foot.appendChild(h('button', { class: 'ghost-btn', type: 'button', text: '退出登录', onclick: logout }));
    foot.appendChild(h('button', { class: 'primary-btn', type: 'button', text: '完成', onclick: A.closeModal }));

    A.openModal({ kicker: 'ACCOUNT', title: '账号与云端', body: body, foot: foot, autofocus: false });
  }

  /* ---------------- 留言 ---------------- */

  function messageBubble(msg) {
    var row = h('div', { class: 'msg-row ' + (msg.sender === 'admin' ? 'from-admin' : 'from-user') });
    var bubble = h('div', { class: 'msg-bubble' });
    bubble.appendChild(h('div', { class: 'msg-body', text: msg.body }));
    bubble.appendChild(h('div', { class: 'msg-time', text: fmtTime(msg.created_at) }));
    row.appendChild(bubble);
    return row;
  }

  function renderThread(container, messages) {
    container.innerHTML = '';
    if (!messages.length) {
      container.appendChild(h('p', { class: 'thread-empty', text: '还没有留言。写下第一条，管理员会在后台看到。' }));
      return;
    }
    messages.forEach(function (msg) { container.appendChild(messageBubble(msg)); });
    container.scrollTop = container.scrollHeight;
  }

  function composer(onSend, placeholder) {
    var wrap = h('div', { class: 'thread-composer' });
    var input = h('textarea', { rows: '2', maxlength: '2000', placeholder: placeholder || '写留言…' });
    var send = h('button', { class: 'primary-btn', type: 'button', text: '发送' });
    function submit() {
      var text = input.value.trim();
      if (!text) return;
      send.disabled = true;
      onSend(text).then(function () {
        input.value = '';
        send.disabled = false;
      }).catch(function (err) {
        send.disabled = false;
        A.toast(errText(err));
      });
    }
    send.addEventListener('click', submit);
    input.addEventListener('keydown', function (e) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submit();
    });
    wrap.appendChild(input);
    wrap.appendChild(send);
    return { wrap: wrap, focus: function () { input.focus(); } };
  }


  function stopGroupPoll() {
    if (groupPollTimer) { clearInterval(groupPollTimer); groupPollTimer = null; }
  }

  function openGroup() {
    if (!session) return openAuth('login');
    stopGroupPoll();
    var body = h('div', { class: 'group-panel' });
    var head = h('div', { class: 'group-list-head' });
    head.appendChild(h('div', { class: 'group-list-title', text: '我的群组' }));
    var inboxBtn = h('button', {
      class: 'ghost-btn group-inbox-btn', type: 'button', text: '消息',
      onclick: openGroupInbox
    });
    head.appendChild(inboxBtn);
    body.appendChild(head);

    var list = h('div', { class: 'group-list' });
    body.appendChild(list);

    function render(groups) {
      list.innerHTML = '';
      if (!groups.length) {
        list.appendChild(h('p', {
          class: 'group-empty',
          text: '还没有加入群组。创建自己的群，或输入 8 位群号申请加入。'
        }));
        return;
      }
      groups.forEach(function (g) {
        var row = h('button', {
          class: 'group-item', type: 'button',
          onclick: function () { openGroupChat(g); }
        });
        row.appendChild(h('span', { class: 'group-item-mark', text: '题' }));
        var main = h('span', { class: 'group-item-main' });
        var title = h('span', { class: 'group-item-name', text: g.name });
        if (g.role === 'owner') title.appendChild(h('em', { class: 'group-tag', text: '群主' }));
        main.appendChild(title);
        main.appendChild(h('span', {
          class: 'group-item-meta',
          text: '群号 ' + g.groupNo + ' · ' + (g.memberCount || 1) + ' 人'
        }));
        row.appendChild(main);
        list.appendChild(row);
      });
    }

    function load() {
      return api('/api/group/list').then(function (data) {
        render(data.groups || []);
      }).catch(function (err) {
        list.innerHTML = '';
        list.appendChild(h('p', { class: 'group-empty', text: errText(err) }));
      }).then(function () {
        api('/api/group/inbox').then(function (data) {
          var n = (data.invites || []).length + (data.joinRequests || []).length;
          inboxBtn.textContent = n ? '消息（' + n + '）' : '消息';
          inboxBtn.classList.toggle('has-badge', n > 0);
        }).catch(function () { /* 消息数只是提示 */ });
      });
    }

    var foot = document.createDocumentFragment();
    foot.appendChild(h('button', {
      class: 'ghost-btn', type: 'button', text: '创建群组', onclick: openGroupCreate
    }));
    foot.appendChild(h('button', {
      class: 'ghost-btn', type: 'button', text: '加入群组', onclick: openGroupJoin
    }));
    foot.appendChild(h('button', {
      class: 'primary-btn', type: 'button', text: '关闭', onclick: A.closeModal
    }));

    A.openModal({ kicker: 'GROUP', title: '群组题库', body: body, foot: foot, autofocus: false });
    load();
  }

  function openGroupCreate() {
    if (!session) return openAuth('login');
    stopGroupPoll();
    var body = h('div', { class: 'group-form' });
    body.appendChild(h('p', { class: 'group-note', text: '你会成为群主。群号由系统随机生成，共 8 位数字。' }));
    var input = h('input', {
      class: 'text-input', type: 'text', maxlength: '30',
      placeholder: '例如：传播学名词解释', 'aria-label': '群名'
    });
    body.appendChild(input);
    var error = h('p', { class: 'account-error', hidden: true });
    body.appendChild(error);
    var btn = h('button', { class: 'primary-btn', type: 'button', text: '创建' });

    function submit() {
      var name = input.value.trim();
      if (!name) return A.toast('给群组起个名字');
      btn.disabled = true;
      btn.textContent = '创建中…';
      api('/api/group/create', { method: 'POST', body: { name: name } }).then(function (data) {
        A.toast('群组已创建，群号 ' + data.group.groupNo);
        openGroup();
      }).catch(function (err) {
        error.textContent = errText(err);
        error.hidden = false;
        btn.disabled = false;
        btn.textContent = '创建';
      });
    }
    btn.addEventListener('click', submit);
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); });

    var foot = document.createDocumentFragment();
    foot.appendChild(h('button', { class: 'ghost-btn', type: 'button', text: '返回', onclick: openGroup }));
    foot.appendChild(btn);
    A.openModal({ kicker: 'GROUP', title: '创建群组', body: body, foot: foot });
    setTimeout(function () { input.focus(); }, 60);
  }

  function openGroupJoin() {
    if (!session) return openAuth('login');
    stopGroupPoll();
    var body = h('div', { class: 'group-form' });
    body.appendChild(h('p', { class: 'group-note', text: '输入群主分享的 8 位群号，申请加入后等待群主通过。' }));
    var input = h('input', {
      class: 'text-input', type: 'text', inputmode: 'numeric', maxlength: '8',
      placeholder: '8 位群号', 'aria-label': '群号'
    });
    body.appendChild(input);
    var error = h('p', { class: 'account-error', hidden: true });
    body.appendChild(error);
    var btn = h('button', { class: 'primary-btn', type: 'button', text: '申请加入' });

    function submit() {
      var no = input.value.replace(/\s+/g, '');
      if (!/^\d{8}$/.test(no)) {
        error.textContent = '群号应为 8 位数字';
        error.hidden = false;
        input.focus();
        return;
      }
      btn.disabled = true;
      btn.textContent = '提交中…';
      api('/api/group/join', { method: 'POST', body: { groupNo: no } }).then(function (data) {
        if (data.already) A.toast('你已经在这个群里了');
        else A.toast('申请已提交，等待群主通过');
        openGroup();
      }).catch(function (err) {
        error.textContent = errText(err);
        error.hidden = false;
        btn.disabled = false;
        btn.textContent = '申请加入';
      });
    }
    btn.addEventListener('click', submit);
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); });

    var foot = document.createDocumentFragment();
    foot.appendChild(h('button', { class: 'ghost-btn', type: 'button', text: '返回', onclick: openGroup }));
    foot.appendChild(btn);
    A.openModal({ kicker: 'GROUP', title: '加入群组', body: body, foot: foot });
    setTimeout(function () { input.focus(); }, 60);
  }

  function openGroupInbox() {
    if (!session) return openAuth('login');
    stopGroupPoll();
    var body = h('div', { class: 'group-inbox' });
    var list = h('div', { class: 'group-inbox-list' });
    body.appendChild(list);

    function respond(path, payload, message) {
      return api(path, { method: 'POST', body: payload }).then(function () {
        A.toast(message);
        return load();
      }).catch(function (err) { A.toast(errText(err)); });
    }

    function decisionButtons(onAccept, onReject) {
      var wrap = h('div', { class: 'group-row-actions' });
      wrap.appendChild(h('button', {
        class: 'ghost-btn danger-text', type: 'button', text: '拒绝', onclick: onReject
      }));
      wrap.appendChild(h('button', {
        class: 'ghost-btn', type: 'button', text: '接受', onclick: onAccept
      }));
      return wrap;
    }

    function render(data) {
      list.innerHTML = '';
      var invites = data.invites || [];
      var joins = data.joinRequests || [];
      if (!invites.length && !joins.length) {
        list.appendChild(h('p', { class: 'group-empty', text: '没有待处理的消息。' }));
        return;
      }
      if (invites.length) {
        list.appendChild(h('div', { class: 'group-section-label', text: '邀请我加入' }));
        invites.forEach(function (item) {
          var row = h('div', { class: 'group-row' });
          var main = h('div', { class: 'group-row-main' });
          main.appendChild(h('div', { class: 'group-row-title', text: item.name }));
          main.appendChild(h('div', {
            class: 'group-row-meta',
            text: '群号 ' + item.groupNo + ' · 邀请人 ' + item.inviter
          }));
          row.appendChild(main);
          row.appendChild(decisionButtons(
            function () { respond('/api/group/invite/respond', { inviteId: item.id, accept: true }, '已加入群组'); },
            function () { respond('/api/group/invite/respond', { inviteId: item.id, accept: false }, '已拒绝邀请'); }
          ));
          list.appendChild(row);
        });
      }
      if (joins.length) {
        list.appendChild(h('div', { class: 'group-section-label', text: '入群申请（我管理的群）' }));
        joins.forEach(function (item) {
          var row = h('div', { class: 'group-row' });
          var main = h('div', { class: 'group-row-main' });
          main.appendChild(h('div', { class: 'group-row-title', text: item.name }));
          main.appendChild(h('div', {
            class: 'group-row-meta',
            text: '群号 ' + item.groupNo + ' · 申请人 ' + item.user
          }));
          row.appendChild(main);
          row.appendChild(decisionButtons(
            function () { respond('/api/group/request/respond', { requestId: item.id, accept: true }, '已同意入群'); },
            function () { respond('/api/group/request/respond', { requestId: item.id, accept: false }, '已拒绝申请'); }
          ));
          list.appendChild(row);
        });
      }
    }

    function load() {
      return api('/api/group/inbox').then(function (data) {
        render(data);
      }).catch(function (err) {
        list.innerHTML = '';
        list.appendChild(h('p', { class: 'group-empty', text: errText(err) }));
      });
    }

    var foot = document.createDocumentFragment();
    foot.appendChild(h('button', { class: 'ghost-btn', type: 'button', text: '返回群组列表', onclick: openGroup }));
    foot.appendChild(h('button', { class: 'primary-btn', type: 'button', text: '关闭', onclick: A.closeModal }));

    A.openModal({ kicker: 'GROUP', title: '群组消息', body: body, foot: foot, autofocus: false });
    load();
  }

  function openGroupChat(group) {
    if (!session) return openAuth('login');
    stopGroupPoll();
    var body = h('div', { class: 'thread-panel group-panel group-chat' });

    var head = h('div', { class: 'group-chat-head' });
    var info = h('div', { class: 'group-chat-info' });
    info.appendChild(h('div', { class: 'group-chat-name', text: group.name }));
    info.appendChild(h('div', {
      class: 'group-row-meta',
      text: '群号 ' + group.groupNo + ' · ' + (group.memberCount || 1) + ' 人'
    }));
    head.appendChild(info);
    body.appendChild(head);

    var list = h('div', { class: 'thread-list' });
    body.appendChild(list);
    var previewing = false;

    function goBack() {
      if (previewing) {
        previewing = false;
        load();
        resumePoll();
        return;
      }
      stopGroupPoll();
      openGroup();
    }

    var sel = h('select', { class: 'group-attach-select', 'aria-label': '附带题库', title: '附带题库' });
    sel.appendChild(h('option', { value: '', text: '只发文字' }));
    ((A.store && A.store.state && A.store.state.decks) || []).forEach(function (deck) {
      sel.appendChild(h('option', { value: deck.id, text: deck.name }));
    });
    var attach = h('label', { class: 'group-attach' });
    attach.appendChild(h('span', {
      class: 'group-attach-icon',
      html: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M13.8 7.2 7.1 13.9a2.2 2.2 0 0 1-3.1-3.1l6.4-6.4a3.3 3.3 0 0 1 4.7 4.7l-6.2 6.2a1.6 1.6 0 0 1-2.3-2.3l5.6-5.6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>'
    }));
    attach.appendChild(sel);

    var chip = h('div', { class: 'group-attach-chip', hidden: true });
    function syncAttach() {
      chip.innerHTML = '';
      var deck = sel.value ? A.store.deckById(sel.value) : null;
      if (!deck) {
        chip.hidden = true;
        attach.classList.remove('on');
        return;
      }
      chip.hidden = false;
      attach.classList.add('on');
      chip.appendChild(h('span', { text: '附带：' + deck.name }));
      chip.appendChild(h('button', {
        class: 'group-attach-clear', type: 'button', text: '✕',
        'aria-label': '取消附带题库',
        onclick: function () { sel.value = ''; syncAttach(); }
      }));
    }
    sel.addEventListener('change', syncAttach);

    var input = h('textarea', { placeholder: '在群里说点什么…', 'aria-label': '群组消息' });
    var send = h('button', {
      class: 'primary-btn group-send-btn', type: 'button', 'aria-label': '发送', title: '发送',
      html: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3.4 10.2 17 4l-4.7 12.1-2.5-4.8-6.4-1.1Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M9.8 11.3 17 4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>'
    });
    var row = h('div', { class: 'thread-composer group-composer' });
    row.appendChild(attach);
    row.appendChild(input);
    row.appendChild(send);
    body.appendChild(chip);
    body.appendChild(row);

    function importDeckMessage(msg) {
      api('/api/group/import', { method: 'POST', body: { messageId: msg.id } }).then(function (data) {
        var res = A.importDeck(data.deckName, data.cards);
        if (!res || !res.added) return A.toast('题库里没有新词条');
        A.toast('已获取 ' + res.added + ' 条到「' + res.deck.name + '」');
      }).catch(function (err) {
        A.toast(errText(err));
      }).then(function () {
        openGroupChat(group);
      });
    }

    function confirmImport(msg) {
      A.askConfirm('GROUP', '获取题库',
        '把「' + (msg.deckName || '题库') + '」的 ' + (msg.deckCount || 0) + ' 条词条存进我的题库？',
        '获取',
        function () { importDeckMessage(msg); },
        function () { openGroupChat(group); });
    }

    function resumePoll() {
      stopGroupPoll();
      groupPollTimer = trackModalTimer(setInterval(load, 7000));
    }

    function previewMessage(msg) {
      stopGroupPoll();
      api('/api/group/deck?messageId=' + encodeURIComponent(msg.id)).then(function (data) {
        renderPreview(msg, data);
      }).catch(function (err) {
        A.toast(errText(err));
        load();
        resumePoll();
      });
    }

    function renderPreview(msg, data) {
      previewing = true;
      list.innerHTML = '';
      var head = h('div', { class: 'deck-preview-head' });
      head.appendChild(h('div', { class: 'deck-preview-title', text: data.deckName || msg.deckName || '题库' }));
      head.appendChild(h('span', { class: 'group-row-meta', text: data.cards.length + ' 条词条' }));
      list.appendChild(head);
      data.cards.forEach(function (card) {
        var item = h('div', { class: 'deck-preview-card' });
        item.appendChild(h('div', { class: 'deck-preview-term', text: card.term }));
        item.appendChild(h('div', { class: 'deck-preview-def', text: card.def }));
        list.appendChild(item);
      });
      list.scrollTop = 0;
    }

    function bubble(msg) {
      var mine = msg.mine === true;
      var wrap = h('div', { class: 'msg-row ' + (mine ? 'from-user' : 'from-admin') });
      var content = h('div', { class: 'msg-bubble' });
      content.appendChild(h('div', { class: 'msg-who', text: mine ? '我' : (msg.name || '同学') }));
      if (msg.body) content.appendChild(h('div', { class: 'msg-body', text: msg.body }));
      if (msg.kind === 'deck') {
        var card = h('div', { class: 'msg-deck' });
        card.appendChild(h('div', { class: 'msg-deck-name', text: msg.deckName || '题库' }));
        card.appendChild(h('div', { class: 'msg-deck-meta', text: (msg.deckCount || 0) + ' 条词条' }));
        var actions = h('div', { class: 'msg-deck-actions' });
        var prev = h('button', { class: 'msg-deck-btn', type: 'button', text: '预览' });
        prev.addEventListener('click', function () { previewMessage(msg); });
        var imp = h('button', { class: 'msg-deck-btn', type: 'button', text: '获取' });
        imp.addEventListener('click', function () { confirmImport(msg); });
        actions.appendChild(prev);
        actions.appendChild(imp);
        card.appendChild(actions);
        content.appendChild(card);
      }
      content.appendChild(h('div', { class: 'msg-time', text: fmtTime(msg.createdAt) }));
      wrap.appendChild(content);
      return wrap;
    }

    function render(messages) {
      list.innerHTML = '';
      if (!messages.length) {
        list.appendChild(h('p', {
          class: 'thread-empty',
          text: '群组还很安静。发一句话，或把自己的题库分享出来。'
        }));
        return;
      }
      messages.forEach(function (m) { list.appendChild(bubble(m)); });
      list.scrollTop = list.scrollHeight;
    }

    function load() {
      return api('/api/group/messages?groupId=' + encodeURIComponent(group.id)).then(function (data) {
        render(data.messages || []);
      }).catch(function (err) {
        list.innerHTML = '';
        list.appendChild(h('p', { class: 'thread-empty', text: errText(err) }));
      });
    }

    function submit() {
      var text = input.value.trim();
      var deckId = sel.value;
      if (!text && !deckId) return A.toast('写点什么，或选一个题库');
      var payload = { groupId: group.id, body: text };
      if (deckId) {
        var deck = A.store.deckById(deckId);
        var cards = A.store.deckCards(deckId).map(function (c) {
          return { term: c.term, def: c.def };
        });
        if (!cards.length) return A.toast('这个题库还没有词条');
        payload.deck = { name: deck ? deck.name : '群组题库', cards: cards };
      }
      send.disabled = true;
      api('/api/group/messages', { method: 'POST', body: payload }).then(function () {
        input.value = '';
        sel.value = '';
        syncAttach();
        previewing = false;
        return load().then(resumePoll);
      }).catch(function (err) {
        A.toast(errText(err));
      }).then(function () {
        send.disabled = false;
      });
    }
    send.addEventListener('click', submit);
    input.addEventListener('keydown', function (e) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submit();
    });

    load();
    resumePoll();

    var foot = document.createDocumentFragment();
    foot.appendChild(h('span', { class: 'foot-left', text: '群里任何人都能导入你分享的题库' }));
    foot.appendChild(h('button', {
      class: 'primary-btn', type: 'button', text: '返回',
      onclick: goBack
    }));

    var settingsBtn = h('button', {
      class: 'icon-btn', type: 'button', 'aria-label': '群设置', title: '群设置',
      html: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 6.5h4.2M11.8 6.5H17M3 13.5h8.2M15.8 13.5H17" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="9.5" cy="6.5" r="2.1" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="13.5" cy="13.5" r="2.1" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
      onclick: function () { openGroupSettings(group); }
    });
    A.openModal({
      kicker: 'GROUP', title: '群聊', body: body, foot: foot,
      action: settingsBtn, autofocus: false
    });
    setTimeout(function () { input.focus(); }, 60);
  }

  function openGroupSettings(group) {
    if (!session) return openAuth('login');
    stopGroupPoll();
    var body = h('div', { class: 'group-settings' });
    var panel = h('div', { class: 'group-settings-body' });
    body.appendChild(panel);

    function act(path, payload, message) {
      return api(path, { method: 'POST', body: payload }).then(function () {
        A.toast(message);
        return load();
      }).catch(function (err) { A.toast(errText(err)); });
    }

    function render(data) {
      var g = data.group;
      var isOwner = data.isOwner === true;
      panel.innerHTML = '';

      panel.appendChild(h('div', { class: 'group-settings-name', text: g.name }));
      panel.appendChild(h('div', {
        class: 'group-row-meta',
        text: '群号 ' + g.groupNo + ' · ' + (g.memberCount || data.members.length) + ' 人'
      }));

      if (isOwner) {
        var renameRow = h('div', { class: 'group-inline-form' });
        var nameInput = h('input', {
          class: 'text-input', type: 'text', maxlength: '30',
          value: g.name, 'aria-label': '群名'
        });
        var saveName = h('button', { class: 'ghost-btn', type: 'button', text: '修改群名' });
        saveName.addEventListener('click', function () {
          var name = nameInput.value.trim();
          if (!name) return A.toast('群名不能为空');
          saveName.disabled = true;
          api('/api/group/rename', { method: 'POST', body: { groupId: g.id, name: name } })
            .then(function (res) {
              g.name = res.name;
              A.toast('群名已修改');
              return load();
            })
            .catch(function (err) {
              A.toast(errText(err));
              saveName.disabled = false;
            });
        });
        renameRow.appendChild(nameInput);
        renameRow.appendChild(saveName);
        panel.appendChild(renameRow);
      }

      panel.appendChild(h('div', {
        class: 'group-section-label', text: '成员（' + data.members.length + '）'
      }));
      data.members.forEach(function (m) {
        var row = h('div', { class: 'group-row' });
        var main = h('div', { class: 'group-row-main' });
        var name = h('div', { class: 'group-row-title', text: m.name + (m.me ? '（我）' : '') });
        if (m.owner) name.appendChild(h('em', { class: 'group-tag', text: '群主' }));
        main.appendChild(name);
        main.appendChild(h('div', { class: 'group-row-meta', text: m.email }));
        row.appendChild(main);
        if (isOwner && !m.owner && !m.me) {
          row.appendChild(h('button', {
            class: 'ghost-btn danger-text', type: 'button', text: '移出',
            onclick: function () {
              A.askConfirm('GROUP', '移出成员', '把 ' + m.name + ' 移出这个群？', '移出', function () {
                act('/api/group/kick', { groupId: g.id, userId: m.userId }, '已移出成员');
              });
            }
          }));
        }
        panel.appendChild(row);
      });

      panel.appendChild(h('div', { class: 'group-section-label', text: '邀请成员' }));
      var inviteRow = h('div', { class: 'group-inline-form' });
      var emailInput = h('input', {
        class: 'text-input', type: 'email', placeholder: '对方的注册邮箱',
        'aria-label': '邀请邮箱'
      });
      var inviteBtn = h('button', { class: 'ghost-btn', type: 'button', text: '邀请' });
      inviteBtn.addEventListener('click', function () {
        var email = emailInput.value.trim();
        if (!email) return A.toast('填写要邀请的邮箱');
        inviteBtn.disabled = true;
        api('/api/group/invite', { method: 'POST', body: { groupId: g.id, email: email } })
          .then(function () { A.toast('已发出邀请'); emailInput.value = ''; })
          .catch(function (err) { A.toast(errText(err)); })
          .then(function () { inviteBtn.disabled = false; });
      });
      inviteRow.appendChild(emailInput);
      inviteRow.appendChild(inviteBtn);
      panel.appendChild(inviteRow);

      if (isOwner && data.joinRequests.length) {
        panel.appendChild(h('div', { class: 'group-section-label', text: '入群申请' }));
        data.joinRequests.forEach(function (r) {
          var row = h('div', { class: 'group-row' });
          var main = h('div', { class: 'group-row-main' });
          main.appendChild(h('div', { class: 'group-row-title', text: r.name }));
          main.appendChild(h('div', { class: 'group-row-meta', text: r.email }));
          row.appendChild(main);
          var actions = h('div', { class: 'group-row-actions' });
          actions.appendChild(h('button', {
            class: 'ghost-btn danger-text', type: 'button', text: '拒绝',
            onclick: function () {
              act('/api/group/request/respond', { requestId: r.id, accept: false }, '已拒绝申请');
            }
          }));
          actions.appendChild(h('button', {
            class: 'ghost-btn', type: 'button', text: '同意',
            onclick: function () {
              act('/api/group/request/respond', { requestId: r.id, accept: true }, '已同意入群');
            }
          }));
          row.appendChild(actions);
          panel.appendChild(row);
        });
      }

      panel.appendChild(h('div', {
        class: 'group-section-label', text: '群文件（' + data.files.length + '）'
      }));
      if (!data.files.length) {
        panel.appendChild(h('p', { class: 'group-note', text: '还没有人分享题库。在群聊里发送一个题库就会出现在这里。' }));
      }
      data.files.forEach(function (f) {
        var row = h('div', { class: 'group-row' });
        var main = h('div', { class: 'group-row-main' });
        main.appendChild(h('div', { class: 'group-row-title', text: f.deckName || '题库' }));
        main.appendChild(h('div', {
          class: 'group-row-meta',
          text: f.name + ' · ' + (f.deckCount || 0) + ' 条 · ' + fmtTime(f.createdAt)
        }));
        row.appendChild(main);
        var actions = h('div', { class: 'group-row-actions' });
        var imp = h('button', { class: 'ghost-btn', type: 'button', text: '导入' });
        imp.addEventListener('click', function () {
          A.askConfirm('GROUP', '导入题库',
            '把「' + (f.deckName || '题库') + '」的 ' + (f.deckCount || 0) + ' 条词条并入我的题库？',
            '导入',
            function () {
              api('/api/group/import', { method: 'POST', body: { messageId: f.id } }).then(function (res) {
                var out = A.importDeck(res.deckName, res.cards);
                A.toast(out && out.added ? '已导入 ' + out.added + ' 条' : '题库里没有新词条');
              }).catch(function (err) {
                A.toast(errText(err));
              }).then(function () { openGroupSettings(group); });
            },
            function () { openGroupSettings(group); });
        });
        actions.appendChild(imp);

        var drop = h('button', {
          class: 'ghost-btn' + (isOwner ? ' danger-text' : ''),
          type: 'button', text: isOwner ? '删除' : '忽略'
        });
        drop.addEventListener('click', function () {
          if (isOwner) {
            A.askConfirm('GROUP', '删除群文件',
              '删除后，群聊里的这条分享和群文件都会消失，确定吗？',
              '删除', function () {
                api('/api/group/file/delete', { method: 'POST', body: { messageId: f.id } })
                  .then(function () { A.toast('已删除'); openGroupSettings(group); })
                  .catch(function (err) { A.toast(errText(err)); openGroupSettings(group); });
              }, function () { openGroupSettings(group); });
            return;
          }
          A.askConfirm('GROUP', '忽略题库',
            '忽略后，这条题库不再出现在你的群文件里（聊天记录仍保留）。',
            '忽略', function () {
              api('/api/group/file/ignore', { method: 'POST', body: { messageId: f.id } })
                .then(function () { A.toast('已忽略'); openGroupSettings(group); })
                .catch(function (err) { A.toast(errText(err)); openGroupSettings(group); });
            }, function () { openGroupSettings(group); });
        });
        actions.appendChild(drop);
        row.appendChild(actions);
        panel.appendChild(row);
      });

      var leave = h('button', { class: 'danger-btn group-leave', type: 'button', text: '退出群组' });
      leave.addEventListener('click', function () {
        var message = '退出后需要重新申请或被邀请才能回来。';
        if (g.ownerId === (me && me.id)) {
          message = g.memberCount > 1 || data.members.length > 1
            ? '你是群主，退出后群主会自动转给最早加入的成员。'
            : '你是最后一名成员，退出后这个群和所有群文件都会被删除。';
        }
        A.askConfirm('GROUP', '退出群组', message, '退出', function () {
          api('/api/group/leave', { method: 'POST', body: { groupId: g.id } }).then(function (res) {
            A.toast(res.deleted ? '群组已解散' : '已退出群组');
            openGroup();
          }).catch(function (err) { A.toast(errText(err)); });
        }, function () { openGroupSettings(group); });
      });
      panel.appendChild(leave);
    }

    function load() {
      return api('/api/group/settings?groupId=' + encodeURIComponent(group.id)).then(function (data) {
        group.name = data.group.name;
        group.groupNo = data.group.groupNo;
        group.memberCount = data.group.memberCount;
        render(data);
      }).catch(function (err) {
        panel.innerHTML = '';
        panel.appendChild(h('p', { class: 'group-empty', text: errText(err) }));
      });
    }

    var foot = document.createDocumentFragment();
    foot.appendChild(h('span', { class: 'foot-left' }));
    foot.appendChild(h('button', {
      class: 'primary-btn', type: 'button', text: '返回',
      onclick: function () { openGroupChat(group); }
    }));

    A.openModal({ kicker: 'GROUP', title: '群设置', body: body, foot: foot, autofocus: false });
    load();
  }

  function openMessages() {
    if (!session) return openAuth('login');
    var body = h('div', { class: 'thread-panel' });
    var list = h('div', { class: 'thread-list' });
    body.appendChild(list);
    var comp = composer(function (text) {
      return api('/api/messages', { method: 'POST', body: { body: text } }).then(load);
    });
    body.appendChild(comp.wrap);

    function load() {
      return api('/api/messages').then(function (data) {
        renderThread(list, data.messages || []);
        setBadge(0);
      }).catch(function (err) {
        list.innerHTML = '';
        list.appendChild(h('p', { class: 'thread-empty', text: errText(err) }));
      });
    }
    load();
    pollTimer = trackModalTimer(setInterval(load, 8000));

    var foot = document.createDocumentFragment();
    foot.appendChild(h('span', { class: 'foot-left', text: '管理员回复会出现在这里' }));
    foot.appendChild(h('button', { class: 'ghost-btn', type: 'button', text: '关闭', onclick: function () {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
      A.closeModal();
    } }));

    A.openModal({ kicker: 'MESSAGES', title: '留言', body: body, foot: foot, autofocus: false });
    setTimeout(function () { comp.focus(); }, 60);
  }

  /* ---------------- 管理后台 ---------------- */

  function openAdmin() {
    if (!me || !me.isAdmin) return;
    var body = h('div', { class: 'admin-panel' });
    var tabs = h('div', { class: 'segmented account-tabs' });
    var usersTab = h('button', { type: 'button', class: 'active', text: '用户' });
    tabs.appendChild(usersTab);
    body.appendChild(tabs);

    var toolbar = h('div', { class: 'admin-toolbar' });
    var summary = h('span', { class: 'admin-summary', text: '加载中…' });
    var refresh = h('button', { class: 'ghost-btn admin-refresh', type: 'button', text: '刷新' });
    toolbar.appendChild(summary);
    toolbar.appendChild(refresh);
    body.appendChild(toolbar);

    var list = h('div', { class: 'admin-users' });
    body.appendChild(list);
    var timer = null;
    var mode = 'users';

    function loadUsers() {
      return api('/api/admin/users').then(function (data) {
        var online = data.users.filter(function (u) { return u.online; }).length;
        summary.textContent = '共 ' + data.users.length + ' 位用户 · ' + online + ' 人在线';
        list.innerHTML = '';
        if (!data.users.length) {
          list.appendChild(h('p', { class: 'thread-empty', text: '还没有注册用户。' }));
          return;
        }
        data.users.forEach(function (u) {
          var row = h('div', { class: 'admin-user' });
          var main = h('div', { class: 'admin-user-main' });
          var nameRow = h('div', { class: 'admin-user-name' });
          nameRow.appendChild(h('i', { class: 'presence-dot' + (u.online ? ' on' : ''), 'aria-hidden': 'true' }));
          nameRow.appendChild(h('strong', { text: u.email }));
          if (u.isAdmin) nameRow.appendChild(h('span', { class: 'admin-tag', text: '管理员' }));
          if (u.deletedAt) nameRow.appendChild(h('span', { class: 'admin-tag', text: '已注销' }));
          if (u.unread) nameRow.appendChild(h('span', { class: 'admin-tag unread', text: u.unread + ' 条未读' }));
          main.appendChild(nameRow);
          var daysLeft = u.purgeAt ? Math.max(0, Math.ceil((u.purgeAt - Date.now()) / 86400000)) : 0;
          main.appendChild(h('div', {
            class: 'admin-user-meta',
            text: (u.deletedAt ? '已注销 · ' + daysLeft + ' 天后清除' : (u.online ? '在线' : '最后在线 ' + fmtTime(u.lastSeenAt))) +
              ' · 注册 ' + fmtDate(u.createdAt) +
              ' · ' + u.decks + ' 库 / ' + u.cards + ' 条' +
              (u.favorites ? ' · ' + u.favorites + ' 收藏' : '')
          }));
          row.appendChild(main);
          var actions = h('div', { class: 'admin-user-actions' });
          actions.appendChild(h('button', {
            class: 'ghost-btn admin-open', type: 'button', text: '留言',
            onclick: function () { openAdminThread(u, timer); }
          }));
          if (!u.isAdmin && !u.deletedAt) {
            actions.appendChild(h('button', {
              class: 'ghost-btn danger-btn admin-delete', type: 'button', text: '注销',
              onclick: function () { openAdminDelete(u, load); }
            }));
          }
          row.appendChild(actions);
          list.appendChild(row);
        });
      }).catch(function (err) {
        summary.textContent = errText(err);
        list.innerHTML = '';
      });
    }
    refresh.addEventListener('click', loadUsers);
    loadUsers();
    timer = trackModalTimer(setInterval(loadUsers, 20000));

    var foot = document.createDocumentFragment();
    foot.appendChild(h('span', { class: 'foot-left', text: '在线状态按 30 秒心跳、90 秒过期计算' }));
    foot.appendChild(h('button', { class: 'ghost-btn', type: 'button', text: '关闭', onclick: function () {
      clearInterval(timer);
      A.closeModal();
    } }));

    A.openModal({ kicker: 'ADMIN', title: '管理后台', body: body, foot: foot, autofocus: false });
  }

  function openAdminDelete(user, reload) {
    var body = h('div', { class: 'account-form' });
    body.appendChild(h('p', { class: 'account-intro', text: '注销后该账号的所有设备会立即退出登录，云端数据保留 7 天。' }));
    body.appendChild(h('p', { class: 'confirm-text', text: '7 天内用户可用同一邮箱重新注册，设置新密码并恢复全部题库、进度、划线和收藏；7 天后数据自动清除。' }));
    var field = h('div', { class: 'field' });
    field.appendChild(h('label', { for: 'nkDeleteEmail', text: '输入 ' + user.email + ' 确认' }));
    var input = h('input', { id: 'nkDeleteEmail', type: 'text', autocomplete: 'off', placeholder: user.email });
    field.appendChild(input);
    body.appendChild(field);
    var errorLine = h('p', { class: 'account-error', hidden: true });
    body.appendChild(errorLine);

    var form = h('form', { class: 'account-auth-form' });
    form.appendChild(body);
    var submit = h('button', { class: 'danger-btn', type: 'button', text: '注销账号' });
    var foot = document.createDocumentFragment();
    foot.appendChild(h('span', { class: 'foot-left' }));
    foot.appendChild(h('button', { class: 'ghost-btn', type: 'button', text: '取消', onclick: A.closeModal }));
    foot.appendChild(submit);

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var typed = input.value.trim().toLowerCase();
      if (typed !== user.email.toLowerCase()) {
        errorLine.textContent = '邮箱不一致，请完整输入';
        errorLine.hidden = false;
        input.focus();
        return;
      }
      submit.disabled = true;
      submit.textContent = '注销中…';
      api('/api/admin/users/delete', { method: 'POST', body: { userId: user.id, email: typed } }).then(function () {
        A.closeModal();
        A.toast('已注销，数据保留 7 天');
        if (reload) reload();
      }).catch(function (err) {
        errorLine.textContent = errText(err);
        errorLine.hidden = false;
        submit.disabled = false;
        submit.textContent = '注销账号';
      });
    });
    submit.addEventListener('click', function () { form.requestSubmit(); });
    A.openModal({ kicker: 'ADMIN', title: '注销账号', body: form, foot: foot, autofocus: false });
    setTimeout(function () { input.focus(); }, 60);
  }

  function openAdminThread(user, adminTimer) {
    if (adminTimer) clearInterval(adminTimer);
    var body = h('div', { class: 'thread-panel admin-thread' });
    var back = h('button', { class: 'ghost-btn back-btn', type: 'button', text: '← 返回用户列表', onclick: openAdmin });
    body.appendChild(back);
    var list = h('div', { class: 'thread-list' });
    body.appendChild(list);
    var comp = composer(function (text) {
      return api('/api/admin/messages', { method: 'POST', body: { userId: user.id, body: text } }).then(load);
    }, '回复 ' + user.email + '…');
    body.appendChild(comp.wrap);
    var poll = null;

    function load() {
      return api('/api/admin/messages?userId=' + encodeURIComponent(user.id)).then(function (data) {
        renderThread(list, data.messages || []);
      }).catch(function (err) {
        list.innerHTML = '';
        list.appendChild(h('p', { class: 'thread-empty', text: errText(err) }));
      });
    }
    load();
    poll = trackModalTimer(setInterval(load, 8000));

    var foot = document.createDocumentFragment();
    foot.appendChild(h('span', { class: 'foot-left', text: user.email }));
    foot.appendChild(h('button', { class: 'ghost-btn', type: 'button', text: '关闭', onclick: function () {
      clearInterval(poll);
      A.closeModal();
    } }));

    A.openModal({ kicker: 'ADMIN · MESSAGE', title: '用户留言', body: body, foot: foot, autofocus: false });
    setTimeout(function () { comp.focus(); }, 60);
  }

  /* ---------------- 启动 ---------------- */

  function boot() {
    var modalEl = document.getElementById('modal');
    if (modalEl) {
      new MutationObserver(function () {
        if (!modalEl.hidden) return;
        modalTimers.forEach(function (id) { clearInterval(id); });
        modalTimers = [];
        pollTimer = null;
      }).observe(modalEl, { attributes: true, attributeFilter: ['hidden'] });
    }
    var groupBtn = $('#groupBtn');
    if (groupBtn) groupBtn.addEventListener('click', openGroup);
    var btn = $('#accountBtn');
    if (btn) {
      btn.addEventListener('click', function () {
        if (session) openAccount(); else openAuth('login');
      });
    }
    session = loadSession();
    if (!session) {
      updateAccountBtn();
      return;
    }
    me = session.user;
    updateAccountBtn();
    api('/api/me').then(function (data) {
      me = data.user;
      setBadge(data.unread);
      updateAccountBtn();
      startCloud();
    }).catch(function (err) {
      if (err.status === 401) handleExpired();
      else {
        updateAccountBtn();
        startCloud();
      }
    });
  }

  // 页面关闭前尽量把最后一次修改推上去
  window.addEventListener('pagehide', function () {
    if (session) pushNow(false);
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
