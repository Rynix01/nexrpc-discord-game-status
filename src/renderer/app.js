const api = window.nexrpc;

let state = null;
let logs = [];
let currentPage = 'dashboard';
let editingProfileId = null;
let toastTimer = null;

const pageMeta = {
  dashboard: ['Dashboard', 'Discord hesaplarını ve aktif durumları yönet.'],
  accounts: ['Accounts', 'VDS üzerinde çalışacak Discord hesaplarını yönet.'],
  profiles: ['Profiles', 'Rich Presence profillerini oluştur ve düzenle.'],
  scheduler: ['Scheduler', 'Saat bazlı otomatik profil geçişleri oluştur.'],
  logs: ['Logs', 'Bağlantı ve çalışma olaylarını izle.'],
  settings: ['Settings', 'Başlangıç, tray ve güvenlik davranışını ayarla.']
};

function $(selector, root = document) {
  return root.querySelector(selector);
}

function $$(selector, root = document) {
  return [...root.querySelectorAll(selector)];
}

function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function typeLabel(type) {
  return ({ PLAYING: 'Oynuyor', STREAMING: 'Yayında', LISTENING: 'Dinliyor', WATCHING: 'İzliyor', COMPETING: 'Yarışıyor' })[type] || type;
}

function statusLabel(status) {
  return ({ connected: 'Bağlı', connecting: 'Bağlanıyor', reconnecting: 'Yeniden bağlanıyor', disconnected: 'Kapalı', error: 'Hata' })[status] || status;
}

function formatDuration(start) {
  if (!start) return '—';
  const sec = Math.max(0, Math.floor((Date.now() - start) / 1000));
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d) return `${d}g ${h}s`;
  if (h) return `${h}s ${m}dk`;
  return `${m}dk`;
}

function showToast(message, type = 'success') {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast show ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, 3200);
}

async function run(action, successMessage = null) {
  try {
    const result = await action();
    if (successMessage) showToast(successMessage, 'success');
    return result;
  } catch (error) {
    showToast(error?.message || String(error), 'error');
    throw error;
  }
}

function switchPage(page) {
  currentPage = page;
  $$('.nav-item').forEach((btn) => btn.classList.toggle('active', btn.dataset.page === page));
  $$('.page').forEach((section) => section.classList.toggle('active', section.id === `page-${page}`));
  const [title, subtitle] = pageMeta[page];
  $('#page-title').textContent = title;
  $('#page-subtitle').textContent = subtitle;
  if (page === 'logs') renderLogs();
}

function profileOptions(selected = null, allowNone = true) {
  const none = allowNone ? '<option value="">Profil seçilmedi</option>' : '';
  return none + state.profiles.map((profile) => `<option value="${esc(profile.id)}" ${profile.id === selected ? 'selected' : ''}>${esc(profile.name)}</option>`).join('');
}

function accountOptions(selected = null) {
  return state.accounts.map((account) => `<option value="${esc(account.id)}" ${account.id === selected ? 'selected' : ''}>${esc(account.label)}</option>`).join('');
}

function renderDashboard() {
  const connected = state.accounts.filter((a) => a.runtime.status === 'connected').length;
  const reconnects = state.accounts.reduce((sum, a) => sum + (a.runtime.reconnects || 0), 0);
  const active = state.accounts.filter((a) => a.runtime.activeProfileId).length;

  $('#stats-grid').innerHTML = [
    ['Toplam Hesap', state.accounts.length, 'Kayıtlı Discord hesapları'],
    ['Bağlı', connected, `${state.accounts.length - connected} hesap bağlı değil`],
    ['Aktif RPC', active, 'Presence uygulanan hesaplar'],
    ['Reconnect', reconnects, 'Bu oturumdaki denemeler']
  ].map(([label, value, sub]) => `
    <div class="stat-card">
      <div class="stat-label">${esc(label)}</div>
      <div class="stat-value">${esc(value)}</div>
      <div class="stat-sub">${esc(sub)}</div>
    </div>
  `).join('');

  const warning = $('#warning-banner');
  if (!state.encryptionAvailable) {
    warning.textContent = 'Windows safeStorage kullanılamıyor. Güvenlik nedeniyle yeni token kaydı yapılmayacak.';
    warning.classList.remove('hidden');
  } else {
    warning.classList.add('hidden');
  }

  const wrap = $('#dashboard-accounts');
  if (!state.accounts.length) {
    wrap.innerHTML = '<div class="empty">Henüz hesap yok. Accounts sayfasından ekleyebilirsin.</div>';
    return;
  }

  wrap.innerHTML = state.accounts.map((account) => {
    const rt = account.runtime;
    const profile = state.profiles.find((p) => p.id === (rt.activeProfileId || account.profileId));
    const username = account.user?.displayName || account.user?.username || 'Henüz giriş yapılmadı';
    return `
      <div class="account-card">
        <div class="account-head">
          <div>
            <div class="account-name">${esc(account.label)}</div>
            <div class="account-user">${esc(username)}</div>
          </div>
          <div class="status-badge status-${esc(rt.status)}">${esc(statusLabel(rt.status))}</div>
        </div>
        <div class="account-meta">
          <div class="meta-box"><span>Ping</span><b>${rt.ping == null ? '—' : `${esc(rt.ping)} ms`}</b></div>
          <div class="meta-box"><span>Uptime</span><b>${esc(formatDuration(rt.connectedAt))}</b></div>
          <div class="meta-box"><span>Profil</span><b>${esc(profile?.name || '—')}</b></div>
        </div>
        <div class="row-actions">
          ${rt.status === 'connected'
            ? `<button class="btn danger-soft small" data-action="dash-disconnect" data-id="${esc(account.id)}">Bağlantıyı Kes</button>`
            : `<button class="btn primary small" data-action="dash-connect" data-id="${esc(account.id)}">Bağlan</button>`}
          <button class="btn ghost small" data-action="go-account" data-id="${esc(account.id)}">Yönet</button>
        </div>
      </div>`;
  }).join('');
}

function renderAccounts() {
  $('#account-profile').innerHTML = profileOptions(null, true);
  $('#accounts-count').textContent = `${state.accounts.length} hesap`;
  const list = $('#accounts-list');
  if (!state.accounts.length) {
    list.innerHTML = '<div class="empty">Kayıtlı hesap yok.</div>';
    return;
  }

  list.innerHTML = state.accounts.map((account) => {
    const rt = account.runtime;
    return `
      <div class="account-row" data-account="${esc(account.id)}">
        <div class="account-head">
          <div>
            <div class="account-name">${esc(account.label)}</div>
            <div class="account-user">${esc(account.user?.username || 'Giriş yapılmadı')} ${account.tokenStored ? '• token kayıtlı' : ''}</div>
          </div>
          <div class="status-badge status-${esc(rt.status)}">${esc(statusLabel(rt.status))}</div>
        </div>

        <div class="account-row-grid">
          <label>Etiket
            <input class="account-label-edit" value="${esc(account.label)}" maxlength="80" />
          </label>
          <label>Başlangıç profili
            <select class="account-profile-edit">${profileOptions(account.profileId, true)}</select>
          </label>
        </div>

        <label class="check-row"><input class="account-auto-edit" type="checkbox" ${account.autoConnect ? 'checked' : ''} /> Uygulama açılınca otomatik bağlan</label>

        <div class="token-replace">
          <input class="account-token-edit" type="password" autocomplete="off" placeholder="Tokenı değiştirmek için yenisini gir" />
          <button class="btn ghost small" data-action="replace-token" data-id="${esc(account.id)}">Tokenı Değiştir</button>
        </div>

        ${rt.lastError ? `<div class="warning-banner">${esc(rt.lastError)}</div>` : ''}

        <div class="row-actions">
          <button class="btn ghost small" data-action="save-account" data-id="${esc(account.id)}">Kaydet</button>
          ${rt.status === 'connected'
            ? `<button class="btn danger-soft small" data-action="disconnect" data-id="${esc(account.id)}">Bağlantıyı Kes</button>`
            : `<button class="btn primary small" data-action="connect" data-id="${esc(account.id)}">Bağlan</button>`}
          <button class="btn primary small" data-action="apply-account-profile" data-id="${esc(account.id)}" ${account.profileId ? '' : 'disabled'}>Profili Uygula</button>
          <button class="btn ghost small" data-action="clear-presence" data-id="${esc(account.id)}" ${rt.status === 'connected' ? '' : 'disabled'}>RPC Temizle</button>
          <button class="btn danger-soft small" data-action="remove-account" data-id="${esc(account.id)}">Sil</button>
        </div>
      </div>`;
  }).join('');
}

function clearProfileForm() {
  editingProfileId = null;
  $('#profile-id').value = '';
  $('#profile-name').value = '';
  $('#profile-app-id').value = '1310982134344847391';
  $('#profile-activity-name').value = '';
  $('#profile-type').value = 'PLAYING';
  $('#profile-status').value = 'online';
  $('#profile-stream-url').value = '';
  $('#profile-details').value = '';
  $('#profile-state').value = '';
  $('#profile-large-image').value = '';
  $('#profile-large-text').value = '';
  $('#profile-small-image').value = '';
  $('#profile-small-text').value = '';
  $('#profile-button1-label').value = '';
  $('#profile-button1-url').value = '';
  $('#profile-button2-label').value = '';
  $('#profile-button2-url').value = '';
  $('#profile-elapsed').checked = true;
  renderProfiles();
}

function editProfile(profileId) {
  const p = state.profiles.find((x) => x.id === profileId);
  if (!p) return;
  editingProfileId = p.id;
  $('#profile-id').value = p.id;
  $('#profile-name').value = p.name || '';
  $('#profile-app-id').value = p.applicationId || '';
  $('#profile-activity-name').value = p.activityName || '';
  $('#profile-type').value = p.type || 'PLAYING';
  $('#profile-status').value = p.status || 'online';
  $('#profile-stream-url').value = p.streamUrl || '';
  $('#profile-details').value = p.details || '';
  $('#profile-state').value = p.state || '';
  $('#profile-large-image').value = p.largeImage || '';
  $('#profile-large-text').value = p.largeText || '';
  $('#profile-small-image').value = p.smallImage || '';
  $('#profile-small-text').value = p.smallText || '';
  $('#profile-button1-label').value = p.buttons?.[0]?.label || '';
  $('#profile-button1-url').value = p.buttons?.[0]?.url || '';
  $('#profile-button2-label').value = p.buttons?.[1]?.label || '';
  $('#profile-button2-url').value = p.buttons?.[1]?.url || '';
  $('#profile-elapsed').checked = p.elapsed !== false;
  renderProfiles();
}

function renderProfiles() {
  $('#profiles-count').textContent = `${state.profiles.length} profil`;
  const list = $('#profiles-list');
  if (!state.profiles.length) {
    list.innerHTML = '<div class="empty">Henüz profil yok.</div>';
    return;
  }

  list.innerHTML = state.profiles.map((profile) => `
    <div class="profile-item ${profile.id === editingProfileId ? 'selected' : ''}">
      <div class="profile-title"><b>${esc(profile.name)}</b><span class="tag">${esc(typeLabel(profile.type))}</span></div>
      <div class="profile-tags">
        <span class="tag">${esc(profile.status)}</span>
        ${profile.elapsed ? '<span class="tag">elapsed</span>' : ''}
        ${profile.buttons?.length ? `<span class="tag">${profile.buttons.length} button</span>` : ''}
      </div>
      <div class="profile-copy">${esc(profile.activityName)}<br>${esc(profile.details || profile.state || 'Detay yok')}</div>
      <div class="row-actions" style="margin-top:12px">
        <button class="btn ghost small" data-action="edit-profile" data-id="${esc(profile.id)}">Düzenle</button>
        <button class="btn ghost small" data-action="export-profile" data-id="${esc(profile.id)}">Export</button>
        <button class="btn danger-soft small" data-action="remove-profile" data-id="${esc(profile.id)}">Sil</button>
      </div>
    </div>
  `).join('');
}

function renderScheduler() {
  $('#schedule-account').innerHTML = accountOptions();
  $('#schedule-profile').innerHTML = profileOptions(null, false);
  const list = $('#schedule-list');
  if (!state.schedules.length) {
    list.innerHTML = '<div class="empty">Henüz zamanlama kuralı yok.</div>';
    return;
  }
  const dayNames = ['Paz', 'Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt'];
  list.innerHTML = state.schedules.map((rule) => {
    const account = state.accounts.find((a) => a.id === rule.accountId);
    const profile = state.profiles.find((p) => p.id === rule.profileId);
    const days = (rule.days || []).map((d) => dayNames[d]).join(', ');
    return `
      <div class="schedule-item">
        <div class="schedule-main">
          <div>
            <div class="account-name">${esc(rule.name)}</div>
            <div class="schedule-sub">${esc(account?.label || 'Silinmiş hesap')} → ${esc(profile?.name || 'Silinmiş profil')}</div>
            <div class="schedule-sub">${esc(days)}</div>
          </div>
          <div class="schedule-time">${esc(rule.time)}</div>
        </div>
        <div class="row-actions" style="margin-top:12px">
          <button class="btn danger-soft small" data-action="remove-schedule" data-id="${esc(rule.id)}">Sil</button>
        </div>
      </div>`;
  }).join('');
}

function renderLogs() {
  const view = $('#logs-view');
  if (!logs.length) {
    view.innerHTML = '<div class="empty">Henüz log yok.</div>';
    return;
  }
  view.innerHTML = logs.slice().reverse().map((entry) => {
    const date = new Date(entry.time);
    const t = Number.isNaN(date.getTime()) ? entry.time : date.toLocaleString('tr-TR');
    return `<div class="log-line ${esc(entry.level)}"><span class="time">${esc(t)}</span><span class="level">${esc(entry.level.toUpperCase())}</span><span class="msg">${esc(entry.message)}</span></div>`;
  }).join('');
}

function renderSettings() {
  $('#setting-tray').checked = Boolean(state.settings.minimizeToTray);
  $('#setting-startup').checked = Boolean(state.settings.startWithWindows);
  $('#setting-minimized').checked = Boolean(state.settings.startMinimized);
  $('#setting-awake').checked = Boolean(state.settings.keepAwake);
  $('#setting-reconnect').checked = Boolean(state.settings.autoReconnect);
}

function renderAll() {
  renderDashboard();
  renderAccounts();
  renderProfiles();
  renderScheduler();
  renderSettings();
  if (currentPage === 'logs') renderLogs();
}

function profileFromForm() {
  const buttons = [
    { label: $('#profile-button1-label').value.trim(), url: $('#profile-button1-url').value.trim() },
    { label: $('#profile-button2-label').value.trim(), url: $('#profile-button2-url').value.trim() }
  ].filter((b) => b.label || b.url);

  return {
    id: $('#profile-id').value || undefined,
    name: $('#profile-name').value.trim(),
    applicationId: $('#profile-app-id').value.trim(),
    activityName: $('#profile-activity-name').value.trim(),
    type: $('#profile-type').value,
    status: $('#profile-status').value,
    streamUrl: $('#profile-stream-url').value.trim(),
    details: $('#profile-details').value.trim(),
    state: $('#profile-state').value.trim(),
    largeImage: $('#profile-large-image').value.trim(),
    largeText: $('#profile-large-text').value.trim(),
    smallImage: $('#profile-small-image').value.trim(),
    smallText: $('#profile-small-text').value.trim(),
    elapsed: $('#profile-elapsed').checked,
    buttons
  };
}

async function init() {
  state = await api.getState();
  logs = await api.getLogs();
  renderAll();

  api.onState((next) => {
    state = next;
    renderAll();
  });

  api.onLog((entry) => {
    logs.push(entry);
    if (logs.length > 500) logs.shift();
    if (currentPage === 'logs') renderLogs();
  });

  $('#nav').addEventListener('click', (event) => {
    const btn = event.target.closest('[data-page]');
    if (btn) switchPage(btn.dataset.page);
  });

  $('#connect-all').addEventListener('click', () => run(() => api.connectAll(), 'Bağlantı denemeleri başlatıldı.'));
  $('#disconnect-all').addEventListener('click', () => run(() => api.disconnectAll(), 'Tüm bağlantılar kapatıldı.'));

  $('#account-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = {
      label: $('#account-label').value.trim(),
      token: $('#account-token').value.trim(),
      profileId: $('#account-profile').value || null,
      autoConnect: $('#account-auto').checked,
      connectNow: $('#account-connect-now').checked
    };
    await run(() => api.addAccount(data), 'Hesap eklendi.');
    $('#account-token').value = '';
    $('#account-label').value = '';
  });

  $('#accounts-list').addEventListener('click', async (event) => {
    const btn = event.target.closest('[data-action]');
    if (!btn) return;
    const id = btn.dataset.id;
    const row = btn.closest('[data-account]');
    const action = btn.dataset.action;

    if (action === 'save-account') {
      await run(() => api.updateAccount({
        id,
        label: $('.account-label-edit', row).value,
        profileId: $('.account-profile-edit', row).value || null,
        autoConnect: $('.account-auto-edit', row).checked
      }), 'Hesap ayarları kaydedildi.');
    }
    if (action === 'replace-token') {
      const token = $('.account-token-edit', row).value.trim();
      if (!token) return showToast('Yeni tokenı gir.', 'error');
      await run(() => api.setAccountToken({ id, token }), 'Token yenilendi.');
      $('.account-token-edit', row).value = '';
    }
    if (action === 'connect') await run(() => api.connectAccount(id), 'Bağlandı.');
    if (action === 'disconnect') await run(() => api.disconnectAccount(id), 'Bağlantı kapatıldı.');
    if (action === 'apply-account-profile') {
      const profileId = $('.account-profile-edit', row).value;
      if (!profileId) return showToast('Önce profil seç.', 'error');
      await api.updateAccount({ id, profileId });
      await run(() => api.applyPresence({ accountId: id, profileId }), 'Presence uygulandı.');
    }
    if (action === 'clear-presence') await run(() => api.clearPresence(id), 'Presence temizlendi.');
    if (action === 'remove-account') {
      if (!confirm('Bu hesabı ve şifreli token kaydını silmek istiyor musun?')) return;
      await run(() => api.removeAccount(id), 'Hesap silindi.');
    }
  });

  $('#dashboard-accounts').addEventListener('click', async (event) => {
    const btn = event.target.closest('[data-action]');
    if (!btn) return;
    const id = btn.dataset.id;
    if (btn.dataset.action === 'dash-connect') await run(() => api.connectAccount(id), 'Bağlandı.');
    if (btn.dataset.action === 'dash-disconnect') await run(() => api.disconnectAccount(id), 'Bağlantı kapatıldı.');
    if (btn.dataset.action === 'go-account') switchPage('accounts');
  });

  $('#profile-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const result = await run(() => api.saveProfile(profileFromForm()), 'Profil kaydedildi.');
    if (result) {
      editingProfileId = result.id;
      $('#profile-id').value = result.id;
    }
  });
  $('#profile-new').addEventListener('click', clearProfileForm);
  $('#profile-import').addEventListener('click', async () => {
    const result = await run(() => api.importProfile());
    if (result) {
      showToast('Profil içe aktarıldı.', 'success');
      editProfile(result.id);
    }
  });
  $('#profiles-list').addEventListener('click', async (event) => {
    const btn = event.target.closest('[data-action]');
    if (!btn) return;
    const id = btn.dataset.id;
    if (btn.dataset.action === 'edit-profile') editProfile(id);
    if (btn.dataset.action === 'export-profile') await run(() => api.exportProfile(id), 'Profil export edildi.');
    if (btn.dataset.action === 'remove-profile') {
      if (!confirm('Profili silmek istiyor musun?')) return;
      await run(() => api.removeProfile(id), 'Profil silindi.');
      if (editingProfileId === id) clearProfileForm();
    }
  });

  $('#schedule-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!state.accounts.length) return showToast('Önce hesap ekle.', 'error');
    if (!state.profiles.length) return showToast('Önce profil ekle.', 'error');
    const days = $$('#schedule-days input:checked').map((el) => Number(el.value));
    if (!days.length) return showToast('En az bir gün seç.', 'error');
    await run(() => api.saveSchedule({
      name: $('#schedule-name').value.trim(),
      accountId: $('#schedule-account').value,
      profileId: $('#schedule-profile').value,
      time: $('#schedule-time').value,
      days,
      enabled: true
    }), 'Zamanlama eklendi.');
    $('#schedule-name').value = '';
  });
  $('#schedule-list').addEventListener('click', async (event) => {
    const btn = event.target.closest('[data-action="remove-schedule"]');
    if (!btn) return;
    await run(() => api.removeSchedule(btn.dataset.id), 'Kural silindi.');
  });

  $('#clear-logs').addEventListener('click', async () => {
    await api.clearLogs();
    logs = [];
    renderLogs();
    showToast('Loglar temizlendi.', 'success');
  });

  const settingsMap = [
    ['#setting-tray', 'minimizeToTray'],
    ['#setting-startup', 'startWithWindows'],
    ['#setting-minimized', 'startMinimized'],
    ['#setting-awake', 'keepAwake'],
    ['#setting-reconnect', 'autoReconnect']
  ];
  for (const [selector, key] of settingsMap) {
    $(selector).addEventListener('change', async (event) => {
      await run(() => api.updateSettings({ [key]: event.target.checked }), 'Ayar kaydedildi.');
    });
  }

  $('#quit-app').addEventListener('click', () => api.quit());

  setInterval(() => {
    if (currentPage === 'dashboard') renderDashboard();
  }, 30000);
}

init().catch((error) => {
  document.body.innerHTML = `<div style="padding:30px;color:#ff9d9d;font-family:Segoe UI">NexRPC arayüzü başlatılamadı: ${esc(error.message || error)}</div>`;
});
