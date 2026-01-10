// main.js
const { app, BrowserWindow, ipcMain, dialog, shell, screen } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');
const { spawn } = require('child_process');
const { createItemsDomain } = require('./main/domain/items.domain');
const { normalizeOrderRef, orderMatchesKey, getVendorName } = require('./main/domain/orders.domain');
const { extractJournalLine, extractSageTotal, extractReconcileApplied, createSageDomain } = require('./main/domain/sage.domain');
const { searchArchiveEntries } = require('./main/domain/archive.domain');
const { normalizeSharedBubblePayload } = require('./main/domain/sharedBubble.domain');
const { createItemsService } = require('./main/services/items.service');
const { createWatchersService } = require('./main/services/watchers.service');
const { createVendorOrdersService } = require('./main/services/vendorOrders.service');
const { createSageService } = require('./main/services/sage.service');
const { createAppConfigService } = require('./main/services/appConfig.service');
const { createUpdatesService } = require('./main/services/updates.service');

// Point Playwright to the packaged browsers when running in production
if (app.isPackaged) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(process.resourcesPath, 'playwright-browsers');
}

const { getWorldOrders } = require('./src/scrapers/worldScraper');
const { getTransbecOrders } = require('./src/scrapers/transbecScraper');
const { getProforceOrders } = require('./src/scrapers/proforceScraper');
const { getBestBuyOrders } = require('./src/scrapers/bestBuyScraper');
const { getCbkOrders } = require('./src/scrapers/cbkScraper');

const isDev = !app.isPackaged;

const LOCK_DURATION_MS = 20000; // 20 seconds

const itemsDomain = createItemsDomain({ randomUUID });
const {
  toMoneyString,
  computeAllocatedFor,
  toDDMMYYYY,
  makeOutstandingFromLine,
  splitItemsByQueue,
  cleanExpiredLocks,
} = itemsDomain;


// ---- path + config helpers ----
const INSTANCE_DIR = app.getPath('userData');
const BUSINESS_FILE_BASENAMES = {
  outstanding: 'outstanding_items.json',
  sageAr: 'sage_ar_items.json',
  cashSales: 'cash_sales_items.json',
  orders: 'orders.json',
  ordersBackup: 'orders.json.bak',
  archived: 'archived_bubbles.json',
  archivedBackup: 'archived_bubbles.json.bak',
};
const BUSINESS_FILE_LIST = Object.values(BUSINESS_FILE_BASENAMES);

const INSTANCE_PATHS = {
  appConfig: path.join(INSTANCE_DIR, 'app_config.json'),
  windowConfig: path.join(INSTANCE_DIR, 'config.json'),
  uiState: path.join(INSTANCE_DIR, 'ui_state.json'),
  sageTempOrder: path.join(INSTANCE_DIR, 'orders.sage.tmp.json'),
};
const SHARED_BUBBLE_FILE = 'bubble_shared.json';

// Vendor/session data must stay instance-local
const VENDOR_PATHS = {
  world: {
    dataDir: path.join(INSTANCE_DIR, 'world'),
    storageState: path.join(INSTANCE_DIR, 'world', 'world_storage_state.json'),
  },
  transbec: {
    dataDir: path.join(INSTANCE_DIR, 'transbec'),
    storageState: path.join(INSTANCE_DIR, 'transbec', 'transbec_storage_state.json'),
    products: path.join(INSTANCE_DIR, 'transbec', 'transbec_products.json'),
  },
  proforce: {
    dataDir: path.join(INSTANCE_DIR, 'proforce'),
    storageState: path.join(INSTANCE_DIR, 'proforce', 'proforce_storage_state.json'),
  },
  bestbuy: {
    dataDir: path.join(INSTANCE_DIR, 'bestbuy'),
    storageState: path.join(INSTANCE_DIR, 'bestbuy', 'bestbuy_storage_state.json'),
  },
  cbk: {
    dataDir: path.join(INSTANCE_DIR, 'cbk'),
    storageState: path.join(INSTANCE_DIR, 'cbk', 'cbk_storage_state.json'),
  },
};

const PRELOAD = path.resolve(__dirname, 'preload.js');

const SAGE_TEMP_ORDER = INSTANCE_PATHS.sageTempOrder;
const SAGE_AHK_SCRIPT = app.isPackaged
  ? path.join(process.resourcesPath, 'ahk', 'sage_purchaser.ahk')
  : path.join(__dirname, 'ahk', 'sage_purchaser.ahk');
const SAGE_INVOICE_SCRIPT = app.isPackaged
  ? path.join(process.resourcesPath, 'ahk', 'update_invoice.ahk')
  : path.join(__dirname, 'ahk', 'update_invoice.ahk');
const SAGE_RECONCILE_SCRIPT = app.isPackaged
  ? path.join(process.resourcesPath, 'ahk', 'reconcile_totals.ahk')
  : path.join(__dirname, 'ahk', 'reconcile_totals.ahk');

let dataFileOverride = null;

function normalizeAppConfig(raw = {}) {
  const sharedDataDir = typeof raw.sharedDataDir === 'string' ? raw.sharedDataDir.trim() : '';
  const ahkExePath = typeof raw.ahkExePath === 'string' ? raw.ahkExePath.trim() : '';
  return { sharedDataDir, ahkExePath, instanceDataDir: INSTANCE_DIR };
}
function ensureAppConfigFile() {
  try { ensureDir(path.dirname(INSTANCE_PATHS.appConfig)); } catch {}
  if (fs.existsSync(INSTANCE_PATHS.appConfig)) return;
  const defaults = normalizeAppConfig();
  fs.writeFileSync(INSTANCE_PATHS.appConfig, JSON.stringify(defaults, null, 2), 'utf-8');
}
function readAppConfig() {
  try {
    ensureAppConfigFile();
    const raw = fs.readFileSync(INSTANCE_PATHS.appConfig, 'utf-8');
    const parsed = JSON.parse(raw);
    return normalizeAppConfig(parsed);
  } catch (e) {
    console.error('[appConfig read]', e);
    return normalizeAppConfig();
  }
}
function writeAppConfig(cfg) {
  try {
    ensureAppConfigFile();
    const base = readAppConfig();
    const incoming = { ...(cfg || {}) };
    delete incoming.instanceDataDir;
    const next = normalizeAppConfig({ ...base, ...incoming, instanceDataDir: INSTANCE_DIR });
    fs.writeFileSync(INSTANCE_PATHS.appConfig, JSON.stringify(next, null, 2), 'utf-8');
    return next;
  } catch (e) {
    console.error('[appConfig write]', e);
    throw e;
  }
}
function getSharedDirInfo() {
  const cfg = readAppConfig();
  const shared = (cfg.sharedDataDir || '').trim();
  return { sharedDir: shared || INSTANCE_DIR, sharedConfigured: Boolean(shared) };
}
function getSharedDataDir() {
  return getSharedDirInfo().sharedDir;
}
function getAhkExePath() {
  const cfg = readAppConfig();
  return (cfg.ahkExePath || '').trim();
}
function validateAhkExePath(targetPath) {
  const candidate = (targetPath || '').trim();
  const exists = Boolean(candidate) && fs.existsSync(candidate);
  return { ok: true, exists, path: candidate };
}
function resolveBusinessPaths() {
  const { sharedDir, sharedConfigured } = getSharedDirInfo();
  const outstanding = dataFileOverride || path.join(sharedDir, BUSINESS_FILE_BASENAMES.outstanding);
  const queueDir = path.dirname(outstanding);
  return {
    sharedDir,
    sharedConfigured,
    queueDir,
    outstanding,
    sageAr: path.join(queueDir, BUSINESS_FILE_BASENAMES.sageAr),
    cashSales: path.join(queueDir, BUSINESS_FILE_BASENAMES.cashSales),
    orders: path.join(queueDir, BUSINESS_FILE_BASENAMES.orders),
    ordersBackup: path.join(queueDir, BUSINESS_FILE_BASENAMES.ordersBackup),
    archived: path.join(sharedDir, BUSINESS_FILE_BASENAMES.archived),
    archivedBackup: path.join(sharedDir, BUSINESS_FILE_BASENAMES.archivedBackup),
  };
}
function ensureBusinessFiles() {
  const resolved = resolveBusinessPaths();
  [
    resolved.outstanding,
    resolved.sageAr,
    resolved.cashSales,
    resolved.orders,
    resolved.ordersBackup,
    resolved.archived,
    resolved.archivedBackup,
  ].forEach((file) => ensureDataFileAt(file));
}
function getResolvedPathsSummary() {
  const resolved = resolveBusinessPaths();
  const files = {
    outstanding_items: { path: resolved.outstanding, exists: fs.existsSync(resolved.outstanding) },
    sage_ar_items: { path: resolved.sageAr, exists: fs.existsSync(resolved.sageAr) },
    cash_sales_items: { path: resolved.cashSales, exists: fs.existsSync(resolved.cashSales) },
    orders_json: { path: resolved.orders, exists: fs.existsSync(resolved.orders) },
    orders_json_bak: { path: resolved.ordersBackup, exists: fs.existsSync(resolved.ordersBackup) },
    archived_bubbles: { path: resolved.archived, exists: fs.existsSync(resolved.archived) },
    archived_bubbles_bak: { path: resolved.archivedBackup, exists: fs.existsSync(resolved.archivedBackup) },
  };
  return {
    sharedDir: resolved.sharedDir,
    sharedConfigured: resolved.sharedConfigured,
    sharedExists: fs.existsSync(resolved.sharedDir),
    instanceDir: INSTANCE_DIR,
    queueDir: resolved.queueDir,
    files,
  };
}
function validateWritable(targetDir) {
  try {
    const testFile = path.join(targetDir, `.write-test-${process.pid}-${Date.now()}`);
    ensureDir(targetDir);
    fs.writeFileSync(testFile, 'ok');
    fs.unlinkSync(testFile);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e?.message || 'Not writable' };
  }
}
function backupFile(srcPath, suffix = '.bak') {
  try {
    if (!fs.existsSync(srcPath)) return;
    const dir = path.dirname(srcPath);
    const base = path.basename(srcPath);
    const target = path.join(dir, `${base}${suffix}`);
    fs.copyFileSync(srcPath, target);
  } catch (e) {
    console.warn('[backup] failed', srcPath, e);
  }
}

// ---- log preload path exists ----
console.log('[main] preload path =', PRELOAD, 'exists?', fs.existsSync(PRELOAD));

// ---- data helpers ----
let sageIntegrationActive = false;

function readConfig() {
  try { if (fs.existsSync(INSTANCE_PATHS.windowConfig)) return JSON.parse(fs.readFileSync(INSTANCE_PATHS.windowConfig, 'utf-8')); } catch {}
  return {};
}
function writeConfig(cfg) {
  try { fs.writeFileSync(INSTANCE_PATHS.windowConfig, JSON.stringify(cfg, null, 2), 'utf-8'); } catch (e) { console.error('[config write]', e); }
}
function loadConfig() {
  try {
    if (!fs.existsSync(INSTANCE_PATHS.windowConfig)) return {};
    const raw = fs.readFileSync(INSTANCE_PATHS.windowConfig, 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}
function saveConfig(partial) {
  const base = loadConfig();
  const next = { ...(base || {}) };
  if (partial && typeof partial === 'object' && !Array.isArray(partial)) {
    Object.assign(next, partial);
  }
  ensureDir(path.dirname(INSTANCE_PATHS.windowConfig));
  fs.writeFileSync(INSTANCE_PATHS.windowConfig, JSON.stringify(next, null, 2), 'utf-8');
  return next;
}
function ensureConfigFile() {
  if (fs.existsSync(INSTANCE_PATHS.windowConfig)) return;
  writeConfig({ userConfig: {} });
}
function getUserConfigRaw() {
  const cfg = readConfig();
  const userConfig = cfg?.userConfig;
  return userConfig && typeof userConfig === 'object' && !Array.isArray(userConfig) ? userConfig : {};
}
function getEnvOverrides(userConfig) {
  if (app.isPackaged) return {};
  const overrides = {};
  Object.keys(userConfig || {}).forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(process.env || {}, key)) {
      overrides[key] = process.env[key];
    }
  });
  return overrides;
}
function getUserConfigEffective() {
  const raw = getUserConfigRaw();
  if (app.isPackaged) return raw;
  const overrides = getEnvOverrides(raw);
  if (!Object.keys(overrides).length) return raw;
  return { ...raw, ...overrides };
}

function getDataFile() {
  const resolved = resolveBusinessPaths();
  return resolved.outstanding;
}
function getQueueDir() {
  const resolved = resolveBusinessPaths();
  return resolved.queueDir;
}
function getQueueFile(queue) {
  const resolved = resolveBusinessPaths();
  if (queue === 'SAGE_AR') return resolved.sageAr;
  if (queue === 'CASH_SALE') return resolved.cashSales;
  return resolved.outstanding;
}
function ensureDataFileAt(file) {
  try {
    ensureDir(path.dirname(file));
    if (!fs.existsSync(file)) fs.writeFileSync(file, '[]', 'utf-8');
  } catch (e) {
    console.error('[ensureDataFileAt]', file, e);
  }
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
  writeJsonAtomic(file, JSON.stringify(items ?? [], null, 2));
}
function readQueueItems(queue) {
  const file = getQueueFile(queue);
  const items = readItemsAt(file);
  return (items || []).map((it) => ({
    ...it,
    accountingPath: queue,
  }));
}
function readItems() {
  return [
    ...readQueueItems('OUTSTANDING'),
    ...readQueueItems('SAGE_AR'),
    ...readQueueItems('CASH_SALE'),
  ];
}

const itemsService = createItemsService({
  getQueueFile,
  readItemsAt,
  writeItemsAt,
  splitItemsByQueue,
  randomUUID,
});
const { readAllQueueItems, writeItems } = itemsService;

function getOrdersFile() {
  const resolved = resolveBusinessPaths();
  return resolved.orders;
}
function readOrders() {
  return readItemsAt(getOrdersFile());
}
function ensureArchiveFileAt(file) {
  ensureDataFileAt(file);
}
function getArchiveFile() {
  const resolved = resolveBusinessPaths();
  return resolved.archived;
}
function writeOrdersAt(file, orders) {
  backupFile(file);
  ensureDataFileAt(file);
  writeJsonAtomic(file, JSON.stringify(orders ?? [], null, 2));
}
function writeOrders(orders) {
  return writeOrdersAt(getOrdersFile(), orders);
}

const sageDomain = createSageDomain({ readOrders, writeOrders, orderMatchesKey });
const { applySageResult, applyReconcileResult, applyInvoiceResult } = sageDomain;

const vendorOrdersService = createVendorOrdersService({
  ensureDir,
  VENDOR_PATHS,
  readOrders,
  writeOrders,
  getOrdersFile,
  loadConfig,
  getWorldOrders,
  getTransbecOrders,
  getProforceOrders,
  getCbkOrders,
  getBestBuyOrders,
});
const {
  fetchWorldOrders,
  fetchTransbecOrders,
  fetchProforceOrders,
  fetchCbkOrders,
  fetchBestBuyOrders,
} = vendorOrdersService;

function ensureDir(dirPath) {
  try { fs.mkdirSync(dirPath, { recursive: true }); } catch {}
}

const appConfigService = createAppConfigService({
  fs,
  dialog,
  path,
  INSTANCE_DIR,
  BUSINESS_FILE_LIST,
  getSharedDirInfo,
  ensureDir,
  writeAppConfig,
});
const {
  promptForSharedFolderIfMissing,
  maybeOfferMigrationToShared,
  migrateBusinessFilesToShared,
} = appConfigService;

function writeJsonAtomic(filePath, jsonString) {
  const dir = path.dirname(filePath);
  ensureDir(dir);
  const tmp = path.join(dir, `${path.basename(filePath)}.tmp.${process.pid}.${Date.now()}`);
  fs.writeFileSync(tmp, jsonString, 'utf-8');
  try {
    fs.renameSync(tmp, filePath);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  }
}

function getSharedBubbleDataPath() {
  const { sharedDir } = getSharedDirInfo();
  return path.join(sharedDir, SHARED_BUBBLE_FILE);
}

function ensureSharedBubbleFile() {
  const target = getSharedBubbleDataPath();
  ensureDir(path.dirname(target));
  if (!fs.existsSync(target)) {
    fs.writeFileSync(target, JSON.stringify({ bubbles: {} }, null, 2), 'utf-8');
  }
  return target;
}

function readSharedBubbleData() {
  try {
    const target = ensureSharedBubbleFile();
    const raw = fs.readFileSync(target, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch (e) {
    console.error('[shared-bubble read]', e);
  }
  return { bubbles: {} };
}

function writeSharedBubbleData(bubbleId, payload) {
  if (!bubbleId) return { ok: false, error: 'bubbleId required' };
  try {
    const target = ensureSharedBubbleFile();
    const current = readSharedBubbleData();
    const bubbles = current.bubbles && typeof current.bubbles === 'object' ? { ...current.bubbles } : {};
    const next = {
      ...(payload || {}),
      id: bubbleId,
    };
    bubbles[bubbleId] = next;
    writeJsonAtomic(target, JSON.stringify({ bubbles }, null, 2));
    return { ok: true, path: target, data: { bubbles } };
  } catch (e) {
    console.error('[shared-bubble write]', e);
    return { ok: false, error: e?.message || 'Failed to write shared bubble data' };
  }
}

function deleteSharedBubbleData(bubbleId) {
  if (!bubbleId) return { ok: false, error: 'bubbleId required' };
  try {
    const target = ensureSharedBubbleFile();
    const current = readSharedBubbleData();
    const bubbles = current.bubbles && typeof current.bubbles === 'object' ? { ...current.bubbles } : {};
    delete bubbles[bubbleId];
    writeJsonAtomic(target, JSON.stringify({ bubbles }, null, 2));
    return { ok: true, path: target };
  } catch (e) {
    console.error('[shared-bubble delete]', e);
    return { ok: false, error: e?.message || 'Failed to delete shared bubble data' };
  }
}

function readArchivedEntries() {
  const file = getArchiveFile();
  ensureArchiveFileAt(file);
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    console.error('[archive] read failed', e);
    return [];
  }
}

function writeArchivedEntries(entries) {
  const file = getArchiveFile();
  ensureArchiveFileAt(file);
  backupFile(file);
  writeJsonAtomic(file, JSON.stringify(entries ?? [], null, 2));
}



function writeTempOrder(order) {
  try {
    fs.writeFileSync(SAGE_TEMP_ORDER, JSON.stringify(order || {}, null, 2), 'utf-8');
    return SAGE_TEMP_ORDER;
  } catch (e) {
    console.error('[sage] failed to write temp order', e);
    return null;
  }
}



let win = null;
let boundsSaveTimeout = null;

const sageService = createSageService({
  fs,
  path,
  spawn,
  app,
  SAGE_AHK_SCRIPT,
  SAGE_RECONCILE_SCRIPT,
  SAGE_INVOICE_SCRIPT,
  SAGE_TEMP_ORDER,
  getOrdersFile,
  backupFile,
  writeTempOrder,
  getAhkExePath,
  extractJournalLine,
  extractSageTotal,
  extractReconcileApplied,
  getVendorName,
  normalizeOrderRef,
  readOrders,
  applySageResult,
  applyInvoiceResult,
  applyReconcileResult,
  getSageIntegrationActive: () => sageIntegrationActive,
});
const {
  runSagePurchase,
  runSageReconcile,
  runUpdateInvoice,
  processSageOrdersQueue,
  processInvoiceUpdateQueue,
  scheduleSageProcessing,
  resetSageQueue,
} = sageService;

const watchersService = createWatchersService({
  fs,
  getWin: () => win,
  getQueueFile,
  getOrdersFile,
  ensureDataFileAt,
  ensureSharedBubbleFile,
  readItems,
  readOrders,
  readSharedBubbleData,
  scheduleSageProcessing,
  getSageIntegrationActive: () => sageIntegrationActive,
});
const {
  startWatching,
  startBubbleSharedWatching,
  startOrdersWatching,
  stopOrdersWatching,
} = watchersService;

const updatesService = createUpdatesService({
  autoUpdater,
  app,
  getWin: () => win,
});
const { setupAutoUpdater, sendUpdateStatus } = updatesService;



// ---- window ----
async function createWindow() {
  // restore any saved custom data file path
  ensureConfigFile();
  ensureAppConfigFile();
  ensureBusinessFiles();
  const cfg = readConfig();
  if (cfg.dataFile && typeof cfg.dataFile === 'string') {
    dataFileOverride = cfg.dataFile;
  }
  const windowBounds = cfg.windowBounds || {};
  const displayBounds = screen.getPrimaryDisplay()?.workArea || {};
  const defaultWidth = Number(displayBounds.width) || Number(windowBounds.width) || 1280;
  const defaultHeight = Number(displayBounds.height) || Number(windowBounds.height) || 900;
  const defaultX = Number.isFinite(displayBounds.x) ? displayBounds.x : (Number.isFinite(windowBounds.x) ? windowBounds.x : undefined);
  const defaultY = Number.isFinite(displayBounds.y) ? displayBounds.y : (Number.isFinite(windowBounds.y) ? windowBounds.y : undefined);
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
  win.maximize();

  setupAutoUpdater();

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
  startBubbleSharedWatching(win);
  registerAllIpc();

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


app.whenReady().then(async () => {
  ensureAppConfigFile();
  try {
    await promptForSharedFolderIfMissing();
  } catch (e) {
    console.warn('[app-config] prompt for shared folder failed', e);
  }
  try {
    await maybeOfferMigrationToShared();
  } catch (e) {
    console.warn('[app-config] migration prompt failed', e);
  }
  ensureBusinessFiles();
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

let ipcRegistered = false;
function registerAllIpc() {
  if (ipcRegistered) return;
  ipcRegistered = true;

  const { registerItemsIpc } = require('./main/ipc/items.ipc');
  const { registerOrdersIpc } = require('./main/ipc/orders.ipc');
  const { registerStockFlowIpc } = require('./main/ipc/stockflow.ipc');
  const { registerSettingsIpc } = require('./main/ipc/settings.ipc');
  const { registerUpdatesIpc } = require('./main/ipc/updates.ipc');

  const deps = {
    getWin: () => win,
    fs,
    dialog,
    shell,
    app,
    autoUpdater,
    sendUpdateStatus,
    LOCK_DURATION_MS,
    INSTANCE_DIR,
    INSTANCE_PATHS,
    VENDOR_PATHS,
    readItems,
    writeItems,
    getDataFile,
    readConfig,
    writeConfig,
    startWatching,
    setDataFileOverride: (next) => { dataFileOverride = next; },
    cleanExpiredLocks,
    readOrders,
    writeOrders,
    getOrdersFile,
    resetSageQueue,
    stopOrdersWatching,
    startOrdersWatching,
    scheduleSageProcessing,
    getSageIntegrationActive: () => sageIntegrationActive,
    setSageIntegrationActive: (next) => { sageIntegrationActive = next; },
    syncOutstandingInvoices,
    makeOutstandingFromLine,
    loadConfig,
    fetchWorldOrders,
    fetchTransbecOrders,
    fetchProforceOrders,
    fetchCbkOrders,
    fetchBestBuyOrders,
    orderMatchesKey,
    runSageReconcile,
    applyReconcileResult,
    readSharedBubbleData,
    getSharedBubbleDataPath,
    writeSharedBubbleData,
    deleteSharedBubbleData,
    readArchivedEntries,
    writeArchivedEntries,
    getArchiveFile,
    searchArchiveEntries,
    normalizeSharedBubblePayload,
    readUIState,
    writeUIState,
    saveConfig,
    getUserConfigRaw,
    getUserConfigEffective,
    getEnvOverrides,
    ensureConfigFile,
    readAppConfig,
    ensureBusinessFiles,
    getSharedDirInfo,
    writeAppConfig,
    startBubbleSharedWatching,
    validateWritable,
    migrateBusinessFilesToShared,
    getResolvedPathsSummary,
    getAhkExePath,
    validateAhkExePath,
  };

  registerItemsIpc(ipcMain, deps);
  registerOrdersIpc(ipcMain, deps);
  registerStockFlowIpc(ipcMain, deps);
  registerSettingsIpc(ipcMain, deps);
  registerUpdatesIpc(ipcMain, deps);
}
function readUIState() {
  try {
    if (fs.existsSync(INSTANCE_PATHS.uiState)) {
      const json = JSON.parse(fs.readFileSync(INSTANCE_PATHS.uiState, 'utf-8'));
      return typeof json === 'object' && json ? json : {};
    }
  } catch (e) {
    console.error('[ui-state read]', e);
  }
  return {};
}
function writeUIState(state) {
  try {
    fs.writeFileSync(INSTANCE_PATHS.uiState, JSON.stringify(state || {}, null, 2), 'utf-8');
  } catch (e) {
    console.error('[ui-state write]', e);
  }
}
