// src/scrapers/cbkInvoice.actions.js
// Parsing helpers for CBK invoices that arrive by email. Unlike BestBuy (ONE
// batch PDF holding many invoices), CBK sends one email PER order — from
// branch_05@cbkauto.com, subject "Re: Invoice 05-6631320" where 6631320 is the
// CBK order number (the order's `reference`). The single PDF attachment is one
// invoice, and CBK names that file by its invoice number (e.g. INV2373740.pdf).
//
// So the two identifying values come from the message itself, not the PDF body:
//   - order number (reference) -> from the subject
//   - invoice number           -> from the attachment filename
// The PDF text is only parsed for the invoice total (and to cross-check the
// order number). Gmail search / attachment download / caching are shared with
// the Transbec pipeline; only CBK-specific parsing lives here.

// pdf-parse is lazy-required (its index.js runs debug code at require-time in
// some setups) and only needed when we actually parse a PDF.
let pdfParse = null;
function getPdfParse() {
  if (!pdfParse) pdfParse = require("pdf-parse");
  return pdfParse;
}

function parseAmount(raw) {
  if (raw == null) return null;
  const n = Number(String(raw).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

// Subject "Re: Invoice 05-6631320" -> "6631320" (the part after the branch
// prefix). Falls back to the last "05-<digits>" style group, then to any long
// standalone number.
function extractOrderNumberFromSubject(subject) {
  const s = String(subject || "");
  const labelled = s.match(/invoice\s+\d+-(\d+)/i);
  if (labelled) return labelled[1];
  const branchOrder = s.match(/\d+-(\d{4,})/);
  if (branchOrder) return branchOrder[1];
  const bare = s.match(/\b(\d{5,})\b/);
  return bare ? bare[1] : "";
}

// Attachment filename "INV2373740.pdf" -> "2373740" (drop the extension, keep
// digits). CBK names the file by invoice number, so this is authoritative.
function extractInvoiceNumberFromFilename(filename) {
  const base = String(filename || "").replace(/\.[^.]*$/, "");
  const digits = base.replace(/\D/g, "");
  return digits || "";
}

// Fallback only: the invoice number is the first number on the header/detail
// row (e.g. "2373740 14:24:50 6631320 7/14/26 ..."). Used when the attachment
// filename didn't carry digits.
function extractInvoiceNumberFromText(text) {
  const t = String(text || "");
  const m = t.match(/\b(\d{6,8})\b\s+\d{1,2}:\d{2}/);
  return m ? m[1] : "";
}

// The CBK invoice total ("INVOICE AMOUNT" / "PAY THIS AMOUNT", 121.06 on the
// sample). The flat text stream doesn't keep the label next to its value, so we
// take the LAST money-shaped token in the document: the bottom-right "PAY THIS
// AMOUNT" box prints last. We drop any %-suffixed value so the footer interest
// rate ("19.56 % annually") is never mistaken for a dollar amount. If a future
// invoice ever colon-labels the amount, prefer that explicit match.
function parseCbkTotal(text) {
  const t = String(text || "");
  const labelled = t.match(/(?:PAY\s*THIS\s*AMOUNT|INVOICE\s*AMOUNT)\s*[:$]?\s*([\d,]+\.\d{2})/i);
  if (labelled) return parseAmount(labelled[1]);
  const money = [...t.matchAll(/([\d,]+\.\d{2})(\s*%)?/g)].filter((m) => !m[2]).map((m) => m[1]);
  return money.length ? parseAmount(money[money.length - 1]) : null;
}

// Pull the identifying fields for one CBK invoice email. invoiceNumber comes
// from the attachment filename, orderNumber from the subject, total from the
// PDF text. orderNumberConfirmed is a non-fatal sanity flag: true when the
// subject's order number is actually printed in the PDF body too.
async function extractCbkInvoice(pdfBuffer, { filename, subject } = {}) {
  let text = "";
  try {
    const data = await getPdfParse()(pdfBuffer);
    text = (data && data.text) || "";
  } catch (e) {
    console.log(`[cbk-invoice] pdf-parse failed: ${e.message}`);
  }

  const invoiceNumber =
    extractInvoiceNumberFromFilename(filename) || extractInvoiceNumberFromText(text);
  const orderNumber = extractOrderNumberFromSubject(subject);
  const total = parseCbkTotal(text);
  const orderNumberConfirmed = Boolean(orderNumber) && text.includes(orderNumber);

  return { invoiceNumber, orderNumber, total, orderNumberConfirmed, text };
}

module.exports = {
  extractOrderNumberFromSubject,
  extractInvoiceNumberFromFilename,
  extractInvoiceNumberFromText,
  parseCbkTotal,
  extractCbkInvoice,
};
