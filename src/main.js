const { app, BrowserWindow, ipcMain, Tray, Menu, safeStorage, nativeImage, powerSaveBlocker, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Client, RichPresence } = require('discord.js-selfbot-v13');

const DEFAULT_APP_ID = '1310982134344847391';
const MAX_LOGS = 500;
const RECONNECT_DELAYS = [5000, 10000, 30000, 60000, 120000];

let mainWindow = null;
let tray = null;
let quitting = false;
let state = null;
let stateFile = null;
let logFile = null;
let schedulerTimer = null;
let watchdogTimer = null;
let powerBlockerId = null;

const connections = new Map();
const reconnectTimers = new Map();
const reconnectAttempts = new Map();
const schedulerFired = new Set();
const logs = [];

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
}

function defaultState() {
  return {
    version: 2,
    accounts: [],
    profiles: [
      {
        id: 'profile_default',
        name: 'Minecraft',
        applicationId: DEFAULT_APP_ID,
        activityName: 'Minecraft',
        type: 'PLAYING',
        status: 'online',
        details: 'Nexuby Network',
        state: 'mc.nexuby.net.tr',
        largeImage: '',
        largeText: 'Minecraft',
        smallImage: '',
        smallText: '',
        elapsed: true,
        streamUrl: '',
        buttons: []
      }
    ],
    schedules: [],
    settings: {
      minimizeToTray: true,
      startWithWindows: false,
      startMinimized: false,
      keepAwake: true,
      autoReconnect: true
    }
  };
}

function loadState() {
  try {
    if (!fs.existsSync(stateFile)) {
      state = defaultState();
      saveState();
      return;
    }
    const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    state = { ...defaultState(), ...parsed };
    state.settings = { ...defaultState().settings, ...(parsed.settings || {}) };
    state.accounts = Array.isArray(parsed.accounts) ? parsed.accounts : [];
    state.profiles = Array.isArray(parsed.profiles) && parsed.profiles.length ? parsed.profiles : defaultState().profiles;
    state.schedules = Array.isArray(parsed.schedules) ? parsed.schedules : [];
  } catch (error) {
    log('error', `Ayar dosyasi okunamadi: ${error.message}`);
    state = defaultState();
    saveState();
  }
}

function saveState() {
  if (!stateFile || !state) return;
  const tmp = `${stateFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, stateFile);
}

function log(level, message, meta = null) {
  const entry = {
    id: makeId('log'),
    time: new Date().toISOString(),
    level,
    message,
    meta
  };
  logs.push(entry);
  while (logs.length > MAX_LOGS) logs.shift();

  try {
    if (logFile) fs.appendFileSync(logFile, `[${entry.time}] [${level.toUpperCase()}] ${message}${meta ? ` ${JSON.stringify(meta)}` : ''}\n`);
  } catch {}

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('log:new', entry);
  }
}

function encryptionReady() {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

function encryptToken(token) {
  if (!encryptionReady()) throw new Error('Windows guvenli depolama kullanilamiyor. Token duz metin olarak kaydedilmez.');
  return safeStorage.encryptString(token).toString('base64');
}

function decryptToken(account) {
  if (!account?.token) throw new Error('Bu hesap icin kayitli token yok.');
  if (!encryptionReady()) throw new Error('Windows guvenli depolama kullanilamiyor.');
  return safeStorage.decryptString(Buffer.from(account.token, 'base64'));
}

function getAccount(accountId) {
  return state.accounts.find((a) => a.id === accountId) || null;
}

function getProfile(profileId) {
  return state.profiles.find((p) => p.id === profileId) || null;
}

function runtimeFor(accountId) {
  return connections.get(accountId) || null;
}

function publicRuntime(accountId) {
  const runtime = runtimeFor(accountId);
  if (!runtime) {
    return {
      status: 'disconnected',
      connectedAt: null,
      reconnects: reconnectAttempts.get(accountId) || 0,
      ping: null,
      lastError: null,
      activeProfileId: null
    };
  }
  let ping = null;
  try {
    const value = runtime.client?.ws?.ping;
    if (Number.isFinite(value) && value >= 0) ping = Math.round(value);
  } catch {}
  return {
    status: runtime.status,
    connectedAt: runtime.connectedAt,
    reconnects: runtime.reconnects || 0,
    ping,
    lastError: runtime.lastError || null,
    activeProfileId: runtime.activeProfileId || null
  };
}

function publicState() {
  return {
    version: state.version,
    encryptionAvailable: encryptionReady(),
    accounts: state.accounts.map((account) => ({
      id: account.id,
      label: account.label,
      autoConnect: account.autoConnect !== false,
      profileId: account.profileId || null,
      createdAt: account.createdAt,
      user: account.user || null,
      tokenStored: Boolean(account.token),
      runtime: publicRuntime(account.id)
    })),
    profiles: state.profiles,
    schedules: state.schedules,
    settings: state.settings
  };
}

function broadcastState() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('state:update', publicState());
  }
  rebuildTrayMenu();
}

function clearReconnectTimer(accountId) {
  const timer = reconnectTimers.get(accountId);
  if (timer) clearTimeout(timer);
  reconnectTimers.delete(accountId);
}

function isInvalidTokenError(error) {
  const text = String(error?.message || error || '').toLowerCase();
  return text.includes('invalid token') || text.includes('token_invalid') || text.includes('improper token');
}

function scheduleReconnect(accountId, reason = 'Baglanti kesildi') {
  const account = getAccount(accountId);
  if (!account || account.autoConnect === false || !state.settings.autoReconnect) return;
  if (reconnectTimers.has(accountId)) return;

  const attempt = (reconnectAttempts.get(accountId) || 0) + 1;
  reconnectAttempts.set(accountId, attempt);
  const delay = RECONNECT_DELAYS[Math.min(attempt - 1, RECONNECT_DELAYS.length - 1)];
  log('warn', `${account.label}: ${reason}. ${Math.round(delay / 1000)} sn sonra yeniden baglanilacak.`);

  const timer = setTimeout(async () => {
    reconnectTimers.delete(accountId);
    try {
      await connectAccount(accountId, true);
    } catch (error) {
      if (!isInvalidTokenError(error)) scheduleReconnect(accountId, error.message);
    }
  }, delay);
  reconnectTimers.set(accountId, timer);
}

async function destroyRuntime(accountId, manual = true) {
  clearReconnectTimer(accountId);
  const runtime = runtimeFor(accountId);
  if (!runtime) return;
  runtime.manualDisconnect = manual;
  try {
    await runtime.client.destroy();
  } catch {}
  connections.delete(accountId);
  broadcastState();
}

function bindClientEvents(account, runtime) {
  const client = runtime.client;

  client.on('ready', async () => {
    runtime.status = 'connected';
    runtime.connectedAt = Date.now();
    runtime.lastReadyAt = Date.now();
    runtime.lastError = null;
    runtime.reconnects = reconnectAttempts.get(account.id) || 0;
    reconnectAttempts.set(account.id, 0);

    const user = client.user;
    account.user = {
      id: user.id,
      username: user.username,
      discriminator: user.discriminator,
      displayName: user.globalName || user.username
    };
    saveState();
    log('info', `${account.label}: Discord'a baglandi (${user.username}).`);
    broadcastState();

    if (account.profileId) {
      const profile = getProfile(account.profileId);
      if (profile) {
        try {
          await applyPresence(account.id, profile.id, false);
        } catch (error) {
          log('error', `${account.label}: Baslangic profili uygulanamadi: ${error.message}`);
        }
      }
    }
  });

  client.on('error', (error) => {
    runtime.lastError = error?.message || String(error);
    log('error', `${account.label}: Discord hatasi: ${runtime.lastError}`);
    broadcastState();
  });

  client.on('warn', (warning) => {
    log('warn', `${account.label}: ${String(warning)}`);
  });

  client.on('shardReconnecting', () => {
    runtime.status = 'reconnecting';
    runtime.reconnects += 1;
    log('warn', `${account.label}: Gateway yeniden baglaniyor.`);
    broadcastState();
  });

  client.on('shardResume', () => {
    runtime.status = 'connected';
    runtime.lastReadyAt = Date.now();
    log('info', `${account.label}: Gateway oturumu resume edildi.`);
    broadcastState();
  });

  client.on('shardReady', () => {
    runtime.status = 'connected';
    runtime.lastReadyAt = Date.now();
    broadcastState();
  });

  client.on('invalidated', async () => {
    runtime.status = 'disconnected';
    log('warn', `${account.label}: Discord oturumu invalidated oldu.`);
    broadcastState();
    if (!runtime.manualDisconnect) {
      await destroyRuntime(account.id, false);
      scheduleReconnect(account.id, 'Oturum gecersiz oldu');
    }
  });
}

async function connectAccount(accountId, fromReconnect = false) {
  const account = getAccount(accountId);
  if (!account) throw new Error('Hesap bulunamadi.');

  const old = runtimeFor(accountId);
  if (old && ['connecting', 'connected', 'reconnecting'].includes(old.status)) return publicRuntime(accountId);

  clearReconnectTimer(accountId);
  const token = decryptToken(account);
  const client = new Client({ checkUpdate: false });
  const runtime = {
    client,
    status: 'connecting',
    connectedAt: null,
    connectStartedAt: Date.now(),
    lastReadyAt: null,
    lastError: null,
    reconnects: reconnectAttempts.get(accountId) || 0,
    activeProfileId: null,
    manualDisconnect: false
  };
  connections.set(accountId, runtime);
  bindClientEvents(account, runtime);
  broadcastState();
  log('info', `${account.label}: Baglanti baslatildi${fromReconnect ? ' (reconnect)' : ''}.`);

  try {
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('Discord girisi 45 saniyede tamamlanmadi.')), 45000));
    await Promise.race([client.login(token), timeout]);
    return publicRuntime(accountId);
  } catch (error) {
    runtime.status = 'error';
    runtime.lastError = error?.message || String(error);
    log('error', `${account.label}: Giris basarisiz: ${runtime.lastError}`);
    broadcastState();
    try { await client.destroy(); } catch {}
    connections.delete(accountId);

    if (!isInvalidTokenError(error)) scheduleReconnect(accountId, runtime.lastError);
    throw error;
  }
}

async function disconnectAccount(accountId) {
  const account = getAccount(accountId);
  await destroyRuntime(accountId, true);
  reconnectAttempts.set(accountId, 0);
  if (account) log('info', `${account.label}: Baglanti kapatildi.`);
  broadcastState();
}

function normalizeProfile(profile) {
  return {
    id: profile.id || makeId('profile'),
    name: String(profile.name || 'Yeni Profil').slice(0, 80),
    applicationId: String(profile.applicationId || DEFAULT_APP_ID).trim(),
    activityName: String(profile.activityName || 'NexRPC').slice(0, 128),
    type: ['PLAYING', 'STREAMING', 'LISTENING', 'WATCHING', 'COMPETING'].includes(profile.type) ? profile.type : 'PLAYING',
    status: ['online', 'idle', 'dnd', 'invisible'].includes(profile.status) ? profile.status : 'online',
    details: String(profile.details || '').slice(0, 128),
    state: String(profile.state || '').slice(0, 128),
    largeImage: String(profile.largeImage || '').slice(0, 500),
    largeText: String(profile.largeText || '').slice(0, 128),
    smallImage: String(profile.smallImage || '').slice(0, 500),
    smallText: String(profile.smallText || '').slice(0, 128),
    elapsed: profile.elapsed !== false,
    streamUrl: String(profile.streamUrl || '').slice(0, 500),
    buttons: Array.isArray(profile.buttons)
      ? profile.buttons.slice(0, 2).map((button) => ({
          label: String(button.label || '').slice(0, 32),
          url: String(button.url || '').slice(0, 500)
        })).filter((b) => b.label && /^https?:\/\//i.test(b.url))
      : []
  };
}

async function applyPresence(accountId, profileId, persistAssignment = true) {
  const account = getAccount(accountId);
  const profile = getProfile(profileId);
  const runtime = runtimeFor(accountId);

  if (!account) throw new Error('Hesap bulunamadi.');
  if (!profile) throw new Error('Profil bulunamadi.');
  if (!runtime || runtime.status !== 'connected' || !runtime.client?.user) throw new Error('Hesap Discord\'a bagli degil.');

  const presence = new RichPresence(runtime.client)
    .setApplicationId(profile.applicationId || DEFAULT_APP_ID)
    .setName(profile.activityName || 'NexRPC')
    .setType(profile.type || 'PLAYING')
    .setPlatform('desktop');

  if (profile.details) presence.setDetails(profile.details);
  if (profile.state) presence.setState(profile.state);
  if (profile.largeImage) presence.setAssetsLargeImage(profile.largeImage);
  if (profile.largeText) presence.setAssetsLargeText(profile.largeText);
  if (profile.smallImage) presence.setAssetsSmallImage(profile.smallImage);
  if (profile.smallText) presence.setAssetsSmallText(profile.smallText);
  if (profile.elapsed && typeof presence.setStartTimestamp === 'function') presence.setStartTimestamp(Date.now());
  if (profile.type === 'STREAMING' && profile.streamUrl && typeof presence.setURL === 'function') presence.setURL(profile.streamUrl);
  for (const button of profile.buttons || []) presence.addButton(button.label, button.url);

  try {
    await Promise.resolve(runtime.client.user.setPresence({
      status: profile.status || 'online',
      activities: [presence]
    }));
  } catch (firstError) {
    await Promise.resolve(runtime.client.user.setActivity(presence));
    log('warn', `${account.label}: setPresence yerine setActivity fallback kullanildi: ${firstError.message}`);
  }

  runtime.activeProfileId = profile.id;
  if (persistAssignment) {
    account.profileId = profile.id;
    saveState();
  }
  log('info', `${account.label}: "${profile.name}" profili uygulandi.`);
  broadcastState();
  return true;
}

async function clearPresence(accountId) {
  const account = getAccount(accountId);
  const runtime = runtimeFor(accountId);
  if (!account || !runtime?.client?.user) throw new Error('Hesap Discord\'a bagli degil.');

  try {
    await Promise.resolve(runtime.client.user.setPresence({ status: 'online', activities: [] }));
  } catch {
    await Promise.resolve(runtime.client.user.setActivity(null));
  }
  runtime.activeProfileId = null;
  log('info', `${account.label}: Aktivite temizlendi.`);
  broadcastState();
}

function updateLoginItem() {
  if (process.platform !== 'win32') return;
  try {
    app.setLoginItemSettings({
      openAtLogin: Boolean(state.settings.startWithWindows),
      args: state.settings.startMinimized ? ['--hidden'] : []
    });
  } catch (error) {
    log('warn', `Windows baslangic ayari uygulanamadi: ${error.message}`);
  }
}

function updatePowerBlocker() {
  try {
    if (state.settings.keepAwake && powerBlockerId == null) {
      powerBlockerId = powerSaveBlocker.start('prevent-app-suspension');
    } else if (!state.settings.keepAwake && powerBlockerId != null) {
      if (powerSaveBlocker.isStarted(powerBlockerId)) powerSaveBlocker.stop(powerBlockerId);
      powerBlockerId = null;
    }
  } catch (error) {
    log('warn', `Power blocker ayarlanamadi: ${error.message}`);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 980,
    minHeight: 640,
    show: false,
    backgroundColor: '#0c0e12',
    title: 'NexRPC',
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      devTools: process.argv.includes('--dev')
    }
  });

  mainWindow.removeMenu();
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file:')) event.preventDefault();
  });

  mainWindow.on('close', (event) => {
    if (!quitting && state?.settings?.minimizeToTray) {
      event.preventDefault();
      mainWindow.hide();
      log('info', 'Pencere tray\'e gizlendi; Discord baglantilari calismaya devam ediyor.');
    }
  });

  mainWindow.once('ready-to-show', () => {
    const hidden = process.argv.includes('--hidden') || state.settings.startMinimized;
    if (!hidden) mainWindow.show();
  });
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  mainWindow.show();
  mainWindow.focus();
}

function rebuildTrayMenu() {
  if (!tray || !state) return;
  const connected = state.accounts.filter((a) => publicRuntime(a.id).status === 'connected').length;
  tray.setToolTip(`NexRPC - ${connected}/${state.accounts.length} hesap bagli`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `NexRPC (${connected}/${state.accounts.length} bagli)`, enabled: false },
    { type: 'separator' },
    { label: 'NexRPC\'yi Ac', click: showWindow },
    {
      label: 'Tum Hesaplari Bagla',
      click: () => state.accounts.forEach((a) => connectAccount(a.id).catch(() => {}))
    },
    {
      label: 'Tum Baglantilari Kapat',
      click: () => state.accounts.forEach((a) => disconnectAccount(a.id).catch(() => {}))
    },
    { type: 'separator' },
    {
      label: 'Cikis',
      click: () => {
        quitting = true;
        app.quit();
      }
    }
  ]));
}

function createTray() {
  let image = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'icon.png'));
  if (!image.isEmpty()) image = image.resize({ width: 18, height: 18 });
  tray = new Tray(image);
  tray.on('double-click', showWindow);
  rebuildTrayMenu();
}

function startScheduler() {
  if (schedulerTimer) clearInterval(schedulerTimer);
  schedulerTimer = setInterval(async () => {
    const now = new Date();
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const day = now.getDay();
    const dateKey = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}-${hhmm}`;

    for (const rule of state.schedules) {
      if (!rule.enabled || rule.time !== hhmm || !Array.isArray(rule.days) || !rule.days.includes(day)) continue;
      const fireKey = `${rule.id}:${dateKey}`;
      if (schedulerFired.has(fireKey)) continue;
      schedulerFired.add(fireKey);

      try {
        if (publicRuntime(rule.accountId).status !== 'connected') await connectAccount(rule.accountId);
        await applyPresence(rule.accountId, rule.profileId, false);
        log('info', `Scheduler: ${rule.name || 'Kural'} calisti.`);
      } catch (error) {
        log('error', `Scheduler: ${rule.name || 'Kural'} calisamadi: ${error.message}`);
      }
    }

    if (schedulerFired.size > 500) schedulerFired.clear();
  }, 15000);
}

function startWatchdog() {
  if (watchdogTimer) clearInterval(watchdogTimer);
  watchdogTimer = setInterval(async () => {
    const now = Date.now();
    for (const account of state.accounts) {
      const runtime = runtimeFor(account.id);
      if (!runtime) continue;

      if (runtime.status === 'connecting' && now - runtime.connectStartedAt > 70000) {
        log('warn', `${account.label}: Watchdog takili kalan baglantiyi yeniden baslatiyor.`);
        await destroyRuntime(account.id, false);
        scheduleReconnect(account.id, 'Watchdog timeout');
      }
    }
    broadcastState();
  }, 30000);
}

function registerIpc() {
  ipcMain.handle('state:get', () => publicState());
  ipcMain.handle('logs:get', () => logs.slice());
  ipcMain.handle('logs:clear', () => {
    logs.splice(0, logs.length);
    if (logFile) fs.writeFileSync(logFile, '');
    return true;
  });

  ipcMain.handle('account:add', async (_event, payload) => {
    const token = String(payload?.token || '').trim();
    const label = String(payload?.label || 'Discord Hesabi').trim().slice(0, 80);
    if (!token) throw new Error('Token bos olamaz.');
    const account = {
      id: makeId('acc'),
      label: label || 'Discord Hesabi',
      token: encryptToken(token),
      profileId: payload?.profileId || null,
      autoConnect: payload?.autoConnect !== false,
      createdAt: Date.now(),
      user: null
    };
    state.accounts.push(account);
    saveState();
    log('info', `${account.label}: Hesap eklendi. Token Windows guvenli depolama ile sifrelendi.`);
    broadcastState();
    if (payload?.connectNow !== false) await connectAccount(account.id);
    return publicState();
  });

  ipcMain.handle('account:update', (_event, payload) => {
    const account = getAccount(payload?.id);
    if (!account) throw new Error('Hesap bulunamadi.');
    if (typeof payload.label === 'string') account.label = payload.label.trim().slice(0, 80) || account.label;
    if ('profileId' in payload) account.profileId = payload.profileId || null;
    if ('autoConnect' in payload) account.autoConnect = Boolean(payload.autoConnect);
    saveState();
    broadcastState();
    return publicState();
  });

  ipcMain.handle('account:set-token', async (_event, payload) => {
    const account = getAccount(payload?.id);
    if (!account) throw new Error('Hesap bulunamadi.');
    const token = String(payload?.token || '').trim();
    if (!token) throw new Error('Token bos olamaz.');
    await destroyRuntime(account.id, true);
    account.token = encryptToken(token);
    saveState();
    log('info', `${account.label}: Token yenilendi.`);
    broadcastState();
    return true;
  });

  ipcMain.handle('account:remove', async (_event, accountId) => {
    const account = getAccount(accountId);
    if (!account) return publicState();
    await destroyRuntime(accountId, true);
    state.accounts = state.accounts.filter((a) => a.id !== accountId);
    state.schedules = state.schedules.filter((r) => r.accountId !== accountId);
    saveState();
    log('info', `${account.label}: Hesap ve sifreli token kaydi silindi.`);
    broadcastState();
    return publicState();
  });

  ipcMain.handle('account:connect', async (_event, accountId) => connectAccount(accountId));
  ipcMain.handle('account:disconnect', async (_event, accountId) => disconnectAccount(accountId));
  ipcMain.handle('account:connect-all', async () => {
    const results = [];
    for (const account of state.accounts) {
      try { await connectAccount(account.id); results.push({ id: account.id, ok: true }); }
      catch (error) { results.push({ id: account.id, ok: false, error: error.message }); }
    }
    return results;
  });
  ipcMain.handle('account:disconnect-all', async () => {
    for (const account of state.accounts) await disconnectAccount(account.id);
    return true;
  });

  ipcMain.handle('profile:save', (_event, payload) => {
    const normalized = normalizeProfile(payload || {});
    const index = state.profiles.findIndex((p) => p.id === normalized.id);
    if (index >= 0) state.profiles[index] = normalized;
    else state.profiles.push(normalized);
    saveState();
    log('info', `Profil kaydedildi: ${normalized.name}`);
    broadcastState();
    return normalized;
  });

  ipcMain.handle('profile:remove', (_event, profileId) => {
    state.profiles = state.profiles.filter((p) => p.id !== profileId);
    for (const account of state.accounts) if (account.profileId === profileId) account.profileId = null;
    state.schedules = state.schedules.filter((r) => r.profileId !== profileId);
    saveState();
    log('info', 'Profil silindi.');
    broadcastState();
    return publicState();
  });

  ipcMain.handle('profile:export', async (_event, profileId) => {
    const profile = getProfile(profileId);
    if (!profile) throw new Error('Profil bulunamadi.');
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'NexRPC Profili Disari Aktar',
      defaultPath: `${profile.name.replace(/[^a-z0-9-_]/gi, '_')}.nexrpc.json`,
      filters: [{ name: 'NexRPC Profile', extensions: ['json'] }]
    });
    if (result.canceled || !result.filePath) return false;
    fs.writeFileSync(result.filePath, JSON.stringify({ nexrpcProfile: 1, profile }, null, 2), 'utf8');
    return true;
  });

  ipcMain.handle('profile:import', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'NexRPC Profili Ice Aktar',
      properties: ['openFile'],
      filters: [{ name: 'NexRPC Profile', extensions: ['json'] }]
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const parsed = JSON.parse(fs.readFileSync(result.filePaths[0], 'utf8'));
    const source = parsed.profile || parsed;
    const profile = normalizeProfile({ ...source, id: makeId('profile'), name: `${source.name || 'Imported'} (Import)` });
    state.profiles.push(profile);
    saveState();
    log('info', `Profil ice aktarildi: ${profile.name}`);
    broadcastState();
    return profile;
  });

  ipcMain.handle('presence:apply', async (_event, payload) => applyPresence(payload.accountId, payload.profileId, true));
  ipcMain.handle('presence:clear', async (_event, accountId) => clearPresence(accountId));

  ipcMain.handle('schedule:save', (_event, payload) => {
    if (!getAccount(payload.accountId)) throw new Error('Scheduler hesabi bulunamadi.');
    if (!getProfile(payload.profileId)) throw new Error('Scheduler profili bulunamadi.');
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(payload.time || '')) throw new Error('Saat HH:MM formatinda olmali.');
    const rule = {
      id: payload.id || makeId('schedule'),
      name: String(payload.name || 'Kural').slice(0, 80),
      accountId: payload.accountId,
      profileId: payload.profileId,
      time: payload.time,
      days: Array.isArray(payload.days) ? payload.days.map(Number).filter((d) => d >= 0 && d <= 6) : [0,1,2,3,4,5,6],
      enabled: payload.enabled !== false
    };
    const index = state.schedules.findIndex((r) => r.id === rule.id);
    if (index >= 0) state.schedules[index] = rule;
    else state.schedules.push(rule);
    saveState();
    broadcastState();
    return rule;
  });

  ipcMain.handle('schedule:remove', (_event, id) => {
    state.schedules = state.schedules.filter((r) => r.id !== id);
    saveState();
    broadcastState();
    return true;
  });

  ipcMain.handle('settings:update', (_event, payload) => {
    state.settings = { ...state.settings, ...payload };
    saveState();
    updateLoginItem();
    updatePowerBlocker();
    broadcastState();
    return state.settings;
  });

  ipcMain.handle('window:show', () => showWindow());
  ipcMain.handle('window:hide', () => mainWindow?.hide());
  ipcMain.handle('app:quit', () => {
    quitting = true;
    app.quit();
  });
}

async function autoConnectAccounts() {
  for (const account of state.accounts) {
    if (account.autoConnect === false) continue;
    connectAccount(account.id).catch((error) => {
      log('error', `${account.label}: Otomatik baglanti basarisiz: ${error.message}`);
    });
    await new Promise((resolve) => setTimeout(resolve, 800));
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());

  app.whenReady().then(async () => {
    app.setAppUserModelId('tr.nexuby.nexrpc');
    const userData = app.getPath('userData');
    fs.mkdirSync(userData, { recursive: true });
    stateFile = path.join(userData, 'state.json');
    logFile = path.join(userData, 'nexrpc.log');

    loadState();
    registerIpc();
    updateLoginItem();
    updatePowerBlocker();
    createWindow();
    createTray();
    startScheduler();
    startWatchdog();

    log('info', `NexRPC 2 basladi. Guvenli depolama: ${encryptionReady() ? 'hazir' : 'kullanilamiyor'}.`);
    await autoConnectAccounts();
  });
}

app.on('activate', showWindow);
app.on('window-all-closed', () => {
  if (!state?.settings?.minimizeToTray && process.platform !== 'darwin') {
    quitting = true;
    app.quit();
  }
});

app.on('before-quit', async () => {
  quitting = true;
  if (schedulerTimer) clearInterval(schedulerTimer);
  if (watchdogTimer) clearInterval(watchdogTimer);
  for (const timer of reconnectTimers.values()) clearTimeout(timer);
  reconnectTimers.clear();
  for (const [accountId] of connections) {
    try { await destroyRuntime(accountId, true); } catch {}
  }
});

process.on('uncaughtException', (error) => log('error', `uncaughtException: ${error.stack || error.message}`));
process.on('unhandledRejection', (error) => log('error', `unhandledRejection: ${error?.stack || error}`));
