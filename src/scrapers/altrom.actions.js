// src/scrapers/altrom.actions.js
// Altrom PROLink (pro.altromprolink.ca) — an SAP Commerce / React storefront
// behind Cloudflare. The Invoices page is driven by a JSON API, so nothing here
// parses HTML tables or PDFs:
//
//   POST /api/invoices/invoices/search
//        { source, pageNumber, pageSize, filterCriteria: [storeARNumbers,
//          startDate, endDate] }  -> { totalItems, totalPages, invoices: [...] }
//   GET  /api/invoices/invoices/invoiceNumber/{n}/storeNumber/{s}/invoiceDateTime/{t}
//        -> full invoice JSON (header, tax, invoicePurchaseDetails = line items).
//        The page's "PDF" button calls the same URL; with no PDF Accept header
//        it answers JSON, which is what we want.
//
// Two gotchas, both found against the live site (2026-10-17):
//  1. Both calls need `Authorization: Bearer <~1h Google ID token>` plus a
//     `source: PLNK_ALTROM` header, minted by the page's JS. We don't
//     reimplement that: we load the Invoices page, let it fire its own search,
//     and lift the headers AND the storeARNumbers filter off that request.
//  2. Cloudflare answers any request made from Node (context.request) with a
//     "Just a moment..." challenge page, and challenges a stock automated
//     Chromium on page loads too. So the browser is launched with
//     AutomationControlled disabled, and every API call runs as fetch() INSIDE
//     the page, where the Cloudflare clearance cookie applies.
const fs = require("fs");

const BASE_URL = "https://pro.altromprolink.ca";
const INVOICES_URL = `${BASE_URL}/my-account/invoices`;
// The search endpoint rejects ranges over 365 days ("date range cannot be more
// than 365 days").
const MAX_RANGE_DAYS = 360;

function getCredentials(creds) {
  const user = (creds && (creds.user || creds.ALTROM_USER || creds.username)) || process.env.ALTROM_USER;
  const pass = (creds && (creds.pass || creds.ALTROM_PASS || creds.password)) || process.env.ALTROM_PASS;
  if (!user || !pass) {
    throw new Error("Missing ALTROM credentials. Set them in Settings.");
  }
  return { user, pass };
}

const LAUNCH_ARGS = ["--disable-blink-features=AutomationControlled"];

async function createContextWithStorage(browser, storageStatePath) {
  const opts = { viewport: { width: 1366, height: 900 } };
  if (fs.existsSync(storageStatePath)) {
    return browser.newContext({ ...opts, storageState: storageStatePath });
  }
  return browser.newContext(opts);
}

// Cloudflare's interstitial titles itself "Just a moment..." and redirects to
// the real page on its own once the challenge clears.
async function waitPastCloudflare(page, timeoutMs = 40000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const title = await page.title().catch(() => "");
    if (!/just a moment/i.test(title)) return;
    await page.waitForTimeout(1500);
  }
  throw new Error("Altrom site is stuck on the Cloudflare check. Try again, or turn off headless scrapers in Settings.");
}

async function isLoginFormVisible(page) {
  return (
    (await page.isVisible("#j_usernamehomepage").catch(() => false)) ||
    (await page.isVisible("#j_username").catch(() => false))
  );
}

// Open the Invoices page and capture the authenticated search request the page
// makes on its own. Logs in first if the stored session has lapsed. Returns
// { authHeaders, storeARNumbers } for callAltromApi().
async function openInvoicesAndCaptureAuth(page, storageStatePath, statusLog = [], credentials) {
  const capture = () =>
    page
      .waitForRequest((r) => /\/api\/invoices\/invoices\/search/.test(r.url()) && r.method() === "POST", {
        timeout: 45000,
      })
      .catch(() => null);

  // Start from the homepage: a logged-out hit on /my-account/invoices answers a
  // bare "Server Error" page (no redirect, no login form), so the session can't
  // be judged from there. The homepage shows the login form only when logged out.
  await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await waitPastCloudflare(page);
  await page.waitForLoadState("load", { timeout: 20000 }).catch(() => {});

  let usedStoredSession = true;
  if (await isLoginFormVisible(page)) {
    usedStoredSession = false;
    const { user, pass } = getCredentials(credentials);
    // The homepage carries two copies of the login form (header dropdown and
    // page body); only one is visible at a time.
    const home = await page.isVisible("#j_usernamehomepage").catch(() => false);
    const userSel = home ? "#j_usernamehomepage" : "#j_username";
    const passSel = home ? "#j_passwordhomepage" : "#j_password";
    statusLog.push("Submitting Altrom login…");
    await page.fill(userSel, user);
    await page.fill(passSel, pass);
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => null),
      page.press(passSel, "Enter"),
    ]);
    await waitPastCloudflare(page);
    if (await isLoginFormVisible(page)) {
      throw new Error("Altrom login did not complete. Check the username/password in Settings.");
    }
    statusLog.push("Altrom login complete.");
  } else {
    statusLog.push("Using stored Altrom session.");
  }

  const searchReqPromise = capture();
  await page.goto(INVOICES_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await waitPastCloudflare(page);
  const req = await searchReqPromise;
  if (!req) {
    throw new Error("Altrom Invoices page never requested its invoice list (page layout may have changed).");
  }
  const headers = req.headers();
  if (!headers.authorization) {
    throw new Error("Altrom invoice request carried no Authorization token.");
  }
  let storeARNumbers = "";
  try {
    const body = JSON.parse(req.postData() || "{}");
    const crit = (body.filterCriteria || []).find((c) => c.fieldName === "storeARNumbers");
    storeARNumbers = crit ? String(crit.fieldValue || "") : "";
  } catch (_) {}
  if (!storeARNumbers) {
    throw new Error("Could not determine the Altrom store/account number from the Invoices page.");
  }

  await page.context().storageState({ path: storageStatePath });
  return {
    usedStoredSession,
    authHeaders: { authorization: headers.authorization, source: headers.source || "PLNK_ALTROM" },
    storeARNumbers,
  };
}

// fetch() from inside the page (see gotcha 2 above). Returns parsed JSON or
// throws with the server's message.
async function callAltromApi(page, authHeaders, path, { method = "GET", body } = {}) {
  const res = await page.evaluate(
    async ({ path, method, body, authHeaders }) => {
      const r = await fetch(path, {
        method,
        headers: { Accept: "application/json", "Content-Type": "application/json", ...authHeaders },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: r.status, text: await r.text() };
    },
    { path, method, body, authHeaders }
  );
  let json = null;
  try {
    json = JSON.parse(res.text);
  } catch (_) {}
  if (res.status !== 200 || !json) {
    const msg = (json && (json.debugMessage || json.message)) || res.text.slice(0, 120);
    throw new Error(`Altrom API ${method} ${path} -> HTTP ${res.status}: ${msg}`);
  }
  return json;
}

// All invoice/credit headers in the trailing `days` window, every page.
async function searchInvoices(page, auth, { days = 60 } = {}) {
  const span = Math.min(Math.max(1, days), MAX_RANGE_DAYS);
  const endDate = Date.now();
  const startDate = endDate - span * 24 * 60 * 60 * 1000;
  const out = [];
  for (let pageNumber = 0; pageNumber < 50; pageNumber++) {
    const data = await callAltromApi(page, auth.authHeaders, "/api/invoices/invoices/search", {
      method: "POST",
      body: {
        source: "PLNK",
        pageNumber,
        pageSize: 100,
        filterCriteria: [
          { fieldName: "storeARNumbers", fieldValue: auth.storeARNumbers },
          { fieldName: "startDate", fieldValue: String(startDate) },
          { fieldName: "endDate", fieldValue: String(endDate) },
        ],
      },
    });
    const list = Array.isArray(data.invoices) ? data.invoices : [];
    out.push(...list);
    const totalPages = Number(data.totalPages) || 1;
    if (pageNumber + 1 >= totalPages || !list.length) break;
  }
  return out;
}

async function fetchInvoiceDetail(page, auth, inv) {
  const path = `/api/invoices/invoices/invoiceNumber/${encodeURIComponent(inv.invoiceNumber)}/storeNumber/${encodeURIComponent(
    inv.storeNumber
  )}/invoiceDateTime/${encodeURIComponent(inv.invoiceDate)}`;
  return callAltromApi(page, auth.authHeaders, path);
}

function dateParts(ms) {
  const d = new Date(Number(ms));
  if (!Number.isFinite(d.getTime())) return { iso: null, sageDate: "", raw: "" };
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = String(d.getFullYear());
  return { iso: d.toISOString(), sageDate: `${dd}${mm}${yyyy.slice(-2)}`, raw: `${yyyy}/${mm}/${dd}` };
}

function money2(n) {
  return Number.isFinite(n) ? n.toFixed(2) : "";
}

function cents(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function isEnvironmentalCharge(l) {
  return /environmental/i.test(l?.invoiceLineItemTypeDescription || "");
}

// invoicePurchaseDetails -> CAPOrder line items. `netPrice` is our unit cost
// (`price` is list); `total` is the signed extended amount. productLine is the
// real line code (e.g. "XUS"), so capRules' default "<line> <part>" applies.
//
// Altrom bills the eco fee as its OWN line right under the part it belongs to
// (line "ENV", e.g. "ENV 035 FILTERS LESS THAN 8IN 0.50" under an oil filter).
// The app's convention (renderer/src/utils/environmentalFee.js) is a per-unit
// fee recorded on the part itself, so each ENV line is folded into the part
// above it: `environmentalFeeAmount` per unit + `ehcExtended` as billed. An
// ENV line with no part above it is kept as a line so its money isn't lost.
function mapLineItems(detail) {
  const lines = Array.isArray(detail?.invoicePurchaseDetails) ? detail.invoicePurchaseDetails : [];
  const out = [];
  for (const l of lines) {
    if (!l || !String(l.partNumber || "").trim()) continue;
    const qty = Number(l.quantity);
    const net = Number(l.netPrice);
    const total = Number(l.total);
    const prev = out[out.length - 1];
    if (isEnvironmentalCharge(l) && prev && !prev.ehcExtended && Number.isFinite(total)) {
      const prevQty = Math.abs(Number(prev.quantity)) || 1;
      prev.ehcExtended = cents(total);
      prev.ehcUnit = cents(Math.abs(total) / prevQty);
      prev.hasEnvironmentalFee = true;
      prev.environmentalFeeAmount = prev.ehcUnit.toFixed(2);
      prev.ehcCode = `${String(l.productLine || "").trim()} ${String(l.partNumber || "").trim()}`.trim();
      continue;
    }
    out.push({
      partLineCode: String(l.productLine || "").trim(),
      partNumber: String(l.partNumber || "").trim(),
      partDescription: String(l.partDescription || "").trim(),
      quantity: Number.isFinite(qty) ? String(qty) : "",
      costPrice: money2(net),
      costPriceValue: Number.isFinite(net) ? net : null,
      extended: money2(total),
      extendedValue: Number.isFinite(total) ? total : null,
      core: Boolean(l.coreIndicatorFlag),
      lineType: l.invoiceLineItemTypeDescription || "",
      addedToOutstanding: false,
    });
  }
  return out;
}

// sage_lineItems carry the fee-INCLUSIVE figures, because enterSagePurchases.ahk
// types costPrice/extended verbatim and knows nothing about EHC — dropping it is
// exactly the World credit 02KQ8236 bug. Same split as App.jsx's
// toWorldCreditOrderLines: cost + fee per unit, extended + fee as billed.
function applyEhcToSageLines(sageLines) {
  return (sageLines || []).map((li) => {
    if (!li || !li.ehcExtended) return li;
    const cost = (Number(li.costPriceValue) || 0) + (Number(li.ehcUnit) || 0);
    const ext = (Number(li.extendedValue) || 0) + (Number(li.ehcExtended) || 0);
    return {
      ...li,
      costPrice: cents(cost).toFixed(2),
      costPriceValue: cents(cost),
      extended: cents(ext).toFixed(2),
      extendedValue: cents(ext),
    };
  });
}

module.exports = {
  LAUNCH_ARGS,
  createContextWithStorage,
  openInvoicesAndCaptureAuth,
  searchInvoices,
  fetchInvoiceDetail,
  mapLineItems,
  applyEhcToSageLines,
  dateParts,
};
