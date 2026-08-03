'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'db.json');
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-this-secret-before-production';
const COOKIE_NAME = 'ct_session';
const FOUR_DAYS_MS = 4 * 24 * 60 * 60 * 1000;
const ADMIN_DEFAULT_HASH = '491ad8b1244e3abf0b809a76e9bebec1:cd2b8f5a825acbecb33132e77350cff77f6b075a5f484506cd43ad558bfc5e6c8f8e56c5161d899e51f27ad9133b6fdee00b0c53a7f26c834f3a37eae55a86a5';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8'
};

function now() { return new Date().toISOString(); }
function uid(prefix = '') { return `${prefix}${crypto.randomUUID()}`; }
function cleanText(value, max = 120) { return String(value || '').trim().slice(0, max); }
function safeUser(user) {
  return { id: user.id, username: user.username, email: user.email, role: user.role, plan: user.plan, createdAt: user.createdAt, disabled: Boolean(user.disabled) };
}
function ensureDir(file) { fs.mkdirSync(path.dirname(file), { recursive: true }); }

function loadDb() {
  ensureDir(DATA_FILE);
  if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, JSON.stringify({ users: [], jobs: [], activity: [], meta: { createdAt: now() } }, null, 2));
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    parsed.users ||= []; parsed.jobs ||= []; parsed.activity ||= [];
    return parsed;
  } catch {
    const backup = `${DATA_FILE}.broken-${Date.now()}`;
    fs.copyFileSync(DATA_FILE, backup);
    return { users: [], jobs: [], activity: [], meta: { createdAt: now(), recoveredFrom: backup } };
  }
}
let db = loadDb();
let saveTimer;
function saveDb() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const tmp = `${DATA_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, DATA_FILE);
  }, 25);
}
function logActivity(userId, type, detail, meta = {}) {
  db.activity.unshift({ id: uid('act_'), userId: userId || null, type, detail: cleanText(detail, 500), meta, createdAt: now() });
  db.activity = db.activity.slice(0, 3000); saveDb();
}
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return `${salt}:${crypto.scryptSync(password, salt, 64).toString('hex')}`;
}
function verifyPassword(password, stored) {
  try {
    const [salt, expectedHex] = String(stored).split(':');
    const actual = crypto.scryptSync(password, salt, 64), expected = Buffer.from(expectedHex, 'hex');
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch { return false; }
}
function seedAdmin() {
  if (db.users.some(user => user.role === 'admin')) return;
  const user = {
    id: uid('usr_'), username: cleanText(process.env.ADMIN_USERNAME || 'admin', 40).toLowerCase(), email: '', role: 'admin', plan: 'admin',
    passwordHash: process.env.ADMIN_PASSWORD ? hashPassword(process.env.ADMIN_PASSWORD) : ADMIN_DEFAULT_HASH,
    disabled: false, createdAt: now(), updatedAt: now()
  };
  db.users.push(user); logActivity(user.id, 'admin_seeded', 'Akun administrator dibuat saat server pertama kali dijalankan.'); saveDb();
}
seedAdmin();

function markStaleJobs() {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  let changed = 0;
  for (const job of db.jobs) {
    if (['queued', 'processing'].includes(job.status) && new Date(job.updatedAt || job.createdAt).getTime() < cutoff) {
      job.status = 'failed';
      job.finishedAt ||= now();
      job.updatedAt = now();
      job.logs ||= [];
      job.logs.push(`[${new Date().toLocaleTimeString('id-ID')}] Job ditutup otomatis karena tidak ada update selama 2 jam.`);
      changed += 1;
    }
  }
  if (changed) saveDb();
}
markStaleJobs();

function base64url(value) { return Buffer.from(value).toString('base64url'); }
function signSession(user) {
  const payload = base64url(JSON.stringify({ sub: user.id, role: user.role, exp: Date.now() + 7 * 24 * 60 * 60 * 1000 }));
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}
function readSession(token) {
  if (!token || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return data.exp && Date.now() <= data.exp ? data : null;
  } catch { return null; }
}
function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const index = part.indexOf('='); if (index < 0) continue;
    out[decodeURIComponent(part.slice(0, index).trim())] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return out;
}
function getUser(req) {
  const session = readSession(parseCookies(req)[COOKIE_NAME]);
  return session ? db.users.find(user => user.id === session.sub && !user.disabled) || null : null;
}
function sessionCookie(token) {
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`;
}
function clearCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`;
}
function quotaInfo(user) {
  if (user.role === 'admin' || user.plan === 'pro') return { plan: user.plan, limit: null, used: 0, remaining: null, nextResetAt: null, unlimited: true };
  const cutoff = Date.now() - FOUR_DAYS_MS;
  const recent = db.jobs.filter(job => job.userId === user.id && new Date(job.createdAt).getTime() > cutoff && !['failed', 'cancelled'].includes(job.status)).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const last = recent[0];
  return { plan: 'free', limit: 1, used: recent.length ? 1 : 0, remaining: recent.length ? 0 : 1, nextResetAt: last ? new Date(new Date(last.createdAt).getTime() + FOUR_DAYS_MS).toISOString() : null, unlimited: false };
}

function securityHeaders() {
  return {
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'"
  };
}
function sendJson(res, status, data, extraHeaders = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, { ...securityHeaders(), 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store', ...extraHeaders });
  res.end(body);
}
function sendText(res, status, text, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { ...securityHeaders(), 'Content-Type': type, 'Content-Length': Buffer.byteLength(text) }); res.end(text);
}
async function readBody(req, maxBytes = 1024 * 1024) {
  const chunks = []; let total = 0;
  for await (const chunk of req) {
    total += chunk.length; if (total > maxBytes) throw Object.assign(new Error('Payload terlalu besar.'), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('JSON request tidak valid.'), { status: 400 }); }
}
function requireUser(req, res) {
  const user = getUser(req);
  if (!user) { sendJson(res, 401, { error: 'Silakan login terlebih dahulu.' }); return null; }
  return user;
}
function requireAdmin(req, res) {
  const user = requireUser(req, res);
  if (!user) return null;
  if (user.role !== 'admin') { sendJson(res, 403, { error: 'Akses administrator diperlukan.' }); return null; }
  return user;
}
function validOrigin(req) {
  if (!['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) return true;
  const origin = req.headers.origin; if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}
const rateMap = new Map();
function checkRate(req, keyName, windowMs, limit) {
  const key = `${req.socket.remoteAddress}:${keyName}`;
  const item = rateMap.get(key) || { count: 0, reset: Date.now() + windowMs };
  if (Date.now() > item.reset) { item.count = 0; item.reset = Date.now() + windowMs; }
  item.count += 1; rateMap.set(key, item); return item.count <= limit;
}

async function handleApi(req, res, url) {
  if (!validOrigin(req)) return sendJson(res, 403, { error: 'Origin tidak valid.' });
  const pathname = url.pathname;
  if (req.method === 'GET' && pathname === '/api/health') return sendJson(res, 200, { ok: true, service: 'ConvertTexture', time: now() });

  if (req.method === 'POST' && pathname === '/api/auth/register') {
    if (!checkRate(req, 'register', 10 * 60 * 1000, 10)) return sendJson(res, 429, { error: 'Terlalu banyak permintaan. Coba lagi sebentar.' });
    const body = await readBody(req), username = cleanText(body.username, 32).toLowerCase(), email = cleanText(body.email, 120).toLowerCase(), password = String(body.password || '');
    if (!/^[a-z0-9_]{3,32}$/.test(username)) return sendJson(res, 400, { error: 'Username 3–32 karakter dan hanya boleh huruf kecil, angka, atau underscore.' });
    if (email && !/^\S+@\S+\.\S+$/.test(email)) return sendJson(res, 400, { error: 'Format email tidak valid.' });
    if (password.length < 8 || password.length > 128) return sendJson(res, 400, { error: 'Password minimal 8 karakter.' });
    if (db.users.some(user => user.username === username)) return sendJson(res, 409, { error: 'Username sudah dipakai.' });
    if (email && db.users.some(user => user.email === email)) return sendJson(res, 409, { error: 'Email sudah dipakai.' });
    const user = { id: uid('usr_'), username, email, role: 'user', plan: 'free', passwordHash: hashPassword(password), disabled: false, createdAt: now(), updatedAt: now() };
    db.users.push(user); logActivity(user.id, 'register', `User ${username} mendaftar.`); saveDb();
    return sendJson(res, 201, { user: safeUser(user), quota: quotaInfo(user) }, { 'Set-Cookie': sessionCookie(signSession(user)) });
  }

  if (req.method === 'POST' && pathname === '/api/auth/login') {
    if (!checkRate(req, 'login', 10 * 60 * 1000, 20)) return sendJson(res, 429, { error: 'Terlalu banyak percobaan login. Coba lagi sebentar.' });
    const body = await readBody(req), identity = cleanText(body.username, 120).toLowerCase(), password = String(body.password || '');
    const user = db.users.find(item => item.username === identity || (item.email && item.email === identity));
    if (!user || user.disabled || !verifyPassword(password, user.passwordHash)) {
      logActivity(user?.id || null, 'login_failed', `Login gagal untuk ${identity || 'unknown'}.`, { ip: req.socket.remoteAddress });
      return sendJson(res, 401, { error: 'Username/email atau password salah.' });
    }
    user.lastLoginAt = now(); user.updatedAt = now(); logActivity(user.id, 'login', `User ${user.username} login.`, { ip: req.socket.remoteAddress }); saveDb();
    return sendJson(res, 200, { user: safeUser(user), quota: quotaInfo(user) }, { 'Set-Cookie': sessionCookie(signSession(user)) });
  }

  if (req.method === 'GET' && pathname === '/api/auth/me') {
    const user = requireUser(req, res); if (!user) return;
    return sendJson(res, 200, { user: safeUser(user), quota: quotaInfo(user) });
  }
  if (req.method === 'POST' && pathname === '/api/auth/logout') {
    const user = requireUser(req, res); if (!user) return;
    logActivity(user.id, 'logout', `User ${user.username} logout.`);
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': clearCookie() });
  }
  if (req.method === 'POST' && pathname === '/api/auth/change-password') {
    const user = requireUser(req, res); if (!user) return;
    if (!checkRate(req, 'password', 10 * 60 * 1000, 8)) return sendJson(res, 429, { error: 'Terlalu banyak permintaan.' });
    const body = await readBody(req), current = String(body.currentPassword || ''), nextPassword = String(body.newPassword || '');
    if (!verifyPassword(current, user.passwordHash)) return sendJson(res, 400, { error: 'Password lama salah.' });
    if (nextPassword.length < 8 || nextPassword.length > 128) return sendJson(res, 400, { error: 'Password baru minimal 8 karakter.' });
    user.passwordHash = hashPassword(nextPassword); user.updatedAt = now(); logActivity(user.id, 'password_changed', 'Password akun diubah.'); saveDb();
    return sendJson(res, 200, { ok: true });
  }
  if (req.method === 'GET' && pathname === '/api/quota') {
    const user = requireUser(req, res); if (!user) return; return sendJson(res, 200, quotaInfo(user));
  }

  if (req.method === 'POST' && pathname === '/api/jobs') {
    const user = requireUser(req, res); if (!user) return;
    if (!checkRate(req, 'create-job', 60 * 1000, 12)) return sendJson(res, 429, { error: 'Terlalu banyak permintaan.' });
    const body = await readBody(req), tool = cleanText(body.tool, 32);
    if (!['version', 'optimize', 'bedrock'].includes(tool)) return sendJson(res, 400, { error: 'Jenis tool tidak valid.' });
    markStaleJobs();
    const active = db.jobs.find(job => job.userId === user.id && ['queued', 'processing'].includes(job.status));
    if (active) return sendJson(res, 409, { error: 'Masih ada proses aktif. Tunggu sampai selesai.', activeJobId: active.id });
    const quota = quotaInfo(user);
    if (!quota.unlimited && quota.remaining <= 0) return sendJson(res, 429, { error: 'Kuota Free sudah habis. Maksimal 1 proses setiap 4 hari.', quota });
    const job = {
      id: uid('job_'), userId: user.id, username: user.username, tool, filename: cleanText(body.filename, 180) || 'resource-pack.zip', originalSize: Math.max(0, Number(body.originalSize || 0)),
      outputSize: 0, savedPercent: 0, status: 'processing', progress: 1,
      logs: [`[${new Date().toLocaleTimeString('id-ID')}] Job dibuat dan browser memulai proses.`], resultName: '', createdAt: now(), updatedAt: now(), finishedAt: null
    };
    db.jobs.unshift(job); db.jobs = db.jobs.slice(0, 5000); logActivity(user.id, 'job_started', `${user.username} memulai ${tool}: ${job.filename}.`, { jobId: job.id }); saveDb();
    return sendJson(res, 201, { job });
  }
  const jobPatch = pathname.match(/^\/api\/jobs\/([^/]+)$/);
  if (req.method === 'PATCH' && jobPatch) {
    const user = requireUser(req, res); if (!user) return;
    if (!checkRate(req, 'patch-job', 60 * 1000, 150)) return sendJson(res, 429, { error: 'Terlalu banyak update job.' });
    const job = db.jobs.find(item => item.id === jobPatch[1]);
    if (!job) return sendJson(res, 404, { error: 'Job tidak ditemukan.' });
    if (job.userId !== user.id && user.role !== 'admin') return sendJson(res, 403, { error: 'Tidak boleh mengubah job ini.' });
    const body = await readBody(req);
    if (['queued', 'processing', 'complete', 'failed', 'cancelled'].includes(body.status)) job.status = body.status;
    if (Number.isFinite(Number(body.progress))) job.progress = Math.max(0, Math.min(100, Number(body.progress)));
    if (Number.isFinite(Number(body.outputSize))) job.outputSize = Math.max(0, Number(body.outputSize));
    if (Number.isFinite(Number(body.savedPercent))) job.savedPercent = Number(body.savedPercent);
    if (body.resultName) job.resultName = cleanText(body.resultName, 180);
    if (Array.isArray(body.logs)) { job.logs.push(...body.logs.map(line => cleanText(line, 700)).filter(Boolean).slice(-50)); job.logs = job.logs.slice(-250); }
    job.updatedAt = now();
    if (['complete', 'failed', 'cancelled'].includes(job.status) && !job.finishedAt) { job.finishedAt = now(); logActivity(user.id, `job_${job.status}`, `${job.filename} berstatus ${job.status}.`, { jobId: job.id, tool: job.tool }); }
    saveDb(); return sendJson(res, 200, { job, quota: quotaInfo(user) });
  }
  if (req.method === 'GET' && pathname === '/api/jobs') {
    const user = requireUser(req, res); if (!user) return;
    return sendJson(res, 200, { jobs: db.jobs.filter(job => job.userId === user.id).slice(0, 100) });
  }

  if (req.method === 'GET' && pathname === '/api/admin/overview') {
    const user = requireAdmin(req, res); if (!user) return;
    const counts = db.jobs.reduce((acc, job) => { acc.total += 1; acc[job.status] = (acc[job.status] || 0) + 1; return acc; }, { total: 0, queued: 0, processing: 0, complete: 0, failed: 0, cancelled: 0 });
    return sendJson(res, 200, { counts, users: db.users.length, recentJobs: db.jobs.slice(0, 100), activity: db.activity.slice(0, 100) });
  }
  if (req.method === 'GET' && pathname === '/api/admin/users') {
    const user = requireAdmin(req, res); if (!user) return;
    return sendJson(res, 200, { users: db.users.map(item => ({ ...safeUser(item), quota: quotaInfo(item), lastLoginAt: item.lastLoginAt || null })) });
  }
  const adminUser = pathname.match(/^\/api\/admin\/users\/([^/]+)$/);
  if (req.method === 'PATCH' && adminUser) {
    const admin = requireAdmin(req, res); if (!admin) return;
    const user = db.users.find(item => item.id === adminUser[1]); if (!user) return sendJson(res, 404, { error: 'User tidak ditemukan.' });
    if (user.role === 'admin' && user.id !== admin.id) return sendJson(res, 400, { error: 'Akun administrator lain tidak boleh diubah dari sini.' });
    const body = await readBody(req);
    if (user.role !== 'admin' && ['free', 'pro'].includes(body.plan)) user.plan = body.plan;
    if (typeof body.disabled === 'boolean' && user.id !== admin.id) user.disabled = body.disabled;
    user.updatedAt = now(); logActivity(admin.id, 'user_updated', `Admin mengubah ${user.username}.`, { targetUserId: user.id, plan: user.plan, disabled: user.disabled }); saveDb();
    return sendJson(res, 200, { user: safeUser(user), quota: quotaInfo(user) });
  }
  const resetQuota = pathname.match(/^\/api\/admin\/users\/([^/]+)\/reset-quota$/);
  if (req.method === 'POST' && resetQuota) {
    const admin = requireAdmin(req, res); if (!admin) return;
    const user = db.users.find(item => item.id === resetQuota[1]); if (!user) return sendJson(res, 404, { error: 'User tidak ditemukan.' });
    const cutoff = Date.now() - FOUR_DAYS_MS; let changed = 0;
    for (const job of db.jobs) {
      if (job.userId === user.id && new Date(job.createdAt).getTime() > cutoff && !['failed', 'cancelled'].includes(job.status)) {
        job.status = 'cancelled'; job.logs.push(`[${new Date().toLocaleTimeString('id-ID')}] Kuota di-reset oleh administrator.`); job.finishedAt ||= now(); job.updatedAt = now(); changed += 1;
      }
    }
    logActivity(admin.id, 'quota_reset', `Kuota ${user.username} di-reset.`, { targetUserId: user.id, changed }); saveDb();
    return sendJson(res, 200, { ok: true, changed, quota: quotaInfo(user) });
  }

  return sendJson(res, 404, { error: 'API endpoint tidak ditemukan.' });
}

function serveStatic(req, res, url) {
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch { return sendText(res, 400, 'Bad request'); }
  let relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  if (!path.extname(relative)) relative = 'index.html';
  const filePath = path.resolve(PUBLIC_DIR, relative);
  if (!filePath.startsWith(path.resolve(PUBLIC_DIR) + path.sep) && filePath !== path.resolve(PUBLIC_DIR, 'index.html')) return sendText(res, 403, 'Forbidden');
  fs.stat(filePath, (error, stat) => {
    if (error || !stat.isFile()) {
      const fallback = path.join(PUBLIC_DIR, 'index.html');
      fs.readFile(fallback, (readError, data) => {
        if (readError) return sendText(res, 404, 'Not found');
        res.writeHead(200, { ...securityHeaders(), 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' }); res.end(data);
      });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { ...securityHeaders(), 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600' });
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else if (req.method === 'GET' || req.method === 'HEAD') serveStatic(req, res, url);
    else sendJson(res, 405, { error: 'Method tidak diizinkan.' });
  } catch (error) {
    console.error(error); logActivity(getUser(req)?.id || null, 'server_error', error.message || 'Unknown server error');
    if (!res.headersSent) sendJson(res, error.status || 500, { error: error.status ? error.message : 'Terjadi kesalahan di server.' });
    else res.end();
  }
});
server.listen(PORT, () => {
  console.log(`ConvertTexture running on http://localhost:${PORT}`);
  if (SESSION_SECRET === 'change-this-secret-before-production') console.warn('WARNING: set SESSION_SECRET before production deployment.');
});
