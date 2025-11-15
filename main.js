// main.js
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const isDev = !app.isPackaged;

const LOCK_DURATION_MS = 20000; // 20 seconds


// ---- data paths ----
const DATA_FILE_DEFAULT = path.join(app.getPath('userData'), 'outstanding_items.json');
const CONFIG_FILE = path.join(app.getPath('userData'), 'config.json');
const PRELOAD = path.resolve(__dirname, 'preload.js');

// ---- log preload path exists ----
console.log('[main] preload path =', PRELOAD, 'exists?', fs.existsSync(PRELOAD));

// ---- data helpers ----
let dataFileOverride = null;
let watcher = null;

function readConfig() {
  try { if (fs.existsSync(CONFIG_FILE)) return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')); } catch {}
  return {};
}
function writeConfig(cfg) {
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf-8'); } catch (e) { console.error('[config write]', e); }
}
function getDataFile() {
  return dataFileOverride || DATA_FILE_DEFAULT;
}
function ensureDataFileAt(file) {
  if (!fs.existsSync(file)) fs.writeFileSync(file, '[]', 'utf-8');
}
function readItemsAt(file) {
  ensureDataFileAt(file);
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    console.error('[readItemsAt]', e);
    return [];
  }
}
function writeItemsAt(file, items) {
  ensureDataFileAt(file);
  fs.writeFileSync(file, JSON.stringify(items ?? [], null, 2), 'utf-8');
}
function readItems() { return readItemsAt(getDataFile()); }
function writeItems(items) { return writeItemsAt(getDataFile(), items); }

function startWatching(win) {
  const file = getDataFile();
  try { if (watcher) watcher.close(); } catch {}
  ensureDataFileAt(file);
  watcher = fs.watch(file, { persistent: false }, () => {
    const arr = readItems();
    if (win && !win.isDestroyed()) {
      win.webContents.send('items:updated', arr);
      console.log('[main] watch -> items:updated', arr.length);
    }
  });
}

function cleanExpiredLocks(items) {
  const now = Date.now();
  let changed = false;
  const cleaned = items.map((it) => {
    if (it.lock_expires_at && it.lock_expires_at < now) {
      const { lock_expires_at, ...rest } = it;
      changed = true;
      return rest;
    }
    return it;
  });
  return { items: cleaned, changed };
}





// ---- window ----
let win = null;

async function createWindow() {
  // restore any saved custom data file path
  const cfg = readConfig();
  if (cfg.dataFile && typeof cfg.dataFile === 'string') {
    dataFileOverride = cfg.dataFile;
  }

  win = new BrowserWindow({
    width: 1280,
    height: 900,
    webPreferences: {
      preload: PRELOAD,            // must exist beside main.js
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,              // TEMP for easier debugging; set true later
    },
  });

  // lifecycle logs
  win.webContents.on('did-finish-load', () => {
    console.log('[main] did-finish-load');
    // initial push (never before this)
    const arr = readItems();
    if (win && !win.isDestroyed()) {
      win.webContents.send('items:updated', arr);
      console.log('[main] initial items sent:', Array.isArray(arr) ? arr.length : arr);
    }
  });

  win.webContents.on('preload-error', (_e, preloadPath, error) => {
    console.error('[main] preload-error at', preloadPath, error);
  });

  if (isDev) {
    await win.loadURL('http://localhost:5173/');
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    await win.loadFile(path.join(__dirname, 'renderer', 'dist', 'index.html'));
  }

  console.log('[main] data file =', getDataFile());
  startWatching(win);
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ---- IPC ----
ipcMain.handle('items:read', () => readItems());
// ipcMain.handle('items:write', (_evt, items) => { writeItems(items); return { ok: true }; });
ipcMain.handle('items:write', (_evt, items) => {
  const file = getDataFile();
  const current = readItems();                // existing array
  const a = JSON.stringify(current);
  const b = JSON.stringify(items ?? []);
  if (a !== b) writeItems(items);             // only write if actually different
  return { ok: true };
});
ipcMain.handle('items:export', async (_evt, items) => {
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: 'Export updated items',
    defaultPath: 'outstanding_items.updated.json',
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (canceled || !filePath) return { ok: false, canceled: true };
  fs.writeFileSync(filePath, JSON.stringify(items ?? [], null, 2), 'utf-8');
  return { ok: true, filePath };
});
ipcMain.handle('items:get-path', () => ({ path: getDataFile() }));
ipcMain.handle('items:reveal', () => { const f = getDataFile(); if (fs.existsSync(f)) shell.showItemInFolder(f); return { ok: true }; });
ipcMain.handle('items:choose-file', async () => {
  const res = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] });
  if (res.canceled || !res.filePaths?.[0]) return { ok: false, canceled: true };
  dataFileOverride = res.filePaths[0];
  const cfg = readConfig(); cfg.dataFile = dataFileOverride; writeConfig(cfg);
  startWatching(win);
  if (win && !win.isDestroyed()) win.webContents.send('items:updated', readItems());
  return { ok: true, path: dataFileOverride };
});
ipcMain.handle('items:use-default', () => {
  dataFileOverride = null;
  const cfg = readConfig(); delete cfg.dataFile; writeConfig(cfg);
  startWatching(win);
  if (win && !win.isDestroyed()) win.webContents.send('items:updated', readItems());
  return { ok: true, path: getDataFile() };
});


// Acquire a 20s lock on a specific item
ipcMain.handle('items:lock-item', (_evt, uid) => {
  let items = readItems();
  const { items: cleaned, changed } = cleanExpiredLocks(items);
  if (changed) {
    items = cleaned;
    writeItems(items);
  }

  const idx = items.findIndex((it) => it.uid === uid);
  if (idx === -1) {
    return { ok: false, reason: 'not-found' };
  }

  const it = items[idx];
  const now = Date.now();

  if (it.lock_expires_at && it.lock_expires_at > now) {
    // Someone else holds a valid lock
    return { ok: false, reason: 'locked' };
  }

  const lock_expires_at = now + LOCK_DURATION_MS;
  items[idx] = { ...it, lock_expires_at };
  writeItems(items);

  return { ok: true, item: items[idx], lock_expires_at };
});

// Apply an edit to a locked item and remove the lock
ipcMain.handle('items:apply-edit', (_evt, uid, patch) => {
  let items = readItems();
  const { items: cleaned, changed } = cleanExpiredLocks(items);
  if (changed) {
    items = cleaned;
    writeItems(items);
  }

  const idx = items.findIndex((it) => it.uid === uid);
  if (idx === -1) {
    return { ok: false, reason: 'not-found' };
  }

  const it = items[idx];
  const now = Date.now();

  if (!it.lock_expires_at || it.lock_expires_at < now) {
    // Lock expired or never existed
    return { ok: false, reason: 'lock-expired' };
  }

  // Don’t keep the lock field in the final saved item
  const { lock_expires_at, ...rest } = it;
  const updated = { ...rest, ...(patch || {}) };
  items[idx] = updated;

  writeItems(items);
  return { ok: true, item: updated };
});

// Optional: manual lock release (e.g., user cancels)
ipcMain.handle('items:release-lock', (_evt, uid) => {
  let items = readItems();
  const idx = items.findIndex((it) => it.uid === uid);
  if (idx === -1) return { ok: false, reason: 'not-found' };

  const it = items[idx];
  if (!it.lock_expires_at) {
    return { ok: true, released: false }; // nothing to do
  }

  const { lock_expires_at, ...rest } = it;
  items[idx] = rest;
  writeItems(items);
  return { ok: true, released: true };
});

