// Before an order goes to Sage, its billed (invoice-confirmed) total is
// compared against what the line items actually add up to. A vendor that
// short-ships part of an order bills only for what shipped, while the
// scraped order still carries the original (larger) quantities — so a big
// gap here almost always means quantities need to be corrected downward,
// not that the invoice is wrong.

const DEFAULT_THRESHOLD = 15;
const DEFAULT_TAX_RATE = 0.13;

function toNumber(val) {
  const n = Number(val);
  return Number.isFinite(n) ? n : 0;
}

// sage_lineItems (Sage-standardized) is what actually gets entered into Sage;
// fall back to the raw scraped lineItems if standardization hasn't run yet.
export function getOrderLineItemsForCalc(order) {
  if (Array.isArray(order?.sage_lineItems) && order.sage_lineItems.length) {
    return order.sage_lineItems;
  }
  return Array.isArray(order?.lineItems) ? order.lineItems : [];
}

// Recomputed from quantity x unit price rather than trusting each line's
// stored `extended` — that field is set at scrape time from the vendor's
// original order quantity, which is exactly what this check exists to catch
// as stale once a line's quantity is corrected down.
export function computeLineItemsSubtotal(lineItems) {
  return (lineItems || []).reduce((sum, li) => {
    const qty = toNumber(li?.quantity);
    const price = toNumber(li?.costPriceValue ?? li?.costPrice);
    return sum + qty * price;
  }, 0);
}

export function computeExpectedTotal(lineItems, taxRate = DEFAULT_TAX_RATE) {
  const subtotal = computeLineItemsSubtotal(lineItems);
  const rate = Number.isFinite(Number(taxRate)) ? Number(taxRate) : 0;
  const tax = subtotal * rate;
  return { subtotal, tax, total: subtotal + tax };
}

// Returns null when there isn't enough information to judge (no confirmed
// billed total yet, no line items, already in Sage, or a credit — credits
// follow their own sign conventions and aren't what this check targets).
export function getOrderQtyDiscrepancy(order, taxRate = DEFAULT_TAX_RATE, threshold = DEFAULT_THRESHOLD) {
  if (!order || order.enteredInSage === true || order.isCredit === true) return null;
  const billedRaw = order.billed_total ?? order.billedTotal;
  const billedNum = billedRaw === null || billedRaw === undefined || billedRaw === "" ? NaN : Number(billedRaw);
  if (!Number.isFinite(billedNum)) return null;
  const lineItems = getOrderLineItemsForCalc(order);
  if (!lineItems.length) return null;
  const expected = computeExpectedTotal(lineItems, taxRate);
  const diff = Number((billedNum - expected.total).toFixed(2));
  const thresholdNum = Number.isFinite(Number(threshold)) ? Number(threshold) : DEFAULT_THRESHOLD;
  return {
    billedTotal: billedNum,
    expectedTotal: expected.total,
    subtotal: expected.subtotal,
    tax: expected.tax,
    diff,
    overThreshold: Math.abs(diff) > thresholdNum,
  };
}

export { DEFAULT_THRESHOLD, DEFAULT_TAX_RATE };
