// src/scrapers/cbkScraper.js
const path = require("path");
const fs = require("fs");
const { chromium } = require("playwright");
const { standardizeOrderForSage } = require("./sageStandardize");
const {
  createContextWithStorage,
  ensureLoggedIn,
  goToHistoryAndSearch,
  scrapeCbkOrders,
  fetchCbkDetail,
} = require("./cbk.actions");
require("dotenv").config();
const DEFAULT_HEADLESS = process.env.CBK_HEADLESS === "true";

function applyCbkDefaults(order = {}) {
  const reference = (order.reference || "").trim();
  return standardizeOrderForSage({
    ...order,
    source: "cbk",
    warehouse: order.warehouse || "CBK",
    sage_source: "CBK505",
    seller: order.seller || "CBK",
    detailClicked: order.detailClicked ?? false,
    detailStored: order.detailStored ?? true,
    pickedUp: order.pickedUp ?? false,
    hasInvoiceNum: order.hasInvoiceNum ?? true,
    totalVerified: order.totalVerified ?? false,
    enteredInSage: order.enteredInSage ?? false,
    inStore: order.inStore ?? false,
    ...(reference || order.source_invoice
      ? { source_invoice: reference || order.source_invoice }
      : {}),
  });
}

function resolvePaths(options = {}) {
  const baseDir = options.storageDir || path.join(__dirname, "..");
  const storageStatePath =
    options.storageStatePath || path.join(baseDir, "cbk_storage_state.json");
  const ordersJsonPath = options.ordersPath || path.join(baseDir, "cbk_orders.json");
  fs.mkdirSync(path.dirname(storageStatePath), { recursive: true });
  fs.mkdirSync(path.dirname(ordersJsonPath), { recursive: true });
  return { storageStatePath, ordersJsonPath };
}

function saveOrdersToJson(filePath, orders) {
  fs.writeFileSync(filePath, JSON.stringify(orders ?? [], null, 2), "utf-8");
}

function mergeOrders(existing = [], incoming = []) {
  const byRef = new Map();
  const normalizeVendor = (order) =>
    (order?.source || order?.warehouse || order?.seller || "").toString().trim().toLowerCase();
  const scopedKey = (order) => {
    const ref = order?.reference ? String(order.reference).trim().toUpperCase() : "";
    const vendor = normalizeVendor(order);
    return ref ? `${vendor || "unknown"}::${ref}` : "";
  };
  (existing || []).forEach((o) => {
    if (!o) return;
    const key = scopedKey(o) || `EXISTING-${byRef.size}`;
    byRef.set(key, o);
  });
  (incoming || []).forEach((o) => {
    if (!o) return;
    const key = scopedKey(o) || `NEW-${byRef.size}`;
    const prev = byRef.get(key) || {};
    const next = {
      ...prev,
      ...o,
      lineItems: Array.isArray(o.lineItems) && o.lineItems.length ? o.lineItems : prev.lineItems || [],
    };
    // Preserve existing source fields when merging into non-CBK orders
    if (prev.source && o.source && prev.source !== o.source) {
      next.source = prev.source;
    }
    if (prev.sage_source && o.sage_source && prev.sage_source !== o.sage_source) {
      next.sage_source = prev.sage_source;
    }
    byRef.set(key, next);
  });
  return Array.from(byRef.values());
}

async function getCbkOrders(options = {}) {
  const headless = options.headless ?? DEFAULT_HEADLESS ?? false;
  const { storageStatePath, ordersJsonPath } = resolvePaths(options);
  const existingOrders = options.existingOrders || [];
  const existingRefs = Array.isArray(options.existingRefs) ? options.existingRefs : [];
  const isCbkOrder = (order) => {
    const src = (order?.source || order?.warehouse || order?.seller || "").toString().trim().toLowerCase();
    return src === "cbk";
  };
  const existingRefSet = new Set(
    [
      ...(existingOrders || [])
        .filter(isCbkOrder)
        .map((o) => (o && o.reference ? String(o.reference).trim().toUpperCase() : "")),
      ...existingRefs.map((ref) => (ref ? String(ref).trim().toUpperCase() : "")),
    ].filter(Boolean)
  );

  let browser;
  let page;
  const statusLog = [];

  try {
    browser = await chromium.launch({ headless });
    const context = await createContextWithStorage(browser, storageStatePath);
    page = await context.newPage();

    const loginInfo = await ensureLoggedIn(page, storageStatePath, statusLog, options.credentials);
    await goToHistoryAndSearch(page, statusLog);

    const scrapedOrders = (await scrapeCbkOrders(page, statusLog)).map((o) => applyCbkDefaults(o));

    // Only process orders not already present by reference
    const newOrders = scrapedOrders.filter((o) => {
      const key = o?.reference ? String(o.reference).trim().toUpperCase() : "";
      return !key || !existingRefSet.has(key);
    });
    statusLog.push(
      `Filtered CBK rows: ${scrapedOrders.length} scraped, ${newOrders.length} new, ${
        scrapedOrders.length - newOrders.length
      } skipped (already present).`
    );

    let detailFetched = 0;
    for (const order of newOrders) {
      if (!order.detailUrl) continue;
      const res = await fetchCbkDetail(context, order.detailUrl);
      if (res.ok && res.detail) {
        order.lineItems = res.detail.lineItems || [];
        if (res.detail.totals?.total?.value !== undefined) {
          order.total = res.detail.totals.total.value;
          order.totalRaw = res.detail.totals.total.raw;
        }
        order.detailFetchedAt = new Date().toISOString();
        // Re-standardize this new order only, so sage_lineItems and derived fields stay in sync.
        const standardized = standardizeOrderForSage({
          ...order,
          source: order.source || "cbk",
          warehouse: order.warehouse || "CBK",
          sage_source: order.sage_source || "CBK505",
        });
        Object.assign(order, standardized);
        detailFetched += 1;
      } else if (res.error) {
        statusLog.push(`[detail] ${order.reference}: ${res.error}`);
      }
    }

    const mergedOrders = mergeOrders(existingOrders, newOrders);
    saveOrdersToJson(ordersJsonPath, mergedOrders);

    if (!scrapedOrders.length) {
      try {
        const htmlPath = path.join(path.dirname(ordersJsonPath), "cbk_last_page.html");
        fs.writeFileSync(htmlPath, await page.content(), "utf-8");
        statusLog.push(`Saved latest CBK page HTML to ${htmlPath} for debugging.`);
      } catch (e) {
        statusLog.push(`Could not save CBK page HTML: ${e.message || e}`);
      }
    }

    return {
      ok: true,
      source: "cbk",
      orders: mergedOrders,
      count: mergedOrders.length,
      added: newOrders.length,
      ordersPath: ordersJsonPath,
      storageStatePath,
      loginInfo,
      headless,
      detailFetched,
      statusLog,
    };
  } catch (err) {
    console.error("[cbk] scraper error:", err);
    try {
      const screenshotPath = path.join(path.dirname(ordersJsonPath || storageStatePath), "cbk_error.png");
      if (page) await page.screenshot({ path: screenshotPath, fullPage: true });
      console.error("[cbk] saved error screenshot to", screenshotPath);
    } catch (s) {
      console.error("[cbk] could not save error screenshot", s);
    }
    return { ok: false, error: err.message || String(err), statusLog };
  } finally {
    if (browser) await browser.close();
  }
}

module.exports = {
  getCbkOrders,
};
