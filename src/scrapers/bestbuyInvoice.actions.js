// src/scrapers/bestbuyInvoice.actions.js
// Parsing helpers for BestBuy invoices, which arrive as ONE batch PDF (subject
// "BESTBUY INVOICES FOR TODAY") containing potentially many invoices, one per
// page. Gmail search / attachment download / caching are shared with the
// Transbec pipeline; only the batch split + BestBuy field parsing live here.
//
// Match key: the Packing Slip number, which is printed on the invoice AND is the
// order's `reference` (when scraped before the warehouse invoices it). We also
// surface the invoice number as a fallback key for late-scrape cases.
//
// IMPORTANT — why totals are read positionally, not from pdf-parse's text:
// pdf-parse (pdfjs's flattened text) glues adjacent table cells together with NO
// separator whenever the PDF doesn't already contain a real space character
// there. A real extracted totals row reads like ".006.79.00259.00" — Freight
// ".00", G.S.T. "6.79", P.S.T. ".00", Total Units "2", Invoice Total "59.00", all
// run together. Splitting that by counting digits is genuinely ambiguous: "2" +
// "59.00" is indistinguishable from "25" + "9.00" from the text alone. Confirmed
// against real invoices, including one where digit-counting would have silently
// returned the wrong total. Instead we use pdfjs-dist directly to read each text
// run's real x-coordinate and assign it to whichever column header's x-range it
// falls under — unambiguous regardless of how the digits print.

let pdfjsLibPromise = null;
function getPdfjsLib() {
  // Dynamic import: pdfjs-dist v6 ships ESM only, this file is CommonJS.
  if (!pdfjsLibPromise) pdfjsLibPromise = import("pdfjs-dist/legacy/build/pdf.mjs");
  return pdfjsLibPromise;
}

// The two summary rows on a BestBuy invoice, left-to-right as printed.
const TOTALS_ROW_LABELS = ["Freight Charge", "G.S.T.", "P.S.T.", "Total Units", "Invoice Total", "Deferred Due"];
const SUBTOTALS_ROW_LABELS = ["Net Parts", "Total Core", "Total E.H.C.", "Sub-total", "Order Discount", "Service Fees"];

// Split the batch text into one block per invoice. Each invoice's first page
// prints "Page: 1"; a multi-page invoice continues with "Page: 2", etc. So we
// anchor invoice starts on "Page: 1" (which correctly groups continuation pages
// with their invoice), falling back to "Invoice No:" if the page markers are
// absent. Each returned block carries how many PDF pages it spans, so the batch
// PDF can be split back into per-invoice files by page range.
function splitInvoiceBlocks(text) {
  const t = String(text || "");
  const collect = (re) => {
    const starts = [];
    let m;
    const rx = new RegExp(re.source, "gi");
    while ((m = rx.exec(t)) !== null) starts.push(m.index);
    return starts;
  };
  let starts = collect(/Page:\s*1\b/);
  if (starts.length < 1) starts = collect(/Invoice\s*No:\s*\d+/);
  if (!starts.length) return [];
  const blocks = [];
  for (let i = 0; i < starts.length; i++) {
    const from = starts[i];
    const to = i + 1 < starts.length ? starts[i + 1] : t.length;
    const block = t.slice(from, to);
    const pageCount = (block.match(/Page:\s*\d+/gi) || []).length || 1;
    blocks.push({ block, pageCount });
  }
  return blocks;
}

function parseAmount(raw) {
  if (raw == null) return null;
  let s = String(raw).replace(/,/g, "");
  // Relocate a trailing accounting minus ("406.73-") to the front so Number()
  // reads it as negative; positive invoices have no minus so this is a no-op.
  const negative = /-/.test(s);
  s = s.replace(/-/g, "");
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

// A money token, allowing the trailing minus that credit invoices use.
const MONEY_TOKEN = /^[\d,]+\.\d{2}-?$/;

// Last-resort fallback ONLY (used if positional extraction throws, e.g. a
// malformed PDF) — NOT reliable on its own; see the ambiguity note above.
function parseInvoiceTotalFallback(block) {
  const m = block.match(/Total\s*Units\s+Invoice\s*Total\s+Deferred\s*Due[^\S\r\n]*\r?\n([^\r\n]+)/i);
  if (!m) return null;
  const tokens = m[1].trim().split(/\s+/);
  // Total Units is an integer that may itself carry a trailing minus on a
  // credit ("6-"); the invoice total is the money token right after it.
  const intIdx = tokens.findIndex((tok) => /^\d+-?$/.test(tok));
  if (intIdx !== -1 && intIdx + 1 < tokens.length && MONEY_TOKEN.test(tokens[intIdx + 1])) {
    return parseAmount(tokens[intIdx + 1]);
  }
  const monies = tokens.filter((tok) => MONEY_TOKEN.test(tok));
  return monies.length ? parseAmount(monies[monies.length - 1]) : null;
}

// Parse one invoice block into its identifying fields (reliable from flat text:
// both are bounded by a digit/non-digit boundary, so gluing causes no ambiguity)
// plus a fallback total that positional extraction should normally override.
function parseBestbuyInvoice(block) {
  const invMatch = block.match(/Invoice\s*No:\s*(\d+)/i);
  const invoiceNumber = invMatch ? invMatch[1] : "";
  const psMatch = block.match(/Packing\s*Slip:\s*(\d+)/i);
  const packingSlip = psMatch ? psMatch[1] : "";
  const total = parseInvoiceTotalFallback(block);
  return { invoiceNumber, packingSlip, total, hasEnvironmentalFee: false, environmentalFeeAmount: "" };
}

// Parse a whole batch PDF's text into an ordered list of invoices. Each carries
// its starting page index and page span, so the batch PDF can be split into
// per-invoice files by page range, and so the positional pass below knows which
// PDF page(s) to read totals from.
function parseBatchInvoices(text) {
  const blocks = splitInvoiceBlocks(text);
  let pageCursor = 0;
  return blocks.map(({ block, pageCount }) => {
    const startPage = pageCursor;
    pageCursor += pageCount;
    return { startPage, pageCount, ...parseBestbuyInvoice(block) };
  });
}

// --- Positional (pdfjs) extraction ---

// Load every page's text items (x/y position + string), dropping pdfjs's
// whitespace-only filler items (their widths are synthetic and not meaningful).
async function getPageRows(pdfBuffer) {
  const pdfjsLib = await getPdfjsLib();
  const doc = await pdfjsLib.getDocument({
    data: new Uint8Array(pdfBuffer),
    disableWorker: true,
    isEvalSupported: false,
  }).promise;
  const pageRows = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const items = content.items
      .map((it) => ({ str: it.str, x: it.transform[4], y: it.transform[5] }))
      .filter((it) => it.str && it.str.trim());
    // Group into printed rows by rounding y (items on the same line share it).
    const rows = new Map();
    items.forEach((it) => {
      const key = Math.round(it.y);
      if (!rows.has(key)) rows.set(key, []);
      rows.get(key).push(it);
    });
    pageRows.push(
      [...rows.entries()]
        .sort((a, b) => b[0] - a[0]) // top of page first
        .map(([y, row]) => ({ y, items: row.sort((a, b) => a.x - b.x) }))
    );
  }
  return pageRows;
}

// Find a header row containing every given label (as distinct items) and read
// the value row directly beneath it, assigning each value to the column whose
// x-range [thisHeaderX, nextHeaderX) contains it. A column with no item in its
// range (common — BestBuy omits $0.00 cells rather than printing them) reads as
// "". Returns null if this page doesn't have the labelled row at all.
function readLabelledRow(rows, labels) {
  const wanted = labels.map((l) => l.toLowerCase());
  for (let i = 0; i < rows.length; i++) {
    const rowLabels = rows[i].items.map((it) => it.str.trim().toLowerCase());
    if (!wanted.every((w) => rowLabels.includes(w))) continue;
    const valueRow = rows[i + 1] || null;
    const headerItems = labels
      .map((label, idx) => {
        const found = rows[i].items.find((it) => it.str.trim().toLowerCase() === label.toLowerCase());
        return found ? { label: labels[idx], x: found.x } : null;
      })
      .filter(Boolean)
      .sort((a, b) => a.x - b.x);
    const result = {};
    headerItems.forEach((h, idx) => {
      const nextX = idx + 1 < headerItems.length ? headerItems[idx + 1].x : Infinity;
      const match = valueRow ? valueRow.items.find((it) => it.x >= h.x && it.x < nextX) : null;
      result[h.label] = match ? match.str.trim() : "";
    });
    return result;
  }
  return null;
}

function moneyOrNull(str) {
  if (!str) return null;
  let s = String(str).replace(/[^\d.\-]/g, "");
  // Credit invoices print accounting negatives as a TRAILING minus ("406.73-");
  // JS's Number() only understands a leading sign, so detect and relocate it.
  // Regular (positive) invoices never carry a minus, so this is a no-op there.
  const negative = /-/.test(s);
  s = s.replace(/-/g, "");
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

// Read Invoice Total + E.H.C. from one page's rows. Returns null if this page
// has neither summary row (e.g. a continuation page of a multi-page invoice).
function readTotalsFromPageRows(rows) {
  const totalsRow = readLabelledRow(rows, TOTALS_ROW_LABELS);
  if (!totalsRow) return null;
  const subtotalsRow = readLabelledRow(rows, SUBTOTALS_ROW_LABELS) || {};
  const ehcAmount = moneyOrNull(subtotalsRow["Total E.H.C."]);
  const hasEnvironmentalFee = Boolean(ehcAmount && ehcAmount > 0);
  return {
    total: moneyOrNull(totalsRow["Invoice Total"]),
    hasEnvironmentalFee,
    environmentalFeeAmount: hasEnvironmentalFee ? ehcAmount.toFixed(2) : "",
  };
}

// For each parsed invoice, read its authoritative total/EHC from whichever of
// its constituent PDF pages carries the summary rows (normally its only page;
// for a multi-page invoice the summary is typically on the last page, so every
// page in range is checked). Mutates and returns the same invoices array.
async function attachPositionalTotals(invoices, pdfBuffer) {
  let pageRows;
  try {
    pageRows = await getPageRows(pdfBuffer);
  } catch (e) {
    console.log(`[bestbuy-invoice] positional total extraction failed, using flat-text fallback: ${e.message}`);
    return invoices;
  }
  for (const inv of invoices) {
    for (let p = inv.startPage; p < inv.startPage + inv.pageCount; p++) {
      const totals = pageRows[p] ? readTotalsFromPageRows(pageRows[p]) : null;
      if (totals) {
        if (totals.total !== null) inv.total = totals.total;
        inv.hasEnvironmentalFee = totals.hasEnvironmentalFee;
        inv.environmentalFeeAmount = totals.environmentalFeeAmount;
        break;
      }
    }
  }
  return invoices;
}

module.exports = {
  splitInvoiceBlocks,
  parseBestbuyInvoice,
  parseBatchInvoices,
  getPageRows,
  readLabelledRow,
  readTotalsFromPageRows,
  attachPositionalTotals,
};
