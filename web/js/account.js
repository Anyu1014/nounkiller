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

    function load() {
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
          if (u.unread) nameRow.appendChild(h('span', { class: 'admin-tag unread', text: u.unread + ' 条未读' }));
          main.appendChild(nameRow);
          main.appendChild(h('div', {
            class: 'admin-user-meta',
            text: (u.online ? '在线' : '最后在线 ' + fmtTime(u.lastSeenAt)) +
              ' · 注册 ' + fmtDate(u.createdAt) +
              ' · ' + u.decks + ' 库 / ' + u.cards + ' 条' +
              (u.favorites ? ' · ' + u.favorites + ' 收藏' : '')
          }));
          row.appendChild(main);
          row.appendChild(h('button', {
            class: 'ghost-btn admin-open', type: 'button', text: '留言',
            onclick: function () { openAdminThread(u, timer); }
          }));
          list.appendChild(row);
        });
      }).catch(function (err) {
        summary.textContent = errText(err);
        list.innerHTML = '';
      });
    }
    refresh.addEventListener('click', load);
    load();
    timer = trackModalTimer(setInterval(load, 20000));

    var foot = document.createDocumentFragment();
    foot.appendChild(h('span', { class: 'foot-left', text: '在线状态按 30 秒心跳、90 秒过期计算' }));
    foot.appendChild(h('button', { class: 'ghost-btn', type: 'button', text: '关闭', onclick: function () {
      clearInterval(timer);
      A.closeModal();
    } }));

    A.openModal({ kicker: 'ADMIN', title: '管理后台', body: body, foot: foot, autofocus: false });
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
