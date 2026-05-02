const fs = require("fs");

const BASE_URL = "https://bestbuycapp.ca:30443/bestbuy02";
const CBK_STYLE_LOGIN = `${BASE_URL}/login.html`;
const HISTORY_URL = `${BASE_URL}/history.html`;

function getCredentials(creds) {
  const user =
    (creds && (creds.user || creds.BESTBUY_USER || creds.username)) || process.env.BESTBUY_USER;
  const pass =
    (creds && (creds.pass || creds.BESTBUY_PASS || creds.password)) || process.env.BESTBUY_PASS;
  if (!user || !pass) {
    throw new Error("Missing BESTBUY credentials. Set them in Settings.");
  }
  return { user, pass };
}

async function createContextWithStorage(browser, storageStatePath) {
  if (fs.existsSync(storageStatePath)) {
    return browser.newContext({ storageState: storageStatePath });
  }
  return browser.newContext();
}

function formatDateForInput(date) {
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const yyyy = date.getFullYear();
  return `${mm}/${dd}/${yyyy}`;
}

async function ensureLoggedIn(page, storageStatePath, statusLog = [], credentials) {
  const { user, pass } = getCredentials(credentials);
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

  statusLog.push("Submitting BestBuy loginâ€¦");
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
  return orders;
}

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

module.exports = {
  createContextWithStorage,
  ensureLoggedIn,
  goToHistoryAndSearch,
  scrapeOrders,
  fetchDetail,
};
