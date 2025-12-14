// src/scrapers/worldScraper.js
const path = require("path");
const fs = require("fs");
const { chromium } = require("playwright");
const { standardizeOrderForSage } = require("./sageStandardize");
require("dotenv").config();

const WORLD_LOGIN_URL = "https://www.iautoparts.biz/pronto/entrepot/WAW";
const FRAME_BODY_NAME = "fraBody";
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

async function getBodyFrame(page, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const frame = page.frame({ name: FRAME_BODY_NAME });
    if (frame) {
      try {
        await frame.waitForSelector("body", { timeout: 2000 });
        return frame;
      } catch (e) {
        // keep looping
      }
    }
    await page.waitForTimeout(500);
  }

  const frameNames = page.frames().map((f) => f.name() || "<no-name>");
  throw new Error(
    `Could not find frame '${FRAME_BODY_NAME}'. Frames seen: ${frameNames.join(", ")}`
  );
}

async function getHeaderFrame(page, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const frame = page.frame({ name: "fraHeader" });
    if (frame) return frame;
    await page.waitForTimeout(300);
  }
  const frameNames = page.frames().map((f) => f.name() || "<no-name>");
  throw new Error(`Could not find frame 'fraHeader'. Frames seen: ${frameNames.join(", ")}`);
}

// Helper: ensure we have login credentials
function getCredentials() {
  const user = process.env.WORLD_USER;
  const pass = process.env.WORLD_PASS;

  if (!user || !pass) {
    throw new Error("WORLD_USER or WORLD_PASS not set in .env");
  }

  return { user, pass };
}

// Create a browser context, with stored session if available
async function createContextWithStorage(browser, storageStatePath) {
  if (fs.existsSync(storageStatePath)) {
    return await browser.newContext({ storageState: storageStatePath });
  }
  return await browser.newContext();
}

// Login if necessary and save session
async function ensureLoggedIn(page, storageStatePath) {
  const { user, pass } = getCredentials();

  await page.goto(WORLD_LOGIN_URL, { waitUntil: "load" });

  const bodyFrame = await getBodyFrame(page);

  // Try to detect an existing session by looking for the login form
  const loginForm = await bodyFrame.$("form#idLoginMain");
  if (!loginForm) {
    console.log("[world] No login form found; assuming stored session is valid.");
    await page.context().storageState({ path: storageStatePath });
    return { loggedIn: true, usedStoredSession: true, loginPerformed: false };
  }

  const usernameInput =
    (await bodyFrame.$("input[name='username']")) || (await bodyFrame.$("#username"));
  const passwordInput =
    (await bodyFrame.$("input[name='password']")) || (await bodyFrame.$("#password"));
  if (!usernameInput || !passwordInput) {
    throw new Error("Login form located, but username/password inputs were not found.");
  }

  await usernameInput.fill(user);
  await passwordInput.fill(pass);

  // Tick "Remember Me" if present so server can set a persistent cookie
  try {
    const rememberCheckbox =
      (await bodyFrame.$("input[name='wantsRememberMe']")) ||
      (await bodyFrame.$("input[type='checkbox'][name*='remember' i]"));
    if (rememberCheckbox) {
      const checked = await rememberCheckbox.isChecked();
      if (!checked) await rememberCheckbox.check();
    }
  } catch (e) {
    console.warn("[world] could not set Remember Me checkbox", e);
  }

  const submitButton =
    (await bodyFrame.$("input[type='submit']")) ||
    (await bodyFrame.$("button[type='submit']"));
  if (submitButton) {
    await Promise.all([
      submitButton.click(),
      bodyFrame.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => null),
      page.waitForLoadState("domcontentloaded", { timeout: 20000 }).catch(() => null),
    ]);
  } else {
    await Promise.all([
      passwordInput.press("Enter"),
      bodyFrame.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => null),
      page.waitForLoadState("domcontentloaded", { timeout: 20000 }).catch(() => null),
    ]);
  }

  await page.context().storageState({ path: storageStatePath });
  return { loggedIn: true, usedStoredSession: false, loginPerformed: true };
}

async function navigateToOrdersTab(page) {
  // Click the "Orders" tab in the header frame and wait for orders list to render in body
  const headerFrame = await getHeaderFrame(page);
  const ordersTab =
    (await headerFrame.$('td[onclick*="pronto/entrepot/waw/orders"]')) ||
    (await headerFrame.$('td[onclick*="/orders"]'));
  if (ordersTab) {
    await Promise.all([
      ordersTab.click(),
      page.waitForTimeout(300), // let frame start navigation
    ]);
  }

  const bodyFrame = await getBodyFrame(page);
  await bodyFrame.waitForSelector("table.ListWrapper tbody tr", { timeout: 20000 });
  return bodyFrame;
}

async function fetchOrderDetailsFromList(page, reference) {
  if (!reference) return { ok: false, skipped: true, reason: "no-reference" };
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  let bodyFrame = await getBodyFrame(page);

  const navPromise = page.waitForLoadState("domcontentloaded", { timeout: 20000 }).catch(() => null);

  const clickRes = await bodyFrame.evaluate((ref) => {
    const ORDER = (ref || "").trim();
    const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
    const eq = (a, b) => norm(a).toUpperCase() === norm(b).toUpperCase();

    function clickLinkInRow(tr) {
      const link =
        tr.querySelector("td:first-child a.COListLink") ||
        tr.querySelector('td:first-child a[href*="orders_view"]') ||
        tr.querySelector("a.COListLink") ||
        tr.querySelector('a[title*="View" i]');
      if (!link) return false;
      link.scrollIntoView({ block: "center" });
      link.click();
      return true;
    }

    function findAndClick(doc) {
      try {
        const xp = `//table[contains(concat(' ',normalize-space(@class),' '),' ListWrapper ')]//tr[td[normalize-space()='${ORDER}']]`;
        const row = doc.evaluate(xp, doc, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
        if (row && clickLinkInRow(row)) return true;

        const tables = Array.from(doc.querySelectorAll("table.ListWrapper"));
        for (const table of tables) {
          for (const tr of table.querySelectorAll("tr")) {
            const hasOrder = Array.from(tr.cells).some((td) => eq(td.textContent, ORDER));
            if (hasOrder && clickLinkInRow(tr)) return true;
          }
        }

        const frames = Array.from(doc.querySelectorAll("iframe, frame"));
        for (const f of frames) {
          const sub = f.contentDocument || f.contentWindow?.document;
          if (sub && findAndClick(sub)) return true;
        }
      } catch (_) {}
      return false;
    }

    return findAndClick(document);
  }, reference);

  if (!clickRes) {
    return { ok: false, reason: "click-failed" };
  }

  await navPromise;

  // Re-acquire the body frame after navigation
  try {
    await page.waitForTimeout(500); // give frameset a moment to swap
    bodyFrame = await getBodyFrame(page, 20000);
  } catch (e) {
    return { ok: false, error: "detail-frame-missing" };
  }

  try {
    await bodyFrame.waitForSelector("tr.PartO, tr.PartE", { timeout: 20000 });
  } catch (err) {
    return { ok: false, error: "detail-timeout" };
  }

  try {
    const detail = await bodyFrame.evaluate(() => {
      const monthToNumber = {
        January: "01", February: "02", March: "03", April: "04",
        May: "05", June: "06", July: "07", August: "08",
        September: "09", October: "10", November: "11", December: "12",
      };
      const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
      const num = (s) => {
        const n = parseFloat((s || "").replace(/[^\d.-]/g, ""));
        return Number.isFinite(n) ? n : null;
      };

      const lineItems = [];
      const rows = Array.from(document.querySelectorAll("tr.PartO, tr.PartE"));
      let lastLine = null;
      for (const row of rows) {
        const cells = row.querySelectorAll("td");
        if (cells.length <= 3) continue;
        const isCore = norm(cells[0]?.innerText || "") === "Core";
        if (!isCore) {
          const spans = cells[3]?.querySelectorAll("span.PartNum") || [];
          const partLineCode = norm(spans[0]?.innerText || "");
          const partNumber = norm(spans[1]?.innerText || "");
          const costPriceRaw = norm(cells[6]?.querySelector("span.PartPrice")?.innerText || "");
          const partDescription = norm(cells[2]?.querySelector("div.partDesc")?.innerText || "");
          const quantity = norm(cells[7]?.innerText || "");
          const extendedRaw = norm(cells[9]?.querySelector("span.PartPrice")?.innerText || "");
          const entry = {
            partLineCode,
            partNumber,
            costPrice: costPriceRaw,
            costPriceValue: num(costPriceRaw),
            partDescription,
            quantity,
            extended: extendedRaw,
            extendedValue: num(extendedRaw),
            core: false,
            addedToOutstanding: false,
            hasEnvironmentalFee: false,
            environmentalFeeAmount: null,
          };
          lineItems.push(entry);
          lastLine = entry;
        } else if (lastLine) {
          const costPriceRaw = norm(cells[4]?.innerText || "");
          const val = num(costPriceRaw);
          if (val === 0) continue; // skip zero-value core
          const entry = {
            partLineCode: `CORE ${lastLine.partLineCode || ""}`.trim(),
            partNumber: lastLine.partNumber || "",
            costPrice: costPriceRaw,
            costPriceValue: val,
            partDescription: `World Core: ${lastLine.partNumber || ""}`.trim(),
            quantity: lastLine.quantity || "",
            extended: costPriceRaw,
            extendedValue: val,
            core: true,
            addedToOutstanding: false,
            hasEnvironmentalFee: false,
            environmentalFeeAmount: null,
          };
          lineItems.push(entry);
          lastLine = entry;
        }
      }

      const divs = Array.from(document.querySelectorAll("div.COPair"));
      let orderDateRaw = "";
      let sageDate = "";
      let confirmNum = "";
      if (divs[1]) {
        const spans = divs[1].querySelectorAll("span");
        if (spans[1]) orderDateRaw = norm(spans[1].innerText || "");
      }
      if (divs[7]) {
        const spans = divs[7].querySelectorAll("span");
        if (spans[1]) confirmNum = norm(spans[1].innerText || "");
      }
      if (orderDateRaw) {
        const bits = orderDateRaw.split(" ").filter(Boolean);
        // Expected like "Nov 28, 2025 09:50 AM"
        const monthName = bits[0] || "";
        let day = (bits[1] || "").replace(/,/, "");
        const year = bits[2] || "";
        if (day.length === 1) day = `0${day}`;
        const month = monthToNumber[monthName] || "";
        if (day && month && year) {
          sageDate = `${day}${month}${year.slice(-2)}`;
        }
      }

      return {
        lineItems,
        orderDateRaw,
        sageDate,
        referenceFromDetail: confirmNum,
      };
    });

    return { ok: true, detail };
  } catch (err) {
    return { ok: false, error: err.message || "detail-parse-failed" };
  }
}

// Navigate to orders page and scrape
async function scrapeWorldOrders(page) {
  const bodyFrame = await navigateToOrdersTab(page);

  const orders = await bodyFrame.evaluate(() => {
    const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
    const parseTotal = (s) => {
      const n = parseFloat((s || "").replace(/[^\d.-]/g, ""));
      return Number.isFinite(n) ? n : null;
    };
    const parseOrderDate = (txt) => {
      const parts = norm(txt).split(" ");
      // Example: "Nov 28, 2025 09:50 AM"
      const joined = parts.join(" ");
      const d = new Date(joined);
      return Number.isNaN(d.getTime()) ? null : d.toISOString();
    };

    // Pick the table with the most body rows as the likely orders table.
    const tables = Array.from(document.querySelectorAll("table"));
    if (tables.length === 0) return [];

    const pick = tables.reduce(
      (best, tbl) => {
        const rows = tbl.querySelectorAll("tbody tr").length;
        return rows > best.rows ? { rows, table: tbl } : best;
      },
      { rows: 0, table: tables[0] }
    ).table;

    const rows = Array.from(pick.querySelectorAll("tbody tr"));
    return rows.map((tr, rowIndex) => {
      const cells = Array.from(tr.querySelectorAll("td"));
      const link = cells[0]?.querySelector("a[href*='orders_view']");
      const orderDateRaw = norm(cells[1]?.innerText || "");
      const vehicleRaw = norm(cells[2]?.innerText || "");
      const status = norm(cells[3]?.innerText || "");
      const reference = norm(cells[4]?.innerText || "");
      const poNumber = norm(cells[5]?.innerText || "");
      const totalRaw = norm(cells[6]?.innerText || "");
      const orderedBy = norm(cells[8]?.innerText || "");
      const seller = norm(cells[9]?.innerText || "");
      const descRaw = norm(cells[10]?.innerText || "");

      const vehicleBits = vehicleRaw.split(/\s+/);
      const vehicleYear = vehicleBits[0] || "";
      const vehicleMake = vehicleBits[1] || "";
      const vehicleModel = vehicleBits.slice(2).join(" ");

      const isoDate = parseOrderDate(orderDateRaw);
      const sageDate =
        isoDate && !Number.isNaN(Date.parse(isoDate))
          ? (() => {
              const d = new Date(isoDate);
              const dd = String(d.getDate()).padStart(2, "0");
              const mm = String(d.getMonth() + 1).padStart(2, "0");
              const yy = String(d.getFullYear()).slice(-2);
              return `${dd}${mm}${yy}`;
            })()
          : "";

      return {
        reference,
        warehouse: seller || orderedBy || "",
        poNumber,
        orderDateRaw,
        orderDate: isoDate,
        sageDate,
        vehicleYear,
        vehicleMake,
        vehicleModel,
        vehicleDesc: vehicleRaw,
        status,
        totalRaw,
        total: parseTotal(totalRaw),
        orderedBy,
        seller,
        orderDesc: descRaw,
        detailUrl: link?.getAttribute("href") || "",
        source_invoice: "",
        // Booleans for downstream workflow
        detailClicked: false,
        detailStored: false,
        pickedUp: false,
        hasInvoiceNum: false,
        totalVerified: false,
        enteredInSage: false,
        inStore: false,
        lineItems: [],
        source: "world",
        __row: rowIndex + 1,
      };
    });
  });

  return Array.isArray(orders) ? orders : [];
}

// Save scraped orders into JSON file
function saveOrdersToJson(orders, ordersJsonPath) {
  fs.writeFileSync(ordersJsonPath, JSON.stringify(orders, null, 2), "utf8");
}

// MAIN ENTRY: call this from Electron main via IPC
async function getWorldOrders(options = {}) {
  const { storageStatePath, ordersJsonPath } = resolvePaths(options);
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
    const loginInfo = await ensureLoggedIn(page, storageStatePath);
    statusLog.push(
      loginInfo?.usedStoredSession
        ? "Using stored session (no login form)."
        : "Logged in with credentials."
    );

    statusLog.push("Navigating to orders list…");
    const scrapedOrders = await scrapeWorldOrders(page);
    statusLog.push(`Found ${scrapedOrders.length} orders on list page.`);

    // Merge with existing orders (by reference, case-insensitive) without overwriting existing entries.
    const existing = Array.isArray(options.existingOrders) ? options.existingOrders : [];
    const byRef = new Map();
    existing.forEach((o) => {
      if (!o || !o.reference) return;
      const key = String(o.reference).trim().toUpperCase();
      if (key) byRef.set(key, o);
    });

    const newOnes = [];
    for (const order of scrapedOrders) {
      const key = order?.reference ? String(order.reference).trim().toUpperCase() : null;
      if (key && byRef.has(key)) {
        continue; // do not overwrite existing
      }
      newOnes.push(order);
      if (key) byRef.set(key, order);
    }

    // Append new orders; keep originals as-is
    const mergedOrders = existing.concat(newOnes);
    statusLog.push(`Appended ${newOnes.length} new orders. Total now ${mergedOrders.length}.`);

    // Fetch details for any orders that do not yet have detailStored (new or existing)
    let detailFetched = 0;
    const detailCandidates = mergedOrders.filter((o) => o && o.detailStored !== true);
    const detailTrue = mergedOrders.filter((o) => o && o.detailStored === true).length;
    statusLog.push(
      `Detail candidates needing scrape: ${detailCandidates.length} (detailStored=true: ${detailTrue})`
    );
    if (detailCandidates.length) {
      const sampleRefs = detailCandidates
        .map((o) => o.reference || "(no ref)")
        .slice(0, 10)
        .join(", ");
      statusLog.push(`Detail refs (first 10): ${sampleRefs}`);
    }
    if (detailCandidates.length === 0) {
      statusLog.push("No orders need detail fetch (all have detailStored=true).");
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
        order.detailError = detailRes.error || detailRes.reason || "detail-fetch-failed";
        statusLog.push(`✖ Detail failed for ${refLabel}: ${order.detailError}`);
      }
      await page.waitForTimeout(stepWaitMs);
    }
    statusLog.push(`Detail fetch complete. ${detailFetched} detail pages scraped.`);

    const standardizedOrders = mergedOrders.map((o) =>
      standardizeOrderForSage({
        ...o,
        source_invoice: o.source_invoice || "",
        source: "world",
        warehouse: o.warehouse || o.seller || o.orderedBy || "World",
        sage_source: "WOR505",
      })
    );

    saveOrdersToJson(standardizedOrders, ordersJsonPath);

    return {
      ok: true,
      count: standardizedOrders.length,
      path: ordersJsonPath,
      orders: standardizedOrders,
      added: newOnes.length,
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
