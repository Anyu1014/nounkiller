// 云端 API 集成检查：需要本地 Pages 运行时或线上站点。
//   cd src && npx wrangler pages dev web --port 8788 --d1=DB --compatibility-date=2026-01-01
//   NK_API=http://127.0.0.1:8788 node --test test/api.test.mjs
// 可选 NK_ADMIN_TOKEN 验证管理员列表 / 回复接口。
import test from 'node:test';
import assert from 'node:assert/strict';

const BASE = (process.env.NK_API || 'http://127.0.0.1:8788').replace(/\/$/, '');
let ADMIN = process.env.NK_ADMIN_TOKEN || '';

async function call(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(token ? { authorization: 'Bearer ' + token } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, data };
}

let health = false;
try {
  const r = await fetch(BASE + '/api/health');
  health = r.ok && (await r.json()).cloud === true;
} catch { /* server not running */ }

if (health && !ADMIN && process.env.NK_ADMIN_EMAIL) {
  const login = await call('/api/auth/login', {
    method: 'POST',
    body: { email: process.env.NK_ADMIN_EMAIL, password: process.env.NK_ADMIN_PASSWORD || '' },
  });
  if (login.status === 200) ADMIN = login.data.token;
}

test('注册、会话、快照与冲突', { skip: health ? false : '需要 Pages D1 运行时' }, async () => {
  const email = `test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@nk.local`;
  const password = 'testpass123';

  const reg = await call('/api/auth/register', { method: 'POST', body: { email, password } });
  assert.equal(reg.status, 201);
  const token = reg.data.token;
  assert.ok(token);

  const me = await call('/api/me', { token });
  assert.equal(me.status, 200);
  assert.equal(me.data.user.email, email);

  const empty = await call('/api/me/data', { token });
  assert.equal(empty.status, 200);
  assert.equal(empty.data.payload, null);

  const payload = {
    version: 3,
    createdAt: Date.now(),
    activeDeckId: 'd1',
    decks: [{ id: 'd1', name: '测试', createdAt: Date.now() }],
    cards: [{ id: 'c1', deckId: 'd1', term: '甲', def: '乙。', fav: true, highlights: [] }],
    stats: { day: '2026-01-01', newStudied: 0, reviews: 0, ratings: { known: 0, fuzzy: 0, unknown: 0 } },
    settings: { dailyGoal: 20, fontScale: 'm' },
  };
  const put = await call('/api/me/data', { method: 'PUT', token, body: { baseVersion: 0, payload } });
  assert.equal(put.status, 200);
  const version = put.data.updatedAt;
  assert.ok(version > 0);

  const got = await call('/api/me/data', { token });
  assert.equal(got.data.payload.cards[0].term, '甲');
  assert.equal(got.data.updatedAt, version);

  const stale = await call('/api/me/data', { method: 'PUT', token, body: { baseVersion: 0, payload } });
  assert.equal(stale.status, 409);

  const msg = await call('/api/messages', { method: 'POST', token, body: { body: '测试留言' } });
  assert.equal(msg.status, 201);
  const thread = await call('/api/messages', { token });
  assert.ok(thread.data.messages.some((m) => m.body === '测试留言'));

  const out = await call('/api/auth/logout', { method: 'POST', token });
  assert.equal(out.status, 200);
  const after = await call('/api/me', { token });
  assert.equal(after.status, 401);
});

test('管理员列表与回复', { skip: health && ADMIN ? false : '需要 NK_ADMIN_TOKEN' }, async () => {
  const list = await call('/api/admin/users', { token: ADMIN });
  assert.equal(list.status, 200);
  assert.ok(Array.isArray(list.data.users));
  assert.ok(list.data.users.length > 0);
  const target = list.data.users.find((u) => !u.isAdmin) || list.data.users[0];
  const reply = await call('/api/admin/messages', {
    method: 'POST',
    token: ADMIN,
    body: { userId: target.id, body: '管理员回复测试' },
  });
  assert.equal(reply.status, 201);
});

test('忘记密码改为联系管理员', { skip: health ? false : '需要 Pages D1 运行时' }, async () => {
  const r = await call('/api/auth/forgot', { method: 'POST', body: { email: 'nobody@nk.local' } });
  assert.equal(r.status, 200);
  assert.equal(r.data.contactAdmin, true);
});

test('注销后 7 天内重新注册恢复数据', { skip: health && ADMIN ? false : '需要 NK_ADMIN_TOKEN' }, async () => {
  const email = `restore-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@nk.local`;
  const password = 'restorepass123';
  const reg = await call('/api/auth/register', { method: 'POST', body: { email, password } });
  assert.equal(reg.status, 201);
  const token = reg.data.token;
  const payload = { version: 3, decks: [{ id: 'd1', name: '恢复测试' }], cards: [{ id: 'c1', deckId: 'd1', term: '甲', def: '乙。' }] };
  const put = await call('/api/me/data', { method: 'PUT', token, body: { baseVersion: 0, payload } });
  assert.equal(put.status, 200);

  const del = await call('/api/admin/users/delete', {
    method: 'POST', token: ADMIN, body: { userId: reg.data.user.id, email },
  });
  assert.equal(del.status, 200);
  assert.ok(del.data.purgeAt > del.data.deletedAt);

  const blocked = await call('/api/auth/login', { method: 'POST', body: { email, password } });
  assert.equal(blocked.status, 403);

  const again = await call('/api/auth/register', { method: 'POST', body: { email, password: 'newpass12345' } });
  assert.equal(again.status, 201);
  assert.equal(again.data.user.restored, true);
  assert.equal(again.data.user.id, reg.data.user.id);

  const restored = await call('/api/me/data', { token: again.data.token });
  assert.equal(restored.status, 200);
  assert.equal(restored.data.payload.cards[0].term, '甲');

  await call('/api/admin/users/delete', {
    method: 'POST', token: ADMIN, body: { userId: reg.data.user.id, email },
  });
});
