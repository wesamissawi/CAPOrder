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
const { configureSageQueue } = require('./main/services/sage.actions');
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
const { getTigerOrders } = require('./src/scrapers/tigerScraper');
const { openEpicorSite } = require('./src/scrapers/epicorScraper');
const { fetchTransbecInvoices } = require('./src/scrapers/transbecInvoice');
const { fetchBestbuyInvoices } = require('./src/scrapers/bestbuyInvoice');
const { fetchBestbuyCreditInvoices } = require('./src/scrapers/bestbuyCreditInvoice');
const { fetchTransbecCreditInvoices } = require('./src/scrapers/transbecCreditInvoice');
const { fetchCbkInvoices } = require('./src/scrapers/cbkInvoice');
const { runInteractiveAuth, verifyConnection } = require('./src/scrapers/gmail.auth');

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
  ordersIndex: 'orders_index.json',
  ordersArchive: 'orders_archive.json',
  ordersArchiveBackup: 'orders_archive.json.bak',
  payments: 'payments.json',
  paymentsBackup: 'payments.json.bak',
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
  tiger: {
    dataDir: path.join(INSTANCE_DIR, 'tiger'),
    storageState: path.join(INSTANCE_DIR, 'tiger', 'tiger_storage_state.json'),
  },
  epicor: {
    // Playwright browser session (cookies) — machine-specific, stays local.
    storageState: path.join(INSTANCE_DIR, 'epicor', 'epicor_storage_state.json'),
  },
};
// Downloaded invoice assets (PDFs/images) and their caches are NOT
// instance-local: they're referenced by filename from shared orders.json
// (e.g. order.bestbuyInvoiceFile), so a fetch on one machine must be visible
// from every machine, exactly like orders.json itself. Resolved fresh on every
// call (not cached in a const) because the shared folder is a runtime Settings
// value that can change without an app restart — see getSharedDataDir().
function getEpicorAssetsDir() {
  return path.join(getSharedDataDir(), 'epicor');
}
function getGmailAssetsDir() {
  return path.join(getSharedDataDir(), 'gmail');
}
function getTransbecInvoiceCachePath() {
  return path.join(getGmailAssetsDir(), 'transbec_invoice_cache.json');
}
function getBestbuyInvoiceCachePath() {
  return path.join(getGmailAssetsDir(), 'bestbuy_invoice_cache.json');
}
function getBestbuyCreditInvoiceCachePath() {
  return path.join(getGmailAssetsDir(), 'bestbuy_credit_invoice_cache.json');
}
function getCbkInvoiceCachePath() {
  return path.join(getGmailAssetsDir(), 'cbk_invoice_cache.json');
}
function getTransbecCreditInvoiceCachePath() {
  return path.join(getGmailAssetsDir(), 'transbec_credit_invoice_cache.json');
}

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
const SAGE_SALES_SCRIPT = app.isPackaged
  ? path.join(process.resourcesPath, 'ahk', 'sage_sales_invoice.ahk')
  : path.join(__dirname, 'ahk', 'sage_sales_invoice.ahk');

let dataFileOverride = null;

function normalizeAppConfig(raw = {}) {
  const sharedDataDir = typeof raw.sharedDataDir === 'string' ? raw.sharedDataDir.trim() : '';
  const ahkExePath = typeof raw.ahkExePath === 'string' ? raw.ahkExePath.trim() : '';
  const timeoutMsRaw = Number(raw.sageAhkTimeoutMs);
  const sageAhkTimeoutMs =
    Number.isFinite(timeoutMsRaw) && timeoutMsRaw >= 10000 ? Math.round(timeoutMsRaw) : 5 * 60 * 1000;
  const itemsReplaceAll =
    typeof raw.itemsReplaceAll === 'boolean' ? raw.itemsReplaceAll : true;
  return { sharedDataDir, ahkExePath, sageAhkTimeoutMs, itemsReplaceAll, instanceDataDir: INSTANCE_DIR };
}
function ensureAppConfigFile() {
  try { ensureDir(path.dirname(INSTANCE_PATHS.appConfig)); } catch {}
  if (fs.existsSync(INSTANCE_PATHS.appConfig)) return;
  const defaults = normalizeAppConfig();
  fs.writeFileSync(INSTANCE_PATHS.appConfig, JSON.stringify(defaults, null, 2), 'utf-8');
}
// Cache the last successfully-read config. resolveBusinessPaths() re-reads the
// config on EVERY file access; if a transient read failure returned bare
// defaults (sharedDataDir: ''), every business file would silently retarget to
// the machine-local userData dir — the app would "load locally", see empty
// items, and a later save against the share could erase real data.
let lastGoodAppConfig = null;
function readAppConfig() {
  try {
    ensureAppConfigFile();
    const raw = fs.readFileSync(INSTANCE_PATHS.appConfig, 'utf-8');
    const parsed = JSON.parse(raw);
    lastGoodAppConfig = normalizeAppConfig(parsed);
    return lastGoodAppConfig;
  } catch (e) {
    console.error('[appConfig read]', e);
    if (lastGoodAppConfig) {
      console.warn('[appConfig read] using last known-good config');
      return lastGoodAppConfig;
    }
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
function getSageAhkTimeoutMs() {
  const cfg = readAppConfig();
  const val = Number(cfg?.sageAhkTimeoutMs);
  if (Number.isFinite(val) && val >= 10000) return Math.round(val);
  return 5 * 60 * 1000;
}
function getItemsReplaceAll() {
  const cfg = readAppConfig();
  return cfg?.itemsReplaceAll !== false;
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
    ordersIndex: path.join(queueDir, BUSINESS_FILE_BASENAMES.ordersIndex),
    ordersArchive: path.join(queueDir, BUSINESS_FILE_BASENAMES.ordersArchive),
    ordersArchiveBackup: path.join(queueDir, BUSINESS_FILE_BASENAMES.ordersArchiveBackup),
    payments: path.join(queueDir, BUSINESS_FILE_BASENAMES.payments),
    paymentsBackup: path.join(queueDir, BUSINESS_FILE_BASENAMES.paymentsBackup),
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
    resolved.ordersIndex,
    resolved.ordersArchive,
    resolved.ordersArchiveBackup,
    resolved.payments,
    resolved.paymentsBackup,
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
    orders_index_json: { path: resolved.ordersIndex, exists: fs.existsSync(resolved.ordersIndex) },
    orders_archive_json: { path: resolved.ordersArchive, exists: fs.existsSync(resolved.ordersArchive) },
    orders_archive_bak: { path: resolved.ordersArchiveBackup, exists: fs.existsSync(resolved.ordersArchiveBackup) },
    payments_json: { path: resolved.payments, exists: fs.existsSync(resolved.payments) },
    payments_json_bak: { path: resolved.paymentsBackup, exists: fs.existsSync(resolved.paymentsBackup) },
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
const os = require('os');
// Purchase-order processing is coordinated across machines via sage_lock.json
// (only one machine at a time). Invoice processing runs locally on any machine
// and is never gated by the lock. Track the two independently.
let sagePoActive = false;
let sageInvoiceActive = false;
const getSagePoActive = () => sagePoActive;
const getSageInvoiceActive = () => sageInvoiceActive;
const getSageAnyActive = () => sagePoActive || sageInvoiceActive;

function getMachineId() {
  return os.hostname() || 'unknown';
}

function getSageLockFile() {
  return path.join(getSharedDataDir(), 'sage_lock.json');
}

function readSageLock() {
  try {
    const f = getSageLockFile();
    if (!fs.existsSync(f)) return null;
    return JSON.parse(fs.readFileSync(f, 'utf-8'));
  } catch { return null; }
}

function writeSageLock(data) {
  try {
    const f = getSageLockFile();
    ensureDir(path.dirname(f));
    fs.writeFileSync(f, JSON.stringify(data, null, 2), 'utf-8');
  } catch (e) {
    console.error('[sage-lock] write failed', e);
  }
}

function clearSageLock() {
  try {
    const lock = readSageLock();
    if (lock && lock.machineId && lock.machineId !== getMachineId()) return;
    const f = getSageLockFile();
    if (fs.existsSync(f)) fs.unlinkSync(f);
  } catch (e) {
    console.error('[sage-lock] clear failed', e);
  }
}

// A lock is "live" only while its owner keeps heartbeating. If a machine dies or
// closes without releasing, the heartbeat goes stale and another machine may claim it.
const SAGE_LOCK_HEARTBEAT_MS = 10000;
const SAGE_LOCK_STALE_MS = 30000;
let sageHeartbeatTimer = null;

function sageLockIsLive(lock) {
  if (!lock || !lock.machineId) return false;
  const beat = lock.heartbeatAt || lock.lockedAt || 0;
  return (Date.now() - beat) < SAGE_LOCK_STALE_MS;
}

function startSageHeartbeat() {
  stopSageHeartbeat();
  sageHeartbeatTimer = setInterval(() => {
    try {
      const lock = readSageLock();
      if (lock && lock.machineId === getMachineId()) {
        writeSageLock({ ...lock, heartbeatAt: Date.now() });
      }
    } catch (e) {
      console.error('[sage-lock] heartbeat failed', e);
    }
  }, SAGE_LOCK_HEARTBEAT_MS);
  if (sageHeartbeatTimer.unref) sageHeartbeatTimer.unref();
}

function stopSageHeartbeat() {
  if (sageHeartbeatTimer) {
    clearInterval(sageHeartbeatTimer);
    sageHeartbeatTimer = null;
  }
}

// ---- bubble edit locks ----
const BUBBLE_LOCKS_FILE = 'bubble_locks.json';

function getBubbleLocksFile() {
  return path.join(getSharedDataDir(), BUBBLE_LOCKS_FILE);
}

function ensureBubbleLocksFile() {
  const f = getBubbleLocksFile();
  ensureDir(path.dirname(f));
  if (!fs.existsSync(f)) fs.writeFileSync(f, JSON.stringify({}, null, 2), 'utf-8');
  return f;
}

function readBubbleLocks() {
  try {
    const f = ensureBubbleLocksFile();
    const raw = JSON.parse(fs.readFileSync(f, 'utf-8'));
    // Prune entries with no heartbeat for 60s — definitely abandoned
    const now = Date.now();
    const cleaned = {};
    Object.entries(raw || {}).forEach(([id, lock]) => {
      if (lock && (now - (lock.lastActive || 0)) < 60000) cleaned[id] = lock;
    });
    return cleaned;
  } catch { return {}; }
}

function writeBubbleLock(bubbleId, data) {
  try {
    const f = ensureBubbleLocksFile();
    const locks = readBubbleLocks();
    locks[bubbleId] = data;
    writeJsonAtomic(f, JSON.stringify(locks, null, 2));
  } catch (e) { console.error('[bubble-lock] write failed', e); }
}

function releaseBubbleLock(bubbleId) {
  try {
    const f = ensureBubbleLocksFile();
    const locks = readBubbleLocks();
    delete locks[bubbleId];
    writeJsonAtomic(f, JSON.stringify(locks, null, 2));
  } catch (e) { console.error('[bubble-lock] release failed', e); }
}

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
// Read a JSON-array file. A missing or blank file is a legitimate empty list,
// but a file we FAILED to read or parse is NOT — returning [] for those cases
// used to let a transient network/SMB glitch or a mid-write partial read be
// mistaken for "no items", and a later save would then erase the real data.
// Such failures now throw after a few quick retries; callers must abort
// instead of writing.
function readItemsAt(file) {
  ensureDataFileAt(file);
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const raw = fs.readFileSync(file, 'utf-8');
      if (raw.trim() === '') return []; // genuinely empty file
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch (e) {
      lastErr = e;
      // brief blocking pause before retry — this is a rare error path
      const until = Date.now() + 60;
      while (Date.now() < until) { /* spin */ }
    }
  }
  console.error('[readItemsAt] unreadable after retries', file, lastErr);
  const err = new Error(`Failed to read ${path.basename(file)}: ${lastErr?.message || 'unknown error'}`);
  err.code = 'ITEMS_READ_FAILED';
  err.file = file;
  throw err;
}
function writeItemsAt(file, items) {
  ensureDataFileAt(file);
  writeJsonAtomic(file, JSON.stringify(items ?? [], null, 2));
}
function readQueueItems(queue) {
  const file = getQueueFile(queue);
  let items = readItemsAt(file);
  // Items written by legacy/AHK tools have no uid. Writes now upsert by uid
  // (no implicit deletions), so every item needs a stable identity — stamp
  // missing uids once and persist them so all machines see the same ids.
  if ((items || []).some((it) => it && !it.uid)) {
    items = (items || []).map((it) => (it && !it.uid ? { ...it, uid: randomUUID() } : it));
    try {
      writeItemsAt(file, items);
      console.log('[items] stamped missing uids in', path.basename(file));
    } catch (e) {
      console.error('[items] failed to persist stamped uids', file, e);
    }
  }
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
  fs,
  path,
});
const { readAllQueueItems, writeItems } = itemsService;

function getOrdersFile() {
  const resolved = resolveBusinessPaths();
  return resolved.orders;
}
function getOrdersIndexFile() {
  const resolved = resolveBusinessPaths();
  return resolved.ordersIndex;
}
function getOrdersArchiveFile() {
  const resolved = resolveBusinessPaths();
  return resolved.ordersArchive;
}
function readOrders() {
  return readItemsAt(getOrdersFile());
}
function readOrdersIndex() {
  return readItemsAt(getOrdersIndexFile());
}
function readOrdersArchive() {
  return readItemsAt(getOrdersArchiveFile());
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
  const res = writeOrdersAt(getOrdersFile(), orders);
  refreshOrdersIndex(orders);
  return res;
}
function writeOrdersArchive(orders) {
  const file = getOrdersArchiveFile();
  backupFile(file);
  ensureDataFileAt(file);
  writeJsonAtomic(file, JSON.stringify(orders ?? [], null, 2));
  refreshOrdersIndex(readOrders(), orders);
}
function writeOrdersIndex(index) {
  const file = getOrdersIndexFile();
  ensureDataFileAt(file);
  writeJsonAtomic(file, JSON.stringify(index ?? [], null, 2));
}
function getPaymentsFile() {
  const resolved = resolveBusinessPaths();
  return resolved.payments;
}
function readPayments() {
  return readItemsAt(getPaymentsFile());
}
function writePayments(payments) {
  const file = getPaymentsFile();
  backupFile(file);
  ensureDataFileAt(file);
  writeJsonAtomic(file, JSON.stringify(payments ?? [], null, 2));
  return { ok: true, path: file };
}
function buildOrdersIndex(activeOrders, archivedOrders) {
  const indexByKey = new Map();
  const add = (order, archived) => {
    if (!order) return;
    const key = normalizeOrderRef(order);
    if (!key || indexByKey.has(key)) return;
    const reference =
      (order.reference || order.sage_reference || order.source_invoice || "").toString().trim();
    const source = (order.source || getVendorName(order) || "").toString().trim();
    indexByKey.set(key, {
      key,
      reference,
      source,
      archived: Boolean(archived),
      archivedAt: archived ? order.archivedAt || null : null,
    });
  };

  (activeOrders || []).forEach((o) => add(o, false));
  (archivedOrders || []).forEach((o) => add(o, true));
  return Array.from(indexByKey.values());
}
function refreshOrdersIndex(activeOrders, archivedOrders) {
  const archive = Array.isArray(archivedOrders) ? archivedOrders : readOrdersArchive();
  const active = Array.isArray(activeOrders) ? activeOrders : readOrders();
  const index = buildOrdersIndex(active, archive);
  writeOrdersIndex(index);
}
function getArchivedOrderRefs(activeOrders, options = {}) {
  const vendor = (options.vendor || '').toString().trim().toLowerCase();
  const preferReferenceVendors = new Set(['world', 'transbec', 'bestbuy', 'proforce']);
  const preferReference = preferReferenceVendors.has(vendor);
  // An active order must be recognized under every value that can identify it.
  // normalizeOrderRef() prefers sage_reference (the invoice number once one is
  // filled), so keying on it alone can leave an order's own `reference` (for
  // BestBuy, the packing slip) looking archived when it is actually active.
  const activeSet = new Set(
    (activeOrders || [])
      .flatMap((o) => [normalizeOrderRef(o), o?.reference ? String(o.reference).trim().toUpperCase() : ''])
      .filter(Boolean)
  );
  const index = readOrdersIndex();
  const refs = [];
  const addRef = (val) => {
    const key = val ? String(val).trim().toUpperCase() : '';
    if (!key || activeSet.has(key)) return;
    refs.push(key);
  };
  const sourceMatches = (entrySource) => {
    if (!vendor) return true;
    const source = (entrySource || '').toString().trim().toLowerCase();
    if (!source) return false;
    return source === vendor;
  };
  if (Array.isArray(index) && index.length) {
    index.forEach((entry) => {
      if (!entry) return;
      if (!sourceMatches(entry.source)) return;
      if (preferReference) {
        addRef(entry.reference);
        addRef(entry.key);
      } else {
        addRef(entry.key);
        addRef(entry.reference);
      }
    });
    return refs;
  }
  const archive = readOrdersArchive();
  (archive || []).forEach((o) => {
    if (vendor) {
      const source = (o?.source || getVendorName(o) || '').toString().trim().toLowerCase();
      if (source && source !== vendor) return;
    }
    if (preferReference) {
      addRef(o?.reference);
    }
    const key = normalizeOrderRef(o);
    if (key && !activeSet.has(key)) refs.push(key);
  });
  return refs;
}
function parseMoney(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const num = parseFloat(String(value).replace(/[^\d.-]/g, ''));
  return Number.isFinite(num) ? num : null;
}
function parseDateMs(value) {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}
function getOrderLastUpdatedAt(order) {
  if (!order) return null;
  return (
    order.lastUpdatedAt ||
    order.last_updated_at ||
    order.updatedAt ||
    order.updated_at ||
    order.sage_processed_at ||
    order.detailFetchedAt ||
    order.orderDate ||
    order.orderDateRaw ||
    null
  );
}
function isOrderCompleteForArchive(order, minDays) {
  if (!order) return false;
  const updatedAt = getOrderLastUpdatedAt(order);
  const updatedMs = parseDateMs(updatedAt);
  if (!updatedMs) return false;
  const minDaysNum = Number(minDays);
  const cutoffDays = Number.isFinite(minDaysNum) && minDaysNum >= 0 ? minDaysNum : 2;
  const cutoffMs = cutoffDays * 24 * 60 * 60 * 1000;
  if (Date.now() - updatedMs < cutoffMs) return false;
  const billed = parseMoney(order.billed_total ?? order.billedTotal);
  const sage = parseMoney(order.sage_total_synced ?? order.sageTotalSynced);
  if (!Number.isFinite(billed) || !Number.isFinite(sage)) return false;
  const totalsMatch = Math.abs(billed - sage) < 0.01;
  return (
    order.detailStored === true &&
    order.pickedUp === true &&
    order.hasInvoiceNum === true &&
    order.totalVerified === true &&
    order.enteredInSage === true &&
    order.inStore === true &&
    order.invoiceNeedsSync === false &&
    order.valueCheckAlert === false &&
    totalsMatch
  );
}
function meetsArchiveCriteria(order) {
  if (!order) return false;
  return (
    order.detailStored === true &&
    order.pickedUp === true &&
    order.hasInvoiceNum === true &&
    order.totalVerified === true &&
    order.enteredInSage === true &&
    order.inStore === true &&
    order.invoiceNeedsSync !== true &&
    order.valueCheckAlert !== true
  );
}
// Derives a "YYYYMM" grouping key for a World order's invoice month, preferring
// sageDate (DDMMYY, the date the invoice itself is dated) and falling back to
// orderDate/archivedAt so every order still lands in some month folder.
function getInvoiceMonthFolderKey(order) {
  const sageDate = String(order?.sageDate || '').trim();
  if (/^\d{6}$/.test(sageDate)) {
    const yy = sageDate.slice(4, 6);
    const mm = sageDate.slice(2, 4);
    return `${2000 + Number(yy)}${mm}`;
  }
  const fallback = order?.orderDate || order?.archivedAt || '';
  const parsed = new Date(fallback);
  if (!isNaN(parsed.getTime())) {
    return `${parsed.getFullYear()}${String(parsed.getMonth() + 1).padStart(2, '0')}`;
  }
  return null;
}

function csvEscape(value) {
  const s = String(value ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Gather every vendor-invoice number we already have on file — from active
// orders, the orders archive, and every <vendor>_YYYYMM/invoices.csv manifest —
// so an Epicor range scan can flag invoices that are NOT yet in our records.
// Matches on invoice-number fields only (source_invoice / invoiceNum / manifest
// invoice_number), never on order reference, so a truly-missing invoice is never
// mistaken for one we already have.
function collectKnownInvoiceNumbers() {
  const known = new Set();
  const add = (v) => {
    const k = String(v || '').trim().toUpperCase();
    if (k) known.add(k);
  };
  const fromOrders = (list) => {
    (list || []).forEach((o) => {
      if (!o) return;
      add(o.source_invoice);
      add(o.invoiceNum);
    });
  };
  try { fromOrders(readOrders()); } catch (e) { console.error('[epicor-known] readOrders failed', e); }
  try { fromOrders(readOrdersArchive()); } catch (e) { console.error('[epicor-known] readOrdersArchive failed', e); }

  // Every vendor's archive manifest shares one schema:
  // reference,invoice_number,billed_total,archived_at — invoice number is col 1.
  try {
    const sharedDir = getSharedDataDir();
    fs.readdirSync(sharedDir, { withFileTypes: true }).forEach((ent) => {
      if (!ent.isDirectory() || !/_\d{6}$/.test(ent.name)) return;
      const manifestPath = path.join(sharedDir, ent.name, 'invoices.csv');
      if (!fs.existsSync(manifestPath)) return;
      const text = fs.readFileSync(manifestPath, 'utf-8');
      text.split(/\r?\n/).forEach((line) => {
        if (!line.trim() || line.startsWith('reference,')) return; // skip header/blank
        const invoice = (line.split(',')[1] || '').replace(/^"|"$/g, '').trim();
        add(invoice);
      });
    });
  } catch (e) {
    console.error('[epicor-known] manifest scan failed', e);
  }
  return known;
}

// When a World order that went through the Epicor invoice lookup gets
// archived, move its scanned invoice image out of the per-machine instance
// folder into a shared world_YYYYMM folder (creating it if needed), and
// append a row to that folder's invoices.csv manifest.
function archiveWorldEpicorAssets(archivedOrders) {
  const candidates = (archivedOrders || []).filter((o) => o && o.source === 'world' && o.epicorInvoiceImage);
  if (!candidates.length) return;

  const sharedDir = getSharedDataDir();
  const epicorDir = getEpicorAssetsDir();

  candidates.forEach((order) => {
    try {
      const sourcePath = path.join(epicorDir, order.epicorInvoiceImage);
      if (!fs.existsSync(sourcePath)) {
        console.warn(`[orders] archive: epicor invoice image missing, skipping move: ${sourcePath}`);
        return;
      }

      const monthKey = getInvoiceMonthFolderKey(order);
      if (!monthKey) {
        console.warn(`[orders] archive: could not determine invoice month for order ${order.reference}; leaving image in place`);
        return;
      }

      const destDir = path.join(sharedDir, `world_${monthKey}`);
      fs.mkdirSync(destDir, { recursive: true });

      const destPath = path.join(destDir, order.epicorInvoiceImage);
      fs.copyFileSync(sourcePath, destPath);
      fs.unlinkSync(sourcePath);

      const manifestPath = path.join(destDir, 'invoices.csv');
      const isNewManifest = !fs.existsSync(manifestPath);
      const row = [
        csvEscape(order.reference || ''),
        csvEscape(order.source_invoice || ''),
        csvEscape(order.billed_total ?? ''),
        csvEscape(order.archivedAt || ''),
      ].join(',');
      const header = 'reference,invoice_number,billed_total,archived_at\n';
      fs.appendFileSync(manifestPath, (isNewManifest ? header : '') + row + '\n', 'utf-8');

      console.log(`[orders] archived epicor invoice image for ${order.reference} -> ${destPath}`);
    } catch (e) {
      console.error(`[orders] failed to archive epicor invoice image for order ${order?.reference}`, e);
    }
  });
}

// Transbec analog of archiveWorldEpicorAssets: when a Transbec order whose
// invoice came from Gmail gets archived, move its saved invoice PDF out of the
// per-machine gmail folder into a shared transbec_YYYYMM folder and append a row
// to that folder's invoices.csv manifest.
function archiveTransbecGmailAssets(archivedOrders) {
  // transbecInvoiceFile holds the .pdf name; older records stored a .png name in
  // transbecInvoiceImage — the PDF sits beside it, so derive it for those too.
  // transbecCreditFile is the analogous field for a credit-memo order created
  // from the Transbec Credits scan (no invoice — just a credit attachment).
  const transbecPdfName = (o) =>
    o.transbecInvoiceFile ||
    o.transbecCreditFile ||
    (o.transbecInvoiceImage ? o.transbecInvoiceImage.replace(/\.png$/i, '.pdf') : '');
  const candidates = (archivedOrders || []).filter((o) => o && o.source === 'transbec' && transbecPdfName(o));
  if (!candidates.length) return;

  const sharedDir = getSharedDataDir();
  const gmailDir = getGmailAssetsDir();

  candidates.forEach((order) => {
    try {
      const monthKey = getInvoiceMonthFolderKey(order);
      if (!monthKey) {
        console.warn(`[orders] archive: could not determine invoice month for order ${order.reference}; leaving Transbec assets in place`);
        return;
      }
      const destDir = path.join(sharedDir, `transbec_${monthKey}`);
      fs.mkdirSync(destDir, { recursive: true });

      // Move the saved invoice PDF into the shared month folder.
      const fileName = transbecPdfName(order);
      const sourcePath = path.join(gmailDir, fileName);
      if (fs.existsSync(sourcePath)) {
        const destPath = path.join(destDir, fileName);
        fs.copyFileSync(sourcePath, destPath);
        fs.unlinkSync(sourcePath);
      } else {
        console.warn(`[orders] archive: Transbec invoice PDF missing for order ${order.reference}; recording manifest only`);
      }

      const manifestPath = path.join(destDir, 'invoices.csv');
      const isNewManifest = !fs.existsSync(manifestPath);
      const row = [
        csvEscape(order.reference || ''),
        csvEscape(order.source_invoice || ''),
        csvEscape(order.billed_total ?? ''),
        csvEscape(order.archivedAt || ''),
      ].join(',');
      const header = 'reference,invoice_number,billed_total,archived_at\n';
      fs.appendFileSync(manifestPath, (isNewManifest ? header : '') + row + '\n', 'utf-8');

      console.log(`[orders] archived Transbec invoice assets for ${order.reference} -> ${destDir}`);
    } catch (e) {
      console.error(`[orders] failed to archive Transbec invoice assets for order ${order?.reference}`, e);
    }
  });
}

// BestBuy analog: move the per-invoice PDF (split out of the batch) from the
// gmail folder into a shared bestbuy_YYYYMM folder, appending to invoices.csv.
function archiveBestbuyGmailAssets(archivedOrders) {
  const candidates = (archivedOrders || []).filter((o) => o && o.source === 'bestbuy' && o.bestbuyInvoiceFile);
  if (!candidates.length) return;

  const sharedDir = getSharedDataDir();
  const gmailDir = getGmailAssetsDir();

  candidates.forEach((order) => {
    try {
      const monthKey = getInvoiceMonthFolderKey(order);
      if (!monthKey) {
        console.warn(`[orders] archive: could not determine invoice month for order ${order.reference}; leaving BestBuy assets in place`);
        return;
      }
      const destDir = path.join(sharedDir, `bestbuy_${monthKey}`);
      fs.mkdirSync(destDir, { recursive: true });

      const fileName = order.bestbuyInvoiceFile;
      const sourcePath = path.join(gmailDir, fileName);
      // Batch PDFs are shared across several orders, so copy (don't move) those;
      // per-invoice split PDFs are unique to one order, so move them.
      const isBatch = /^bestbuy_batch_/i.test(fileName);
      if (fs.existsSync(sourcePath)) {
        fs.copyFileSync(sourcePath, path.join(destDir, fileName));
        if (!isBatch) fs.unlinkSync(sourcePath);
      } else {
        console.warn(`[orders] archive: BestBuy invoice PDF missing for order ${order.reference}; recording manifest only`);
      }

      const manifestPath = path.join(destDir, 'invoices.csv');
      const isNewManifest = !fs.existsSync(manifestPath);
      const row = [
        csvEscape(order.reference || ''),
        csvEscape(order.source_invoice || ''),
        csvEscape(order.billed_total ?? ''),
        csvEscape(order.archivedAt || ''),
      ].join(',');
      const header = 'reference,invoice_number,billed_total,archived_at\n';
      fs.appendFileSync(manifestPath, (isNewManifest ? header : '') + row + '\n', 'utf-8');

      console.log(`[orders] archived BestBuy invoice assets for ${order.reference} -> ${destDir}`);
    } catch (e) {
      console.error(`[orders] failed to archive BestBuy invoice assets for order ${order?.reference}`, e);
    }
  });
}

// Auto-adds any order line items not yet in Outstanding to the NEW STOCK
// bubble right before the order leaves active status — same effect as
// clicking "Bubblify" on the order, but always targets the existing NEW STOCK
// bubble instead of creating a fresh per-order one, and only touches items
// that haven't already been added (mirrors orders:bubblify-order's own guard).
// Runs for every archive path (single-order and bulk) since both funnel
// through here rather than the renderer.
function addOrderLineItemsToNewStock(order) {
  if (!order || !Array.isArray(order.lineItems)) return { order, newItems: [] };
  const newItems = [];
  const updatedLineItems = order.lineItems.map((line) => {
    if (!line || line.addedToOutstanding === true) return line;
    newItems.push({ ...makeOutstandingFromLine(order, line), allocated_to: 'NEW STOCK' });
    return { ...line, addedToOutstanding: true };
  });
  if (!newItems.length) return { order, newItems: [] };
  return { order: { ...order, lineItems: updatedLineItems }, newItems };
}

function itemCodeKey(v) {
  return String(v || '').trim().toUpperCase().replace(/\s+/g, ' ');
}

// Credit/return orders (order.isCredit === true, currently only Transbec
// credit memos — see [[transbec-credit-memos]]) run through archiving
// differently from every other order: instead of adding their (negative)
// line items as fresh NEW STOCK — which would be wrong, since a credit isn't
// new inventory arriving — this "rakes out" stock that's ALREADY sitting in
// the RETURNS bubble, matched by itemcode (partLineCode + partNumber). Per
// explicit instruction: if there's no matching item in RETURNS, the line is
// left alone entirely and NOTHING is added to stock flow for it — a credit
// with no corresponding physical return on hand must not invent a stock
// movement. Unlike addOrderLineItemsToNewStock (pure upsert of brand-new
// rows), this can both decrement an existing row's quantity and fully
// delete it, so it performs its own read+write instead of returning
// newItems for the caller to concat.
function reconcileCreditReturnAgainstStock(order) {
  if (!order || !Array.isArray(order.lineItems) || !order.lineItems.length) return order;

  let currentItems;
  try {
    currentItems = readItems() || [];
  } catch (e) {
    console.error('[orders] reconcileCreditReturnAgainstStock: readItems failed', e);
    return order;
  }

  const nowIso = new Date().toISOString();
  const upserts = [];
  const deletedUids = [];
  // Guards against two credit line items for the same part both matching the
  // same physical Returns row within one reconciliation pass.
  const consumedUids = new Set();

  const updatedLineItems = order.lineItems.map((line) => {
    if (!line || line.addedToOutstanding === true) return line;
    const code = itemCodeKey(`${line.partLineCode || ''} ${line.partNumber || ''}`);
    const returnQty = Math.abs(Number(line.quantity) || 0);
    if (!code || !returnQty) return { ...line, addedToOutstanding: true };

    const match = currentItems.find(
      (it) =>
        it &&
        !consumedUids.has(it.uid) &&
        itemCodeKey(it.itemcode) === code &&
        String(it.allocated_to || '').trim().toUpperCase() === 'RETURNS'
    );

    if (!match) {
      console.log(
        `[orders] credit ${order.reference || ''}: no matching Returns item for "${code}" — leaving stock flow untouched`
      );
      return { ...line, addedToOutstanding: true };
    }

    consumedUids.add(match.uid);
    const nextQty = (Number(match.quantity) || 0) - returnQty;
    if (nextQty > 0) {
      upserts.push({ ...match, quantity: nextQty, last_moved_at: nowIso });
    } else {
      deletedUids.push(match.uid);
    }
    return { ...line, addedToOutstanding: true };
  });

  if (upserts.length || deletedUids.length) {
    try {
      writeItems(upserts, { deletedUids });
    } catch (e) {
      console.error('[orders] reconcileCreditReturnAgainstStock: writeItems failed', e);
    }
  }

  return { ...order, lineItems: updatedLineItems };
}

function archiveCompletedOrders(options = {}) {
  let minDays = options;
  if (options && typeof options === 'object') {
    minDays = options.minDays ?? options.archiveMinDays ?? options.archiveCleanupDays;
  }
  if (minDays === undefined || minDays === null) {
    try {
      const uiState = readUIState();
      if (uiState && typeof uiState.archiveCleanupDays === 'number') {
        minDays = uiState.archiveCleanupDays;
      }
    } catch {}
  }
  const active = readOrders();
  const archive = readOrdersArchive();
  const archiveByKey = new Map();
  (archive || []).forEach((o) => {
    const key = normalizeOrderRef(o);
    if (!key || archiveByKey.has(key)) return;
    archiveByKey.set(key, o);
  });

  const keepActive = [];
  let archivedCount = 0;
  const newlyArchivedOrders = [];
  const allNewOutstandingItems = [];
  const nowIso = new Date().toISOString();

  (active || []).forEach((order) => {
    if (isOrderCompleteForArchive(order, minDays)) {
      const key = normalizeOrderRef(order);
      if (key && !archiveByKey.has(key)) {
        let processedOrder;
        if (order.isCredit) {
          // Performs its own read+write immediately (it can decrement/delete
          // existing Returns rows, not just add new ones) — see the function
          // comment for why this can't be batched with allNewOutstandingItems.
          processedOrder = reconcileCreditReturnAgainstStock(order);
        } else {
          const { order: withOutstanding, newItems } = addOrderLineItemsToNewStock(order);
          if (newItems.length) allNewOutstandingItems.push(...newItems);
          processedOrder = withOutstanding;
        }
        const archivedOrder = { ...processedOrder, archivedAt: nowIso };
        archiveByKey.set(key, archivedOrder);
        archivedCount += 1;
        newlyArchivedOrders.push(archivedOrder);
      }
    } else {
      keepActive.push(order);
    }
  });

  if (allNewOutstandingItems.length) {
    try {
      writeItems(readItems().concat(allNewOutstandingItems));
    } catch (e) {
      console.error('[orders] failed to add order items to Outstanding before bulk archive', e);
    }
  }

  const mergedArchive = Array.from(archiveByKey.values());
  writeOrdersArchive(mergedArchive);
  writeOrders(keepActive);

  try {
    archiveWorldEpicorAssets(newlyArchivedOrders);
  } catch (e) {
    console.error('[orders] archiveWorldEpicorAssets failed', e);
  }
  try {
    archiveTransbecGmailAssets(newlyArchivedOrders);
  } catch (e) {
    console.error('[orders] archiveTransbecGmailAssets failed', e);
  }
  try {
    archiveBestbuyGmailAssets(newlyArchivedOrders);
  } catch (e) {
    console.error('[orders] archiveBestbuyGmailAssets failed', e);
  }

  return {
    ok: true,
    archived: archivedCount,
    remaining: keepActive.length,
    archiveCount: mergedArchive.length,
  };
}
function purgeOldOrdersArchive(days = 90) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const archive = readOrdersArchive() || [];
  const keep = archive.filter((o) => {
    const ts = o?.archivedAt ? new Date(o.archivedAt).getTime() : NaN;
    return isNaN(ts) || ts > cutoff;
  });
  const removed = archive.length - keep.length;
  writeOrdersArchive(keep);
  return { ok: true, removed, remaining: keep.length };
}

function searchOrdersArchive(term) {
  const norm = (v) => (v ?? '').toString().trim().toLowerCase();
  const strip = (v) => v.replace(/[-\s]/g, '');
  const q = norm(term);
  const qStripped = strip(q);
  if (!q) return { ok: false, error: 'Enter a part number to search.' };

  const archive = readOrdersArchive() || [];
  const results = [];

  for (const order of archive) {
    const lineItems = Array.isArray(order?.lineItems) ? order.lineItems : [];
    const matched = lineItems.filter((line) => {
      const partNum = norm(line?.partNumber);
      const lineCode = norm(line?.partLineCode);
      const combined = lineCode ? `${lineCode} ${partNum}` : partNum;
      const partNumStripped = strip(partNum);
      const combinedStripped = strip(combined);
      return partNum.includes(q) || combined.includes(q) ||
        partNumStripped.includes(qStripped) || combinedStripped.includes(qStripped);
    });
    if (!matched.length) continue;
    const invoice = (order?.source_invoice || order?.invoiceNum || '').trim();
    const date = order?.orderDate || order?.orderDateRaw || order?.sageDate || '';
    const warehouse = (order?.warehouse || order?.seller || '').trim();
    results.push({
      reference: order?.reference || '',
      source: order?.source || '',
      invoice,
      date,
      warehouse,
      archivedAt: order?.archivedAt || '',
      lines: matched.map((line) => ({
        partNumber: line?.partNumber || '',
        partLineCode: line?.partLineCode || '',
        itemcode: line?.partLineCode ? `${line.partLineCode} ${line.partNumber}`.trim() : (line?.partNumber || ''),
        partDescription: line?.partDescription || '',
        costPrice: line?.costPrice || '',
        costPriceValue: line?.costPriceValue ?? null,
        quantity: line?.quantity ?? null,
        addedToOutstanding: line?.addedToOutstanding === true,
      })),
    });
  }

  results.sort((a, b) => String(b.archivedAt || '').localeCompare(String(a.archivedAt || '')));
  return { ok: true, results };
}

// A reference is unique per vendor but could (rarely) collide across vendors, so
// when a source is supplied we scope the match to that vendor. The archive is
// keyed by source+reference (not reference alone) for the same reason.
function normalizeSource(o) {
  return String((o && o.source) || '').trim().toUpperCase();
}
function orderMatchesKeyAndSource(order, key, src) {
  return orderMatchesKey(order, key) && (!src || normalizeSource(order) === src);
}
function archiveDedupeKey(o) {
  return `${normalizeSource(o)}|${normalizeOrderRef(o)}`;
}

function archiveOrderByKey(refKeyRaw, source) {
  const key = (refKeyRaw || '').toString().trim().toUpperCase();
  if (!key) return { ok: false, error: 'Missing reference key.' };
  const src = (source || '').toString().trim().toUpperCase();

  const active = readOrders();
  const archive = readOrdersArchive();
  const archiveByKey = new Map();
  (archive || []).forEach((o) => {
    const k = archiveDedupeKey(o);
    if (!k || archiveByKey.has(k)) return;
    archiveByKey.set(k, o);
  });

  // Only the FIRST order matching this key (and source, when given) is pulled;
  // any coincidental same-reference order from another vendor stays active
  // instead of being silently dropped.
  let found = null;
  const keepActive = [];
  (active || []).forEach((order) => {
    if (!order) return;
    if (!found && orderMatchesKeyAndSource(order, key, src)) {
      found = order;
      return;
    }
    keepActive.push(order);
  });

  if (!found) return { ok: false, error: 'Order not found.' };
  if (!meetsArchiveCriteria(found)) {
    return { ok: false, error: 'Order does not meet archive criteria.' };
  }

  if (found.isCredit) {
    found = reconcileCreditReturnAgainstStock(found);
  } else {
    const { order: withOutstanding, newItems } = addOrderLineItemsToNewStock(found);
    if (newItems.length) {
      try {
        writeItems(readItems().concat(newItems));
      } catch (e) {
        console.error('[orders] failed to add order items to Outstanding before archive', e);
      }
    }
    found = withOutstanding;
  }

  const normKey = archiveDedupeKey(found);
  let archivedOrder = null;
  if (normKey && !archiveByKey.has(normKey)) {
    archivedOrder = { ...found, archivedAt: new Date().toISOString() };
    archiveByKey.set(normKey, archivedOrder);
  }

  const mergedArchive = Array.from(archiveByKey.values());
  writeOrdersArchive(mergedArchive);
  writeOrders(keepActive);

  if (archivedOrder) {
    try {
      archiveWorldEpicorAssets([archivedOrder]);
    } catch (e) {
      console.error('[orders] archiveWorldEpicorAssets failed', e);
    }
    try {
      archiveTransbecGmailAssets([archivedOrder]);
    } catch (e) {
      console.error('[orders] archiveTransbecGmailAssets failed', e);
    }
    try {
      archiveBestbuyGmailAssets([archivedOrder]);
    } catch (e) {
      console.error('[orders] archiveBestbuyGmailAssets failed', e);
    }
  }

  return { ok: true, archived: 1, remaining: keepActive.length };
}

// Permanently drop an order from active orders.json (no archive, no invoice
// manifest) — used to clean up throwaway orders such as ones created from an
// Epicor scan by mistake. Matches on reference / invoice # / __row, scoped to
// the given vendor source when supplied so a same-reference order from another
// vendor is never removed by mistake.
function deleteOrderByKey(refKeyRaw, source) {
  const key = (refKeyRaw || '').toString().trim().toUpperCase();
  if (!key) return { ok: false, error: 'Missing reference key.' };
  const src = (source || '').toString().trim().toUpperCase();
  const active = readOrders();
  let removed = 0;
  const keep = (active || []).filter((order) => {
    if (order && orderMatchesKeyAndSource(order, key, src)) {
      removed += 1;
      return false;
    }
    return true;
  });
  if (!removed) return { ok: false, error: 'Order not found.' };
  writeOrders(keep);
  return { ok: true, removed, remaining: keep.length };
}

const sageDomain = createSageDomain({ readOrders, writeOrders, orderMatchesKey });
const { applySageResult, applyReconcileResult, applyInvoiceResult } = sageDomain;

const vendorOrdersService = createVendorOrdersService({
  ensureDir,
  VENDOR_PATHS,
  readOrders,
  writeOrders,
  getArchivedOrderRefs,
  getOrdersFile,
  loadConfig,
  getWorldOrders,
  getTransbecOrders,
  getProforceOrders,
  getCbkOrders,
  getTigerOrders,
  getBestBuyOrders,
  openEpicorSite,
  fetchTransbecInvoicesScraper: fetchTransbecInvoices,
  fetchBestbuyInvoicesScraper: fetchBestbuyInvoices,
  fetchBestbuyCreditInvoicesScraper: fetchBestbuyCreditInvoices,
  fetchCbkInvoicesScraper: fetchCbkInvoices,
  fetchTransbecCreditInvoicesScraper: fetchTransbecCreditInvoices,
  getEpicorAssetsDir,
  getGmailAssetsDir,
  getTransbecInvoiceCachePath,
  getBestbuyInvoiceCachePath,
  getBestbuyCreditInvoiceCachePath,
  getCbkInvoiceCachePath,
  getTransbecCreditInvoiceCachePath,
  runInteractiveAuth,
  verifyConnection,
  saveConfig,
  shell,
  collectKnownInvoiceNumbers,
});
const {
  fetchWorldOrders,
  fetchTransbecOrders,
  fetchProforceOrders,
  fetchCbkOrders,
  fetchTigerOrders,
  fetchBestBuyOrders,
  openEpicor,
  scanEpicorRange,
  rescanEpicorInvoice,
  getEpicorScannedInvoices,
  fetchTransbecInvoices: fetchTransbecInvoicesService,
  fetchBestbuyInvoices: fetchBestbuyInvoicesService,
  fetchBestbuyCreditInvoices: fetchBestbuyCreditInvoicesService,
  fetchCbkInvoices: fetchCbkInvoicesService,
  fetchTransbecCreditInvoices: fetchTransbecCreditInvoicesService,
  getTransbecCreditInvoices,
  resetTransbecCreditScans,
  connectGmail,
  getGmailStatus,
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
    const lines = order?.sage_lineItems || order?.lineItems || [];
    console.log('[sage] writeTempOrder costPrice debug:', lines.map((l, i) => ({
      idx: i,
      part: `${l?.partLineCode || ''} ${l?.partNumber || ''}`.trim(),
      costPrice: l?.costPrice,
      costPriceValue: l?.costPriceValue,
      environmentalFeeAmount: l?.environmentalFeeAmount,
      source: order?.sage_lineItems ? 'sage_lineItems' : 'lineItems',
    })));
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
  SAGE_SALES_SCRIPT,
  SAGE_TEMP_ORDER,
  getOrdersFile,
  backupFile,
  writeTempOrder,
  getAhkExePath,
  getSageAhkTimeoutMs,
  extractJournalLine,
  extractSageTotal,
  extractReconcileApplied,
  getVendorName,
  normalizeOrderRef,
  readOrders,
  applySageResult,
  applyInvoiceResult,
  applyReconcileResult,
  getSagePoActive,
  getSageInvoiceActive,
});
const {
  runSagePurchase,
  runSageReconcile,
  runUpdateInvoice,
  runSageSalesInvoice,
  processSageOrdersQueue,
  processInvoiceUpdateQueue,
  scheduleSageProcessing,
  resetSageQueue,
} = sageService;

// Wire AHK queue running-state into the shared lock file
configureSageQueue({
  onStart: () => {
    try {
      const lock = readSageLock();
      if (lock && lock.machineId === getMachineId()) {
        writeSageLock({ ...lock, running: true });
      }
    } catch (e) { console.error('[sage-lock] onStart update failed', e); }
  },
  onDone: () => {
    try {
      const lock = readSageLock();
      if (lock && lock.machineId === getMachineId()) {
        writeSageLock({ ...lock, running: false });
      }
    } catch (e) { console.error('[sage-lock] onDone update failed', e); }
  },
});

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
  getSageIntegrationActive: getSageAnyActive,
  getSagePoActive,
  getSageLockFile,
  readSageLock,
  sageLockIsLive,
  getMachineId,
  onSageLockForcedOff: () => {
    // The lock only governs purchase-order processing; invoices keep running locally.
    sagePoActive = false;
    stopSageHeartbeat();
  },
  getBubbleLocksFile,
  readBubbleLocks,
});
const {
  startWatching,
  startBubbleSharedWatching,
  startOrdersWatching,
  stopOrdersWatching,
  startSageLockWatching,
  startBubbleLockWatching,
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
      plugins: true,               // enables Chromium's built-in PDF viewer (Verify Invoice modal)
    },
  });
  win.maximize();

  setupAutoUpdater();

  // lifecycle logs
  win.webContents.on('did-finish-load', () => {
    console.log('[main] did-finish-load');
    // initial push (never before this). If the read fails, send nothing —
    // the renderer will fetch via items:read and surface the error itself.
    try {
      const arr = readItems();
      if (win && !win.isDestroyed()) {
        win.webContents.send('items:updated', arr);
        console.log('[main] initial items sent:', Array.isArray(arr) ? arr.length : arr);
      }
    } catch (e) {
      console.error('[main] initial items read failed — not sending', e);
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
  ensureBusinessFiles();
  try {
    refreshOrdersIndex();
  } catch (e) {
    console.warn('[orders] refresh index failed', e);
  }
  try {
    const res = archiveCompletedOrders();
    console.log('[orders] startup archive completed', res);
  } catch (e) {
    console.warn('[orders] startup archive failed', e);
  }
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
// Release the PO lock on clean exit so another machine can claim it immediately
// instead of waiting for the heartbeat to go stale.
app.on('before-quit', () => {
  try {
    stopSageHeartbeat();
    if (sagePoActive) clearSageLock();
  } catch (e) {
    console.error('[sage-lock] release on quit failed', e);
  }
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

let ipcRegistered = false;
function registerAllIpc() {
  if (ipcRegistered) return;
  ipcRegistered = true;

  const { registerAllIpc: registerAllIpcByDomain } = require('./main/ipc/ipc.registry');

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
    readPayments,
    writePayments,
    getPaymentsFile,
    archiveCompletedOrders,
    archiveOrderByKey,
    deleteOrderByKey,
    searchOrdersArchive,
    purgeOldOrdersArchive,
    readOrdersArchive,
    writeOrdersArchive,
    resetSageQueue,
    stopOrdersWatching,
    startOrdersWatching,
    scheduleSageProcessing,
    getSagePoActive,
    setSagePoActive: (next) => { sagePoActive = Boolean(next); },
    getSageInvoiceActive,
    setSageInvoiceActive: (next) => { sageInvoiceActive = Boolean(next); },
    syncOutstandingInvoices,
    makeOutstandingFromLine,
    loadConfig,
    fetchWorldOrders,
    fetchTransbecOrders,
    fetchProforceOrders,
    fetchCbkOrders,
    fetchTigerOrders,
    fetchBestBuyOrders,
    openEpicor,
    scanEpicorRange,
    rescanEpicorInvoice,
    getEpicorScannedInvoices,
    // Passed as functions, not static strings: the shared folder is a runtime
    // Settings value, so this must resolve fresh on every image request rather
    // than bake in whatever it was when the app started.
    getEpicorAssetsDir,
    fetchTransbecInvoices: fetchTransbecInvoicesService,
    fetchBestbuyInvoices: fetchBestbuyInvoicesService,
    fetchBestbuyCreditInvoices: fetchBestbuyCreditInvoicesService,
    fetchCbkInvoices: fetchCbkInvoicesService,
    fetchTransbecCreditInvoices: fetchTransbecCreditInvoicesService,
    getTransbecCreditInvoices,
    resetTransbecCreditScans,
    connectGmail,
    getGmailStatus,
    getGmailAssetsDir,
    orderMatchesKey,
    runSageReconcile,
    runSageSalesInvoice,
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
    getItemsReplaceAll,
    startBubbleSharedWatching,
    validateWritable,
    migrateBusinessFilesToShared,
    getResolvedPathsSummary,
    getAhkExePath,
    validateAhkExePath,
    readSageLock,
    writeSageLock,
    clearSageLock,
    sageLockIsLive,
    startSageHeartbeat,
    stopSageHeartbeat,
    getMachineId,
    readBubbleLocks,
    writeBubbleLock,
    releaseBubbleLock,
    getBubbleLocksFile,
  };

  startSageLockWatching();
  startBubbleLockWatching();
  registerAllIpcByDomain(ipcMain, deps);

  ipcMain.handle('dialog:confirm', async (evt, message, detail) => {
    const sender = BrowserWindow.fromWebContents(evt.sender) || win;
    const result = await dialog.showMessageBox(sender, {
      type: 'question',
      buttons: ['Cancel', 'OK'],
      defaultId: 1,
      cancelId: 0,
      message: message || 'Are you sure?',
      detail: detail || '',
    });
    return result.response === 1;
  });
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
