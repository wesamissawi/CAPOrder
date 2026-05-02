// src/scrapers/worldScraper.js
const path = require("path");
const fs = require("fs");
const { chromium } = require("playwright");
const { standardizeOrderForSage } = require("./sageStandardize");
const {
  createContextWithStorage,
  ensureLoggedIn,
  navigateToOrdersTab,
  fetchOrderDetailsFromList,
  scrapeWorldOrders,
  loadExistingOrders,
} = require("./world.actions");
require("dotenv").config();

const DEFAULT_HEADLESS = process.env.WORLD_HEADLESS === "true" ? true : false;

function resolvePaths(options = {}) {
  const baseDir = options.storageDir || path.join(__dirname, "..");
  const storageStatePath =
    options.storageStatePath || path.join(baseDir, "world_storage_state.json");
  const ordersJsonPath = options.ordersPath || path.join(baseDir, "world_orders.json");
  fs.mkdirSync(path.dirname(storageStatePath), { recursive: true });
  fs.mkdirSync(path.dirname(ordersJsonPath), { recursive: true });
  return { storageStatePath, ordersJsonPath };
}

// Save scraped orders into JSON file
function saveOrdersToJson(orders, ordersJsonPath) {
  fs.writeFileSync(ordersJsonPath, JSON.stringify(orders, null, 2), "utf8");
}

// MAIN ENTRY: call this from Electron main via IPC
async function getWorldOrders(options = {}) {
  const { storageStatePath, ordersJsonPath } = resolvePaths(options);
  const { existingOrders, refMap, normalizeRef } = loadExistingOrders(
    ordersJsonPath,
    options.existingOrders,
    options.existingRefs
  );
  const headless = options.headless ?? DEFAULT_HEADLESS;
  const statusLog = [];
  const stepWaitMs = options.stepWaitMs ?? 1500;
  const browser = await chromium.launch({
    headless,
    slowMo: options.slowMo ?? (headless ? 0 : 200),
  });

  let page;
  try {
    const context = await createContextWithStorage(browser, storageStatePath);
    page = await context.newPage();

    statusLog.push("Opening login page…");
    const loginInfo = await ensureLoggedIn(page, storageStatePath, options.credentials);
    statusLog.push(
      loginInfo?.usedStoredSession
        ? "Using stored session (no login form)."
        : "Logged in with credentials."
    );

    statusLog.push("Navigating to orders list…");
    const scrapedOrders = await scrapeWorldOrders(page);
    statusLog.push(`Found ${scrapedOrders.length} orders on list page.`);

    const newOrders = [];
    let skippedExisting = 0;
    for (const order of scrapedOrders) {
      const key = normalizeRef(order?.reference);
      if (key && refMap.has(key)) {
        skippedExisting += 1;
        continue; // existing reference: leave stored copy untouched
      }
      newOrders.push(order);
      if (key) refMap.set(key, true);
    }

    statusLog.push(
      `Existing preserved: ${existingOrders.length} (skipped ${skippedExisting} already in file).`
    );
    statusLog.push(`New orders to append: ${newOrders.length}.`);

    if (newOrders.length === 0) {
      statusLog.push("No new orders found; existing orders.json left unchanged.");
      return {
        ok: true,
        count: existingOrders.length,
        path: ordersJsonPath,
        orders: existingOrders,
        added: 0,
        detailFetched: 0,
        loginInfo,
        headless,
        statusLog,
      };
    }

    // Fetch details only for brand-new orders; existing entries stay untouched
    let detailFetched = 0;
    const detailCandidates = newOrders.filter((o) => o && o.detailStored !== true);
    const detailTrue = existingOrders.filter((o) => o && o.detailStored === true).length;
    statusLog.push(
      `Detail candidates needing scrape (new only): ${detailCandidates.length} (existing detailStored=true: ${detailTrue})`
    );
    if (detailCandidates.length) {
      const sampleRefs = detailCandidates
        .map((o) => o.reference || "(no ref)")
        .slice(0, 10)
        .join(", ");
      statusLog.push(`Detail refs (first 10): ${sampleRefs}`);
    }
    if (detailCandidates.length === 0) {
      statusLog.push("No new orders need detail fetch.");
    }
    for (const order of detailCandidates) {
      const refLabel = order.reference || "(no ref)";

      // Refresh list view before each detail fetch to ensure we're on the orders grid
      statusLog.push(`Opening detail for ${refLabel}…`);
      await navigateToOrdersTab(page).catch(() => {});
      await page.waitForTimeout(stepWaitMs);

      const detailRes = await fetchOrderDetailsFromList(page, order.reference);
      if (detailRes.ok && detailRes.detail) {
        order.lineItems = detailRes.detail.lineItems || [];
        order.sageDate = order.sageDate || detailRes.detail.sageDate || "";
        order.orderDateRaw = order.orderDateRaw || detailRes.detail.orderDateRaw || order.orderDateRaw;
        order.detailStored = true;
        order.detailFetchedAt = new Date().toISOString();
        detailFetched += 1;
        statusLog.push(`✔ Detail scraped for ${refLabel} (${order.lineItems.length} lines)`);
      } else {
        // Do not mutate the order when detail fetch fails; just record status.
        const errMsg = detailRes.error || detailRes.reason || "detail-fetch-failed";
        statusLog.push(`✖ Detail skipped/failed for ${refLabel}: ${errMsg}`);
      }
      await page.waitForTimeout(stepWaitMs);
    }
    statusLog.push(`Detail fetch complete. ${detailFetched} detail pages scraped.`);

    const standardizedNewOrders = newOrders.map((o) =>
      standardizeOrderForSage({
        ...o,
        source: "world",
        warehouse: o.warehouse || o.seller || o.orderedBy || "World",
        sage_source: "WOR505",
      })
    );

    const finalOrders = existingOrders.concat(standardizedNewOrders);
    saveOrdersToJson(finalOrders, ordersJsonPath);

    return {
      ok: true,
      count: finalOrders.length,
      path: ordersJsonPath,
      orders: finalOrders,
      added: standardizedNewOrders.length,
      detailFetched,
      loginInfo,
      headless,
      statusLog,
    };
  } catch (err) {
    console.error("World scraper error:", err);
    try {
      const screenshotPath = path.join(path.dirname(ordersJsonPath), "world_error.png");
      if (page) {
        await page.screenshot({ path: screenshotPath, fullPage: true });
        console.error("Saved error screenshot to", screenshotPath);
      }
    } catch (s) {
      console.error("Could not save error screenshot", s);
    }
    return { ok: false, error: err.message };
  } finally {
    await browser.close();
  }
}

module.exports = {
  getWorldOrders,
};
