// src/scrapers/sageStandardize.js
// Utility to normalize orders/line items into a Sage-friendly shape across scrapers.

const { resolveCapCode } = require("./capRules");
const { orderLooksLikeCredit } = require("./creditShape");

function cleanMoneyString(val) {
  if (val === null || val === undefined) return "";
  return String(val).replace(/[^\d.-]/g, "").trim();
}

function toNumber(val) {
  if (val === null || val === undefined) return null;
  const n = parseFloat(cleanMoneyString(val));
  return Number.isFinite(n) ? n : null;
}

function normalizeLineItem(item = {}, warehouse = "") {
  const costRaw = item.costPrice ?? item.cost ?? item.net ?? item.extended ?? "";
  const extendedRaw = item.extended ?? item.total ?? item.extendedValue ?? "";
  const partLineCode = item.partLineCode || item.brand || item.line || "";
  const partNumber = item.partNumber || item.part || item.sku || "";
  const partDescription = item.partDescription || item.description || item.notes || "";
  // Resolved CAP/Sage identity for this line. partLineCode/partNumber stay RAW
  // (the purchase-entry AHK re-applies ourRules to them), but sageCode holds the
  // final code the part will actually carry in Sage — the same value the bubble
  // stores — so the two never drift. See src/scrapers/capRules.js.
  const resolved = resolveCapCode(warehouse, partLineCode, partNumber, partDescription);
  return {
    ...item,
    partLineCode,
    partNumber,
    costPrice: cleanMoneyString(costRaw),
    costPriceValue: item.costPriceValue ?? toNumber(costRaw),
    partDescription,
    sageCode: resolved.code,
    sageDescription: resolved.description,
    quantity: item.quantity ?? item.qty ?? item.count ?? "",
    extended: cleanMoneyString(extendedRaw),
    extendedValue: item.extendedValue ?? toNumber(extendedRaw),
    core: Boolean(item.core),
  };
}

function standardizeOrderForSage(order = {}) {
  const invoice = (order.invoiceNum || "").toString().trim();
  const reference = (order.source_invoice || order.reference || "").toString().trim();
  const warehouse = (order.warehouse || order.seller || order.source || "").toString().trim();
  const sage_source = (order.sage_source || order.source || warehouse || "").toString().trim();
  const lastUpdatedAt = order.lastUpdatedAt || order.updatedAt || new Date().toISOString();
  const sage_lineItems = Array.isArray(order.lineItems)
    ? order.lineItems.map((li) => normalizeLineItem(li || {}, warehouse))
    : [];
  return {
    ...order,
    warehouse: warehouse || order.warehouse || "",
    source: order.source || warehouse || order.seller || "",
    sageDate: order.sageDate || order.sage_date || "",
    sage_reference: reference,
    sage_source,
    lastUpdatedAt,
    // Every scraper routes through here, so this is where a credit/return gets
    // classified for all of them at once — no vendor has to know it scraped a
    // credit, only that the document's signs are negative (see creditShape.js).
    // Only ever set to true: the Gmail credit pipelines flag orders whose own
    // shape isn't negative, and this must not undo that.
    ...(orderLooksLikeCredit({ ...order, sage_lineItems }) ? { isCredit: true } : {}),
    sage_lineItems,
  };
}

module.exports = {
  standardizeOrderForSage,
  normalizeLineItem,
};
