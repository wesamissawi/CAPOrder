const fs = require('fs');
const path = require('path');
const { writeJsonAtomic } = require('../utils/atomicWrite');

const createVendorOrdersService = (deps) => {
  const {
    ensureDir,
    VENDOR_PATHS,
    readOrders,
    writeOrders,
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
    fetchWorldInvoicesScraper,
    fetchTransbecInvoicesScraper,
    fetchBestbuyInvoicesScraper,
    fetchBestbuyCreditInvoicesScraper,
    fetchCbkInvoicesScraper,
    fetchTransbecCreditInvoicesScraper,
    fetchProforceCreditInvoicesScraper,
    fetchWorldCreditInvoicesScraper,
    getWorldInvoiceCachePath,
    getGmailAssetsDir,
    getTransbecInvoiceCachePath,
    getBestbuyInvoiceCachePath,
    getBestbuyCreditInvoiceCachePath,
    getCbkInvoiceCachePath,
    getTransbecCreditInvoiceCachePath,
    getProforceCreditInvoiceCachePath,
    getWorldCreditInvoiceCachePath,
    runInteractiveAuth,
    verifyConnection,
    saveConfig,
    shell,
    collectKnownInvoiceNumbers,
    mergeOrdersForWrite,
    getArchivedOrderKeys,
  } = deps;

  // A crawl takes minutes and builds its result from a snapshot of orders.json
  // taken before it started. Reconcile against disk on the way out so a Sage run
  // that finished meanwhile is not reverted, and an order currently locked by
  // Sage is left exactly as it is. See mergeOrdersForWrite.
  function writeOrdersMerged(list) {
    const { orders, blocked, resurrected } = mergeOrdersForWrite(readOrders(), list, {
      archivedKeys: getArchivedOrderKeys?.(),
    });
    if (blocked.length) {
      console.warn('[vendor] left Sage-locked order(s) untouched:', blocked.join(', '));
    }
    if (resurrected?.length) {
      console.warn('[vendor] refused to re-add already-archived order(s):', resurrected.join(', '));
    }
    writeOrders(orders);
    return orders;
  }

  async function fetchWorldOrders() {
    try {
      ensureDir(VENDOR_PATHS.world.dataDir);
      const existing = readOrders();
      const archivedRefs = getArchivedOrderRefs(existing, { vendor: 'world' });
      const targetOrdersPath = getOrdersFile();
      const config = loadConfig();
      const worldUser = typeof config.WORLD_USER === 'string' ? config.WORLD_USER : '';
      const worldPass = typeof config.WORLD_PASS === 'string' ? config.WORLD_PASS : '';
      if (!worldUser || !worldPass) {
        return { ok: false, error: 'Missing WORLD credentials. Set them in Settings.' };
      }
      const res = await getWorldOrders({
        storageDir: VENDOR_PATHS.world.dataDir,
        storageStatePath: VENDOR_PATHS.world.storageState,
        ordersPath: targetOrdersPath,
        existingOrders: existing,
        existingRefs: archivedRefs,
        credentials: { user: worldUser, pass: worldPass },
        headless: getScrapersHeadless(),
      });
      if (res?.ok && Array.isArray(res.orders)) {
        writeOrdersMerged(res.orders);
      }
      return { ok: true, ...(res || {}), path: targetOrdersPath };
    } catch (e) {
      console.error('[orders:fetch-world]', e);
      return { ok: false, error: e?.message || 'Failed to fetch World orders.' };
    }
  }

  async function fetchTransbecOrders() {
    try {
      ensureDir(VENDOR_PATHS.transbec.dataDir);
      const targetOrdersPath = getOrdersFile();
      const existing = readOrders();
      const archivedRefs = getArchivedOrderRefs(existing, { vendor: 'transbec' });
      const config = loadConfig();
      const transbecUser = typeof config.TRANSBEC_USER === 'string' ? config.TRANSBEC_USER : '';
      const transbecPass = typeof config.TRANSBEC_PASS === 'string' ? config.TRANSBEC_PASS : '';
      const maxPagesRaw = Number(config.TRANSBEC_MAX_PAGES);
      const maxPages = Number.isFinite(maxPagesRaw) && maxPagesRaw >= 1 ? Math.floor(maxPagesRaw) : 1;
      if (!transbecUser || !transbecPass) {
        return { ok: false, error: 'Missing TRANSBEC credentials. Set them in Settings.' };
      }
      const res = await getTransbecOrders({
        storageDir: VENDOR_PATHS.transbec.dataDir,
        storageStatePath: VENDOR_PATHS.transbec.storageState,
        ordersPath: targetOrdersPath,
        productsPath: VENDOR_PATHS.transbec.products,
        existingOrders: existing,
        existingRefs: archivedRefs,
        maxPages,
        credentials: { user: transbecUser, pass: transbecPass },
        headless: getScrapersHeadless(),
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
        merged = writeOrdersMerged(merged);
      }
      return {
        ok: true,
        ...(res || {}),
        orders: merged,
        path: targetOrdersPath,
        productsPath: VENDOR_PATHS.transbec.products,
      };
    } catch (e) {
      console.error('[orders:fetch-transbec]', e);
      return { ok: false, error: e?.message || 'Failed to fetch Transbec orders.' };
    }
  }

  async function fetchProforceOrders() {
    try {
      const config = loadConfig();
      const store = typeof config.PROFORCE_STORE === 'string' ? config.PROFORCE_STORE : '';
      const customer = typeof config.PROFORCE_CUSTOMER === 'string' ? config.PROFORCE_CUSTOMER : '';
      const pass = typeof config.PROFORCE_PASS === 'string' ? config.PROFORCE_PASS : '';
      if (!store || !customer || !pass) {
        return { ok: false, error: 'Missing PROFORCE credentials. Set them in Settings.' };
      }
      ensureDir(VENDOR_PATHS.proforce.dataDir);
      const targetOrdersPath = getOrdersFile();
      const existing = readOrders();
      const archivedRefs = getArchivedOrderRefs(existing, { vendor: 'proforce' });
      const res = await getProforceOrders({
        storageDir: VENDOR_PATHS.proforce.dataDir,
        storageStatePath: VENDOR_PATHS.proforce.storageState,
        ordersPath: targetOrdersPath,
        existingOrders: existing,
        existingRefs: archivedRefs,
        credentials: { store, customer, pass },
        headless: getScrapersHeadless(),
      });
      if (res?.ok && Array.isArray(res.orders)) {
        writeOrdersMerged(res.orders);
      }
      return { ok: true, ...(res || {}), path: targetOrdersPath };
    } catch (e) {
      console.error('[orders:login-proforce]', e);
      return { ok: false, error: e?.message || 'Failed to fetch Proforce orders.' };
    }
  }

  async function fetchCbkOrders() {
    try {
      const config = loadConfig();
      const cbkUser = typeof config.CBK_USER === 'string' ? config.CBK_USER : '';
      const cbkPass = typeof config.CBK_PASS === 'string' ? config.CBK_PASS : '';
      if (!cbkUser || !cbkPass) {
        return { ok: false, error: 'Missing CBK credentials. Set them in Settings.' };
      }
      ensureDir(VENDOR_PATHS.cbk.dataDir);
      const targetOrdersPath = getOrdersFile();
      const existing = readOrders();
      const archivedRefs = getArchivedOrderRefs(existing, { vendor: 'cbk' });
      const res = await getCbkOrders({
        storageDir: VENDOR_PATHS.cbk.dataDir,
        storageStatePath: VENDOR_PATHS.cbk.storageState,
        ordersPath: targetOrdersPath,
        existingOrders: existing,
        existingRefs: archivedRefs,
        credentials: { user: cbkUser, pass: cbkPass },
        headless: getScrapersHeadless(),
      });
      if (res?.ok && Array.isArray(res.orders)) {
        writeOrdersMerged(res.orders);
      }
      return { ok: true, ...(res || {}), path: targetOrdersPath };
    } catch (e) {
      console.error('[orders:fetch-cbk]', e);
      return { ok: false, error: e?.message || 'Failed to fetch CBK orders.' };
    }
  }

  async function fetchTigerOrders() {
    try {
      const config = loadConfig();
      const tigerUser = typeof config.TIGER_USER === 'string' ? config.TIGER_USER : '';
      const tigerPass = typeof config.TIGER_PASS === 'string' ? config.TIGER_PASS : '';
      if (!tigerUser || !tigerPass) {
        return { ok: false, error: 'Missing TIGER credentials. Set them in Settings.' };
      }
      ensureDir(VENDOR_PATHS.tiger.dataDir);
      const targetOrdersPath = getOrdersFile();
      const existing = readOrders();
      const archivedRefs = getArchivedOrderRefs(existing, { vendor: 'tiger' });
      const res = await getTigerOrders({
        storageDir: VENDOR_PATHS.tiger.dataDir,
        storageStatePath: VENDOR_PATHS.tiger.storageState,
        ordersPath: targetOrdersPath,
        existingOrders: existing,
        existingRefs: archivedRefs,
        credentials: { user: tigerUser, pass: tigerPass },
        headless: getScrapersHeadless(),
      });
      if (res?.ok && Array.isArray(res.orders)) {
        writeOrdersMerged(res.orders);
      }
      return { ok: true, ...(res || {}), path: targetOrdersPath };
    } catch (e) {
      console.error('[orders:fetch-tiger]', e);
      return { ok: false, error: e?.message || 'Failed to fetch Tiger orders.' };
    }
  }

  async function fetchBestBuyOrders() {
    try {
      const config = loadConfig();
      const bestUser = typeof config.BESTBUY_USER === 'string' ? config.BESTBUY_USER : '';
      const bestPass = typeof config.BESTBUY_PASS === 'string' ? config.BESTBUY_PASS : '';
      if (!bestUser || !bestPass) {
        return { ok: false, error: 'Missing BESTBUY credentials. Set them in Settings.' };
      }
      ensureDir(VENDOR_PATHS.bestbuy.dataDir);
      const targetOrdersPath = getOrdersFile();
      const existing = readOrders();
      const archivedRefs = getArchivedOrderRefs(existing, { vendor: 'bestbuy' });
      const res = await getBestBuyOrders({
        storageDir: VENDOR_PATHS.bestbuy.dataDir,
        storageStatePath: VENDOR_PATHS.bestbuy.storageState,
        ordersPath: targetOrdersPath,
        existingOrders: existing,
        existingRefs: archivedRefs,
        credentials: { user: bestUser, pass: bestPass },
        headless: getScrapersHeadless(),
      });
      if (res?.ok && Array.isArray(res.orders)) {
        writeOrdersMerged(res.orders);
      }
      return { ok: true, ...(res || {}), path: targetOrdersPath };
    } catch (e) {
      console.error('[orders:fetch-bestbuy]', e);
      return { ok: false, error: e?.message || 'Failed to fetch BestBuy orders.' };
    }
  }


  // Read the Gmail OAuth config the same way the other vendors read theirs.
  function getGmailCreds() {
    const config = loadConfig();
    return {
      clientId: typeof config.GMAIL_CLIENT_ID === 'string' ? config.GMAIL_CLIENT_ID : '',
      clientSecret: typeof config.GMAIL_CLIENT_SECRET === 'string' ? config.GMAIL_CLIENT_SECRET : '',
      refreshToken: typeof config.GMAIL_REFRESH_TOKEN === 'string' ? config.GMAIL_REFRESH_TOKEN : '',
      sender: typeof config.TRANSBEC_INVOICE_SENDER === 'string' ? config.TRANSBEC_INVOICE_SENDER : '',
      subjectPattern:
        typeof config.TRANSBEC_INVOICE_SUBJECT === 'string' ? config.TRANSBEC_INVOICE_SUBJECT : '',
      worldSender:
        typeof config.WORLD_INVOICE_SENDER === 'string' ? config.WORLD_INVOICE_SENDER : '',
      worldSubject:
        typeof config.WORLD_INVOICE_SUBJECT === 'string' ? config.WORLD_INVOICE_SUBJECT : '',
      bestbuySender:
        typeof config.BESTBUY_INVOICE_SENDER === 'string' ? config.BESTBUY_INVOICE_SENDER : '',
      bestbuySubject:
        typeof config.BESTBUY_INVOICE_SUBJECT === 'string' ? config.BESTBUY_INVOICE_SUBJECT : '',
      bestbuyCreditSender:
        typeof config.BESTBUY_CREDIT_INVOICE_SENDER === 'string' ? config.BESTBUY_CREDIT_INVOICE_SENDER : '',
      bestbuyCreditSubject:
        typeof config.BESTBUY_CREDIT_INVOICE_SUBJECT === 'string' ? config.BESTBUY_CREDIT_INVOICE_SUBJECT : '',
      cbkSender:
        typeof config.CBK_INVOICE_SENDER === 'string' ? config.CBK_INVOICE_SENDER : '',
      cbkSubject:
        typeof config.CBK_INVOICE_SUBJECT === 'string' ? config.CBK_INVOICE_SUBJECT : '',
      transbecCreditSender:
        typeof config.TRANSBEC_CREDIT_INVOICE_SENDER === 'string' ? config.TRANSBEC_CREDIT_INVOICE_SENDER : '',
      transbecCreditSubject:
        typeof config.TRANSBEC_CREDIT_INVOICE_SUBJECT === 'string' ? config.TRANSBEC_CREDIT_INVOICE_SUBJECT : '',
      worldCreditSender:
        typeof config.WORLD_CREDIT_INVOICE_SENDER === 'string' ? config.WORLD_CREDIT_INVOICE_SENDER : '',
      worldCreditSubject:
        typeof config.WORLD_CREDIT_INVOICE_SUBJECT === 'string' ? config.WORLD_CREDIT_INVOICE_SUBJECT : '',
      proforceCreditSender:
        typeof config.PROFORCE_CREDIT_INVOICE_SENDER === 'string' ? config.PROFORCE_CREDIT_INVOICE_SENDER : '',
      proforceCreditSubject:
        typeof config.PROFORCE_CREDIT_INVOICE_SUBJECT === 'string' ? config.PROFORCE_CREDIT_INVOICE_SUBJECT : '',
    };
  }

  // Interactive one-time Gmail consent. Opens the Google consent screen in the
  // user's browser, captures the redirect, and persists the refresh token.
  async function connectGmail() {
    try {
      const { clientId, clientSecret } = getGmailCreds();
      if (!clientId || !clientSecret) {
        return { ok: false, error: 'Enter your Gmail OAuth client id and secret in Settings first.' };
      }
      const { refreshToken, scope } = await runInteractiveAuth({
        clientId,
        clientSecret,
        openExternal: (url) => shell.openExternal(url),
      });
      saveConfig({ GMAIL_REFRESH_TOKEN: refreshToken });
      // Confirm the token works and learn which mailbox we connected.
      let emailAddress = '';
      try {
        const info = await verifyConnection({ clientId, clientSecret, refreshToken });
        emailAddress = info.emailAddress || '';
      } catch (e) {
        console.warn('[vendor:connect-gmail] verify after connect failed', e);
      }
      return { ok: true, emailAddress, scope };
    } catch (e) {
      console.error('[vendor:connect-gmail]', e);
      return { ok: false, error: e?.message || 'Failed to connect Gmail.' };
    }
  }

  // Lightweight status probe for the Settings screen.
  async function getGmailStatus() {
    try {
      const { clientId, clientSecret, refreshToken } = getGmailCreds();
      if (!clientId || !clientSecret) {
        return { ok: true, connected: false, reason: 'no-client' };
      }
      if (!refreshToken) {
        return { ok: true, connected: false, reason: 'not-connected' };
      }
      const info = await verifyConnection({ clientId, clientSecret, refreshToken });
      return { ok: true, connected: true, emailAddress: info.emailAddress || '' };
    } catch (e) {
      return { ok: true, connected: false, reason: 'error', error: e?.message || 'Gmail check failed.' };
    }
  }

  // World now emails machine-readable invoice PDFs, replacing the retired Epicor
  // portal scrape. Each PDF prints its own order reference, so a run simply
  // discovers every invoice email and the renderer matches them to orders.
  async function fetchWorldInvoices(payload = {}) {
    try {
      const { clientId, clientSecret, refreshToken, worldSender, worldSubject } = getGmailCreds();
      if (!clientId || !clientSecret) {
        return { ok: false, error: 'Missing Gmail OAuth client id/secret. Set them in Settings.' };
      }
      if (!refreshToken) {
        return { ok: false, error: 'Gmail is not connected. Click “Connect Gmail” in Settings.' };
      }
      if (!worldSender && !worldSubject) {
        return {
          ok: false,
          error: 'Set the World invoice sender and/or subject pattern in Settings.',
        };
      }
      const gmailDataDir = getGmailAssetsDir();
      ensureDir(gmailDataDir);
      const reference = typeof payload?.reference === 'string' ? payload.reference : '';
      return await fetchWorldInvoicesScraper({
        credentials: { clientId, clientSecret, refreshToken },
        sender: worldSender,
        subjectPattern: worldSubject,
        reference,
        dataDir: gmailDataDir,
        cachePath: getWorldInvoiceCachePath(),
      });
    } catch (e) {
      console.error('[vendor:fetch-world-invoices]', e);
      return { ok: false, error: e?.message || 'Failed to fetch World invoices.' };
    }
  }

  async function fetchTransbecInvoices(payload = {}) {
    try {
      const { clientId, clientSecret, refreshToken, sender, subjectPattern } = getGmailCreds();
      if (!clientId || !clientSecret) {
        return { ok: false, error: 'Missing Gmail OAuth client id/secret. Set them in Settings.' };
      }
      if (!refreshToken) {
        return { ok: false, error: 'Gmail is not connected. Click “Connect Gmail” in Settings.' };
      }
      if (!sender && !subjectPattern) {
        return {
          ok: false,
          error: 'Set the Transbec invoice sender and/or subject pattern in Settings.',
        };
      }
      const gmailDataDir = getGmailAssetsDir();
      ensureDir(gmailDataDir);
      const reference = typeof payload?.reference === 'string' ? payload.reference : '';
      const res = await fetchTransbecInvoicesScraper({
        credentials: { clientId, clientSecret, refreshToken },
        sender,
        subjectPattern,
        reference,
        dataDir: gmailDataDir,
        cachePath: getTransbecInvoiceCachePath(),
      });
      return res;
    } catch (e) {
      console.error('[vendor:fetch-transbec-invoices]', e);
      return { ok: false, error: e?.message || 'Failed to fetch Transbec invoices.' };
    }
  }

  async function fetchBestbuyInvoices(payload = {}) {
    try {
      const { clientId, clientSecret, refreshToken, bestbuySender, bestbuySubject } = getGmailCreds();
      if (!clientId || !clientSecret) {
        return { ok: false, error: 'Missing Gmail OAuth client id/secret. Set them in Settings.' };
      }
      if (!refreshToken) {
        return { ok: false, error: 'Gmail is not connected. Click “Connect Gmail” in Settings.' };
      }
      const gmailDataDir = getGmailAssetsDir();
      ensureDir(gmailDataDir);
      const reference = typeof payload?.reference === 'string' ? payload.reference : '';
      const res = await fetchBestbuyInvoicesScraper({
        credentials: { clientId, clientSecret, refreshToken },
        sender: bestbuySender,
        subjectPattern: bestbuySubject || 'BESTBUY INVOICES FOR TODAY',
        reference,
        dataDir: gmailDataDir,
        cachePath: getBestbuyInvoiceCachePath(),
      });
      return res;
    } catch (e) {
      console.error('[vendor:fetch-bestbuy-invoices]', e);
      return { ok: false, error: e?.message || 'Failed to fetch BestBuy invoices.' };
    }
  }

  // BestBuy credit invoices are a separate Gmail search (bestautosolution.ca,
  // one email per credit) from the daily batch invoice pipeline above — see
  // bestbuyCreditInvoice.js for why "Order No." emails from the same sender
  // must be filtered out rather than just searched around.
  async function fetchBestbuyCreditInvoices(payload = {}) {
    try {
      const { clientId, clientSecret, refreshToken, bestbuyCreditSender, bestbuyCreditSubject } = getGmailCreds();
      if (!clientId || !clientSecret) {
        return { ok: false, error: 'Missing Gmail OAuth client id/secret. Set them in Settings.' };
      }
      if (!refreshToken) {
        return { ok: false, error: 'Gmail is not connected. Click “Connect Gmail” in Settings.' };
      }
      const gmailDataDir = getGmailAssetsDir();
      ensureDir(gmailDataDir);
      const reference = typeof payload?.reference === 'string' ? payload.reference : '';
      const res = await fetchBestbuyCreditInvoicesScraper({
        credentials: { clientId, clientSecret, refreshToken },
        sender: bestbuyCreditSender || 'bestautosolution.ca',
        subjectPattern: bestbuyCreditSubject || 'invoice',
        reference,
        dataDir: gmailDataDir,
        cachePath: getBestbuyCreditInvoiceCachePath(),
      });
      return res;
    } catch (e) {
      console.error('[vendor:fetch-bestbuy-credit-invoices]', e);
      return { ok: false, error: e?.message || 'Failed to fetch BestBuy credit invoices.' };
    }
  }

  // Proforce credit invoices are the ONLY thing Proforce emails - regular
  // invoices are already fully captured by the portal scrape (proforceScraper.js).
  // See proforceCreditInvoice.js for the sender/subject/attachment convention.
  async function fetchProforceCreditInvoices(payload = {}) {
    try {
      const { clientId, clientSecret, refreshToken, proforceCreditSender, proforceCreditSubject } = getGmailCreds();
      if (!clientId || !clientSecret) {
        return { ok: false, error: 'Missing Gmail OAuth client id/secret. Set them in Settings.' };
      }
      if (!refreshToken) {
        return { ok: false, error: 'Gmail is not connected. Click “Connect Gmail” in Settings.' };
      }
      const gmailDataDir = getGmailAssetsDir();
      ensureDir(gmailDataDir);
      const reference = typeof payload?.reference === 'string' ? payload.reference : '';
      const res = await fetchProforceCreditInvoicesScraper({
        credentials: { clientId, clientSecret, refreshToken },
        sender: proforceCreditSender || 'noreply@epartconnection.com',
        subjectPattern: proforceCreditSubject || 'invoice',
        reference,
        dataDir: gmailDataDir,
        cachePath: getProforceCreditInvoiceCachePath(),
      });
      return res;
    } catch (e) {
      console.error('[vendor:fetch-proforce-credit-invoices]', e);
      return { ok: false, error: e?.message || 'Failed to fetch Proforce credit invoices.' };
    }
  }

  async function fetchCbkInvoices(payload = {}) {
    try {
      const { clientId, clientSecret, refreshToken, cbkSender, cbkSubject } = getGmailCreds();
      if (!clientId || !clientSecret) {
        return { ok: false, error: 'Missing Gmail OAuth client id/secret. Set them in Settings.' };
      }
      if (!refreshToken) {
        return { ok: false, error: 'Gmail is not connected. Click “Connect Gmail” in Settings.' };
      }
      const gmailDataDir = getGmailAssetsDir();
      ensureDir(gmailDataDir);
      const reference = typeof payload?.reference === 'string' ? payload.reference : '';
      const res = await fetchCbkInvoicesScraper({
        credentials: { clientId, clientSecret, refreshToken },
        sender: cbkSender,
        subjectPattern: cbkSubject || 'Invoice',
        reference,
        dataDir: gmailDataDir,
        cachePath: getCbkInvoiceCachePath(),
      });
      return res;
    } catch (e) {
      console.error('[vendor:fetch-cbk-invoices]', e);
      return { ok: false, error: e?.message || 'Failed to fetch CBK invoices.' };
    }
  }

  // Transbec CREDIT MEMOS from Gmail — unlike the other Gmail invoice pulls,
  // a credit memo has no pre-existing order to patch: it's purely a discovery
  // list, and the Credits view's "Create order" button turns one into a new
  // order. Powers the Credits view's "Check for Transbec Credits" button.
  async function fetchTransbecCreditInvoices(payload = {}) {
    try {
      const { clientId, clientSecret, refreshToken, transbecCreditSender, transbecCreditSubject } = getGmailCreds();
      if (!clientId || !clientSecret) {
        return { ok: false, error: 'Missing Gmail OAuth client id/secret. Set them in Settings.' };
      }
      if (!refreshToken) {
        return { ok: false, error: 'Gmail is not connected. Click “Connect Gmail” in Settings.' };
      }
      const gmailDataDir = getGmailAssetsDir();
      ensureDir(gmailDataDir);
      const fromDate = typeof payload?.fromDate === 'string' ? payload.fromDate : '';
      const toDate = typeof payload?.toDate === 'string' ? payload.toDate : '';
      const res = await fetchTransbecCreditInvoicesScraper({
        credentials: { clientId, clientSecret, refreshToken },
        sender: transbecCreditSender || 'donotreply@transbec.ca',
        subjectPattern: transbecCreditSubject || 'Credit Memo',
        dataDir: gmailDataDir,
        cachePath: getTransbecCreditInvoiceCachePath(),
        fromDate,
        toDate,
      });
      if (!res?.ok) return res;
      const known = collectKnownInvoiceNumbers ? collectKnownInvoiceNumbers() : new Set();
      const discoveries = (res.discoveries || []).map((d) => {
        const key = String(d.creditMemoNumber || '').trim().toUpperCase();
        return { ...d, known: Boolean(key) && known.has(key) };
      });
      return { ...res, discoveries };
    } catch (e) {
      console.error('[vendor:fetch-transbec-credit-invoices]', e);
      return { ok: false, error: e?.message || 'Failed to fetch Transbec credit memos.' };
    }
  }

  // List every credit memo already cached in transbec_credit_invoice_cache.json,
  // WITHOUT hitting Gmail — lets the Credits view show prior scan results right
  // after an app restart.
  async function getTransbecCreditInvoices() {
    try {
      const cachePath = getTransbecCreditInvoiceCachePath();
      let cache = {};
      if (fs.existsSync(cachePath)) {
        const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) cache = parsed;
      }
      const known = collectKnownInvoiceNumbers ? collectKnownInvoiceNumbers() : new Set();
      const credits = Object.values(cache)
        .map((v) => v && v.discovery)
        .filter(Boolean)
        .map((d) => {
          const key = String(d.creditMemoNumber || '').trim().toUpperCase();
          return { ...d, known: Boolean(key) && known.has(key) };
        })
        .sort((a, b) => String(b.checkedAt || '').localeCompare(String(a.checkedAt || '')));
      return {
        ok: true,
        credits,
        scannedCount: credits.length,
        unknownCount: credits.filter((c) => !c.known).length,
      };
    } catch (e) {
      console.error('[vendor:get-transbec-credits]', e);
      return { ok: false, error: e?.message || 'Failed to read Transbec credit memos.' };
    }
  }

  // DEV-ONLY reset: wipe every trace of past Transbec credit scans — the cache
  // file (so nothing is treated as "already found") and every downloaded
  // credit-memo PDF (transbec_credit_*.pdf in the shared gmail assets dir).
  // Does NOT touch any order already created from a credit (orders.json is
  // untouched) — this only clears the scan/discovery data itself.
  async function resetTransbecCreditScans() {
    try {
      const cachePath = getTransbecCreditInvoiceCachePath();
      let removedFiles = 0;
      if (fs.existsSync(cachePath)) {
        fs.unlinkSync(cachePath);
      }
      const gmailDataDir = getGmailAssetsDir();
      if (fs.existsSync(gmailDataDir)) {
        fs.readdirSync(gmailDataDir).forEach((name) => {
          if (/^transbec_credit_.*\.pdf$/i.test(name)) {
            try {
              fs.unlinkSync(path.join(gmailDataDir, name));
              removedFiles += 1;
            } catch (e) {
              console.error(`[vendor:reset-transbec-credits] failed to delete ${name}`, e);
            }
          }
        });
      }
      return { ok: true, removedFiles };
    } catch (e) {
      console.error('[vendor:reset-transbec-credits]', e);
      return { ok: false, error: e?.message || 'Failed to reset Transbec credit scans.' };
    }
  }

  // World CREDIT MEMOS from Gmail — same shape as the Transbec credit pipeline
  // above (no pre-existing order, purely a discovery list; the Credits view's
  // "Create order" button turns one into a new order). Powers the Credits
  // view's "Check for World Credits" button.
  async function fetchWorldCreditInvoices(payload = {}) {
    try {
      const { clientId, clientSecret, refreshToken, worldCreditSender, worldCreditSubject } = getGmailCreds();
      if (!clientId || !clientSecret) {
        return { ok: false, error: 'Missing Gmail OAuth client id/secret. Set them in Settings.' };
      }
      if (!refreshToken) {
        return { ok: false, error: 'Gmail is not connected. Click “Connect Gmail” in Settings.' };
      }
      const gmailDataDir = getGmailAssetsDir();
      ensureDir(gmailDataDir);
      const fromDate = typeof payload?.fromDate === 'string' ? payload.fromDate : '';
      const toDate = typeof payload?.toDate === 'string' ? payload.toDate : '';
      const res = await fetchWorldCreditInvoicesScraper({
        credentials: { clientId, clientSecret, refreshToken },
        sender: worldCreditSender || 'reports@groupe-monaco.ca',
        subjectPattern: worldCreditSubject || 'Credit Memo for 20605 Cust',
        dataDir: gmailDataDir,
        cachePath: getWorldCreditInvoiceCachePath(),
        fromDate,
        toDate,
      });
      if (!res?.ok) return res;
      const known = collectKnownInvoiceNumbers ? collectKnownInvoiceNumbers() : new Set();
      const discoveries = (res.discoveries || []).map((d) => {
        const key = String(d.creditMemoNumber || '').trim().toUpperCase();
        return { ...d, known: Boolean(key) && known.has(key) };
      });
      return { ...res, discoveries };
    } catch (e) {
      console.error('[vendor:fetch-world-credit-invoices]', e);
      return { ok: false, error: e?.message || 'Failed to fetch World credit memos.' };
    }
  }

  // List every credit memo already cached in world_credit_invoice_cache.json,
  // WITHOUT hitting Gmail — lets the Credits view show prior scan results
  // right after an app restart.
  async function getWorldCreditInvoices() {
    try {
      const cachePath = getWorldCreditInvoiceCachePath();
      let cache = {};
      if (fs.existsSync(cachePath)) {
        const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) cache = parsed;
      }
      const known = collectKnownInvoiceNumbers ? collectKnownInvoiceNumbers() : new Set();
      const credits = Object.values(cache)
        .map((v) => v && v.discovery)
        .filter(Boolean)
        .map((d) => {
          const key = String(d.creditMemoNumber || '').trim().toUpperCase();
          return { ...d, known: Boolean(key) && known.has(key) };
        })
        .sort((a, b) => String(b.checkedAt || '').localeCompare(String(a.checkedAt || '')));
      return {
        ok: true,
        credits,
        scannedCount: credits.length,
        unknownCount: credits.filter((c) => !c.known).length,
      };
    } catch (e) {
      console.error('[vendor:get-world-credits]', e);
      return { ok: false, error: e?.message || 'Failed to read World credit memos.' };
    }
  }

  return {
    fetchWorldOrders,
    fetchTransbecOrders,
    fetchProforceOrders,
    fetchCbkOrders,
    fetchTigerOrders,
    fetchBestBuyOrders,
    fetchWorldInvoices,
    connectGmail,
    getGmailStatus,
    fetchTransbecInvoices,
    fetchBestbuyInvoices,
    fetchBestbuyCreditInvoices,
    fetchCbkInvoices,
    fetchTransbecCreditInvoices,
    fetchProforceCreditInvoices,
    fetchWorldCreditInvoices,
    getTransbecCreditInvoices,
    getWorldCreditInvoices,
    resetTransbecCreditScans,
  };
};

module.exports = { createVendorOrdersService };
