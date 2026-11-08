// 群组未读数：直接用 Worker 里的 SQL 建库验证，避免另写一份 SQL 跑偏。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const worker = readFileSync(new URL('../web/_worker.js', import.meta.url), 'utf8');

function between(start, end) {
  const from = worker.indexOf(start);
  assert.ok(from >= 0, 'Worker 里找不到：' + start);
  const to = worker.indexOf(end, from);
  assert.ok(to > from, 'Worker 里找不到：' + end);
  return worker.slice(from, to);
}

const UNREAD_SQL = between('SELECT g.*, m.role', '`');
const MARK_READ_SQL = /'(UPDATE chat_members SET last_read_at = \?[^']*)'/.exec(worker)[1];

function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE chat_groups (id TEXT PRIMARY KEY, group_no TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL, owner_id TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE chat_members (group_id TEXT NOT NULL, user_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member', joined_at INTEGER NOT NULL,
      last_read_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (group_id, user_id));
    CREATE TABLE chat_messages (id TEXT PRIMARY KEY, group_id TEXT NOT NULL, user_id TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT 'text',
      deck_name TEXT NOT NULL DEFAULT '', deck_count INTEGER NOT NULL DEFAULT 0,
      deck_payload TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL);
  `);
  db.exec(`
    INSERT INTO chat_groups VALUES ('g1', '12345678', '测试群', 'u1', 100);
    INSERT INTO chat_members (group_id, user_id, role, joined_at) VALUES ('g1', 'u1', 'owner', 100);
    INSERT INTO chat_members (group_id, user_id, role, joined_at) VALUES ('g1', 'u2', 'member', 150);
    INSERT INTO chat_messages (id, group_id, user_id, body, created_at) VALUES ('m1', 'g1', 'u2', '一', 1000);
    INSERT INTO chat_messages (id, group_id, user_id, body, created_at) VALUES ('m2', 'g1', 'u2', '二', 2000);
    INSERT INTO chat_messages (id, group_id, user_id, body, created_at) VALUES ('m3', 'g1', 'u1', '三', 3000);
  `);
  return db;
}

const unreadOf = (db, userId) => {
  const row = db.prepare(UNREAD_SQL).get(userId, userId);
  return Number(row.unread || 0);
};

// 与 Worker 一致：last_read_at 只在比它新的时候往前推
const markRead = (db, userId, at, newest) => db.prepare(MARK_READ_SQL).run(at, 'g1', userId, newest);

test('群组未读数：别人的新消息计数，自己的不算，读过后清零', () => {
  assert.match(worker, /last_read_at INTEGER NOT NULL DEFAULT 0/);
  const db = makeDb();
  assert.equal(unreadOf(db, 'u1'), 2, 'u1 应看到 u2 的两条');
  assert.equal(unreadOf(db, 'u2'), 1, 'u2 只应看到 u1 的一条');

  markRead(db, 'u1', 3000, 3000);
  assert.equal(unreadOf(db, 'u1'), 0, '读到最新后清零');

  unreadOf(db, 'u1');
  db.exec("INSERT INTO chat_messages (id, group_id, user_id, body, created_at) VALUES ('m4', 'g1', 'u2', '四', 4000)");
  assert.equal(unreadOf(db, 'u1'), 1, '新消息再冒出来');
});
