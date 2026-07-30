// src/scrapers/proforceCreditInvoice.actions.js
// Small parsing helpers for the Proforce credit-invoice Gmail pipeline. Kept
// separate from proforceCreditInvoice.js so the parsing logic can be unit
// tested / tweaked without touching the Gmail search flow.

// Proforce's credit emails (noreply@epartconnection.com) use the subject
// "Invoice #652522" - the number is the same invoice number used as the
// order's reference/source_invoice on the scraped Proforce order.
function extractReferenceFromSubject(subject) {
  const text = String(subject || "");
  const m = text.match(/invoice\s*#\s*(\d+)/i);
  return m ? m[1] : "";
}

// Stable, filesystem-safe asset name keyed by invoice number, mirroring the
// bestbuy_credit_/transbec_credit_ naming convention.
function getProforceCreditAssetName(id) {
  const safe = String(id || "").trim().replace(/[^A-Za-z0-9_-]/g, "_");
  return `proforce_credit_${safe || "unknown"}.pdf`;
}

module.exports = {
  extractReferenceFromSubject,
  getProforceCreditAssetName,
};
