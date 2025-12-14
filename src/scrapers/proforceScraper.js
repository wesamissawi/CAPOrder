// src/scrapers/proforceScraper.js
const path = require("path");
const fs = require("fs");
const { chromium } = require("playwright");
const { standardizeOrderForSage } = require("./sageStandardize");
require("dotenv").config();

const BASE_URL = "https://eoffice.epartconnection.com";
const LOGIN_URL = `${BASE_URL}/wpLogin.aspx`;
const DEFAULT_HEADLESS = process.env.PROFORCE_HEADLESS === "true";
const CLICK_PAUSE_MS = 3000;

function resolvePaths(options = {}) {
  const baseDir = options.storageDir || path.join(__dirname, "..");
  const storageStatePath =
    options.storageStatePath || path.join(baseDir, "proforce_storage_state.json");
  const ordersJsonPath = options.ordersPath || path.join(baseDir, "proforce_orders.json");
  fs.mkdirSync(path.dirname(storageStatePath), { recursive: true });
  fs.mkdirSync(path.dirname(ordersJsonPath), { recursive: true });
  return { storageStatePath, ordersJsonPath };
}

function getCredentials() {
  const store = process.env.PROFORCE_STORE;
  const customer = process.env.PROFORCE_CUSTOMER;
  const pass = process.env.PROFORCE_PASS;
  if (!store || !customer || !pass) {
    throw new Error("Missing PROFORCE_STORE / PROFORCE_CUSTOMER / PROFORCE_PASS in .env");
  }
  return { store, customer, pass };
}

async function createContextWithStorage(browser, storageStatePath) {
  if (fs.existsSync(storageStatePath)) {
    return browser.newContext({ storageState: storageStatePath });
  }
  return browser.newContext();
}

function parseProforceDate(txt) {
  if (!txt) return { iso: null, sageDate: "" };
  const clean = String(txt).replace(/\u2011/g, "-").trim(); // replace narrow hyphen
  // Supports "2025-11-18 01:52 PM" and "11/13/2025 10:17:00 AM"
  let m =
    clean.match(
      /(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})\s*(AM|PM)?/i
    ) ||
    clean.match(
      /(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)?/i
    );
  if (!m) return { iso: null, sageDate: "" };

  let year, month, day, hour, minute, ampm;
  if (m.length === 7 && m[1].length === 4) {
    year = m[1];
    month = m[2];
    day = m[3];
    hour = parseInt(m[4], 10);
    minute = parseInt(m[5], 10);
    ampm = (m[6] || "").toUpperCase();
  } else {
    month = m[1];
    day = m[2];
    year = m[3];
    hour = parseInt(m[4], 10);
    minute = parseInt(m[5], 10);
    ampm = (m[6] || "").toUpperCase();
  }
  if (ampm === "PM" && hour < 12) hour += 12;
  if (ampm === "AM" && hour === 12) hour = 0;

  const iso = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), hour, minute, 0)).toISOString();
  const sageDate = `${String(day).padStart(2, "0")}${String(month).padStart(2, "0")}${String(year).slice(-2)}`;
  return { iso, sageDate };
}

async function ensureLoggedIn(page, storageStatePath) {
  const statusLog = [];
  const { store, customer, pass } = getCredentials();

  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });

  // If login form is missing, assume we are already authenticated
  const loginFormPresent = await page.$("#StoreIdTextBox");
  if (!loginFormPresent) {
    statusLog.push("Login form not found; assuming existing session.");
    await page.context().storageState({ path: storageStatePath });
    return { loggedIn: true, usedStoredSession: true, statusLog };
  }

  const storeInput = await page.$("#StoreIdTextBox");
  const customerInput = await page.$("#CustomerNumberTextBox");
  const passwordInput = await page.$("#PasswordTextBox");
  const loginButton = await page.$("#LoginButton");

  if (!storeInput || !customerInput || !passwordInput || !loginButton) {
    throw new Error("Could not locate Proforce login inputs/buttons.");
  }

  await storeInput.fill(store);
  await customerInput.fill(customer);
  await passwordInput.fill(pass);

  statusLog.push("Submitting Proforce login…");
  await page.waitForTimeout(CLICK_PAUSE_MS);
  await Promise.all([
    loginButton.click(),
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => null),
  ]);

  // Check if still on login page
  const stillHere = await page.$("#LoginButton");
  if (stillHere) {
    throw new Error("Proforce login appears to have failed (login form still present).");
  }

  await page.context().storageState({ path: storageStatePath });
  statusLog.push("Login successful; session stored.");
  return { loggedIn: true, usedStoredSession: false, statusLog };
}

async function parseOrderList(page) {
  return page.evaluate(() => {
    const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
    const money = (s) => {
      const n = parseFloat((s || "").replace(/[^\d.-]/g, ""));
      return Number.isFinite(n) ? n : null;
    };
    const rows =
      Array.from(document.querySelectorAll("#InvoiceTable tbody tr")) ||
      Array.from(document.querySelectorAll(".dataTables_scrollBody #InvoiceTable tbody tr"));
    return rows
      .map((tr, idx) => {
        const tds = tr.querySelectorAll("td");
        if (tds.length < 9) return null;
        const dateRaw = norm(tds[0]?.innerText || "");
        const invoiceLink = tds[1]?.querySelector("a");
        const invoiceNum = norm(invoiceLink?.textContent || tds[1]?.innerText || "");
        const customerNum = norm(tds[2]?.innerText || "");
        const type = norm(tds[3]?.innerText || "");
        const poNumber = norm(tds[4]?.innerText || "");
        const referenceCol = norm(tds[5]?.innerText || "");
        const status = norm(tds[6]?.innerText || "");
        const totalRaw = norm(tds[7]?.innerText || "");
        const paidRaw = norm(tds[8]?.innerText || "");
        const href = invoiceLink?.getAttribute("href") || "";
        if (!invoiceNum) return null;
        return {
          reference: invoiceNum,
        poNumber,
        orderDateRaw: dateRaw,
        referenceCol,
        status,
        totalRaw,
          total: money(totalRaw),
        paidRaw,
          customerNum,
          href,
          detailUrl: href,
          source: "proforce",
          __row: idx + 1,
        };
      })
      .filter(Boolean);
  });
}

async function fetchOrderDetail(context, detailUrl) {
  if (!detailUrl) return { ok: false, reason: "no-detail-url" };
  const detailPage = await context.newPage();
  const fullUrl = detailUrl.startsWith("http") ? detailUrl : `${BASE_URL}/${detailUrl.replace(/^\/+/, "")}`;

  try {
    await detailPage.waitForTimeout(CLICK_PAUSE_MS);
    await detailPage.goto(fullUrl, { waitUntil: "domcontentloaded" });
    await detailPage.waitForSelector("#InvoiceTable", { timeout: 20000 });
  } catch (err) {
    await detailPage.close();
    return { ok: false, error: `detail-navigation-failed (${err.message || err})` };
  }

  try {
    const detail = await detailPage.evaluate(() => {
      const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
      const money = (s) => {
        const n = parseFloat((s || "").replace(/[^\d.-]/g, ""));
        return Number.isFinite(n) ? n : null;
      };

      const infoPanel = document.querySelector(".invoice-panel .panel-body") || document.querySelector(".panel.invoice-panel .panel-body");
      const infoText = infoPanel ? infoPanel.innerText : "";
      const getMatch = (label) => {
        const re = new RegExp(`${label}\\s*:\\s*([^\\n]+)`, "i");
        const m = infoText.match(re);
        return m ? norm(m[1]) : "";
      };

      const invoiceNum = getMatch("Invoice #");
      const orderDateRaw = getMatch("Date");
      const poNumber = getMatch("PO #");
      const refDetail = getMatch("Reference");
      const counterman = getMatch("Countermen");

      let totalRaw = "";
      let totalVal = null;
      const totalWell = Array.from(document.querySelectorAll(".well .row"))
        .map((r) => norm(r.innerText || ""))
        .find((t) => /^Total\b/i.test(t));
      if (totalWell) {
        const m = totalWell.match(/Total\s+([\s\S]+)/i);
        if (m) {
          totalRaw = norm(m[1]);
          const n = parseFloat((m[1] || "").replace(/[^\d.-]/g, ""));
          if (Number.isFinite(n)) totalVal = n;
        }
      }

      const rows = Array.from(document.querySelectorAll("#InvoiceTable tbody tr"));
      const lineItems = [];

      for (const row of rows) {
        const tds = row.querySelectorAll("td");
        if (tds.length < 8) continue;
        // skip notes/colspan rows
        if (row.querySelector("td[colspan]")) continue;

        const partLineCode = norm(tds[0]?.innerText || "");
        const partNumber = norm(tds[1]?.innerText || "");
        const partDescription = norm(tds[2]?.innerText || "");
        const qtyOrdered = norm(tds[4]?.innerText || "");
        const qtyShipped = norm(tds[5]?.innerText || "");
        const backOrdered = norm(tds[6]?.innerText || "");
        const corePrice = money(tds[8]?.innerText || "");
        const yourPrice = money(tds[10]?.innerText || "");
        const extPrice = money(tds[11]?.innerText || "");

        if (!partNumber || partNumber.startsWith("*")) continue;
        if (!yourPrice && !extPrice) continue;

        lineItems.push({
          partLineCode,
          partNumber,
          partDescription,
          quantity: (qtyShipped || qtyOrdered || "").replace(/\.0+$/, ""),
          costPrice: yourPrice !== null ? String(yourPrice) : "",
          costPriceValue: yourPrice,
          extended: extPrice !== null ? String(extPrice) : "",
          extendedValue: extPrice,
          core: corePrice !== null && corePrice > 0,
          addedToOutstanding: false,
          hasEnvironmentalFee: false,
          environmentalFeeAmount: null,
        });
      }

      return {
        lineItems,
        orderDateRaw,
        poNumber,
        referenceFromDetail: refDetail || invoiceNum,
        invoiceNum,
        counterman,
        totalRaw,
        totalVal,
      };
    });

    await detailPage.close();
    return { ok: true, detail };
  } catch (err) {
    await detailPage.close();
    return { ok: false, error: err.message || "detail-parse-failed" };
  }
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
  const existingByRef = new Map(
    existingOrders
      .filter((o) => o && o.reference)
      .map((o) => [String(o.reference).trim().toUpperCase(), o])
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
  const loginInfo = await ensureLoggedIn(page, storageStatePath);
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
      if (refKey && existingByRef.has(refKey)) {
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
      if (!mergedMap.has(key)) {
        mergedMap.set(key, o);
      }
    }
    const mergedOrders = Array.from(mergedMap.values()).map((o) =>
      standardizeOrderForSage({
        ...o,
        source: "proforce",
        warehouse: o.warehouse || "Proforce",
        sage_source: "PRO505",
      })
    );

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
