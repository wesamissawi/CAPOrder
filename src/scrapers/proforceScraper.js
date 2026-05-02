// src/scrapers/proforceScraper.js
const path = require("path");
const fs = require("fs");
const { chromium } = require("playwright");
const { standardizeOrderForSage } = require("./sageStandardize");
const {
  createContextWithStorage,
  ensureLoggedIn,
  parseProforceDate,
  parseOrderList,
  fetchOrderDetail,
} = require("./proforce.actions");
require("dotenv").config();

const DEFAULT_HEADLESS = process.env.PROFORCE_HEADLESS === "true";

function resolvePaths(options = {}) {
  const baseDir = options.storageDir || path.join(__dirname, "..");
  const storageStatePath =
    options.storageStatePath || path.join(baseDir, "proforce_storage_state.json");
  const ordersJsonPath = options.ordersPath || path.join(baseDir, "proforce_orders.json");
  fs.mkdirSync(path.dirname(storageStatePath), { recursive: true });
  fs.mkdirSync(path.dirname(ordersJsonPath), { recursive: true });
  return { storageStatePath, ordersJsonPath };
}

function saveJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data ?? [], null, 2), "utf8");
}

async function getProforceOrders(options = {}) {
  const { storageStatePath, ordersJsonPath } = resolvePaths(options);
  const headless = options.headless ?? DEFAULT_HEADLESS;
  const statusLog = [];
  const stepWaitMs = options.stepWaitMs ?? 800;
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

  const browser = await chromium.launch({
    headless,
    slowMo: options.slowMo ?? (headless ? 0 : 100),
  });

  let page;
  try {
    const context = await createContextWithStorage(browser, storageStatePath);
    page = await context.newPage();

  statusLog.push("Opening Proforce login…");
  const loginInfo = await ensureLoggedIn(page, storageStatePath, options.credentials);
  statusLog.push(...(loginInfo.statusLog || []));

    // Stay on landing (invoice recall) page and wait for rows
    await page.waitForSelector("#InvoiceTable tbody tr", { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(5000); // pause so you can see the list before parsing

    const list = await parseOrderList(page);
    if (list.length === 0) {
      statusLog.push("No Proforce orders parsed from list page; saving screenshot for inspection.");
      try {
        const screenshotPath = path.join(path.dirname(ordersJsonPath || storageStatePath), "proforce_no_orders.png");
        await page.screenshot({ path: screenshotPath, fullPage: true });
        statusLog.push(`Saved screenshot: ${screenshotPath}`);
      } catch (_) {}
    } else {
      statusLog.push(`Found ${list.length} Proforce orders on list page.`);
    }

    // Normalize base fields
    const orders = list.map((o) => {
      const { iso, sageDate } = parseProforceDate(o.orderDateRaw);
      return {
        ...o,
        warehouse: "Proforce",
        seller: "Proforce",
        orderDate: iso,
        sageDate: sageDate || "",
        vehicleYear: "",
        vehicleMake: "",
        vehicleModel: "",
        vehicleDesc: "",
        orderDesc: o.referenceCol || "",
        detailUrl: o.href || o.detailUrl || "",
        detailClicked: false,
        detailStored: false,
        pickedUp: false,
        hasInvoiceNum: Boolean(o.reference),
        totalVerified: false,
        enteredInSage: false,
        inStore: false,
        lineItems: [],
        source: "proforce",
        source_invoice: o.reference || "",
        customerReference: o.referenceCol || "",
      };
    });

    // Fetch details for new references
    let detailFetched = 0;
    for (const order of orders) {
      const refKey = order.reference ? String(order.reference).trim().toUpperCase() : "";
      if (refKey && (existingByRef.has(refKey) || existingRefSet.has(refKey))) {
        order.detailStored = true;
        continue;
      }
      if (!order.detailUrl) {
        order.detailError = "no-detail-url";
        continue;
      }
      const detailRes = await fetchOrderDetail(context, order.detailUrl);
      if (detailRes.ok && detailRes.detail) {
        const d = detailRes.detail;
        order.lineItems = d.lineItems || [];
        const parsedDate = parseProforceDate(d.orderDateRaw);
        order.orderDateRaw = d.orderDateRaw || order.orderDateRaw;
        order.orderDate = order.orderDate || parsedDate.iso;
        order.sageDate = order.sageDate || parsedDate.sageDate || "";
        order.poNumber = order.poNumber || d.poNumber || "";
        order.customerReference = order.customerReference || d.referenceFromDetail || d.reference || "";
        order.reference = order.reference || d.referenceFromDetail || d.invoiceNum || order.reference;
        order.source_invoice = order.reference || order.source_invoice || "";
        order.hasInvoiceNum = Boolean(order.source_invoice);
        order.orderedBy = d.counterman || order.orderedBy || "";
        order.totalRaw = d.totalRaw || order.totalRaw;
        order.detailStored = true;
        order.detailFetchedAt = new Date().toISOString();
        // Re-standardize this new order only so sage_lineItems and derived fields reflect fetched detail.
        const standardized = standardizeOrderForSage({
          ...order,
          source: order.source || "proforce",
          warehouse: order.warehouse || "Proforce",
          sage_source: order.sage_source || "PRO505",
        });
        Object.assign(order, standardized);
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
      if (mergedMap.has(key)) continue; // keep existing entry untouched
      if (existingRefSet.has(key)) continue; // archived: skip re-adding
      const standardized = standardizeOrderForSage({
        ...o,
        source: "proforce",
        warehouse: o.warehouse || "Proforce",
        sage_source: "PRO505",
      });
      mergedMap.set(key, standardized);
    }
    const mergedOrders = Array.from(mergedMap.values());

    saveJson(ordersJsonPath, mergedOrders);

    return {
      ok: true,
      source: "proforce",
      orders: mergedOrders,
      ordersPath: ordersJsonPath,
      storageStatePath,
      detailFetched,
      headless,
      statusLog,
      loginInfo,
    };
  } catch (err) {
    console.error("[proforce] scraper error:", err);
    try {
      const screenshotPath = path.join(path.dirname(ordersJsonPath || storageStatePath), "proforce_error.png");
      if (page) await page.screenshot({ path: screenshotPath, fullPage: true });
      console.error("[proforce] saved error screenshot to", screenshotPath);
    } catch (s) {
      console.error("[proforce] could not save error screenshot", s);
    }
    return { ok: false, error: err.message || String(err), statusLog };
  } finally {
    await browser.close();
  }
}

module.exports = {
  getProforceOrders,
};
