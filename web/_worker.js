/*!
 * NounKiller · cloud worker (Cloudflare Pages advanced mode)
 *
 * 同域 /api/* 提供邮箱登录、云端题库/设置/收藏、在线状态与留言板；
 * 其它请求交给静态资源。数据存 D1（绑定点名 DB），表在首次请求时自动创建。
 *
 * 设计边界：
 * - 登录用邮箱 + 密码（PBKDF2-SHA256），会话令牌只存哈希；不依赖第三方账号系统。
 * - 注册会发一封「注册成功」通知邮件（不验证）；忘记密码走邮箱 6 位验证码重置。
 * - 邮件通过 Brevo HTTP API 发送，密钥只放 Cloudflare Secret（BREVO_API_KEY）。
 * - 每个用户一条 JSON 快照（题库、SRS、划线、设置、收藏都在里面），last-write-wins。
 */

const SESSION_DAYS = 60;
const SESSION_MS = SESSION_DAYS * 24 * 60 * 60 * 1000;
// Workers WebCrypto 的 PBKDF2 上限为 100000 次
const PBKDF2_ITERATIONS = 100000;
const MAX_PAYLOAD_BYTES = 900000;
const MAX_MESSAGE = 2000;
const ONLINE_WINDOW_MS = 90 * 1000;
const RESET_TTL_MS = 10 * 60 * 1000;
const RESET_COOLDOWN_MS = 60 * 1000;
const RESET_MAX_ATTEMPTS = 5;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'authorization,content-type',
  'Access-Control-Max-Age': '86400',
};

let schemaReady = null;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...CORS,
    },
  });
}

function fail(status, message) {
  return json({ error: message }, status);
}

function need(condition, status, message) {
  if (!condition) throw new HttpError(status, message);
}

function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  need(email.length >= 5 && email.length <= 254, 400, '邮箱格式不正确');
  need(/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email), 400, '邮箱格式不正确');
  return email;
}

function normalizePassword(value) {
  const password = String(value || '');
  need(password.length >= 8 && password.length <= 128, 400, '密码至少 8 位，最多 128 位');
  return password;
}

function bytesToB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 1) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function b64ToBytes(text) {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i += 1) out[i] = s.charCodeAt(i);
  return out;
}

function randomToken(bytes = 32) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return bytesToB64(buf).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function sha256(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hashPassword(password, saltB64) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: b64ToBytes(saltB64), iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    key,
    256,
  );
  return bytesToB64(new Uint8Array(bits));
}

function sameSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function ensureSchema(env) {
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    const statements = [
      `CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, pass_hash TEXT NOT NULL, salt TEXT NOT NULL,
        is_admin INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL DEFAULT 0, presence TEXT NOT NULL DEFAULT 'away')`,
      `CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL,
        created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)`,
      'CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)',
      `CREATE TABLE IF NOT EXISTS user_data (
        user_id TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at INTEGER NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
        sender TEXT NOT NULL CHECK (sender IN ('user','admin')),
        body TEXT NOT NULL, created_at INTEGER NOT NULL,
        read_by_user INTEGER NOT NULL DEFAULT 0, read_by_admin INTEGER NOT NULL DEFAULT 0)`,
      'CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id, created_at)',
      `CREATE TABLE IF NOT EXISTS email_codes (
        email TEXT NOT NULL, purpose TEXT NOT NULL, code_hash TEXT NOT NULL,
        expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, PRIMARY KEY (email, purpose))`,
    ];
    for (const sql of statements) await env.DB.prepare(sql).run();
  })();
  return schemaReady;
}

function adminEmails(env) {
  return String(env.ADMIN_EMAILS || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

async function createSession(env, userId) {
  const token = randomToken(32);
  const now = Date.now();
  await env.DB.prepare(
    'INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
  ).bind(await sha256(token), userId, now, now + SESSION_MS).run();
  return token;
}

async function requireUser(request, env) {
  const header = request.headers.get('authorization') || '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  need(match, 401, '请先登录');
  const tokenHash = await sha256(match[1].trim());
  const row = await env.DB.prepare(
    `SELECT u.id, u.email, u.is_admin, u.created_at, u.last_seen_at, s.expires_at
     FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
  ).bind(tokenHash).first();
  need(row && row.expires_at > Date.now(), 401, '登录已过期，请重新登录');
  return row;
}

async function readJson(request) {
  const type = request.headers.get('content-type') || '';
  need(type.includes('application/json'), 415, '请求格式不正确');
  const text = await request.text();
  need(text.length <= MAX_PAYLOAD_BYTES + 4096, 413, '提交内容过大');
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, '请求内容不是合法 JSON');
  }
}

function userView(row) {
  return {
    id: row.id,
    email: row.email,
    isAdmin: row.is_admin === 1,
    createdAt: row.created_at,
  };
}

async function unreadFor(env, userId) {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM messages
     WHERE user_id = ? AND sender = 'admin' AND read_by_user = 0`,
  ).bind(userId).first();
  return row ? row.n : 0;
}

const MAIL_FROM_FALLBACK = '2164206282@qq.com';

function mailFrom(env) {
  return String(env.MAIL_FROM || MAIL_FROM_FALLBACK).trim();
}

// Brevo 事务邮件；没有配置密钥时静默跳过（注册通知不能阻断注册）。
async function sendMail(env, { to, subject, text, html }) {
  if (!env.BREVO_API_KEY) return { sent: false, reason: 'mail_not_configured' };
  const endpoint = env.MAIL_API_URL || 'https://api.brevo.com/v3/smtp/email';
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'api-key': env.BREVO_API_KEY,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({
      sender: { name: String(env.MAIL_FROM_NAME || 'NounKiller').trim(), email: mailFrom(env) },
      to: [{ email: to }],
      subject,
      textContent: text,
      htmlContent: html,
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`mail ${res.status}: ${detail.slice(0, 240)}`);
  }
  return { sent: true };
}

function welcomeMail(email) {
  const link = 'https://nounkiller.pages.dev';
  const text = [
    'NounKiller / 名解斩',
    '',
    `你的邮箱 ${email} 已注册成功。`,
    '题库、SRS 进度、划线、收藏和设置会同步到云端，换设备登录即可接着背。',
    `打开：${link}`,
    '',
    '这是一封注册通知，不需要点击验证；如非本人操作，忽略即可。',
  ].join('\n');
  const html = `<!doctype html><html><body style="margin:0;background:#f3f0e8;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;color:#20241f">
  <div style="max-width:520px;margin:0 auto;padding:36px 22px">
    <div style="background:#244f3f;color:#f7f3e8;border-radius:18px;padding:26px 28px">
      <div style="font:600 13px/1.4 ui-monospace,monospace;letter-spacing:.18em;opacity:.75">NOUNKILLER</div>
      <div style="font-family:Georgia,'Songti SC',serif;font-size:30px;margin-top:12px">注册成功</div>
    </div>
    <div style="background:#fbfaf5;border:1px solid #e5dfd0;border-radius:18px;padding:26px 28px;margin-top:14px;font-size:15px;line-height:1.85">
      <p style="margin:0 0 12px">你的邮箱 <b>${email}</b> 已注册 NounKiller。</p>
      <p style="margin:0 0 12px">题库、SRS 进度、划线、收藏和设置会同步到云端，换设备登录即可接着背。</p>
      <p style="margin:0 0 18px"><a href="${link}" style="display:inline-block;background:#2f6753;color:#f8f5ea;text-decoration:none;padding:11px 18px;border-radius:10px">打开 NounKiller</a></p>
      <p style="margin:0;color:#8b8d80;font-size:12.5px">这是一封注册通知，不需要点击验证。如非本人操作，忽略即可。</p>
    </div>
  </div></body></html>`;
  return { to: email, subject: 'NounKiller 注册成功', text, html };
}

function resetMail(email, code) {
  const text = [
    'NounKiller / 名解斩',
    '',
    `你的验证码是 ${code}，10 分钟内有效。`,
    '如果这不是你本人操作，忽略这封邮件即可，密码不会改变。',
  ].join('\n');
  const html = `<!doctype html><html><body style="margin:0;background:#f3f0e8;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;color:#20241f">
  <div style="max-width:520px;margin:0 auto;padding:36px 22px">
    <div style="background:#fbfaf5;border:1px solid #e5dfd0;border-radius:18px;padding:28px">
      <div style="font:600 12px/1.4 ui-monospace,monospace;letter-spacing:.18em;color:#8b8d80">PASSWORD RESET</div>
      <div style="font-family:Georgia,'Songti SC',serif;font-size:26px;margin:10px 0 18px">重置密码</div>
      <p style="margin:0 0 14px;font-size:14.5px;line-height:1.8">你的 NounKiller 验证码：</p>
      <div style="font:700 34px/1 ui-monospace,monospace;letter-spacing:.22em;color:#244f3f">${code}</div>
      <p style="margin:18px 0 0;color:#8b8d80;font-size:12.5px;line-height:1.7">10 分钟内有效。如非本人操作，忽略即可。</p>
    </div>
  </div></body></html>`;
  return { to: email, subject: 'NounKiller 重置密码验证码', text, html };
}

async function handleRegister(request, env, ctx) {
  const body = await readJson(request);
  const email = normalizeEmail(body.email);
  const password = normalizePassword(body.password);
  const exists = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
  need(!exists, 409, '这个邮箱已经注册，直接登录即可');

  const salt = bytesToB64(crypto.getRandomValues(new Uint8Array(16)));
  const hash = await hashPassword(password, salt);
  // 管理员只由 ADMIN_EMAILS 指定；不做“首个用户自动管理员”，避免公开站点被抢注。
  const isAdmin = adminEmails(env).includes(email) ? 1 : 0;
  const id = crypto.randomUUID();
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO users (id, email, pass_hash, salt, is_admin, created_at, last_seen_at, presence)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'online')`,
  ).bind(id, email, hash, salt, isAdmin, now, now).run();
  const token = await createSession(env, id);
  const mail = welcomeMail(email);
  const job = sendMail(env, mail).catch((err) => console.error('welcome mail failed', err));
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(job);
  return json({
    token,
    user: { id, email, isAdmin: isAdmin === 1, createdAt: now },
  }, 201);
}

async function handleLogin(request, env) {
  const body = await readJson(request);
  const email = normalizeEmail(body.email);
  const password = String(body.password || '');
  const row = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
  need(row, 401, '邮箱或密码不正确');
  const hash = await hashPassword(password, row.salt);
  need(sameSecret(hash, row.pass_hash), 401, '邮箱或密码不正确');
  const now = Date.now();
  await env.DB.prepare(
    "UPDATE users SET last_seen_at = ?, presence = 'online' WHERE id = ?",
  ).bind(now, row.id).run();
  const token = await createSession(env, row.id);
  return json({ token, user: userView(row) });
}

async function handleForgot(request, env) {
  const body = await readJson(request);
  const email = normalizeEmail(body.email);
  need(env.BREVO_API_KEY, 503, '邮件服务还未配置，请联系管理员');
  const user = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
  // 不暴露邮箱是否存在。
  if (!user) return json({ ok: true });

  const now = Date.now();
  const prev = await env.DB.prepare(
    "SELECT created_at FROM email_codes WHERE email = ? AND purpose = 'reset'",
  ).bind(email).first();
  if (prev && now - prev.created_at < RESET_COOLDOWN_MS) {
    const wait = Math.ceil((RESET_COOLDOWN_MS - (now - prev.created_at)) / 1000);
    return fail(429, `验证码刚发过，请 ${wait} 秒后再试`);
  }

  const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, '0');
  const codeHash = await sha256(`${email}:reset:${code}`);
  await env.DB.prepare(
    `INSERT INTO email_codes (email, purpose, code_hash, expires_at, attempts, created_at)
     VALUES (?, 'reset', ?, ?, 0, ?)
     ON CONFLICT(email, purpose) DO UPDATE SET
       code_hash = excluded.code_hash, expires_at = excluded.expires_at,
       attempts = 0, created_at = excluded.created_at`,
  ).bind(email, codeHash, now + RESET_TTL_MS, now).run();

  try {
    await sendMail(env, resetMail(email, code));
  } catch (err) {
    console.error('reset mail failed', err);
    await env.DB.prepare("DELETE FROM email_codes WHERE email = ? AND purpose = 'reset'").bind(email).run();
    return fail(502, '验证码邮件发送失败，请稍后重试');
  }
  return json({ ok: true, cooldown: Math.floor(RESET_COOLDOWN_MS / 1000) });
}

async function handleReset(request, env) {
  const body = await readJson(request);
  const email = normalizeEmail(body.email);
  const code = String(body.code || '').trim();
  const password = normalizePassword(body.password);
  need(/^\d{6}$/.test(code), 400, '请输入 6 位数字验证码');

  const user = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
  need(user, 400, '验证码不正确或已过期');
  const row = await env.DB.prepare(
    "SELECT * FROM email_codes WHERE email = ? AND purpose = 'reset'",
  ).bind(email).first();
  need(row, 400, '验证码不正确或已过期');
  if (Date.now() > row.expires_at) {
    await env.DB.prepare("DELETE FROM email_codes WHERE email = ? AND purpose = 'reset'").bind(email).run();
    return fail(400, '验证码已过期，请重新获取');
  }
  need(row.attempts < RESET_MAX_ATTEMPTS, 429, '尝试次数过多，请重新获取验证码');

  const expected = await sha256(`${email}:reset:${code}`);
  if (!sameSecret(expected, row.code_hash)) {
    await env.DB.prepare(
      "UPDATE email_codes SET attempts = attempts + 1 WHERE email = ? AND purpose = 'reset'",
    ).bind(email).run();
    return fail(400, '验证码不正确或已过期');
  }

  const salt = bytesToB64(crypto.getRandomValues(new Uint8Array(16)));
  const hash = await hashPassword(password, salt);
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET pass_hash = ?, salt = ? WHERE id = ?').bind(hash, salt, user.id),
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id),
    env.DB.prepare("DELETE FROM email_codes WHERE email = ? AND purpose = 'reset'").bind(email),
  ]);
  const token = await createSession(env, user.id);
  return json({ token, user: userView(user) });
}

async function handleMe(request, env) {
  const user = await requireUser(request, env);
  return json({ user: userView(user), unread: await unreadFor(env, user.id) });
}

async function handleGetData(request, env) {
  const user = await requireUser(request, env);
  const row = await env.DB.prepare(
    'SELECT payload, updated_at FROM user_data WHERE user_id = ?',
  ).bind(user.id).first();
  if (!row) return json({ payload: null, updatedAt: 0 });
  let payload = null;
  try { payload = JSON.parse(row.payload); } catch { payload = null; }
  return json({ payload, updatedAt: row.updated_at });
}

async function handlePutData(request, env) {
  const user = await requireUser(request, env);
  const body = await readJson(request);
  need(body && typeof body.payload === 'object' && body.payload !== null, 400, '数据格式不正确');
  const serialized = JSON.stringify(body.payload);
  need(new TextEncoder().encode(serialized).length <= MAX_PAYLOAD_BYTES, 413, '题库数据过大，无法同步');
  const base = Number(body.baseVersion) || 0;
  const current = await env.DB.prepare(
    'SELECT updated_at FROM user_data WHERE user_id = ?',
  ).bind(user.id).first();
  if (current && current.updated_at > base) {
    const row = await env.DB.prepare(
      'SELECT payload, updated_at FROM user_data WHERE user_id = ?',
    ).bind(user.id).first();
    return json({
      error: '云端有更新的数据',
      code: 'conflict',
      updatedAt: row.updated_at,
      payload: JSON.parse(row.payload),
    }, 409);
  }
  const now = Math.max(Date.now(), (current ? current.updated_at : 0) + 1);
  await env.DB.prepare(
    `INSERT INTO user_data (user_id, payload, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`,
  ).bind(user.id, serialized, now).run();
  return json({ updatedAt: now });
}

async function handlePresence(request, env) {
  const user = await requireUser(request, env);
  const body = await readJson(request);
  const state = body.state === 'away' ? 'away' : 'online';
  const now = Date.now();
  await env.DB.prepare(
    'UPDATE users SET last_seen_at = ?, presence = ? WHERE id = ?',
  ).bind(now, state, user.id).run();
  return json({ ok: true, at: now, unread: await unreadFor(env, user.id) });
}

async function handleUserMessages(request, env) {
  const user = await requireUser(request, env);
  if (request.method === 'GET') {
    await env.DB.prepare(
      `UPDATE messages SET read_by_user = 1
       WHERE user_id = ? AND sender = 'admin' AND read_by_user = 0`,
    ).bind(user.id).run();
    const rows = await env.DB.prepare(
      `SELECT id, sender, body, created_at FROM messages
       WHERE user_id = ? ORDER BY created_at ASC LIMIT 300`,
    ).bind(user.id).all();
    return json({ messages: rows.results || [] });
  }
  const body = await readJson(request);
  const text = String(body.body || '').trim();
  need(text.length > 0 && text.length <= MAX_MESSAGE, 400, `留言需在 1–${MAX_MESSAGE} 字之间`);
  const now = Date.now();
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO messages (id, user_id, sender, body, created_at, read_by_user, read_by_admin)
     VALUES (?, ?, 'user', ?, ?, 1, 0)`,
  ).bind(id, user.id, text, now).run();
  return json({ id, createdAt: now }, 201);
}

async function requireAdmin(request, env) {
  const user = await requireUser(request, env);
  need(user.is_admin === 1, 403, '需要管理员权限');
  return user;
}

async function handleAdminUsers(request, env) {
  await requireAdmin(request, env);
  const rows = await env.DB.prepare(
    `SELECT u.id, u.email, u.created_at, u.last_seen_at, u.is_admin,
            d.payload, d.updated_at,
            (SELECT COUNT(*) FROM messages m
              WHERE m.user_id = u.id AND m.sender = 'user' AND m.read_by_admin = 0) AS unread
     FROM users u LEFT JOIN user_data d ON d.user_id = u.id
     ORDER BY u.last_seen_at DESC LIMIT 500`,
  ).all();
  const now = Date.now();
  const users = (rows.results || []).map((row) => {
    let decks = 0;
    let cards = 0;
    let favorites = 0;
    if (row.payload) {
      try {
        const data = JSON.parse(row.payload);
        decks = Array.isArray(data.decks) ? data.decks.length : 0;
        cards = Array.isArray(data.cards) ? data.cards.length : 0;
        favorites = Array.isArray(data.cards) ? data.cards.filter((c) => c && c.fav).length : 0;
      } catch { /* ignore broken snapshot */ }
    }
    return {
      id: row.id,
      email: row.email,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
      online: now - row.last_seen_at < ONLINE_WINDOW_MS,
      isAdmin: row.is_admin === 1,
      unread: row.unread || 0,
      decks,
      cards,
      favorites,
      dataUpdatedAt: row.updated_at || 0,
    };
  });
  return json({ users, onlineWindow: ONLINE_WINDOW_MS, now });
}

async function handleAdminThread(request, env) {
  await requireAdmin(request, env);
  const url = new URL(request.url);
  if (request.method === 'GET') {
    const userId = String(url.searchParams.get('userId') || '');
    need(userId, 400, '缺少用户');
    const target = await env.DB.prepare('SELECT id, email FROM users WHERE id = ?').bind(userId).first();
    need(target, 404, '用户不存在');
    await env.DB.prepare(
      'UPDATE messages SET read_by_admin = 1 WHERE user_id = ? AND sender = \'user\' AND read_by_admin = 0',
    ).bind(userId).run();
    const rows = await env.DB.prepare(
      `SELECT id, sender, body, created_at FROM messages
       WHERE user_id = ? ORDER BY created_at ASC LIMIT 300`,
    ).bind(userId).all();
    return json({ user: target, messages: rows.results || [] });
  }
  const body = await readJson(request);
  const userId = String(body.userId || '');
  const text = String(body.body || '').trim();
  need(userId, 400, '缺少用户');
  need(text.length > 0 && text.length <= MAX_MESSAGE, 400, `回复需在 1–${MAX_MESSAGE} 字之间`);
  const target = await env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(userId).first();
  need(target, 404, '用户不存在');
  const now = Date.now();
  const id = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO messages (id, user_id, sender, body, created_at, read_by_user, read_by_admin)
       VALUES (?, ?, 'admin', ?, ?, 0, 1)`,
    ).bind(id, userId, text, now),
    env.DB.prepare(
      `UPDATE messages SET read_by_admin = 1
       WHERE user_id = ? AND sender = 'user' AND read_by_admin = 0`,
    ).bind(userId),
  ]);
  return json({ id, createdAt: now }, 201);
}

async function route(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (!path.startsWith('/api/')) return env.ASSETS.fetch(request);
  if (!env.DB) return fail(503, '云端未配置数据库绑定（D1: DB）');

  await ensureSchema(env);
  if (path === '/api/health') return json({ ok: true, cloud: true, mail: !!env.BREVO_API_KEY });
  if (path === '/api/auth/register' && request.method === 'POST') return handleRegister(request, env, ctx);
  if (path === '/api/auth/forgot' && request.method === 'POST') return handleForgot(request, env);
  if (path === '/api/auth/reset' && request.method === 'POST') return handleReset(request, env);
  if (path === '/api/auth/login' && request.method === 'POST') return handleLogin(request, env);
  if (path === '/api/auth/logout' && request.method === 'POST') {
    const user = await requireUser(request, env);
    const token = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(token)).run();
    await env.DB.prepare("UPDATE users SET presence = 'away' WHERE id = ?").bind(user.id).run();
    return json({ ok: true });
  }
  if (path === '/api/me' && request.method === 'GET') return handleMe(request, env);
  if (path === '/api/me/data' && request.method === 'GET') return handleGetData(request, env);
  if (path === '/api/me/data' && request.method === 'PUT') return handlePutData(request, env);
  if (path === '/api/presence' && request.method === 'POST') return handlePresence(request, env);
  if (path === '/api/messages' && (request.method === 'GET' || request.method === 'POST')) {
    return handleUserMessages(request, env);
  }
  if (path === '/api/admin/users' && request.method === 'GET') return handleAdminUsers(request, env);
  if (path === '/api/admin/messages' && (request.method === 'GET' || request.method === 'POST')) {
    return handleAdminThread(request, env);
  }
  return fail(404, '接口不存在');
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await route(request, env, ctx);
    } catch (error) {
      if (error instanceof HttpError) return fail(error.status, error.message);
      console.error('[nounkiller] api error', error && error.stack ? error.stack : error);
      return fail(500, '服务器开小差了，请稍后重试');
    }
  },
};
