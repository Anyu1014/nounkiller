/*!
 * NounKiller · core.js
 * 纯逻辑层：分词/遮挡、点击揭秘范围、题库解析、间隔重复调度、高亮区间运算。
 * 不依赖 DOM，可在 Node 中直接测试（见 src/test/run.mjs）。
 */
(function (global) {
  'use strict';

  var DAY = 86400000;
  var MIN = 60000;

  var RE_PUNCT = /[\p{P}]/u;
  var RE_SPACE = /\s/u;
  var RE_WORD = /[A-Za-z0-9'’\-]/;

  /* ---------------- 字符与回忆遮挡 ---------------- */

  function classifyChar(ch) {
    if (RE_SPACE.test(ch)) return 'space';
    if (RE_PUNCT.test(ch)) return 'punct';
    return 'char';
  }

  function tokenize(text) {
    var chars = Array.from(String(text == null ? '' : text));
    var out = new Array(chars.length);
    for (var i = 0; i < chars.length; i++) {
      out[i] = { i: i, ch: chars[i], type: classifyChar(chars[i]) };
    }
    return out;
  }

  function hiddenCount(text) {
    var tokens = tokenize(text), n = 0;
    for (var i = 0; i < tokens.length; i++) if (tokens[i].type === 'char') n++;
    return n;
  }

  /**
   * 点一次要揭开的字块。
   * 中文等：点击位置 + 前后各一个字（共最多 3 字），作为线索。
   * 英文/数字：按整个连续词揭示，避免逐个字母敲。
   */
  /**
   * 点击某字时要点亮的字位。
   * radius 为向左右各扩展的字数（默认 1）；遇到标点/空白立即停止，绝不跨标点提示。
   * 英文与数字仍按整词揭开，避免只亮出一个字母。
   */
  function revealCluster(text, index, radius) {
    var tokens = tokenize(text);
    var set = new Set();
    if (index < 0 || index >= tokens.length) return set;
    var t = tokens[index];
    if (!t || t.type !== 'char') return set;

    if (RE_WORD.test(t.ch)) {
      var start = index, end = index;
      while (start > 0 && tokens[start - 1].type === 'char' && RE_WORD.test(tokens[start - 1].ch) && index - start < 24) start--;
      while (end < tokens.length - 1 && tokens[end + 1].type === 'char' && RE_WORD.test(tokens[end + 1].ch) && end - index < 24) end++;
      for (var k = start; k <= end; k++) if (tokens[k].type === 'char') set.add(k);
      return set;
    }

    var r = Math.max(0, Math.min(3, Math.round(radius == null ? 1 : Number(radius) || 0)));
    set.add(index);
    var step;
    for (step = 1; step <= r; step++) {
      var left = tokens[index - step];
      if (!left || left.type !== 'char') break;
      set.add(index - step);
    }
    for (step = 1; step <= r; step++) {
      var right = tokens[index + step];
      if (!right || right.type !== 'char') break;
      set.add(index + step);
    }
    return set;
  }

  /** 从某个位置之后（含回退）寻找下一个仍隐藏的字。 */
  function nextHiddenIndex(text, from) {
    var tokens = tokenize(text);
    for (var i = from + 1; i < tokens.length; i++) if (tokens[i].type === 'char') return i;
    for (var j = from - 1; j >= 0; j--) if (tokens[j].type === 'char') return j;
    return -1;
  }

  /* ---------------- 高亮区间（[start, end) 码点下标） ---------------- */

  function normalizeRange(a, b) {
    var start = Math.min(a, b), end = Math.max(a, b) + 1;
    return { start: Math.max(0, start), end: Math.max(0, end) };
  }

  function subtractHighlight(list, start, end) {
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var h = list[i];
      if (h.end <= start || h.start >= end) { out.push(h); continue; }
      if (h.start < start) out.push({ start: h.start, end: start, color: h.color, style: h.style });
      if (h.end > end) out.push({ start: end, end: h.end, color: h.color, style: h.style });
    }
    return out;
  }

  /** 覆盖式写入：新标记会切掉与之重叠的旧标记。 */
  function addHighlight(list, start, end, color, style) {
    if (end <= start) return list.slice();
    var trimmed = subtractHighlight(list, start, end);
    trimmed.push({ start: start, end: end, color: color, style: style || 'marker' });
    trimmed.sort(function (a, b) { return a.start - b.start || a.end - b.end; });
    return trimmed;
  }

  function removeHighlight(list, start, end) {
    return subtractHighlight(list, start, end);
  }

  function highlightAt(list, index) {
    var found = null;
    for (var i = 0; i < list.length; i++) {
      if (list[i].start <= index && index < list[i].end) found = list[i];
    }
    return found;
  }

  /* ---------------- 题库解析 ---------------- */

  var TERM_KEYS = ['term', 'name', 'title', 'word', 'front', 'q', '名词', '术语', '词条', '标题', '题目'];
  var DEF_KEYS = ['definition', 'def', 'content', 'text', 'explanation', 'meaning', 'back', 'a', '解释', '释义', '定义', '内容', '描述', '答案'];

  function pick(obj, keys) {
    for (var i = 0; i < keys.length; i++) {
      var v = obj[keys[i]];
      if (typeof v === 'string' && v.trim()) return v;
      if (typeof v === 'number') return String(v);
    }
    return '';
  }

  function cleanTerm(s) {
    return String(s || '')
      .replace(/^\uFEFF/, '')
      .replace(/^#{1,6}\s*/, '')
      .replace(/^\*\*(.+)\*\*$/, '$1')
      .replace(/^(?:第?\s*)?[0-9０-９]{1,3}\s*[.、)．）]\s*/, '')
      .replace(/^[（(]\s*[0-9０-９一二三四五六七八九十]{1,3}\s*[）)]\s*/, '')
      .replace(/^[一二三四五六七八九十]{1,3}\s*[、.．]\s*/, '')
      .replace(/^\*\*(.+)\*\*$/, '$1')
      .replace(/[：:]\s*$/, '')
      .trim();
  }

  function cleanDef(s) {
    return String(s || '').replace(/\uFEFF/g, '').replace(/\r\n?/g, '\n').trim();
  }

  function validCard(term, def) {
    term = cleanTerm(term);
    def = cleanDef(def);
    if (!term || !def) return null;
    if (term.length > 120) return null;
    return { term: term, def: def };
  }

  function dedupe(cards) {
    var seen = new Set(), out = [];
    for (var i = 0; i < cards.length; i++) {
      var c = cards[i], key = c.term + '\u0001' + c.def;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(c);
    }
    return out;
  }

  /**
   * txt / md 题库解析。依次尝试：
   * 1. 「名词：解释」逐行写法（整段至少 60% 行是这种结构）；
   * 2. 名词一行、解释若干行，条目之间可以没有空行：
   *    靠「短行 + 下一行像解释」判断新名词；编号行（1. / （1） / 一、）永远算新条目；
   * 3. 空行或 --- 分隔的传统写法。
   * 解释里的短句（如举例分行）不会被误判成名词，因为下一行同样很短且没有句末标点。
   */
  function parseText(raw) {
    var text = String(raw || '').replace(/\uFEFF/g, '').replace(/\r\n?/g, '\n');
    var lines = text.split('\n');
    var cards = [];
    var skipped = [];

    function stripHash(l) { return l.replace(/^#{1,6}\s*/, ''); }
    function isDecor(l) { return /^[-—=*_·\s]{3,}$/.test(l); }
    function numberedBody(l) {
      var body = stripHash(l).trim();
      var m = body.match(/^(?:第?\s*)?[0-9０-９]{1,3}\s*[.、)．）]\s*(.+)$/);
      if (m) return m[1];
      m = body.match(/^[（(]\s*[0-9０-９一二三四五六七八九十]{1,3}\s*[）)]\s*(.+)$/);
      if (m) return m[1];
      m = body.match(/^[一二三四五六七八九十]{1,3}\s*[、.．]\s*(.+)$/);
      if (m) return m[1];
      return null;
    }
    function splitInline(l) {
      var m = l.match(/^(.{1,60}?)[：:]\s*(.+)$/);
      if (m && m[1].trim() && !/[。！？；]/.test(m[1])) return { term: m[1].trim(), def: m[2].trim() };
      return null;
    }
    function isShortLine(l) {
      return l.length <= 40 && !/[。！？；，,、：:]$/.test(l) && !/[：:]/.test(l);
    }
    function looksLikeDef(l) {
      return l.length >= 8 || /[。！？；]$/.test(l);
    }

    // 1) 纯「名词：解释」逐行格式
    var nonEmpty = lines.map(function (l) { return stripHash(l).trim(); }).filter(Boolean);
    var pairs = [];
    for (var p = 0; p < nonEmpty.length; p++) {
      if (isDecor(nonEmpty[p]) || numberedBody(nonEmpty[p])) continue;
      var pair = splitInline(nonEmpty[p]);
      if (pair) { var pc = validCard(pair.term, pair.def); if (pc) pairs.push(pc); }
    }
    if (pairs.length >= 2 && pairs.length === nonEmpty.length) {
      return { cards: dedupe(pairs), skipped: skipped };
    }
    // 但全部只有一条「名词：解释」时也应当能导入
    if (pairs.length === 1 && nonEmpty.length === 1) {
      return { cards: dedupe(pairs), skipped: skipped };
    }

    // 2) 逐行扫描
    var cur = null;
    var defLines = [];

    function flush() {
      if (cur) {
        var card = validCard(cur, defLines.join('\n'));
        if (card) cards.push(card);
        else if (!defLines.length) skipped.push(cur.slice(0, 40));
      }
      cur = null;
      defLines = [];
    }

    for (var i = 0; i < lines.length; i++) {
      var line = stripHash(lines[i]).trim();
      if (!line) { flush(); continue; }
      if (isDecor(line)) { flush(); continue; }

      var numBody = numberedBody(lines[i]);
      if (numBody != null) {
        flush();
        var numInline = splitInline(numBody);
        if (numInline) { cur = numInline.term; defLines = [numInline.def]; }
        else { cur = numBody; defLines = []; }
        continue;
      }

      var prevEnds = defLines.length > 0 && /[。！？；]$/.test(defLines[defLines.length - 1]);
      var inline = splitInline(line);
      if (inline && (!cur || prevEnds)) {
        flush();
        cur = inline.term;
        defLines = [inline.def];
        continue;
      }

      var next = '';
      for (var j = i + 1; j < lines.length; j++) {
        var n = stripHash(lines[j]).trim();
        if (!n) break;
        next = n;
        break;
      }
      // 解释内部也可能分行写很短；只有上一行已经收句（或有编号/空行）时才让短行开新名词
      var startsTerm = isShortLine(line) && next && looksLikeDef(next) && (!cur || !defLines.length || prevEnds);
      if (!cur || startsTerm) {
        flush();
        cur = line;
        defLines = [];
        continue;
      }
      defLines.push(line);
    }
    flush();
    return { cards: dedupe(cards), skipped: skipped };
  }

  /** 兼容多种 JSON 结构：数组、{cards|items|data}、{名词: 解释}、多题库数组、JSONL。 */
  function parseJSON(raw) {
    var data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      // JSONL: 每行一个对象
      var lines = String(raw).split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
      var objs = [];
      try {
        for (var i = 0; i < lines.length; i++) objs.push(JSON.parse(lines[i]));
      } catch (e2) {
        throw new Error('JSON 格式无法解析：' + e.message);
      }
      data = objs;
    }

    var cards = [];
    var deckName = '';

    function push(term, def) {
      var c = validCard(term, def);
      if (c) cards.push(c);
    }

    function walk(node, depth) {
      if (!node || depth > 8) return;
      if (Array.isArray(node)) {
        for (var i = 0; i < node.length; i++) walk(node[i], depth + 1);
        return;
      }
      if (typeof node !== 'object') return;

      var term = pick(node, TERM_KEYS);
      var def = pick(node, DEF_KEYS);
      if (term && def) { push(term, def); return; }

      var arrKey = null;
      for (var k = 0; k < ['cards', 'items', 'list', 'data', 'entries', 'terms', 'decks'].length; k++) {
        if (Array.isArray(node[['cards', 'items', 'list', 'data', 'entries', 'terms', 'decks'][k]])) {
          arrKey = ['cards', 'items', 'list', 'data', 'entries', 'terms', 'decks'][k];
          break;
        }
      }
      if (arrKey) {
        if (!deckName && typeof node.name === 'string') deckName = node.name.trim();
        if (!deckName && typeof node.title === 'string') deckName = node.title.trim();
        walk(node[arrKey], depth + 1);
        return;
      }

      var keys = Object.keys(node);
      var flatPairs = 0;
      for (var j = 0; j < keys.length; j++) {
        var v = node[keys[j]];
        if (typeof v === 'string' && v.trim()) flatPairs++;
        else if (typeof v === 'number') flatPairs++;
      }
      if (flatPairs >= 1 && flatPairs === keys.length) {
        for (var m = 0; m < keys.length; m++) push(keys[m], node[keys[m]]);
        return;
      }
      for (var n = 0; n < keys.length; n++) walk(node[keys[n]], depth + 1);
    }

    walk(data, 0);
    if (data && !Array.isArray(data) && typeof data === 'object') {
      if (!deckName && typeof data.name === 'string') deckName = data.name.trim();
      if (!deckName && typeof data.title === 'string') deckName = data.title.trim();
    }
    return { cards: dedupe(cards), name: deckName, skipped: [] };
  }

  /** 自动识别 JSON / 纯文本。 */
  function parseImport(raw, nameHint) {
    var text = String(raw || '').trim();
    if (!text) throw new Error('内容为空');
    var name = String(nameHint || '').trim();
    var result;
    if (text[0] === '[' || text[0] === '{') {
      result = parseJSON(text);
      if (!name && result.name) name = result.name;
    } else {
      result = parseText(text);
    }
    if (!result.cards.length) {
      throw new Error('没有解析到词条。文本请用空行分隔，首行为名词，其余为解释。');
    }
    return { name: name || '导入题库', cards: result.cards, skipped: result.skipped || [] };
  }

  /* ---------------- 间隔重复 ---------------- */

  function dayStart(ts) {
    var d = new Date(ts == null ? Date.now() : ts);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  // 从 ts 当天 0:00 起算，加 n 天后的 0:00；用于「每晚 0:00 刷新」的日级排期
  function addDays(ts, n) {
    var d = new Date(ts == null ? Date.now() : ts);
    d.setDate(d.getDate() + n);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  function newSrs(now) {
    return {
      state: 'new',
      due: now || Date.now(),
      interval: 0,
      ease: 2.3,
      reps: 0,
      lapses: 0,
      last: null,
      lastAt: 0
    };
  }

  /**
   * 三级评级调度：
   *  熟悉   → 进入 review，间隔按 ease 增长（1 天起步，上限 365 天）
   *  不熟悉 → learning，20 分钟后再出现，间隔减半，ease 略降
   *  不认识 → learning，10 分钟后再出现，间隔清零，ease 明显下降
   */
  function rate(srs, rating, now) {
    var s = Object.assign({}, newSrs(now), srs || {});
    now = now || Date.now();
    s.reps = (s.reps || 0) + 1;
    s.last = rating;
    s.lastAt = now;

    if (rating === 'known') {
      s.ease = Math.min(2.9, (s.ease || 2.3) + 0.06);
      if (s.state === 'review' && s.interval >= 1) {
        s.interval = Math.min(365, Math.max(s.interval + 1, Math.round(s.interval * s.ease)));
      } else {
        s.interval = 1;
      }
      s.state = 'review';
      s.due = addDays(now, s.interval);
    } else if (rating === 'fuzzy') {
      s.ease = Math.max(1.3, (s.ease || 2.3) - 0.12);
      s.interval = s.state === 'review' ? Math.max(0.5, s.interval * 0.5) : 0.3;
      s.state = 'learning';
      s.due = now + 20 * MIN;
    } else if (rating === 'unknown') {
      s.ease = Math.max(1.3, (s.ease || 2.3) - 0.25);
      s.interval = 0;
      s.state = 'learning';
      s.lapses = (s.lapses || 0) + 1;
      s.due = now + 10 * MIN;
    } else {
      throw new Error('未知评级：' + rating);
    }
    return s;
  }

  function isNewCard(card) { return !card.srs || card.srs.state === 'new'; }
  function isDue(card, now) {
    return !!card.srs && card.srs.state !== 'new' && card.srs.due <= (now || Date.now());
  }
  function dueCount(cards, now) {
    var n = 0;
    for (var i = 0; i < cards.length; i++) if (isDue(cards[i], now)) n++;
    return n;
  }
  function newCount(cards) {
    var n = 0;
    for (var i = 0; i < cards.length; i++) if (isNewCard(cards[i])) n++;
    return n;
  }

  /* ---------------- 时间/杂项 ---------------- */

  function dateKey(d) {
    d = d ? new Date(d) : new Date();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return d.getFullYear() + '-' + m + '-' + day;
  }

  function formatDue(ts, now) {
    now = now || Date.now();
    var diff = ts - now;
    if (diff <= 0) return '现在';
    if (diff < MIN) return '马上';
    if (diff < 60 * MIN) return Math.max(1, Math.round(diff / MIN)) + ' 分钟后';
    if (diff < DAY) return Math.round(diff / 3600000) + ' 小时后';
    if (diff < 2 * DAY) return '明天';
    return Math.round(diff / DAY) + ' 天后';
  }

  function formatDuration(ms) {
    var sec = Math.max(0, Math.round(ms / 1000));
    var m = Math.floor(sec / 60), s = sec % 60;
    if (m <= 0) return s + ' 秒';
    return m + ' 分 ' + String(s).padStart(2, '0') + ' 秒';
  }

  function uid() {
    if (global.crypto && typeof global.crypto.randomUUID === 'function') return global.crypto.randomUUID();
    return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  global.MJZ = global.MJZ || {};
  global.MJZ.core = {
    DAY: DAY,
    MIN: MIN,
    classifyChar: classifyChar,
    tokenize: tokenize,
    hiddenCount: hiddenCount,
    revealCluster: revealCluster,
    nextHiddenIndex: nextHiddenIndex,
    normalizeRange: normalizeRange,
    addHighlight: addHighlight,
    removeHighlight: removeHighlight,
    subtractHighlight: subtractHighlight,
    highlightAt: highlightAt,
    parseText: parseText,
    parseJSON: parseJSON,
    parseImport: parseImport,
    dedupe: dedupe,
    newSrs: newSrs,
    rate: rate,
    isNewCard: isNewCard,
    isDue: isDue,
    dueCount: dueCount,
    newCount: newCount,
    dayStart: dayStart,
    addDays: addDays,
    dateKey: dateKey,
    formatDue: formatDue,
    formatDuration: formatDuration,
    uid: uid
  };
})(typeof window !== 'undefined' ? window : globalThis);
