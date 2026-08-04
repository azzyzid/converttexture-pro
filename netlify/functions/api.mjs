import { getStore } from '@netlify/blobs';
import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(crypto.scrypt);
const STORE_NAME = 'converttexture-db';
const COOKIE_NAME = 'ct_session';
const FOUR_DAYS_MS = 4 * 24 * 60 * 60 * 1000;
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_ADMIN_HASH = '491ad8b1244e3abf0b809a76e9bebec1:cd2b8f5a825acbecb33132e77350cff77f6b075a5f484506cd43ad558bfc5e6c8f8e56c5161d899e51f27ad9133b6fdee00b0c53a7f26c834f3a37eae55a86a5';

let store;

const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'Content-Type': 'application/json; charset=utf-8',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY'
};

function now() { return new Date().toISOString(); }
function uid(prefix = '') { return `${prefix}${crypto.randomUUID()}`; }
function cleanText(value, max = 120) { return String(value ?? '').trim().slice(0, max); }
function safeUser(user) {
  return {
    id: user.id,
    username: user.username,
    email: user.email || '',
    role: user.role,
    plan: user.plan,
    createdAt: user.createdAt,
    disabled: Boolean(user.disabled)
  };
}
function json(status, data, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...SECURITY_HEADERS, ...extraHeaders }
  });
}
function normalizedPath(request) {
  const pathname = new URL(request.url).pathname;
  const functionPrefix = '/.netlify/functions/api';
  if (pathname.startsWith(functionPrefix)) return `/api${pathname.slice(functionPrefix.length)}`;
  return pathname;
}
async function bodyJson(request, maxBytes = 1024 * 1024) {
  const raw = await request.text();
  if (Buffer.byteLength(raw, 'utf8') > maxBytes) throw Object.assign(new Error('Payload terlalu besar.'), { status: 413 });
  if (!raw) return {};
  try { return JSON.parse(raw); }
  catch { throw Object.assign(new Error('JSON request tidak valid.'), { status: 400 }); }
}
function parseCookies(request) {
  const output = {};
  for (const part of String(request.headers.get('cookie') || '').split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    output[decodeURIComponent(part.slice(0, index).trim())] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return output;
}
function clientIp(request, context) {
  return cleanText(
    context?.ip || request.headers.get('x-nf-client-connection-ip') || request.headers.get('x-forwarded-for')?.split(',')[0] || 'unknown',
    100
  );
}
function sha256(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }
function validOrigin(request) {
  if (!['POST', 'PATCH', 'PUT', 'DELETE'].includes(request.method)) return true;
  const origin = request.headers.get('origin');
  if (!origin) return true;
  try { return new URL(origin).host === new URL(request.url).host; }
  catch { return false; }
}

async function getJSON(key) { return store.get(key, { type: 'json' }); }
async function listJSON(prefix, max = 5000) {
  const { blobs = [] } = await store.list({ prefix });
  const selected = blobs.slice(-max);
  const values = await Promise.all(selected.map(({ key }) => getJSON(key)));
  return values.filter(Boolean);
}
async function setJSON(key, value, options) { return store.setJSON(key, value, options); }

async function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const derived = await scryptAsync(password, salt, 64);
  return `${salt}:${Buffer.from(derived).toString('hex')}`;
}
async function verifyPassword(password, stored) {
  try {
    const [salt, expectedHex] = String(stored || '').split(':');
    if (!salt || !expectedHex) return false;
    const actual = Buffer.from(await scryptAsync(password, salt, 64));
    const expected = Buffer.from(expectedHex, 'hex');
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch { return false; }
}

async function ensureAdmin() {
  const adminUsername = cleanText(process.env.ADMIN_USERNAME || 'admin', 32).toLowerCase();
  const existingAdminId = await store.get('meta/admin-id');
  if (existingAdminId) {
    const existing = await getJSON(`users/${existingAdminId}`);
    if (existing?.role === 'admin') return existing;
  }

  const usernameKey = `usernames/${adminUsername}`;
  let adminId = await store.get(usernameKey);
  if (adminId) {
    const existing = await getJSON(`users/${adminId}`);
    if (existing?.role !== 'admin') throw new Error(`Username administrator "${adminUsername}" sudah digunakan akun biasa.`);
    await store.set('meta/admin-id', existing.id);
    return existing;
  }

  adminId = 'usr_admin';
  const passwordHash = process.env.ADMIN_PASSWORD
    ? await hashPassword(process.env.ADMIN_PASSWORD)
    : DEFAULT_ADMIN_HASH;
  const admin = {
    id: adminId,
    username: adminUsername,
    email: '',
    role: 'admin',
    plan: 'admin',
    passwordHash,
    disabled: false,
    createdAt: now(),
    updatedAt: now(),
    lastLoginAt: null
  };
  const reserved = await store.set(usernameKey, adminId, { onlyIfNew: true });
  if (!reserved.modified) return ensureAdmin();
  await setJSON(`users/${adminId}`, admin);
  await store.set('meta/admin-id', adminId);
  await logActivity(adminId, 'admin_seeded', 'Akun administrator dibuat otomatis di penyimpanan Netlify.', {});
  return admin;
}

async function getSessionSecret() {
  let secret = await store.get('meta/session-secret');
  if (secret) return secret;
  const generated = crypto.randomBytes(48).toString('base64url');
  const result = await store.set('meta/session-secret', generated, { onlyIfNew: true });
  if (result.modified) return generated;
  secret = await store.get('meta/session-secret');
  if (!secret) throw new Error('Gagal membuat session secret.');
  return secret;
}
function base64url(value) { return Buffer.from(value).toString('base64url'); }
async function signSession(user) {
  const secret = await getSessionSecret();
  const payload = base64url(JSON.stringify({ sub: user.id, role: user.role, exp: Date.now() + SESSION_MS }));
  const signature = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}
async function readSession(token) {
  if (!token || !token.includes('.')) return null;
  const [payload, signature] = token.split('.');
  const secret = await getSessionSecret();
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  const a = Buffer.from(signature || '');
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return data.exp && Date.now() <= data.exp ? data : null;
  } catch { return null; }
}
function sessionCookie(token) {
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.floor(SESSION_MS / 1000)}`;
}
function clearCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}
async function getUser(request) {
  const session = await readSession(parseCookies(request)[COOKIE_NAME]);
  if (!session?.sub) return null;
  const user = await getJSON(`users/${session.sub}`);
  return user && !user.disabled ? user : null;
}
async function requireUser(request) {
  const user = await getUser(request);
  if (!user) throw Object.assign(new Error('Silakan login terlebih dahulu.'), { status: 401 });
  return user;
}
async function requireAdmin(request) {
  const user = await requireUser(request);
  if (user.role !== 'admin') throw Object.assign(new Error('Akses administrator diperlukan.'), { status: 403 });
  return user;
}

async function logActivity(userId, type, detail, meta = {}) {
  const timestamp = Date.now();
  const activity = {
    id: uid('act_'),
    userId: userId || null,
    type: cleanText(type, 80),
    detail: cleanText(detail, 500),
    meta,
    createdAt: now()
  };
  await setJSON(`activity/${String(timestamp).padStart(13, '0')}-${activity.id}`, activity);
  return activity;
}
async function checkRate(request, context, action, windowMs, limit) {
  const key = `rates/${sha256(`${clientIp(request, context)}:${action}`)}`;
  const current = await getJSON(key);
  const timestamp = Date.now();
  const next = !current || timestamp > current.resetAt
    ? { count: 1, resetAt: timestamp + windowMs }
    : { count: Number(current.count || 0) + 1, resetAt: current.resetAt };
  await setJSON(key, next);
  return next.count <= limit;
}

async function getAllJobs() {
  const jobs = await listJSON('jobs/', 5000);
  return jobs.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}
async function getUserJobs(userId) {
  const jobs = await listJSON(`jobs/${userId}/`, 1000);
  return jobs.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}
async function quotaInfo(user, suppliedJobs = null) {
  if (user.role === 'admin' || user.plan === 'pro') {
    return { plan: user.plan, limit: null, used: 0, remaining: null, nextResetAt: null, unlimited: true };
  }
  const jobs = suppliedJobs || await getUserJobs(user.id);
  const cutoff = Date.now() - FOUR_DAYS_MS;
  const recent = jobs
    .filter(job => new Date(job.createdAt).getTime() > cutoff && !['failed', 'cancelled'].includes(job.status))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const last = recent[0];
  return {
    plan: 'free',
    limit: 1,
    used: recent.length ? 1 : 0,
    remaining: recent.length ? 0 : 1,
    nextResetAt: last ? new Date(new Date(last.createdAt).getTime() + FOUR_DAYS_MS).toISOString() : null,
    unlimited: false
  };
}
async function saveJob(job) {
  const key = job.storageKey || await store.get(`jobids/${job.id}`);
  if (!key) throw Object.assign(new Error('Job tidak ditemukan.'), { status: 404 });
  const clean = { ...job };
  delete clean.storageKey;
  await setJSON(key, clean);
  return clean;
}
async function getJob(id) {
  const key = await store.get(`jobids/${id}`);
  if (!key) return null;
  const job = await getJSON(key);
  return job ? { ...job, storageKey: key } : null;
}
async function markStaleJobs(jobs) {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  const updates = [];
  for (const job of jobs) {
    if (['queued', 'processing'].includes(job.status) && new Date(job.updatedAt || job.createdAt).getTime() < cutoff) {
      job.status = 'failed';
      job.finishedAt ||= now();
      job.updatedAt = now();
      job.logs ||= [];
      job.logs.push(`[${new Date().toLocaleTimeString('id-ID')}] Job ditutup otomatis karena tidak ada update selama 2 jam.`);
      updates.push(saveJob(job));
    }
  }
  await Promise.all(updates);
}

async function register(request, context) {
  if (!(await checkRate(request, context, 'register', 10 * 60 * 1000, 10))) return json(429, { error: 'Terlalu banyak permintaan. Coba lagi sebentar.' });
  const body = await bodyJson(request);
  const username = cleanText(body.username, 32).toLowerCase();
  const email = cleanText(body.email, 120).toLowerCase();
  const password = String(body.password || '');
  if (!/^[a-z0-9_]{3,32}$/.test(username)) return json(400, { error: 'Username 3–32 karakter dan hanya boleh huruf kecil, angka, atau underscore.' });
  if (email && !/^\S+@\S+\.\S+$/.test(email)) return json(400, { error: 'Format email tidak valid.' });
  if (password.length < 8 || password.length > 128) return json(400, { error: 'Password minimal 8 karakter.' });

  const usernameKey = `usernames/${username}`;
  if (await store.get(usernameKey)) return json(409, { error: 'Username sudah dipakai.' });
  const emailKey = email ? `emails/${sha256(email)}` : null;
  if (emailKey && await store.get(emailKey)) return json(409, { error: 'Email sudah dipakai.' });

  const user = {
    id: uid('usr_'), username, email, role: 'user', plan: 'free',
    passwordHash: await hashPassword(password), disabled: false,
    createdAt: now(), updatedAt: now(), lastLoginAt: null
  };
  const usernameReservation = await store.set(usernameKey, user.id, { onlyIfNew: true });
  if (!usernameReservation.modified) return json(409, { error: 'Username sudah dipakai.' });
  if (emailKey) {
    const emailReservation = await store.set(emailKey, user.id, { onlyIfNew: true });
    if (!emailReservation.modified) {
      await store.delete(usernameKey);
      return json(409, { error: 'Email sudah dipakai.' });
    }
  }
  try {
    await setJSON(`users/${user.id}`, user, { onlyIfNew: true });
  } catch (error) {
    await store.delete(usernameKey);
    if (emailKey) await store.delete(emailKey);
    throw error;
  }
  await logActivity(user.id, 'register', `User ${username} mendaftar.`, {});
  const token = await signSession(user);
  return json(201, { user: safeUser(user), quota: await quotaInfo(user, []) }, { 'Set-Cookie': sessionCookie(token) });
}

async function login(request, context) {
  if (!(await checkRate(request, context, 'login', 10 * 60 * 1000, 20))) return json(429, { error: 'Terlalu banyak percobaan login. Coba lagi sebentar.' });
  const body = await bodyJson(request);
  const identity = cleanText(body.username, 120).toLowerCase();
  const password = String(body.password || '');
  let userId = null;
  if (identity.includes('@')) userId = await store.get(`emails/${sha256(identity)}`);
  else userId = await store.get(`usernames/${identity}`);
  const user = userId ? await getJSON(`users/${userId}`) : null;
  if (!user || user.disabled || !(await verifyPassword(password, user.passwordHash))) {
    await logActivity(user?.id || null, 'login_failed', `Login gagal untuk ${identity || 'unknown'}.`, { ip: clientIp(request, context) });
    return json(401, { error: 'Username/email atau password salah.' });
  }
  user.lastLoginAt = now();
  user.updatedAt = now();
  await setJSON(`users/${user.id}`, user);
  await logActivity(user.id, 'login', `User ${user.username} login.`, { ip: clientIp(request, context) });
  const token = await signSession(user);
  return json(200, { user: safeUser(user), quota: await quotaInfo(user) }, { 'Set-Cookie': sessionCookie(token) });
}

async function handle(request, context) {
  if (!validOrigin(request)) return json(403, { error: 'Origin tidak valid.' });
  const pathname = normalizedPath(request);
  const method = request.method.toUpperCase();

  if (method === 'GET' && pathname === '/api/health') {
    return json(200, { ok: true, service: 'ConvertTexture Netlify API', storage: 'Netlify Blobs', time: now() });
  }

  await ensureAdmin();

  if (method === 'POST' && pathname === '/api/auth/register') return register(request, context);
  if (method === 'POST' && pathname === '/api/auth/login') return login(request, context);

  if (method === 'GET' && pathname === '/api/auth/me') {
    const user = await requireUser(request);
    return json(200, { user: safeUser(user), quota: await quotaInfo(user) });
  }
  if (method === 'POST' && pathname === '/api/auth/logout') {
    const user = await requireUser(request);
    await logActivity(user.id, 'logout', `User ${user.username} logout.`, {});
    return json(200, { ok: true }, { 'Set-Cookie': clearCookie() });
  }
  if (method === 'POST' && pathname === '/api/auth/change-password') {
    const user = await requireUser(request);
    if (!(await checkRate(request, context, 'password', 10 * 60 * 1000, 8))) return json(429, { error: 'Terlalu banyak permintaan.' });
    const body = await bodyJson(request);
    const current = String(body.currentPassword || '');
    const nextPassword = String(body.newPassword || '');
    if (!(await verifyPassword(current, user.passwordHash))) return json(400, { error: 'Password lama salah.' });
    if (nextPassword.length < 8 || nextPassword.length > 128) return json(400, { error: 'Password baru minimal 8 karakter.' });
    user.passwordHash = await hashPassword(nextPassword);
    user.updatedAt = now();
    await setJSON(`users/${user.id}`, user);
    await logActivity(user.id, 'password_changed', 'Password akun diubah.', {});
    return json(200, { ok: true });
  }
  if (method === 'GET' && pathname === '/api/quota') {
    const user = await requireUser(request);
    return json(200, await quotaInfo(user));
  }

  if (method === 'POST' && pathname === '/api/jobs') {
    const user = await requireUser(request);
    if (!(await checkRate(request, context, 'create-job', 60 * 1000, 12))) return json(429, { error: 'Terlalu banyak permintaan.' });
    const body = await bodyJson(request);
    const tool = cleanText(body.tool, 32);
    if (!['version', 'optimize', 'bedrock'].includes(tool)) return json(400, { error: 'Jenis tool tidak valid.' });
    const jobs = await getUserJobs(user.id);
    await markStaleJobs(jobs);
    const active = jobs.find(job => ['queued', 'processing'].includes(job.status));
    if (active) return json(409, { error: 'Masih ada proses aktif. Tunggu sampai selesai.', activeJobId: active.id });
    const quota = await quotaInfo(user, jobs);
    if (!quota.unlimited && quota.remaining <= 0) return json(429, { error: 'Kuota Free sudah habis. Maksimal 1 proses setiap 4 hari.', quota });

    const createdMs = Date.now();
    const job = {
      id: uid('job_'), userId: user.id, username: user.username, tool,
      filename: cleanText(body.filename, 180) || 'resource-pack.zip',
      originalSize: Math.max(0, Number(body.originalSize || 0)), outputSize: 0,
      savedPercent: 0, status: 'processing', progress: 1,
      logs: [`[${new Date().toLocaleTimeString('id-ID')}] Job dibuat dan browser memulai proses.`],
      resultName: '', createdAt: now(), updatedAt: now(), finishedAt: null
    };
    const storageKey = `jobs/${user.id}/${String(createdMs).padStart(13, '0')}-${job.id}`;
    await setJSON(storageKey, job, { onlyIfNew: true });
    await store.set(`jobids/${job.id}`, storageKey, { onlyIfNew: true });
    await logActivity(user.id, 'job_started', `${user.username} memulai ${tool}: ${job.filename}.`, { jobId: job.id });
    return json(201, { job });
  }

  const jobPatch = pathname.match(/^\/api\/jobs\/([^/]+)$/);
  if (method === 'PATCH' && jobPatch) {
    const user = await requireUser(request);
    if (!(await checkRate(request, context, 'patch-job', 60 * 1000, 180))) return json(429, { error: 'Terlalu banyak update job.' });
    const job = await getJob(jobPatch[1]);
    if (!job) return json(404, { error: 'Job tidak ditemukan.' });
    if (job.userId !== user.id && user.role !== 'admin') return json(403, { error: 'Tidak boleh mengubah job ini.' });
    const body = await bodyJson(request);
    if (['queued', 'processing', 'complete', 'failed', 'cancelled'].includes(body.status)) job.status = body.status;
    if (Number.isFinite(Number(body.progress))) job.progress = Math.max(0, Math.min(100, Number(body.progress)));
    if (Number.isFinite(Number(body.outputSize))) job.outputSize = Math.max(0, Number(body.outputSize));
    if (Number.isFinite(Number(body.savedPercent))) job.savedPercent = Number(body.savedPercent);
    if (body.resultName) job.resultName = cleanText(body.resultName, 180);
    if (Array.isArray(body.logs)) {
      job.logs ||= [];
      job.logs.push(...body.logs.map(line => cleanText(line, 700)).filter(Boolean).slice(-50));
      job.logs = job.logs.slice(-250);
    }
    job.updatedAt = now();
    if (['complete', 'failed', 'cancelled'].includes(job.status) && !job.finishedAt) {
      job.finishedAt = now();
      await logActivity(user.id, `job_${job.status}`, `${job.filename} berstatus ${job.status}.`, { jobId: job.id, tool: job.tool });
    }
    const savedJob = await saveJob(job);
    return json(200, { job: savedJob, quota: await quotaInfo(user) });
  }

  if (method === 'GET' && pathname === '/api/jobs') {
    const user = await requireUser(request);
    const jobs = await getUserJobs(user.id);
    await markStaleJobs(jobs);
    return json(200, { jobs: jobs.slice(0, 100) });
  }

  if (method === 'GET' && pathname === '/api/admin/overview') {
    await requireAdmin(request);
    const [jobs, users, activity] = await Promise.all([
      getAllJobs(),
      listJSON('users/', 5000),
      listJSON('activity/', 3000)
    ]);
    await markStaleJobs(jobs);
    activity.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    const counts = jobs.reduce((acc, job) => {
      acc.total += 1;
      acc[job.status] = (acc[job.status] || 0) + 1;
      return acc;
    }, { total: 0, queued: 0, processing: 0, complete: 0, failed: 0, cancelled: 0 });
    return json(200, { counts, users: users.length, recentJobs: jobs.slice(0, 100), activity: activity.slice(0, 100) });
  }

  if (method === 'GET' && pathname === '/api/admin/users') {
    await requireAdmin(request);
    const users = await listJSON('users/', 5000);
    const results = await Promise.all(users.map(async user => ({
      ...safeUser(user),
      quota: await quotaInfo(user),
      lastLoginAt: user.lastLoginAt || null
    })));
    results.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return json(200, { users: results });
  }

  const adminUser = pathname.match(/^\/api\/admin\/users\/([^/]+)$/);
  if (method === 'PATCH' && adminUser) {
    const admin = await requireAdmin(request);
    const user = await getJSON(`users/${adminUser[1]}`);
    if (!user) return json(404, { error: 'User tidak ditemukan.' });
    if (user.role === 'admin' && user.id !== admin.id) return json(400, { error: 'Akun administrator lain tidak boleh diubah dari sini.' });
    const body = await bodyJson(request);
    if (user.role !== 'admin' && ['free', 'pro'].includes(body.plan)) user.plan = body.plan;
    if (typeof body.disabled === 'boolean' && user.id !== admin.id) user.disabled = body.disabled;
    user.updatedAt = now();
    await setJSON(`users/${user.id}`, user);
    await logActivity(admin.id, 'user_updated', `Admin mengubah ${user.username}.`, { targetUserId: user.id, plan: user.plan, disabled: user.disabled });
    return json(200, { user: safeUser(user), quota: await quotaInfo(user) });
  }

  const resetQuota = pathname.match(/^\/api\/admin\/users\/([^/]+)\/reset-quota$/);
  if (method === 'POST' && resetQuota) {
    const admin = await requireAdmin(request);
    const user = await getJSON(`users/${resetQuota[1]}`);
    if (!user) return json(404, { error: 'User tidak ditemukan.' });
    const jobs = await getUserJobs(user.id);
    const cutoff = Date.now() - FOUR_DAYS_MS;
    let changed = 0;
    for (const job of jobs) {
      if (new Date(job.createdAt).getTime() > cutoff && !['failed', 'cancelled'].includes(job.status)) {
        job.status = 'cancelled';
        job.logs ||= [];
        job.logs.push(`[${new Date().toLocaleTimeString('id-ID')}] Kuota di-reset oleh administrator.`);
        job.finishedAt ||= now();
        job.updatedAt = now();
        await saveJob(job);
        changed += 1;
      }
    }
    await logActivity(admin.id, 'quota_reset', `Kuota ${user.username} di-reset.`, { targetUserId: user.id, changed });
    return json(200, { ok: true, changed, quota: await quotaInfo(user) });
  }

  return json(404, { error: 'API endpoint tidak ditemukan.' });
}

export default async function handler(request, context) {
  store ||= getStore({ name: STORE_NAME, consistency: 'strong' });
  try {
    return await handle(request, context);
  } catch (error) {
    console.error('ConvertTexture API error:', error);
    const status = Number(error?.status || 500);
    return json(status, { error: status >= 500 ? 'Terjadi kesalahan di server.' : error.message });
  }
}
