/*!
 * NounKiller · store.js
 * 状态持久化：网页用 localStorage；原生壳通过 NounKillerNative / WKWebView 注入与消息回写。
 */
(function (global) {
  'use strict';

  var C = global.MJZ.core;
  var KEY = 'nounkiller.state.v1';
  var LEGACY_KEY = 'mingjiezhan.state.v1';
  var FAV_DECK_ID = '__favorites__';
  var FAV_DECK_NAME = '总收藏题库';
  var SAVE_DELAY = 250;

  var nativeStore = {
    read: function () {
      try {
        if (global.NounKillerNative && typeof global.NounKillerNative.loadState === 'function') {
          var s = global.NounKillerNative.loadState();
          if (s) return s;
        }
      } catch (e) { /* 原生桥不可用则继续回退 */ }
      try {
        if (typeof global.__NOUNKILLER_STATE__ === 'string' && global.__NOUNKILLER_STATE__) {
          return global.__NOUNKILLER_STATE__;
        }
      } catch (e2) { /* ignore */ }
      try {
        var cur = global.localStorage.getItem(KEY);
        if (cur) return cur;
        // 兼容更名前的旧数据，首次读取后由下一次保存写入新 key
        return global.localStorage.getItem(LEGACY_KEY);
      } catch (e3) {
        return null;
      }
    },
    write: function (json) {
      try { global.localStorage.setItem(KEY, json); } catch (e) { /* file:// 下可能禁写 */ }
      try {
        if (global.NounKillerNative && typeof global.NounKillerNative.saveState === 'function') {
          global.NounKillerNative.saveState(json);
        }
      } catch (e2) { /* ignore */ }
      try {
        var w = global.webkit;
        if (w && w.messageHandlers && w.messageHandlers.nounkillerState) {
          w.messageHandlers.nounkillerState.postMessage(json);
        }
      } catch (e3) { /* ignore */ }
    }
  };

  function sampleCards() {
    return [
      {
        term: '机会成本',
        def: '为了得到某种东西而所要放弃的另一些东西的最大价值。\n\n它不一定等于会计成本：你选择了读研，成本不只是学费，还包括这两年本可以工作挣到的收入。'
      },
      {
        term: '沉没成本',
        def: '已经发生、无法收回的支出，例如已经花掉的电影票钱。\n\n理性的决策应当只看未来的边际收益与边际成本，而不应被沉没成本左右——「来都来了」不是继续投入的理由。'
      },
      {
        term: '边际效用递减',
        def: '在一定时间内，其他条件不变时，随着消费者对某种商品消费量的增加，每增加一单位该商品所带来的效用增量递减。\n\n第一杯水解渴，第二杯舒服，第三杯就只是负担。'
      },
      {
        term: '间隔重复',
        def: '一种根据遗忘曲线安排复习时点的学习方法：每次成功回忆后，逐步拉长下一次复习的间隔；回忆失败则缩短间隔。\n\n它的目标不是「一次记住」，而是在快要忘记的时刻恰好再想起一次。'
      },
      {
        term: '测试效应',
        def: '主动从记忆中提取信息（测试、默写、复述），比反复阅读同一材料更能促进长期记忆保持的现象。\n\n换句话说：想起一次，胜过重读十遍。'
      },
      {
        term: '帕累托最优',
        def: '一种资源配置状态：在不使任何其他人境况变坏的前提下，已经无法再使至少一个人的境况变好。\n\n它描述的是「没有免费改进空间」，并不等同于公平或人人满意。'
      }
    ];
  }

  function freshState() {
    var now = Date.now();
    var deckId = C.uid();
    var cards = sampleCards().map(function (item) {
      return {
        id: C.uid(),
        deckId: deckId,
        term: item.term,
        def: item.def,
        createdAt: now,
        srs: C.newSrs(now),
        highlights: []
      };
    });
    return {
      version: 3,
      createdAt: now,
      activeDeckId: deckId,
      decks: [{ id: deckId, name: '示例题库 · 记忆与决策', createdAt: now, sample: true }],
      cards: cards,
      stats: freshStats(now),
      settings: { dailyNew: 0, fontScale: 'm', revealRadius: 1, highlightStyle: 'marker', highlightColor: 'yellow' }
    };
  }

  function freshStats(now) {
    return {
      day: C.dateKey(now || Date.now()),
      newStudied: 0,
      reviews: 0,
      ratings: { known: 0, fuzzy: 0, unknown: 0 }
    };
  }

  function isPlainObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
  }

  function normalize(state) {
    if (!isPlainObject(state) || !Array.isArray(state.decks) || !Array.isArray(state.cards)) return null;
    var deckIds = new Set();
    state.decks = state.decks.filter(function (d) {
      if (!isPlainObject(d) || typeof d.id !== 'string' || !d.id || deckIds.has(d.id)) return false;
      deckIds.add(d.id);
      d.name = typeof d.name === 'string' && d.name.trim() ? d.name.trim() : '未命名题库';
      d.createdAt = Number(d.createdAt) || Date.now();
      return true;
    });
    if (!state.decks.length) return null;

    state.cards = state.cards.filter(function (c) {
      if (!isPlainObject(c) || typeof c.id !== 'string' || !c.id) return false;
      if (typeof c.term !== 'string' || !c.term.trim() || typeof c.def !== 'string' || !c.def.trim()) return false;
      if (!deckIds.has(c.deckId)) return false;
      c.term = c.term.trim();
      c.def = c.def.replace(/\r\n?/g, '\n').trim();
      c.createdAt = Number(c.createdAt) || Date.now();
      c.srs = Object.assign(C.newSrs(c.createdAt), isPlainObject(c.srs) ? c.srs : {});
      c.fav = c.fav === true;
      c.highlights = Array.isArray(c.highlights)
        ? c.highlights.filter(function (h) {
            return isPlainObject(h) && Number.isFinite(h.start) && Number.isFinite(h.end) &&
              h.end > h.start && h.start >= 0 && typeof h.color === 'string';
          }).map(function (h) {
            var style = h.style;
            if (style !== 'marker' && style !== 'line' && style !== 'wavy') {
              style = h.color === 'underline' ? 'line' : 'marker';
            }
            var color = h.color === 'underline' ? 'yellow' : h.color;
            if (color !== 'yellow' && color !== 'green' && color !== 'pink') color = 'yellow';
            return { start: h.start, end: h.end, color: color, style: style };
          })
        : [];
      return true;
    });

    var validCardIds = new Set(state.cards.map(function (c) { return c.id; }));
    if (state.activeDeckId !== FAV_DECK_ID && !deckIds.has(state.activeDeckId)) {
      state.activeDeckId = state.decks[0].id;
    }
    void validCardIds;

    var today = C.dateKey();
    if (!isPlainObject(state.stats) || state.stats.day !== today) state.stats = freshStats();
    state.stats.newStudied = Number(state.stats.newStudied) || 0;
    state.stats.reviews = Number(state.stats.reviews) || 0;
    state.stats.ratings = Object.assign({ known: 0, fuzzy: 0, unknown: 0 }, state.stats.ratings || {});

    var settings = isPlainObject(state.settings) ? state.settings : {};
    state.settings = {
      dailyNew: Math.max(0, Math.min(200, settings.dailyNew == null ? 0 : (Number(settings.dailyNew) || 0))),
      fontScale: ['s', 'm', 'l'].indexOf(settings.fontScale) >= 0 ? settings.fontScale : 'm',
      revealRadius: [0, 1, 2, 3].indexOf(Number(settings.revealRadius)) >= 0 ? Number(settings.revealRadius) : 1,
      highlightStyle: ['marker', 'line', 'wavy'].indexOf(settings.highlightStyle) >= 0 ? settings.highlightStyle : 'marker',
      highlightColor: ['yellow', 'green', 'pink'].indexOf(settings.highlightColor) >= 0 ? settings.highlightColor : 'yellow'
    };
    var version = Number(state.version) || 1;
    if (version < 2) state.settings.dailyNew = 0;
    if (version < 3) {
      // 旧版按「24 小时后」排期，升级后统一落到当天 0:00，改为每晚刷新
      state.cards.forEach(function (c) {
        if (c.srs && c.srs.state === 'review' && c.srs.due) c.srs.due = C.dayStart(c.srs.due);
      });
    }
    state.version = 3;
    return state;
  }

  function load() {
    var raw = nativeStore.read();
    if (raw) {
      try {
        var parsed = normalize(JSON.parse(raw));
        if (parsed) {
          ensureToday(parsed);
          return parsed;
        }
      } catch (e) {
        console.warn('[NounKiller] 本地数据损坏，已启用新数据：', e);
      }
    }
    return freshState();
  }

  function ensureToday(state) {
    var today = C.dateKey();
    if (state.stats.day !== today) {
      state.stats = freshStats();
      return true;
    }
    return false;
  }

  function createStore() {
    var state = load();
    var timer = null;
    var dirty = false;

    function saveNow() {
      if (timer) { clearTimeout(timer); timer = null; }
      dirty = false;
      try {
        nativeStore.write(JSON.stringify(state));
      } catch (e) {
        console.warn('[NounKiller] 保存失败', e);
      }
    }

    function save() {
      dirty = true;
      if (timer) clearTimeout(timer);
      timer = setTimeout(saveNow, SAVE_DELAY);
    }

    function deckCards(deckId) {
      if (deckId === FAV_DECK_ID) return state.cards.filter(function (c) { return c.fav; });
      return state.cards.filter(function (c) { return c.deckId === deckId; });
    }

    function deckById(id) {
      if (id === FAV_DECK_ID) return { id: FAV_DECK_ID, name: FAV_DECK_NAME, virtual: true };
      for (var i = 0; i < state.decks.length; i++) if (state.decks[i].id === id) return state.decks[i];
      return null;
    }

    function activeDeck() {
      return deckById(state.activeDeckId) || state.decks[0] || null;
    }

    function setActiveDeck(id) {
      if (!deckById(id)) return false;
      state.activeDeckId = id;
      save();
      return true;
    }

    function createDeck(name) {
      var now = Date.now();
      var deck = { id: C.uid(), name: (name || '新题库').trim() || '新题库', createdAt: now };
      state.decks.push(deck);
      state.activeDeckId = deck.id;
      save();
      return deck;
    }

    function renameDeck(id, name) {
      var deck = deckById(id);
      name = (name || '').trim();
      if (!deck || !name) return false;
      deck.name = name.slice(0, 60);
      save();
      return true;
    }

    function deleteDeck(id) {
      var idx = state.decks.findIndex(function (d) { return d.id === id; });
      if (idx < 0) return false;
      state.decks.splice(idx, 1);
      state.cards = state.cards.filter(function (c) { return c.deckId !== id; });
      if (!state.decks.length) {
        var deck = { id: C.uid(), name: '新题库', createdAt: Date.now() };
        state.decks.push(deck);
      }
      if (state.activeDeckId === id) state.activeDeckId = state.decks[0].id;
      save();
      return true;
    }

    function addCards(deckId, items) {
      var now = Date.now();
      var added = [];
      var existing = new Set(deckCards(deckId).map(function (c) { return c.term + '\u0001' + c.def; }));
      for (var i = 0; i < items.length; i++) {
        var item = items[i];
        var key = item.term + '\u0001' + item.def;
        if (existing.has(key)) continue;
        existing.add(key);
        var card = {
          id: C.uid(),
          deckId: deckId,
          term: item.term.trim(),
          def: item.def.replace(/\r\n?/g, '\n').trim(),
          createdAt: now,
          srs: C.newSrs(now),
          highlights: []
        };
        state.cards.push(card);
        added.push(card);
      }
      if (added.length) save();
      return added;
    }

    /** 整库重写：按名词保留原有卡片（进度、标记不丢），解释就地更新。 */
    function replaceDeckCards(deckId, items) {
      var existing = deckCards(deckId);
      var byTerm = new Map();
      existing.forEach(function (c) {
        if (!byTerm.has(c.term)) byTerm.set(c.term, c);
      });
      var used = new Set();
      var rebuilt = [];
      var now = Date.now();
      for (var i = 0; i < items.length; i++) {
        var item = items[i];
        var hit = byTerm.get(item.term);
        if (hit && !used.has(hit.id)) {
          used.add(hit.id);
          hit.def = item.def;
          rebuilt.push(hit);
        } else {
          rebuilt.push({
            id: C.uid(),
            deckId: deckId,
            term: item.term,
            def: item.def,
            createdAt: now,
            srs: C.newSrs(now),
            highlights: []
          });
        }
      }
      state.cards = state.cards.filter(function (c) { return c.deckId !== deckId; }).concat(rebuilt);
      save();
      return rebuilt.length;
    }

    function resetDeckProgress(deckId) {
      var now = Date.now();
      var count = 0;
      for (var i = 0; i < state.cards.length; i++) {
        if (deckId === FAV_DECK_ID ? state.cards[i].fav : state.cards[i].deckId === deckId) {
          state.cards[i].srs = C.newSrs(now);
          count++;
        }
      }
      if (count) save();
      return count;
    }

    function recordRating(rating, isNew) {
      ensureToday(state);
      var s = state.stats;
      s.reviews++;
      if (isNew) s.newStudied++;
      s.ratings[rating] = (s.ratings[rating] || 0) + 1;
      save();
    }

    function newAllowance() {
      var limit = state.settings.dailyNew;
      if (limit === 0) return Infinity;
      return Math.max(0, limit - state.stats.newStudied);
    }

    function findCard(id) {
      for (var i = 0; i < state.cards.length; i++) if (state.cards[i].id === id) return state.cards[i];
      return null;
    }

    // 退回到后台/关闭页面时立即落盘
    global.addEventListener('pagehide', saveNow);
    global.addEventListener('visibilitychange', function () {
      if (global.document.visibilityState === 'hidden') saveNow();
    });

    return {
      state: state,
      save: save,
      saveNow: saveNow,
      deckCards: deckCards,
      deckById: deckById,
      activeDeck: activeDeck,
      setActiveDeck: setActiveDeck,
      createDeck: createDeck,
      renameDeck: renameDeck,
      deleteDeck: deleteDeck,
      addCards: addCards,
      replaceDeckCards: replaceDeckCards,
      resetDeckProgress: resetDeckProgress,
      recordRating: recordRating,
      newAllowance: newAllowance,
      findCard: findCard,
      ensureToday: function () {
        var changed = ensureToday(state);
        if (changed) save();
        return changed;
      },
      isDirty: function () { return dirty; },
      FAV_DECK_ID: FAV_DECK_ID,
      FAV_DECK_NAME: FAV_DECK_NAME
    };
  }

  global.MJZ = global.MJZ || {};
  global.MJZ.store = {
    create: createStore,
    freshState: freshState,
    KEY: KEY,
    LEGACY_KEY: LEGACY_KEY
  };
})(typeof window !== 'undefined' ? window : globalThis);
