// src/scrapers/bestbuyCreditInvoice.actions.js
// Parsing helpers for BestBuy CREDIT invoices, which arrive one-per-email from
// bestautosolution.ca as "Re: Invoice 21-9074026". IMPORTANT: the number in the
// subject (9074026) is the PACKING SLIP — i.e. the return order's `reference` —
// NOT the invoice number. The real invoice number (e.g. 2408861) lives only in
// the PDF body ("Invoice No:"). The subject number is what we match orders on.
//
// The SAME sender also sends "Re Order No.: 21-8664280" order-confirmation
// emails using the identical numbering scheme, so a Gmail search on the bare
// reference number would match both — callers must drop anything matching
// isOrderConfirmationSubject before treating a hit as a credit invoice.

// "Re: Invoice 21-9074026" -> "9074026" (drops the branch prefix). This is the
// packing slip / order reference, not the invoice number. Falls back to any
// bare run of digits long enough to plausibly be a reference.
function extractReferenceFromSubject(subject) {
  const s = String(subject || "");
  const labelled = s.match(/invoice\s+\d+-(\d+)/i);
  if (labelled) return labelled[1];
  const bare = s.match(/\b(\d{6,8})\b/);
  return bare ? bare[1] : "";
}

// "Re Order No.: 21-8664280" — an order confirmation, NOT a credit invoice,
// even though it comes from the same sender and carries a reference number in
// the exact same shape. Must be excluded by subject before matching, since the
// number alone can't tell the two apart.
function isOrderConfirmationSubject(subject) {
  return /\border\s*no\b/i.test(String(subject || ""));
}

module.exports = { extractReferenceFromSubject, isOrderConfirmationSubject };
