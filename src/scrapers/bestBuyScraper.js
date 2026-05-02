// src/scrapers/bestBuyScraper.js
// Scrapes order history and detail pages from BestBuy's portal using Playwright.
const path = require("path");
const fs = require("fs");
const { chromium } = require("playwright");
const { standardizeOrderForSage } = require("./sageStandardize");
const {
  createContextWithStorage,
  ensureLoggedIn,
  goToHistoryAndSearch,
  scrapeOrders,
  fetchDetail,
} = require("./bestbuy.actions");
require("dotenv").config();

const DEFAULT_HEADLESS = process.env.BESTBUY_HEADLESS === "true";

/**
 * Applies normalized defaults to an order so downstream consumers always have expected flags/shape.
 */
function applyDefaults(order = {}) {
  const reference = (order.reference || "").trim();
  const invoice = (order.invoiceNum || order.source_invoice || "").trim();
  return standardizeOrderForSage({
    ...order,
    source: "bestbuy",
    warehouse: order.warehouse || "BestBuy",
    sage_source: "BES505",
    seller: order.seller || "BestBuy",
    detailClicked: order.detailClicked ?? false,
    detailStored: order.detailStored ?? true,
    pickedUp: order.pickedUp ?? false,
    hasInvoiceNum: order.hasInvoiceNum ?? true,
    totalVerified: order.totalVerified ?? false,
    enteredInSage: order.enteredInSage ?? false,
    inStore: order.inStore ?? false,
    ...(invoice ? { source_invoice: invoice } : {}),
  });
}

/**
 * Builds storage/output paths and ensures directories exist.
 */
function resolvePaths(options = {}) {
  const baseDir = options.storageDir || path.join(__dirname, "..");
  const storageStatePath =
    options.storageStatePath || path.join(baseDir, "bestbuy_storage_state.json");
  const ordersJsonPath = options.ordersPath || path.join(baseDir, "bestbuy_orders.json");
  fs.mkdirSync(path.dirname(storageStatePath), { recursive: true });
  fs.mkdirSync(path.dirname(ordersJsonPath), { recursive: true });
  return { storageStatePath, ordersJsonPath };
}

function mergeOrders(existing = [], incoming = []) {
  const byRef = new Map();
  (existing || []).forEach((o) => {
    if (!o) return;
    const key = o.reference ? String(o.reference).trim().toUpperCase() : `EXISTING-${byRef.size}`;
    byRef.set(key, o);
  });
  (incoming || []).forEach((o) => {
    if (!o) return;
    const key = o.reference ? String(o.reference).trim().toUpperCase() : `NEW-${byRef.size}`;
    if (byRef.has(key)) return; // keep existing entry untouched
    byRef.set(key, o);
  });
  return Array.from(byRef.values());
}

/**
 * Orchestrates the BestBuy scrape: login, search, scrape rows, fetch details, and persist orders.
 */
async function getBestBuyOrders(options = {}) {
  const headless = options.headless ?? DEFAULT_HEADLESS ?? false;
  const { storageStatePath, ordersJsonPath } = resolvePaths(options);
  const existingOrders = options.existingOrders || [];
  const existingRefs = Array.isArray(options.existingRefs) ? options.existingRefs : [];
  const existingRefSet = new Set(
    [
      ...(existingOrders || []).map((o) =>
        o && o.reference ? String(o.reference).trim().toUpperCase() : ""
      ),
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

    const scrapedOrders = (await scrapeOrders(page, statusLog)).map((o) => applyDefaults(o));
    const newOrders = scrapedOrders.filter((o) => {
      const key = o?.reference ? String(o.reference).trim().toUpperCase() : "";
      return !key || !existingRefSet.has(key);
    });
    statusLog.push(
      `Filtered BestBuy rows: ${scrapedOrders.length} scraped, ${newOrders.length} new, ${
        scrapedOrders.length - newOrders.length
      } skipped (already present).`
    );

    let detailFetched = 0;
    for (const order of newOrders) {
      if (!order.detailUrl) continue;
      const res = await fetchDetail(context, order.detailUrl);
      if (res.ok && res.detail) {
        order.lineItems = res.detail.lineItems || [];
        if (res.detail.totals?.total?.value !== undefined) {
          order.total = res.detail.totals.total.value;
          order.totalRaw = res.detail.totals.total.raw;
        }
        order.detailFetchedAt = new Date().toISOString();
        const standardized = standardizeOrderForSage({
          ...order,
          source: order.source || "bestbuy",
          warehouse: order.warehouse || "BestBuy",
          sage_source: order.sage_source || "BES505",
        });
        Object.assign(order, standardized);
        detailFetched += 1;
      } else if (res.error) {
        statusLog.push(`[detail] ${order.reference}: ${res.error}`);
      }
    }

    const mergedOrders = mergeOrders(existingOrders, newOrders);
    fs.writeFileSync(ordersJsonPath, JSON.stringify(mergedOrders ?? [], null, 2), "utf-8");

    if (!scrapedOrders.length) {
      try {
        const htmlPath = path.join(path.dirname(ordersJsonPath), "bestbuy_last_page.html");
        fs.writeFileSync(htmlPath, await page.content(), "utf-8");
        statusLog.push(`Saved latest BestBuy page HTML to ${htmlPath} for debugging.`);
      } catch (e) {
        statusLog.push(`Could not save BestBuy page HTML: ${e.message || e}`);
      }
    }

    return {
      ok: true,
      source: "bestbuy",
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
    console.error("[bestbuy] scraper error:", err);
    try {
      const screenshotPath = path.join(path.dirname(ordersJsonPath || storageStatePath), "bestbuy_error.png");
      if (page) await page.screenshot({ path: screenshotPath, fullPage: true });
      console.error("[bestbuy] saved error screenshot to", screenshotPath);
    } catch (s) {
      console.error("[bestbuy] could not save error screenshot", s);
    }
    return { ok: false, error: err.message || String(err), statusLog };
  } finally {
    if (browser) await browser.close();
  }
}

module.exports = {
  getBestBuyOrders,
};
