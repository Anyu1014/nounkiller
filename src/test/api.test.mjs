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

test('忘记密码直接发送验证码', { skip: health ? false : '需要 Pages D1 运行时' }, async () => {
  const email = `reset-${Date.now()}@nk.local`;
  const password = 'resetpass123';
  const reg = await call('/api/auth/register', { method: 'POST', body: { email, password } });
  assert.equal(reg.status, 201);
  const r = await call('/api/auth/forgot', { method: 'POST', body: { email } });
  // 本地测试没有 QQ_SMTP_PASS 时发送会 503；有凭据时应 200。两种都不泄露邮箱是否存在。
  assert.ok([200, 503].includes(r.status), `unexpected ${r.status}: ${JSON.stringify(r.data)}`);
  if (r.status === 200) assert.equal(r.data.ok, true);
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

test('群组：创建、群号申请、邀请、群设置、分享题库、踢人、退群', { skip: health ? false : '需要 Pages D1 运行时' }, async () => {
  const stamp = Date.now() + '-' + Math.random().toString(36).slice(2, 6);
  const ownerEmail = `owner-${stamp}@nk.local`;
  const memberEmail = `member-${stamp}@nk.local`;
  const guestEmail = `guest-${stamp}@nk.local`;
  const register = (email) => call('/api/auth/register', { method: 'POST', body: { email, password: 'grouppass123' } });
  const owner = (await register(ownerEmail)).data;
  const member = (await register(memberEmail)).data;
  const guest = (await register(guestEmail)).data;
  assert.ok(owner.token && member.token && guest.token);

  const created = await call('/api/group/create', { method: 'POST', token: owner.token, body: { name: '测试群组' } });
  assert.equal(created.status, 200);
  const group = created.data.group;
  assert.match(group.groupNo, /^\d{8}$/);
  assert.equal(group.role, 'owner');

  const list0 = await call('/api/group/list', { token: owner.token });
  assert.equal(list0.status, 200);
  assert.equal(list0.data.groups.length, 1);
  assert.equal(list0.data.groups[0].id, group.id);

  // 群号申请 → 群主审批
  const join = await call('/api/group/join', { method: 'POST', token: member.token, body: { groupNo: group.groupNo } });
  assert.equal(join.status, 200);
  assert.equal(join.data.pending, true);
  const repeat = await call('/api/group/join', { method: 'POST', token: member.token, body: { groupNo: group.groupNo } });
  assert.equal(repeat.status, 200);
  assert.equal(repeat.data.pending, true);

  const inboxOwner = await call('/api/group/inbox', { token: owner.token });
  assert.equal(inboxOwner.data.joinRequests.length, 1);
  const request = inboxOwner.data.joinRequests[0];
  assert.equal(request.groupId, group.id);
  const approved = await call('/api/group/request/respond', {
    method: 'POST', token: owner.token, body: { requestId: request.id, accept: true },
  });
  assert.equal(approved.status, 200);

  const memberList = await call('/api/group/list', { token: member.token });
  assert.ok(memberList.data.groups.some((g) => g.id === group.id && g.role === 'member'));

  // 邮箱邀请 → 被邀请人在消息里接受
  const invited = await call('/api/group/invite', {
    method: 'POST', token: owner.token, body: { groupId: group.id, email: guestEmail },
  });
  assert.equal(invited.status, 200);
  const inboxGuest = await call('/api/group/inbox', { token: guest.token });
  assert.equal(inboxGuest.data.invites.length, 1);
  assert.equal(inboxGuest.data.invites[0].groupId, group.id);
  const accepted = await call('/api/group/invite/respond', {
    method: 'POST', token: guest.token, body: { inviteId: inboxGuest.data.invites[0].id, accept: true },
  });
  assert.equal(accepted.status, 200);

  // 群设置：成员列表、改名权限
  const settings = await call('/api/group/settings?groupId=' + encodeURIComponent(group.id), { token: owner.token });
  assert.equal(settings.status, 200);
  assert.equal(settings.data.isOwner, true);
  assert.equal(settings.data.members.length, 3);
  assert.equal(settings.data.members.filter((m) => m.owner).length, 1);
  const guestId = settings.data.members.find((m) => m.email === guestEmail).userId;
  assert.ok(guestId);

  const renamed = await call('/api/group/rename', {
    method: 'POST', token: owner.token, body: { groupId: group.id, name: '改名后的群' },
  });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.data.name, '改名后的群');
  const denied = await call('/api/group/rename', {
    method: 'POST', token: member.token, body: { groupId: group.id, name: '我不配' },
  });
  assert.equal(denied.status, 403);

  // 客户端直接分享题库（不依赖云端快照），空词条被丢弃
  const sent = await call('/api/group/messages', {
    method: 'POST', token: member.token,
    body: {
      groupId: group.id, body: '分享给你',
      deck: { name: '群组分享题库', cards: [{ term: '分享名词', def: '分享解释。' }, { term: '', def: '空词条' }] },
    },
  });
  assert.equal(sent.status, 200);
  const thread = await call('/api/group/messages?groupId=' + encodeURIComponent(group.id), { token: guest.token });
  assert.equal(thread.status, 200);
  const msg = thread.data.messages.find((m) => m.kind === 'deck');
  assert.ok(msg);
  assert.equal(msg.deckName, '群组分享题库');
  assert.equal(msg.deckCount, 1);
  assert.equal(msg.name, memberEmail.split('@')[0]);

  const preview = await call('/api/group/deck?messageId=' + encodeURIComponent(msg.id), { token: guest.token });
  assert.equal(preview.status, 200);
  assert.equal(preview.data.deckName, '群组分享题库');
  assert.deepEqual(preview.data.cards, [{ term: '分享名词', def: '分享解释。' }]);

  const imported = await call('/api/group/import', { method: 'POST', token: guest.token, body: { messageId: msg.id } });
  assert.equal(imported.status, 200);
  assert.deepEqual(imported.data.cards, [{ term: '分享名词', def: '分享解释。' }]);

  const files = await call('/api/group/settings?groupId=' + encodeURIComponent(group.id), { token: owner.token });
  assert.equal(files.data.files.length, 1);
  assert.equal(files.data.files[0].deckName, '群组分享题库');

  // 成员忽略群文件：只影响自己
  const ignored = await call('/api/group/file/ignore', {
    method: 'POST', token: guest.token, body: { messageId: msg.id },
  });
  assert.equal(ignored.status, 200);
  const guestFiles = await call('/api/group/settings?groupId=' + encodeURIComponent(group.id), { token: guest.token });
  assert.equal(guestFiles.data.files.length, 0);
  const ownerFiles = await call('/api/group/settings?groupId=' + encodeURIComponent(group.id), { token: owner.token });
  assert.equal(ownerFiles.data.files.length, 1);

  // 非群主不能删除群文件；群主删除后群文件与聊天里的分享一起消失
  const deleteDenied = await call('/api/group/file/delete', {
    method: 'POST', token: guest.token, body: { messageId: msg.id },
  });
  assert.equal(deleteDenied.status, 403);
  const removed = await call('/api/group/file/delete', {
    method: 'POST', token: owner.token, body: { messageId: msg.id },
  });
  assert.equal(removed.status, 200);
  const noFiles = await call('/api/group/settings?groupId=' + encodeURIComponent(group.id), { token: owner.token });
  assert.equal(noFiles.data.files.length, 0);
  const threadAfter = await call('/api/group/messages?groupId=' + encodeURIComponent(group.id), { token: member.token });
  assert.equal(threadAfter.data.messages.filter((m) => m.kind === 'deck').length, 0);

  // 群主踢人
  const kicked = await call('/api/group/kick', {
    method: 'POST', token: owner.token, body: { groupId: group.id, userId: guestId },
  });
  assert.equal(kicked.status, 200);
  const guestAfter = await call('/api/group/messages?groupId=' + encodeURIComponent(group.id), { token: guest.token });
  assert.equal(guestAfter.status, 403);

  // 成员退群；群主最后退出时解散
  const left = await call('/api/group/leave', { method: 'POST', token: member.token, body: { groupId: group.id } });
  assert.equal(left.status, 200);
  assert.equal(left.data.left, true);
  const dissolved = await call('/api/group/leave', { method: 'POST', token: owner.token, body: { groupId: group.id } });
  assert.equal(dissolved.status, 200);
  assert.equal(dissolved.data.deleted, true);
  const listEnd = await call('/api/group/list', { token: owner.token });
  assert.equal(listEnd.data.groups.length, 0);
});
