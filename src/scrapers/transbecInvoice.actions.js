// src/scrapers/transbecInvoice.actions.js
// Helpers for pulling Transbec invoices out of Gmail and parsing the attached PDF.
//
// Unlike the Epicor pipeline (which OCRs a scanned image), Transbec invoices are
// digitally-generated PDFs with a real text layer, so pdf-parse reads them
// directly. We keep the Epicor rasterize+OCR path as a fallback in case a future
// invoice ever arrives as a scan.
const fs = require("fs");
const path = require("path");

// pdf-parse is lazy-required inside the function: its index.js runs debug code at
// require-time in some setups, and we only need it when actually parsing.
let pdfParse = null;
function getPdfParse() {
  if (!pdfParse) pdfParse = require("pdf-parse");
  return pdfParse;
}

// Order references are "LL9999" — 2 letters then 4 digits (e.g. BW3391). Same
// shape as World, so we reuse the position-aware OCR-confusion correction: a
// letter slot can only be a letter, a digit slot only a digit. Deliberately not
// generic fuzzy matching, which could equate two genuinely different references.
const REFERENCE_REGEX = /^[A-Z]{2}\d{4}$/;
function correctReferenceFormat(raw) {
  const clean = String(raw || "")
    .replace(/[\s\-]/g, "")
    .toUpperCase()
    .slice(0, 6);
  if (clean.length !== 6) return "";
  const digitToLetter = { 0: "O", 1: "I", 5: "S", 8: "B", 2: "Z" };
  const letterToLetter = { Q: "O" };
  const letterToDigit = { O: "0", Q: "0", I: "1", L: "1", S: "5", B: "8", Z: "2" };
  const chars = clean.split("");
  for (let i = 0; i < 2; i++) {
    if (digitToLetter[chars[i]]) chars[i] = digitToLetter[chars[i]];
    else if (letterToLetter[chars[i]]) chars[i] = letterToLetter[chars[i]];
  }
  for (let i = 2; i < 6; i++) {
    if (letterToDigit[chars[i]]) chars[i] = letterToDigit[chars[i]];
  }
  const corrected = chars.join("");
  return REFERENCE_REGEX.test(corrected) ? corrected : "";
}

// The reference lives in the email subject. We don't know the exact subject
// wording yet, so we just scan it for the first LL9999-shaped token and correct
// it. (If subjects turn out to have a fixed prefix like "Reference:", tighten
// this to anchor on it.)
function extractReferenceFromSubject(subject) {
  const text = String(subject || "");
  // Prefer an explicitly-labelled reference if present…
  const labelled = text.match(/reference\s*(?:no\.?)?\s*[:#]?\s*([A-Za-z]{2}\d{4})/i);
  if (labelled) {
    const corrected = correctReferenceFormat(labelled[1]);
    if (corrected) return corrected;
  }
  // …otherwise take the first bare LL9999 token.
  const bare = text.match(/\b([A-Za-z]{2}\d{4})\b/);
  return bare ? correctReferenceFormat(bare[1]) : "";
}

// Gmail message payloads are a nested tree of MIME parts; the PDF can be at any
// depth. Walk it and return the first PDF attachment's { attachmentId, filename }.
function findPdfAttachment(payload) {
  const stack = [payload].filter(Boolean);
  while (stack.length) {
    const part = stack.shift();
    const filename = part.filename || "";
    const mime = part.mimeType || "";
    const attachmentId = part.body && part.body.attachmentId;
    if (attachmentId && (mime === "application/pdf" || /\.pdf$/i.test(filename))) {
      return { attachmentId, filename };
    }
    if (Array.isArray(part.parts)) stack.push(...part.parts);
  }
  return null;
}

function getHeader(payload, name) {
  const headers = (payload && payload.headers) || [];
  const hit = headers.find((h) => h.name && h.name.toLowerCase() === name.toLowerCase());
  return hit ? hit.value : "";
}

// A number like "89.77" or "1,234.56" -> Number, else null.
function parseAmount(raw) {
  if (raw == null) return null;
  const n = Number(String(raw).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

// Pull the invoice number, invoice total, balance due and (cross-check)
// reference out of the invoice text. Anchors were chosen from a real sample
// (invoice 01HX0951, ref BW3391, total 89.77) but must be re-verified against
// live pdf-parse output — the visual layout and the text-stream order differ.
function parseInvoiceText(text) {
  const t = String(text || "");

  // Invoice # — "Invoice No. 01HX0951" at the top / header. The page-1 form
  // (with the branch prefix) is canonical; page 2 sometimes drops it.
  let invoiceNumber = "";
  const invNo = t.match(/Invoice\s*No\.?\s*([0-9A-Z]{6,10})/i);
  if (invNo) invoiceNumber = invNo[1].toUpperCase();
  if (!invoiceNumber) {
    const invNum = t.match(/Invoice\s*NUMBER\s*[:#]?\s*([0-9A-Z]{6,10})/i);
    if (invNum) invoiceNumber = invNum[1].toUpperCase();
  }

  // Balance due — the ONLY reliably-labelled money value is the return stub's
  // "Invoice BALANCE DUE: 89.77", where the amount sits right after a colon. We
  // REQUIRE that colon: the bare "BALANCE DUE" that appears as a column header is
  // followed (in the text stream) by the misaligned value row, whose first number
  // is the sub-total (79.44), not the balance — matching it grabs the wrong figure.
  let balanceDue = null;
  const bal = t.match(/BALANCE\s*DUE\s*:\s*\$?\s*([\d,]+\.\d{2})/i);
  if (bal) balanceDue = parseAmount(bal[1]);

  // Invoice total — "INVOICE TOTAL" only ever appears as a column header (never
  // colon-labelled next to its value), so it can't be extracted positionally
  // from the text stream. It equals the balance due on an unpaid invoice
  // (payments = 0), which is the normal case for these NET-30 invoices, so we use
  // the reliably-labelled balance due as the stored total. If a future invoice
  // carries a real "INVOICE TOTAL:" label, prefer it.
  let invoiceTotal = null;
  const invTot = t.match(/INVOICE\s*TOTAL\s*:\s*\$?\s*([\d,]+\.\d{2})/i);
  if (invTot) invoiceTotal = parseAmount(invTot[1]);
  if (invoiceTotal == null) invoiceTotal = balanceDue;

  // Reference on the invoice itself ("*** ACX Reference No: BW3391 ***") — used
  // to cross-check the subject reference, not as the primary match key.
  let pdfReference = "";
  const ref = t.match(/Reference\s*No\.?\s*[:#]?\s*([A-Za-z]{2}\d{4})/i);
  if (ref) pdfReference = correctReferenceFormat(ref[1]);

  return { invoiceNumber, invoiceTotal, balanceDue, pdfReference };
}

// Extract invoice fields from raw PDF bytes. Uses the text layer (pdf-parse);
// only if that yields no usable text does it fall back to the Epicor-style
// rasterize-then-OCR path.
async function extractInvoiceFromPdf(pdfBuffer) {
  let text = "";
  let usedOcr = false;
  try {
    const data = await getPdfParse()(pdfBuffer);
    text = (data && data.text) || "";
  } catch (e) {
    console.log(`[transbec-invoice] pdf-parse failed: ${e.message}`);
  }

  if (text.replace(/\s/g, "").length < 40) {
    console.log("[transbec-invoice] no usable text layer — falling back to OCR");
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
      console.log(`[transbec-invoice] OCR fallback failed: ${e.message}`);
    }
  }

  const parsed = parseInvoiceText(text);
  return { ...parsed, text, usedOcr };
}

// Stable, filesystem-safe asset names keyed by invoice number (survives future
// searches), mirroring the Epicor convention.
function getInvoiceAssetName(invoiceNumber, ext) {
  const safe = String(invoiceNumber || "")
    .trim()
    .replace(/[^A-Za-z0-9_-]/g, "_");
  return `transbec_invoice_${safe || "unknown"}.${ext}`;
}

// Download a Gmail attachment and return the raw bytes.
async function downloadAttachment(gmail, messageId, attachmentId) {
  const res = await gmail.users.messages.attachments.get({
    userId: "me",
    messageId,
    id: attachmentId,
  });
  const data = res.data && res.data.data;
  if (!data) throw new Error("Attachment had no data.");
  // Gmail returns URL-safe base64.
  return Buffer.from(data, "base64");
}

// Search for candidate invoice emails. Query mirrors the user's chosen anchor:
// sender + subject pattern, restricted to messages that carry an attachment.
async function searchInvoiceEmails(gmail, { sender, subjectPattern, maxResults = 25 }) {
  const parts = ["has:attachment"];
  if (sender) parts.push(`from:(${sender})`);
  if (subjectPattern) parts.push(`subject:(${subjectPattern})`);
  const q = parts.join(" ");
  console.log(`[transbec-invoice] Gmail search query: ${q}`);
  const listRes = await gmail.users.messages.list({ userId: "me", q, maxResults });
  return listRes.data.messages || [];
}

function loadInvoiceCache(cachePath) {
  try {
    if (cachePath && fs.existsSync(cachePath)) {
      const parsed = JSON.parse(fs.readFileSync(cachePath, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    }
  } catch (e) {
    console.log(`[transbec-invoice] failed to load cache: ${e.message}`);
  }
  return {};
}

function saveInvoiceCache(cachePath, cache) {
  try {
    if (!cachePath) return;
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2), "utf8");
  } catch (e) {
    console.log(`[transbec-invoice] failed to save cache: ${e.message}`);
  }
}

module.exports = {
  correctReferenceFormat,
  extractReferenceFromSubject,
  findPdfAttachment,
  getHeader,
  parseInvoiceText,
  extractInvoiceFromPdf,
  getInvoiceAssetName,
  downloadAttachment,
  searchInvoiceEmails,
  loadInvoiceCache,
  saveInvoiceCache,
};
