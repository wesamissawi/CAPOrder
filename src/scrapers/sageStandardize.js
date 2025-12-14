// src/scrapers/sageStandardize.js
// Utility to normalize orders/line items into a Sage-friendly shape across scrapers.

function toNumber(val) {
  if (val === null || val === undefined) return null;
  const str = String(val);
  const n = parseFloat(str.replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function normalizeLineItem(item = {}) {
  const costRaw = item.costPrice ?? item.cost ?? item.net ?? item.extended ?? "";
  const extendedRaw = item.extended ?? item.total ?? item.extendedValue ?? "";
  return {
    ...item,
    partLineCode: item.partLineCode || item.brand || item.line || "",
    partNumber: item.partNumber || item.part || item.sku || "",
    costPrice: costRaw,
    costPriceValue: item.costPriceValue ?? toNumber(costRaw),
    partDescription: item.partDescription || item.description || item.notes || "",
    quantity: item.quantity ?? item.qty ?? item.count ?? "",
    extended: extendedRaw,
    extendedValue: item.extendedValue ?? toNumber(extendedRaw),
    core: Boolean(item.core),
  };
}

function standardizeOrderForSage(order = {}) {
  const invoice = (order.invoiceNum || "").toString().trim();
  const reference = (order.source_invoice || order.reference || "").toString().trim();
  const warehouse = (order.warehouse || order.seller || order.source || "").toString().trim();
  const sage_source = (order.sage_source || order.source || warehouse || "").toString().trim();
  return {
    ...order,
    warehouse: warehouse || order.warehouse || "",
    source: order.source || warehouse || order.seller || "",
    sageDate: order.sageDate || order.sage_date || "",
    sage_reference: reference,
    sage_source,
    sage_lineItems: Array.isArray(order.lineItems)
      ? order.lineItems.map((li) => normalizeLineItem(li || {}))
      : [],
  };
}

module.exports = {
  standardizeOrderForSage,
  normalizeLineItem,
};
