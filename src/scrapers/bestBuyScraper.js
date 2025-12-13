// src/scrapers/bestBuyScraper.js
// Scrapes order history and detail pages from BestBuy's portal using Playwright.
const path = require("path");
const fs = require("fs");
const { chromium } = require("playwright");
const { standardizeOrderForSage } = require("./sageStandardize");
require("dotenv").config();

const BASE_URL = "https://bestbuycapp.ca:30443/bestbuy02";
const CBK_STYLE_LOGIN = `${BASE_URL}/login.html`;
const HISTORY_URL = `${BASE_URL}/history.html`;
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
    seller: order.seller || "BestBuy",
    detailClicked: order.detailClicked ?? false,
    detailStored: order.detailStored ?? true,
    pickedUp: order.pickedUp ?? false,
    hasInvoiceNum: order.hasInvoiceNum ?? true,
    totalVerified: order.totalVerified ?? false,
    enteredInSage: order.enteredInSage ?? false,
    inStore: order.inStore ?? false,
    source_invoice: invoice || "",
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

function getCredentials() {
  const user = process.env.BESTBUY_USER;
  const pass = process.env.BESTBUY_PASS;
  if (!user || !pass) {
    throw new Error("BESTBUY_USER or BESTBUY_PASS not set in .env");
  }
  return { user, pass };
}

/**
 * Reuses a saved session if present; otherwise returns a fresh context.
 */
async function createContextWithStorage(browser, storageStatePath) {
  if (fs.existsSync(storageStatePath)) {
    return browser.newContext({ storageState: storageStatePath });
  }
  return browser.newContext();
}

/**
 * BestBuy expects MM/DD/YYYY.
 */
function formatDateForInput(date) {
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const yyyy = date.getFullYear();
  // const mm = '05'
  // const dd = '03'
  // const yyyy = '2025'
  return `${mm}/${dd}/${yyyy}`;
}

/**
 * Logs into the portal (or reuses existing session) and persists storage state.
 */
async function ensureLoggedIn(page, storageStatePath, statusLog = []) {
  const { user, pass } = getCredentials();
  await page.goto(CBK_STYLE_LOGIN, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(150);

  const usernameInput = await page.$("#username, input[name='username']");
  const passwordInput = await page.$("#password, input[name='password']");

  // If the form isn't present, assume the session is still valid and store it for reuse.
  if (!usernameInput || !passwordInput) {
    statusLog.push("Login form missing; assuming existing session.");
    await page.context().storageState({ path: storageStatePath });
    return { loggedIn: true, usedStoredSession: true, loginPerformed: false };
  }

  await usernameInput.fill(user);
  await passwordInput.fill(pass);

  const remember = (await page.$("#rememberMe")) || (await page.$("input[name='rememberLogin']"));
  if (remember) {
    try {
      // Some templates hide the native checkbox; prefer forcing the underlying input to checked.
      await remember.evaluate((el) => {
        el.checked = true;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      });
      if (!(await remember.isChecked())) {
        // Fallback: click the label if the programmatic set didn't stick.
        await page.evaluate(() => {
          const lbl =
            document.querySelector("label[for='rememberMe']") ||
            document.querySelector("#login-remember");
          lbl?.click();
        });
      }
    } catch (e) {
      statusLog.push("Could not check Remember Me checkbox.");
    }
  }

  const loginButton =
    (await page.$("#login-button-div a")) ||
    (await page.$("#login-btn")) ||
    (await page.$("#loginForm button[type='submit']")) ||
    (await page.$("#loginForm input[type='submit']"));

  statusLog.push("Submitting BestBuy login…");
  if (loginButton) {
    await loginButton.click().catch(() => {});
  } else {
    await page.keyboard.press("Enter").catch(() => {});
  }

  // Wait for navigation or a short delay to allow the page to transition.
  await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 5000 }).catch(() => null);
  await page.waitForTimeout(200);

  const loginFormPresent = await page.$("#loginForm #username");
  if (loginFormPresent) {
    throw new Error("BestBuy login appears to have failed (login form still present).");
  }

  await page.context().storageState({ path: storageStatePath });
  statusLog.push("BestBuy login complete; session stored.");
  return { loggedIn: true, usedStoredSession: false, loginPerformed: true };
}

/**
 * Opens the history page, sets a date range (current month back one month), and triggers search.
 */
async function goToHistoryAndSearch(page, statusLog = []) {
  const today = new Date();
  const start = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  const startStr = formatDateForInput(start);
  const endStr = formatDateForInput(today);

  await page.goto(HISTORY_URL, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#history-search-btn, #order-list", { timeout: 15000 }).catch(() => {});

  try {
    await page.evaluate(
      ({ startStr, endStr }) => {
        const setVal = (sel, val) => {
          const el = document.querySelector(sel);
          if (!el) return false;
          el.value = val;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        };
        setVal("#startDate", startStr);
        setVal("#endDate", endStr);
      },
      { startStr, endStr }
    );
    statusLog.push(`Set BestBuy date range ${startStr} -> ${endStr}`);
  } catch (e) {
    statusLog.push(`Failed to set BestBuy date range: ${e.message || e}`);
  }

  try {
    await page.evaluate(() => {
      if (typeof doSearch === "function") {
        doSearch();
      } else {
        const btn = document.querySelector("#history-search-btn") || document.querySelector("#history-btn-div a");
        btn?.click();
      }
    });
  } catch (_) {}

  await page.waitForSelector("#order-list tbody tr", { timeout: 20000 });
  await page.waitForTimeout(1000);
  statusLog.push("Loaded BestBuy history page and triggered Search.");
}

/**
 * Scrapes the visible order table rows from the history page.
 */
async function scrapeOrders(page, statusLog = []) {
  await page.waitForLoadState("domcontentloaded").catch(() => {});

  const orders = await page.evaluate(() => {
    const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
    const money = (s) => {
      const n = parseFloat((s || "").replace(/[^\d.-]/g, ""));
      return Number.isFinite(n) ? n : null;
    };
    const parseDate = (raw) => {
      const txt = norm(raw);
      if (!txt) return { iso: null, sageDate: "" };
      const d = new Date(txt);
      if (Number.isNaN(d.getTime())) return { iso: null, sageDate: "" };
      const iso = d.toISOString();
      const dd = String(d.getDate()).padStart(2, "0");
      const mm = String(d.getMonth() + 1).padStart(2, "0");
      const yy = String(d.getFullYear()).slice(-2);
      return { iso, sageDate: `${dd}${mm}${yy}` };
    };

    const table = document.querySelector("#order-list");
    if (!table) return [];
    const rows = Array.from(table.querySelectorAll("tbody tr")).filter((tr) =>
      tr.querySelectorAll("td").length >= 9
    );

    return rows.map((tr, idx) => {
      const tds = tr.querySelectorAll("td");
      const cell = (i) => norm(tds[i]?.innerText || "");
      const link = tds[3]?.querySelector("a");
      const href = link?.getAttribute("href") || "";
      const orderNo = norm(link?.textContent || cell(3));
      const invoiceText = cell(6);
      const totalText = cell(7);
      const orderDateRaw = cell(1);
      const { iso, sageDate } = parseDate(orderDateRaw);
      return {
        reference: orderNo || `BESTBUY-${idx + 1}`,
        orderDateRaw,
        orderDate: iso,
        sageDate,
        branch: cell(2),
        poNumber: cell(4),
        shipVia: cell(5),
        invoiceNum: invoiceText,
        status: cell(8),
        totalRaw: totalText,
        total: money(totalText),
        detailUrl: href,
        source: "bestbuy",
        lineItems: [],
      };
    });
  });

  statusLog.push(`Scraped ${orders.length} BestBuy order rows from history table.`);
  return orders.map((o) => applyDefaults(o));
}

/**
 * Loads the order detail page and extracts line items/totals.
 */
async function fetchDetail(context, detailUrl) {
  if (!detailUrl) return { ok: false, reason: "no-detail-url" };
  const page = await context.newPage();
  const fullUrl = detailUrl.startsWith("http")
    ? detailUrl
    : `${BASE_URL}/${detailUrl.replace(/^\/+/, "")}`;

  try {
    await page.goto(fullUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
    await page.waitForSelector(".quickbid-detail-table", { timeout: 15000 });
  } catch (err) {
    await page.close();
    return { ok: false, error: `detail-navigation-failed (${err.message || err})` };
  }

  try {
    const detail = await page.evaluate(() => {
      const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
      const money = (s) => {
        const n = parseFloat((s || "").replace(/[^\d.-]/g, ""));
        return Number.isFinite(n) ? n : null;
      };

      const lineItems = [];
      const table = document.querySelector(".quickbid-detail-table");
      if (table) {
        const bodyRows = Array.from(table.querySelectorAll("tr")).slice(1);
        for (const tr of bodyRows) {
          const tds = tr.querySelectorAll("td");
          if (!tds.length) continue;
          const partNumber = norm(tds[0]?.innerText || "");
          const partDescription = norm(tds[1]?.innerText || "");
          const brand = norm(tds[2]?.innerText || "");
          const netRaw = norm(tds[4]?.innerText || "");
          const coreRaw = norm(tds[8]?.innerText || "");
          const ehcRaw = norm(tds[9]?.innerText || "");
          const qtyOrder = norm(tds[10]?.innerText || "");
          const qtyShip = norm(tds[11]?.innerText || "");
          const totalRaw = norm(tds[12]?.innerText || "");
          const quantity = qtyShip || qtyOrder || "";
          const coreVal = money(coreRaw);
          const entry = {
            partLineCode: brand || "",
            partNumber,
            costPrice: netRaw,
            costPriceValue: money(netRaw),
            partDescription,
            quantity,
            extended: totalRaw,
            extendedValue: money(totalRaw),
            core: false,
            coreCharge: coreVal,
            hasEnvironmentalFee: Boolean(money(ehcRaw)),
            environmentalFeeAmount: money(ehcRaw),
            addedToOutstanding: false,
          };
          lineItems.push(entry);
          if (coreVal) {
            lineItems.push({
              partLineCode: `CORE ${brand || ""}`.trim(),
              partNumber,
              costPrice: coreRaw,
              costPriceValue: coreVal,
              partDescription: `BestBuy Core: ${partNumber}`.trim(),
              quantity,
              extended: coreRaw,
              extendedValue: coreVal,
              core: true,
              addedToOutstanding: false,
              hasEnvironmentalFee: false,
              environmentalFeeAmount: null,
            });
          }
        }
      }

      const totals = {};
      document.querySelectorAll(".parts-search-results-navigation").forEach((nav) => {
        const title = norm(nav.querySelector(".total-title")?.innerText || "");
        const amt = norm(nav.querySelector(".total-amount")?.innerText || "");
        if (title && amt) totals[title.toLowerCase()] = { raw: amt, value: money(amt) };
      });

      return { lineItems, totals };
    });

    await page.close();
    return { ok: true, detail };
  } catch (err) {
    await page.close();
    return { ok: false, error: err.message || "detail-parse-failed" };
  }
}

/**
 * Merges existing and newly scraped orders, preferring latest data while keeping detail lines.
 */
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
    const prev = byRef.get(key) || {};
    const next = {
      ...prev,
      ...o,
      lineItems: Array.isArray(o.lineItems) && o.lineItems.length ? o.lineItems : prev.lineItems || [],
    };
    byRef.set(key, next);
  });
  return Array.from(byRef.values()).map(applyDefaults);
}

/**
 * Orchestrates the BestBuy scrape: login, search, scrape rows, fetch details, and persist orders.
 */
async function getBestBuyOrders(options = {}) {
  const headless = options.headless ?? DEFAULT_HEADLESS ?? false;
  const { storageStatePath, ordersJsonPath } = resolvePaths(options);
  const existingOrders = options.existingOrders || [];
  const existingRefSet = new Set(
    (existingOrders || [])
      .map((o) => (o && o.reference ? String(o.reference).trim().toUpperCase() : ""))
      .filter(Boolean)
  );

  let browser;
  let page;
  const statusLog = [];

  try {
    browser = await chromium.launch({ headless });
    const context = await createContextWithStorage(browser, storageStatePath);
    page = await context.newPage();

    const loginInfo = await ensureLoggedIn(page, storageStatePath, statusLog);
    await goToHistoryAndSearch(page, statusLog);

    const scrapedOrders = await scrapeOrders(page, statusLog);
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
