const crypto = require('crypto');
const configManager = require('./config-manager');

const COOKIE = 'rh_session';
const SESSION_DAYS = 30;
const SCRYPT = { N: 16384, r: 8, p: 1 };

// ─── Passwords ────────────────────────────────────────────────────────────────

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, SCRYPT);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(password, stored) {
  const [scheme, salt, hash] = String(stored || '').split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = crypto.scryptSync(String(password), Buffer.from(salt, 'base64'), expected.length, SCRYPT);
  return crypto.timingSafeEqual(actual, expected);
}

function validateCredentials(username, password) {
  if (typeof username !== 'string' || !/^[A-Za-z0-9._-]{2,32}$/.test(username.trim())) {
    throw new Error('Username must be 2–32 characters (letters, numbers, . _ -)');
  }
  if (typeof password !== 'string' || password.length < 8) {
    throw new Error('Password must be at least 8 characters');
  }
}

// ─── Account (stored in config.yaml → auth) ───────────────────────────────────

function getAccount() {
  try {
    const auth = configManager.load().auth;
    return auth?.username && auth?.passwordHash ? auth : null;
  } catch { return null; }
}

function hasAccount() {
  return getAccount() !== null;
}

function setCredentials(username, password) {
  validateCredentials(username, password);
  const config = configManager.load();
  config.auth = {
    username: username.trim(),
    passwordHash: hashPassword(password),
    // New secret on every change — invalidates all existing sessions
    secret: crypto.randomBytes(32).toString('base64'),
  };
  configManager.save(config);
}

function checkLogin(username, password) {
  const account = getAccount();
  if (!account) return false;
  const userOk = String(username || '').trim().toLowerCase() === account.username.toLowerCase();
  const passOk = verifyPassword(password || '', account.passwordHash); // always run — constant-ish timing
  return userOk && passOk;
}

// ─── Sessions (stateless signed cookie) ───────────────────────────────────────

function sign(data, secret) {
  return crypto.createHmac('sha256', secret).update(data).digest('base64url');
}

function createToken(account) {
  const data = Buffer.from(JSON.stringify({ u: account.username, exp: Date.now() + SESSION_DAYS * 86400000 })).toString('base64url');
  return `${data}.${sign(data, account.secret)}`;
}

function verifyToken(token) {
  const account = getAccount();
  if (!account || !token) return null;
  const [data, sig] = String(token).split('.');
  if (!data || !sig) return null;
  const expected = sign(data, account.secret);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString());
    if (payload.exp < Date.now() || payload.u !== account.username) return null;
    return payload.u;
  } catch { return null; }
}

function readCookie(req) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return decodeURIComponent(v.join('='));
  }
  return null;
}

function setSessionCookie(req, res) {
  const account = getAccount();
  if (!account) return;
  const secure = req.secure ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE}=${createToken(account)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure}`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function currentUser(req) {
  return verifyToken(readCookie(req));
}

// ─── Login rate limiting (per IP, in memory) ──────────────────────────────────

const MAX_FAILURES = 10;
const WINDOW_MS = 15 * 60 * 1000;
const failures = new Map(); // ip → { count, first }

function isLockedOut(ip) {
  const f = failures.get(ip);
  if (!f) return false;
  if (Date.now() - f.first > WINDOW_MS) { failures.delete(ip); return false; }
  return f.count >= MAX_FAILURES;
}

function recordFailure(ip) {
  const f = failures.get(ip);
  if (!f || Date.now() - f.first > WINDOW_MS) failures.set(ip, { count: 1, first: Date.now() });
  else f.count++;
}

function clearFailures(ip) {
  failures.delete(ip);
}

module.exports = {
  hasAccount, getAccount, setCredentials, checkLogin, validateCredentials, verifyPassword,
  setSessionCookie, clearSessionCookie, currentUser,
  isLockedOut, recordFailure, clearFailures,
};
