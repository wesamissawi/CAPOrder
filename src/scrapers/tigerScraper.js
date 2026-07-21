// src/scrapers/tigerScraper.js
const path = require("path");
const fs = require("fs");
const { chromium } = require("playwright");
const { standardizeOrderForSage } = require("./sageStandardize");
const {
  createContextWithStorage,
  ensureLoggedIn,
  goToStatement,
  scrapeStatementRows,
  fetchOrderDetail,
  originOf,
  DEFAULT_BRANCH,
} = require("./tiger.actions");
require("dotenv").config();

const DEFAULT_HEADLESS = process.env.TIGER_HEADLESS === "true";
// Statement is paginated by month (period=1 current, 2 previous, ...); scan a
// small trailing window by default, same spirit as CBK's prev-month-to-today range.
const DEFAULT_PERIODS = [1, 2];

function applyTigerDefaults(order = {}) {
  // Tiger's statement already gives us its own invoice # and a confirmed
  // total straight from their billing system (not an OCR guess), so pre-fill
  // the same fields the invoice-fetch flows fill in for other vendors instead
  // of leaving them for the user to retype.
  const invoiceNum = (order.invoiceNum || "").toString().trim();
  const total = typeof order.total === "number" ? order.total : null;
  return standardizeOrderForSage({
    ...order,
    source: "tiger",
    warehouse: order.warehouse || "Tiger",
    sage_source: order.sage_source || "TIG505",
    seller: order.seller || "Tiger",
    detailClicked: order.detailClicked ?? false,
    detailStored: order.detailStored ?? true,
    pickedUp: order.pickedUp ?? false,
    source_invoice: order.source_invoice || invoiceNum || "",
    hasInvoiceNum: order.hasInvoiceNum ?? Boolean(invoiceNum),
    billed_total: order.billed_total ?? total,
    totalVerified: order.totalVerified ?? (total !== null),
    enteredInSage: order.enteredInSage ?? false,
    inStore: order.inStore ?? false,
  });
}

function resolvePaths(options = {}) {
  const baseDir = options.storageDir || path.join(__dirname, "..");
  const storageStatePath =
    options.storageStatePath || path.join(baseDir, "tiger_storage_state.json");
  const ordersJsonPath = options.ordersPath || path.join(baseDir, "tiger_orders.json");
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
    if (prev.source && o.source && prev.source !== o.source) next.source = prev.source;
    if (prev.sage_source && o.sage_source && prev.sage_source !== o.sage_source) {
      next.sage_source = prev.sage_source;
    }
    byRef.set(key, next);
  });
  return Array.from(byRef.values());
}

async function getTigerOrders(options = {}) {
  const headless = options.headless ?? DEFAULT_HEADLESS ?? false;
  const branch = options.branch || DEFAULT_BRANCH;
  const periods = Array.isArray(options.periods) && options.periods.length ? options.periods : DEFAULT_PERIODS;
  const { storageStatePath, ordersJsonPath } = resolvePaths(options);
  const existingOrders = options.existingOrders || [];
  const existingRefs = Array.isArray(options.existingRefs) ? options.existingRefs : [];
  const isTigerOrder = (order) => {
    const src = (order?.source || order?.warehouse || order?.seller || "").toString().trim().toLowerCase();
    return src === "tiger";
  };
  const existingRefSet = new Set(
    [
      ...(existingOrders || [])
        .filter(isTigerOrder)
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

    const loginInfo = await ensureLoggedIn(page, storageStatePath, statusLog, options.credentials, branch);

    const scrapedByOrderId = new Map();
    for (const period of periods) {
      await goToStatement(page, statusLog, period);
      const rows = await scrapeStatementRows(page, statusLog);
      for (const row of rows) {
        if (!scrapedByOrderId.has(row.orderId)) scrapedByOrderId.set(row.orderId, row);
      }
    }
    const scrapedOrders = Array.from(scrapedByOrderId.values()).map((o) => applyTigerDefaults(o));

    const newOrders = scrapedOrders.filter((o) => {
      const key = o?.reference ? String(o.reference).trim().toUpperCase() : "";
      return !key || !existingRefSet.has(key);
    });
    statusLog.push(
      `Filtered Tiger rows: ${scrapedOrders.length} scraped, ${newOrders.length} new, ${
        scrapedOrders.length - newOrders.length
      } skipped (already present).`
    );

    const origin = originOf(page);
    let detailFetched = 0;
    for (const order of newOrders) {
      const res = await fetchOrderDetail(context, origin, order.orderId);
      if (res.ok && res.detail) {
        order.lineItems = res.detail.lineItems || [];
        order.poNumber = res.detail.customerPO || order.poNumber || "";
        order.orderedBy = res.detail.orderedBy || "";
        if (res.detail.totals?.total?.value != null) {
          order.total = res.detail.totals.total.value;
          order.totalRaw = res.detail.totals.total.raw;
          order.billed_total = res.detail.totals.total.value;
          order.totalVerified = true;
        }
        order.detailFetchedAt = new Date().toISOString();
        const standardized = standardizeOrderForSage({
          ...order,
          source: order.source || "tiger",
          warehouse: order.warehouse || "Tiger",
          sage_source: order.sage_source || "TIG505",
        });
        Object.assign(order, standardized);
        detailFetched += 1;
      } else if (res.error) {
        statusLog.push(`[detail] ${order.reference}: ${res.error}`);
      }
    }

    const mergedOrders = mergeOrders(existingOrders, newOrders);
    saveOrdersToJson(ordersJsonPath, mergedOrders);

    return {
      ok: true,
      source: "tiger",
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
    console.error("[tiger] scraper error:", err);
    try {
      const screenshotPath = path.join(path.dirname(ordersJsonPath || storageStatePath), "tiger_error.png");
      if (page) await page.screenshot({ path: screenshotPath, fullPage: true });
      console.error("[tiger] saved error screenshot to", screenshotPath);
    } catch (s) {
      console.error("[tiger] could not save error screenshot", s);
    }
    return { ok: false, error: err.message || String(err), statusLog };
  } finally {
    if (browser) await browser.close();
  }
}

module.exports = {
  getTigerOrders,
};
