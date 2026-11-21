// src/scrapers/worldB2b.actions.js
//
// World Automotive (Groupe Monaco) moved to b2b.groupe-monaco.ca, which is the
// same storefront platform as orderstransbec.com — identical login form, the
// same /store/order-history table and the same receipt modal. This file is the
// World twin of transbec.actions.js. It is a per-vendor copy on purpose (the
// established convention); only the detail-page parser differs, because World's
// receipt has two extra columns (EHC, Core) that Transbec's does not.
//
// The retired iautoparts frameset scraper (world.actions.js / worldScraper.js)
// is intentionally left in place until the user says to delete it.
const fs = require("fs");
const { parseTransbecDate } = require("./transbec.actions");

const BASE_URL = "https://b2b.groupe-monaco.ca";
const HOME_URL = `${BASE_URL}/store/home`;
const ORDERS_URL = `${BASE_URL}/store/order-history`;
const LANG_EN_URL = `${BASE_URL}/store/lang-english/`;

function getCredentials(creds) {
  const user =
    (creds && (creds.user || creds.WORLD_USER || creds.username)) || process.env.WORLD_USER;
  const pass =
    (creds && (creds.pass || creds.WORLD_PASS || creds.password)) || process.env.WORLD_PASS;
  if (!user || !pass) throw new Error("Missing WORLD credentials. Set them in Settings.");
  return { user, pass };
}

async function createContextWithStorage(browser, storageStatePath) {
  if (fs.existsSync(storageStatePath)) {
    return browser.newContext({ storageState: storageStatePath });
  }
  return browser.newContext();
}

async function ensureEnglish(page) {
  try {
    await page.goto(LANG_EN_URL, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(800);
  } catch (e) {
    console.warn("[world] Unable to switch language to English:", e.message || e);
  }
}

// The page renders the login form twice (a hidden mobile copy and a visible
// sidebar one), so every locator is pinned to the visible instance.
async function ensureLoggedIn(page, storageStatePath, credentials) {
  const { user, pass } = getCredentials(credentials);
  await ensureEnglish(page);
  await page.goto(HOME_URL, { waitUntil: "domcontentloaded" });
  await page
    .waitForSelector("#logoutbutton, #loginemail", { state: "attached", timeout: 15000 })
    .catch(() => {});

  if (await page.$("#logoutbutton")) {
    await page.context().storageState({ path: storageStatePath });
    return { loggedIn: true, usedStoredSession: true, loginPerformed: false };
  }

  const userInput = page.locator("#loginemail:visible, input[name='tmplusername']:visible").first();
  const passInput = page.locator("#loginpassword:visible, input[name='tmplpassword']:visible").first();
  await userInput.waitFor({ state: "visible", timeout: 15000 });
  await userInput.fill(user, { timeout: 5000 });
  await passInput.fill(pass, { timeout: 5000 });

  const remember = page.locator("input[name='tmplrememberme']:visible").first();
  if (await remember.count().catch(() => 0)) {
    await remember.check({ timeout: 3000 }).catch(() => {});
  }

  const submit = page.locator("button[name='tmplloginsubmit']:visible").first();
  await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => null),
    submit.click({ timeout: 5000 }),
  ]);

  // Don't trust the click: a wrong password just re-renders the form.
  await page.waitForSelector("#logoutbutton", { state: "attached", timeout: 15000 }).catch(() => {});
  if (!(await page.$("#logoutbutton"))) {
    throw new Error("World login failed (no logout button after submit). Check the credentials in Settings.");
  }

  await ensureEnglish(page);
  await page.context().storageState({ path: storageStatePath });
  return { loggedIn: true, usedStoredSession: false, loginPerformed: true };
}

async function parseOrdersFromPage(page) {
  return page.evaluate(() => {
    const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
    const num = (s) => {
      const n = parseFloat((s || "").replace(/[^\d.-]/g, ""));
      return Number.isFinite(n) ? n : null;
    };
    const totalPages = Array.from(
      document.querySelectorAll("#orderspagination .pagination li a")
    ).reduce((acc, a) => {
      const n = parseInt(a.textContent, 10);
      return Number.isFinite(n) ? Math.max(acc, n) : acc;
    }, 1);

    const rows = Array.from(document.querySelectorAll("#orders tr"));
    const orders = rows
      .map((tr, rowIndex) => {
        const cells = tr.querySelectorAll("td");
        const link = cells[1]?.querySelector("a");
        const modalCandidate =
          link?.getAttribute("onclick") || cells[0]?.querySelector("a")?.getAttribute("onclick") || "";
        const modalMatch = modalCandidate.match(/openOrderViewModal\(['"]([^'"]+)/);
        return {
          reference: norm(link?.textContent || ""),
          poNumber: norm(cells[2]?.textContent || "").replace(/^Order PO:\s*/i, ""),
          partsCount: norm(cells[3]?.textContent || ""),
          totalRaw: norm(cells[4]?.innerText || ""),
          total: num(cells[4]?.innerText || ""),
          orderDateRaw: norm(cells[5]?.innerText || ""),
          dateTimestamp: norm(cells[5]?.querySelector("a")?.getAttribute("data-tstamp") || ""),
          href: link?.getAttribute("href") || "",
          modalUrl: modalMatch ? modalMatch[1] : "",
          rowIndex: rowIndex + 1,
        };
      })
      .filter((o) => o.reference);
    return { orders, totalPages };
  });
}

async function scrapeOrdersList(page, maxPages = 1) {
  const orders = [];
  const limit = Math.max(1, maxPages);
  for (let pageNumber = 1; pageNumber <= limit; pageNumber += 1) {
    await page.goto(`${ORDERS_URL}?pageNumber=${pageNumber}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#orders tr", { timeout: 20000 });
    const { orders: pageOrders, totalPages } = await parseOrdersFromPage(page);

    for (const o of pageOrders) {
      const { iso, sageDate, raw } = parseTransbecDate(o.dateTimestamp || o.orderDateRaw);
      orders.push({
        ...o,
        orderDate: iso,
        orderDateRaw: raw || o.orderDateRaw,
        sageDate,
        source: "world",
      });
    }
    // Don't request pages past the last one the site reports.
    if (pageNumber >= totalPages) break;
  }
  return orders;
}

// Detail columns (td index within a line row): 0 image, 1 part "<b>PART</b> / LINE",
// 2 EHC, 3 Core, 4 qty, 5 cost, 6 total. The next row carries brand + description
// in a colspan=5 cell.
async function fetchOrderDetail(context, detailUrl, refLabel = "") {
  if (!detailUrl) return { ok: false, reason: "no-detail-url" };
  const detailPage = await context.newPage();
  const fullUrl = detailUrl.startsWith("http") ? detailUrl : `${BASE_URL}${detailUrl}`;

  try {
    await detailPage.goto(fullUrl, { waitUntil: "domcontentloaded" });
    await detailPage.waitForSelector(".tblorderdeets tbody tr", { timeout: 20000 });
  } catch (err) {
    await detailPage.close();
    return { ok: false, error: `detail-navigation-failed (${err.message || err})` };
  }

  try {
    const detail = await detailPage.evaluate(() => {
      const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
      const num = (s) => {
        const n = parseFloat((s || "").replace(/[^\d.-]/g, ""));
        return Number.isFinite(n) ? n : null;
      };
      const moneyStr = (s) => {
        const n = num(s);
        return n === null ? "" : String(n);
      };

      const reference = norm(document.querySelector("span.oconftxt")?.textContent || "");
      const fromMatch = (document.body.innerText || "").match(/From:\s*([^\n]+)/i);
      const orderTotalMatch = (document.body.innerText || "").match(/Order Total\s*\$?\s*([\d,]+\.\d{2})/i);

      const rows = Array.from(document.querySelectorAll(".tblorderdeets tbody tr"));
      const lineItems = [];
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const bold = row.querySelector("td b");
        if (!bold) continue;
        const tds = row.querySelectorAll("td");

        const partCellText = norm(tds[1]?.innerText || "");
        const slash = partCellText.lastIndexOf("/");
        const partNumber = norm(bold.textContent || (slash >= 0 ? partCellText.slice(0, slash) : partCellText));
        const partLineCode = slash >= 0 ? norm(partCellText.slice(slash + 1)) : "";

        const ehcText = norm(tds[2]?.innerText || "");
        const coreText = norm(tds[3]?.innerText || "");
        const quantity = norm(tds[4]?.textContent || "");
        const costRaw = norm(tds[5]?.innerText || "");
        const extRaw = norm(tds[6]?.innerText || "");
        if (!partNumber || (!quantity && !costRaw && !extRaw)) continue;

        // Cell reads: BRAND<br>ITEM TYPE<br>detail<br><br>vehicle. The item
        // type is what the old World scraper stored as the description, so it
        // stays the description; the remainder is kept as notes.
        let partDescription = "";
        let partBrand = "";
        let partNotes = "";
        const descTd = rows[i + 1]?.querySelector('td[colspan="5"]');
        if (descTd) {
          const segs = (descTd.innerHTML || "")
            .split(/<br\s*\/?>/i)
            .map((h) => norm(h.replace(/<[^>]+>/g, " ")))
            .filter(Boolean);
          partBrand = segs[0] || "";
          partDescription = segs[1] || segs[0] || "";
          partNotes = segs.slice(2).join(" | ");
        }

        lineItems.push({
          partLineCode,
          partNumber,
          costPrice: moneyStr(costRaw),
          costPriceValue: num(costRaw),
          partDescription,
          partBrand,
          partNotes,
          quantity,
          extended: moneyStr(extRaw),
          extendedValue: num(extRaw),
          // EHC cell = per-unit fee, and the line Total INCLUDES it (cost 25.07
          // + EHC 1.35 prints 26.42); the scraper splits that out. The Core
          // cell has not been seen filled yet, so it is kept raw and flagged.
          ehcRaw: ehcText,
          ehcUnit: num(ehcText),
          coreRaw: coreText,
          core: false,
          addedToOutstanding: false,
          hasEnvironmentalFee: false,
          environmentalFeeAmount: null,
        });
      }

      return {
        reference,
        fromLocation: fromMatch ? norm(fromMatch[1]) : "",
        orderTotal: orderTotalMatch ? num(orderTotalMatch[1]) : null,
        lineItems,
      };
    });

    await detailPage.close();
    return { ok: true, detail };
  } catch (err) {
    await detailPage.close();
    return { ok: false, error: err.message || "detail-parse-failed", refLabel };
  }
}

function aggregateProducts(orders) {
  const map = new Map();
  for (const order of orders || []) {
    for (const line of order.lineItems || []) {
      if (!line?.partNumber || line.core) continue;
      const key = `${line.partLineCode || ""}::${line.partNumber}`.toUpperCase();
      if (!map.has(key)) {
        map.set(key, {
          partLineCode: line.partLineCode || "",
          partNumber: line.partNumber,
          partDescription: line.partDescription || "",
          lastCostPrice: line.costPrice || "",
          lastExtended: line.extended || "",
          lastOrderReference: order.reference || "",
          source: "world",
        });
      }
    }
  }
  return Array.from(map.values());
}

module.exports = {
  createContextWithStorage,
  ensureLoggedIn,
  parseOrdersFromPage,
  scrapeOrdersList,
  fetchOrderDetail,
  aggregateProducts,
};
