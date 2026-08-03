(() => {
  'use strict';

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const state = {
    user: null, quota: null, jobs: [], adminOverview: null, adminUsers: [],
    files: { version: null, optimize: null, bedrock: null },
    results: { version: null, optimize: null, bedrock: null },
    authMode: 'login', activeView: 'dashboard', queueTimer: null, optimizePreset: 'medium'
  };
  const viewTitles = { dashboard: 'Dashboard', version: 'Version Converter', optimize: 'Optimize Tools', bedrock: 'Bedrock Converter', queue: 'Queue Monitor', history: 'My History', admin: 'Admin Dashboard' };
  const whatsappUrl = 'https://wa.me/628383028712?text=' + encodeURIComponent('Halo admin ConvertTexture, saya ingin upgrade plan dari Free ke Pro.');
  const optimizePresets = {
    low: {
      label: 'LOW · Potato / Zalith', description: 'Texture oversized maksimal 128px, palette agresif, custom shader dibuang. Font, glyph, GUI, atlas, dan animasi tetap aman.',
      removeUnused: false, deduplicate: true, stripShaders: true, minifyJson: true, removeSourceFiles: true,
      power2: false, downscale: true, maxDimension: 128, lossy: true, quality: 'low', reencode: true
    },
    medium: {
      label: 'MEDIUM · Balanced', description: 'Texture oversized maksimal 256px dengan kompresi seimbang. Cocok untuk mayoritas HP dan launcher mobile.',
      removeUnused: false, deduplicate: true, stripShaders: false, minifyJson: true, removeSourceFiles: true,
      power2: false, downscale: true, maxDimension: 256, lossy: true, quality: 'medium', reencode: true
    },
    high: {
      label: 'HIGH · High quality', description: 'Texture oversized maksimal 512px dan palette ringan. Visual lebih tajam dengan penghematan yang tetap aman.',
      removeUnused: false, deduplicate: true, stripShaders: false, minifyJson: true, removeSourceFiles: true,
      power2: false, downscale: true, maxDimension: 512, lossy: true, quality: 'high', reencode: true
    }
  };

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
  }
  function formatDate(value) {
    if (!value) return '—';
    return new Intl.DateTimeFormat('id-ID', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
  }
  function formatTool(tool) {
    return ({ version: 'Version Converter', optimize: 'Optimize Tools', bedrock: 'Bedrock Converter' })[tool] || tool;
  }
  function statusLabel(status) {
    return ({ processing: 'Active', queued: 'Queued', complete: 'Complete', failed: 'Failed', cancelled: 'Cancelled' })[status] || status;
  }
  function applyOptimizePreset(name) {
    const preset = optimizePresets[name];
    if (!preset) return;
    state.optimizePreset = name;
    const values = {
      '#optRemoveUnused': preset.removeUnused, '#optDedup': preset.deduplicate, '#optShaders': preset.stripShaders,
      '#optMinify': preset.minifyJson, '#optSourceFiles': preset.removeSourceFiles, '#optPower2': preset.power2,
      '#optDownscale': preset.downscale, '#optLossy': preset.lossy, '#optReencode': preset.reencode
    };
    Object.entries(values).forEach(([selector, value]) => { const element = $(selector); if (element) element.checked = value; });
    if ($('#optMaxDimension')) $('#optMaxDimension').value = String(preset.maxDimension);
    if ($('#optQuality')) $('#optQuality').value = preset.quality;
    $$('[data-opt-preset]').forEach(button => {
      const active = button.dataset.optPreset === name;
      button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active));
    });
    if ($('#optPresetSummary')) $('#optPresetSummary').innerHTML = `<strong>${escapeHtml(preset.label)}</strong><span>${escapeHtml(preset.description)}</span>`;
  }

  function markOptimizeCustom() {
    if (!state.optimizePreset) return;
    state.optimizePreset = 'custom';
    $$('[data-opt-preset]').forEach(button => { button.classList.remove('active'); button.setAttribute('aria-pressed', 'false'); });
    if ($('#optPresetSummary')) $('#optPresetSummary').innerHTML = '<strong>CUSTOM · Manual settings</strong><span>Pengaturan preset sudah diubah manual. Font, glyph, GUI, atlas, dan animasi tetap dilindungi oleh engine.</span>';
  }

  function toast(title, message = '', type = '') {
    const element = document.createElement('div');
    element.className = `toast ${type}`;
    element.innerHTML = `<strong>${escapeHtml(title)}</strong>${message ? `<p>${escapeHtml(message)}</p>` : ''}`;
    $('#toastStack').appendChild(element);
    setTimeout(() => element.remove(), 4200);
  }
  function openModal(id) { const el = $(id); el.classList.add('open'); el.setAttribute('aria-hidden', 'false'); }
  function closeModal(id) { const el = $(id); el.classList.remove('open'); el.setAttribute('aria-hidden', 'true'); }

  async function api(path, options = {}) {
    const response = await fetch(path, {
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      ...options,
      body: options.body && typeof options.body !== 'string' ? JSON.stringify(options.body) : options.body
    });
    let data = {};
    try { data = await response.json(); } catch {}
    if (!response.ok) {
      const error = new Error(data.error || `Request failed (${response.status})`);
      error.status = response.status;
      error.data = data;
      throw error;
    }
    return data;
  }

  function setAuthMode(mode) {
    state.authMode = mode;
    const login = mode === 'login';
    $('#loginForm').classList.toggle('hidden', !login);
    $('#registerForm').classList.toggle('hidden', login);
    $('#authTitle').textContent = login ? 'Masuk ke workspace' : 'Buat akun Free';
    $('#authSubtitle').textContent = login ? 'Kelola konversi, optimasi, kuota, dan riwayat proses dari satu dashboard.' : 'Daftar untuk mendapatkan 1 proses gratis setiap 4 hari.';
    $('#authSwitch').innerHTML = login ? 'Belum punya akun? <b>Daftar</b>' : 'Sudah punya akun? <b>Masuk</b>';
  }

  function applySession(data) {
    state.user = data.user;
    state.quota = data.quota;
    $('#authScreen').classList.add('hidden');
    $('#appShell').classList.remove('hidden');
    const initial = location.hash.replace('#', '');
    setView(viewTitles[initial] ? initial : 'dashboard', false);
    updateAccountUi();
    refreshAll();
    startPolling();
  }

  function clearSession() {
    state.user = null; state.quota = null; state.jobs = [];
    clearInterval(state.queueTimer); state.queueTimer = null;
    $('#appShell').classList.add('hidden');
    $('#authScreen').classList.remove('hidden');
    closeModal('#accountModal');
    setAuthMode('login');
  }

  async function bootstrap() {
    $('#whatsappLink').href = whatsappUrl;
    try { applySession(await api('/api/auth/me')); }
    catch { clearSession(); }
  }

  function setView(name, updateHash = true) {
    if (!viewTitles[name]) return;
    if (name === 'admin' && state.user?.role !== 'admin') name = 'dashboard';
    state.activeView = name;
    $$('.view').forEach(view => view.classList.toggle('active', view.dataset.viewPanel === name));
    $$('.nav-item[data-view]').forEach(item => item.classList.toggle('active', item.dataset.view === name));
    $('#sidebar').classList.remove('open'); $('#sidebarBackdrop').classList.remove('open');
    document.title = `${viewTitles[name]} · ConvertTexture`;
    if (updateHash) history.replaceState(null, '', `#${name}`);
    window.scrollTo({ top: 0, behavior: 'smooth' });
    if (name === 'queue') loadQueue();
    if (name === 'history') loadJobs();
    if (name === 'admin') loadAdmin();
  }

  function updateAccountUi() {
    if (!state.user) return;
    const initial = state.user.username.slice(0, 1).toUpperCase();
    ['#sidebarAvatar', '#topAvatar', '#modalAvatar'].forEach(id => $(id).textContent = initial);
    $('#sidebarUsername').textContent = state.user.username;
    $('#sidebarPlan').textContent = `${state.user.plan.toUpperCase()} PLAN`;
    $('#modalUsername').textContent = state.user.username;
    $('#modalEmail').textContent = state.user.email || 'No email provided';
    $('#modalPlan').textContent = state.user.role === 'admin' ? 'ADMINISTRATOR' : `${state.user.plan.toUpperCase()} TIER`;
    $('#adminNav').classList.toggle('hidden', state.user.role !== 'admin');
    const quota = state.quota || {};
    if (quota.unlimited) {
      $('#quotaChip').textContent = 'Unlimited plan';
      $('#modalQuotaValue').textContent = '∞';
      $('#modalQuotaBar').style.width = '100%';
      $('#modalQuotaText').textContent = 'Tidak ada batas penggunaan';
    } else {
      $('#quotaChip').textContent = `Free · ${quota.remaining ?? 0}/1 tersisa`;
      $('#modalQuotaValue').textContent = `${quota.used || 0} / 1`;
      $('#modalQuotaBar').style.width = `${quota.used ? 100 : 0}%`;
      $('#modalQuotaText').textContent = quota.nextResetAt ? `Reset ${formatDate(quota.nextResetAt)}` : 'Maksimal 1 proses setiap 4 hari';
    }
  }

  async function refreshAll() {
    await Promise.allSettled([loadJobs(), refreshMe()]);
    if (state.user?.role === 'admin') await loadAdmin(false);
  }
  async function refreshMe() {
    try {
      const data = await api('/api/auth/me');
      state.user = data.user; state.quota = data.quota; updateAccountUi();
    } catch (error) { if (error.status === 401) clearSession(); }
  }
  function startPolling() {
    clearInterval(state.queueTimer);
    state.queueTimer = setInterval(() => {
      if (!state.user) return;
      if (state.activeView === 'queue') loadQueue(false);
      else if (state.activeView === 'admin' && state.user.role === 'admin') loadAdmin(false);
      else refreshMe();
    }, 7000);
  }

  async function loadJobs(showError = true) {
    try {
      const data = await api('/api/jobs');
      state.jobs = data.jobs || [];
      renderDashboard(); renderHistory();
      if (state.user?.role !== 'admin') renderQueue(state.jobs);
    } catch (error) { if (showError) toast('Gagal memuat jobs', error.message, 'error'); }
  }

  function renderDashboard() {
    const jobs = state.jobs;
    const complete = jobs.filter(job => job.status === 'complete');
    const saved = complete.filter(job => job.tool === 'optimize').reduce((sum, job) => sum + Math.max(0, Number(job.originalSize || 0) - Number(job.outputSize || 0)), 0);
    $('#metricTotal').textContent = jobs.length;
    $('#metricDone').textContent = complete.length;
    $('#metricSaved').textContent = TextureTools.formatBytes(saved);
    if (state.quota?.unlimited) {
      $('#metricQuota').textContent = '∞'; $('#metricQuotaNote').textContent = 'Unlimited plan';
    } else {
      $('#metricQuota').textContent = state.quota?.remaining ?? 0;
      $('#metricQuotaNote').textContent = state.quota?.nextResetAt ? `Reset ${formatDate(state.quota.nextResetAt)}` : 'Tersisa pada periode ini';
    }
    const root = $('#recentJobs');
    const recent = jobs.slice(0, 5);
    root.classList.toggle('empty-box', !recent.length);
    root.innerHTML = recent.length ? recent.map(jobMiniHtml).join('') : 'Belum ada aktivitas.';
    $('#queueBadge').textContent = jobs.filter(job => ['processing', 'queued'].includes(job.status)).length;
  }

  function jobMiniHtml(job) {
    const icon = job.status === 'complete' ? '✓' : job.status === 'failed' ? '!' : 'ϟ';
    const stateClass = job.status === 'failed' ? 'error' : job.status === 'processing' ? 'running' : '';
    return `<div class="job-mini"><span class="state-icon">${icon}</span><div><strong>${escapeHtml(job.filename)}</strong><small>${escapeHtml(formatTool(job.tool))} · ${escapeHtml(formatDate(job.createdAt))}</small></div><span class="status-tag ${stateClass}">${escapeHtml(statusLabel(job.status))}</span></div>`;
  }

  function renderHistory() {
    const root = $('#historyList');
    if (!state.jobs.length) { root.className = 'table-wrap empty-box'; root.innerHTML = 'Belum ada history.'; return; }
    root.className = 'table-wrap';
    root.innerHTML = `<table class="data-table"><thead><tr><th>FILE</th><th>TOOL</th><th>STATUS</th><th>ORIGINAL</th><th>OUTPUT</th><th>DATE</th></tr></thead><tbody>${state.jobs.map(job => `<tr><td><strong>${escapeHtml(job.filename)}</strong></td><td>${escapeHtml(formatTool(job.tool))}</td><td><span class="status-tag ${job.status === 'failed' ? 'error' : job.status === 'processing' ? 'running' : ''}">${escapeHtml(statusLabel(job.status))}</span></td><td>${TextureTools.formatBytes(job.originalSize)}</td><td>${TextureTools.formatBytes(job.outputSize)}</td><td>${escapeHtml(formatDate(job.createdAt))}</td></tr>`).join('')}</tbody></table>`;
  }

  async function loadQueue(showError = true) {
    try {
      if (state.user?.role === 'admin') {
        const data = await api('/api/admin/overview');
        state.adminOverview = data;
        renderQueue(data.recentJobs || [], true);
      } else {
        const data = await api('/api/jobs'); state.jobs = data.jobs || []; renderQueue(state.jobs, false); renderDashboard();
      }
    } catch (error) { if (showError) toast('Gagal refresh queue', error.message, 'error'); }
  }

  function renderQueue(jobs, adminMode = false) {
    const counts = {
      total: jobs.length,
      active: jobs.filter(job => job.status === 'processing').length,
      queued: jobs.filter(job => job.status === 'queued').length,
      done: jobs.filter(job => job.status === 'complete').length
    };
    $('#queueTotal').textContent = counts.total; $('#queueActive').textContent = counts.active; $('#queueQueued').textContent = counts.queued; $('#queueDone').textContent = counts.done;
    $('#queueCountTag').textContent = `${counts.total} tasks`;
    $('#queueSubtitle').textContent = adminMode ? 'Semua aktivitas user dan status pemrosesannya.' : 'Semua proses akunmu dan status pemrosesannya.';
    const root = $('#queueList');
    root.classList.toggle('empty-box', !jobs.length);
    root.innerHTML = jobs.length ? jobs.map(job => {
      const complete = job.status === 'complete'; const failed = job.status === 'failed';
      const icon = complete ? '✓' : failed ? '!' : 'ϟ';
      const saved = Number(job.savedPercent || 0);
      return `<article class="queue-card"><div class="queue-summary"><span class="state-icon ${failed ? 'failed' : job.status === 'processing' ? 'processing' : ''}">${icon}</span><div><strong>${escapeHtml(job.filename)}</strong><small>${adminMode ? `${escapeHtml(job.username)} · ` : ''}${escapeHtml(formatTool(job.tool))} · ${escapeHtml(formatDate(job.createdAt))}</small></div><span class="status-tag ${failed ? 'error' : job.status === 'processing' ? 'running' : ''}">${escapeHtml(statusLabel(job.status))}</span><span class="queue-meta">${Math.round(Number(job.progress || 0))}%<br>${TextureTools.formatBytes(job.outputSize || job.originalSize)}</span></div><div class="queue-details"><div class="queue-stats"><div><small>ORIGINAL</small><strong>${TextureTools.formatBytes(job.originalSize)}</strong></div><div><small>OUTPUT</small><strong>${TextureTools.formatBytes(job.outputSize)}</strong></div><div><small>SAVED</small><strong>${Number.isFinite(saved) ? `${saved}%` : '—'}</strong></div></div><pre class="queue-log">${escapeHtml((job.logs || []).join('\n'))}</pre></div></article>`;
    }).join('') : 'Belum ada task.';
    $$('.queue-card', root).forEach(card => $('.queue-summary', card).addEventListener('click', () => card.classList.toggle('open')));
    $('#queueBadge').textContent = counts.active + counts.queued;
  }

  async function loadAdmin(showError = true) {
    if (state.user?.role !== 'admin') return;
    try {
      const [overview, users] = await Promise.all([api('/api/admin/overview'), api('/api/admin/users')]);
      state.adminOverview = overview; state.adminUsers = users.users || [];
      $('#adminUsersCount').textContent = overview.users || 0;
      $('#adminJobsCount').textContent = overview.counts?.total || 0;
      $('#adminDoneCount').textContent = overview.counts?.complete || 0;
      $('#adminFailedCount').textContent = overview.counts?.failed || 0;
      renderAdminUsers(); renderAdminActivity();
      if (state.activeView === 'queue') renderQueue(overview.recentJobs || [], true);
    } catch (error) { if (showError) toast('Gagal memuat admin dashboard', error.message, 'error'); }
  }

  function renderAdminUsers() {
    const root = $('#adminUsers');
    root.innerHTML = `<table class="data-table"><thead><tr><th>USER</th><th>ROLE</th><th>PLAN</th><th>QUOTA</th><th>LAST LOGIN</th><th>ACTION</th></tr></thead><tbody>${state.adminUsers.map(user => `<tr data-user-id="${escapeHtml(user.id)}"><td><strong>${escapeHtml(user.username)}</strong><br><span class="muted">${escapeHtml(user.email || 'No email')}</span></td><td>${escapeHtml(user.role)}</td><td><select class="plan-select" data-plan ${user.role === 'admin' ? 'disabled' : ''}><option value="free" ${user.plan === 'free' ? 'selected' : ''}>Free</option><option value="pro" ${user.plan === 'pro' ? 'selected' : ''}>Pro</option></select></td><td>${user.quota?.unlimited ? 'Unlimited' : `${user.quota?.used || 0}/1`}</td><td>${escapeHtml(formatDate(user.lastLoginAt))}</td><td><button class="table-action" data-reset-quota ${user.role === 'admin' ? 'disabled' : ''}>Reset quota</button> <button class="table-action danger" data-disable ${user.role === 'admin' ? 'disabled' : ''}>${user.disabled ? 'Enable' : 'Disable'}</button></td></tr>`).join('')}</tbody></table>`;
    $$('[data-plan]', root).forEach(select => select.addEventListener('change', async () => {
      const row = select.closest('[data-user-id]');
      try { await api(`/api/admin/users/${row.dataset.userId}`, { method: 'PATCH', body: { plan: select.value } }); toast('Plan diperbarui'); await loadAdmin(false); }
      catch (error) { toast('Gagal update plan', error.message, 'error'); }
    }));
    $$('[data-reset-quota]', root).forEach(button => button.addEventListener('click', async () => {
      const row = button.closest('[data-user-id]');
      try { await api(`/api/admin/users/${row.dataset.userId}/reset-quota`, { method: 'POST', body: {} }); toast('Kuota di-reset'); await loadAdmin(false); }
      catch (error) { toast('Gagal reset quota', error.message, 'error'); }
    }));
    $$('[data-disable]', root).forEach(button => button.addEventListener('click', async () => {
      const row = button.closest('[data-user-id]'); const user = state.adminUsers.find(item => item.id === row.dataset.userId);
      try { await api(`/api/admin/users/${row.dataset.userId}`, { method: 'PATCH', body: { disabled: !user.disabled } }); toast('Status akun diperbarui'); await loadAdmin(false); }
      catch (error) { toast('Gagal update akun', error.message, 'error'); }
    }));
  }

  function renderAdminActivity() {
    const root = $('#adminActivity'); const activity = state.adminOverview?.activity || [];
    root.innerHTML = activity.length ? activity.map(item => `<div class="activity-row"><span>•</span><div><strong>${escapeHtml(item.type)}</strong><p>${escapeHtml(item.detail)}</p></div><time>${escapeHtml(formatDate(item.createdAt))}</time></div>`).join('') : '<div class="empty-box">Belum ada activity log.</div>';
  }

  function bindDropzone(type, zoneId, inputId, cardId, runId) {
    const zone = $(zoneId); const input = $(inputId); const card = $(cardId); const run = $(runId);
    const choose = () => input.click();
    zone.addEventListener('click', event => { if (!event.target.closest('button') || event.target.closest('button')) choose(); });
    ['dragenter', 'dragover'].forEach(eventName => zone.addEventListener(eventName, event => { event.preventDefault(); zone.classList.add('dragging'); }));
    ['dragleave', 'drop'].forEach(eventName => zone.addEventListener(eventName, event => { event.preventDefault(); zone.classList.remove('dragging'); }));
    zone.addEventListener('drop', event => setToolFile(type, [...event.dataTransfer.files][0], card, run));
    input.addEventListener('change', () => { setToolFile(type, input.files[0], card, run); input.value = ''; });
  }

  function setToolFile(type, file, card, run) {
    if (!file) return;
    if (!/\.zip$/i.test(file.name)) { toast('File tidak didukung', 'Pilih resource pack dengan format .zip.', 'error'); return; }
    state.files[type] = file; state.results[type] = null;
    card.classList.remove('hidden');
    card.innerHTML = `<span class="file-icon">▤</span><div><strong>${escapeHtml(file.name)}</strong><small>${TextureTools.formatBytes(file.size)}</small></div><button type="button" aria-label="Hapus">×</button>`;
    $('button', card).addEventListener('click', () => { state.files[type] = null; card.classList.add('hidden'); card.innerHTML = ''; run.disabled = true; });
    run.disabled = false;
  }

  async function createJob(tool, file) {
    try { return (await api('/api/jobs', { method: 'POST', body: { tool, filename: file.name, originalSize: file.size } })).job; }
    catch (error) {
      if (error.status === 429) { state.quota = error.data?.quota || state.quota; updateAccountUi(); openModal('#upgradeModal'); }
      throw error;
    }
  }

  function createJobReporter(job, logElement, stateElement, progressElement = null) {
    let logs = []; let pending = []; let lastProgress = 0; let flushTimer = null;
    const flush = async (force = false) => {
      if (!pending.length && !force) return;
      const batch = pending.splice(0);
      try { await api(`/api/jobs/${job.id}`, { method: 'PATCH', body: { progress: lastProgress, logs: batch } }); }
      catch {}
    };
    const schedule = () => { if (flushTimer) return; flushTimer = setTimeout(async () => { flushTimer = null; await flush(); }, 900); };
    return {
      log(line) {
        const stamped = `[${new Date().toLocaleTimeString('id-ID')}] ${line}`;
        logs.push(stamped); pending.push(stamped); logElement.textContent = logs.join('\n'); logElement.scrollTop = logElement.scrollHeight; schedule();
      },
      progress(value) {
        lastProgress = Math.max(lastProgress, Math.min(100, Number(value || 0)));
        if (progressElement) progressElement.style.width = `${lastProgress}%`;
        stateElement.textContent = `${Math.round(lastProgress)}%`; stateElement.className = 'status-tag running'; schedule();
      },
      async finish(status, result = {}) {
        clearTimeout(flushTimer); flushTimer = null;
        await flush();
        const data = await api(`/api/jobs/${job.id}`, { method: 'PATCH', body: { status, progress: status === 'complete' ? 100 : lastProgress, outputSize: result.outputSize || 0, savedPercent: result.savedPercent || 0, resultName: result.resultName || '', logs: pending.splice(0) } });
        state.quota = data.quota || state.quota; updateAccountUi();
        await loadJobs(false);
      }
    };
  }

  function renderResult(type, result, file, rootId) {
    const root = $(rootId); const report = result.report || {};
    root.classList.remove('hidden');
    const summary = type === 'version'
      ? [`Format ${report.targetFormat}`, `${report.legacyConverted || 0} legacy`, `${report.modernConverted || 0} modern`]
      : type === 'optimize'
        ? [`${String(report.preset || 'custom').toUpperCase()} preset`, `${report.pngProcessed || 0} PNG`, `${Number(result.savedPercent || 0)}% saved`]
        : [`${report.textures || 0} textures`, `${report.legacy || 0} legacy`, `${report.modern || 0} modern`];
    root.innerHTML = `<h3>✓ Proses selesai</h3><p>${escapeHtml(result.filename)}</p><div class="result-grid">${summary.map((value, index) => `<span><small>${['OUTPUT','PROCESSED','MAPPINGS'][index]}</small><b>${escapeHtml(value)}</b></span>`).join('')}</div><button class="btn primary full" data-download>Download hasil</button>`;
    $('[data-download]', root).addEventListener('click', () => TextureTools.downloadBlob(result.blob, result.filename));
  }

  async function runVersion() {
    const file = state.files.version; if (!file) return;
    const button = $('#versionRun'); button.disabled = true; button.textContent = 'Converting...';
    $('#versionLogs').textContent = ''; $('#versionResult').classList.add('hidden');
    let job; let reporter;
    try {
      job = await createJob('version', file);
      reporter = createJobReporter(job, $('#versionLogs'), $('#versionState'));
      reporter.log('Memulai Version Converter...');
      const result = await TextureTools.convertVersion(file, { targetFormat: Number($('#versionTarget').value), keepLegacy: $('#versionBackup').checked, log: line => reporter.log(line), progress: value => reporter.progress(value) });
      state.results.version = result; renderResult('version', result, file, '#versionResult');
      $('#versionState').textContent = 'Complete'; $('#versionState').className = 'status-tag';
      await reporter.finish('complete', { outputSize: result.blob.size, savedPercent: file.size ? Math.round((1 - result.blob.size / file.size) * 1000) / 10 : 0, resultName: result.filename });
      toast('Version conversion selesai', result.filename);
    } catch (error) {
      $('#versionState').textContent = 'Failed'; $('#versionState').className = 'status-tag error';
      $('#versionLogs').textContent += `\nERROR: ${error.message}`;
      if (reporter) await reporter.finish('failed');
      if (error.status !== 429) toast('Konversi gagal', error.message, 'error');
    } finally { button.disabled = !state.files.version; button.textContent = 'Convert resource pack'; }
  }

  async function runOptimize() {
    const file = state.files.optimize; if (!file) return;
    const button = $('#optimizeRun'); button.disabled = true; button.textContent = 'Optimizing...';
    $('#optimizeLogs').textContent = ''; $('#optimizeResult').classList.add('hidden'); $('#optimizeProgress').style.width = '0%';
    let job; let reporter;
    try {
      job = await createJob('optimize', file);
      reporter = createJobReporter(job, $('#optimizeLogs'), $('#optimizeState'), $('#optimizeProgress'));
      reporter.log('Memulai Optimize Tools...');
      const result = await TextureTools.optimizePack(file, {
        preset: state.optimizePreset || 'custom', removeUnused: $('#optRemoveUnused').checked, deduplicate: $('#optDedup').checked, stripShaders: $('#optShaders').checked,
        minifyJson: $('#optMinify').checked, removeSourceFiles: $('#optSourceFiles').checked, power2: $('#optPower2').checked, downscale: $('#optDownscale').checked,
        maxDimension: Number($('#optMaxDimension').value), lossy: $('#optLossy').checked, quality: $('#optQuality').value,
        reencode: $('#optReencode').checked, log: line => reporter.log(line), progress: value => reporter.progress(value)
      });
      state.results.optimize = result; renderResult('optimize', result, file, '#optimizeResult');
      $('#optimizeState').textContent = 'Complete'; $('#optimizeState').className = 'status-tag';
      await reporter.finish('complete', { outputSize: result.blob.size, savedPercent: result.savedPercent, resultName: result.filename });
      toast('Optimasi selesai', `${TextureTools.formatBytes(file.size)} → ${TextureTools.formatBytes(result.blob.size)}`);
    } catch (error) {
      $('#optimizeState').textContent = 'Failed'; $('#optimizeState').className = 'status-tag error';
      $('#optimizeLogs').textContent += `\nERROR: ${error.message}`;
      if (reporter) await reporter.finish('failed');
      if (error.status !== 429) toast('Optimasi gagal', error.message, 'error');
    } finally { button.disabled = !state.files.optimize; button.textContent = 'Optimize resource pack'; }
  }

  async function runBedrock() {
    const file = state.files.bedrock; if (!file) return;
    const button = $('#bedrockRun'); button.disabled = true; button.textContent = 'Generating...';
    $('#bedrockLogs').textContent = ''; $('#bedrockResult').classList.add('hidden');
    let job; let reporter;
    try {
      job = await createJob('bedrock', file);
      reporter = createJobReporter(job, $('#bedrockLogs'), $('#bedrockState'));
      reporter.log('Memulai Bedrock & Geyser converter...');
      const namespace = $('#bedrockNamespace').value.trim();
      if (!/^[a-z0-9_.-]+$/.test(namespace)) throw new Error('Namespace hanya boleh huruf kecil, angka, underscore, titik, atau minus.');
      const result = await TextureTools.convertBedrock(file, {
        packName: $('#bedrockPackName').value, namespace, baseItem: $('#bedrockBaseItem').value.trim(), includeAll: $('#bedrockIncludeAll').checked,
        log: line => reporter.log(line), progress: value => reporter.progress(value)
      });
      state.results.bedrock = result; renderResult('bedrock', result, file, '#bedrockResult');
      $('#bedrockState').textContent = 'Complete'; $('#bedrockState').className = 'status-tag';
      await reporter.finish('complete', { outputSize: result.blob.size, savedPercent: 0, resultName: result.filename });
      toast('Bedrock bundle selesai', result.filename);
    } catch (error) {
      $('#bedrockState').textContent = 'Failed'; $('#bedrockState').className = 'status-tag error';
      $('#bedrockLogs').textContent += `\nERROR: ${error.message}`;
      if (reporter) await reporter.finish('failed');
      if (error.status !== 429) toast('Bedrock conversion gagal', error.message, 'error');
    } finally { button.disabled = !state.files.bedrock; button.textContent = 'Generate Bedrock bundle'; }
  }

  function bindEvents() {
    $('#authSwitch').addEventListener('click', () => setAuthMode(state.authMode === 'login' ? 'register' : 'login'));
    $('#loginForm').addEventListener('submit', async event => {
      event.preventDefault(); const button = $('button[type="submit"]', event.currentTarget); button.disabled = true;
      const form = new FormData(event.currentTarget);
      try { applySession(await api('/api/auth/login', { method: 'POST', body: Object.fromEntries(form) })); toast('Berhasil login'); }
      catch (error) { toast('Login gagal', error.message, 'error'); }
      finally { button.disabled = false; }
    });
    $('#registerForm').addEventListener('submit', async event => {
      event.preventDefault(); const button = $('button[type="submit"]', event.currentTarget); button.disabled = true;
      const form = new FormData(event.currentTarget);
      try { applySession(await api('/api/auth/register', { method: 'POST', body: Object.fromEntries(form) })); toast('Akun berhasil dibuat'); }
      catch (error) { toast('Registrasi gagal', error.message, 'error'); }
      finally { button.disabled = false; }
    });
    $$('.nav-item[data-view]').forEach(button => button.addEventListener('click', () => setView(button.dataset.view)));
    $$('[data-open-view]').forEach(button => button.addEventListener('click', () => setView(button.dataset.openView)));
    $('#menuButton').addEventListener('click', () => { $('#sidebar').classList.add('open'); $('#sidebarBackdrop').classList.add('open'); });
    $('#sidebarClose').addEventListener('click', () => { $('#sidebar').classList.remove('open'); $('#sidebarBackdrop').classList.remove('open'); });
    $('#sidebarBackdrop').addEventListener('click', () => { $('#sidebar').classList.remove('open'); $('#sidebarBackdrop').classList.remove('open'); });
    ['#accountButton', '#sidebarAccount'].forEach(id => $(id).addEventListener('click', () => openModal('#accountModal')));
    $$('[data-close-modal]').forEach(element => element.addEventListener('click', () => closeModal('#accountModal')));
    $$('[data-upgrade]').forEach(element => element.addEventListener('click', () => { closeModal('#accountModal'); openModal('#upgradeModal'); }));
    $$('[data-close-upgrade]').forEach(element => element.addEventListener('click', () => closeModal('#upgradeModal')));
    $('#openPassword').addEventListener('click', () => { closeModal('#accountModal'); openModal('#passwordModal'); });
    $$('[data-close-password]').forEach(element => element.addEventListener('click', () => closeModal('#passwordModal')));
    $('#passwordForm').addEventListener('submit', async event => {
      event.preventDefault(); const body = Object.fromEntries(new FormData(event.currentTarget));
      try { await api('/api/auth/change-password', { method: 'POST', body }); event.currentTarget.reset(); closeModal('#passwordModal'); toast('Password berhasil diubah'); }
      catch (error) { toast('Gagal mengganti password', error.message, 'error'); }
    });
    $('#signOut').addEventListener('click', async () => { try { await api('/api/auth/logout', { method: 'POST', body: {} }); } catch {} clearSession(); });
    $('#refreshButton').addEventListener('click', refreshAll); $('#queueRefresh').addEventListener('click', loadQueue); $('#historyRefresh').addEventListener('click', loadJobs); $('#adminRefresh').addEventListener('click', loadAdmin);
    $$('.admin-tabs button').forEach(button => button.addEventListener('click', () => { $$('.admin-tabs button').forEach(item => item.classList.toggle('active', item === button)); $$('.admin-tab').forEach(panel => panel.classList.toggle('active', panel.dataset.adminPanel === button.dataset.adminTab)); }));
    bindDropzone('version', '#versionDrop', '#versionFile', '#versionFileCard', '#versionRun');
    bindDropzone('optimize', '#optimizeDrop', '#optimizeFile', '#optimizeFileCard', '#optimizeRun');
    bindDropzone('bedrock', '#bedrockDrop', '#bedrockFile', '#bedrockFileCard', '#bedrockRun');
    $$('[data-opt-preset]').forEach(button => button.addEventListener('click', () => applyOptimizePreset(button.dataset.optPreset)));
    ['#optRemoveUnused','#optDedup','#optShaders','#optMinify','#optSourceFiles','#optPower2','#optDownscale','#optMaxDimension','#optLossy','#optQuality','#optReencode']
      .forEach(selector => $(selector)?.addEventListener('change', markOptimizeCustom));
    applyOptimizePreset('medium');
    $('#versionRun').addEventListener('click', runVersion); $('#optimizeRun').addEventListener('click', runOptimize); $('#bedrockRun').addEventListener('click', runBedrock);
    window.addEventListener('hashchange', () => setView(location.hash.replace('#', '') || 'dashboard', false));
  }

  bindEvents(); bootstrap();
})();
