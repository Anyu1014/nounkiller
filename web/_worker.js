/*!
 * NounKiller · cloud worker (Cloudflare Pages advanced mode)
 *
 * 同域 /api/* 提供邮箱登录、云端题库/设置/收藏、在线状态与留言板；
 * 其它请求交给静态资源。数据存 D1（绑定点名 DB），表在首次请求时自动创建。
 *
 * 设计边界：
 * - 登录用邮箱 + 密码（PBKDF2-SHA256），会话令牌只存哈希；不依赖第三方账号系统。
 * - 注册会发一封「注册成功」通知邮件（不验证）；忘记密码提示联系管理员。
 * - 邮件通过 QQ 邮箱 SMTP（smtp.qq.com:465）发送，授权码只放 Cloudflare Secret。
 * - 管理员注销账号后数据保留 7 天；同一邮箱重新注册即可恢复。
 * - 每个用户一条 JSON 快照（题库、SRS、划线、设置、收藏都在里面），last-write-wins。
 */

import { connect } from 'cloudflare:sockets';

const SESSION_DAYS = 60;
const SESSION_MS = SESSION_DAYS * 24 * 60 * 60 * 1000;
// Workers WebCrypto 的 PBKDF2 上限为 100000 次
const PBKDF2_ITERATIONS = 100000;
const MAX_PAYLOAD_BYTES = 900000;
const MAX_MESSAGE = 2000;
const ONLINE_WINDOW_MS = 90 * 1000;
// 管理员注销账号后，云端数据保留 7 天；期间同邮箱可重新注册恢复。
const RESTORE_DAYS = 7;
const RESTORE_MS = RESTORE_DAYS * 24 * 60 * 60 * 1000;
const RESET_TTL_MS = 10 * 60 * 1000;

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
        last_seen_at INTEGER NOT NULL DEFAULT 0, presence TEXT NOT NULL DEFAULT 'away',
        deleted_at INTEGER NOT NULL DEFAULT 0)`,
      `CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL,
        created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)`,
      'CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)',
      `CREATE TABLE IF NOT EXISTS user_data (
        user_id TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at INTEGER NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS reset_requests (
        email TEXT PRIMARY KEY, requested_at INTEGER NOT NULL,
        sent_at INTEGER NOT NULL DEFAULT 0, expires_at INTEGER NOT NULL DEFAULT 0,
        code_hash TEXT NOT NULL DEFAULT '', attempts INTEGER NOT NULL DEFAULT 0)`,
      `CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
        sender TEXT NOT NULL CHECK (sender IN ('user','admin')),
        body TEXT NOT NULL, created_at INTEGER NOT NULL,
        read_by_user INTEGER NOT NULL DEFAULT 0, read_by_admin INTEGER NOT NULL DEFAULT 0)`,
      'CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id, created_at)',
      `CREATE TABLE IF NOT EXISTS chat_groups (
        id TEXT PRIMARY KEY, group_no TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
        owner_id TEXT NOT NULL, created_at INTEGER NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS chat_members (
        group_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member',
        joined_at INTEGER NOT NULL, last_read_at INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (group_id, user_id))`,
      `CREATE TABLE IF NOT EXISTS chat_invites (
        id TEXT PRIMARY KEY, group_id TEXT NOT NULL, inviter_id TEXT NOT NULL, invitee_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL, UNIQUE(group_id, invitee_id))`,
      `CREATE TABLE IF NOT EXISTS chat_join_requests (
        id TEXT PRIMARY KEY, group_id TEXT NOT NULL, user_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL, UNIQUE(group_id, user_id))`,
      `CREATE TABLE IF NOT EXISTS chat_messages (
        id TEXT PRIMARY KEY, group_id TEXT NOT NULL, user_id TEXT NOT NULL,
        body TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT 'text',
        deck_name TEXT NOT NULL DEFAULT '', deck_count INTEGER NOT NULL DEFAULT 0,
        deck_payload TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS chat_file_hides (
        user_id TEXT NOT NULL, message_id TEXT NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, message_id))`,
      'CREATE INDEX IF NOT EXISTS idx_chat_messages_time ON chat_messages(group_id, created_at)',
      'CREATE INDEX IF NOT EXISTS idx_chat_members_user ON chat_members(user_id)',
      'CREATE INDEX IF NOT EXISTS idx_chat_invites_user ON chat_invites(invitee_id, status)',
    ];
    for (const sql of statements) await env.DB.prepare(sql).run();
    // 老库补列；已存在时会报 duplicate column，忽略即可。
    try {
      await env.DB.prepare('ALTER TABLE users ADD COLUMN deleted_at INTEGER NOT NULL DEFAULT 0').run();
    } catch {}
    try {
      await env.DB.prepare('ALTER TABLE chat_members ADD COLUMN last_read_at INTEGER NOT NULL DEFAULT 0').run();
    } catch {}
  })();
  return schemaReady;
}

async function purgeUserData(env, userId) {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId),
    env.DB.prepare('DELETE FROM user_data WHERE user_id = ?').bind(userId),
    env.DB.prepare('DELETE FROM messages WHERE user_id = ?').bind(userId),
    env.DB.prepare('DELETE FROM users WHERE id = ?').bind(userId),
  ]);
}

async function purgeExpiredUsers(env) {
  const cutoff = Date.now() - RESTORE_MS;
  const rows = await env.DB.prepare(
    'SELECT id FROM users WHERE deleted_at > 0 AND deleted_at <= ? AND is_admin = 0 LIMIT 50',
  ).bind(cutoff).all();
  for (const row of rows.results || []) await purgeUserData(env, row.id);
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
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND u.deleted_at = 0`,
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
  return String(env.QQ_SMTP_USER || env.MAIL_FROM || MAIL_FROM_FALLBACK).trim();
}

function b64utf8(value) {
  return bytesToB64(new TextEncoder().encode(String(value)));
}

function mailHeaderValue(value) {
  const text = String(value || '').replace(/[\r\n]+/g, ' ').trim();
  return /^[\x20-\x7e]*$/.test(text) ? text : `=?UTF-8?B?${b64utf8(text)}?=`;
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timeout`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function mailBody(env, { from, to, subject, text, html }) {
  const boundary = `nk_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  const block = (value) => b64utf8(value).replace(/.{1,76}/g, (line) => `${line}\r\n`);
  const headers = [
    `From: ${mailHeaderValue(env.MAIL_FROM_NAME || 'NounKiller')} <${from}>`,
    `To: <${to}>`,
    `Subject: ${mailHeaderValue(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${Date.now()}.${Math.random().toString(36).slice(2)}@nounkiller.pages.dev>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];
  const parts = [
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    block(text),
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    block(html),
    `--${boundary}--`,
  ];
  return `${headers.join('\r\n')}\r\n\r\n${parts.join('\r\n')}`.replace(/(^|\r\n)\./g, '$1..');
}

// QQ 邮箱 SMTP over TLS；没有配置授权码时静默跳过，注册流程不受影响。
async function smtpSend(env, mail) {
  const host = String(env.QQ_SMTP_HOST || 'smtp.qq.com').trim();
  const port = Number(env.QQ_SMTP_PORT || 465);
  const user = String(env.QQ_SMTP_USER || '').trim();
  const pass = String(env.QQ_SMTP_PASS || '');
  const from = mailFrom(env);
  if (!user || !pass) throw new Error('mail_not_configured');

  const socket = connect({ hostname: host, port }, { secureTransport: 'on' });
  const decoder = new TextDecoder();
  let writer;
  let reader;
  let buffered = '';

  const readReply = async () => {
    const lines = [];
    for (;;) {
      const idx = buffered.indexOf('\r\n');
      if (idx >= 0) {
        const line = buffered.slice(0, idx);
        buffered = buffered.slice(idx + 2);
        lines.push(line);
        if (/^\d{3} /.test(line)) return { code: Number(line.slice(0, 3)), text: lines.join('\n') };
        continue;
      }
      const chunk = await withTimeout(reader.read(), 10000, 'smtp read');
      if (chunk.done) throw new Error('smtp closed');
      buffered += decoder.decode(chunk.value, { stream: true });
    }
  };

  const command = async (line) => {
    await withTimeout(writer.write(new TextEncoder().encode(`${line}\r\n`)), 10000, 'smtp write');
    return readReply();
  };

  const expect = (reply, code, label) => {
    if (reply.code !== code) throw new Error(`smtp ${label} ${reply.code}: ${reply.text.slice(0, 180)}`);
  };

  try {
    await withTimeout(socket.opened, 10000, 'smtp connect');
    writer = socket.writable.getWriter();
    reader = socket.readable.getReader();
    expect(await readReply(), 220, 'greeting');
    expect(await command('EHLO nounkiller.pages.dev'), 250, 'ehlo');
    expect(await command('AUTH LOGIN'), 334, 'auth');
    expect(await command(btoa(user)), 334, 'user');
    expect(await command(btoa(pass)), 235, 'password');
    expect(await command(`MAIL FROM:<${from}>`), 250, 'from');
    expect(await command(`RCPT TO:<${mail.to}>`), 250, 'to');
    expect(await command('DATA'), 354, 'data');
    const body = mailBody(env, { from, ...mail });
    await withTimeout(writer.write(new TextEncoder().encode(`${body}\r\n.\r\n`)), 10000, 'smtp body');
    expect(await readReply(), 250, 'send');
    await command('QUIT').catch(() => {});
    return { sent: true };
  } finally {
    try { if (writer) writer.releaseLock(); } catch {}
    try { if (reader) reader.releaseLock(); } catch {}
    try { socket.close(); } catch {}
  }
}

async function sendMail(env, mail) {
  if (!env.QQ_SMTP_USER || !env.QQ_SMTP_PASS) return { sent: false, reason: 'mail_not_configured' };
  return smtpSend(env, mail);
}

function welcomeMail(email, restored = false) {
  const link = 'https://nounkiller.pages.dev';
  const title = restored ? '数据已恢复' : '注册成功';
  const text = [
    'NounKiller / 名解斩',
    '',
    restored ? `你的邮箱 ${email} 重新注册成功，云端数据已恢复。` : `你的邮箱 ${email} 已注册成功。`,
    '题库、SRS 进度、划线、收藏和设置会同步到云端，换设备登录即可接着背。',
    `打开：${link}`,
    '',
    '这是一封注册通知，不需要点击验证；如非本人操作，忽略即可。',
  ].join('\n');
  const html = `<!doctype html><html><body style="margin:0;background:#f3f0e8;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;color:#20241f">
  <div style="max-width:520px;margin:0 auto;padding:36px 22px">
    <div style="background:#244f3f;color:#f7f3e8;border-radius:18px;padding:26px 28px">
      <div style="font:600 13px/1.4 ui-monospace,monospace;letter-spacing:.18em;opacity:.75">NOUNKILLER</div>
      <div style="font-family:Georgia,'Songti SC',serif;font-size:30px;margin-top:12px">${title}</div>
    </div>
    <div style="background:#fbfaf5;border:1px solid #e5dfd0;border-radius:18px;padding:26px 28px;margin-top:14px;font-size:15px;line-height:1.85">
      <p style="margin:0 0 12px">你的邮箱 <b>${email}</b> ${restored ? '重新注册成功，云端数据已恢复。' : '已注册 NounKiller。'}</p>
      <p style="margin:0 0 12px">题库、SRS 进度、划线、收藏和设置会同步到云端，换设备登录即可接着背。</p>
      <p style="margin:0 0 18px"><a href="${link}" style="display:inline-block;background:#2f6753;color:#f8f5ea;text-decoration:none;padding:11px 18px;border-radius:10px">打开 NounKiller</a></p>
      <p style="margin:0;color:#8b8d80;font-size:12.5px">这是一封注册通知，不需要点击验证。如非本人操作，忽略即可。</p>
    </div>
  </div></body></html>`;
  return { to: email, subject: `NounKiller ${title}`, text, html };
}

function resetMail(env, email, code) {
  const from = mailFrom(env);
  const text = [
    'NounKiller / 名解斩',
    '',
    `你的密码重置验证码是：${code}`,
    '验证码 10 分钟内有效，只能使用一次。',
    '如非本人申请，请忽略本邮件，你的密码不会被修改。',
  ].join('\n');
  const html = `<!doctype html><html><body style="margin:0;background:#f3f0e8;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;color:#20241f">
  <div style="max-width:520px;margin:0 auto;padding:36px 22px">
    <div style="background:#244f3f;color:#f7f3e8;border-radius:18px;padding:26px 28px">
      <div style="font:600 13px/1.4 ui-monospace,monospace;letter-spacing:.18em;opacity:.75">NOUNKILLER</div>
      <div style="font-family:Georgia,'Songti SC',serif;font-size:30px;margin-top:12px">重置密码</div>
    </div>
    <div style="background:#fbfaf5;border:1px solid #e5dfd0;border-radius:18px;padding:26px 28px;margin-top:14px;font-size:15px;line-height:1.85">
      <p style="margin:0 0 12px">你的密码重置验证码：</p>
      <p style="margin:0 0 16px;font:600 30px/1.2 ui-monospace,monospace;letter-spacing:.16em">${code}</p>
      <p style="margin:0 0 12px">验证码 10 分钟内有效，只能使用一次。</p>
      <p style="margin:0;color:#8b8d80;font-size:12.5px">如非本人申请，请忽略本邮件，你的密码不会被修改。</p>
    </div>
  </div></body></html>`;
  return { from, to: email, subject: 'NounKiller 重置密码验证码', text, html };
}

async function handleRegister(request, env, ctx) {
  const body = await readJson(request);
  const email = normalizeEmail(body.email);
  const password = normalizePassword(body.password);
  await purgeExpiredUsers(env);
  let existing = await env.DB.prepare(
    'SELECT id, created_at, deleted_at FROM users WHERE email = ?',
  ).bind(email).first();
  const now = Date.now();
  if (existing && existing.deleted_at && now - existing.deleted_at >= RESTORE_MS) {
    await purgeUserData(env, existing.id);
    existing = null;
  }
  need(!existing || existing.deleted_at > 0, 409, '这个邮箱已经注册，直接登录即可');

  const salt = bytesToB64(crypto.getRandomValues(new Uint8Array(16)));
  const hash = await hashPassword(password, salt);
  // 管理员只由 ADMIN_EMAILS 指定；不做“首个用户自动管理员”，避免公开站点被抢注。
  const isAdmin = adminEmails(env).includes(email) ? 1 : 0;
  const restored = Boolean(existing);
  const id = existing ? existing.id : crypto.randomUUID();
  const createdAt = existing ? existing.created_at : now;
  if (restored) {
    // 注销后 7 天内同邮箱重新注册：复用原 id，user_data 原样保留。
    await env.DB.prepare(
      `UPDATE users SET pass_hash = ?, salt = ?, is_admin = ?, last_seen_at = ?,
        presence = 'online', deleted_at = 0 WHERE id = ?`,
    ).bind(hash, salt, isAdmin, now, id).run();
  } else {
    await env.DB.prepare(
      `INSERT INTO users (id, email, pass_hash, salt, is_admin, created_at, last_seen_at, presence, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'online', 0)`,
    ).bind(id, email, hash, salt, isAdmin, now, now).run();
  }
  const token = await createSession(env, id);
  const mail = welcomeMail(email, restored);
  const job = sendMail(env, mail).catch((err) => console.error('welcome mail failed', err));
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(job);
  return json({
    token,
    user: { id, email, isAdmin: isAdmin === 1, createdAt, restored },
  }, 201);
}

async function handleLogin(request, env) {
  const body = await readJson(request);
  const email = normalizeEmail(body.email);
  const password = String(body.password || '');
  const row = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
  need(row, 401, '邮箱或密码不正确');
  need(!row.deleted_at, 403, '账号已注销；7 天内可用同一邮箱重新注册，数据会恢复');
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
  need(email.includes('@'), 400, '请输入有效邮箱');
  const user = await env.DB.prepare(
    'SELECT id FROM users WHERE email = ? AND deleted_at = 0',
  ).bind(email).first();
  const now = Date.now();
  if (user) {
    const last = await env.DB.prepare(
      'SELECT sent_at FROM reset_requests WHERE email = ?',
    ).bind(email).first();
    // 同一邮箱 60 秒内只发一次，避免被当成邮件轰炸工具。
    if (!last || last.sent_at < now - 60000) {
      const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, '0');
      const codeHash = await sha256(`${email}:reset:${code}`);
      await env.DB.prepare(
        `INSERT INTO reset_requests (email, requested_at, sent_at, expires_at, code_hash, attempts)
         VALUES (?, ?, ?, ?, ?, 0)
         ON CONFLICT(email) DO UPDATE SET requested_at = excluded.requested_at,
           sent_at = excluded.sent_at, expires_at = excluded.expires_at,
           code_hash = excluded.code_hash, attempts = 0`,
      ).bind(email, now, now, now + RESET_TTL_MS, codeHash).run();
      try {
        await sendMail(env, resetMail(env, email, code));
      } catch (err) {
        console.error('reset mail failed', err);
        return fail(503, '验证码邮件发送失败，请稍后重试');
      }
    }
  }
  return json({ ok: true, message: '如果该邮箱已注册，验证码已发送，10 分钟内有效。' });
}

async function handleReset(request, env) {
  const body = await readJson(request);
  const email = normalizeEmail(body.email);
  const code = String(body.code || '').trim();
  const password = normalizePassword(body.password);
  need(/^\d{6}$/.test(code), 400, '请输入 6 位验证码');
  const row = await env.DB.prepare('SELECT * FROM reset_requests WHERE email = ?').bind(email).first();
  need(row && row.sent_at > 0, 400, '验证码尚未发送，请联系管理员');
  need(row.expires_at > Date.now(), 400, '验证码已过期，请联系管理员重新发送');
  need(row.attempts < 5, 429, '尝试次数过多，请联系管理员重新发送');
  const hash = await sha256(`${email}:reset:${code}`);
  if (hash !== row.code_hash) {
    await env.DB.prepare('UPDATE reset_requests SET attempts = attempts + 1 WHERE email = ?').bind(email).run();
    return fail(400, '验证码不正确');
  }
  const user = await env.DB.prepare(
    'SELECT id FROM users WHERE email = ? AND deleted_at = 0',
  ).bind(email).first();
  need(user, 404, '用户不存在或已注销');
  const salt = bytesToB64(crypto.getRandomValues(new Uint8Array(16)));
  const passHash = await hashPassword(password, salt);
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET pass_hash = ?, salt = ? WHERE id = ?').bind(passHash, salt, user.id),
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id),
    env.DB.prepare('DELETE FROM reset_requests WHERE email = ?').bind(email),
  ]);
  const token = await createSession(env, user.id);
  const full = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(user.id).first();
  return json({ token, user: userView(full) });
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


const GROUP_LIMIT = 120;
const GROUP_DECK_MAX_BYTES = 300000;
const GROUP_DECK_MAX_CARDS = 800;
const GROUP_NAME_MAX = 30;

function groupName(value) {
  return String(value || '').trim().slice(0, GROUP_NAME_MAX);
}

function groupView(row) {
  return {
    id: row.id,
    name: row.name,
    groupNo: row.group_no,
    ownerId: row.owner_id,
    role: row.role || 'member',
    memberCount: Number(row.member_count || 0),
    unread: Number(row.unread || 0),
    createdAt: row.created_at,
  };
}

function chatMessageView(row, meId) {
  return {
    id: row.id,
    groupId: row.group_id,
    userId: row.user_id,
    name: row.email ? String(row.email).split('@')[0] : '同学',
    mine: row.user_id === meId,
    body: row.body || '',
    kind: row.kind || 'text',
    deckName: row.deck_name || '',
    deckCount: Number(row.deck_count || 0),
    createdAt: row.created_at,
  };
}

async function uniqueGroupNo(env) {
  for (let i = 0; i < 20; i += 1) {
    const no = String(10000000 + Math.floor(Math.random() * 90000000));
    const hit = await env.DB.prepare('SELECT 1 FROM chat_groups WHERE group_no = ?').bind(no).first();
    if (!hit) return no;
  }
  need(false, 500, '群号生成失败，请重试');
}

async function requireGroupMember(env, groupId, userId) {
  const row = await env.DB.prepare(
    `SELECT m.role, g.id, g.name, g.group_no, g.owner_id, g.created_at
     FROM chat_members m JOIN chat_groups g ON g.id = m.group_id
     WHERE m.group_id = ? AND m.user_id = ?`,
  ).bind(groupId, userId).first();
  need(row, 403, '你不在这个群组里');
  return row;
}

async function handleGroups(request, env) {
  const user = await requireUser(request, env);
  const rows = await env.DB.prepare(
    `SELECT g.*, m.role,
       (SELECT COUNT(*) FROM chat_members cm WHERE cm.group_id = g.id) AS member_count,
       (SELECT COUNT(*) FROM chat_messages um
         WHERE um.group_id = g.id AND um.user_id != ? AND um.created_at > m.last_read_at) AS unread
     FROM chat_groups g JOIN chat_members m ON m.group_id = g.id
     WHERE m.user_id = ? ORDER BY g.created_at DESC`,
  ).bind(user.id, user.id).all();
  return json({ groups: (rows.results || []).map(groupView) });
}

async function handleGroupCreate(request, env) {
  const user = await requireUser(request, env);
  const data = await readJson(request);
  const name = groupName(data.name);
  need(name, 400, '给群组起个名字');
  const groupNo = await uniqueGroupNo(env);
  const id = randomToken(12);
  const now = Date.now();
  await env.DB.prepare(
    'INSERT INTO chat_groups (id, group_no, name, owner_id, created_at) VALUES (?, ?, ?, ?, ?)',
  ).bind(id, groupNo, name, user.id, now).run();
  await env.DB.prepare(
    "INSERT INTO chat_members (group_id, user_id, role, joined_at, last_read_at) VALUES (?, ?, 'owner', ?, ?)",
  ).bind(id, user.id, now, now).run();
  return json({ group: { id, name, groupNo, ownerId: user.id, role: 'owner', memberCount: 1, createdAt: now } });
}

async function handleGroupInbox(request, env) {
  const user = await requireUser(request, env);
  const invites = await env.DB.prepare(
    `SELECT i.id, i.created_at, g.id AS group_id, g.name, g.group_no, u.email AS inviter_email
     FROM chat_invites i JOIN chat_groups g ON g.id = i.group_id
     JOIN users u ON u.id = i.inviter_id
     WHERE i.invitee_id = ? AND i.status = 'pending' ORDER BY i.created_at DESC`,
  ).bind(user.id).all();
  const joins = await env.DB.prepare(
    `SELECT r.id, r.created_at, g.id AS group_id, g.name, g.group_no, u.email AS user_email
     FROM chat_join_requests r JOIN chat_groups g ON g.id = r.group_id
     JOIN users u ON u.id = r.user_id
     WHERE g.owner_id = ? AND r.status = 'pending' ORDER BY r.created_at DESC`,
  ).bind(user.id).all();
  return json({
    invites: (invites.results || []).map((r) => ({
      id: r.id, groupId: r.group_id, name: r.name, groupNo: r.group_no,
      inviter: r.inviter_email ? String(r.inviter_email).split('@')[0] : '成员', createdAt: r.created_at,
    })),
    joinRequests: (joins.results || []).map((r) => ({
      id: r.id, groupId: r.group_id, name: r.name, groupNo: r.group_no,
      user: r.user_email ? String(r.user_email).split('@')[0] : '同学', createdAt: r.created_at,
    })),
  });
}

async function handleGroupJoin(request, env) {
  const user = await requireUser(request, env);
  const data = await readJson(request);
  const no = String(data.groupNo || '').trim();
  need(/^\d{8}$/.test(no), 400, '群号应为 8 位数字');
  const group = await env.DB.prepare('SELECT * FROM chat_groups WHERE group_no = ?').bind(no).first();
  need(group, 404, '没有找到这个群组');
  const member = await env.DB.prepare(
    'SELECT 1 FROM chat_members WHERE group_id = ? AND user_id = ?',
  ).bind(group.id, user.id).first();
  if (member) return json({ ok: true, already: true, groupId: group.id });
  const pending = await env.DB.prepare(
    "SELECT 1 FROM chat_join_requests WHERE group_id = ? AND user_id = ? AND status = 'pending'",
  ).bind(group.id, user.id).first();
  if (!pending) {
    await env.DB.prepare(
      `INSERT INTO chat_join_requests (id, group_id, user_id, status, created_at)
       VALUES (?, ?, ?, 'pending', ?)
       ON CONFLICT(group_id, user_id) DO UPDATE SET status='pending', created_at=excluded.created_at`,
    ).bind(randomToken(12), group.id, user.id, Date.now()).run();
  }
  return json({ ok: true, pending: true, groupId: group.id });
}

async function handleGroupInvite(request, env) {
  const user = await requireUser(request, env);
  const data = await readJson(request);
  const groupId = String(data.groupId || '');
  const email = normalizeEmail(data.email);
  need(groupId && email, 400, '填写要邀请的邮箱');
  await requireGroupMember(env, groupId, user.id);
  const target = await env.DB.prepare('SELECT id, deleted_at FROM users WHERE email = ?').bind(email).first();
  need(target && !target.deleted_at, 404, '这个邮箱还没有注册 NounKiller');
  const member = await env.DB.prepare(
    'SELECT 1 FROM chat_members WHERE group_id = ? AND user_id = ?',
  ).bind(groupId, target.id).first();
  need(!member, 409, '对方已经在群里了');
  await env.DB.prepare(
    `INSERT INTO chat_invites (id, group_id, inviter_id, invitee_id, status, created_at)
     VALUES (?, ?, ?, ?, 'pending', ?)
     ON CONFLICT(group_id, invitee_id) DO UPDATE SET status='pending', created_at=excluded.created_at, inviter_id=excluded.inviter_id`,
  ).bind(randomToken(12), groupId, user.id, target.id, Date.now()).run();
  return json({ ok: true });
}

async function handleGroupInviteRespond(request, env) {
  const user = await requireUser(request, env);
  const data = await readJson(request);
  const inviteId = String(data.inviteId || '');
  need(inviteId, 400, '缺少邀请');
  const accept = data.accept === true;
  const row = await env.DB.prepare(
    "SELECT * FROM chat_invites WHERE id = ? AND invitee_id = ? AND status = 'pending'",
  ).bind(inviteId, user.id).first();
  need(row, 404, '邀请已失效');
  if (accept) {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO chat_members (group_id, user_id, role, joined_at, last_read_at) VALUES (?, ?, 'member', ?, ?)",
    ).bind(row.group_id, user.id, Date.now(), Date.now()).run();
  }
  await env.DB.prepare("UPDATE chat_invites SET status = ? WHERE id = ?")
    .bind(accept ? 'accepted' : 'rejected', inviteId).run();
  return json({ ok: true, accepted: accept, groupId: row.group_id });
}

async function handleGroupJoinRespond(request, env) {
  const user = await requireUser(request, env);
  const data = await readJson(request);
  const requestId = String(data.requestId || '');
  need(requestId, 400, '缺少申请');
  const accept = data.accept === true;
  const row = await env.DB.prepare(
    `SELECT r.*, g.owner_id FROM chat_join_requests r JOIN chat_groups g ON g.id = r.group_id
     WHERE r.id = ? AND r.status = 'pending'`,
  ).bind(requestId).first();
  need(row, 404, '申请已失效');
  need(row.owner_id === user.id, 403, '只有群主可以审批');
  if (accept) {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO chat_members (group_id, user_id, role, joined_at, last_read_at) VALUES (?, ?, 'member', ?, ?)",
    ).bind(row.group_id, row.user_id, Date.now(), Date.now()).run();
  }
  await env.DB.prepare("UPDATE chat_join_requests SET status = ? WHERE id = ?")
    .bind(accept ? 'accepted' : 'rejected', requestId).run();
  return json({ ok: true, accepted: accept });
}

async function handleGroupSettings(request, env) {
  const user = await requireUser(request, env);
  const groupId = new URL(request.url).searchParams.get('groupId') || '';
  need(groupId, 400, '缺少群组');
  const row = await requireGroupMember(env, groupId, user.id);
  const isOwner = row.owner_id === user.id;
  const members = await env.DB.prepare(
    `SELECT m.user_id, m.role, m.joined_at, u.email FROM chat_members m JOIN users u ON u.id = m.user_id
     WHERE m.group_id = ? ORDER BY m.joined_at ASC`,
  ).bind(groupId).all();
  const files = await env.DB.prepare(
    `SELECT m.id, m.deck_name, m.deck_count, m.created_at, m.user_id, u.email
     FROM chat_messages m LEFT JOIN users u ON u.id = m.user_id
     WHERE m.group_id = ? AND m.kind = 'deck'
       AND m.id NOT IN (SELECT message_id FROM chat_file_hides WHERE user_id = ?)
     ORDER BY m.created_at DESC LIMIT 80`,
  ).bind(groupId, user.id).all();
  const memberCount = members.results ? members.results.length : 1;
  let joinRequests = [];
  if (isOwner) {
    const pending = await env.DB.prepare(
      `SELECT r.id, r.created_at, u.email FROM chat_join_requests r JOIN users u ON u.id = r.user_id
       WHERE r.group_id = ? AND r.status = 'pending' ORDER BY r.created_at ASC`,
    ).bind(groupId).all();
    joinRequests = (pending.results || []).map((r) => ({
      id: r.id, email: r.email, name: String(r.email || '').split('@')[0], createdAt: r.created_at,
    }));
  }
  return json({
    group: {
      id: row.id, name: row.name, groupNo: row.group_no, ownerId: row.owner_id,
      role: row.role, memberCount, createdAt: row.created_at,
    },
    isOwner,
    members: (members.results || []).map((m) => ({
      userId: m.user_id, email: m.email, name: String(m.email || '').split('@')[0],
      role: m.role, joinedAt: m.joined_at, me: m.user_id === user.id, owner: m.user_id === row.owner_id,
    })),
    joinRequests,
    files: (files.results || []).map((f) => ({
      id: f.id, deckName: f.deck_name, deckCount: f.deck_count, createdAt: f.created_at,
      name: f.email ? String(f.email).split('@')[0] : '同学',
      mine: f.user_id === user.id,
    })),
  });
}

async function handleGroupRename(request, env) {
  const user = await requireUser(request, env);
  const data = await readJson(request);
  const groupId = String(data.groupId || '');
  need(groupId, 400, '缺少群组');
  const row = await requireGroupMember(env, groupId, user.id);
  need(row.owner_id === user.id, 403, '只有群主可以修改群名');
  const name = groupName(data.name);
  need(name, 400, '群名不能为空');
  await env.DB.prepare('UPDATE chat_groups SET name = ? WHERE id = ?').bind(name, groupId).run();
  return json({ ok: true, name });
}

async function handleGroupLeave(request, env) {
  const user = await requireUser(request, env);
  const data = await readJson(request);
  const groupId = String(data.groupId || '');
  need(groupId, 400, '缺少群组');
  const row = await requireGroupMember(env, groupId, user.id);
  if (row.owner_id === user.id) {
    const next = await env.DB.prepare(
      "SELECT user_id FROM chat_members WHERE group_id = ? AND user_id <> ? ORDER BY joined_at ASC LIMIT 1",
    ).bind(groupId, user.id).first();
    if (!next) {
      await env.DB.batch([
        env.DB.prepare('DELETE FROM chat_messages WHERE group_id = ?').bind(groupId),
        env.DB.prepare('DELETE FROM chat_invites WHERE group_id = ?').bind(groupId),
        env.DB.prepare('DELETE FROM chat_join_requests WHERE group_id = ?').bind(groupId),
        env.DB.prepare('DELETE FROM chat_members WHERE group_id = ?').bind(groupId),
        env.DB.prepare('DELETE FROM chat_groups WHERE id = ?').bind(groupId),
      ]);
      return json({ ok: true, deleted: true });
    }
    await env.DB.prepare("UPDATE chat_groups SET owner_id = ? WHERE id = ?").bind(next.user_id, groupId).run();
    await env.DB.prepare("UPDATE chat_members SET role = 'owner' WHERE group_id = ? AND user_id = ?")
      .bind(groupId, next.user_id).run();
  }
  await env.DB.prepare('DELETE FROM chat_members WHERE group_id = ? AND user_id = ?')
    .bind(groupId, user.id).run();
  return json({ ok: true, left: true });
}

async function handleGroupKick(request, env) {
  const user = await requireUser(request, env);
  const data = await readJson(request);
  const groupId = String(data.groupId || '');
  need(groupId, 400, '缺少群组');
  const row = await requireGroupMember(env, groupId, user.id);
  need(row.owner_id === user.id, 403, '只有群主可以移除成员');
  const target = String(data.userId || '');
  need(target && target !== user.id, 400, '不能移除自己');
  await env.DB.prepare('DELETE FROM chat_members WHERE group_id = ? AND user_id = ?')
    .bind(groupId, target).run();
  return json({ ok: true });
}

async function groupDeckPayload(raw) {
  const deck = raw && typeof raw === 'object' ? raw : null;
  need(deck, 400, '题库内容为空');
  const name = String(deck.name || '').trim().slice(0, 80) || '群组题库';
  const cards = [];
  const items = Array.isArray(deck.cards) ? deck.cards : [];
  for (const item of items) {
    if (!item) continue;
    const term = String(item.term || '').trim();
    const def = String(item.def || '').trim();
    if (!term || !def) continue;
    cards.push({ term, def });
    if (cards.length >= GROUP_DECK_MAX_CARDS) break;
  }
  need(cards.length, 400, '题库里没有可分享的词条');
  const payload = JSON.stringify({ name, cards });
  need(new TextEncoder().encode(payload).length <= GROUP_DECK_MAX_BYTES, 413, '题库太大，无法分享');
  return { name, cards, payload };
}

async function handleGroupMessages(request, env) {
  const user = await requireUser(request, env);
  if (request.method === 'GET') {
    const groupId = new URL(request.url).searchParams.get('groupId') || '';
    need(groupId, 400, '缺少群组');
    await requireGroupMember(env, groupId, user.id);
    const rows = await env.DB.prepare(
      `SELECT m.*, u.email FROM chat_messages m LEFT JOIN users u ON u.id = m.user_id
       WHERE m.group_id = ? ORDER BY m.created_at DESC LIMIT ?`,
    ).bind(groupId, GROUP_LIMIT).all();
    // 只在真的有新消息时写一次，避免每次轮询都写库。
    const newest = (rows.results || []).reduce((max, r) => Math.max(max, Number(r.created_at || 0)), 0);
    if (newest > 0) {
      await env.DB.prepare(
        'UPDATE chat_members SET last_read_at = ? WHERE group_id = ? AND user_id = ? AND last_read_at < ?',
      ).bind(Date.now(), groupId, user.id, newest).run();
    }
    return json({ messages: (rows.results || []).map((r) => chatMessageView(r, user.id)).reverse() });
  }
  const data = await readJson(request);
  const groupId = String(data.groupId || '');
  need(groupId, 400, '缺少群组');
  await requireGroupMember(env, groupId, user.id);
  const text = String(data.body || '').trim().slice(0, MAX_MESSAGE);
  let kind = 'text';
  let deckName = '';
  let deckCount = 0;
  let deckPayload = '';
  if (data.deck) {
    const share = await groupDeckPayload(data.deck);
    kind = 'deck'; deckName = share.name; deckCount = share.cards.length; deckPayload = share.payload;
  }
  need(text || kind === 'deck', 400, '写点什么，或选一个题库');
  await env.DB.prepare(
    `INSERT INTO chat_messages (id, group_id, user_id, body, kind, deck_name, deck_count, deck_payload, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(randomToken(12), groupId, user.id, text, kind, deckName, deckCount, deckPayload, Date.now()).run();
  return json({ ok: true });
}

async function loadGroupDeck(env, messageId, userId) {
  need(messageId, 400, '缺少消息');
  const row = await env.DB.prepare(
    "SELECT group_id, deck_name, deck_payload FROM chat_messages WHERE id = ? AND kind = 'deck'",
  ).bind(messageId).first();
  need(row, 404, '这条群组消息里没有题库');
  await requireGroupMember(env, row.group_id, userId);
  let deck = null;
  try { deck = JSON.parse(row.deck_payload); } catch { deck = null; }
  need(deck && Array.isArray(deck.cards) && deck.cards.length, 404, '题库内容已损坏');
  return { deckName: row.deck_name || deck.name || '群组题库', cards: deck.cards };
}

async function handleGroupImport(request, env) {
  const user = await requireUser(request, env);
  const body = await readJson(request);
  return json(await loadGroupDeck(env, String(body.messageId || ''), user.id));
}

async function groupDeckMessageId(request, env) {
  const user = await requireUser(request, env);
  const data = await readJson(request);
  const messageId = String(data.messageId || '');
  need(messageId, 400, '缺少题库');
  const row = await env.DB.prepare(
    "SELECT group_id FROM chat_messages WHERE id = ? AND kind = 'deck'",
  ).bind(messageId).first();
  need(row, 404, '这条群组消息里没有题库');
  const member = await requireGroupMember(env, row.group_id, user.id);
  return { user, messageId, groupId: row.group_id, member };
}

async function handleGroupFileDelete(request, env) {
  const { user, messageId, member } = await groupDeckMessageId(request, env);
  need(member.owner_id === user.id, 403, '只有群主可以删除群文件');
  await env.DB.prepare('DELETE FROM chat_messages WHERE id = ?').bind(messageId).run();
  await env.DB.prepare('DELETE FROM chat_file_hides WHERE message_id = ?').bind(messageId).run();
  return json({ ok: true });
}

async function handleGroupFileIgnore(request, env) {
  const { user, messageId } = await groupDeckMessageId(request, env);
  await env.DB.prepare(
    'INSERT OR IGNORE INTO chat_file_hides (user_id, message_id, created_at) VALUES (?, ?, ?)',
  ).bind(user.id, messageId, Date.now()).run();
  return json({ ok: true });
}

async function handleGroupPreview(request, env) {
  const user = await requireUser(request, env);
  const messageId = new URL(request.url).searchParams.get('messageId') || '';
  return json(await loadGroupDeck(env, messageId, user.id));
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
  await purgeExpiredUsers(env);
  const rows = await env.DB.prepare(
    `SELECT u.id, u.email, u.created_at, u.last_seen_at, u.is_admin, u.deleted_at,
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
      online: !row.deleted_at && now - row.last_seen_at < ONLINE_WINDOW_MS,
      isAdmin: row.is_admin === 1,
      deletedAt: row.deleted_at || 0,
      purgeAt: row.deleted_at ? row.deleted_at + RESTORE_MS : 0,
      unread: row.unread || 0,
      decks,
      cards,
      favorites,
      dataUpdatedAt: row.updated_at || 0,
    };
  });
  return json({ users, onlineWindow: ONLINE_WINDOW_MS, now });
}

async function handleAdminDelete(request, env) {
  const admin = await requireAdmin(request, env);
  const body = await readJson(request);
  const userId = String(body.userId || '');
  const email = normalizeEmail(body.email);
  need(userId, 400, '缺少用户');
  const target = await env.DB.prepare(
    'SELECT id, email, is_admin, deleted_at FROM users WHERE id = ?',
  ).bind(userId).first();
  need(target, 404, '用户不存在');
  need(target.id !== admin.id, 400, '不能注销当前管理员账号');
  need(target.is_admin === 0, 400, '管理员账号不能注销');
  need(email === target.email, 400, '邮箱确认不匹配');
  need(!target.deleted_at, 409, '该账号已经注销');
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET deleted_at = ?, presence = 'away' WHERE id = ?").bind(now, userId),
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId),
  ]);
  return json({ ok: true, deletedAt: now, purgeAt: now + RESTORE_MS });
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
  if (path === '/api/health') return json({ ok: true, cloud: true, mail: !!(env.QQ_SMTP_USER && env.QQ_SMTP_PASS) });
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
  if (path === '/api/group/list' && request.method === 'GET') return handleGroups(request, env);
  if (path === '/api/group/create' && request.method === 'POST') return handleGroupCreate(request, env);
  if (path === '/api/group/inbox' && request.method === 'GET') return handleGroupInbox(request, env);
  if (path === '/api/group/join' && request.method === 'POST') return handleGroupJoin(request, env);
  if (path === '/api/group/invite' && request.method === 'POST') return handleGroupInvite(request, env);
  if (path === '/api/group/invite/respond' && request.method === 'POST') return handleGroupInviteRespond(request, env);
  if (path === '/api/group/request/respond' && request.method === 'POST') return handleGroupJoinRespond(request, env);
  if (path === '/api/group/settings' && request.method === 'GET') return handleGroupSettings(request, env);
  if (path === '/api/group/rename' && request.method === 'POST') return handleGroupRename(request, env);
  if (path === '/api/group/leave' && request.method === 'POST') return handleGroupLeave(request, env);
  if (path === '/api/group/kick' && request.method === 'POST') return handleGroupKick(request, env);
  if (path === '/api/group/messages' && (request.method === 'GET' || request.method === 'POST')) {
    return handleGroupMessages(request, env);
  }
  if (path === '/api/group/import' && request.method === 'POST') return handleGroupImport(request, env);
  if (path === '/api/group/file/delete' && request.method === 'POST') return handleGroupFileDelete(request, env);
  if (path === '/api/group/file/ignore' && request.method === 'POST') return handleGroupFileIgnore(request, env);
  if (path === '/api/group/deck' && request.method === 'GET') return handleGroupPreview(request, env);
  if (path === '/api/admin/users' && request.method === 'GET') return handleAdminUsers(request, env);
  if (path === '/api/admin/users/delete' && request.method === 'POST') return handleAdminDelete(request, env);
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
