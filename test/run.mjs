import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const corePath = fileURLToPath(new URL('../web/js/core.js', import.meta.url));
// 用当前 realm 执行，避免跨 realm 的 deepStrictEqual 原型差异
vm.runInThisContext(readFileSync(corePath, 'utf8'), { filename: 'core.js' });
const C = globalThis.MJZ.core;

const DAY = 86400000;
const MIN = 60000;

test('tokenize：保留标点与空白，其余全部视为可遮挡字符', () => {
  const text = 'CPU 是“中央处理器”，\n负责运算。';
  const tokens = C.tokenize(text);
  assert.equal(tokens.map((t) => t.ch).join(''), text);
  assert.equal(tokens[3].type, 'space');
  assert.equal(tokens[4].ch, '是');
  assert.equal(tokens[4].type, 'char');
  assert.equal(tokens[5].ch, '“');
  assert.equal(tokens[5].type, 'punct');
  assert.equal(tokens.at(-1).ch, '。');
  assert.equal(tokens.at(-1).type, 'punct');
  // 隐形字符数 = char 类型数量；标点、空白不计入
  assert.equal(C.hiddenCount(text), tokens.filter((t) => t.type === 'char').length);
  assert.equal(C.hiddenCount('，。！\n '), 0);
});

test('revealCluster：中文一次点亮点击字及左右相邻字（最多 3 个）', () => {
  const text = '名解斩是背诵工具。';
  assert.deepEqual([...C.revealCluster(text, 0)].sort((a, b) => a - b), [0, 1]);
  assert.deepEqual([...C.revealCluster(text, 2)].sort((a, b) => a - b), [1, 2, 3]);
  // 标点不可点
  assert.equal(C.revealCluster('你好。', 2).size, 0);
  assert.equal(C.revealCluster(text, -1).size, 0);
  assert.equal(C.revealCluster(text, 999).size, 0);
});

test('revealCluster：点亮范围可调，标点隔断不跨标点', () => {
  const text = '甲乙、丙丁。';
  assert.deepEqual([...C.revealCluster(text, 3, 0)].sort((a, b) => a - b), [3]);
  assert.deepEqual([...C.revealCluster(text, 3, 1)].sort((a, b) => a - b), [3, 4]);
  // 左边紧邻顿号：不再继续点亮顿号前的「乙」
  assert.deepEqual([...C.revealCluster(text, 3, 2)].sort((a, b) => a - b), [3, 4]);
  // 右边紧邻句号：不再继续点亮句号后的内容
  assert.deepEqual([...C.revealCluster(text, 1, 2)].sort((a, b) => a - b), [0, 1]);
});

test('revealCluster：英文与数字按连续词整体揭开', () => {
  const text = 'CPU 和 GPU 都是处理器。';
  const cpu = [...C.revealCluster(text, 1)].sort((a, b) => a - b);
  assert.deepEqual(cpu, [0, 1, 2]);
  const gpu = [...C.revealCluster(text, 6)].sort((a, b) => a - b);
  assert.deepEqual(gpu, [6, 7, 8]);
  // 数字串
  const num = [...C.revealCluster('第 2024 年', 3)].sort((a, b) => a - b);
  assert.deepEqual(num, [2, 3, 4, 5]);
});

test('nextHiddenIndex：先向右再向左，跳过标点；全无时返回 -1', () => {
  const text = '甲、乙。';
  assert.equal(C.nextHiddenIndex(text, 0), 2); // 跳过顿号
  assert.equal(C.nextHiddenIndex(text, 2), 0);
  assert.equal(C.nextHiddenIndex('。。。', 0), -1);
});

test('高亮区间：覆盖写、部分切除、查询与清除', () => {
  let list = [];
  list = C.addHighlight(list, 0, 3, 'yellow');
  assert.deepEqual(list, [{ start: 0, end: 3, color: 'yellow', style: 'marker' }]);
  list = C.addHighlight(list, 1, 5, 'green');
  assert.deepEqual(list, [
    { start: 0, end: 1, color: 'yellow', style: 'marker' },
    { start: 1, end: 5, color: 'green', style: 'marker' }
  ]);
  assert.equal(C.highlightAt(list, 0).color, 'yellow');
  assert.equal(C.highlightAt(list, 1).color, 'green');
  assert.equal(C.highlightAt(list, 4).color, 'green');
  assert.equal(C.highlightAt(list, 5), null);

  list = C.removeHighlight(list, 2, 4);
  assert.deepEqual(list, [
    { start: 0, end: 1, color: 'yellow', style: 'marker' },
    { start: 1, end: 2, color: 'green', style: 'marker' },
    { start: 4, end: 5, color: 'green', style: 'marker' }
  ]);
  assert.deepEqual(C.normalizeRange(4, 2), { start: 2, end: 5 });
  assert.equal(C.addHighlight([], 5, 5, 'pink').length, 0);

  const wavy = C.addHighlight([], 0, 4, 'pink', 'wavy');
  assert.deepEqual(wavy, [{ start: 0, end: 4, color: 'pink', style: 'wavy' }]);
  assert.deepEqual(C.removeHighlight(wavy, 1, 3), [
    { start: 0, end: 1, color: 'pink', style: 'wavy' },
    { start: 3, end: 4, color: 'pink', style: 'wavy' }
  ]);
});

test('parseText：空行分条、首行名词、多行解释合并', () => {
  const raw = '机会成本\n为了得到某种东西而放弃的最大价值。\n它不一定等于会计成本。\n\n沉没成本\n已经发生且无法收回的支出。';
  const { cards } = C.parseText(raw);
  assert.equal(cards.length, 2);
  assert.equal(cards[0].term, '机会成本');
  assert.match(cards[0].def, /最大价值。\n它不一定/);
  assert.equal(cards[1].term, '沉没成本');
});

test('parseText：截图 OCR 的孤立整句并回上一段', () => {
  const raw = '1. 编码:把信息转化为符号的过程。\n\n'
    + '编码者需要在共享的意义空间中选择符号系统。\n'
    + '2. 解码:接收者把符号还原为意义的过程。';
  const { cards } = C.parseText(raw);
  assert.equal(cards.length, 2);
  assert.equal(cards[0].term, '编码');
  assert.match(cards[0].def, /符号的过程。\n编码者需要在共享/);
});

test('parseText：单块「名词：解释」逐行写法', () => {
  const raw = '机会成本：放弃的最大价值。\n沉没成本：已经发生、无法收回的支出。\n边际效用：每增加一单位带来的效用增量。';
  const { cards } = C.parseText(raw);
  assert.equal(cards.length, 3);
  assert.equal(cards[2].term, '边际效用');
});

test('parseText：清洗编号、井号、BOM 与装饰分隔线', () => {
  const raw = '\uFEFF# 1. 沉没成本\n已经发生、无法收回的支出。\n\n---\n\n2、机会成本\n放弃的最大价值。';
  const { cards } = C.parseText(raw);
  assert.deepEqual(cards.map((c) => c.term), ['沉没成本', '机会成本']);
});

test('parseText：名词/解释连写，无需空行也能分条', () => {
  const raw = '机会成本\n为了得到某种东西而放弃的最大价值。\n'
    + '沉没成本\n已经发生、无法收回的支出。\n'
    + '边际效用\n每增加一单位消费带来的效用增量。';
  const { cards } = C.parseText(raw);
  assert.deepEqual(cards.map((c) => c.term), ['机会成本', '沉没成本', '边际效用']);
  assert.equal(cards[0].def, '为了得到某种东西而放弃的最大价值。');
  assert.equal(cards[2].def, '每增加一单位消费带来的效用增量。');
});

test('parseText：序号是分条标记，名词前有序号即可无空行', () => {
  const raw = '机会成本\n放弃的最大价值\n'
    + '1. 沉没成本\n已经发生、无法收回的支出\n'
    + '2、边际效用\n每增加一单位带来的效用增量';
  const { cards } = C.parseText(raw);
  assert.deepEqual(cards.map((c) => c.term), ['机会成本', '沉没成本', '边际效用']);
  assert.equal(cards[1].def, '已经发生、无法收回的支出');
});

test('parseText：序号 + 「名词：解释」写在同一行', () => {
  const raw = '1. 机会成本：放弃的最大价值。\n2. 沉没成本：已经发生、无法收回的支出。';
  const { cards } = C.parseText(raw);
  assert.deepEqual(cards.map((c) => c.term), ['机会成本', '沉没成本']);
  assert.equal(cards[1].def, '已经发生、无法收回的支出。');
});

test('parseText：「名词：解释」后还能跟补充说明行', () => {
  const raw = '机会成本：放弃的最大价值。\n它不一定等于会计成本。\n沉没成本：已经发生、无法收回的支出。';
  const { cards } = C.parseText(raw);
  assert.equal(cards.length, 2);
  assert.match(cards[0].def, /放弃的最大价值。\n它不一定等于会计成本。/);
});

test('parseText：解释里的短句分行不会被当成新名词', () => {
  const raw = '边际效用递减\n第一杯水解渴\n第二杯舒服\n第三杯就只是负担。\n'
    + '沉没成本\n已经发生、无法收回的支出。';
  const { cards } = C.parseText(raw);
  assert.equal(cards.length, 2);
  assert.equal(cards[0].term, '边际效用递减');
  assert.match(cards[0].def, /第一杯水解渴\n第二杯舒服\n第三杯就只是负担。/);
  assert.equal(cards[1].term, '沉没成本');
});

test('parseText：编辑视图的「1.名词:解释」块可原样回读', () => {
  const raw = '1.机会成本:第一段解释。\n           第二段继续。\n\n2.沉没成本:已经发生、无法收回的支出。';
  const { cards } = C.parseText(raw);
  assert.deepEqual(cards.map((c) => c.term), ['机会成本', '沉没成本']);
  assert.match(cards[0].def, /第一段解释。\n第二段继续。/);
  assert.equal(cards[1].def, '已经发生、无法收回的支出。');
});

test('parseJSON：数组、包装对象、扁平映射、JSONL 与题库名', () => {
  const arr = C.parseJSON(JSON.stringify([
    { term: 'A', definition: 'a 的定义' },
    { name: 'B', content: 'b 的定义' }
  ]));
  assert.equal(arr.cards.length, 2);

  const wrapped = C.parseJSON(JSON.stringify({ name: '传播学', cards: [{ term: '编码', def: '把信息转成符号。' }] }));
  assert.equal(wrapped.name, '传播学');
  assert.equal(wrapped.cards[0].term, '编码');

  const flat = C.parseJSON(JSON.stringify({ 编码: '把信息转成符号。', 解码: '把符号还原成信息。' }));
  assert.equal(flat.cards.length, 2);

  const jsonl = C.parseJSON('{"term":"A","def":"a"}\n{"term":"B","def":"b"}');
  assert.equal(jsonl.cards.length, 2);
});

test('parseImport：自动识别，空内容与无词条要报错', () => {
  const txt = C.parseImport('A\na 的定义', '题库一');
  assert.equal(txt.name, '题库一');
  assert.equal(txt.cards.length, 1);

  const json = C.parseImport('{"name":"题库二","cards":[{"term":"A","def":"a"}]}');
  assert.equal(json.name, '题库二');

  assert.throws(() => C.parseImport('   '), /内容为空/);
  assert.throws(() => C.parseImport('只有一行没有解释'), /没有解析到词条/);
});

test('SRS：熟悉按 ease 增长、不熟悉 20 分钟、不认识 10 分钟', () => {
  const t0 = 1_700_000_000_000;
  let s = C.newSrs(t0);
  assert.equal(s.state, 'new');
  assert.equal(C.isNewCard({ srs: s }), true);

  s = C.rate(s, 'known', t0);
  assert.equal(s.state, 'review');
  assert.equal(s.interval, 1);
  assert.equal(s.due, C.addDays(t0, 1)); // 次日 0:00 刷新
  assert.equal(s.reps, 1);
  assert.ok(Math.abs(s.ease - 2.36) < 1e-9);

  const t1 = t0 + DAY;
  s = C.rate(s, 'known', t1);
  assert.equal(s.interval, 2); // max(1+1, round(1*2.36)) = 2
  assert.equal(s.due, C.addDays(t1, 2));

  const t2 = t1 + 2 * DAY;
  s = C.rate(s, 'known', t2);
  assert.equal(s.interval, 5); // max(3, round(2*2.42)) = 5

  let f = C.rate(C.newSrs(t0), 'fuzzy', t0);
  assert.equal(f.state, 'learning');
  assert.equal(f.due, t0 + 20 * MIN);
  assert.equal(f.interval, 0.3);

  let u = C.rate(C.newSrs(t0), 'unknown', t0);
  assert.equal(u.state, 'learning');
  assert.equal(u.due, t0 + 10 * MIN);
  assert.equal(u.interval, 0);
  assert.equal(u.lapses, 1);

  // ease 下限 1.3，上限 2.9
  let lo = C.newSrs(t0);
  for (let i = 0; i < 10; i++) lo = C.rate(lo, 'unknown', t0);
  assert.equal(lo.ease, 1.3);
  let hi = C.newSrs(t0);
  for (let i = 0; i < 20; i++) hi = C.rate(hi, 'known', t0);
  assert.equal(hi.ease, 2.9);

  // 熟悉后间隔封顶 365 天
  let big = Object.assign(C.newSrs(t0), { state: 'review', interval: 300, ease: 2.9 });
  big = C.rate(big, 'known', t0);
  assert.equal(big.interval, 365);
  assert.equal(big.due, C.addDays(t0, 365));

  // 日级排期统一落在本地 0:00
  const noon = new Date(2026, 0, 2, 13, 30, 0).getTime();
  const next = C.rate(C.newSrs(noon), 'known', noon);
  assert.equal(next.due, new Date(2026, 0, 3, 0, 0, 0).getTime());
  assert.equal(C.dayStart(noon), new Date(2026, 0, 2, 0, 0, 0).getTime());
});

test('到期判断与计数', () => {
  const t0 = 1_700_000_000_000;
  const fresh = { id: '1', srs: C.newSrs(t0) };
  const learning = { id: '2', srs: C.rate(C.newSrs(t0), 'fuzzy', t0) };
  const cards = [fresh, learning];
  assert.equal(C.isNewCard(fresh), true);
  assert.equal(C.isDue(fresh, t0), false);
  assert.equal(C.isDue(learning, t0), false);
  assert.equal(C.isDue(learning, t0 + 21 * MIN), true);
  assert.equal(C.newCount(cards), 1);
  assert.equal(C.dueCount(cards, t0 + 21 * MIN), 1);
});

test('时间格式化', () => {
  const t0 = new Date(2026, 0, 2, 9, 0, 0).getTime();
  assert.equal(C.dateKey(t0), '2026-01-02');
  assert.equal(C.formatDue(t0 - 1000, t0), '现在');
  assert.equal(C.formatDue(t0 + 30 * 1000, t0), '马上');
  assert.equal(C.formatDue(t0 + 5 * MIN, t0), '5 分钟后');
  assert.equal(C.formatDue(t0 + 3 * 60 * MIN, t0), '3 小时后');
  assert.equal(C.formatDue(t0 + DAY, t0), '明天');
  assert.equal(C.formatDue(t0 + 3 * DAY, t0), '3 天后');
  assert.equal(C.formatDuration(0), '0 秒');
  assert.equal(C.formatDuration(65 * 1000), '1 分 05 秒');
});

test('dedupe 按名词+解释去重', () => {
  const cards = [
    { term: 'A', def: 'a' },
    { term: 'A', def: 'a' },
    { term: 'A', def: 'b' }
  ];
  assert.equal(C.dedupe(cards).length, 2);
});
