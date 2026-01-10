function normalizeOrderRef(order) {
  if (!order) return "";
  const ref = order.sage_reference || order.reference || order.__row || "";
  return String(ref || "").trim().toUpperCase();
}

function orderMatchesKey(order, targetKey) {
  if (!order || !targetKey) return false;
  const candidates = [
    order.sage_reference_synced,
    order.sage_reference,
    order.source_invoice,
    order.reference,
    order.__row,
  ];
  return candidates.some((val) => {
    if (val === null || val === undefined) return false;
    return String(val).trim().toUpperCase() === targetKey;
  });
}

function getVendorName(order) {
  if (!order) return "";
  return (
    (order.sage_source || "").trim() ||
    (order.warehouse || "").trim() ||
    (order.seller || "").trim()
  );
}

module.exports = { normalizeOrderRef, orderMatchesKey, getVendorName };
