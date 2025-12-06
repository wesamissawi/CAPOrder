// src/scrapers/transbecScraper.js
const path = require("path");
const fs = require("fs");
const { chromium } = require("playwright");
require("dotenv").config();

const BASE_URL = "https://orderstransbec.com";
const HOME_URL = `${BASE_URL}/store/home`;
const ORDERS_URL = `${BASE_URL}/store/order-history`;
const LANG_EN_URL = `${BASE_URL}/store/lang-english/`;
// default: visible browser; set TRANSBEC_HEADLESS=true to run headless
const DEFAULT_HEADLESS = process.env.TRANSBEC_HEADLESS === "true";

function resolvePaths(options = {}) {
  const baseDir = options.storageDir || path.join(__dirname, "..");
  const storageStatePath =
    options.storageStatePath || path.join(baseDir, "transbec_storage_state.json");
  const ordersJsonPath = options.ordersPath || path.join(baseDir, "transbec_orders.json");
  const productsJsonPath =
    options.productsPath || path.join(baseDir, "transbec_products.json");
  fs.mkdirSync(path.dirname(storageStatePath), { recursive: true });
  fs.mkdirSync(path.dirname(ordersJsonPath), { recursive: true });
  fs.mkdirSync(path.dirname(productsJsonPath), { recursive: true });
  return { storageStatePath, ordersJsonPath, productsJsonPath };
}

function getCredentials() {
  const user = process.env.TRANSBEC_USER;
  const pass = process.env.TRANSBEC_PASS;
  if (!user || !pass) throw new Error("TRANSBEC_USER or TRANSBEC_PASS not set in .env");
  return { user, pass };
}

async function createContextWithStorage(browser, storageStatePath) {
  if (fs.existsSync(storageStatePath)) {
    return browser.newContext({ storageState: storageStatePath });
  }
  return browser.newContext();
}

function parseTransbecDate(txt) {
  const monthMap = {
    jan: "01",
    feb: "02",
    mar: "03",
    apr: "04",
    avr: "04",
    mai: "05",
    may: "05",
    jun: "06",
    jui: "07",
    jul: "07",
    aug: "08",
    aoû: "08",
    sep: "09",
    oct: "10",
    nov: "11",
    déc: "12",
    dec: "12",
  };
  if (!txt) return { iso: null, sageDate: "" };
  const clean = String(txt).trim();
  const match = clean.match(
    /([A-Za-zéèêëàâäîïôöûüçÉÈÊËÀÂÄÎÏÔÖÛÜÇ]{3,})\.?\s*(\d{1,2}),\s*(\d{4})(?:\s*at\s*(\d{1,2}):(\d{2})\s*(AM|PM|EST|EDT)?)?/i
  );
  if (!match) return { iso: null, sageDate: "" };
  const month = monthMap[match[1].slice(0, 3).toLowerCase()] || "";
  const day = match[2].padStart(2, "0");
  const year = match[3];
  let hour = match[4] ? parseInt(match[4], 10) : 0;
  const minute = match[5] ? parseInt(match[5], 10) : 0;
  const ampm = (match[6] || "").toUpperCase();
  if (ampm === "PM" && hour < 12) hour += 12;
  if (ampm === "AM" && hour === 12) hour = 0;
  if (!month) return { iso: null, sageDate: "" };
  const iso = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), hour, minute, 0)).toISOString();
  return { iso, sageDate: `${day}${month}${year.slice(-2)}` };
}

async function ensureEnglish(page) {
  try {
    await page.goto(LANG_EN_URL, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(800);
  } catch (e) {
    console.warn("[transbec] Unable to switch language to English:", e.message || e);
  }
}

async function findFirst(page, selectors) {
  for (const sel of selectors) {
    const handle = await page.$(sel);
    if (handle) return handle;
  }
  return null;
}

async function findVisibleLocator(page, selectors) {
  for (const sel of selectors) {
    const handles = await page.$$(sel);
    if (!handles.length) continue;
    for (let i = 0; i < handles.length; i++) {
      const h = handles[i];
      if (await h.isVisible().catch(() => false)) return h;
      try {
        await h.evaluate((el) => {
          el.style.display = "block";
          el.style.visibility = "visible";
          el.style.opacity = "1";
          el.removeAttribute("hidden");
        });
        if (await h.isVisible().catch(() => false)) return h;
      } catch (_) {}
    }
  }
  return null;
}

async function dismissOverlays(page) {
  try {
    const overlay = page.locator("#saoverlaycontainer");
    if (await overlay.isVisible().catch(() => false)) {
      await overlay.evaluate((el) => {
        el.style.display = "none";
      });
    }
  } catch (_) {}
}

async function ensureLoggedIn(page, storageStatePath) {
  const { user, pass } = getCredentials();
  await ensureEnglish(page);
  await page.goto(HOME_URL, { waitUntil: "domcontentloaded" });
  await page
    .waitForSelector(
      "#loginform form, #loginemail, #loginpassword, form[action*='login'], form[action=''], input[name='tmplusername']",
      { timeout: 15000 }
    )
    .catch(() => {});

  const logoutBtn = await page.$("#logoutbutton");
  if (logoutBtn) {
    await ensureEnglish(page);
    await page.context().storageState({ path: storageStatePath });
    return { loggedIn: true, usedStoredSession: true, loginPerformed: false };
  }

  await dismissOverlays(page);

  const loginLink = await findFirst(page, [
    'a[href*="user-login"]',
    'a[href*="login"]',
    "#headbtnlogin a",
    "#loginbutton",
  ]);
  if (loginLink) {
    await Promise.all([
      loginLink.click(),
      page.waitForTimeout(400),
    ]);
  }

  const usernameLocator =
    (await findVisibleLocator(page, [
      "#loginemail",
      'input[name="tmplusername"]',
      'input[name="username"]',
      'input[name="userid"]',
      "#username",
      "#userid",
      'input[type="text"][name*="user" i]',
      'input[type="email"]',
    ])) || page.locator("#loginemail").first() || page.locator('input[name="tmplusername"]').first();

  const passwordLocator =
    (await findVisibleLocator(page, [
      "#loginpassword",
      'input[name="tmplpassword"]',
      'input[type="password"]',
      'input[name*="pass" i]',
    ])) || page.locator("#loginpassword").first() || page.locator('input[name="tmplpassword"]').first();

  if (!usernameLocator || !passwordLocator) {
    // Last resort: force-fill via DOM visibility filtering
    const domFill = await page.evaluate(([u, p]) => {
      const pickVisible = (nodes) => nodes.find((n) => n && n.offsetParent !== null) || nodes[0];
      const uEl = pickVisible(
        Array.from(
          document.querySelectorAll('#sidesearch #loginemail, #loginform #loginemail, input[name="tmplusername"], input#loginemail')
        )
      );
      const pEl = pickVisible(
        Array.from(
          document.querySelectorAll('#sidesearch #loginpassword, #loginform #loginpassword, input[name="tmplpassword"], input#loginpassword')
        )
      );
      if (uEl) {
        uEl.value = u;
        uEl.dispatchEvent(new Event("input", { bubbles: true }));
        uEl.dispatchEvent(new Event("change", { bubbles: true }));
      }
      if (pEl) {
        pEl.value = p;
        pEl.dispatchEvent(new Event("input", { bubbles: true }));
        pEl.dispatchEvent(new Event("change", { bubbles: true }));
      }
      return { uOk: Boolean(uEl), pOk: Boolean(pEl) };
    }, [user, pass]);

    if (!domFill?.uOk || !domFill?.pOk) {
      throw new Error("Could not locate Transbec login inputs on the page.");
    }
  } else {
    await usernameLocator.scrollIntoViewIfNeeded().catch(() => {});
    await passwordLocator.scrollIntoViewIfNeeded().catch(() => {});

    try {
      await usernameLocator.fill(user, { timeout: 5000 });
      await passwordLocator.fill(pass, { timeout: 5000 });
    } catch (_) {
      await page.evaluate(
        ([u, p]) => {
          const uEl =
            document.querySelector("#loginemail") ||
            document.querySelector('input[name="tmplusername"]') ||
            document.querySelector('input[name="username"]');
          const pEl =
            document.querySelector("#loginpassword") ||
            document.querySelector('input[name="tmplpassword"]') ||
            document.querySelector('input[type="password"]');
          if (uEl) {
            uEl.value = u;
            uEl.dispatchEvent(new Event("input", { bubbles: true }));
            uEl.dispatchEvent(new Event("change", { bubbles: true }));
          }
          if (pEl) {
            pEl.value = p;
            pEl.dispatchEvent(new Event("input", { bubbles: true }));
            pEl.dispatchEvent(new Event("change", { bubbles: true }));
          }
        },
        [user, pass]
      );
    }
  }

  const remember = await findFirst(page, [
    'input[type="checkbox"][name*="remember" i]',
    'input[type="checkbox"][id*="remember" i]',
    'input[name="tmplrememberme"]',
  ]);
  if (remember) {
    try {
      const checked = await remember.isChecked();
      if (!checked) await remember.check();
    } catch (e) {
      console.warn("[transbec] failed to tick remember checkbox", e);
    }
  }

  await dismissOverlays(page);

  // Click visible login button, prefer ones in the sidebar/login form
  const buttonSelectors = [
    "#sidesearch button[name='tmplloginsubmit']",
    "#loginform button[name='tmplloginsubmit']",
    "button[name='tmplloginsubmit']",
    "button[type='submit']",
    "input[type='submit']",
  ];

  let clicked = false;
  for (const sel of buttonSelectors) {
    const handles = await page.$$(sel);
    for (const h of handles) {
      if (!(await h.isVisible().catch(() => false))) continue;
      await h.scrollIntoViewIfNeeded().catch(() => {});
      try {
        await Promise.all([
          h.click({ timeout: 5000 }),
          page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => null),
        ]);
        clicked = true;
        break;
      } catch (_) {
        // try next
      }
    }
    if (clicked) break;
  }

  if (!clicked) {
    const domClicked = await page.evaluate(() => {
      const pickVisible = (nodes) => nodes.find((n) => n && n.offsetParent !== null) || nodes[0];
      const btn = pickVisible(
        Array.from(
          document.querySelectorAll(
            "#sidesearch button[name='tmplloginsubmit'], #loginform button[name='tmplloginsubmit'], button[type='submit'], input[type='submit']"
          )
        )
      );
      if (btn) {
        btn.click();
        return true;
      }
      return false;
    });
    if (domClicked) {
      await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => null);
      clicked = true;
    }
  }

  if (!clicked && passwordLocator) {
    await Promise.all([
      passwordLocator.press("Enter").catch(() => {}),
      page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => null),
    ]);
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
    const rows = Array.from(document.querySelectorAll("#orders tr"));
    const orders = rows
      .map((tr, rowIndex) => {
        const cells = tr.querySelectorAll("td");
        const link = cells[1]?.querySelector("a");
        const modalCandidate =
          link?.getAttribute("onclick") ||
          cells[0]?.querySelector("a")?.getAttribute("onclick") ||
          "";
        const modalMatch = modalCandidate.match(/openOrderViewModal\(['"]([^'"]+)/);
        const modalUrl = modalMatch ? modalMatch[1] : "";

        const totalPages = Array.from(
          document.querySelectorAll("#orderspagination .pagination li a")
        ).reduce((acc, a) => {
          const num = parseInt(a.textContent, 10);
          return Number.isFinite(num) ? Math.max(acc, num) : acc;
        }, 1);

        return {
          reference: norm(link?.textContent || ""),
          poNumber: norm(cells[2]?.textContent || "").replace(/^Order PO:\s*/i, ""),
          partsCount: norm(cells[3]?.textContent || ""),
          totalRaw: norm(cells[4]?.innerText || ""),
          total: num(cells[4]?.innerText || ""),
          orderDateRaw: norm(cells[5]?.innerText || ""),
          dateTimestamp: norm(cells[5]?.querySelector("a")?.getAttribute("data-tstamp") || ""),
          href: link?.getAttribute("href") || "",
          modalUrl,
          rowIndex: rowIndex + 1,
          totalPages,
        };
      })
      .filter((o) => o.reference);

    const maxPage = orders.reduce((acc, o) => Math.max(acc, o.totalPages || 1), 1);
    return { orders, totalPages: maxPage };
  });
}

async function scrapeOrdersList(page, maxPages = 1) {
  let pageNumber = 1;
  const orders = [];

  while (pageNumber <= Math.max(1, maxPages)) {
    await page.goto(`${ORDERS_URL}?pageNumber=${pageNumber}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#orders tr", { timeout: 20000 });
    const { orders: pageOrders } = await parseOrdersFromPage(page);

    for (const o of pageOrders) {
      const { iso, sageDate } = o.dateTimestamp
        ? parseTransbecDate(o.dateTimestamp)
        : parseTransbecDate(o.orderDateRaw);
      orders.push({
        ...o,
        orderDate: iso,
        sageDate,
        source: "transbec",
      });
    }

    pageNumber += 1;
  }

  return orders;
}

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
      const monthMap = {
        jan: "01",
        feb: "02",
        mar: "03",
        apr: "04",
        avr: "04",
        mai: "05",
        may: "05",
        jun: "06",
        jui: "07",
        jul: "07",
        aug: "08",
        aoû: "08",
        sep: "09",
        oct: "10",
        nov: "11",
        déc: "12",
        dec: "12",
      };
      const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
      const money = (s) => norm(s).replace(/[^\d.,-]/g, "").replace(",", ".") || "";
      const num = (s) => {
        const n = parseFloat((s || "").replace(/[^\d.-]/g, ""));
        return Number.isFinite(n) ? n : null;
      };

      const bodyText = document.body.innerText || "";
      const dateMatch = bodyText.match(
        /([A-Za-zéèêëàâäîïôöûüçÉÈÊËÀÂÄÎÏÔÖÛÜÇ]{3,})\.?[^\d]*(\d{1,2}),\s*(\d{4})/
      );
      let orderDateRaw = "";
      let orderDate = null;
      let sageDate = "";
      if (dateMatch) {
        orderDateRaw = dateMatch[0];
        const month = monthMap[dateMatch[1].slice(0, 3).toLowerCase()] || "";
        const day = dateMatch[2].padStart(2, "0");
        const year = dateMatch[3];
        if (month) {
          orderDate = new Date(`${year}-${month}-${day}T00:00:00.000Z`).toISOString();
          sageDate = `${day}${month}${year.slice(-2)}`;
        }
      }

      const reference = norm(document.querySelector("span.oconftxt")?.textContent || "");

      const rows = Array.from(document.querySelectorAll(".tblorderdeets tbody tr"));
      const lineItems = [];

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const bold = row.querySelector("td b");
        if (!bold) continue;

        const tds = row.querySelectorAll("td");
        const partCellText = norm(tds[1]?.innerText || "");
        const [partNumRaw, lineCodeRaw] = partCellText.split("/");
        const partNumber = norm(partNumRaw || bold.textContent || "");
        const partLineCode = norm(lineCodeRaw || "").replace(/^\/\s*/, "") || "TRB";

        const quantity = norm(tds[4]?.textContent || "");
        const costPrice = money(tds[5]?.innerText || "");
        const extended = money(tds[6]?.innerText || "");
        const costPriceValue = num(tds[5]?.innerText || "");
        const extendedValue = num(tds[6]?.innerText || "");
        const coreText = norm(tds[3]?.innerText || "");

        // Skip rows that don't look like a real line (no partNumber or no quantity/cost)
        if (!partNumber || partNumber.includes("Application:") || partNumber.includes("$")) continue;
        if (!quantity && !costPrice && !extended) continue;

        let partDescription = "";
        const nextRow = rows[i + 1];
        if (nextRow && nextRow.querySelector('td[colspan="5"]')) {
          const descTd = nextRow.querySelector('td[colspan="5"]');
          partDescription = norm(
            (descTd?.textContent || "")
              .replace(/Popularity:.*$/i, "")
              .replace(/Application:/i, "Application:")
          );
          // Drop leading "TRANSBEC" branding when present
          partDescription = partDescription.replace(/^TRANSBEC\s*/i, "").trim();
        }

        lineItems.push({
          partLineCode,
          partNumber,
          costPrice,
          costPriceValue,
          partDescription,
          quantity,
          extended,
          extendedValue,
          core: coreText !== "",
          addedToOutstanding: false,
          hasEnvironmentalFee: false,
          environmentalFeeAmount: null,
        });
      }

      return {
        reference,
        orderDateRaw,
        orderDate,
        sageDate,
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
      if (!line?.partNumber) continue;
      const key = `${line.partLineCode || ""}::${line.partNumber}`.toUpperCase();
      if (!map.has(key)) {
        map.set(key, {
          partLineCode: line.partLineCode || "",
          partNumber: line.partNumber,
          partDescription: line.partDescription || "",
          lastCostPrice: line.costPrice || "",
          lastExtended: line.extended || "",
          lastOrderReference: order.reference || "",
          source: "transbec",
        });
      }
    }
  }
  return Array.from(map.values());
}

function saveJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data ?? [], null, 2), "utf8");
}

async function getTransbecOrders(options = {}) {
  const { storageStatePath, ordersJsonPath, productsJsonPath } = resolvePaths(options);
  const headless = options.headless ?? DEFAULT_HEADLESS;
  const maxPages = options.maxPages ?? 1; // default: only scrape first page
  const existingOrders = Array.isArray(options.existingOrders) ? options.existingOrders : [];
  const existingByRef = new Map(
    existingOrders
      .filter((o) => o && o.reference)
      .map((o) => [String(o.reference).trim().toUpperCase(), o])
  );
  const statusLog = [];
  const stepWaitMs = options.stepWaitMs ?? 1200;
  const browser = await chromium.launch({
    headless,
    slowMo: options.slowMo ?? (headless ? 0 : 150),
  });

  let page;
  try {
    const context = await createContextWithStorage(browser, storageStatePath);
    page = await context.newPage();

    statusLog.push("Opening Transbec home…");
    const loginInfo = await ensureLoggedIn(page, storageStatePath);
    statusLog.push(
      loginInfo?.usedStoredSession
        ? "Using stored Transbec session (cookie/state)."
        : "Logged in to Transbec with credentials."
    );

    statusLog.push(`Scraping Transbec order list (max ${maxPages} page${maxPages === 1 ? "" : "s"})…`);
    const rawOrders = await scrapeOrdersList(page, maxPages);
    statusLog.push(`Found ${rawOrders.length} orders on scanned page(s).`);

    // Normalize orders similar to world fields
    const orders = rawOrders.map((o) => ({
      ...o,
      warehouse: "Transbec",
      seller: "Transbec",
      orderDateRaw: o.orderDateRaw || o.dateTimestamp || "",
      orderDate: o.orderDate || null,
      sageDate: o.sageDate || "",
      vehicleYear: "",
      vehicleMake: "",
      vehicleModel: "",
      vehicleDesc: "",
      status: "",
      orderedBy: o.orderedBy || "",
      orderDesc: "",
      detailUrl: o.href || o.modalUrl || "",
      source_invoice: "",
      detailClicked: false,
      detailStored: false,
      pickedUp: false,
      hasInvoiceNum: false,
      totalVerified: false,
      enteredInSage: false,
      inStore: false,
      lineItems: [],
      source: "transbec",
      __row: o.rowIndex || null,
    }));

    let detailFetched = 0;
    for (const order of orders) {
      const refKey = order.reference ? String(order.reference).trim().toUpperCase() : "";
      if (refKey && existingByRef.has(refKey)) {
        // Keep existing version; skip detail fetch
        order.detailStored = true;
        continue;
      }
      if (!order.modalUrl && !order.href) {
        order.detailError = "no-detail-url";
        continue;
      }
      const detailRes = await fetchOrderDetail(context, order.modalUrl || order.href, order.reference);
      if (detailRes.ok && detailRes.detail) {
        order.lineItems = detailRes.detail.lineItems || [];
        order.orderDate = order.orderDate || detailRes.detail.orderDate;
        order.orderDateRaw = order.orderDateRaw || detailRes.detail.orderDateRaw;
        order.sageDate = order.sageDate || detailRes.detail.sageDate;
        order.reference = order.reference || detailRes.detail.reference;
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
      if (!mergedMap.has(key)) mergedMap.set(key, o);
    }
    const mergedOrders = Array.from(mergedMap.values());

    const products = aggregateProducts(mergedOrders);
    statusLog.push(`Aggregated ${products.length} unique products from order line items.`);

    saveJson(ordersJsonPath, mergedOrders);
    saveJson(productsJsonPath, products);

    return {
      ok: true,
      source: "transbec",
      orders: mergedOrders,
      products,
      ordersPath: ordersJsonPath,
      productsPath: productsJsonPath,
      storageStatePath,
      detailFetched,
      headless,
      statusLog,
      loginInfo,
    };
  } catch (err) {
    console.error("[transbec] scraper error:", err);
    try {
      const screenshotPath = path.join(
        path.dirname(ordersJsonPath || storageStatePath),
        "transbec_error.png"
      );
      if (page) await page.screenshot({ path: screenshotPath, fullPage: true });
      console.error("[transbec] saved error screenshot to", screenshotPath);
    } catch (s) {
      console.error("[transbec] could not save error screenshot", s);
    }
    return { ok: false, error: err.message || String(err), statusLog };
  } finally {
    await browser.close();
  }
}

module.exports = {
  getTransbecOrders,
};
