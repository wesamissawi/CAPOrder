const fs = require("fs");

const BASE_URL = "http://cbklink.cappcon.com:32000/cbk01";
const CBK_LOGIN_URL = `${BASE_URL}/login.html`;
const CBK_HISTORY_URL = `${BASE_URL}/history.html`;

function getCredentials(creds) {
  const user = (creds && (creds.user || creds.CBK_USER || creds.username)) || process.env.CBK_USER;
  const pass = (creds && (creds.pass || creds.CBK_PASS || creds.password)) || process.env.CBK_PASS;
  if (!user || !pass) {
    throw new Error("Missing CBK credentials. Set them in Settings.");
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

async function ensureLoggedIn(page, storageStatePath, statusLog = [], credentials) {
  const { user, pass } = getCredentials(credentials);
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

  statusLog.push("Submitting CBK loginâ€¦");
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
  return orders;
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

module.exports = {
  createContextWithStorage,
  ensureLoggedIn,
  parseCbkDate,
  goToHistoryAndSearch,
  scrapeCbkOrders,
  fetchCbkDetail,
};
