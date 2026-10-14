'use strict';

// 拯词在线账号与进度同步服务。
//
// This service is intentionally a small, dependency-free Node service so it
// can be deployed to any Node 18+ host. Put it behind HTTPS in production and
// set SAVVEUR_AUTH_ORIGINS to the exact browser origins that may call it.
// Passwords are never stored in plain text: scrypt derives a password hash and
// only a SHA-256 hash of each bearer token is persisted.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.SAVVEUR_AUTH_PORT || 8787);
const HOST = process.env.SAVVEUR_AUTH_HOST || '127.0.0.1';
const DATA_FILE = path.resolve(process.env.SAVVEUR_AUTH_DATA || path.join(__dirname, 'auth-data.json'));
const MAX_BODY = 2 * 1024 * 1024;
const SESSION_DAYS = 30;
const PASSWORD_MIN = 8;
const ALLOWED_ORIGINS = new Set(
  (process.env.SAVVEUR_AUTH_ORIGINS || 'http://127.0.0.1:8765,http://localhost:8765,null')
    .split(',').map(s => s.trim()).filter(Boolean)
);
const rate = new Map();

function now() { return Date.now(); }
function id(prefix) { return prefix + crypto.randomBytes(12).toString('hex'); }
function token() { return crypto.randomBytes(32).toString('base64url'); }
function hashToken(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function normalizedEmail(value) { return String(value || '').trim().toLowerCase(); }
function normalizedUsername(value) { return String(value || '').trim().toLocaleLowerCase(); }
function json(res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(body);
}
function fail(status, message, code) { return { error: { code: code || 'request_failed', message } }; }

function initialData() { return { version: 1, users: {}, sessions: {} }; }
function loadData() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (parsed && parsed.version === 1 && parsed.users && parsed.sessions) return parsed;
  } catch { /* first launch or interrupted write */ }
  return initialData();
}
let data = loadData();
function persist() {
  const dir = path.dirname(DATA_FILE);
  fs.mkdirSync(dir, { recursive: true });
  const temporary = DATA_FILE + '.tmp-' + process.pid;
  fs.writeFileSync(temporary, JSON.stringify(data), { encoding: 'utf8', mode: 0o600 });
  try {
    fs.renameSync(temporary, DATA_FILE);
  } catch (error) {
    // Windows does not replace an existing file with renameSync. Keep the
    // normal atomic path where supported, then use a short fallback for the
    // packaged Windows runtime instead of dropping a successful registration.
    if (!['EEXIST', 'EPERM', 'ENOTEMPTY'].includes(error.code)) throw error;
    try { fs.rmSync(DATA_FILE, { force: true }); } catch { /* retry below */ }
    try { fs.renameSync(temporary, DATA_FILE); }
    catch { fs.copyFileSync(temporary, DATA_FILE); fs.rmSync(temporary, { force: true }); }
  }
}
function pruneSessions() {
  const cutoff = now(); let changed = false;
  for (const [key, session] of Object.entries(data.sessions)) {
    if (!session || session.expiresAt <= cutoff || !data.users[session.userId]) { delete data.sessions[key]; changed = true; }
  }
  if (changed) persist();
}
function publicUser(user) {
  return { id: user.id, email: user.email, username: user.username, createdAt: user.createdAt };
}
function validateRegistration(input) {
  const email = normalizedEmail(input.email), username = String(input.username || '').trim(), password = String(input.password || '');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/u.test(email) || email.length > 254) return { error: '邮箱格式不对，请检查一下。', field: 'email' };
  if (username.length < 2 || username.length > 24 || /[\u0000-\u001f\u007f]/u.test(username)) return { error: '用户名需要是 2–24 个字符。', field: 'username' };
  if (password.length < PASSWORD_MIN || password.length > 128) return { error: `密码需要至少 ${PASSWORD_MIN} 位。`, field: 'password' };
  return { email, username, password };
}
function derivePassword(password, salt = crypto.randomBytes(16)) {
  const digest = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return { salt: salt.toString('base64'), hash: digest.toString('base64') };
}
function passwordMatches(password, user) {
  try {
    const salt = Buffer.from(user.passwordSalt, 'base64');
    const expected = Buffer.from(user.passwordHash, 'base64');
    const actual = crypto.scryptSync(password, salt, expected.length, { N: 16384, r: 8, p: 1 });
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch { return false; }
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0, text = '';
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY) { reject(Object.assign(Error('请求太大了。'), { status: 413 })); req.destroy(); return; }
      text += chunk;
    });
    req.on('end', () => {
      if (!text) return resolve({});
      try { resolve(JSON.parse(text)); } catch { reject(Object.assign(Error('请求格式不对。'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}
function requestIp(req) {
  // Do not trust forwarded headers by default. A reverse proxy may set
  // SAVVEUR_AUTH_TRUST_PROXY=1 after it has sanitised X-Forwarded-For.
  return process.env.SAVVEUR_AUTH_TRUST_PROXY === '1'
    ? String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim()
    : String(req.socket.remoteAddress || '');
}
function checkRate(req, kind) {
  const key = kind + ':' + requestIp(req), current = rate.get(key) || { count: 0, at: now() };
  if (now() - current.at > 10 * 60 * 1000) { current.count = 0; current.at = now(); }
  current.count++;
  rate.set(key, current);
  // Registration and login are deliberately conservative. This is a basic
  // guard; production deployments can add a reverse-proxy rate limiter.
  return current.count <= (kind === 'register' ? 12 : 30);
}
function bearer(req) {
  const raw = String(req.headers.authorization || '');
  const match = raw.match(/^Bearer\s+([A-Za-z0-9_-]{30,100})$/i);
  return match ? match[1] : '';
}
function auth(req) {
  pruneSessions();
  const raw = bearer(req), session = raw ? data.sessions[hashToken(raw)] : null;
  if (!session || session.expiresAt <= now()) return null;
  const user = data.users[session.userId];
  if (!user) return null;
  session.lastSeenAt = now();
  return { raw, session, user };
}
function userResponse(user, sessionToken, expiresAt) {
  return { user: publicUser(user), accessToken: sessionToken, tokenType: 'Bearer', expiresAt };
}
function cleanState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Object.assign(Error('进度数据格式不对。'), { status: 400 });
  const text = JSON.stringify(value);
  if (text.length > MAX_BODY) throw Object.assign(Error('进度数据太大了。'), { status: 413 });
  // Round-trip removes prototype-bearing input and makes the stored value
  // plain JSON. The page already escapes user text before displaying it.
  return JSON.parse(text);
}

async function handler(req, res) {
  const origin = req.headers.origin;
  if (origin && !ALLOWED_ORIGINS.has(origin)) return json(res, 403, fail(403, '这个来源没有接入拯词账号。', 'origin_not_allowed'));
  if (origin) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const url = new URL(req.url || '/', `http://${HOST}:${PORT}`);
  if (url.pathname === '/health' || url.pathname === '/api/health') return json(res, 200, { ok: true, service: 'savveur-auth', version: '1.0.0' });
  // Keep the short /api names as aliases for the first desktop client build.
  // The versioned routes remain canonical for future clients.
  const route = ({
    '/api/auth/register': '/v1/auth/register',
    '/api/auth/login': '/v1/auth/login',
    '/api/auth/logout': '/v1/auth/logout',
    '/api/auth/me': '/v1/auth/me',
    '/api/progress': '/v1/sync/state'
  })[url.pathname] || url.pathname;

  if (req.method === 'POST' && route === '/v1/auth/register') {
    if (!checkRate(req, 'register')) return json(res, 429, fail(429, '注册请求有点多，等几分钟再试。', 'rate_limited'));
    const input = await readBody(req), checked = validateRegistration(input);
    if (checked.error) return json(res, 400, fail(400, checked.error, 'invalid_' + checked.field));
    const key = checked.email, usernameKey = normalizedUsername(checked.username);
    if (Object.values(data.users).some(user => user.email === key)) return json(res, 409, fail(409, '这个邮箱已经注册过了，直接登录吧。', 'email_exists'));
    if (Object.values(data.users).some(user => normalizedUsername(user.username) === usernameKey)) return json(res, 409, fail(409, '这个用户名已经被用了，换一个试试。', 'username_exists'));
    const password = derivePassword(checked.password), user = { id: id('u_'), email: key, username: checked.username, passwordSalt: password.salt, passwordHash: password.hash, createdAt: now(), state: {}, stateRevision: 0, stateUpdatedAt: 0, progress: null, progressRevision: 0 };
    data.users[user.id] = user;
    const raw = token(), expiresAt = now() + SESSION_DAYS * 86400000;
    data.sessions[hashToken(raw)] = { userId: user.id, createdAt: now(), lastSeenAt: now(), expiresAt };
    persist();
    return json(res, 201, userResponse(user, raw, expiresAt));
  }

  if (req.method === 'POST' && route === '/v1/auth/login') {
    if (!checkRate(req, 'login')) return json(res, 429, fail(429, '登录尝试有点多，等几分钟再试。', 'rate_limited'));
    const input = await readBody(req), email = normalizedEmail(input.email), password = String(input.password || '');
    const user = Object.values(data.users).find(item => item.email === email);
    if (!user || !passwordMatches(password, user)) return json(res, 401, fail(401, '邮箱或密码不对。', 'invalid_credentials'));
    const raw = token(), expiresAt = now() + SESSION_DAYS * 86400000;
    data.sessions[hashToken(raw)] = { userId: user.id, createdAt: now(), lastSeenAt: now(), expiresAt };
    persist();
    return json(res, 200, userResponse(user, raw, expiresAt));
  }

  const identity = auth(req);
  if (!identity) return json(res, 401, fail(401, '登录状态过期了，请重新登录。', 'unauthorized'));
  if (req.method === 'POST' && route === '/v1/auth/logout') {
    const raw = bearer(req); delete data.sessions[hashToken(raw)]; persist();
    return json(res, 200, { ok: true });
  }
  if (req.method === 'GET' && route === '/v1/auth/me') return json(res, 200, { user: publicUser(identity.user) });
  if (req.method === 'GET' && route === '/v1/sync/state') {
    if (url.pathname === '/api/progress') {
      return json(res, 200, identity.user.progress || { state: identity.user.state || {}, revision: identity.user.stateRevision || 0, updatedAt: identity.user.stateUpdatedAt || 0 });
    }
    return json(res, 200, { state: identity.user.state || {}, revision: identity.user.stateRevision || 0, updatedAt: identity.user.stateUpdatedAt || 0 });
  }
  if (req.method === 'PUT' && route === '/v1/sync/state') {
    if (url.pathname === '/api/progress') {
      const bundle = cleanState(await readBody(req));
      identity.user.progress = bundle;
      identity.user.progressRevision = (identity.user.progressRevision || 0) + 1;
      // Keep the canonical state endpoint useful for clients that switch from
      // the legacy progress alias to the versioned API.
      if (bundle.state && typeof bundle.state === 'object') {
        identity.user.state = bundle.state;
        identity.user.stateUpdatedAt = Number(bundle.updatedAt) || now();
        identity.user.stateRevision = identity.user.progressRevision;
      }
      persist();
      return json(res, 200, { ok: true, revision: identity.user.progressRevision, updatedAt: Number(bundle.updatedAt) || now() });
    }
    const input = await readBody(req), current = identity.user.stateRevision || 0;
    if (input.baseRevision !== undefined && Number(input.baseRevision) !== current) return json(res, 409, { ...fail(409, '云端进度刚刚更新过，请先拉取后再保存。', 'revision_conflict'), state: identity.user.state || {}, revision: current, updatedAt: identity.user.stateUpdatedAt || 0 });
    const state = cleanState(input.state), revision = current + 1, updatedAt = now();
    identity.user.state = state; identity.user.stateRevision = revision; identity.user.stateUpdatedAt = updatedAt;
    persist();
    return json(res, 200, { ok: true, revision, updatedAt });
  }
  return json(res, 404, fail(404, '找不到这个账号接口。', 'not_found'));
}

function makeServer() {
  return http.createServer((req, res) => {
    handler(req, res).catch(error => {
      const status = Number(error.status) || 500;
      if (!res.headersSent) json(res, status, fail(status, status >= 500 ? '服务暂时有点忙，请稍后再试。' : error.message)); else res.end();
    });
  });
}
if (require.main === module) {
  pruneSessions();
  makeServer().listen(PORT, HOST, () => console.log(`Savveur auth ready at http://${HOST}:${PORT}`));
}
module.exports = { makeServer, handler, validateRegistration, derivePassword, passwordMatches, cleanState, DATA_FILE };
