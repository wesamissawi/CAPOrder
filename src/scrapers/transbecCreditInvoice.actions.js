// src/scrapers/transbecCreditInvoice.actions.js
// Parsing helpers for Transbec CREDIT MEMOS from Gmail — a separate pipeline
// from transbecInvoice.js (regular invoices). These arrive from
// donotreply@transbec.ca with subject "Credit Memo for T30252 Cust PO".
//
// IMPORTANT (learned from a real sample, credit memo 01HX8638, 2026-07-21):
// the subject's "T30252" is the Transbec CUSTOMER NUMBER, not a per-credit
// identifier — it's the same for every credit memo Transbec ever sends this
// business, so it can't be used as an order `reference` (every credit would
// collide on the same value). The PDF body's PACKING SLIP (e.g.
// "01CD9051001") is what's actually unique per credit/shipment, so that's
// what becomes the new order's reference; the subject token is kept only as
// a last-resort fallback and as an informational `customerNumber`.

let pdfParse = null;
function getPdfParse() {
  if (!pdfParse) pdfParse = require("pdf-parse");
  return pdfParse;
}

// "Credit Memo for T30252 Cust PO" -> "T30252"
function extractPoReferenceFromSubject(subject) {
  const s = String(subject || "");
  const labelled = s.match(/credit\s*memo\s*for\s+(\S+)\s+cust\s*po/i);
  if (labelled) return labelled[1].toUpperCase();
  // Fallback: a bare token following "for", in case the wording varies.
  const bare = s.match(/\bfor\s+([A-Za-z0-9-]{4,12})\b/i);
  return bare ? bare[1].toUpperCase() : "";
}

// Transbec's "Credit Memo" search also turns up "Credit Memo Pick Ticket TRB
// LAVAL" emails — a warehouse pick-ticket notification, not an actual credit
// memo document, but it matches the same subject search since it contains
// the words "Credit Memo". Confirmed on a real account (2026-07-21): these
// carry no "Cust PO" reference and their attached PDF has none of the usual
// credit-memo fields, so they must be excluded before ever being treated as
// a credit — same idea as BestBuy's isOrderConfirmationSubject filter.
function isPickTicketSubject(subject) {
  return /pick\s*ticket/i.test(String(subject || ""));
}

// "2026-07-16" -> "2026/07/16", the format Gmail's after:/before: operators need.
function isoToGmailDate(iso) {
  return String(iso || "").trim().replace(/-/g, "/");
}

// "2026-07-16" + (-5) -> "2026-07-11". Used to compute the default trailing
// lookback window and to bump the "before:" bound by one day (Gmail's before:
// is exclusive of that day).
function addDaysIso(iso, days) {
  const m = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return iso;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  d.setUTCDate(d.getUTCDate() + Number(days || 0));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(
    d.getUTCDate()
  ).padStart(2, "0")}`;
}

function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(
    2,
    "0"
  )}`;
}

function parseAmount(raw) {
  if (raw == null) return null;
  const n = Number(String(raw).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

// --- Positional (pdfjs) line-item extraction ---
//
// CRITICAL, learned the hard way (2026-07-21): a per-line flat-text regex
// (pdf-parse's output) does NOT work here. Verified against the real
// pdf-parse output for credit memo 01HX8638 — EVERY column on an item row is
// glued to its neighbor with ZERO separator whenever the PDF has no actual
// space character there, e.g. the real text for one line is:
//   "TRB 510073WHEEL BEARING & C-CLIPEA-20-2-18.770.00-37.54"
// (part number+description+unit+6 numbers, all run together — only the
// "TRB "/part-number boundary has a real space). Splitting a run like
// "-20-2-18.770.00-37.54" into its 6 numbers by counting digits is genuinely
// ambiguous — the EXACT same lesson already learned for BestBuy invoices
// (see bestbuyInvoice.actions.js's file-header comment). The fix is the
// same: read pdfjs-dist's raw positioned text items directly instead of
// pdf-parse's flattened text. At that level each column IS still a separate
// item with its own x-coordinate — pdf-parse's gluing is an artifact of ITS
// OWN text-joining, not something inherent to the PDF — so there is nothing
// ambiguous to resolve positionally. Verified against all 9 real lines of
// credit memo 01HX8638: every item row prints exactly 9 positioned items in
// this fixed order: "<code> <partNumber>", description, unit, order qty,
// back ordered, inv qty, net price, net core, ext price.

let pdfjsLibPromise = null;
function getPdfjsLib() {
  // Dynamic import: pdfjs-dist v6 ships ESM only, this file is CommonJS.
  if (!pdfjsLibPromise) pdfjsLibPromise = import("pdfjs-dist/legacy/build/pdf.mjs");
  return pdfjsLibPromise;
}

// Load every page's text items (x/y position + string) grouped into printed
// rows (items sharing a rounded y), sorted left-to-right — mirrors
// bestbuyInvoice.actions.js's getPageRows exactly (same library, same need).
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

// A line-item row's leftmost cell is always "<2-4 letter line code> <part
// number>" as ONE positioned text run (e.g. "TRB 510073") — the one column
// boundary that DOES have a real space character in the source PDF.
const ITEM_CODE_RE = /^([A-Z]{2,4})\s+(\S+)$/;

async function extractLineItemsFromCreditMemoPdf(pdfBuffer) {
  let pageRows;
  try {
    pageRows = await getPageRows(pdfBuffer);
  } catch (e) {
    console.log(`[transbec-credit] positional line-item extraction failed: ${e.message}`);
    return [];
  }
  const items = [];
  for (const rows of pageRows) {
    for (const row of rows) {
      const first = row.items[0];
      if (!first) continue;
      const codeMatch = first.str.trim().match(ITEM_CODE_RE);
      if (!codeMatch) continue;
      if (row.items.length !== 9) {
        // Layout deviated from the verified 9-cell shape (e.g. a genuinely
        // omitted zero-value cell) — surface it rather than guess at a
        // possibly-wrong column mapping.
        console.log(
          `[transbec-credit] line-item row has ${row.items.length} cell(s) (expected 9), skipping: ` +
            row.items.map((it) => it.str).join(" | ")
        );
        continue;
      }
      const [, partLineCode, partNumber] = codeMatch;
      const cells = row.items.map((it) => it.str.trim());
      const [, partDescription, unit, orderedQty, backOrderedQty, invQty, netPrice, netCore, extPrice] = cells;
      const costPriceValue = Number(netPrice);
      const extendedValue = Number(extPrice);
      // Field names mirror the shape regular Transbec order lineItems already
      // use (transbec.actions.js) — partLineCode/partNumber/partDescription/
      // costPrice(Value)/extended(Value)/core/addedToOutstanding — so this
      // slots into the same downstream handling (e.g. addOrderLineItemsToNewStock)
      // as any other order's line items.
      items.push({
        partLineCode,
        partNumber,
        partDescription,
        unit,
        // "quantity" = INV QTY, same convention as the Epicor line-item parser.
        // Kept signed (negative here) — this is a return, reducing stock.
        quantity: Number(invQty),
        orderedQty: Number(orderedQty),
        backOrderedQty: Number(backOrderedQty),
        costPrice: netPrice,
        costPriceValue: Number.isFinite(costPriceValue) ? costPriceValue : null,
        extended: extPrice,
        extendedValue: Number.isFinite(extendedValue) ? extendedValue : null,
        core: Number(netCore) !== 0,
        addedToOutstanding: false,
        hasEnvironmentalFee: false,
        environmentalFeeAmount: null,
      });
    }
  }
  return items;
}

// Verified against real pdf-parse output for credit memo 01HX8638
// (2026-07-21) — including the gluing problem: pdf-parse's flat text has NO
// separator between a field's value and the next field's label whenever the
// PDF has no real space character there, e.g. the real page-2 line reads
// "PO NUMBER:1015691PACKING SLIP:01CD9051001TERMS:NET 30" — no spaces at
// all around the colons or between adjacent fields. Every capture below is
// shape-anchored (digits only, or a specific digit/letter pattern) rather
// than a generic `[A-Za-z0-9]+` precisely so it stops at the value's own
// natural end instead of continuing into the next glued-on label word.
function parseCreditMemoText(text) {
  const t = String(text || "");

  // "Credit Memo\nNo. 01HX8638" near the header — the canonical, branch-
  // prefixed form (matches the page-2 "INVOICE NUMBER: HX8638" minus its
  // leading "01", same "prefer the page-1 form" rule as regular invoices).
  let creditMemoNumber = "";
  const memoNo = t.match(/Credit\s*Memo\s*No\.?\s*[:#]?\s*([0-9A-Z]{4,10})/i);
  if (memoNo) creditMemoNumber = memoNo[1].toUpperCase();

  // The packing slip of the shipment being returned/credited — colon-labelled
  // on the page-2 return stub ("PACKING SLIP:01CD9051001TERMS:..." once
  // glued). This is what becomes the new order's `reference` (see file
  // header comment for why the subject's customer number can't be used for
  // that). Shape is always digits+letters+digits (e.g. "01CD9051001") —
  // anchoring on the trailing digit run stops the match before "TERMS".
  let packingSlip = "";
  const slipMatch = t.match(/PACKING\s*SLIP\s*:\s*(\d{2}[A-Z]{2}\d+)/i);
  if (slipMatch) packingSlip = slipMatch[1].toUpperCase();

  // Informational only — the customer's own PO number (pure digits, e.g.
  // "1015691") and Transbec's customer number for this account (a letter
  // followed by digits, e.g. "T30252" — requiring the leading letter also
  // skips past the unrelated "*** ALTERNATE CUSTOMER #: 30252 ***" line
  // earlier in the text, which has no letter prefix).
  let poNumber = "";
  const poMatch = t.match(/\bPO\s*NUMBER\s*:\s*(\d+)/i);
  if (poMatch) poNumber = poMatch[1];

  let customerNumber = "";
  const custMatch = t.match(/CUSTOMER\s*#\s*:\s*([A-Za-z]\d+)/i);
  if (custMatch) customerNumber = custMatch[1].toUpperCase();

  // "Credit Memo BALANCE DUE:-209.07" on the page-2 return stub — the one
  // reliable, colon-labelled total (works even glued directly to the colon,
  // since \s* allows zero whitespace). The unlabelled summary table above it
  // ("TOTAL PURCHASE TOTAL MDSE FREIGHT TAX PCT TAX AMT INVOICE TOTAL
  // PAYMENTS BALANCE DUE" then 6 numbers for 8 columns — TAX PCT prints no
  // value) has the exact same column/value misalignment gotcha as regular
  // Transbec invoices, so it is deliberately NOT parsed positionally.
  let total = null;
  const totalMatch =
    t.match(/Credit\s*Memo\s*BALANCE\s*DUE\s*:\s*\$?\s*(-?[\d,]+\.\d{2})/i) ||
    t.match(/BALANCE\s*DUE\s*:\s*\$?\s*(-?[\d,]+\.\d{2})/i);
  if (totalMatch) total = parseAmount(totalMatch[1]);
  // Force negative — a credit reduces what's owed, same convention used for
  // BestBuy credit invoices, regardless of the sign printed in the source.
  if (total != null) total = -Math.abs(total);

  return { creditMemoNumber, packingSlip, poNumber, customerNumber, total };
}

// Extract credit-memo fields from raw PDF bytes. Scalar fields (credit memo
// #, packing slip, totals) come from pdf-parse's flat text layer, same as
// regular Transbec invoices; line items are read positionally via pdfjs
// (see extractLineItemsFromCreditMemoPdf's header comment for why flat text
// doesn't work for those). Falls back to rasterize+OCR only if pdf-parse
// yields no usable text at all.
async function extractCreditMemoFromPdf(pdfBuffer) {
  let text = "";
  let usedOcr = false;
  try {
    const data = await getPdfParse()(pdfBuffer);
    text = (data && data.text) || "";
  } catch (e) {
    console.log(`[transbec-credit] pdf-parse failed: ${e.message}`);
  }

  if (text.replace(/\s/g, "").length < 40) {
    console.log("[transbec-credit] no usable text layer — falling back to OCR");
    usedOcr = true;
    try {
      const { pdfToPng } = require("pdf-to-png-converter");
      const Tesseract = require("tesseract.js");
      const pngPages = await pdfToPng(pdfBuffer, { viewportScale: 3, pagesToProcess: [1] });
      if (pngPages.length && pngPages[0].content) {
        const {
          data: { text: ocrText },
        } = await Tesseract.recognize(pngPages[0].content, "eng");
        text = ocrText || "";
      }
    } catch (e) {
      console.log(`[transbec-credit] OCR fallback failed: ${e.message}`);
    }
  }

  const parsed = parseCreditMemoText(text);
  // Line items need the raw PDF bytes (positional pdfjs read), not the
  // pdf-parse text — see extractLineItemsFromCreditMemoPdf's header comment.
  const lineItems = await extractLineItemsFromCreditMemoPdf(pdfBuffer);
  return { ...parsed, lineItems, text, usedOcr };
}

// Stable, filesystem-safe asset name, mirroring getInvoiceAssetName.
function getCreditMemoAssetName(id) {
  const safe = String(id || "").trim().replace(/[^A-Za-z0-9_-]/g, "_");
  return `transbec_credit_${safe || "unknown"}.pdf`;
}

module.exports = {
  extractPoReferenceFromSubject,
  isPickTicketSubject,
  getPageRows,
  extractLineItemsFromCreditMemoPdf,
  parseCreditMemoText,
  extractCreditMemoFromPdf,
  getCreditMemoAssetName,
  isoToGmailDate,
  addDaysIso,
  todayIso,
};
