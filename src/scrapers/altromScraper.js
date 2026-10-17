// src/scrapers/altromScraper.js
// Altrom PROLink order pull. Mirrors tigerScraper.js: the vendor portal is the
// source of truth, every charge invoice becomes an order keyed by Altrom's
// invoice number, deduped by source+reference. See altrom.actions.js for how
// the portal's JSON API is reached.
const path = require("path");
const fs = require("fs");
const { chromium } = require("playwright");
const { standardizeOrderForSage } = require("./sageStandardize");
const {
  LAUNCH_ARGS,
  createContextWithStorage,
  openInvoicesAndCaptureAuth,
  searchInvoices,
  fetchInvoiceDetail,
  mapLineItems,
  applyEhcToSageLines,
  dateParts,
} = require("./altrom.actions");
require("dotenv").config();

const DEFAULT_HEADLESS = process.env.ALTROM_HEADLESS === "true";
// Trailing window of invoices to look at. Already-known invoice numbers are
// skipped before any detail fetch, so this only bounds the cheap list call.
const DEFAULT_DAYS = 60;

function round2(n) {
  return Math.round(n * 100) / 100;
}

function applyAltromDefaults(order = {}) {
  // Like Tiger, the portal hands us the invoice # and a billed total straight
  // from Altrom's billing system, so fill the fields the invoice-fetch flows
  // fill for other vendors.
  const invoiceNum = (order.invoiceNum || "").toString().trim();
  const total = typeof order.total === "number" ? order.total : null;
  return standardizeOrderForSage({
    ...order,
    source: "altrom",
    warehouse: order.warehouse || "Altrom",
    sage_source: order.sage_source || "NAP505",
    seller: order.seller || "Altrom",
    detailClicked: order.detailClicked ?? false,
    detailStored: order.detailStored ?? true,
    pickedUp: order.pickedUp ?? false,
    source_invoice: order.source_invoice || invoiceNum || "",
    hasInvoiceNum: order.hasInvoiceNum ?? Boolean(invoiceNum),
    billed_total: order.billed_total ?? total,
    totalVerified: order.totalVerified ?? (total !== null),
    enteredInSage: order.enteredInSage ?? false,
    inStore: order.inStore ?? false,
  });
}

function resolvePaths(options = {}) {
  const baseDir = options.storageDir || path.join(__dirname, "..");
  const storageStatePath =
    options.storageStatePath || path.join(baseDir, "altrom_storage_state.json");
  const ordersJsonPath = options.ordersPath || path.join(baseDir, "altrom_orders.json");
  fs.mkdirSync(path.dirname(storageStatePath), { recursive: true });
  fs.mkdirSync(path.dirname(ordersJsonPath), { recursive: true });
  return { storageStatePath, ordersJsonPath };
}

function mergeOrders(existing = [], incoming = []) {
  const byRef = new Map();
  const normalizeVendor = (order) =>
    (order?.source || order?.warehouse || order?.seller || "").toString().trim().toLowerCase();
  const scopedKey = (order) => {
    const ref = order?.reference ? String(order.reference).trim().toUpperCase() : "";
    const vendor = normalizeVendor(order);
    return ref ? `${vendor || "unknown"}::${ref}` : "";
  };
  (existing || []).forEach((o) => {
    if (!o) return;
    const key = scopedKey(o) || `EXISTING-${byRef.size}`;
    byRef.set(key, o);
  });
  (incoming || []).forEach((o) => {
    if (!o) return;
    const key = scopedKey(o) || `NEW-${byRef.size}`;
    const prev = byRef.get(key) || {};
    const next = {
      ...prev,
      ...o,
      lineItems: Array.isArray(o.lineItems) && o.lineItems.length ? o.lineItems : prev.lineItems || [],
    };
    if (prev.source && o.source && prev.source !== o.source) next.source = prev.source;
    if (prev.sage_source && o.sage_source && prev.sage_source !== o.sage_source) {
      next.sage_source = prev.sage_source;
    }
    byRef.set(key, next);
  });
  return Array.from(byRef.values());
}

// Build an order from a search row + its detail JSON. The detail's own
// arithmetic is audited (lines sum to subtotal, subtotal + tax = total, total
// matches the list row) so a malformed response can't slip through as a
// "verified" total.
function buildOrder(row, detail) {
  const h = detail?.invoiceHeader || {};
  const invoiceNumber = String(row.invoiceNumber || h.invoiceNumber || "").trim();
  const { iso, sageDate, raw } = dateParts(row.invoiceDate ?? h.invoiceDateTime);
  const lineItems = mapLineItems(detail);
  const total = Number.isFinite(Number(h.totalAmount)) ? Number(h.totalAmount) : Number(row.invoiceTotal);
  const subtotal = Number(h.subTotalAmount);
  const tax = round2((Number(detail?.tax?.tax1Total) || 0) + (Number(detail?.tax?.tax2Total) || 0));
  const lineSum = round2(lineItems.reduce((s, l) => s + (l.extendedValue || 0) + (l.ehcExtended || 0), 0));
  const ehcTotal = round2(lineItems.reduce((s, l) => s + (l.ehcExtended || 0), 0));
  const salesOrder = (h.order || []).find((o) => /sales order/i.test(o.orderType || ""))?.orderValue || row.salesOrderNumber || "";
  const prolinkOrder = (h.order || []).find((o) => /prolink/i.test(o.orderType || ""))?.orderValue || "";

  const problems = [];
  if (!lineItems.length) problems.push("no line items");
  if (Number.isFinite(subtotal) && Math.abs(lineSum - subtotal) > 0.01) {
    problems.push(`lines sum ${lineSum.toFixed(2)} ≠ subtotal ${subtotal.toFixed(2)}`);
  }
  if (Number.isFinite(subtotal) && Math.abs(round2(subtotal + tax) - total) > 0.01) {
    problems.push(`subtotal + tax ${round2(subtotal + tax).toFixed(2)} ≠ total ${total.toFixed(2)}`);
  }
  if (Number.isFinite(Number(row.invoiceTotal)) && Math.abs(Number(row.invoiceTotal) - total) > 0.01) {
    problems.push(`list total ${Number(row.invoiceTotal).toFixed(2)} ≠ invoice total ${total.toFixed(2)}`);
  }

  const order = applyAltromDefaults({
    reference: invoiceNumber,
    invoiceNum: invoiceNumber,
    orderId: salesOrder,
    salesOrderNumber: salesOrder,
    prolinkOrderNumber: prolinkOrder,
    poNumber: String(row.refrencePONumber || h.referencePONumber || "").trim(),
    storeNumber: row.storeNumber || "",
    altromInvoiceDateTime: row.invoiceDate ?? h.invoiceDateTime ?? null,
    orderDateRaw: raw,
    orderDate: iso,
    sageDate,
    lineItems,
    hasEnvironmentalFee: ehcTotal !== 0,
    environmentalFeeAmount: ehcTotal !== 0 ? ehcTotal.toFixed(2) : "",
    subtotal: Number.isFinite(subtotal) ? subtotal : null,
    tax,
    total,
    totalRaw: Number.isFinite(total) ? total.toFixed(2) : "",
    billed_total: total,
    totalVerified: problems.length === 0,
    altromAuditProblems: problems,
    detailFetchedAt: new Date().toISOString(),
  });
  order.sage_lineItems = applyEhcToSageLines(order.sage_lineItems);
  const sageSum = round2(order.sage_lineItems.reduce((s, l) => s + (Number(l.extendedValue) || 0), 0));
  if (Number.isFinite(subtotal) && Math.abs(sageSum - subtotal) > 0.01) {
    problems.push(`Sage lines sum ${sageSum.toFixed(2)} ≠ subtotal ${subtotal.toFixed(2)}`);
    order.totalVerified = false;
    order.altromAuditProblems = problems;
  }
  return { order, problems };
}

async function getAltromOrders(options = {}) {
  const headless = options.headless ?? DEFAULT_HEADLESS ?? false;
  const days = Number(options.days) > 0 ? Number(options.days) : DEFAULT_DAYS;
  const { storageStatePath, ordersJsonPath } = resolvePaths(options);
  const existingOrders = options.existingOrders || [];
  const existingRefs = Array.isArray(options.existingRefs) ? options.existingRefs : [];
  const isAltromOrder = (order) => {
    const src = (order?.source || order?.warehouse || order?.seller || "").toString().trim().toLowerCase();
    return src === "altrom";
  };
  const existingRefSet = new Set(
    [
      ...(existingOrders || [])
        .filter(isAltromOrder)
        .map((o) => (o && o.reference ? String(o.reference).trim().toUpperCase() : "")),
      ...existingRefs.map((ref) => (ref ? String(ref).trim().toUpperCase() : "")),
    ].filter(Boolean)
  );

  let browser;
  let page;
  const statusLog = [];

  try {
    // Cloudflare never clears for a headless browser here (tried both the
    // headless shell and full-Chromium new-headless, 2026-10-17), so the
    // browser is always headed. "Headless" instead parks the window off-screen.
    browser = await chromium.launch({
      headless: false,
      args: headless ? [...LAUNCH_ARGS, "--window-position=-32000,-32000"] : LAUNCH_ARGS,
    });
    const context = await createContextWithStorage(browser, storageStatePath);
    page = await context.newPage();

    const auth = await openInvoicesAndCaptureAuth(page, storageStatePath, statusLog, options.credentials);
    const loginInfo = { loggedIn: true, usedStoredSession: auth.usedStoredSession, loginPerformed: !auth.usedStoredSession };

    const rows = await searchInvoices(page, auth, { days });
    // Credit memos (invoiceType "CRD": negative total, negative quantities)
    // go through the Credits/Returns flows, not Order Management, so they're
    // not turned into purchase orders here.
    const charges = rows.filter((r) => String(r.invoiceType || "").toUpperCase() !== "CRD");
    statusLog.push(
      `Altrom invoice list (last ${days} days): ${rows.length} row(s), ${rows.length - charges.length} credit(s) skipped.`
    );

    const newRows = charges.filter((r) => {
      const key = String(r.invoiceNumber || "").trim().toUpperCase();
      return key && !existingRefSet.has(key);
    });
    statusLog.push(`${newRows.length} new, ${charges.length - newRows.length} already present.`);

    const newOrders = [];
    let detailFetched = 0;
    for (const row of newRows) {
      try {
        const detail = await fetchInvoiceDetail(page, auth, row);
        const { order, problems } = buildOrder(row, detail);
        if (problems.length) statusLog.push(`[audit] ${order.reference}: ${problems.join("; ")}`);
        newOrders.push(order);
        detailFetched += 1;
      } catch (err) {
        statusLog.push(`[detail] ${row.invoiceNumber}: ${err.message || err}`);
      }
    }

    const mergedOrders = mergeOrders(existingOrders, newOrders);
    // Not written to ordersJsonPath here — same reason as tigerScraper.js: the
    // caller re-reads current state and merges through the CRDT store.

    return {
      ok: true,
      source: "altrom",
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
    console.error("[altrom] scraper error:", err);
    try {
      const screenshotPath = path.join(path.dirname(storageStatePath), "altrom_error.png");
      if (page) await page.screenshot({ path: screenshotPath, fullPage: true });
      console.error("[altrom] saved error screenshot to", screenshotPath);
    } catch (s) {
      console.error("[altrom] could not save error screenshot", s);
    }
    return { ok: false, error: err.message || String(err), statusLog };
  } finally {
    if (browser) await browser.close();
  }
}

module.exports = {
  getAltromOrders,
  buildOrder,
};
