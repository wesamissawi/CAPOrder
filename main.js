// main.js
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');
const { spawn } = require('child_process');
const { getWorldOrders } = require('./src/scrapers/worldScraper');
const { getTransbecOrders } = require('./src/scrapers/transbecScraper');
const { getProforceOrders } = require('./src/scrapers/proforceScraper');
const { getBestBuyOrders } = require('./src/scrapers/bestBuyScraper');
const { getCbkOrders } = require('./src/scrapers/cbkScraper');

const isDev = !app.isPackaged;

const LOCK_DURATION_MS = 20000; // 20 seconds


// ---- path + config helpers ----
const INSTANCE_DIR = app.getPath('userData');
const APP_CONFIG_FILE = path.join(INSTANCE_DIR, 'app_config.json'); // stores sharedDataDir
const CONFIG_FILE = path.join(INSTANCE_DIR, 'config.json'); // window bounds + legacy userConfig
const UI_STATE_FILE = path.join(INSTANCE_DIR, 'ui_state.json');
const PRELOAD = path.resolve(__dirname, 'preload.js');

// Vendor/session data must stay instance-local
const WORLD_DATA_DIR = path.join(INSTANCE_DIR, 'world');
const WORLD_STORAGE_STATE = path.join(WORLD_DATA_DIR, 'world_storage_state.json');
const TRANSBEC_DATA_DIR = path.join(INSTANCE_DIR, 'transbec');
const TRANSBEC_STORAGE_STATE = path.join(TRANSBEC_DATA_DIR, 'transbec_storage_state.json');
const TRANSBEC_PRODUCTS_PATH = path.join(TRANSBEC_DATA_DIR, 'transbec_products.json');
const PROFORCE_DATA_DIR = path.join(INSTANCE_DIR, 'proforce');
const PROFORCE_STORAGE_STATE = path.join(PROFORCE_DATA_DIR, 'proforce_storage_state.json');
const BESTBUY_DATA_DIR = path.join(INSTANCE_DIR, 'bestbuy');
const BESTBUY_STORAGE_STATE = path.join(BESTBUY_DATA_DIR, 'bestbuy_storage_state.json');
const CBK_DATA_DIR = path.join(INSTANCE_DIR, 'cbk');
const CBK_STORAGE_STATE = path.join(CBK_DATA_DIR, 'cbk_storage_state.json');

const SAGE_AHK_SCRIPT = path.join(__dirname, 'ahk', 'sage_purchaser.ahk');
const AHK_EXECUTABLE = process.env.AHK_EXE || process.env.AUTOHOTKEY_PATH || 'AutoHotkey64.exe';
const SAGE_TEMP_ORDER = path.join(INSTANCE_DIR, 'orders.sage.tmp.json');

const BUSINESS_FILES = [
  'orders.json',
  'orders.json.bak',
  'outstanding_items.json',
  'sage_ar_items.json',
  'cash_sales_items.json',
  'archived_bubbles.json',
  'archived_bubbles.json.bak',
];
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
let dataFileOverride = null;
let ordersFileOverride = null;
let itemsWatchers = [];
let ordersWatcher = null;
let sageIntegrationActive = false;
let sageProcessing = false;
let sagePendingRun = false;
const sageProcessingRefs = new Set();

function readConfig() {
  try { if (fs.existsSync(CONFIG_FILE)) return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')); } catch {}
  return {};
}
function writeConfig(cfg) {
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf-8'); } catch (e) { console.error('[config write]', e); }
}
function ensureConfigFile() {
  if (fs.existsSync(CONFIG_FILE)) return;
  writeConfig({ userConfig: {} });
}
function ensureAppConfigFile() {
  try { ensureDir(path.dirname(APP_CONFIG_FILE)); } catch {}
  if (fs.existsSync(APP_CONFIG_FILE)) return;
  fs.writeFileSync(APP_CONFIG_FILE, JSON.stringify({ sharedDataDir: '' }, null, 2), 'utf-8');
}
function readAppConfig() {
  try {
    ensureAppConfigFile();
    const raw = fs.readFileSync(APP_CONFIG_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : { sharedDataDir: '' };
  } catch (e) {
    console.error('[appConfig read]', e);
    return { sharedDataDir: '' };
  }
}
function writeAppConfig(cfg) {
  try {
    ensureAppConfigFile();
    const base = readAppConfig();
    const next = { ...base, ...(cfg || {}) };
    fs.writeFileSync(APP_CONFIG_FILE, JSON.stringify(next, null, 2), 'utf-8');
    return next;
  } catch (e) {
    console.error('[appConfig write]', e);
    throw e;
  }
}
function getSharedDataDir() {
  const cfg = readAppConfig();
  const dir = (cfg.sharedDataDir || '').trim();
  if (dir) return dir;
  return INSTANCE_DIR; // fallback to local instance if not configured
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

function ensureBusinessFiles() {
  const dir = getSharedDataDir();
  ensureDir(dir);
  BUSINESS_FILES.forEach((name) => {
    const file = path.join(dir, name);
    if (name.endsWith('.bak')) {
      ensureDir(path.dirname(file));
    } else {
      ensureDataFileAt(file);
    }
  });
}

function getResolvedPathsSummary() {
  const sharedDir = getSharedDataDir();
  const instanceDir = INSTANCE_DIR;
  const files = {};
  BUSINESS_FILES.forEach((name) => {
    const p = path.join(sharedDir, name);
    files[name] = { path: p, exists: fs.existsSync(p) };
  });
  return { sharedDir, instanceDir, files };
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

function migrateBusinessFilesToShared(mode = 'copy') {
  const sharedDir = getSharedDataDir();
  const instanceDir = INSTANCE_DIR;
  if (!sharedDir || sharedDir === instanceDir) {
    return { ok: false, error: 'Shared folder not configured.' };
  }
  ensureDir(sharedDir);

  const results = [];
  BUSINESS_FILES.forEach((name) => {
    const src = path.join(instanceDir, name);
    const dest = path.join(sharedDir, name);
    if (!fs.existsSync(src)) {
      results.push({ name, action: 'skip', reason: 'missing source' });
      return;
    }
    if (src === dest) {
      results.push({ name, action: 'skip', reason: 'already in shared' });
      return;
    }
    if (fs.existsSync(dest)) {
      results.push({ name, action: 'skip', reason: 'dest exists' });
      return;
    }
    try {
      ensureDir(path.dirname(dest));
      if (mode === 'move') {
        fs.renameSync(src, dest);
        results.push({ name, action: 'moved', from: src, to: dest });
      } else {
        fs.copyFileSync(src, dest);
        results.push({ name, action: 'copied', from: src, to: dest });
      }
    } catch (e) {
      results.push({ name, action: 'error', error: e?.message || 'failed' });
    }
  });
  return { ok: true, sharedDir, results };
}
function getDataFile() {
  return dataFileOverride || path.join(getSharedDataDir(), 'outstanding_items.json');
}
function getQueueDir() {
  return path.dirname(getDataFile());
}
function getQueueFile(queue) {
  if (queue === 'SAGE_AR') return path.join(getQueueDir(), 'sage_ar_items.json');
  if (queue === 'CASH_SALE') return path.join(getQueueDir(), 'cash_sales_items.json');
  return getDataFile();
}
function ensureDataFileAt(file) {
  ensureDir(path.dirname(file));
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

function readAllQueueItems() {
  const queues = ['OUTSTANDING', 'SAGE_AR', 'CASH_SALE'];
  const byQueue = {};
  queues.forEach((queue) => {
    const file = getQueueFile(queue);
    byQueue[queue] = readItemsAt(file);
  });
  return byQueue;
}
function splitItemsByQueue(items) {
  const buckets = {
    OUTSTANDING: [],
    SAGE_AR: [],
    CASH_SALE: [],
  };
  (items || []).forEach((it) => {
    const queue = it?.accountingPath || 'OUTSTANDING';
    if (queue === 'SAGE_AR') buckets.SAGE_AR.push(it);
    else if (queue === 'CASH_SALE') buckets.CASH_SALE.push(it);
    else buckets.OUTSTANDING.push(it);
  });
  return buckets;
}
function writeItems(items) {
  const queues = ['OUTSTANDING', 'SAGE_AR', 'CASH_SALE'];

  // 1) Read current state of all queues
  const currentByQueue = readAllQueueItems();

  // 2) Build uid -> item map from current items
  const map = new Map();
  queues.forEach((queue) => {
    (currentByQueue[queue] || []).forEach((it) => {
      if (!it) return;
      const uid = it.uid || randomUUID();
      map.set(uid, { ...it, uid });
    });
  });

  // 3) Apply incoming items (overwrite by uid)
  const incomingUids = new Set();
  (items || []).forEach((it) => {
    if (!it) return;
    const uid = it.uid || randomUUID();
    incomingUids.add(uid);
    map.set(uid, { ...it, uid });
  });

  // 3b) Remove items that are no longer present (honor deletions)
  Array.from(map.keys()).forEach((uid) => {
    if (!incomingUids.has(uid)) {
      map.delete(uid);
    }
  });

  // 4) Split merged list back into queues
  const mergedList = Array.from(map.values());
  const buckets = splitItemsByQueue(mergedList);

  // 5) Atomically write each queue file if changed
  queues.forEach((queue) => {
    const file = getQueueFile(queue);
    const current = currentByQueue[queue] || [];
    const next = buckets[queue];
    const a = JSON.stringify(current ?? []);
    const b = JSON.stringify(next ?? []);
    if (a !== b) writeItemsAt(file, next);
  });
}

function getOrdersFile() {
  return ordersFileOverride || path.join(getSharedDataDir(), 'orders.json');
}
function readOrders() {
  return readItemsAt(getOrdersFile());
}
function ensureArchiveFileAt(file) {
  ensureDir(path.dirname(file));
  if (!fs.existsSync(file)) fs.writeFileSync(file, '[]', 'utf-8');
}
function getArchiveFile() {
  return path.join(getSharedDataDir(), 'archived_bubbles.json');
}
function writeOrdersAt(file, orders) {
  backupFile(file);
  ensureDataFileAt(file);
  writeJsonAtomic(file, JSON.stringify(orders ?? [], null, 2));
}
function writeOrders(orders) {
  return writeOrdersAt(getOrdersFile(), orders);
}
function ensureDir(dirPath) {
  try { fs.mkdirSync(dirPath, { recursive: true }); } catch {}
}

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

function toMoneyString(val) {
  if (val === null || val === undefined || val === '') return '';
  const normalized = String(val).replace(/[^\d.-]/g, '').trim();
  if (!normalized) return '';
  const num = Number(normalized);
  if (Number.isFinite(num)) return num.toFixed(2);
  return normalized;
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
    accountingPath: 'OUTSTANDING',
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
  const files = [
    getQueueFile('OUTSTANDING'),
    getQueueFile('SAGE_AR'),
    getQueueFile('CASH_SALE'),
  ];
  itemsWatchers.forEach((w) => {
    try { w.close(); } catch {}
  });
  itemsWatchers = [];
  files.forEach((file) => {
    ensureDataFileAt(file);
    const w = fs.watch(file, { persistent: false }, () => {
      const arr = readItems();
      if (win && !win.isDestroyed()) {
        win.webContents.send('items:updated', arr);
        console.log('[main] watch -> items:updated', arr.length);
      }
    });
    itemsWatchers.push(w);
  });
}

function startOrdersWatching(win) {
  const file = getOrdersFile();
  try { if (ordersWatcher) ordersWatcher.close(); } catch {}
  ensureDataFileAt(file);
  ordersWatcher = fs.watch(file, { persistent: false }, () => {
    const arr = readOrders();
    if (win && !win.isDestroyed()) {
      win.webContents.send('orders:updated', arr);
      console.log('[main] watch -> orders:updated', Array.isArray(arr) ? arr.length : 0);
    }
    if (sageIntegrationActive)
      scheduleSageProcessing();
  });
}

function stopOrdersWatching() {
  try { if (ordersWatcher) ordersWatcher.close(); } catch {}
  ordersWatcher = null;
}

function normalizeOrderRef(order) {
  if (!order) return "";
  const ref = order.sage_reference || order.reference || order.__row || "";
  return String(ref || "").trim().toUpperCase();
}

function extractJournalLine(stdoutRaw) {
  const stdout = (stdoutRaw || "").toString();
  const lines = stdout
    .split(/\r?\n/)
    .map((ln) => (ln || "").trim())
    .filter(Boolean);
  if (!lines.length) return "";
  const lastLine = lines[lines.length - 1];
  return lastLine.replace(/^\[[^\]]*\]\s*/, "");
}

function getVendorName(order) {
  if (!order) return "";
  return (
    (order.sage_source || "").trim() ||
    (order.warehouse || "").trim() ||
    (order.seller || "").trim()
  );
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

function runSagePurchase(order) {
  return new Promise((resolve) => {
    if (!fs.existsSync(SAGE_AHK_SCRIPT)) {
      return resolve({ ok: false, error: 'AHK script not found', code: 'missing-script' });
    }

    backupFile(getOrdersFile(), '.pre-sage.bak');

    const orderPath = writeTempOrder(order);
    if (!orderPath) {
      return resolve({ ok: false, error: 'Failed to write temp order file', code: 'temp-write-failed' });
    }

    const args = [
      SAGE_AHK_SCRIPT,
      orderPath,
      order?.sage_reference || order?.reference || "",
      getVendorName(order) || "",
      getOrdersFile(),
    ];

    let stdout = "";
    let stderr = "";
    let finished = false;

    const complete = (payload) => {
      if (finished) return;
      finished = true;
      resolve(payload);
    };

    const child = spawn(AHK_EXECUTABLE, args, { windowsHide: true });
    child.stdout.on('data', (d) => {
      const chunk = d.toString();
      stdout += chunk;
      console.log('[sage] AHK stdout chunk:', chunk.trim());
    });
    child.stderr.on('data', (d) => {
      const chunk = d.toString();
      stderr += chunk;
      console.error('[sage] AHK stderr chunk:', chunk.trim());
    });
    child.on('error', (err) => {
      console.error('[sage] spawn error', err);
      complete({ ok: false, code: 'spawn-error', error: err, stdout, stderr });
    });
    child.on('close', (code) => {
      const ok = code === 0;
      const parsedJournal = extractJournalLine(stdout);
      console.log('[sage] AHK finished', {
        code,
        ok,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        parsedJournal,
      });
      complete({ ok, code, stdout, stderr, journalEntry: parsedJournal });
    });
  });
}

function applySageResult(refKey, res = {}, fallbackOrder = null) {
  const orders = readOrders();
  const list = Array.isArray(orders) ? orders : [];

  const key = (refKey || "").toString().trim().toUpperCase();
  if (!key) return;

  const journalEntry =
    extractJournalLine(res.stdout || "") ||
    (res.journalEntry || "").toString().trim() ||
    "";
  const nowIso = new Date().toISOString();

  let changed = false;
  let found = false;
  const updated = list.map((o) => {
    if (!o) return o;
    const cand = (o.sage_reference || o.reference || o.__row || "").toString().trim().toUpperCase();
    if (!cand || cand !== key) return o;

    changed = true;
    found = true;
    return {
      ...o,
      journalEntry: journalEntry || o.journalEntry || o.journal_entry || "",
      journal_entry: journalEntry || o.journal_entry || o.journalEntry || "",
      enteredInSage: true,
      invoiceSageUpdate: true,
      sage_trigger: false,
      sage_processed_at: nowIso,
    };
  });

  if (!found && fallbackOrder) {
    const patch = {
      journalEntry: journalEntry || fallbackOrder.journalEntry || fallbackOrder.journal_entry || "",
      journal_entry: journalEntry || fallbackOrder.journal_entry || fallbackOrder.journalEntry || "",
      enteredInSage: true,
      invoiceSageUpdate: true,
      sage_trigger: false,
      sage_processed_at: nowIso,
    };
    const merged = { ...fallbackOrder, ...patch };
    updated.push(merged);
    changed = true;
  }

  if (changed) writeOrders(updated);
}

async function processSageOrdersQueue() {
  if (!sageIntegrationActive) return;
  if (sageProcessing) {
    sagePendingRun = true;
    return;
  }

  sageProcessing = true;
  try {
    const orders = readOrders();
    const targets = [];
    (orders || []).forEach((order) => {
      const refKey = normalizeOrderRef(order);
      if (!refKey) return;
      if (!order?.sage_trigger) return;
      if (order?.enteredInSage) return;
      if (sageProcessingRefs.has(refKey)) return;
      sageProcessingRefs.add(refKey);
      targets.push({ refKey, order });
    });

    for (const { refKey, order } of targets) {
      console.log("[sage] starting AHK for", refKey);
      const res = await runSagePurchase(order);
      if (!res?.ok) {
        console.error("[sage] AHK run failed for", refKey, res?.error || res?.stderr || res?.code, {
          stdout: (res?.stdout || "").toString().trim(),
          stderr: (res?.stderr || "").toString().trim(),
        });
      } else {
        console.log(
          "[sage] AHK success for",
          refKey,
          "stdout:",
            (res.stdout || "").toString().trim()
          );
          applySageResult(refKey, res, order);
        }
        sageProcessingRefs.delete(refKey);
      }
    } catch (e) {
      console.error("[sage] queue error", e);
  } finally {
    sageProcessing = false;
    if (sagePendingRun && sageIntegrationActive) {
      sagePendingRun = false;
      setTimeout(() => processSageOrdersQueue(), 200);
    } else {
      sagePendingRun = false;
    }
  }
}

function scheduleSageProcessing() {
  if (!sageIntegrationActive) return;
  if (sageProcessing) {
    sagePendingRun = true;
    return;
  }
  processSageOrdersQueue();
}

function resetSageQueue() {
  sageProcessingRefs.clear();
  sagePendingRun = false;
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
let boundsSaveTimeout = null;

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

app.whenReady().then(() => {
  ensureBusinessFiles();
  createWindow();
});

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

ipcMain.handle('orders:read', () => readOrders());
ipcMain.handle('orders:get-path', () => ({ path: getOrdersFile() }));
ipcMain.handle('orders:watch', (_evt, enable = true) => {
  try {
    sageIntegrationActive = enable !== false;

    if (enable === false) {
      resetSageQueue();
      stopOrdersWatching();
      return { ok: true, watching: false };
    }
    startOrdersWatching(win);
    scheduleSageProcessing();
    return { ok: true, watching: true, path: getOrdersFile() };
  } catch (e) {
    console.error('[orders:watch]', e);
    return { ok: false, error: e?.message || 'Failed to watch orders file.' };
  }
});
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
  if (sageIntegrationActive)
    scheduleSageProcessing();
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

ipcMain.handle('orders:fetch-cbk', async () => {
  try {
    ensureDir(CBK_DATA_DIR);
    const targetOrdersPath = getOrdersFile();
    const existing = readOrders();
    const res = await getCbkOrders({
      storageDir: CBK_DATA_DIR,
      storageStatePath: CBK_STORAGE_STATE,
      ordersPath: targetOrdersPath,
      existingOrders: existing,
    });
    if (res?.ok && Array.isArray(res.orders)) {
      writeOrders(res.orders);
    }
    return { ok: true, ...(res || {}), path: targetOrdersPath };
  } catch (e) {
    console.error('[orders:fetch-cbk]', e);
    return { ok: false, error: e?.message || 'Failed to fetch CBK orders.' };
  }
});

ipcMain.handle('orders:fetch-bestbuy', async () => {
  try {
    ensureDir(BESTBUY_DATA_DIR);
    const targetOrdersPath = getOrdersFile();
    const existing = readOrders();
    const res = await getBestBuyOrders({
      storageDir: BESTBUY_DATA_DIR,
      storageStatePath: BESTBUY_STORAGE_STATE,
      ordersPath: targetOrdersPath,
      existingOrders: existing,
    });
    if (res?.ok && Array.isArray(res.orders)) {
      writeOrders(res.orders);
    }
    return { ok: true, ...(res || {}), path: targetOrdersPath };
  } catch (e) {
    console.error('[orders:fetch-bestbuy]', e);
    return { ok: false, error: e?.message || 'Failed to fetch BestBuy orders.' };
  }
});

ipcMain.handle('ui-state:read', () => ({ ok: true, state: readUIState() }));
ipcMain.handle('ui-state:write', (_evt, state) => {
  writeUIState(state && typeof state === 'object' ? state : {});
  return { ok: true };
});

ipcMain.handle('app-config:get', () => {
  try {
    const cfg = readAppConfig();
    const sharedDir = getSharedDataDir();
    const instanceDir = INSTANCE_DIR;
    ensureBusinessFiles();
    return { ok: true, config: { ...cfg, instanceDataDir: instanceDir, sharedDataDir: sharedDir }, path: APP_CONFIG_FILE };
  } catch (e) {
    console.error('[app-config:get]', e);
    return { ok: false, error: e?.message || 'Failed to read app config.' };
  }
});

ipcMain.handle('app-config:set', (_evt, partial) => {
  try {
    if (!partial || typeof partial !== 'object' || Array.isArray(partial)) {
      return { ok: false, error: 'Invalid config payload' };
    }
    const next = writeAppConfig(partial);
    ensureBusinessFiles();
    // restart watchers to pick up new shared dir
    startWatching(win);
    startOrdersWatching(win);
    return { ok: true, config: { ...next, instanceDataDir: INSTANCE_DIR, sharedDataDir: getSharedDataDir() }, path: APP_CONFIG_FILE };
  } catch (e) {
    console.error('[app-config:set]', e);
    return { ok: false, error: e?.message || 'Failed to write app config.' };
  }
});

ipcMain.handle('app-config:choose-shared', async () => {
  const res = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
  if (res.canceled || !res.filePaths?.[0]) return { ok: false, canceled: true };
  const chosen = res.filePaths[0];
  return { ok: true, path: chosen };
});

ipcMain.handle('app-config:paths-summary', () => {
  try {
    ensureBusinessFiles();
    return { ok: true, summary: getResolvedPathsSummary() };
  } catch (e) {
    return { ok: false, error: e?.message || 'Failed to summarize paths.' };
  }
});

ipcMain.handle('app-config:validate-shared', (_evt, dirPath) => {
  if (!dirPath) return { ok: false, error: 'Path required' };
  const res = validateWritable(dirPath);
  return res.ok ? { ok: true } : res;
});

ipcMain.handle('app-config:migrate-business', (_evt, payload) => {
  try {
    const mode = payload?.mode === 'move' ? 'move' : 'copy';
    const res = migrateBusinessFilesToShared(mode);
    ensureBusinessFiles();
    startWatching(win);
    startOrdersWatching(win);
    return res;
  } catch (e) {
    console.error('[app-config:migrate-business]', e);
    return { ok: false, error: e?.message || 'Failed to migrate files.' };
  }
});

ipcMain.handle('config:read', () => {
  try {
    ensureConfigFile();
    const raw = getUserConfigRaw();
    const effective = getUserConfigEffective();
    const overrides = getEnvOverrides(raw);
    return { ok: true, config: effective, raw, overrides, path: CONFIG_FILE };
  } catch (e) {
    console.error('[config:read]', e);
    return { ok: false, error: e?.message || 'Failed to read config.' };
  }
});
ipcMain.handle('config:write', (_evt, nextConfig) => {
  try {
    ensureConfigFile();
    if (!nextConfig || typeof nextConfig !== 'object' || Array.isArray(nextConfig)) {
      return { ok: false, error: 'Config must be an object.' };
    }
    const cfg = readConfig();
    cfg.userConfig = nextConfig;
    writeConfig(cfg);
    return { ok: true };
  } catch (e) {
    console.error('[config:write]', e);
    return { ok: false, error: e?.message || 'Failed to write config.' };
  }
});

ipcMain.handle('archive:save-bubble', (_evt, payload) => {
  try {
    const { bubble, meta, items } = payload || {};
    if (!bubble || !bubble.id) return { ok: false, error: 'Missing bubble info' };
    const archivedAt = new Date().toISOString();
    const entry = {
      id: bubble.id,
      bubble: { ...bubble },
      meta: { ...(meta || {}), accountingPath: 'ARCHIVED', archivedAt },
      accountingPath: 'ARCHIVED',
      archivedAt,
      items: Array.isArray(items) ? items : [],
    };
    const existing = readArchivedEntries();
    existing.push(entry);
    writeArchivedEntries(existing);
    return { ok: true, archivedAt, path: getArchiveFile() };
  } catch (e) {
    console.error('[archive:save-bubble]', e);
    return { ok: false, error: e?.message || 'Failed to archive bubble' };
  }
});

ipcMain.handle('archive:search', (_evt, query) => {
  const normalize = (val) => (val ?? '').toString().trim().toLowerCase();
  try {
    const term = normalize(query?.term || query?.q);
    const bubbleTerm = normalize(query?.bubbleName || query?.customerName);
    if (!term && !bubbleTerm) return { ok: true, results: [], empty: true };

    const entries = readArchivedEntries();
    const results = [];

    for (const entry of entries) {
      const bubbleName = entry?.bubble?.name || entry?.bubbleName || '';
      const customer = entry?.meta?.customer || entry?.meta?.customerName || '';
      const archivedAt = entry?.archivedAt || entry?.meta?.archivedAt || '';
      const bubbleMatches = bubbleTerm
        ? [bubbleName, customer].some((val) => normalize(val).includes(bubbleTerm))
        : true;
      if (!bubbleMatches && !term) continue;

      const items = Array.isArray(entry?.items) ? entry.items : [];
      const matchedItems = items
        .filter((it) => {
          if (!term) return true;
          const code = normalize(it?.itemcode || it?.partNumber || it?.partLineCode);
          const desc = normalize(it?.notes1 || '') + ' ' + normalize(it?.notes2 || '') + ' ' + normalize(it?.description || '');
          return code.includes(term) || desc.includes(term);
        })
        .map((it) => ({
          itemcode: it?.itemcode || it?.partNumber || '',
          description: it?.notes1 || it?.description || '',
          notes2: it?.notes2 || '',
          quantity: it?.quantity,
          allocated_for: it?.allocated_for,
          cost: it?.cost,
          reference_num: it?.reference_num,
        }));

      if (!matchedItems.length) continue;
      results.push({
        bubbleId: entry?.id || entry?.bubble?.id || '',
        bubbleName: bubbleName || 'Archived Bubble',
        archivedAt,
        items: matchedItems,
      });
    }

    results.sort((a, b) => String(b.archivedAt || '').localeCompare(String(a.archivedAt || '')));
    return { ok: true, results };
  } catch (e) {
    console.error('[archive:search]', e);
    return { ok: false, error: e?.message || 'Failed to search archive' };
  }
});

ipcMain.handle('archive:get-path', () => ({ ok: true, path: getArchiveFile() }));


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
