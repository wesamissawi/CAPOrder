// main.js
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');
const { getWorldOrders } = require('./src/scrapers/worldScraper');
const { getTransbecOrders } = require('./src/scrapers/transbecScraper');
const { getProforceOrders } = require('./src/scrapers/proforceScraper');
let log = console;
try { log = require('electron-log'); } catch (e) { console.warn('[autoUpdater] electron-log not installed; falling back to console'); }

const isDev = !app.isPackaged;

const LOCK_DURATION_MS = 20000; // 20 seconds


// ---- data paths ----
const DATA_FILENAME = 'outstanding_items.json';
const ORDERS_FILENAME = 'orders.json';

const DEFAULT_WIN_ITEMS_DIR = '\\\\GIRLSBOYS\\ushare\\Ghost PO\\Order_Items';
const DEFAULT_WIN_ORDERS_DIR = '\\\\GIRLSBOYS\\ushare\\Ghost PO\\Orders';
const DEFAULT_LOCAL_BASE = path.join(app.getPath('documents'), 'CAPOrder');

const WORLD_DATA_DIR = path.join(app.getPath('userData'), 'world');
const WORLD_STORAGE_STATE = path.join(WORLD_DATA_DIR, 'world_storage_state.json');
const TRANSBEC_DATA_DIR = path.join(app.getPath('userData'), 'transbec');
const TRANSBEC_STORAGE_STATE = path.join(TRANSBEC_DATA_DIR, 'transbec_storage_state.json');
const TRANSBEC_PRODUCTS_PATH = path.join(TRANSBEC_DATA_DIR, 'transbec_products.json');
const PROFORCE_DATA_DIR = path.join(app.getPath('userData'), 'proforce');
const PROFORCE_STORAGE_STATE = path.join(PROFORCE_DATA_DIR, 'proforce_storage_state.json');



const CONFIG_FILE = path.join(app.getPath('userData'), 'config.json');
const UI_STATE_FILE = path.join(app.getPath('userData'), 'ui_state.json');
const PRELOAD = path.resolve(__dirname, 'preload.js');

// ---- log preload path exists ----
console.log('[main] preload path =', PRELOAD, 'exists?', fs.existsSync(PRELOAD));

// ---- data helpers ----
let dataFileOverride = null;
let ordersFileOverride = null;
let configCache = null;
let watcher = null;

function readConfig() {
  try {
    if (configCache) return configCache;
    if (fs.existsSync(CONFIG_FILE)) {
      configCache = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
      return configCache;
    }
  } catch {}
  configCache = {};
  return configCache;
}
function writeConfig(cfg) {
  try { configCache = cfg; fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf-8'); } catch (e) { console.error('[config write]', e); }
}

function getDefaultItemsDir() {
  if (process.platform === 'win32') return DEFAULT_WIN_ITEMS_DIR;
  if (process.platform === 'darwin') return path.join(DEFAULT_LOCAL_BASE, 'items');
  return app.getPath('userData');
}
function getDefaultOrdersDir() {
  if (process.platform === 'win32') return DEFAULT_WIN_ORDERS_DIR;
  if (process.platform === 'darwin') return path.join(DEFAULT_LOCAL_BASE, 'orders');
  return app.getPath('userData');
}
function getDefaultDataFile() {
  return path.join(getDefaultItemsDir(), DATA_FILENAME);
}
function getDefaultOrdersFile() {
  return path.join(getDefaultOrdersDir(), ORDERS_FILENAME);
}
function getDataFile() {
  return dataFileOverride || getDefaultDataFile();
}
function ensureDataFileAt(file) {
  try { ensureDir(path.dirname(file)); } catch {}
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

function getOrdersFile() {
  return ordersFileOverride || getDefaultOrdersFile();
}
function readOrders() {
  return readItemsAt(getOrdersFile());
}
function writeOrdersAt(file, orders) {
  ensureDataFileAt(file);
  fs.writeFileSync(file, JSON.stringify(orders ?? [], null, 2), 'utf-8');
}
function writeOrders(orders) {
  return writeOrdersAt(getOrdersFile(), orders);
}
function ensureDir(dirPath) {
  try { fs.mkdirSync(dirPath, { recursive: true }); } catch {}
}

function toMoneyString(val) {
  if (val === null || val === undefined || val === '') return '';
  const num = Number(val);
  if (Number.isFinite(num)) return num.toFixed(2);
  return String(val);
}

function toDDMMYYYY(order) {
  // Prefer ISO orderDate
  if (order?.orderDate) {
    const d = new Date(order.orderDate);
    if (!Number.isNaN(d.getTime())) {
      const dd = String(d.getDate()).padStart(2, '0');
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const yyyy = d.getFullYear();
      return `${dd}${mm}${yyyy}`;
    }
  }
  // Fallback: sageDate (DDMMYY)
  const s = String(order?.sageDate || '').trim();
  if (s.length === 6) {
    return `${s.slice(0, 2)}${s.slice(2, 4)}20${s.slice(4, 6)}`;
  }
  return '';
}

function makeOutstandingFromLine(order, line) {
  const nowIso = new Date().toISOString();
  const itemcode = `${line?.partLineCode || ''} ${line?.partNumber || ''}`.trim() || (line?.partNumber || line?.partLineCode || 'ITEM');
  const costVal = line?.costPriceValue ?? line?.costPrice ?? line?.extendedValue ?? line?.extended;
  const qty = Number(line?.quantity ?? 1) || 1;
  const inv = (order?.source_invoice || order?.invoiceNum || '').trim();
  return {
    uid: randomUUID(),
    allocated_for: toMoneyString(line?.extended ?? line?.costPrice ?? order?.total ?? order?.totalRaw ?? ''),
    allocated_to: 'New Stock',
    cost: toMoneyString(costVal),
    date: toDDMMYYYY(order),
    invoice_num: '',
    'invoiced date': '',
    'invoiced status': '',
    itemcode,
    notes1: line?.partDescription || '',
    notes2: '',
    source_inv: inv || order?.source || 'world',
    warehouse: order?.warehouse || order?.seller || '',
    last_moved_at: nowIso,
    quantity: qty,
    reference_num: order?.reference || '',
    sold_date: '',
    sold_status: '',
  };
}

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

function setupAutoUpdater(mainWindow) {
  if (isDev) return; // skip auto-updates in dev

  try {
    if (log?.transports?.file) log.transports.file.level = 'info';
    autoUpdater.logger = log;
  } catch (e) {
    console.error('[autoUpdater] logger init failed', e);
  }

  autoUpdater.on('update-available', (info) => {
    log.info?.('[autoUpdater] Update available', info?.version || info);
  });

  autoUpdater.on('update-not-available', (info) => {
    log.info?.('[autoUpdater] No update available', info?.version || info);
  });

  autoUpdater.on('error', (err) => {
    console.error('[autoUpdater] Error', err);
    log.error?.(err);
  });

  autoUpdater.on('update-downloaded', async (_evt, info) => {
    try {
      const { response } = await dialog.showMessageBox(mainWindow || undefined, {
        type: 'info',
        title: 'Update ready',
        message: `Version ${info?.version || ''} has been downloaded. Restart now to apply the update?`,
        buttons: ['Restart now', 'Later'],
        defaultId: 0,
        cancelId: 1,
      });
      if (response === 0) {
        autoUpdater.quitAndInstall();
      }
    } catch (e) {
      console.error('[autoUpdater] dialog failed', e);
    }
  });

  const triggerCheck = () => {
    autoUpdater.checkForUpdates().catch((e) => {
      console.error('[autoUpdater] check failed', e);
      log.error?.(e);
    });
  };

  if (mainWindow) {
    mainWindow.once('ready-to-show', triggerCheck);
  } else {
    app.whenReady().then(triggerCheck);
  }
}





// ---- window ----
let win = null;
let boundsSaveTimeout = null;

async function createWindow() {
  // restore any saved custom data file path
  const cfg = readConfig();
  if (cfg.dataDir && typeof cfg.dataDir === 'string') {
    dataFileOverride = path.join(cfg.dataDir, DATA_FILENAME);
  } else if (cfg.dataFile && typeof cfg.dataFile === 'string') {
    dataFileOverride = cfg.dataFile;
  }
  if (cfg.ordersDir && typeof cfg.ordersDir === 'string') {
    ordersFileOverride = path.join(cfg.ordersDir, ORDERS_FILENAME);
  } else if (cfg.ordersFile && typeof cfg.ordersFile === 'string') {
    ordersFileOverride = cfg.ordersFile;
  }
  const windowBounds = cfg.windowBounds || {};
  const defaultWidth = Number(windowBounds.width) || 1280;
  const defaultHeight = Number(windowBounds.height) || 900;
  const defaultX = Number.isFinite(windowBounds.x) ? windowBounds.x : undefined;
  const defaultY = Number.isFinite(windowBounds.y) ? windowBounds.y : undefined;
  win = new BrowserWindow({
    width: defaultWidth,
    height: defaultHeight,
    x: defaultX,
    y: defaultY,
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
    await win.loadURL('http://localhost:5173/').catch((err) => {
      console.error('Failed to load URL', err);
    });
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    await win.loadFile(path.join(__dirname, 'renderer', 'dist', 'index.html'));
  }

  console.log('[main] data file =', getDataFile());
  startWatching(win);
  if (!isDev) setupAutoUpdater(win);

  const scheduleSaveBounds = () => {
    if (boundsSaveTimeout) clearTimeout(boundsSaveTimeout);
    boundsSaveTimeout = setTimeout(() => {
      if (!win || win.isDestroyed()) return;
      const bounds = win.getBounds();
      const cfg = readConfig();
      cfg.windowBounds = bounds;
      writeConfig(cfg);
    }, 400);
  };

  win.on('move', scheduleSaveBounds);
  win.on('resize', scheduleSaveBounds);
  win.on('close', () => {
    if (boundsSaveTimeout) clearTimeout(boundsSaveTimeout);
    if (!win || win.isDestroyed()) return;
    const bounds = win.getBounds();
    const cfg = readConfig();
    cfg.windowBounds = bounds;
    writeConfig(cfg);
  });
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
ipcMain.handle('items:get-path', () => ({
  path: getDataFile(),
  defaultPath: getDefaultDataFile(),
  platform: process.platform,
}));
ipcMain.handle('items:reveal', () => { const f = getDataFile(); if (fs.existsSync(f)) shell.showItemInFolder(f); return { ok: true }; });
ipcMain.handle('items:choose-file', async () => {
  const res = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] });
  if (res.canceled || !res.filePaths?.[0]) return { ok: false, canceled: true };
  dataFileOverride = res.filePaths[0];
  const cfg = readConfig();
  cfg.dataFile = dataFileOverride;
  cfg.dataDir = path.dirname(dataFileOverride);
  writeConfig(cfg);
  startWatching(win);
  if (win && !win.isDestroyed()) win.webContents.send('items:updated', readItems());
  return { ok: true, path: dataFileOverride };
});
ipcMain.handle('items:use-default', () => {
  dataFileOverride = null;
  const cfg = readConfig(); delete cfg.dataFile; delete cfg.dataDir; writeConfig(cfg);
  startWatching(win);
  if (win && !win.isDestroyed()) win.webContents.send('items:updated', readItems());
  return { ok: true, path: getDataFile() };
});

ipcMain.handle('paths:get-info', () => {
  const cfg = readConfig();
  return {
    ok: true,
    itemsPath: getDataFile(),
    ordersPath: getOrdersFile(),
    defaults: {
      itemsPath: getDefaultDataFile(),
      ordersPath: getDefaultOrdersFile(),
      itemsDir: getDefaultItemsDir(),
      ordersDir: getDefaultOrdersDir(),
    },
    overrides: {
      itemsDir: (dataFileOverride && path.dirname(dataFileOverride)) || cfg.dataDir || null,
      ordersDir: (ordersFileOverride && path.dirname(ordersFileOverride)) || cfg.ordersDir || null,
    },
    platform: process.platform,
  };
});

ipcMain.handle('paths:choose-items-dir', async () => {
  const res = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
  if (res.canceled || !res.filePaths?.[0]) return { ok: false, canceled: true };
  const dir = res.filePaths[0];
  dataFileOverride = path.join(dir, DATA_FILENAME);
  const cfg = readConfig(); cfg.dataDir = dir; delete cfg.dataFile; writeConfig(cfg);
  startWatching(win);
  if (win && !win.isDestroyed()) win.webContents.send('items:updated', readItems());
  return { ok: true, path: getDataFile(), dir };
});

ipcMain.handle('paths:choose-orders-dir', async () => {
  const res = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
  if (res.canceled || !res.filePaths?.[0]) return { ok: false, canceled: true };
  const dir = res.filePaths[0];
  ordersFileOverride = path.join(dir, ORDERS_FILENAME);
  const cfg = readConfig(); cfg.ordersDir = dir; delete cfg.ordersFile; writeConfig(cfg);
  return { ok: true, path: getOrdersFile(), dir };
});

ipcMain.handle('paths:use-defaults', () => {
  dataFileOverride = null;
  ordersFileOverride = null;
  const cfg = readConfig();
  delete cfg.dataFile; delete cfg.dataDir;
  delete cfg.ordersFile; delete cfg.ordersDir;
  writeConfig(cfg);
  startWatching(win);
  if (win && !win.isDestroyed()) win.webContents.send('items:updated', readItems());
  return { ok: true, itemsPath: getDataFile(), ordersPath: getOrdersFile() };
});

ipcMain.handle('orders:read', () => readOrders());
ipcMain.handle('orders:get-path', () => ({
  path: getOrdersFile(),
  defaultPath: getDefaultOrdersFile(),
  platform: process.platform,
}));
ipcMain.handle('orders:write', (_evt, orders) => {
  const current = readOrders();                  // existing array
  const a = JSON.stringify(current);
  const b = JSON.stringify(orders ?? []);
  if (a !== b) writeOrders(orders);              // only write if actually different
  try {
    syncOutstandingInvoices(orders ?? []);
  } catch (e) {
    console.error('[orders:write] sync outstanding failed', e);
  }
  return { ok: true };
});
ipcMain.handle('orders:add-to-outstanding', () => {
  try {
    const orders = readOrders();
    const items = readItems();
    const newItems = [];
    let lineUpdates = 0;

    const updatedOrders = orders.map((order) => {
      if (!order || !Array.isArray(order.lineItems)) return order;
      const updatedLineItems = order.lineItems.map((line) => {
        if (!line || line.addedToOutstanding === true) return line;
        const outItem = makeOutstandingFromLine(order, line);
        newItems.push(outItem);
        lineUpdates += 1;
        return { ...line, addedToOutstanding: true };
      });
      return { ...order, lineItems: updatedLineItems };
    });

    if (newItems.length > 0) {
      const mergedItems = items.concat(newItems);
      writeItems(mergedItems);
      writeOrders(updatedOrders);
    }

    return { ok: true, added: newItems.length, linesUpdated: lineUpdates };
  } catch (e) {
    console.error('[orders:add-to-outstanding]', e);
    return { ok: false, error: e?.message || 'Failed to add outstanding items.' };
  }
});

function syncOutstandingInvoices(orders) {
  try {
    const items = readItems();
    const byRef = new Map();
    (orders || []).forEach((o) => {
      if (!o || !o.reference) return;
      const inv = (o.source_invoice || o.invoiceNum || '').trim();
      if (!inv) return;
      const key = String(o.reference).trim().toUpperCase();
      if (key) byRef.set(key, inv);
    });
    if (byRef.size === 0) return;

    let changed = false;
    const updated = items.map((it) => {
      if (!it || !it.reference_num) return it;
      const key = String(it.reference_num).trim().toUpperCase();
      const inv = byRef.get(key);
      if (!inv) return it;
      if (it.source_inv === inv) return it;
      changed = true;
      return { ...it, source_inv: inv };
    });

    if (changed) {
      writeItems(updated);
    }
  } catch (e) {
    console.error('[syncOutstandingInvoices]', e);
  }
}
ipcMain.handle('orders:fetch-world', async () => {
  try {
    ensureDir(WORLD_DATA_DIR);
    const existing = readOrders();
    const targetOrdersPath = getOrdersFile();
    const res = await getWorldOrders({
      storageDir: WORLD_DATA_DIR,
      storageStatePath: WORLD_STORAGE_STATE,
      ordersPath: targetOrdersPath,
      existingOrders: existing,
    });
    if (res?.ok && Array.isArray(res.orders)) {
      writeOrders(res.orders);
    }
    return { ok: true, ...(res || {}), path: targetOrdersPath };
  } catch (e) {
    console.error('[orders:fetch-world]', e);
    return { ok: false, error: e?.message || 'Failed to fetch World orders.' };
  }
});

ipcMain.handle('orders:fetch-transbec', async () => {
  try {
    ensureDir(TRANSBEC_DATA_DIR);
    const targetOrdersPath = getOrdersFile();
    const existing = readOrders();
    const res = await getTransbecOrders({
      storageDir: TRANSBEC_DATA_DIR,
      storageStatePath: TRANSBEC_STORAGE_STATE,
      ordersPath: targetOrdersPath,
      productsPath: TRANSBEC_PRODUCTS_PATH,
      existingOrders: existing,
      maxPages: 1, // limit to first page as requested
    });
    let merged = Array.isArray(res?.orders) ? res.orders : [];
    if (res?.ok) {
      const byRef = new Map();
      (existing || []).forEach((o) => {
        if (!o?.reference) return;
        const key = String(o.reference).trim().toUpperCase();
        if (key) byRef.set(key, o);
      });
      for (const o of merged) {
        const key = o?.reference ? String(o.reference).trim().toUpperCase() : "";
        if (!key) continue;
        if (!byRef.has(key)) {
          byRef.set(key, o);
        }
      }
      merged = Array.from(byRef.values());
      writeOrders(merged);
    }
    return {
      ok: true,
      ...(res || {}),
      orders: merged,
      path: targetOrdersPath,
      productsPath: TRANSBEC_PRODUCTS_PATH,
    };
  } catch (e) {
    console.error('[orders:fetch-transbec]', e);
    return { ok: false, error: e?.message || 'Failed to fetch Transbec orders.' };
  }
});

ipcMain.handle('orders:fetch-proforce', async () => {
  try {
    ensureDir(PROFORCE_DATA_DIR);
    const targetOrdersPath = getOrdersFile();
    const existing = readOrders();
    const res = await getProforceOrders({
      storageDir: PROFORCE_DATA_DIR,
      storageStatePath: PROFORCE_STORAGE_STATE,
      ordersPath: targetOrdersPath,
      existingOrders: existing,
    });
    if (res?.ok && Array.isArray(res.orders)) {
      writeOrders(res.orders);
    }
    return { ok: true, ...(res || {}), path: targetOrdersPath };
  } catch (e) {
    console.error('[orders:login-proforce]', e);
    return { ok: false, error: e?.message || 'Failed to fetch Proforce orders.' };
  }
});

ipcMain.handle('ui-state:read', () => ({ ok: true, state: readUIState() }));
ipcMain.handle('ui-state:write', (_evt, state) => {
  writeUIState(state && typeof state === 'object' ? state : {});
  return { ok: true };
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
function readUIState() {
  try {
    if (fs.existsSync(UI_STATE_FILE)) {
      const json = JSON.parse(fs.readFileSync(UI_STATE_FILE, 'utf-8'));
      return typeof json === 'object' && json ? json : {};
    }
  } catch (e) {
    console.error('[ui-state read]', e);
  }
  return {};
}
function writeUIState(state) {
  try {
    fs.writeFileSync(UI_STATE_FILE, JSON.stringify(state || {}, null, 2), 'utf-8');
  } catch (e) {
    console.error('[ui-state write]', e);
  }
}
