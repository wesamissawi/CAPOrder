// src/scrapers/transbecScraper.js
const path = require("path");
const fs = require("fs");
const { chromium } = require("playwright");
const { standardizeOrderForSage } = require("./sageStandardize");
const {
  createContextWithStorage,
  ensureLoggedIn,
  parseTransbecDate,
  scrapeOrdersList,
  fetchOrderDetail,
  aggregateProducts,
} = require("./transbec.actions");
require("dotenv").config();

// default: visible browser; set TRANSBEC_HEADLESS=true to run headless
const DEFAULT_HEADLESS = process.env.TRANSBEC_HEADLESS === "true";

function resolvePaths(options = {}) {
  const baseDir = options.storageDir || path.join(__dirname, "..");
  const storageStatePath =
    options.storageStatePath || path.join(baseDir, "transbec_storage_state.json");
  const ordersJsonPath = options.ordersPath || path.join(baseDir, "transbec_orders.json");
  const productsJsonPath =
    options.productsPath || path.join(baseDir, "transbec_products.json");
  fs.mkdirSync(path.dirname(storageStatePath), { recursive: true });
  fs.mkdirSync(path.dirname(ordersJsonPath), { recursive: true });
  fs.mkdirSync(path.dirname(productsJsonPath), { recursive: true });
  return { storageStatePath, ordersJsonPath, productsJsonPath };
}

function saveJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data ?? [], null, 2), "utf8");
}

async function getTransbecOrders(options = {}) {
  const { storageStatePath, ordersJsonPath, productsJsonPath } = resolvePaths(options);
  const headless = options.headless ?? DEFAULT_HEADLESS;
  const maxPages = options.maxPages ?? 1; // default: only scrape first page
  const existingOrders = Array.isArray(options.existingOrders) ? options.existingOrders : [];
  const existingRefs = Array.isArray(options.existingRefs) ? options.existingRefs : [];
  const existingByRef = new Map(
    existingOrders
      .filter((o) => o && o.reference)
      .map((o) => [String(o.reference).trim().toUpperCase(), o])
  );
  const existingRefSet = new Set(
    existingRefs
      .map((ref) => (ref ? String(ref).trim().toUpperCase() : ""))
      .filter(Boolean)
  );
  const statusLog = [];
  const stepWaitMs = options.stepWaitMs ?? 1200;
  const browser = await chromium.launch({
    headless,
    slowMo: options.slowMo ?? (headless ? 0 : 150),
  });

  let page;
  try {
    const context = await createContextWithStorage(browser, storageStatePath);
    page = await context.newPage();

    statusLog.push("Opening Transbec home…");
    const loginInfo = await ensureLoggedIn(page, storageStatePath, options.credentials);
    statusLog.push(
      loginInfo?.usedStoredSession
        ? "Using stored Transbec session (cookie/state)."
        : "Logged in to Transbec with credentials."
    );

    statusLog.push(`Scraping Transbec order list (max ${maxPages} page${maxPages === 1 ? "" : "s"})…`);
    const rawOrders = await scrapeOrdersList(page, maxPages);
    statusLog.push(`Found ${rawOrders.length} orders on scanned page(s).`);

    // Normalize orders similar to world fields
    const orders = rawOrders.map((o) => ({
      ...o,
      warehouse: "Transbec",
      seller: "Transbec",
      orderDateRaw: o.orderDateRaw || o.dateTimestamp || "",
      orderDate: o.orderDate || null,
      sageDate: o.sageDate || "",
      vehicleYear: "",
      vehicleMake: "",
      vehicleModel: "",
      vehicleDesc: "",
      status: "",
      orderedBy: o.orderedBy || "",
      orderDesc: "",
      detailUrl: o.href || o.modalUrl || "",
      ...(o.source_invoice ? { source_invoice: o.source_invoice } : {}),
      detailClicked: false,
      detailStored: false,
      pickedUp: false,
      hasInvoiceNum: false,
      totalVerified: false,
      enteredInSage: false,
      inStore: false,
      lineItems: [],
      source: "transbec",
      __row: o.rowIndex || null,
    }));

    let detailFetched = 0;
    for (const order of orders) {
      const refKey = order.reference ? String(order.reference).trim().toUpperCase() : "";
      if (refKey && (existingByRef.has(refKey) || existingRefSet.has(refKey))) {
        // Keep existing version; skip detail fetch
        order.detailStored = true;
        continue;
      }
      if (!order.modalUrl && !order.href) {
        order.detailError = "no-detail-url";
        continue;
      }
      const detailRes = await fetchOrderDetail(context, order.modalUrl || order.href, order.reference);
      if (detailRes.ok && detailRes.detail) {
        order.lineItems = detailRes.detail.lineItems || [];
        order.orderDate = order.orderDate || detailRes.detail.orderDate;
        order.orderDateRaw = order.orderDateRaw || detailRes.detail.orderDateRaw;
        order.sageDate = order.sageDate || detailRes.detail.sageDate;
        order.reference = order.reference || detailRes.detail.reference;
        order.detailStored = true;
        order.detailFetchedAt = new Date().toISOString();
        detailFetched += 1;
      } else {
        order.detailError = detailRes.error || detailRes.reason || "detail-fetch-failed";
      }
      await page.waitForTimeout(stepWaitMs);
    }
    statusLog.push(`Detail fetch complete. ${detailFetched} detail pages scraped.`);

    // Merge with existing (existing entries win)
    const mergedMap = new Map(existingByRef);
    for (const o of orders) {
      const key = o?.reference ? String(o.reference).trim().toUpperCase() : "";
      if (!key) continue;
      if (mergedMap.has(key)) continue; // leave existing untouched
      if (existingRefSet.has(key)) continue; // archived: skip re-adding
      const standardized = standardizeOrderForSage({
        ...o,
        source: "transbec",
        sage_source: "TRA505",
        ...(o.source_invoice ? { source_invoice: o.source_invoice } : {}),
      });
      mergedMap.set(key, standardized);
    }
      const mergedOrders = Array.from(mergedMap.values());

    const products = aggregateProducts(mergedOrders);
    statusLog.push(`Aggregated ${products.length} unique products from order line items.`);

    saveJson(ordersJsonPath, mergedOrders);
    saveJson(productsJsonPath, products);

    return {
      ok: true,
      source: "transbec",
      orders: mergedOrders,
      products,
      ordersPath: ordersJsonPath,
      productsPath: productsJsonPath,
      storageStatePath,
      detailFetched,
      headless,
      statusLog,
      loginInfo,
    };
  } catch (err) {
    console.error("[transbec] scraper error:", err);
    try {
      const screenshotPath = path.join(
        path.dirname(ordersJsonPath || storageStatePath),
        "transbec_error.png"
      );
      if (page) await page.screenshot({ path: screenshotPath, fullPage: true });
      console.error("[transbec] saved error screenshot to", screenshotPath);
    } catch (s) {
      console.error("[transbec] could not save error screenshot", s);
    }
    return { ok: false, error: err.message || String(err), statusLog };
  } finally {
    await browser.close();
  }
}

module.exports = {
  getTransbecOrders,
};
