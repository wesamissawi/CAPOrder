// src/scrapers/creditShape.js
// Is this order a credit/return rather than a purchase?
//
// Some vendors announce it (Transbec credit memos and the BestBuy/Proforce
// Gmail credit pipelines set `isCredit` explicitly), but most don't — a BestBuy
// return, for instance, is scraped from the ordinary order-history page and
// looks like any other order apart from its signs. The document's SHAPE is the
// signal that works for every vendor: a credit's total is negative and its
// lines carry negative quantities.
//
// This is the CommonJS twin of `looksLikeCredit` in
// renderer/src/utils/qtyDiscrepancy.js — the renderer can't require CJS out of
// src/, so the rule is written once on each side. Keep the two in step: they
// must agree on what counts as a credit, or an order will be filtered as one in
// the UI and archived as a purchase by the main process.
function toNumber(val) {
  const n = Number(val);
  return Number.isFinite(n) ? n : 0;
}

// sage_lineItems (Sage-standardized) is what actually gets entered into Sage;
// fall back to the raw scraped lineItems if standardization hasn't run yet.
function creditLineItems(order) {
  if (Array.isArray(order?.sage_lineItems) && order.sage_lineItems.length) {
    return order.sage_lineItems;
  }
  return Array.isArray(order?.lineItems) ? order.lineItems : [];
}

function orderLooksLikeCredit(order) {
  if (order?.isCredit === true) return true;
  // Header total, which a list-page scrape has before any detail fetch — so a
  // credit is still recognized when its line items never came back.
  if (toNumber(order?.total) < 0) return true;
  const lineItems = creditLineItems(order);
  if (!lineItems.length) return false;
  if (lineItems.some((li) => toNumber(li?.quantity) < 0)) return true;
  return lineItems.reduce((sum, li) => sum + toNumber(li?.quantity) * toNumber(li?.costPriceValue ?? li?.costPrice), 0) < 0;
}

module.exports = { orderLooksLikeCredit };
