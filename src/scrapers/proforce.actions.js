const fs = require("fs");

const BASE_URL = "https://eoffice.epartconnection.com";
const LOGIN_URL = `${BASE_URL}/wpLogin.aspx`;
const CLICK_PAUSE_MS = 3000;

function getCredentials(creds) {
  const store =
    (creds && (creds.store || creds.PROFORCE_STORE || creds.username || creds.user)) ||
    process.env.PROFORCE_STORE;
  const customer =
    (creds && (creds.customer || creds.PROFORCE_CUSTOMER)) || process.env.PROFORCE_CUSTOMER;
  const pass =
    (creds && (creds.pass || creds.password || creds.PROFORCE_PASS)) || process.env.PROFORCE_PASS;
  if (!store || !customer || !pass) {
    throw new Error("Missing PROFORCE credentials. Set them in Settings.");
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

async function ensureLoggedIn(page, storageStatePath, credentials) {
  const statusLog = [];
  const { store, customer, pass } = getCredentials(credentials);

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

  statusLog.push("Submitting Proforce loginâ€¦");
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

module.exports = {
  createContextWithStorage,
  ensureLoggedIn,
  parseProforceDate,
  parseOrderList,
  fetchOrderDetail,
  CLICK_PAUSE_MS,
};
