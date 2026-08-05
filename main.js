// main.js
const { app, BrowserWindow, ipcMain, dialog, shell, screen } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');
const { spawn } = require('child_process');
const { createItemsDomain } = require('./main/domain/items.domain');
const {
  normalizeOrderRef,
  orderMatchesKey,
  getVendorName,
  sageOrderLockIsLive,
  isOrderSageLocked,
  mergeOrdersForWrite,
  buildArchivedKeySet,
} = require('./main/domain/orders.domain');
const { extractJournalLine, extractSageTotal, extractReconcileApplied, createSageDomain } = require('./main/domain/sage.domain');
const { searchArchiveEntries } = require('./main/domain/archive.domain');
const { locatePart } = require('./main/domain/locate.domain');
const { normalizeSharedBubblePayload } = require('./main/domain/sharedBubble.domain');
const { createItemsService } = require('./main/services/items.service');
const { createSalesOrderPrintsService } = require('./main/services/salesOrderPrints.service');
const { createWatchersService } = require('./main/services/watchers.service');
const { createVendorOrdersService } = require('./main/services/vendorOrders.service');
const { createSageService } = require('./main/services/sage.service');
const { configureSageQueue } = require('./main/services/sage.actions');
const { createAppConfigService } = require('./main/services/appConfig.service');
const { createUpdatesService } = require('./main/services/updates.service');
// Shared business data is replicated as a CRDT (see main/crdt/README.md).
// Machines exchange append-only op logs instead of overwriting shared JSON
// files, which is what removes lost updates between machines on the share.
const { createCrdtLayer } = require('./main/crdt');

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
const { fetchProforceCreditInvoices } = require('./src/scrapers/proforceCreditInvoice');
const { fetchTransbecCreditInvoices } = require('./src/scrapers/transbecCreditInvoice');
const { fetchCbkInvoices } = require('./src/scrapers/cbkInvoice');
const { runInteractiveAuth, verifyConnection } = require('./src/scrapers/gmail.auth');
const {
  openCloverSession,
  scrapeCloverPayments,
  closeCloverSession,
  getCloverStatus,
} = require('./src/scrapers/cloverScraper');
const { resolveCapCode } = require('./src/scrapers/capRules');

const isDev = !app.isPackaged;


const itemsDomain = createItemsDomain({ randomUUID });
const {
  toMoneyString,
  computeAllocatedFor,
  toDDMMYYYY,
  makeOutstandingFromLine,
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
  orderAssignments: 'order_assignments.json',
  payments: 'payments.json',
  paymentsBackup: 'payments.json.bak',
  // Every Clover payment id ever scraped, so a payment the user has since
  // edited or deleted is never re-imported. Shared, like payments.json itself:
  // a scrape on one machine must not reappear on another.
  cloverLedger: 'clover_scraped.json',
  archived: 'archived_bubbles.json',
  archivedBackup: 'archived_bubbles.json.bak',
  // One row per "Send to Sage Sales" run: what was sold, which payment settled
  // it, and the Sage invoice number the AHK read off the form. Shared, because
  // the report has to show every run whichever machine made it.
  sageSalesRuns: 'sage_sales_runs.json',
  sageSalesRunsBackup: 'sage_sales_runs.json.bak',
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
// Clover keeps nothing shared: no session is stored (the user logs in by hand
// every time) and the only thing ever written is a page snapshot when a scrape
// comes back empty, which is machine-local troubleshooting, not business data.
function getCloverDebugDir() {
  return path.join(INSTANCE_DIR, 'clover');
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
function getProforceCreditInvoiceCachePath() {
  return path.join(getGmailAssetsDir(), 'proforce_credit_invoice_cache.json');
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
  const scrapersHeadless =
    typeof raw.scrapersHeadless === 'boolean' ? raw.scrapersHeadless : false;
  const qtyThresholdRaw = Number(raw.qtyDiscrepancyThreshold);
  const qtyDiscrepancyThreshold = Number.isFinite(qtyThresholdRaw) && qtyThresholdRaw >= 0 ? qtyThresholdRaw : 15;
  const qtyTaxRateRaw = Number(raw.qtyDiscrepancyTaxRate);
  const qtyDiscrepancyTaxRate =
    Number.isFinite(qtyTaxRateRaw) && qtyTaxRateRaw >= 0 && qtyTaxRateRaw <= 1 ? qtyTaxRateRaw : 0.13;
  return {
    sharedDataDir,
    ahkExePath,
    sageAhkTimeoutMs,
    itemsReplaceAll,
    scrapersHeadless,
    qtyDiscrepancyThreshold,
    qtyDiscrepancyTaxRate,
    instanceDataDir: INSTANCE_DIR,
  };
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
function getScrapersHeadless() {
  const cfg = readAppConfig();
  return cfg?.scrapersHeadless === true;
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
    orderAssignments: path.join(queueDir, BUSINESS_FILE_BASENAMES.orderAssignments),
    payments: path.join(queueDir, BUSINESS_FILE_BASENAMES.payments),
    paymentsBackup: path.join(queueDir, BUSINESS_FILE_BASENAMES.paymentsBackup),
    cloverLedger: path.join(queueDir, BUSINESS_FILE_BASENAMES.cloverLedger),
    archived: path.join(sharedDir, BUSINESS_FILE_BASENAMES.archived),
    archivedBackup: path.join(sharedDir, BUSINESS_FILE_BASENAMES.archivedBackup),
    sageSalesRuns: path.join(queueDir, BUSINESS_FILE_BASENAMES.sageSalesRuns),
    sageSalesRunsBackup: path.join(queueDir, BUSINESS_FILE_BASENAMES.sageSalesRunsBackup),
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
    resolved.sageSalesRuns,
    resolved.sageSalesRunsBackup,
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
    sage_sales_runs: { path: resolved.sageSalesRuns, exists: fs.existsSync(resolved.sageSalesRuns) },
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
// Read-then-write rather than fs.copyFileSync: on Windows a copy goes through
// CopyFileExW, which opens the SOURCE denying delete-sharing. Every write backs
// the file up first, so on the shared drive that left a window — as long as it
// takes to copy orders.json over SMB — where no other machine could rename its
// temp file over the original, surfacing as
//   EPERM: operation not permitted, rename '...orders.json.tmp.NNN' -> '...orders.json'
// fs.readFileSync shares delete, so the same backup no longer blocks a
// concurrent atomic replace.
function backupFile(srcPath, suffix = '.bak') {
  try {
    if (!fs.existsSync(srcPath)) return;
    const dir = path.dirname(srcPath);
    const base = path.basename(srcPath);
    const target = path.join(dir, `${base}${suffix}`);
    fs.writeFileSync(target, fs.readFileSync(srcPath));
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

// Bubble edit locks lived here — bubble_locks.json plus its read/write/release
// helpers. Removed with the rest of the lock: concurrent edits to one bubble
// merge per field now, so there is nothing left to serialize. bubble_locks.json
// on the share is inert and can be deleted; nothing reads or writes it.

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
  // ensureDataFileAt below creates an empty [] when the file is absent, which is
  // right on first run but would otherwise turn "the file vanished" into a
  // silent empty list — and the next save would then commit that emptiness. A
  // populated .bak next to a missing primary is the signature of a deleted (not
  // new) file, so refuse rather than guess. Atomic renames never leave the
  // primary missing, so this only fires for a non-atomic writer or a hiccup.
  try {
    if (!fs.existsSync(file)) {
      const bak = `${file}.bak`;
      if (fs.existsSync(bak) && fs.statSync(bak).size > 2) {
        const err = new Error(
          `${path.basename(file)} is missing but its backup still has data — refusing to treat it as empty.`
        );
        err.code = 'ITEMS_READ_FAILED';
        err.file = file;
        throw err;
      }
    }
  } catch (e) {
    if (e?.code === 'ITEMS_READ_FAILED') throw e;
    // stat/exists failure: fall through to the normal read + retry path
  }
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
// writeItemsAt used to live here — the whole-file replace of one queue. Every
// queue file is a projection now and is written by main/crdt/projections.js.
// ---- replicated store ----
//
// Everything below that reads or writes shared business data goes through this
// layer. It keeps the old function names and signatures on purpose — the
// concurrency fix is underneath them, not spread across their several hundred
// call sites. See main/crdt/index.js for what changed semantically (in short:
// a save publishes the fields you changed, instead of overwriting the file
// with the copy you happened to be holding).
//
// The functions passed in are hoisted declarations defined further down this
// file; the layer only calls them lazily, after startup has resolved the
// shared folder.
const crdt = createCrdtLayer({
  machineId: getMachineId(),
  getSharedDataDir,
  resolveBusinessPaths,
  getSharedBubbleFile: () => getSharedBubbleDataPath(),
  writeJsonAtomic,
  buildOrdersIndex,
  instanceDir: INSTANCE_DIR,
  onChange: (summary) => onCrdtChange(summary),
});

function readItems() {
  return crdt.readItems();
}

const itemsService = createItemsService({
  getQueueFile,
  readAllQueueItems: () => crdt.readAllQueueItems(),
  writeItemRecords: (items, opts) => crdt.writeItemRecords(items, opts),
  randomUUID,
  fs,
  path,
});
const { readAllQueueItems, writeItems, readHistory } = itemsService;

const salesOrderPrintsService = createSalesOrderPrintsService({
  getQueueFile,
  fs,
  path,
  randomUUID,
});
const {
  appendPrintSnapshot,
  findPrintSnapshots,
  getPrintsFile,
} = salesOrderPrintsService;

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
  return crdt.readOrders();
}
// orders_index.json is pure derived data — it is rebuilt from the order and
// archive tables on every projection pass, so it is read from the file rather
// than replicated separately. Nothing can make it disagree with them.
function readOrdersIndex() {
  return readItemsAt(getOrdersIndexFile());
}
function readOrdersArchive() {
  return crdt.readOrdersArchive();
}
// ---- Order Assignment ledger ----
//
// A durable record of "this line's parts went there". It exists because the
// live item store is NOT a permanent history: archiving a bubble removes its
// items entirely, which would make an old, fully-handled order line read as
// untouched again. Assignment writes both the item movement (the mechanism)
// and a ledger record (the memory).
//
// Shape: { "<orderKey>": { resolved, lines: { "<idx>": { resolved, assignments: [...] } } } }
// An object, not an array — hence its own ensure/read rather than readItemsAt.
function getOrderAssignmentsFile() {
  const resolved = resolveBusinessPaths();
  return resolved.orderAssignments;
}
function ensureOrderAssignmentsFile() {
  const file = getOrderAssignmentsFile();
  try {
    ensureDir(path.dirname(file));
    if (!fs.existsSync(file)) fs.writeFileSync(file, '{}', 'utf-8');
  } catch (e) {
    console.error('[order-assignments] ensure failed', e);
  }
  return file;
}
// Rebuilt from the three flat assignment entities (see main/crdt/index.js), so
// two people working different lines of the same order no longer overwrite
// each other, and two assignments made at once no longer lose one to an array
// replace. The nested shape callers expect is unchanged.
function readOrderAssignments() {
  try {
    return crdt.readOrderAssignments();
  } catch (e) {
    // Unlike the item queues, a ledger read failure is not destructive on its
    // own — but it must not silently read as "nothing assigned", which would
    // wrongly blank the view. Surface it to the caller.
    const err = new Error(`Could not read ${BUSINESS_FILE_BASENAMES.orderAssignments}: ${e?.message || e}`);
    err.code = 'ASSIGNMENTS_READ_FAILED';
    throw err;
  }
}
function writeOrderAssignments(ledger) {
  return crdt.writeOrderAssignments(ledger ?? {});
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
  // Publishes only the fields that changed relative to what this process was
  // served, and removes only orders the caller actually saw and left out — so
  // an order another machine added mid-edit is no longer collateral damage.
  // orders_index.json is refreshed as part of the projection pass.
  return crdt.writeOrders(orders);
}
// Remove exactly the orders we just archived or deleted.
//
// This used to be a careful workaround: archiving does real work in between
// (adding parts to Outstanding, reconciling a credit against stock, writing the
// 3.5MB archive over SMB), and writing back the pre-work array erased anything
// another machine had added in that window. Removal was therefore expressed as
// a set operation against a fresh read, COUNTED per `reference|source` key —
// because that key wasn't unique, and archiving one of two orders sharing a
// reference had to remove exactly one of them.
//
// Orders carry a stable `__uid` now, so removal is just "delete these records"
// and the counting is gone. A fallback that matched on `reference|source` for
// orders predating the stamp went with it: every order on the share carries a
// __uid, so it could no longer fire, and a key-based match is exactly the
// ambiguity __uid was introduced to end.
function removeOrdersFromDisk(removedOrders) {
  const fresh = readOrders() || [];
  const doomed = new Set();
  (removedOrders || []).forEach((o) => {
    if (o && o.__uid) doomed.add(o.__uid);
    else console.warn('[orders] removal skipped — order carries no __uid', o?.reference || '(no ref)');
  });

  if (doomed.size) crdt.removeOrders(Array.from(doomed));
  return fresh.filter((o) => !(o && doomed.has(o.__uid)));
}

// Read-modify-write a SINGLE order on disk. Every Sage lock transition and both
// Sage triggers go through here rather than riding along on the renderer's bulk
// save, so a minutes-old in-memory array can never travel with them.
function patchOrderOnDisk(refKey, patch) {
  const key = (refKey || '').toString().trim().toUpperCase();
  if (!key) return null;
  const list = readOrders() || [];
  let updated = null;
  const next = list.map((o) => {
    if (!o || updated || !orderMatchesKey(o, key)) return o;
    const patchVal = typeof patch === 'function' ? patch(o) : patch || {};
    if (!patchVal) return o;
    updated = { ...o, ...patchVal, lastUpdatedAt: new Date().toISOString() };
    return updated;
  });
  if (!updated) return null;
  // Commit just this order rather than the whole list. readOrders() above
  // established the baseline, so only the patched fields become ops.
  crdt.store.commit('order', [updated]);
  return updated;
}

// stage: 'queued' (waiting for the Sage machine to pick it up), 'running' (AHK
// is driving Sage right now) or 'reconcile'. startedAt is kept from the first
// transition so the staleness window covers the whole round trip.
function setSageOrderLock(refKey, stage, extra = {}) {
  return patchOrderOnDisk(refKey, (order) => {
    const prev = order?.sage_lock && typeof order.sage_lock === 'object' ? order.sage_lock : null;
    const now = Date.now();
    return {
      sage_lock: {
        ...(prev || {}),
        machineId: getMachineId(),
        stage,
        startedAt: prev?.startedAt || now,
        heartbeatAt: now,
        ...extra,
      },
    };
  });
}

function clearSageOrderLock(refKey, patch = {}) {
  return patchOrderOnDisk(refKey, { sage_lock: null, ...patch });
}

function writeOrdersArchive(orders) {
  return crdt.writeOrdersArchive(orders);
}
// writeOrdersIndex went with refreshOrdersIndex — orders_index.json is written
// by the projection pass now, from buildOrdersIndex below.
function getPaymentsFile() {
  const resolved = resolveBusinessPaths();
  return resolved.payments;
}
function readPayments() {
  return crdt.readPayments();
}
function writePayments(payments) {
  crdt.writePayments(payments);
  return { ok: true, path: getPaymentsFile() };
}
function getSageSalesRunsFile() {
  const resolved = resolveBusinessPaths();
  return resolved.sageSalesRuns;
}
function readSageSalesRuns() {
  return crdt.readSageSalesRuns();
}
function writeSageSalesRuns(runs) {
  crdt.writeSageSalesRuns(runs);
  return { ok: true, path: getSageSalesRunsFile() };
}
function getCloverLedgerFile() {
  const resolved = resolveBusinessPaths();
  return resolved.cloverLedger;
}
function readCloverLedger() {
  return crdt.readCloverLedger();
}
function writeCloverLedger(entries) {
  crdt.writeCloverLedger(entries);
  return { ok: true, path: getCloverLedgerFile() };
}
function buildOrdersIndex(activeOrders, archivedOrders) {
  const indexByKey = new Map();
  const add = (order, archived) => {
    if (!order) return;
    const key = normalizeOrderRef(order);
    if (!key) return;
    const existing = indexByKey.get(key);
    if (existing) {
      // Already indexed from the active list. If it ALSO turns up in the
      // archive, record that rather than discarding it: an order present in
      // both IS a resurrected one, and indexing it as merely active is what
      // would blind the guard in mergeOrdersForWrite to it forever. The active
      // entry still supplies reference/source.
      if (archived && !existing.archived) {
        existing.archived = true;
        existing.archivedAt = order.archivedAt || existing.archivedAt || null;
      }
      return;
    }
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
// Keys of every order already in the archive, for mergeOrdersForWrite's
// resurrection guard. Read fresh on each save — the index is rewritten whenever
// anything is archived. Fails OPEN: an unreadable index must never start
// silently dropping orders from a save, it just leaves the guard inactive.
function getArchivedOrderKeys() {
  try {
    return buildArchivedKeySet(readOrdersIndex());
  } catch (e) {
    console.error('[orders] archive guard disabled — orders index unreadable', e?.message || e);
    return new Set();
  }
}
// refreshOrdersIndex used to live here. orders_index.json is rebuilt as part of
// every projection pass now (main/crdt/projections.js), from the same merged
// order + archive tables the other files come from, so it cannot drift out of
// step with them and nothing needs to force it.
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
  if (isOrderSageLocked(order)) return false;   // see meetsArchiveCriteria
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
  // Never archive an order the Sage pipeline currently holds. An invoice re-run
  // happens on an order that is ALREADY enteredInSage, so every other criterion
  // below can be satisfied while a run is mid-flight on another machine —
  // archiving it there would pull it out from under the AHK.
  if (isOrderSageLocked(order)) return false;
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
  const updatedLineItems = order.lineItems.map((line, idx) => {
    if (!line || line.addedToOutstanding === true) return line;
    newItems.push({ ...makeOutstandingFromLine(order, line, idx), allocated_to: 'NEW STOCK' });
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

  let archivedCount = 0;
  const newlyArchivedOrders = [];
  // The orders as they were BEFORE processing — removeOrdersFromDisk matches on
  // reference+source, which processing never changes, but keeping the originals
  // makes that independence explicit.
  const archivedSourceOrders = [];
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
        archivedSourceOrders.push(order);
      }
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
  // Removal-only against a fresh read: the active list was loaded before the
  // Outstanding/credit/archive writes above, which take seconds over SMB.
  const remainingActive = removeOrdersFromDisk(archivedSourceOrders);

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
    remaining: remainingActive.length,
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

// Never let a bad/missing rule break a search — a blank capCode just falls the
// archive view back to the raw "<line> <part>" comparison.
function resolveCapCodeForLine(warehouse, line) {
  try {
    const r = resolveCapCode(warehouse, line?.partLineCode, line?.partNumber, line?.partDescription);
    return (r?.code || '').trim();
  } catch (e) {
    console.error('[archive search] capCode resolve failed', e?.message);
    return '';
  }
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
        // The code this line WOULD carry as a stock item. makeOutstandingFromLine
        // runs every line through the CAP rules before storing it, so for some
        // warehouses the stored itemcode differs from the raw "<line> <part>"
        // (Transbec: "TRB BCD1210" -> "BCD 1210"). Resolve it here, with the
        // same warehouse precedence, so the archive view can match a line
        // against live stock and item history instead of missing it entirely.
        capCode: resolveCapCodeForLine(warehouse || order?.source || '', line),
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
  (active || []).forEach((order) => {
    if (!order || found) return;
    if (orderMatchesKeyAndSource(order, key, src)) found = order;
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
  const remainingActive = removeOrdersFromDisk([found]);

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

  return { ok: true, archived: 1, remaining: remainingActive.length };
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
  const matched = [];
  (active || []).forEach((order) => {
    if (order && orderMatchesKeyAndSource(order, key, src)) {
      removed += 1;
      matched.push(order);
    }
  });
  if (!removed) return { ok: false, error: 'Order not found.' };
  const remainingActive = removeOrdersFromDisk(matched);
  return { ok: true, removed, remaining: remainingActive.length };
}

const sageDomain = createSageDomain({ readOrders, writeOrders, orderMatchesKey });
const { applySageResult, applyReconcileResult, applyInvoiceResult, alignSageTotalSign } = sageDomain;

const vendorOrdersService = createVendorOrdersService({
  ensureDir,
  VENDOR_PATHS,
  readOrders,
  writeOrders,
  mergeOrdersForWrite,
  getArchivedOrderKeys,
  getArchivedOrderRefs,
  getOrdersFile,
  loadConfig,
  getScrapersHeadless,
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
  fetchProforceCreditInvoicesScraper: fetchProforceCreditInvoices,
  getEpicorAssetsDir,
  getGmailAssetsDir,
  getTransbecInvoiceCachePath,
  getBestbuyInvoiceCachePath,
  getBestbuyCreditInvoiceCachePath,
  getCbkInvoiceCachePath,
  getTransbecCreditInvoiceCachePath,
  getProforceCreditInvoiceCachePath,
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
  scanEpicorCredits,
  rescanEpicorInvoice,
  setEpicorInvoiceUnmatchable,
  getEpicorScannedInvoices,
  getEpicorScannedCredits,
  fetchTransbecInvoices: fetchTransbecInvoicesService,
  fetchBestbuyInvoices: fetchBestbuyInvoicesService,
  fetchBestbuyCreditInvoices: fetchBestbuyCreditInvoicesService,
  fetchCbkInvoices: fetchCbkInvoicesService,
  fetchTransbecCreditInvoices: fetchTransbecCreditInvoicesService,
  fetchProforceCreditInvoices: fetchProforceCreditInvoicesService,
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

// Replacing an existing file on Windows needs delete access on the DESTINATION,
// so anything holding it open without delete-sharing (antivirus mid-scan, an
// editor, AHK's FileRead, a stale SMB oplock) fails the rename with
// EPERM/EACCES/EBUSY. Those holders let go within milliseconds, so retry
// briefly instead of failing the save outright.
const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

// Blocking pause that doesn't peg a core. This runs on the main process, but
// only on a rare error path and for at most ~400ms across all retries.
function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch {}
}

function renameWithRetry(tmp, filePath, attempts = 5) {
  let lastErr = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      fs.renameSync(tmp, filePath);
      if (attempt > 0)
        console.warn('[writeJsonAtomic] rename succeeded on attempt', attempt + 1, filePath);
      return;
    } catch (e) {
      lastErr = e;
      if (!RENAME_RETRY_CODES.has(e?.code) || attempt === attempts - 1) break;
      sleepSync(40 * (attempt + 1));
    }
  }
  console.error('[writeJsonAtomic] rename failed after', attempts, 'attempts', filePath, lastErr);
  throw lastErr;
}

function writeJsonAtomic(filePath, jsonString) {
  const dir = path.dirname(filePath);
  ensureDir(dir);
  const tmp = path.join(dir, `${path.basename(filePath)}.tmp.${process.pid}.${Date.now()}`);
  fs.writeFileSync(tmp, jsonString, 'utf-8');
  try {
    renameWithRetry(tmp, filePath);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  }
}

// ---- sales order numbering ----
// One sequence for the whole business: a printed Sales Order number has to be
// unique no matter which machine printed it, so the counter lives in the shared
// folder. Read-modify-write over SMB is not atomic, so the bump is guarded by
// an exclusive-create lock file — two machines printing at the same moment must
// never draw the same number.
const SALES_ORDER_SEQ_FILE = 'sales_order_seq.json';
const SALES_ORDER_SEQ_LOCK = 'sales_order_seq.lock';
const SALES_ORDER_START = 1001;
const SALES_ORDER_PREFIX = 'SO-';
const SALES_ORDER_LOCK_STALE_MS = 15000;

function getSalesOrderSeqFile() {
  return path.join(getSharedDataDir(), SALES_ORDER_SEQ_FILE);
}

function formatSalesOrderNumber(n) {
  return `${SALES_ORDER_PREFIX}${String(n).padStart(5, '0')}`;
}

function acquireSalesOrderSeqLock() {
  const lockPath = path.join(getSharedDataDir(), SALES_ORDER_SEQ_LOCK);
  ensureDir(path.dirname(lockPath));
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      fs.writeFileSync(
        lockPath,
        JSON.stringify({ machineId: getMachineId(), at: Date.now() }),
        { flag: 'wx' }
      );
      return lockPath;
    } catch (e) {
      if (e?.code !== 'EEXIST') throw e;
      // A machine that died mid-bump must not block numbering forever.
      try {
        const st = fs.statSync(lockPath);
        if (Date.now() - st.mtimeMs > SALES_ORDER_LOCK_STALE_MS) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch {}
      sleepSync(50);
    }
  }
  throw new Error('Sales order numbering is busy on another machine. Try again in a moment.');
}

function releaseSalesOrderSeqLock(lockPath) {
  try { fs.unlinkSync(lockPath); } catch (e) { console.error('[sales-order-seq] unlock failed', e); }
}

// Throws rather than falling back to the start of the sequence: a counter file
// that exists but can't be parsed would otherwise silently hand out numbers
// that are already on printed paperwork.
function readSalesOrderSeq() {
  const f = getSalesOrderSeqFile();
  if (!fs.existsSync(f)) return SALES_ORDER_START;
  const parsed = JSON.parse(fs.readFileSync(f, 'utf-8'));
  const next = Number(parsed?.next);
  if (!Number.isFinite(next) || next < SALES_ORDER_START) {
    throw new Error(`Sales order counter at ${f} is unreadable (next=${parsed?.next}).`);
  }
  return Math.floor(next);
}

function nextSalesOrderNumber() {
  const lockPath = acquireSalesOrderSeqLock();
  try {
    const next = readSalesOrderSeq();
    writeJsonAtomic(
      getSalesOrderSeqFile(),
      JSON.stringify(
        { next: next + 1, updatedAt: new Date().toISOString(), updatedBy: getMachineId() },
        null,
        2
      )
    );
    return { ok: true, number: next, label: formatSalesOrderNumber(next) };
  } finally {
    releaseSalesOrderSeqLock(lockPath);
  }
}

function getSharedBubbleDataPath() {
  const { sharedDir } = getSharedDirInfo();
  return path.join(sharedDir, SHARED_BUBBLE_FILE);
}

// ensureSharedBubbleFile went with the bubble-shared watcher that was its last
// caller. bubble_shared.json is a projection now — main/crdt/projections.js
// creates the directory and writes the file, so there is nothing to pre-seed.

function readSharedBubbleData() {
  return crdt.readSharedBubbleData();
}

// Each bubble is now its own replicated record. This used to read the whole
// `bubbles` map, splice one entry in and write the lot back — so two machines
// editing DIFFERENT bubbles at the same moment lost one of them entirely. A
// write now describes only the bubble it names, and only the fields that
// actually changed on it.
function writeSharedBubbleData(bubbleId, payload) {
  const res = crdt.writeSharedBubbleData(bubbleId, payload);
  return res.ok ? { ...res, path: getSharedBubbleDataPath() } : res;
}

function deleteSharedBubbleData(bubbleId) {
  const res = crdt.deleteSharedBubbleData(bubbleId);
  return res.ok ? { ...res, path: getSharedBubbleDataPath() } : res;
}

function readArchivedEntries() {
  return crdt.readArchivedEntries();
}

function writeArchivedEntries(entries) {
  return crdt.writeArchivedEntries(entries);
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
  setSageOrderLock,
  clearSageOrderLock,
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

// Push merged state to the renderer whenever the store changes, whether the
// change came from this machine or arrived in another machine's op log.
//
// This replaces the old per-file watchers. Those had to re-read and re-parse a
// whole JSON file on every event and defend against reading it mid-write; the
// store hands us the entities that actually changed, already merged, so a push
// can never carry a partial read. The "skip the push on a failed read" guard
// that used to live in watchers.service.js is therefore no longer reachable —
// there is no read to fail.
function onCrdtChange(summary = {}) {
  const changed = new Set(summary.entities || []);
  const target = typeof win !== 'undefined' ? win : null;
  if (!target || target.isDestroyed()) return;

  try {
    if (changed.has('item')) {
      // checkout, not read: this IS the renderer's new view of the world, so it
      // becomes the baseline its next save is measured against.
      const items = crdt.checkoutItems();
      target.webContents.send('items:updated', items);
      console.log('[crdt] -> items:updated', items.length, summary.local ? '(local)' : '(remote)');
    }
    if (changed.has('order') || changed.has('orderArchive')) {
      target.webContents.send('orders:updated', crdt.checkoutOrders());
      if (getSageAnyActive()) scheduleSageProcessing();
    }
    if (changed.has('bubble')) {
      target.webContents.send('bubble-shared:updated', crdt.readSharedBubbleData());
    }
    if (changed.has('payment')) {
      target.webContents.send('payments:updated', crdt.checkoutPayments());
    }
    // Any new conflict is pushed immediately — the whole point of flagging one
    // is that somebody finds out before the losing change is forgotten.
    if ((summary.conflicts || []).length) {
      target.webContents.send('crdt:conflicts', crdt.listConflicts());
      console.warn('[crdt] concurrent edits flagged for review:', summary.conflicts.length);
    }
  } catch (e) {
    console.error('[crdt] failed to push update to renderer', e);
  }
}

const watchersService = createWatchersService({
  fs,
  getWin: () => win,
  getCrdtOpsDir: () => path.join(crdt.getCrdtDir(), 'ops'),
  refreshCrdt: () => crdt.refresh(),
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
});
const {
  startWatching,
  startSageLockWatching,
} = watchersService;

const updatesService = createUpdatesService({
  autoUpdater,
  app,
  getWin: () => win,
});
const { setupAutoUpdater, stopAutoUpdater, sendUpdateStatus, beginManualCheck } = updatesService;



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
  // Always watch orders.json, not just while this machine drives Sage: the
  // machine that triggers an order has to see the result the processing machine
  // writes back, otherwise its copy goes stale and a later save reverts it.
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
  // Load the replicated store before anything reads business data. On the very
  // first run against a share this also seeds the op log from the existing JSON
  // files (once for the whole share, not once per machine) — so an existing
  // installation migrates itself with no manual step.
  try {
    const seed = crdt.start();
    if (seed.seeded) console.log('[crdt] migrated existing data into the op log');
  } catch (e) {
    console.error('[crdt] startup failed', e);
    dialog.showErrorBox(
      'Shared data could not be opened',
      `${e?.message || e}\n\nThe app will not save changes until this is resolved.`
    );
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
  try {
    stopAutoUpdater();
  } catch (e) {
    console.error('[updates] stopping update timers failed', e);
  }
  // Playwright's Chromium is a child process, not an Electron window, so it
  // outlives the app unless we close it here.
  try {
    closeCloverSession();
  } catch (e) {
    console.error('[clover] closing browser on quit failed', e);
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
    beginManualCheck,
    INSTANCE_DIR,
    INSTANCE_PATHS,
    VENDOR_PATHS,
    readItems,
    checkoutItems: () => crdt.checkoutItems(),
    writeItems,
    readHistory,
    // Replicated-store surface: conflict review + diagnostics.
    listCrdtConflicts: () => crdt.listConflicts(),
    ackCrdtConflict: (id) => crdt.ackConflict(id),
    ackAllCrdtConflicts: () => crdt.ackAllConflicts(),
    getCrdtStats: () => crdt.stats(),
    appendPrintSnapshot,
    findPrintSnapshots,
    getPrintsFile,
    getDataFile,
    readConfig,
    writeConfig,
    startWatching,
    setDataFileOverride: (next) => { dataFileOverride = next; },
    readOrders,
    writeOrders,
    getOrdersFile,
    readPayments,
    writePayments,
    getPaymentsFile,
    openCloverSession,
    scrapeCloverPayments,
    closeCloverSession,
    getCloverStatus,
    getCloverDebugDir,
    readCloverLedger,
    writeCloverLedger,
    getCloverLedgerFile,
    archiveCompletedOrders,
    archiveOrderByKey,
    deleteOrderByKey,
    searchOrdersArchive,
    purgeOldOrdersArchive,
    readOrdersArchive,
    writeOrdersArchive,
    readOrderAssignments,
    writeOrderAssignments,
    getOrderAssignmentsFile,
    randomUUID,
    resetSageQueue,
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
    scanEpicorCredits,
    rescanEpicorInvoice,
    setEpicorInvoiceUnmatchable,
    getEpicorScannedInvoices,
    getEpicorScannedCredits,
    // Passed as functions, not static strings: the shared folder is a runtime
    // Settings value, so this must resolve fresh on every image request rather
    // than bake in whatever it was when the app started.
    getEpicorAssetsDir,
    fetchTransbecInvoices: fetchTransbecInvoicesService,
    fetchBestbuyInvoices: fetchBestbuyInvoicesService,
    fetchBestbuyCreditInvoices: fetchBestbuyCreditInvoicesService,
    fetchCbkInvoices: fetchCbkInvoicesService,
    fetchTransbecCreditInvoices: fetchTransbecCreditInvoicesService,
    fetchProforceCreditInvoices: fetchProforceCreditInvoicesService,
    getTransbecCreditInvoices,
    resetTransbecCreditScans,
    connectGmail,
    getGmailStatus,
    getGmailAssetsDir,
    orderMatchesKey,
    mergeOrdersForWrite,
    getArchivedOrderKeys,
    sageOrderLockIsLive,
    isOrderSageLocked,
    setSageOrderLock,
    clearSageOrderLock,
    patchOrderOnDisk,
    runSageReconcile,
    runSageSalesInvoice,
    applyReconcileResult,
    alignSageTotalSign,
    readSageSalesRuns,
    writeSageSalesRuns,
    getSageSalesRunsFile,
    readSharedBubbleData,
    getSharedBubbleDataPath,
    writeSharedBubbleData,
    deleteSharedBubbleData,
    nextSalesOrderNumber,
    readArchivedEntries,
    writeArchivedEntries,
    getArchiveFile,
    searchArchiveEntries,
    locatePart,
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
  };

  startSageLockWatching();
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

  // Forward renderer debug logs to the main-process terminal so they can be
  // captured/copied from the console where `npm start` runs.
  ipcMain.on('debug:log', (_evt, ...args) => {
    console.log('[renderer]', ...args);
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
