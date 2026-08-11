// src/scrapers/worldCreditInvoice.actions.js
// Parsing helpers for World Automotive Warehouse CREDIT MEMOS arriving by
// email (Gmail) — sender reports@groupe-monaco.ca, subject "Credit Memo for
// 20605 Cust PO" (20605 is World's customer number for this account, the
// same value printed in the CUSTOMER NUMBER cell of the document).
//
// VERIFIED (2026-08-11) against a real sample (credit memo 02KQ8236, 17 line
// items across 2 pages, totals -732.48): a World credit memo is the EXACT
// SAME document template/column layout as a regular World invoice
// (worldInvoice.actions.js) — same positional-pdfjs gluing problem, same
// DISC%-anchored item row, same totals-row shape — with every money value
// simply printed NEGATIVE. The only real differences are the ID row's column
// labels ("Credit Memo NUMBER"/"Credit Memo DATE" instead of "Invoice
// NUMBER"/"Invoice DATE") and the absence of an "ACX Reference No" line (a
// credit is a return against a past sale, not tied to a new order). So this
// file reuses assignByNearestColumn/readColumnsUnderHeader/extractLineItems/
// money/extractStubBalanceDue from worldInvoice.actions.js rather than
// reimplementing them.
const { getPageRows } = require("./bestbuyInvoice.actions");
const {
  readColumnsUnderHeader,
  extractLineItems,
  money,
  extractStubBalanceDue,
} = require("./worldInvoice.actions");

const ID_ROW_LABELS = [
  "CUSTOMER NUMBER",
  "Credit Memo NUMBER",
  "Credit Memo DATE",
  "PACKING SLIP",
  "TERMS",
  "WHSE",
];

const TOTALS_ROW_LABELS = [
  "TOTAL MDSE",
  "TOTAL EHC",
  "TOTAL CORE",
  "FREIGHT",
  "SUBTOTAL",
  "TAX AMT",
  "INVOICE TOTAL",
  "PAYMENTS",
  "BALANCE DUE",
];

// The packing slip (e.g. "02RK7488001") is the only per-credit identifier on
// the document — unlike an invoice, there's no ACX order reference, so this
// becomes the new order's `reference` (same convention as Transbec credit
// memos: see [[transbec-credit-memos]]).
async function extractCreditMemoFromPdf(pdfBuffer) {
  const pageRows = await getPageRows(pdfBuffer);
  const rows = pageRows.flat();

  // "Credit Memo\nNo. 02KQ8236" near the header — the canonical form. Page 2
  // repeats it as "INVOICE NUMBER: KQ8236" (drops the leading branch digits),
  // so prefer whichever the header form gives us first, same "prefer page-1
  // form" rule as every other vendor's parser.
  let creditMemoNumber = "";
  for (const row of rows) {
    const text = row.items.map((c) => c.str.trim()).join(" ");
    const m = text.match(/^No\.\s*([0-9A-Z]{4,12})$/i);
    if (m && !creditMemoNumber) creditMemoNumber = m[1].toUpperCase();
  }

  const idRow = readColumnsUnderHeader(rows, ID_ROW_LABELS) || {};
  if (!creditMemoNumber && idRow["Credit Memo NUMBER"]) {
    creditMemoNumber = String(idRow["Credit Memo NUMBER"]).trim().toUpperCase();
  }

  const totalsRaw = readColumnsUnderHeader(rows, TOTALS_ROW_LABELS) || {};
  const totals = {};
  for (const label of TOTALS_ROW_LABELS) totals[label] = money(totalsRaw[label]) ?? 0;

  const lineItems = extractLineItems(rows);
  const stubBalanceDue = extractStubBalanceDue(rows);

  const creditTotal = totals["INVOICE TOTAL"] || null;
  const balanceDue = stubBalanceDue ?? totals["BALANCE DUE"] ?? null;

  // Same arithmetic self-audit as the invoice parser — every figure is read
  // independently, so the printed document has to reconcile with itself.
  const near = (a, b) => a != null && b != null && Math.abs(a - b) < 0.01;
  const sum = (fn) => lineItems.reduce((acc, li) => acc + (fn(li) || 0), 0);
  const checks = {
    subtotal: near(
      totals["TOTAL MDSE"] + totals["TOTAL EHC"] + totals["TOTAL CORE"] + totals["FREIGHT"],
      totals["SUBTOTAL"]
    ),
    invoiceTotal: near(totals["SUBTOTAL"] + totals["TAX AMT"], totals["INVOICE TOTAL"]),
    balanceDue: stubBalanceDue == null || near(stubBalanceDue, totals["BALANCE DUE"]),
    lineItems: lineItems.length > 0 && near(sum((li) => li.extended), totals["TOTAL MDSE"]),
    ehc: near(sum((li) => li.ehcExtended), totals["TOTAL EHC"]),
  };
  checks.ok = Object.values(checks).every(Boolean);

  return {
    creditMemoNumber,
    packingSlip: String(idRow["PACKING SLIP"] || "").trim(),
    creditDate: String(idRow["Credit Memo DATE"] || "").trim(),
    total: creditTotal,
    balanceDue,
    totalEhc: totals["TOTAL EHC"] || 0,
    hasEnvironmentalFee: (totals["TOTAL EHC"] || 0) !== 0,
    environmentalFeeAmount: totals["TOTAL EHC"] ? Math.abs(totals["TOTAL EHC"]).toFixed(2) : "",
    totals,
    lineItems,
    checks,
  };
}

// Stable, filesystem-safe asset name keyed by credit memo number, mirroring
// getInvoiceAssetName.
function getCreditMemoAssetName(creditMemoNumber) {
  const safe = String(creditMemoNumber || "")
    .trim()
    .replace(/[^A-Za-z0-9_-]/g, "_");
  return `world_credit_${safe || "unknown"}.pdf`;
}

module.exports = {
  extractCreditMemoFromPdf,
  getCreditMemoAssetName,
};
