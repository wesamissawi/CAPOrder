// src/scrapers/cbkScraper.js
const path = require("path");
const fs = require("fs");
const { chromium } = require("playwright");
require("dotenv").config();

const BASE_URL = "http://cbklink.cappcon.com:32000/cbk01";
const CBK_LOGIN_URL = `${BASE_URL}/login.html`;
const CBK_HISTORY_URL = `${BASE_URL}/history.html`;
const DEFAULT_HEADLESS = process.env.CBK_HEADLESS === "true";

function applyCbkDefaults(order = {}) {
  const reference = (order.reference || "").trim();
  return {
    ...order,
    source: "cbk",
    warehouse: order.warehouse || "CBK",
    seller: order.seller || "CBK",
    detailClicked: order.detailClicked ?? false,
    detailStored: order.detailStored ?? true,
    pickedUp: order.pickedUp ?? false,
    hasInvoiceNum: order.hasInvoiceNum ?? true,
    totalVerified: order.totalVerified ?? false,
    enteredInSage: order.enteredInSage ?? false,
    inStore: order.inStore ?? false,
    source_invoice: reference || order.source_invoice || "",
  };
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

function getCredentials() {
  const user = process.env.CBK_USER;
  const pass = process.env.CBK_PASS;
  if (!user || !pass) {
    throw new Error("CBK_USER or CBK_PASS not set in .env");
  }
  return { user, pass };
}

async function createContextWithStorage(browser, storageStatePath) {
  if (fs.existsSync(storageStatePath)) {
    return browser.newContext({ storageState: storageStatePath });
  }
  return browser.newContext();
}

function parseCbkDate(raw) {
  const norm = (raw || "").replace(/\s+/g, " ").trim();
  if (!norm) return { iso: null, sageDate: "" };

  let year;
  let month;
  let day;
  let hour = 0;
  let minute = 0;
  let ampm = "";

  // Supports: 11/28/2025, 28/11/2025, 2025-11-28, or strings parsable by Date
  let m =
    norm.match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/) ||
    norm.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
  if (m) {
    if (m[1].length === 4) {
      year = m[1];
      month = m[2];
      day = m[3];
    } else {
      month = m[1];
      day = m[2];
      year = m[3];
    }
  }

  const timeMatch = norm.match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
  if (timeMatch) {
    hour = parseInt(timeMatch[1], 10);
    minute = parseInt(timeMatch[2], 10);
    ampm = (timeMatch[3] || "").toUpperCase();
  }
  if (ampm === "PM" && hour < 12) hour += 12;
  if (ampm === "AM" && hour === 12) hour = 0;

  if (!year || !month || !day) {
    const d = new Date(norm);
    if (Number.isNaN(d.getTime())) return { iso: null, sageDate: "" };
    const iso = d.toISOString();
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const yy = String(d.getFullYear()).slice(-2);
    return { iso, sageDate: `${dd}${mm}${yy}` };
  }

  const iso = new Date(
    Date.UTC(Number(year), Number(month) - 1, Number(day), hour, minute, 0)
  ).toISOString();
  const dd = String(day).padStart(2, "0");
  const mm = String(month).padStart(2, "0");
  const yy = String(year).slice(-2);
  return { iso, sageDate: `${dd}${mm}${yy}` };
}

async function ensureLoggedIn(page, storageStatePath, statusLog = []) {
  const { user, pass } = getCredentials();
  await page.goto(CBK_LOGIN_URL, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(500);

  const usernameInput = await page.$("#username, input[name='username']");
  const passwordInput = await page.$("#password, input[name='password']");

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
      if (!(await remember.isChecked())) await remember.check();
      statusLog.push("Checked Remember Me.");
    } catch (_) {
      // Last resort: force check via DOM
      try {
        await page.evaluate((el) => {
          el.checked = true;
          el.dispatchEvent(new Event("change", { bubbles: true }));
          el.dispatchEvent(new Event("input", { bubbles: true }));
        }, remember);
      } catch (_) {}
    }
  }

  const loginButton =
    (await page.$("#login-btn")) ||
    (await page.$("#loginForm button[type='submit']")) ||
    (await page.$("#loginForm input[type='submit']"));

  statusLog.push("Submitting CBK login…");
  await Promise.all([
    loginButton ? loginButton.click() : passwordInput.press("Enter"),
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => null),
    page.waitForLoadState("domcontentloaded").catch(() => null),
  ]);
  await page.waitForTimeout(500);

  await page.context().storageState({ path: storageStatePath });
  statusLog.push("CBK login complete; session stored.");
  return { loggedIn: true, usedStoredSession: false, loginPerformed: true };
}

async function goToHistoryAndSearch(page, statusLog = []) {
  // Determine date range: start = first of previous month, end = today
  const today = new Date();
  const start = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  const fmt = (d) => {
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    const yyyy = d.getFullYear();
    return `${mm}/${dd}/${yyyy}`;
  };
  const startStr = fmt(start);
  const endStr = fmt(today);

  await page.goto(CBK_HISTORY_URL, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#history-search-btn, #order-list", { timeout: 15000 }).catch(() => {});

  // Fill date range
  try {
    await page.evaluate(
      ({ startStr, endStr }) => {
        const setVal = (id, val) => {
          const el = document.querySelector(id);
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
    statusLog.push(`Set CBK date range ${startStr} -> ${endStr}`);
  } catch (e) {
    statusLog.push(`Failed to set CBK date range: ${e.message || e}`);
  }

  // Trigger search for the full year
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
  statusLog.push("Loaded CBK history page and triggered Search.");
}

async function scrapeCbkOrders(page, statusLog = []) {
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
        reference: orderNo || `CBK-${idx + 1}`,
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
        source: "cbk",
        lineItems: [],
      };
    });
  });

  statusLog.push(`Scraped ${orders.length} CBK order rows from history table.`);
  return orders.map((o) => applyCbkDefaults(o));
}

function saveOrdersToJson(filePath, orders) {
  fs.writeFileSync(filePath, JSON.stringify(orders ?? [], null, 2), "utf-8");
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
    const prev = byRef.get(key) || {};
    const next = {
      ...prev,
      ...o,
      lineItems: Array.isArray(o.lineItems) && o.lineItems.length ? o.lineItems : prev.lineItems || [],
    };
    byRef.set(key, next);
  });
  return Array.from(byRef.values()).map(applyCbkDefaults);
}

async function fetchCbkDetail(context, detailUrl) {
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
        const bodyRows = Array.from(table.querySelectorAll("tr")).slice(1); // skip headers
        for (const tr of bodyRows) {
          const tds = tr.querySelectorAll("td");
          if (!tds.length) continue;
          const partNumber = norm(tds[0]?.innerText || "");
          const partDescription = norm(tds[1]?.innerText || "");
          const brand = norm(tds[2]?.innerText || "");
          const netRaw = norm(tds[3]?.innerText || "");
          const coreRaw = norm(tds[4]?.innerText || "");
          const ehcRaw = norm(tds[5]?.innerText || "");
          const qtyOrder = norm(tds[6]?.innerText || "");
          const qtyShip = norm(tds[7]?.innerText || "");
          const totalRaw = norm(tds[8]?.innerText || "");

          const quantity = qtyShip || qtyOrder || "";
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
            coreCharge: money(coreRaw),
            hasEnvironmentalFee: Boolean(money(ehcRaw)),
            environmentalFeeAmount: money(ehcRaw),
            addedToOutstanding: false,
          };
          lineItems.push(entry);

          // If there is a core charge, track as a separate synthetic line to preserve downstream logic
          if (entry.coreCharge) {
            lineItems.push({
              partLineCode: `CORE ${brand || ""}`.trim(),
              partNumber,
              costPrice: coreRaw,
              costPriceValue: entry.coreCharge,
              partDescription: `CBK Core: ${partNumber}`.trim(),
              quantity,
              extended: coreRaw,
              extendedValue: entry.coreCharge,
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

async function getCbkOrders(options = {}) {
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

    const scrapedOrders = await scrapeCbkOrders(page, statusLog);

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
