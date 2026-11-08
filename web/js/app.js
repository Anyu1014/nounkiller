/*!
 * NounKiller · app.js
 * 界面与交互：评级、逐字回忆、全文高亮、题库导入、排期。
 */
(function () {
  'use strict';

  var C = window.MJZ.core;
  var store = window.MJZ.store.create();
  var S = store.state;

  var APP_VERSION = (document.querySelector('meta[name="app-version"]') || {}).content || '2.1.0';

  var RATING_LABEL = { known: '熟悉', fuzzy: '不熟悉', unknown: '不认识' };
  var RATING_ORDER = ['unknown', 'fuzzy', 'known'];

  /* ---------------- 元素 ---------------- */

  var els = {
    body: document.body,
    deckName: document.getElementById('deckName'),
    deckBtn: document.getElementById('deckBtn'),
    settingsBtn: document.getElementById('settingsBtn'),
    brandHome: document.getElementById('brandHome'),
    brandName: document.getElementById('brandName'),
    studyScreen: document.getElementById('studyScreen'),
    doneScreen: document.getElementById('doneScreen'),
    crumbs: document.getElementById('crumbs'),
    progress: document.getElementById('progress'),
    progressFill: document.getElementById('progressFill'),
    card: document.getElementById('card'),
    cardCounter: document.getElementById('cardCounter'),
    tocBtn: document.getElementById('tocBtn'),
    favBtn: document.getElementById('favBtn'),
    prevBtn: document.getElementById('prevBtn'),
    cardStatus: document.getElementById('cardStatus'),
    term: document.getElementById('term'),
    answer: document.getElementById('answer'),
    answerTools: document.getElementById('answerTools'),
    ratingBar: document.getElementById('ratingBar'),
    nextRow: document.getElementById('nextRow'),
    sessionFoot: document.getElementById('sessionFoot'),
    toast: document.getElementById('toast'),
    modal: document.getElementById('modal'),
    modalKicker: document.getElementById('modalKicker'),
    modalTitle: document.getElementById('modalTitle'),
    modalBody: document.getElementById('modalBody'),
    modalFoot: document.getElementById('modalFoot'),
    modalActions: document.getElementById('modalActions'),
  };

  /* ---------------- 运行时状态 ---------------- */

  var app = {
    queue: [],
    index: 0,
    current: null,
    phase: 'empty', // prompt | revealed | recall | done
    rating: null,
    revealed: new Set(),
    tokens: [],
    tokenEls: new Map(),
    charEls: new Map(),
    totalUnique: 0,
    ratedIds: new Set(),
    sessionStart: 0,
    counts: { known: 0, fuzzy: 0, unknown: 0 },
    ratingById: {},
    marking: false,
    erasing: false,
    selection: null,
    painted: null,
    dragging: false,
    doneKind: 'rest',
    lastFocused: null,
    toastTimer: null,
    modalOpen: false
  };

  /* ---------------- 工具 ---------------- */

  function h(tag, attrs) {
    var el = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        var val = attrs[key];
        if (val == null || val === false) return;
        if (key === 'class') el.className = val;
        else if (key === 'text') el.textContent = val;
        else if (key === 'html') el.innerHTML = val;
        else if (key === 'dataset') Object.keys(val).forEach(function (k) { el.dataset[k] = val[k]; });
        else if (key.slice(0, 2) === 'on') el.addEventListener(key.slice(2), val);
        else if (key === 'disabled' || key === 'hidden' || key === 'checked' || key === 'selected') el[key] = !!val;
        else el.setAttribute(key, val);
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child == null || child === false) continue;
      if (Array.isArray(child)) {
        child.forEach(function (c) { if (c != null && c !== false) el.appendChild(c instanceof Node ? c : document.createTextNode(String(c))); });
      } else {
        el.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
      }
    }
    return el;
  }

  function icon(paths, size) {
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 20 20');
    svg.setAttribute('aria-hidden', 'true');
    svg.innerHTML = paths;
    if (size) { svg.style.width = size + 'px'; svg.style.height = size + 'px'; }
    return svg;
  }

  var ICONS = {
    eyeOff: '<path d="M3 3l14 14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M8.2 4.5A8.9 8.9 0 0 1 10 4.3c4.2 0 7 3.5 7.7 5.7-.3.9-1 2.2-2.2 3.3M5.4 6.2C3.9 7.3 3 8.6 2.6 10c.7 2.2 3.5 5.7 7.7 5.7 1 0 1.9-.2 2.7-.6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" fill="none"/>',
    pen: '<path d="M12.9 3.6a1.7 1.7 0 0 1 2.4 0l1.1 1.1a1.7 1.7 0 0 1 0 2.4l-8.1 8.1-3.8 1 1-3.8 7.4-8.8Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="m11.6 5.1 3.3 3.3" stroke="currentColor" stroke-width="1.5"/>',
    arrow: '<path d="M4 10h11M10.5 5.5 15 10l-4.5 4.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>',
    close: '<path d="M5 5l10 10M15 5 5 15" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
    upload: '<path d="M10 13V3.6M6.4 7.2 10 3.6l3.6 3.6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M3.6 12.4v3.2c0 .5.4.9.9.9h11c.5 0 .9-.4.9-.9v-3.2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
    plus: '<path d="M10 4v12M4 10h12" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
    trash: '<path d="M4 6h12M8 6V4.4c0-.4.3-.7.7-.7h2.6c.4 0 .7.3.7.7V6M6 6l.7 10c0 .5.4.9.9.9h4.8c.5 0 .9-.4.9-.9L14 6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
    rename: '<path d="M4 13.8 13.3 4.5a1.4 1.4 0 0 1 2 0l.2.2a1.4 1.4 0 0 1 0 2L6.2 16H4v-2.2Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>',
    eraser: '<path d="m7 13 6.3-6.3a1.4 1.4 0 0 1 2 0l1 1a1.4 1.4 0 0 1 0 2L12.5 13H7Z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M4 13h8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>',
    underline: '<path d="M6 3.5v5.8a4 4 0 0 0 8 0V3.5M4 16.5h12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
    spark: '<path d="M10 3.2 11.3 7 15 8.3 11.3 9.6 10 13.4 8.7 9.6 5 8.3 8.7 7 10 3.2Z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>'
  };

  function toast(message) {
    els.toast.textContent = message;
    els.toast.hidden = false;
    requestAnimationFrame(function () { els.toast.classList.add('show'); });
    if (app.toastTimer) clearTimeout(app.toastTimer);
    app.toastTimer = setTimeout(function () {
      els.toast.classList.remove('show');
      setTimeout(function () { els.toast.hidden = true; }, 220);
    }, 2200);
  }

  function fmtClock(ts) {
    var d = new Date(ts);
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  function deckCards() {
    var deck = store.activeDeck();
    return deck ? store.deckCards(deck.id) : [];
  }

  function midnightText(ts, now) {
    var days = Math.round((C.dayStart(ts) - C.dayStart(now)) / 86400000);
    if (days <= 0) return '今天 0:00';
    if (days === 1) return '今晚 0:00';
    return days + ' 天后 0:00';
  }

  function nextDueText() {
    var now = Date.now();
    var min = Infinity;
    deckCards().forEach(function (c) {
      if (c.srs && c.srs.state !== 'new' && c.srs.due > now) min = Math.min(min, c.srs.due);
    });
    if (min === Infinity) return '暂无安排';
    if (C.dayStart(min) === min) return midnightText(min, now);
    var base = C.formatDue(min, now);
    return base === '明天' ? '明天 ' + fmtClock(min) : base;
  }

  function nextDueStamp() {
    var now = Date.now();
    var min = Infinity;
    deckCards().forEach(function (c) {
      if (c.srs && c.srs.state !== 'new' && c.srs.due > now) min = Math.min(min, c.srs.due);
    });
    return min;
  }

  /* ---------------- 会话 ---------------- */

  function buildQueue(includeAll) {
    var now = Date.now();
    var cards = deckCards();
    var deck = store.activeDeck();
    if (deck && deck.virtual) includeAll = true;
    if (includeAll === true) {
      var all = cards.slice().sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); });
      return { due: [], fresh: [], all: all };
    }
    var due = cards.filter(function (c) { return C.isDue(c, now); }).sort(function (a, b) { return a.srs.due - b.srs.due; });
    // 稳定排序：同一批导入的新卡保持原顺序
    var fresh = cards.filter(function (c) { return C.isNewCard(c); }).sort(function (a, b) {
      return (a.createdAt || 0) - (b.createdAt || 0);
    });
    var allowance = store.newAllowance();
    if (allowance !== Infinity) fresh = fresh.slice(0, allowance);
    return { due: due, fresh: fresh, all: due.concat(fresh) };
  }

  function startSession(includeAll) {
    var deck = store.activeDeck();
    if (!deck) { app.phase = 'done'; app.doneKind = 'empty'; render(); return; }

    var built = buildQueue(includeAll === true);
    var queue = built.all;
    if (!queue.length) {
      var cardCount = store.deckCards(deck.id).length;
      app.phase = 'done';
      app.doneKind = cardCount === 0 ? 'empty' : 'rest';
      app.current = null;
      app.queue = [];
      app.totalUnique = 0;
      render();
      return;
    }

    app.queue = queue.slice();
    app.index = 0;
    app.current = app.queue[0];
    app.phase = 'prompt';
    app.rating = null;
    app.revealed = new Set();
    app.tokens = [];
    app.tokenEls = new Map();
    app.charEls = new Map();
    app.totalUnique = queue.length;
    app.ratedIds = new Set();
    app.sessionStart = Date.now();
    app.counts = { known: 0, fuzzy: 0, unknown: 0 };
    app.ratingById = {};
    app.marking = false;
    app.erasing = false;
    app.selection = null;
    app.painted = null;
    render();
  }

  function rateCard(rating) {
    if (app.phase !== 'prompt' || !app.current) return;
    var card = app.current;
    var wasNew = C.isNewCard(card);

    card.srs = C.rate(card.srs, rating, Date.now());
    store.recordRating(rating, wasNew);
    app.ratedIds.add(card.id);
    if (app.ratingById[card.id]) app.counts[app.ratingById[card.id]] -= 1;
    app.ratingById[card.id] = rating;
    app.counts[rating] += 1;
    app.rating = rating;

    // 队列保持完整：上一条/目录跳转都基于同一份顺序，SRS 负责下一轮排期。
    app.phase = rating === 'fuzzy' ? 'recall' : 'revealed';
    app.revealed = new Set();
    app.marking = false;
    app.erasing = false;
    app.selection = null;
    render();
  }

  function nextUnratedIndex() {
    var i;
    for (i = app.index + 1; i < app.queue.length; i++) {
      if (!app.ratedIds.has(app.queue[i].id)) return i;
    }
    for (i = 0; i < app.index; i++) {
      if (!app.ratedIds.has(app.queue[i].id)) return i;
    }
    return -1;
  }

  function presentPrompt(card) {
    app.current = card;
    app.phase = 'prompt';
    app.rating = null;
    app.revealed = new Set();
    app.tokens = [];
    app.tokenEls = new Map();
    app.charEls = new Map();
    app.marking = false;
    app.erasing = false;
    app.selection = null;
    app.painted = null;
  }

  function nextCard() {
    if (app.phase !== 'revealed' && app.phase !== 'recall') return;
    app.marking = false;
    app.erasing = false;
    app.selection = null;

    var next = nextUnratedIndex();
    if (next < 0) {
      finishSession();
      return;
    }
    app.index = next;
    presentPrompt(app.queue[next]);
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function prevCard() {
    if (app.phase === 'done' || app.index <= 0) return;
    app.index -= 1;
    presentPrompt(app.queue[app.index]);
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function jumpTo(cardId) {
    var card = null;
    for (var i = 0; i < app.queue.length; i++) {
      if (app.queue[i].id === cardId) { card = app.queue[i]; break; }
    }
    var idx = card ? app.queue.indexOf(card) : -1;
    if (!card) {
      var deckCardsNow = deckCards();
      for (var j = 0; j < deckCardsNow.length; j++) {
        if (deckCardsNow[j].id === cardId) { card = deckCardsNow[j]; break; }
      }
      if (!card) return;
      idx = app.index + 1;
      app.queue.splice(idx, 0, card);
      app.totalUnique = app.queue.length;
    }
    closeModal();
    app.index = idx;
    presentPrompt(card);
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function restartAll() {
    startSession(true);
  }

  function finishSession() {
    app.phase = 'done';
    app.doneKind = 'summary';
    app.current = null;
    render();
  }

  /* ---------------- 渲染 ---------------- */

  function render() {
    var deck = store.activeDeck();
    els.deckName.textContent = deck ? deck.name : '未选择题库';

    if (app.phase === 'done') {
      els.studyScreen.hidden = true;
      els.doneScreen.hidden = false;
      renderDone();
      return;
    }

    els.studyScreen.hidden = false;
    els.doneScreen.hidden = true;
    renderStudy();
  }

  function renderStudy() {
    var card = app.current;
    if (!card) return;

    var total = app.totalUnique || 1;
    var rated = Math.min(app.ratedIds.size, total);
    els.crumbs.innerHTML = '本轮 <b>' + total + '</b> 张 · 已评 <b>' + rated + '</b> 张';
    var pct = Math.round((rated / total) * 100);
    els.progressFill.style.width = pct + '%';
    els.progress.setAttribute('aria-valuenow', String(pct));

    els.cardCounter.textContent = '第 ' + (app.index + 1) + ' / ' + total + ' 张';
    if (els.prevBtn) els.prevBtn.disabled = app.index <= 0;
    els.cardStatus.textContent = app.phase === 'prompt' ? '待回忆' : app.phase === 'recall' ? '逐字回忆' : '已显示全文';
    els.term.textContent = card.term;
    if (els.favBtn) {
      els.favBtn.classList.toggle('on', !!card.fav);
      els.favBtn.setAttribute('aria-pressed', String(!!card.fav));
      els.favBtn.setAttribute('aria-label', (card.fav ? '取消收藏 ' : '收藏 ') + card.term);
    }

    els.ratingBar.hidden = app.phase !== 'prompt';
    els.sessionFoot.hidden = app.phase !== 'prompt';
    renderAnswer();
    renderNextRow();
  }

  function renderAnswer() {
    els.answer.innerHTML = '';
    els.answer.className = 'answer';
    els.answerTools.hidden = true;
    els.answerTools.innerHTML = '';

    if (!app.current) return;
    if (app.phase === 'prompt') {
      renderPrompt();
    } else if (app.phase === 'revealed') {
      renderRevealed();
    } else if (app.phase === 'recall') {
      renderRecall();
    }
  }

  function renderPrompt() {
    var block = h('div', { class: 'prompt-block' });
    block.appendChild(h('span', { class: 'prompt-icon' }, icon(ICONS.eyeOff)));
    block.appendChild(h('p', { class: 'prompt-title', text: '先别急着看释义' }));
    block.appendChild(h('p', {
      class: 'prompt-sub',
      text: '在心里把这段名词解释讲一遍，再选择记忆程度。选「不熟悉」会进入逐字点亮模式。'
    }));
    els.answer.appendChild(block);
  }

  function renderRevealed() {
    var card = app.current;
    els.answer.innerHTML = '';
    els.answerTools.innerHTML = '';
    var built = buildFullText(card.def, card.highlights);
    app.charEls = built.els;
    var textEl = h('div', { class: 'full-text', id: 'fullText' });
    textEl.appendChild(built.frag);
    els.answer.appendChild(textEl);
    if (app.marking || app.erasing) els.answer.classList.add('marking');

    els.answerTools.hidden = false;
    var left = h('div', { class: 'tool-left' });
    left.appendChild(h('button', {
      class: 'tool-chip' + (app.marking ? ' active' : ''),
      id: 'markToggle',
      type: 'button',
      'aria-pressed': app.marking ? 'true' : 'false'
    }, icon(ICONS.pen, 14), '划线标记'));
    left.appendChild(h('button', {
      class: 'tool-chip' + (app.erasing ? ' active' : ''),
      id: 'eraseToggle',
      type: 'button',
      'aria-pressed': app.erasing ? 'true' : 'false'
    }, icon(ICONS.eraser, 14), '擦除'));
    left.appendChild(h('button', {
      class: 'tool-chip',
      id: 'clearMarks',
      type: 'button'
    }, icon(ICONS.trash, 14), '清空标记'));

    var right = h('div', {
      class: 'tool-hint',
      text: app.erasing ? '在标记上滑动即可擦除，再点「擦除」结束'
        : app.marking ? '拖动文字直接划线，再点「划线标记」结束'
        : '标记会保存在本机'
    });
    els.answerTools.appendChild(left);
    els.answerTools.appendChild(right);
  }

  function buildFullText(text, highlights) {
    var chars = Array.from(text);
    var frag = document.createDocumentFragment();
    var els = new Map();
    var sel = app.selection ? C.normalizeRange(app.selection.a, app.selection.b) : null;
    for (var i = 0; i < chars.length; i++) {
      var ch = chars[i];
      if (/\s/.test(ch)) {
        frag.appendChild(document.createTextNode(ch));
        continue;
      }
      var span = document.createElement('span');
      span.className = 'c';
      span.dataset.i = String(i);
      span.textContent = ch;
      var mark = C.highlightAt(highlights || [], i);
      if (mark) {
        span.classList.add('hl-' + mark.color);
        span.classList.add('hl-style-' + (mark.style || 'marker'));
      }
      if (sel && i >= sel.start && i < sel.end) span.classList.add('sel');
      frag.appendChild(span);
      els.set(i, span);
    }
    return { frag: frag, els: els };
  }

  function renderRecall() {
    var card = app.current;
    var tokens = C.tokenize(card.def);
    app.tokens = tokens;
    app.tokenEls = new Map();

    var frag = document.createDocumentFragment();
    for (var i = 0; i < tokens.length; i++) {
      var t = tokens[i];
      if (t.type === 'space') {
        frag.appendChild(document.createTextNode(t.ch));
        continue;
      }
      var span = document.createElement('span');
      span.textContent = t.ch;
      span.dataset.i = String(t.i);
      if (t.type === 'punct') {
        span.className = 'punct';
      } else {
        span.className = 'ph' + (app.revealed.has(t.i) ? ' on' : '');
        if (!app.revealed.has(t.i)) span.setAttribute('aria-hidden', 'true');
        app.tokenEls.set(t.i, span);
      }
      frag.appendChild(span);
    }

    var wrap = h('div', { class: 'recall-wrap' });
    var textEl = h('div', {
      class: 'recall-text',
      id: 'recallText',
      'aria-label': '逐字回忆区：点击空白字块点亮文字，或用「全部显现」一次看全'
    });
    textEl.appendChild(frag);
    wrap.appendChild(textEl);

    var hiddenTotal = C.hiddenCount(card.def);
    var count = h('b', { id: 'recallCount', text: String(app.revealed.size) });
    var hint = h('div', { class: 'recall-hint' });
    var hintText = h('span');
    hintText.appendChild(h('i', { class: 'hint-dot' }));
    hintText.appendChild(document.createTextNode('已点亮 '));
    hintText.appendChild(count);
    hintText.appendChild(document.createTextNode(' / ' + hiddenTotal + ' 字 · 点击字块找回文字'));
    hint.appendChild(hintText);
    hint.appendChild(h('button', {
      class: 'link-btn',
      id: 'revealAll',
      type: 'button',
      text: '全部显现'
    }));
    wrap.appendChild(hint);

    els.answer.appendChild(wrap);
    updateRecallHint();
  }

  function updateRecallHint() {
    var card = app.current;
    if (!card) return;
    var total = C.hiddenCount(card.def);
    var countEl = document.getElementById('recallCount');
    if (countEl) countEl.textContent = String(app.revealed.size);
    var hintText = document.querySelector('.recall-hint span');
    if (hintText) {
      var complete = app.revealed.size >= total;
      hintText.lastChild.textContent = complete
        ? ' · 已全部点亮，点「全部隐藏」可收起'
        : ' · 点击字块找回文字';
    }
    var btn = document.getElementById('revealAll');
    if (btn) {
      btn.hidden = false;
      btn.textContent = app.revealed.size >= total ? '全部隐藏' : '全部显现';
    }
  }

  function renderNextRow() {
    els.nextRow.innerHTML = '';
    if (app.phase === 'prompt') {
      els.nextRow.hidden = true;
      return;
    }
    els.nextRow.hidden = false;

    var badge = h('span', { class: 'rating-badge ' + (app.rating || '') });
    badge.appendChild(h('i', { class: 'dot' }));
    badge.appendChild(document.createTextNode('已评：' + (RATING_LABEL[app.rating] || '—')));
    els.nextRow.appendChild(badge);

    var next = h('button', {
      class: 'next-btn',
      id: 'nextBtn',
      type: 'button'
    }, nextUnratedIndex() >= 0 ? '下一条' : '完成本轮', icon(ICONS.arrow, 17));
    els.nextRow.appendChild(next);
    els.nextRow.appendChild(h('span', { class: 'next-hint', text: '空格' }));
  }

  function renderDone() {
    els.doneScreen.innerHTML = '';
    var deck = store.activeDeck();
    var cards = deckCards();
    var wrap = h('div', { class: 'done-card' });
    wrap.appendChild(h('div', { class: 'done-seal', text: 'n.' }));

    if (app.doneKind === 'empty') {
      var favEmpty = store.activeDeck() && store.activeDeck().virtual;
      wrap.appendChild(h('h2', { text: favEmpty ? '还没有收藏的词条' : '先导入一份题库' }));
      wrap.appendChild(h('p', {
        class: 'done-sub',
        text: favEmpty
          ? '在名词右上角点亮星标，收藏的词条会汇总到「总收藏题库」，随时回来集中背诵。'
          : '支持 txt / json：txt 可名词一行、解释跟几行，条目无需空行；也支持「名词：解释」和序号分条。json 支持数组或 {cards:[...]}。'
      }));
      var emptyActions = h('div', { class: 'done-actions' });
      if (favEmpty) {
        emptyActions.appendChild(h('button', { class: 'primary-btn', type: 'button', onclick: openDecks }, '去题库管理'));
      } else {
        emptyActions.appendChild(h('button', { class: 'primary-btn', type: 'button', onclick: function () { openImport(); } }, '导入题库'));
        emptyActions.appendChild(h('button', { class: 'ghost-btn', type: 'button', onclick: openDecks }, '题库管理'));
      }
      wrap.appendChild(emptyActions);
      els.doneScreen.appendChild(wrap);
      return;
    }

    if (app.doneKind === 'rest') {
      var allowance = store.newAllowance();
      var freshCount = C.newCount(cards);
      var limitReached = freshCount > 0 && allowance === 0;
      var nextTs = nextDueStamp();

      wrap.appendChild(h('h2', { text: limitReached ? '今天的任务完成了' : '当前没有待复习的卡片' }));
      var sub = limitReached
        ? '今天的新词条已达每日目标（' + S.settings.dailyNew + ' 条）。可以先去设置调整目标，或明天再来。'
        : (nextTs !== Infinity
          ? (C.dayStart(nextTs) === nextTs
            ? '下一批将在' + midnightText(nextTs, Date.now()) + ' 刷新。'
            : '下一张将在 ' + C.formatDue(nextTs, Date.now()) + '（' + fmtClock(nextTs) + '）到期。')
          : '这个题库还没有排期，导入新词条或重置进度即可开始。');
      wrap.appendChild(h('p', { class: 'done-sub', text: sub }));

      var meta = h('div', { class: 'done-meta' });
      meta.appendChild(h('span', { text: '题库：' + (deck ? deck.name : '—') }));
      meta.appendChild(h('span', { text: '共 ' + cards.length + ' 条' }));
      meta.appendChild(h('span', { text: '待复习 ' + C.dueCount(cards, Date.now()) + ' · 新卡 ' + C.newCount(cards) }));
      wrap.appendChild(meta);

      var actions = h('div', { class: 'done-actions' });
      var built = buildQueue();
      if (built.all.length) {
        actions.appendChild(h('button', { class: 'primary-btn', type: 'button', onclick: startSession }, '继续学习'));
      }
      actions.appendChild(h('button', {
        class: 'ghost-btn',
        type: 'button',
        onclick: function () {
          var name = deck ? deck.name : '当前题库';
          askConfirm('Progress', '重置进度', '把「' + name + '」的全部词条重新作为新卡开始？排期会清空，划线标记保留。', '重置', function () {
            var n = deck ? store.resetDeckProgress(deck.id) : 0;
            toast('已重置 ' + n + ' 条词条的进度');
            startSession();
          });
        }
      }, '重置'));
      actions.appendChild(h('button', { class: 'ghost-btn', type: 'button', onclick: openDecks }, '题库管理'));
      actions.appendChild(h('button', { class: 'ghost-btn', type: 'button', onclick: openSettings }, '设置'));
      wrap.appendChild(actions);
      els.doneScreen.appendChild(wrap);
      return;
    }

    // 本轮总结
    var elapsed = Date.now() - (app.sessionStart || Date.now());
    wrap.appendChild(h('h2', { text: '本轮完成' }));
    wrap.appendChild(h('p', {
      class: 'done-sub',
      text: '记忆不是一次完成的事。不熟悉和不认识会很快再出现，熟悉的间隔会逐渐拉长。'
    }));

    var stats = h('div', { class: 'done-stats' });
    [
      ['known', '熟悉'],
      ['fuzzy', '不熟悉'],
      ['unknown', '不认识']
    ].forEach(function (pair) {
      stats.appendChild(h('div', { class: 'done-stat ' + pair[0] },
        h('b', { text: String(app.counts[pair[0]]) }),
        h('span', { text: pair[1] })
      ));
    });
    wrap.appendChild(stats);

    var meta = h('div', { class: 'done-meta' });
    meta.appendChild(h('span', { text: '本轮 ' + app.totalUnique + ' 张' }));
    meta.appendChild(h('span', { text: '用时 ' + C.formatDuration(elapsed) }));
    meta.appendChild(h('span', { text: '下次复习 ' + nextDueText() }));
    wrap.appendChild(meta);

    var actions = h('div', { class: 'done-actions' });
    var built2 = buildQueue();
    if (built2.all.length) {
      actions.appendChild(h('button', { class: 'primary-btn', type: 'button', onclick: startSession }, '再来一轮'));
    }
    actions.appendChild(h('button', {
      class: built2.all.length ? 'ghost-btn' : 'primary-btn',
      type: 'button',
      onclick: restartAll
    }, '重置本轮'));
    actions.appendChild(h('button', { class: 'ghost-btn', type: 'button', onclick: openDecks }, '题库管理'));
    wrap.appendChild(actions);
    els.doneScreen.appendChild(wrap);
  }

  /* ---------------- 逐字回忆交互 ---------------- */

  function revealAt(index) {
    var card = app.current;
    if (!card) return;
    var fresh = [];
    var set = C.revealCluster(card.def, index, S.settings.revealRadius);
    set.forEach(function (i) {
      if (!app.revealed.has(i)) {
        app.revealed.add(i);
        fresh.push(i);
      }
    });
    paintRevealed(fresh);
  }

  function paintRevealed(fresh) {
    fresh.forEach(function (i) {
      var el = app.tokenEls.get(i);
      if (!el) return;
      el.classList.add('on', 'flash');
      el.removeAttribute('aria-hidden');
      el.addEventListener('animationend', function handler() {
        el.classList.remove('flash');
        el.removeEventListener('animationend', handler);
      });
    });
    updateRecallHint();
    if (fresh.length && navigator.vibrate) {
      try { navigator.vibrate(8); } catch (e) { /* ignore */ }
    }
  }

  function revealAll() {
    var fresh = [];
    app.tokenEls.forEach(function (el, i) {
      if (!app.revealed.has(i)) {
        app.revealed.add(i);
        fresh.push(i);
      }
    });
    if (!fresh.length) return;
    // 一次全开时不做逐字闪动，避免整段乱跳
    fresh.forEach(function (i) {
      var el = app.tokenEls.get(i);
      if (!el) return;
      el.classList.add('on');
      el.removeAttribute('aria-hidden');
    });
    updateRecallHint();
    if (navigator.vibrate) { try { navigator.vibrate(12); } catch (e) { /* ignore */ } }
  }

  function toggleRevealAll() {
    var card = app.current;
    if (!card) return;
    var total = C.hiddenCount(card.def);
    if (app.revealed.size >= total) {
      app.revealed = new Set();
      app.tokenEls.forEach(function (el) {
        el.classList.remove('on');
        el.setAttribute('aria-hidden', 'true');
      });
      updateRecallHint();
      if (navigator.vibrate) { try { navigator.vibrate(8); } catch (e) { /* ignore */ } }
      return;
    }
    revealAll();
  }

  /* ---------------- 高亮标记 ---------------- */

  function indexFromPoint(x, y) {
    var el = document.elementFromPoint(x, y);
    if (!el) return -1;
    var charEl = el.closest ? el.closest('.c') : null;
    if (charEl && els.answer.contains(charEl)) return Number(charEl.dataset.i);
    return -1;
  }

  function selectionRange() {
    if (!app.selection) return null;
    return C.normalizeRange(app.selection.a, app.selection.b);
  }

  function paintSelection(next) {
    var prev = app.painted;
    if (prev && next && prev.start === next.start && prev.end === next.end) return;
    if (prev) {
      for (var i = prev.start; i < prev.end; i++) {
        var old = app.charEls.get(i);
        if (old && (!next || i < next.start || i >= next.end)) old.classList.remove('sel');
      }
    }
    if (next) {
      for (var j = next.start; j < next.end; j++) {
        var el = app.charEls.get(j);
        if (el) el.classList.add('sel');
      }
    }
    app.painted = next;
  }

  function clearSelection() {
    paintSelection(null);
    app.selection = null;
    app.dragging = false;
  }

  function applyMark() {
    var range = selectionRange();
    var card = app.current;
    if (!range || !card) return;
    card.highlights = C.addHighlight(
      card.highlights || [],
      range.start,
      range.end,
      S.settings.highlightColor || 'yellow',
      S.settings.highlightStyle || 'marker'
    );
    store.save();
    clearSelection();
    renderRevealed();
    if (app.marking) els.answer.classList.add('marking');
  }

  function eraseMark() {
    var range = selectionRange();
    var card = app.current;
    if (!range || !card) return;
    var before = (card.highlights || []).length;
    card.highlights = C.removeHighlight(card.highlights || [], range.start, range.end);
    clearSelection();
    if (card.highlights.length === before) return;
    store.save();
    renderRevealed();
    if (app.erasing) els.answer.classList.add('marking');
    toast('已擦除这里的标记');
  }

  function clearMarks() {
    var card = app.current;
    if (!card) return;
    if (!(card.highlights || []).length) { toast('这张卡还没有标记'); return; }
    askConfirm('Mark', '清空标记', '清空这张卡的全部高亮与下划线？', '清空', function () {
      card.highlights = [];
      store.saveNow();
      renderRevealed();
      toast('已清空本卡标记');
    });
  }

  /* ---------------- 弹层 ---------------- */

  function openModal(opts) {
    app.lastFocused = document.activeElement;
    app.modalOpen = true;
    els.modalKicker.textContent = opts.kicker || 'NounKiller';
    els.modalTitle.textContent = opts.title || '';
    els.modalBody.innerHTML = '';
    if (opts.body) els.modalBody.appendChild(opts.body);
    els.modalFoot.innerHTML = '';
    if (opts.foot) els.modalFoot.appendChild(opts.foot);
    if (els.modalActions) {
      var extra = els.modalActions.querySelectorAll('[data-modal-action]');
      for (var i = 0; i < extra.length; i++) extra[i].remove();
      if (opts.action) {
        opts.action.setAttribute('data-modal-action', '1');
        els.modalActions.insertBefore(opts.action, els.modalActions.firstChild);
      }
    }
    els.modal.classList.toggle('is-tall', opts.tall === true);
    els.modal.hidden = false;
    els.body.style.overflow = 'hidden';
    var focusable = els.modal.querySelector('button, input, textarea, select, [tabindex]');
    if (focusable && opts.autofocus !== false) setTimeout(function () { focusable.focus(); }, 30);
  }

  function closeModal() {
    if (!app.modalOpen) return;
    app.modalOpen = false;
    els.modal.hidden = true;
    els.modal.classList.remove('is-tall');
    els.body.style.overflow = '';
    if (app.lastFocused && app.lastFocused.focus) {
      try { app.lastFocused.focus(); } catch (e) { /* ignore */ }
    }
  }

  function modalFoot(primaryText, onPrimary, opts) {
    opts = opts || {};
    var foot = document.createDocumentFragment();
    if (opts.left) foot.appendChild(opts.left);
    else foot.appendChild(h('span', { class: 'foot-left' }));
    foot.appendChild(h('button', {
      class: 'ghost-btn',
      type: 'button',
      onclick: closeModal
    }, '取消'));
    if (primaryText) {
      foot.appendChild(h('button', {
        class: 'primary-btn',
        type: 'button',
        disabled: !!opts.disabled,
        onclick: onPrimary
      }, primaryText));
    }
    return foot;
  }

  /**
   * 应用内确认框。WebView 的原生 confirm 行为不可靠（Android WebView 默认可能直接返回 false），
   * 所以所有破坏性操作都走同一条弹层路径。
   */
  function askConfirm(kicker, title, message, yesText, onYes, onCancel) {
    var body = h('p', { class: 'confirm-text', text: message });
    var foot = document.createDocumentFragment();
    foot.appendChild(h('span', { class: 'foot-left' }));
    foot.appendChild(h('button', {
      class: 'ghost-btn',
      type: 'button',
      onclick: function () {
        closeModal();
        if (onCancel) onCancel();
      }
    }, '取消'));
    foot.appendChild(h('button', {
      class: 'primary-btn danger',
      type: 'button',
      onclick: function () {
        closeModal();
        onYes();
      }
    }, yesText));
    openModal({ kicker: kicker, title: title, body: body, foot: foot });
  }

  /* ---------------- 题库管理 ---------------- */

  function deckRow(deck, renaming) {
    var cards = store.deckCards(deck.id);
    var active = S.activeDeckId === deck.id;
    var row = h('div', {
      class: 'deck-row' + (active ? ' active' : '') + (deck.virtual ? ' is-virtual' : '')
    });

    var radio = h('button', {
      class: 'deck-radio',
      type: 'button',
      'aria-label': '切换到 ' + deck.name,
      onclick: function () {
        if (S.activeDeckId === deck.id) return;
        store.setActiveDeck(deck.id);
        closeModal();
        startSession();
        toast('已切换到「' + deck.name + '」');
      }
    });
    row.appendChild(radio);

    var info = h('div', { class: 'deck-info' });
    var nameLine = h('span', { class: 'deck-name-line' });
    nameLine.appendChild(h('span', { class: 'deck-name', text: deck.name }));
    if (deck.virtual) nameLine.appendChild(h('span', { class: 'deck-pin', text: '置顶' }));
    info.appendChild(nameLine);
    var now = Date.now();
    var meta = deck.virtual
      ? '全部收藏 · ' + cards.length + ' 条'
      : cards.length + ' 条 · 待复习 ' + C.dueCount(cards, now) + ' · 新卡 ' + C.newCount(cards);
    if (active) meta += ' · 当前';
    info.appendChild(h('span', { class: 'deck-meta', text: meta }));
    row.appendChild(info);

    var actions = h('div', { class: 'deck-actions' });
    if (deck.virtual) {
      row.appendChild(actions);
      return row;
    }
    actions.appendChild(h('button', {
      class: 'mini-btn',
      type: 'button',
      title: '编辑题库',
      'aria-label': '编辑题库',
      onclick: function () { openDeckEditor(deck.id); }
    }, icon(ICONS.rename)));
    actions.appendChild(h('button', {
      class: 'mini-btn',
      type: 'button',
      title: '删除题库',
      'aria-label': '删除题库',
      onclick: function () {
        askConfirm('Libraries', '删除题库', '删除「' + deck.name + '」？该题库的 ' + cards.length + ' 条词条和标记会一并删除。', '删除', function () {
          store.deleteDeck(deck.id);
          openDecks();
          startSession();
          toast('已删除题库');
        }, function () { openDecks(); });
      }
    }, icon(ICONS.trash)));
    row.appendChild(actions);
    return row;
  }

  /** 编辑视图的文本格式：1.名词:解释，空行分条；解释内部的换行原样保留。 */
  function deckToText(cards) {
    return cards.map(function (card, i) {
      // 解释内部只保留单换行，避免空行把同一条词条切成两条
      var def = String(card.def || '').replace(/[ \t]*\n[ \t]*/g, '\n').replace(/\n{2,}/g, '\n').trim();
      var prefix = (i + 1) + '.' + card.term + ':';
      var pad = ' '.repeat(measurePad(prefix));
      var lines = def.split('\n');
      var tail = lines.slice(1).map(function (line) { return '\n' + pad + line; }).join('');
      return prefix + lines[0] + tail;
    }).join('\n\n');
  }

  // 续行缩进：用编辑器的实际字体量出前缀宽度，向下取整到空格数，
  // 让第二行与第一行解释对齐（最多偏前半格）。
  var measureCtx = null;
  function measurePad(prefix) {
    try {
      if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
      measureCtx.font = '14px ui-monospace, "SF Mono", Menlo, "PingFang SC", monospace';
      var unit = measureCtx.measureText(' ').width;
      var width = measureCtx.measureText(prefix).width;
      if (!unit) return 0;
      return Math.max(0, Math.floor(width / unit));
    } catch (e) {
      return prefix.length;
    }
  }

  function openDeckEditor(deckId) {
    var deck = store.deckById(deckId);
    if (!deck) return;
    var cards = store.deckCards(deckId);
    var body = h('div');

    var nameField = h('div', { class: 'field' });
    nameField.appendChild(h('label', { for: 'deckEditName', text: '题库名称' }));
    var nameInput = h('input', {
      class: 'text-input',
      id: 'deckEditName',
      type: 'text',
      maxlength: '60',
      value: deck.name
    });
    nameField.appendChild(nameInput);
    body.appendChild(nameField);

    var textField = h('div', { class: 'field' });
    textField.appendChild(h('label', { for: 'deckEditText', text: '词条内容' }));
    var textarea = h('textarea', {
      class: 'text-input deck-editor-text',
      id: 'deckEditText',
      spellcheck: 'false',
      placeholder: '1.名词:解释\n\n2.名词:解释'
    });
    textarea.value = deckToText(cards);
    textField.appendChild(textarea);
    textField.appendChild(h('p', {
      class: 'import-help',
      text: '按「1.名词:解释」排版，空行分条；解释要分段时，后续行继续写。保存会就地更新词条，未改名的学习进度和划线都会保留。'
    }));
    body.appendChild(textField);

    function save() {
      var name = nameInput.value.trim();
      if (!name) { nameInput.focus(); toast('题库名不能为空'); return; }
      if (!textarea.value.trim()) {
        store.renameDeck(deckId, name);
        store.replaceDeckCards(deckId, []);
        store.saveNow();
        closeModal(); openDecks(); startSession();
        toast('已保存题库');
        return;
      }
      var parsed;
      try {
        parsed = C.parseText(textarea.value);
      } catch (e) {
        toast('解析失败：' + e.message);
        return;
      }
      if (!parsed.cards.length) {
        toast('没有解析到词条，请按「1.名词:解释」排版');
        textarea.focus();
        return;
      }
      store.renameDeck(deckId, name);
      store.replaceDeckCards(deckId, parsed.cards);
      store.saveNow();
      closeModal(); openDecks(); startSession();
      toast('已保存 ' + parsed.cards.length + ' 条词条');
    }

    openModal({
      kicker: 'Libraries',
      title: '编辑题库',
      body: body,
      foot: modalFoot('保存', save),
      autofocus: false
    });
    setTimeout(function () { nameInput.focus(); nameInput.select(); }, 30);
  }

  var STAR_PATH = 'M12 3.4l2.6 5.3 5.8.9-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.2-4.1 5.8-.9z';

  function favButton(card, onChange) {
    var btn = h('button', {
      class: 'fav-btn' + (card.fav ? ' on' : ''),
      type: 'button',
      'aria-label': (card.fav ? '取消收藏 ' : '收藏 ') + card.term,
      'aria-pressed': String(!!card.fav)
    });
    btn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="' + STAR_PATH + '"/></svg>';
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      card.fav = !card.fav;
      btn.classList.toggle('on', !!card.fav);
      btn.setAttribute('aria-pressed', String(!!card.fav));
      btn.setAttribute('aria-label', (card.fav ? '取消收藏 ' : '收藏 ') + card.term);
      store.save();
      if (onChange) onChange();
    });
    return btn;
  }

  function openToc() {
    var cards = deckCards();
    var body = h('div');
    var list = null;
    if (!cards.length) {
      var isFav = store.activeDeck() && store.activeDeck().virtual;
      body.appendChild(h('p', {
        class: 'confirm-text',
        text: isFav ? '还没有收藏的词条，点亮名词右上角的星标即可汇总到这里。' : '这个题库还没有词条，先导入或编辑题库。'
      }));
    } else {
      list = h('div', { class: 'toc-list' });
      body.appendChild(list);
    }

    function paint() {
      if (!list) return;
      list.innerHTML = '';
      var favs = cards.filter(function (c) { return c.fav; });
      var rest = cards.filter(function (c) { return !c.fav; });
      var n = 0;
      function section(label, items) {
        if (!items.length) return;
        if (favs.length) list.appendChild(h('div', { class: 'toc-group', text: label }));
        items.forEach(function (c) {
          n += 1;
          var row = h('div', {
            class: 'toc-item' + (app.current && c.id === app.current.id ? ' is-current' : '')
          });
          var main = h('button', { class: 'toc-main', type: 'button' });
          main.appendChild(h('span', { class: 'toc-num', text: String(n) }));
          main.appendChild(h('span', { class: 'toc-term', text: c.term }));
          main.addEventListener('click', function () { jumpTo(c.id); });
          row.appendChild(main);
          row.appendChild(favButton(c, paint));
          list.appendChild(row);
        });
      }
      section('收藏', favs);
      section('全部词条', rest);
    }

    paint();

    var foot = modalFoot(null, null, {
      left: h('span', { class: 'foot-left', text: '共 ' + cards.length + ' 条 · 仅显示名词' })
    });
    openModal({ kicker: 'Contents', title: '目录', body: body, foot: foot, autofocus: false });
  }

  function openDecks() {
    var body = h('div');
    var list = h('div', { class: 'deck-list' });
    list.appendChild(deckRow({ id: store.FAV_DECK_ID, name: store.FAV_DECK_NAME, virtual: true }));
    S.decks.forEach(function (deck) {
      list.appendChild(deckRow(deck));
    });
    body.appendChild(list);

    var toolbar = h('div', { class: 'deck-toolbar' });
    toolbar.appendChild(h('button', {
      class: 'ghost-btn',
      type: 'button',
      onclick: function () {
        var deck = store.createDeck('新题库');
        startSession();
        openDeckEditor(deck.id);
      }
    }, icon(ICONS.plus, 15), '新建题库'));
    toolbar.appendChild(h('button', {
      class: 'primary-btn',
      type: 'button',
      onclick: function () { openImport(); }
    }, icon(ICONS.upload, 15), '导入题库'));
    body.appendChild(toolbar);

    body.appendChild(h('p', {
      class: 'import-help',
      text: '不登录时词条与进度只保存在本机；登录后会同步到你的云端空间，换设备可继续。'
    }));

    openModal({
      kicker: 'Libraries',
      title: '题库',
      body: body,
      foot: modalFoot(null, null, { left: h('span', { class: 'foot-left', text: '共 ' + (S.decks.length + 1) + ' 个题库' }) })
    });
  }

  /* ---------------- 导入 ---------------- */

  function openImport(presetDeckId) {
    var parsed = null;
    var body = h('div');
    var footInfo = h('span', { class: 'foot-left', text: '支持 txt / json / pdf / docx / 图片' });

    var targetField = h('div', { class: 'field' });
    targetField.appendChild(h('label', { for: 'importDeckSelect', text: '导入到' }));
    var select = h('select', { class: 'text-input', id: 'importDeckSelect' });
    S.decks.forEach(function (deck) {
      select.appendChild(h('option', {
        value: deck.id,
        text: deck.name,
        selected: deck.id === (presetDeckId || S.activeDeckId)
      }));
    });
    select.appendChild(h('option', { value: '__new__', text: '＋ 新建题库' }));
    targetField.appendChild(select);
    body.appendChild(targetField);

    var nameField = h('div', { class: 'field', hidden: true });
    nameField.appendChild(h('label', { for: 'importDeckName', text: '新题库名称' }));
    var nameInput = h('input', {
      class: 'text-input',
      id: 'importDeckName',
      type: 'text',
      maxlength: '60',
      placeholder: '例如：传播学名词解释',
      value: ''
    });
    nameField.appendChild(nameInput);
    body.appendChild(nameField);

    select.addEventListener('change', function () { nameField.hidden = select.value !== '__new__'; });

    var drop = h('div', { class: 'drop-zone', tabindex: '0', role: 'button' });
    drop.appendChild(icon(ICONS.upload));
    drop.appendChild(h('span', null, h('b', { text: '选择题库文件' }), ' 或拖到这里'));
    drop.appendChild(h('span', { text: 'txt / json / md / pdf / docx / 截图' }));
    var fileInput = h('input', {
      type: 'file',
      accept: '.txt,.json,.jsonl,.md,.pdf,.docx,.doc,image/*,text/plain,application/json,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      hidden: true
    });
    body.appendChild(drop);
    body.appendChild(fileInput);

    var textarea = h('textarea', {
      id: 'importText',
      class: 'import-textarea',
      placeholder: '或直接粘贴题库内容：\n\n机会成本\n为了得到某种东西而放弃的最大价值。\n\n沉没成本\n已经发生、无法收回的支出。',
      'aria-label': '粘贴题库内容'
    });
    body.appendChild(textarea);
    body.appendChild(h('p', {
      class: 'import-help',
      text: 'txt：名词一行、解释跟几行，条目之间可无空行；名词前有序号（1. / （1） / 一、）时序号即分条标记；也支持逐行「名词：解释」。PDF 取文字层，Word 支持 .docx，截图会自动识别中文；识别结果仍按上面同一套规则切分。'
    }));

    var preview = h('div', { class: 'import-preview', text: '等待内容…' });
    body.appendChild(preview);

    function parseNow() {
      var text = textarea.value;
      if (!text.trim()) {
        parsed = null;
        preview.className = 'import-preview';
        preview.textContent = '等待内容…';
        footInfo.textContent = '支持 txt / json / pdf / docx / 图片';
        updateImportButton();
        return;
      }
      try {
        var nameHint = nameInput.value.trim();
        var result = C.parseImport(text, nameHint);
        parsed = result;
        preview.className = 'import-preview ok';
        preview.textContent = '可导入 ' + result.cards.length + ' 条词条';
        var list = h('ul', { class: 'preview-items' });
        result.cards.slice(0, 3).forEach(function (c) {
          list.appendChild(h('li', { text: c.term + ' — ' + c.def.replace(/\n/g, ' ').slice(0, 42) }));
        });
        if (result.cards.length > 3) list.appendChild(h('li', { text: '… 还有 ' + (result.cards.length - 3) + ' 条' }));
        preview.appendChild(list);
        footInfo.textContent = '将导入 ' + result.cards.length + ' 条';
      } catch (err) {
        parsed = null;
        preview.className = 'import-preview err';
        preview.textContent = err.message || '解析失败';
        footInfo.textContent = '暂无可导入内容';
      }
      updateImportButton();
    }

    var importBtn = h('button', {
      class: 'primary-btn',
      type: 'button',
      disabled: true,
      onclick: function () {
        if (!parsed) return;
        var deckId = select.value;
        var deckName = '';
        if (deckId === '__new__') {
          deckName = nameInput.value.trim() || parsed.name || '导入题库';
          deckName = deckName.replace(/\.[^.]+$/, '');
          deckId = store.createDeck(deckName).id;
        }
        var added = store.addCards(deckId, parsed.cards);
        store.setActiveDeck(deckId);
        closeModal();
        startSession();
        var deck = store.deckById(deckId);
        toast('已导入 ' + added.length + ' 条到「' + (deck ? deck.name : '题库') + '」');
      }
    }, '导入');

    function updateImportButton() {
      importBtn.disabled = !parsed || !parsed.cards.length;
      importBtn.textContent = parsed ? '导入 ' + parsed.cards.length + ' 条' : '导入';
    }

    var foot = document.createDocumentFragment();
    foot.appendChild(footInfo);
    foot.appendChild(h('button', {
      class: 'ghost-btn',
      type: 'button',
      onclick: function () {
        closeModal();
        if (onCancel) onCancel();
      }
    }, '取消'));
    foot.appendChild(importBtn);

    var debounce = null;
    textarea.addEventListener('input', function () {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(parseNow, 160);
    });

    function loadFile(file) {
      if (!file) return;
      var kind = MJZ.extract.kindOf(file);
      var limits = { text: 8, pdf: 30, docx: 20, doc: 8, image: 12 };
      if (file.size > (limits[kind] || 8) * 1024 * 1024) {
        toast('文件过大（该类型上限 ' + (limits[kind] || 8) + 'MB）');
        return;
      }
      var labels = { pdf: '正在读取 PDF…', docx: '正在读取 Word…', image: '正在识别图片文字…', text: '正在读取文件…' };
      preview.className = 'import-preview';
      preview.textContent = labels[kind] || '正在读取…';
      footInfo.textContent = '识别中，请稍候';
      importBtn.disabled = true;
      MJZ.extract.extract(file, function (a, b) {
        if (kind === 'image') {
          var pct = Math.round((Number(a) || 0) * 100);
          if (b === 'recognizing text') preview.textContent = '正在识别图片文字… ' + pct + '%';
          else if (b === 'loading language traineddata') preview.textContent = '正在下载中文识别包…';
          else if (b === 'initializing api' || b === 'loading tesseract core') preview.textContent = '正在初始化识别引擎…';
          else if (pct) preview.textContent = '正在识别图片文字… ' + pct + '%';
        } else if (kind === 'pdf') {
          preview.textContent = '正在读取 PDF… ' + a + ' / ' + b + ' 页';
        }
      }).then(function (text) {
        textarea.value = text;
        if (!nameInput.value) nameInput.value = file.name.replace(/\.[^.]+$/, '');
        if (select.value !== '__new__' && !store.deckById(select.value)) select.value = '__new__';
        parseNow();
      }).catch(function (err) {
        parsed = null;
        preview.className = 'import-preview err';
        preview.textContent = err && err.message ? err.message : '识别失败，请换一个文件试试';
        footInfo.textContent = '识别失败';
        importBtn.disabled = true;
      });
    }

    drop.addEventListener('click', function () { fileInput.click(); });
    drop.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
    });
    fileInput.addEventListener('change', function () {
      loadFile(fileInput.files && fileInput.files[0]);
    });
    drop.addEventListener('dragover', function (e) {
      e.preventDefault();
      drop.classList.add('dragover');
    });
    drop.addEventListener('dragleave', function () { drop.classList.remove('dragover'); });
    drop.addEventListener('drop', function (e) {
      e.preventDefault();
      drop.classList.remove('dragover');
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]);
    });

    openModal({
      kicker: 'Import',
      title: '导入题库',
      body: body,
      foot: foot
    });
    setTimeout(function () { textarea.focus(); }, 40);
  }

  /* ---------------- 设置 ---------------- */

  function openSettings() {
    var body = h('div');

    var g1 = h('div', { class: 'setting-group' });
    var row1 = h('div', { class: 'setting-row' });
    var label1 = h('div');
    label1.appendChild(h('div', { class: 'setting-label', text: '每日目标' }));
    label1.appendChild(h('div', { class: 'setting-desc', text: '0 表示不限；每天计划新学多少条新词条，到期复习不受限。' }));
    row1.appendChild(label1);

    var stepper = h('div', { class: 'stepper' });
    var minus = h('button', { type: 'button', 'aria-label': '减少', text: '−' });
    var input = h('input', { type: 'number', min: '0', max: '200', value: String(S.settings.dailyNew), 'aria-label': '每日目标' });
    var plus = h('button', { type: 'button', 'aria-label': '增加', text: '＋' });
    function applyDaily(v) {
      v = Math.max(0, Math.min(200, Math.round(Number(v) || 0)));
      S.settings.dailyNew = v;
      input.value = String(v);
      store.save();
    }
    minus.addEventListener('click', function () { applyDaily(Number(input.value) - 5); });
    plus.addEventListener('click', function () { applyDaily(Number(input.value) + 5); });
    input.addEventListener('change', function () { applyDaily(input.value); });
    stepper.appendChild(minus); stepper.appendChild(input); stepper.appendChild(plus);
    row1.appendChild(stepper);
    g1.appendChild(row1);
    body.appendChild(g1);

    var g2 = h('div', { class: 'setting-group' });
    var row2 = h('div', { class: 'setting-row' });
    var label2 = h('div');
    label2.appendChild(h('div', { class: 'setting-label', text: '正文字号' }));
    label2.appendChild(h('div', { class: 'setting-desc', text: '长时间背诵时选一个眼睛舒服的大小。' }));
    row2.appendChild(label2);
    var seg = h('div', { class: 'segmented' });
    [['s', '小'], ['m', '标准'], ['l', '大']].forEach(function (opt) {
      seg.appendChild(h('button', {
        type: 'button',
        class: S.settings.fontScale === opt[0] ? 'active' : '',
        text: opt[1],
        onclick: function (e) {
          S.settings.fontScale = opt[0];
          applyFontScale();
          store.save();
          Array.prototype.forEach.call(seg.children, function (b) { b.classList.remove('active'); });
          e.currentTarget.classList.add('active');
        }
      }));
    });
    row2.appendChild(seg);
    g2.appendChild(row2);
    body.appendChild(g2);

    var gR = h('div', { class: 'setting-group' });
    var rowR = h('div', { class: 'setting-row' });
    var labelR = h('div');
    labelR.appendChild(h('div', { class: 'setting-label', text: '点亮范围' }));
    labelR.appendChild(h('div', { class: 'setting-desc', text: '点击字块时，一起点亮的相邻字数；标点会隔断提示，不跨标点；英文与数字按整词。' }));
    rowR.appendChild(labelR);
    var segR = h('div', { class: 'segmented' });
    [[0, '仅本字'], [1, '±1 字'], [2, '±2 字']].forEach(function (opt) {
      segR.appendChild(h('button', {
        type: 'button',
        class: S.settings.revealRadius === opt[0] ? 'active' : '',
        text: opt[1],
        onclick: function (e) {
          S.settings.revealRadius = opt[0];
          store.save();
          Array.prototype.forEach.call(segR.children, function (b) { b.classList.remove('active'); });
          e.currentTarget.classList.add('active');
        }
      }));
    });
    rowR.appendChild(segR);
    gR.appendChild(rowR);
    body.appendChild(gR);

    var gH = h('div', { class: 'setting-group' });
    var rowH = h('div', { class: 'setting-row' });
    var labelH = h('div');
    labelH.appendChild(h('div', { class: 'setting-label', text: '划线标记' }));
    labelH.appendChild(h('div', { class: 'setting-desc', text: '荧光笔覆盖文字；横线与波浪线只在下缘标记，不遮字。' }));
    rowH.appendChild(labelH);
    var segH = h('div', { class: 'segmented' });
    [['marker', '荧光笔'], ['line', '横线'], ['wavy', '波浪线']].forEach(function (opt) {
      segH.appendChild(h('button', {
        type: 'button',
        class: S.settings.highlightStyle === opt[0] ? 'active' : '',
        text: opt[1],
        onclick: function (e) {
          S.settings.highlightStyle = opt[0];
          store.save();
          Array.prototype.forEach.call(segH.children, function (b) { b.classList.remove('active'); });
          e.currentTarget.classList.add('active');
        }
      }));
    });
    rowH.appendChild(segH);
    gH.appendChild(rowH);
    body.appendChild(gH);

    var gC = h('div', { class: 'setting-group' });
    var rowC = h('div', { class: 'setting-row' });
    var labelC = h('div');
    labelC.appendChild(h('div', { class: 'setting-label', text: '划线颜色' }));
    labelC.appendChild(h('div', { class: 'setting-desc', text: '新建标记使用这个颜色；已有标记保持原样。' }));
    rowC.appendChild(labelC);
    var swatches = h('div', { class: 'swatches' });
    [['yellow', '黄'], ['green', '绿'], ['pink', '粉']].forEach(function (opt) {
      swatches.appendChild(h('button', {
        type: 'button',
        class: 'swatch ' + opt[0] + (S.settings.highlightColor === opt[0] ? ' active' : ''),
        'aria-label': opt[1] + '色',
        onclick: function (e) {
          S.settings.highlightColor = opt[0];
          store.save();
          Array.prototype.forEach.call(swatches.children, function (b) { b.classList.remove('active'); });
          e.currentTarget.classList.add('active');
        }
      }));
    });
    rowC.appendChild(swatches);
    gC.appendChild(rowC);
    body.appendChild(gC);

    var g3 = h('div', { class: 'setting-group' });
    var row3 = h('div', { class: 'setting-row' });
    var label3 = h('div');
    label3.appendChild(h('div', { class: 'setting-label', text: '重置本库进度' }));
    label3.appendChild(h('div', { class: 'setting-desc', text: '清空排期，所有词条重新作为新卡开始；高亮标记会保留。' }));
    row3.appendChild(label3);
    row3.appendChild(h('button', {
      class: 'danger-btn',
      type: 'button',
      onclick: function () {
        var deck = store.activeDeck();
        if (!deck) return;
        askConfirm('Settings', '重置进度', '重置「' + deck.name + '」的全部学习进度？高亮标记会保留。', '重置', function () {
          var n = store.resetDeckProgress(deck.id);
          startSession();
          toast('已重置 ' + n + ' 条词条的进度');
        }, openSettings);
      }
    }, '重置'));
    g3.appendChild(row3);
    body.appendChild(g3);

    var g4 = h('div', { class: 'setting-group' });
    g4.appendChild(h('div', { class: 'setting-label', text: '关于' }));
    g4.appendChild(h('p', { class: 'about-author', text: '作者：Anyu' }));
    g4.appendChild(h('p', {
      class: 'about-note',
      text: 'NounKiller v' + APP_VERSION + ' · 专注名词解释的背诵工具。先凭记忆讲一遍，用三级自评标出不熟；逐字点亮补全解释，再用间隔重复把「看过」练成「说得出」。'
    }));
    g4.appendChild(h('p', {
      class: 'about-note',
      text: '题库、进度与划线默认保存在本机；登录后可同步到自己的云端，也能建群共享题库、邀请同学一起背。'
    }));
    body.appendChild(g4);

    openModal({
      kicker: 'Settings',
      title: '设置',
      body: body,
      foot: modalFoot('完成', closeModal)
    });
  }

  function applyFontScale() {
    els.body.classList.remove('font-s', 'font-l');
    if (S.settings.fontScale === 's') els.body.classList.add('font-s');
    if (S.settings.fontScale === 'l') els.body.classList.add('font-l');
  }

  /* ---------------- 事件绑定 ---------------- */

  els.ratingBar.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-rating]');
    if (!btn) return;
    rateCard(btn.dataset.rating);
  });

  els.nextRow.addEventListener('click', function (e) {
    if (e.target.closest('#nextBtn')) nextCard();
  });

  els.answer.addEventListener('click', function (e) {
    if (app.phase !== 'recall') return;
    if (e.target.closest('#revealAll')) { toggleRevealAll(); return; }
    var ph = e.target.closest('.ph');
    if (!ph) return;
    var i = Number(ph.dataset.i);
    if (app.revealed.has(i)) {
      var next = C.nextHiddenIndex(app.current.def, i);
      if (next >= 0) revealAt(next);
    } else {
      revealAt(i);
    }
  });

  els.answerTools.addEventListener('click', function (e) {
    if (e.target.closest('#markToggle')) {
      app.marking = !app.marking;
      if (app.marking) app.erasing = false;
      else store.saveNow();
      clearSelection();
      renderRevealed();
      toast(app.marking ? '拖动文字直接划线' : '划线已保存');
      return;
    }
    if (e.target.closest('#eraseToggle')) {
      app.erasing = !app.erasing;
      if (app.erasing) app.marking = false;
      clearSelection();
      renderRevealed();
      toast(app.erasing ? '在标记上滑动即可擦除' : '已退出擦除');
      return;
    }
    if (e.target.closest('#clearMarks')) {
      clearMarks();
    }
  });

  // 高亮选择的拖拽
  els.answer.addEventListener('pointerdown', function (e) {
    if (app.phase !== 'revealed' || (!app.marking && !app.erasing)) return;
    var charEl = e.target.closest('.c');
    if (!charEl) return;
    e.preventDefault();
    app.selection = { a: Number(charEl.dataset.i), b: Number(charEl.dataset.i) };
    app.dragging = true;
    app.painted = null;
    paintSelection(selectionRange());
    try { els.answer.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
  });

  els.answer.addEventListener('pointermove', function (e) {
    if (!app.dragging) return;
    var idx = indexFromPoint(e.clientX, e.clientY);
    if (idx < 0) return;
    app.selection.b = idx;
    paintSelection(selectionRange());
  });

  function endSelection(e) {
    if (!app.dragging) return;
    app.dragging = false;
    try { els.answer.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    var range = selectionRange();
    if (!range || range.end <= range.start) { clearSelection(); return; }
    // 松手即生效：划线直接上色，擦除直接清除，不再弹调色盘
    if (app.erasing) eraseMark();
    else applyMark();
  }

  els.answer.addEventListener('pointerup', endSelection);
  els.answer.addEventListener('pointercancel', function (e) {
    app.dragging = false;
    try { els.answer.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
  });

  els.deckBtn.addEventListener('click', function () { openDecks(); });
  els.settingsBtn.addEventListener('click', openSettings);
  if (els.favBtn) els.favBtn.addEventListener('click', function () {
    var card = app.current;
    if (!card) return;
    card.fav = !card.fav;
    els.favBtn.classList.toggle('on', !!card.fav);
    els.favBtn.setAttribute('aria-pressed', String(!!card.fav));
    els.favBtn.setAttribute('aria-label', (card.fav ? '取消收藏 ' : '收藏 ') + card.term);
    store.save();
  });
  if (els.tocBtn) els.tocBtn.addEventListener('click', openToc);
  if (els.prevBtn) els.prevBtn.addEventListener('click', prevCard);
  // 品牌名始终一行；先让题库选择与图标间距收缩，仍放不下才等比缩小字号
  function fitBrandName() {
    var name = els.brandName;
    if (!name) return;
    var appbar = name.closest ? name.closest('.appbar') : null;
    name.style.fontSize = '';
    var base = parseFloat(getComputedStyle(name).fontSize) || 20;
    var size = base;
    var guard = 0;
    while (appbar && appbar.scrollWidth > appbar.clientWidth + 1 && size > 11 && guard < 40) {
      size = Math.max(11, size - 0.5);
      name.style.fontSize = size + 'px';
      guard += 1;
      void appbar.scrollWidth;
    }
  }

  els.brandHome.addEventListener('click', function () {
    if (app.phase === 'done' && app.doneKind === 'summary') return;
    if (app.phase === 'prompt' || app.phase === 'revealed' || app.phase === 'recall') {
      // 回到本轮第一张之前不现实，这里只把页面滚回顶部
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  });

  els.modal.addEventListener('click', function (e) {
    if (e.target.closest('[data-close]')) closeModal();
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      if (app.marking || app.erasing) {
        app.marking = false; app.erasing = false; clearSelection(); renderRevealed(); return;
      }
      if (app.modalOpen) { closeModal(); return; }
    }
    if (app.modalOpen) return;
    var tag = (e.target && e.target.tagName) || '';
    if (/INPUT|TEXTAREA|SELECT/.test(tag)) return;

    if (e.key === 'ArrowLeft' && (app.phase === 'prompt' || app.phase === 'revealed' || app.phase === 'recall')) {
      e.preventDefault();
      prevCard();
      return;
    }

    if (app.phase === 'prompt') {
      if (e.key === '1') { e.preventDefault(); rateCard('unknown'); }
      else if (e.key === '2') { e.preventDefault(); rateCard('fuzzy'); }
      else if (e.key === '3') { e.preventDefault(); rateCard('known'); }
      return;
    }
    if (app.phase === 'revealed' || app.phase === 'recall') {
      if (e.key === ' ' || e.key === 'Enter') {
        if (tag === 'BUTTON') return;
        e.preventDefault();
        nextCard();
      }
    }
  });

  // Android 返回键：先关弹层/调色盘，返回 true 表示已消费
  window.nkBack = function () {
    if (app.marking || app.erasing) {
      app.marking = false; app.erasing = false; clearSelection(); renderRevealed(); return true;
    }
    if (app.modalOpen) { closeModal(); return true; }
    return false;
  };

  // 点击遮罩关闭
  document.addEventListener('click', function (e) {
    if (app.modalOpen && e.target.classList && e.target.classList.contains('modal-backdrop')) {
      closeModal();
    }
  });

  /* ---------------- 启动 ---------------- */

  // 每晚 0:00 自动换日：重置每日目标额度，并把到期的卡重新排进本轮
  var lastDay = C.dateKey();
  function refreshIfNewDay() {
    var today = C.dateKey();
    if (today === lastDay) return;
    lastDay = today;
    store.ensureToday();
    var deck = store.activeDeck();
    if (app.phase === 'done' && app.doneKind === 'rest' && !(deck && deck.virtual)) startSession();
    else render();
  }
  function armMidnightRefresh() {
    var delay = Math.max(1000, C.addDays(Date.now(), 1) - Date.now() + 1000);
    setTimeout(function () {
      refreshIfNewDay();
      armMidnightRefresh();
    }, delay);
  }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') refreshIfNewDay();
  });

  function measureAppbar() {
    var bar = document.querySelector('.appbar');
    if (!bar) return;
    var h = Math.round(bar.getBoundingClientRect().height);
    if (h > 0) document.documentElement.style.setProperty('--appbar-h', h + 'px');
  }

  function boot() {
    measureAppbar();
    window.addEventListener('resize', measureAppbar);
    window.addEventListener('orientationchange', function () { setTimeout(measureAppbar, 120); });
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(measureAppbar);
    fitBrandName();
    var brandFitFrame = null;
    window.addEventListener('resize', function () {
      if (brandFitFrame) cancelAnimationFrame(brandFitFrame);
      brandFitFrame = requestAnimationFrame(fitBrandName);
    });
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(fitBrandName);
    applyFontScale();
    store.ensureToday();
    lastDay = C.dateKey();
    startSession();
    armMidnightRefresh();
  }

  // 供 account.js 复用界面与状态
  window.MJZ.app = {
    get state() { return S; },
    get store() { return store; },
    replaceState: function (raw) {
      S = store.replaceState(raw);
      applyFontScale();
      startSession();
      return S;
    },
    // 群组分享的题库并入同名题库，避免每次导入都多出一个重名题库
    importDeck: function (name, cards) {
      var items = (cards || []).filter(function (c) {
        return c && typeof c.term === 'string' && typeof c.def === 'string' && c.term.trim() && c.def.trim();
      });
      if (!items.length) return { deck: null, added: 0 };
      var wanted = (name || '群组题库').slice(0, 60);
      var deck = store.state.decks.filter(function (d) {
        return !d.virtual && d.name === wanted;
      })[0];
      if (!deck) deck = store.createDeck(wanted);
      var added = store.addCards(deck.id, items);
      return { deck: deck, added: added.length };
    },
    openModal: openModal,
    closeModal: closeModal,
    modalFoot: modalFoot,
    askConfirm: askConfirm,
    toast: toast,
    h: h
  };

  boot();
})();
