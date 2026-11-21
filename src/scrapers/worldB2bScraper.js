// src/scrapers/worldB2bScraper.js
//
// World Automotive orders from b2b.groupe-monaco.ca (replaces the iautoparts
// frameset scraper in worldScraper.js, which is left in place for now).
// Mirrors transbecScraper.js; see worldB2b.actions.js for the page details.
const path = require("path");
const fs = require("fs");
const { chromium } = require("playwright");
const { standardizeOrderForSage } = require("./sageStandardize");
const {
  createContextWithStorage,
  ensureLoggedIn,
  scrapeOrdersList,
  fetchOrderDetail,
  aggregateProducts,
} = require("./worldB2b.actions");
require("dotenv").config();

const DEFAULT_HEADLESS = process.env.WORLD_HEADLESS === "true";
const WORLD_WAREHOUSE = "World Automotive Warehouse";
const cents = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const refKeyOf = (ref) => (ref ? String(ref).trim().toUpperCase() : "");

// The site's EHC cell is a per-unit fee and the line Total includes it. Same
// two-array split the invoice pipeline uses (environmentalFee.js): lineItems
// keep the part's own cost/extended with the fee as metadata, sage_lineItems
// carry the fee-INCLUSIVE figures the purchase-entry AHK types into Sage.
// Because hasEnvironmentalFee/environmentalFeeAmount are set here, the later
// invoice pass sees the fee already applied and skips it (no double count).
function applyScrapedEhc(lineItems) {
  return lineItems.map((li) => {
    const fee = Number(li.ehcUnit);
    if (!Number.isFinite(fee) || fee <= 0 || li.core) return li;
    const qty = Number(li.quantity) || 0;
    const ext = Number(li.extendedValue);
    const partExt = Number.isFinite(ext) ? cents(ext - fee * qty) : ext;
    return {
      ...li,
      extended: String(partExt),
      extendedValue: partExt,
      hasEnvironmentalFee: true,
      environmentalFeeAmount: fee.toFixed(2),
    };
  });
}

function patchSageEhc(order) {
  const sage = Array.isArray(order.sage_lineItems) ? order.sage_lineItems : [];
  order.sage_lineItems = sage.map((li, idx) => {
    const src = order.lineItems[idx];
    if (!src?.hasEnvironmentalFee) return li;
    const fee = Number(src.environmentalFeeAmount);
    const qty = Number(src.quantity) || 0;
    const cost = cents(Number(src.costPriceValue) + fee);
    const ext = cents(Number(src.extendedValue) + fee * qty);
    return {
      ...li,
      costPrice: String(cost),
      costPriceValue: cost,
      extended: String(ext),
      extendedValue: ext,
    };
  });
  return order;
}

function resolvePaths(options = {}) {
  const baseDir = options.storageDir || path.join(__dirname, "..");
  // Own file, so the old iautoparts session stays intact if we ever roll back.
  const storageStatePath =
    options.storageStatePath || path.join(baseDir, "world_b2b_storage_state.json");
  const ordersJsonPath = options.ordersPath || path.join(baseDir, "world_b2b_orders.json");
  const productsJsonPath = options.productsPath || path.join(baseDir, "world_b2b_products.json");
  for (const p of [storageStatePath, ordersJsonPath, productsJsonPath]) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
  }
  return { storageStatePath, ordersJsonPath, productsJsonPath };
}

async function getWorldB2bOrders(options = {}) {
  const { storageStatePath, ordersJsonPath, productsJsonPath } = resolvePaths(options);
  const headless = options.headless ?? DEFAULT_HEADLESS;
  const maxPages = options.maxPages ?? 1;
  const existingOrders = Array.isArray(options.existingOrders) ? options.existingOrders : [];
  const existingRefs = Array.isArray(options.existingRefs) ? options.existingRefs : [];

  // Only World's own orders count as "already have it"; a Transbec order that
  // happened to share a reference must not suppress a World one.
  const existingByRef = new Map(
    existingOrders
      .filter((o) => o && o.reference && (!o.source || o.source === "world"))
      .map((o) => [refKeyOf(o.reference), o])
  );
  const existingRefSet = new Set(existingRefs.map(refKeyOf).filter(Boolean));

  const statusLog = [];
  const stepWaitMs = options.stepWaitMs ?? 800;
  const browser = await chromium.launch({
    headless,
    slowMo: options.slowMo ?? (headless ? 0 : 150),
  });

  let page;
  try {
    const context = await createContextWithStorage(browser, storageStatePath);
    page = await context.newPage();

    statusLog.push("Opening World (b2b.groupe-monaco.ca)…");
    const loginInfo = await ensureLoggedIn(page, storageStatePath, options.credentials);
    statusLog.push(
      loginInfo?.usedStoredSession
        ? "Using stored World session."
        : "Logged in to World with credentials."
    );

    statusLog.push(`Scraping World order list (max ${maxPages} page${maxPages === 1 ? "" : "s"})…`);
    const rawOrders = await scrapeOrdersList(page, maxPages);
    statusLog.push(`Found ${rawOrders.length} orders on scanned page(s).`);

    const orders = rawOrders.map((o) => ({
      ...o,
      // The exact string every historical World order carries (the old scraper
      // stored the seller name; App.jsx's WORLD_WAREHOUSE is the same). Keeps
      // Returns' per-warehouse grouping and capRules' alias lookup unchanged.
      warehouse: WORLD_WAREHOUSE,
      seller: WORLD_WAREHOUSE,
      vehicleYear: "",
      vehicleMake: "",
      vehicleModel: "",
      vehicleDesc: "",
      status: "",
      orderedBy: "",
      orderDesc: "",
      detailUrl: o.href || o.modalUrl || "",
      detailClicked: false,
      detailStored: false,
      pickedUp: false,
      hasInvoiceNum: false,
      // The Sage run sets this once the figures agree (the old World scraper
      // started false too); the emailed invoice supplies billed_total.
      totalVerified: false,
      enteredInSage: false,
      inStore: false,
      lineItems: [],
      source: "world",
      __row: o.rowIndex || null,
    }));

    let detailFetched = 0;
    const toReview = [];
    for (const order of orders) {
      const refKey = refKeyOf(order.reference);
      if (refKey && (existingByRef.has(refKey) || existingRefSet.has(refKey))) {
        order.detailStored = true;
        continue;
      }
      if (!order.modalUrl && !order.href) {
        order.detailError = "no-detail-url";
        continue;
      }
      const detailRes = await fetchOrderDetail(context, order.modalUrl || order.href, order.reference);
      if (detailRes.ok && detailRes.detail) {
        const d = detailRes.detail;
        order.lineItems = applyScrapedEhc(d.lineItems || []);
        order.reference = order.reference || d.reference;
        if (d.fromLocation) order.fromLocation = d.fromLocation;
        order.detailStored = true;
        order.detailFetchedAt = new Date().toISOString();
        detailFetched += 1;
        if (order.lineItems.some((li) => li.coreRaw)) toReview.push(order.reference);
      } else {
        order.detailError = detailRes.error || detailRes.reason || "detail-fetch-failed";
        statusLog.push(`✖ Detail failed for ${order.reference}: ${order.detailError}`);
      }
      await page.waitForTimeout(stepWaitMs);
    }
    statusLog.push(`Detail fetch complete. ${detailFetched} detail pages scraped.`);
    if (toReview.length) {
      statusLog.push(
        `Orders with a Core cell filled (core NOT split into its own line yet — review): ${toReview.join(", ")}`
      );
    }

    // Existing entries win; archived refs are never re-added. Same return
    // contract as the old World scraper: everything we were given, plus the
    // new World orders (the caller merges it through the CRDT store).
    const seen = new Set(existingByRef.keys());
    const newOrders = [];
    for (const o of orders) {
      const key = refKeyOf(o.reference);
      if (!key || seen.has(key) || existingRefSet.has(key)) continue;
      seen.add(key);
      newOrders.push(
        patchSageEhc(standardizeOrderForSage({ ...o, source: "world", sage_source: "WOR505" }))
      );
    }
    const mergedOrders = existingOrders.concat(newOrders);

    const products = aggregateProducts(mergedOrders);
    statusLog.push(`Aggregated ${products.length} unique products from order line items.`);
    // As in transbecScraper: orders are persisted by the caller through the
    // CRDT store (our snapshot is stale after a multi-minute crawl).
    fs.writeFileSync(productsJsonPath, JSON.stringify(products, null, 2), "utf8");

    return {
      ok: true,
      source: "world",
      orders: mergedOrders,
      products,
      count: mergedOrders.length,
      added: newOrders.length,
      ordersPath: ordersJsonPath,
      productsPath: productsJsonPath,
      storageStatePath,
      detailFetched,
      headless,
      statusLog,
      loginInfo,
    };
  } catch (err) {
    console.error("[world] scraper error:", err);
    try {
      const screenshotPath = path.join(path.dirname(storageStatePath), "world_b2b_error.png");
      if (page) await page.screenshot({ path: screenshotPath, fullPage: true });
    } catch (s) {
      console.error("[world] could not save error screenshot", s);
    }
    return { ok: false, error: err.message || String(err), statusLog };
  } finally {
    await browser.close();
  }
}

module.exports = { getWorldB2bOrders };
