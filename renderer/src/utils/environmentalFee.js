// renderer/src/utils/environmentalFee.js
//
// The environmental handling charge (EHC) is a PER-UNIT fee recorded on a single
// line item. Two things then happen, and they must always happen together:
//
//   * `lineItems[i]` records the fee as metadata only — its costPrice/extended
//     stay as the vendor billed the part itself.
//   * `sage_lineItems[i]` carries the fee-INCLUSIVE figures, because those are
//     what the purchase-entry AHK sends to Sage: cost + fee per unit, and
//     extended + fee x quantity.
//
// This used to live inline in Order Management's "+ev" input. It was lifted out
// when the World Gmail invoice pipeline started applying the fee automatically
// (the invoice prints EHC per line), so the typed path and the automatic path
// cannot drift apart.

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// Fee arithmetic is binary floating point, so 11.88 + 0.21 lands on
// 12.090000000000002. These figures are money and are typed verbatim into Sage
// by the purchase-entry AHK, so round the COMPUTED values back to cents.
function money(n) {
  return n === null ? null : Math.round((n + Number.EPSILON) * 100) / 100;
}

// Parts are compared with dashes and spaces removed: the World order scrape
// stores "MTS EM4042" while the invoice prints "MTS EM-4042" for the same part,
// so an exact string compare silently fails to match. Mirrors the dash handling
// capRules already applies when resolving Sage codes.
export function normalizeFeePartKey(lineCode, partNumber) {
  return `${lineCode || ""}${partNumber || ""}`
    .toUpperCase()
    .replace(/[\s-]/g, "");
}

// Apply (or clear) the per-unit environmental fee on one line item, returning
// fresh lineItems / sage_lineItems arrays. `fee` is the PER-UNIT amount; pass
// null/"" to clear. Returns the arrays unchanged when `index` is out of range.
export function applyEnvironmentalFee(order, index, fee) {
  const lineItems = Array.isArray(order?.lineItems) ? order.lineItems : [];
  const baseSage =
    Array.isArray(order?.sage_lineItems) && order.sage_lineItems.length
      ? order.sage_lineItems
      : lineItems;

  const baseLineItem = lineItems[index];
  if (!baseLineItem) return { lineItems, sage_lineItems: baseSage };

  const trimmed = String(fee ?? "").trim();
  const hasFee = trimmed !== "";
  const parsed = Number(trimmed);
  // Keep a non-numeric entry verbatim so a half-typed value isn't destroyed.
  const amountVal = hasFee && Number.isFinite(parsed) ? parsed : hasFee ? trimmed : null;
  const feeNum = toNumber(amountVal);

  const baseCostVal = toNumber(baseLineItem.costPriceValue ?? baseLineItem.costPrice);
  const baseCostStr = baseLineItem.costPrice ?? baseSage[index]?.costPrice ?? "";
  const baseExtendedVal = toNumber(baseLineItem.extendedValue ?? baseLineItem.extended);
  const baseExtendedStr = baseLineItem.extended ?? baseSage[index]?.extended ?? "";
  const qtyVal = toNumber(baseLineItem.quantity) ?? toNumber(baseSage[index]?.quantity) ?? 0;

  const applies = hasFee && feeNum !== null;
  const nextCostVal =
    applies && baseCostVal !== null ? money(baseCostVal + feeNum) : baseCostVal;
  const nextExtendedVal =
    applies && baseExtendedVal !== null ? money(baseExtendedVal + feeNum * qtyVal) : baseExtendedVal;

  const nextLineItems = lineItems.map((li, idx) =>
    idx === index ? { ...li, hasEnvironmentalFee: hasFee, environmentalFeeAmount: amountVal } : li
  );

  const nextSageLineItems = baseSage.map((li, idx) => {
    if (idx !== index) return li;
    const updated = {
      ...(li || baseLineItem),
      hasEnvironmentalFee: hasFee,
      environmentalFeeAmount: amountVal,
    };
    updated.costPrice = nextCostVal !== null ? String(nextCostVal) : baseCostStr;
    updated.costPriceValue = nextCostVal;
    updated.extended = nextExtendedVal !== null ? String(nextExtendedVal) : baseExtendedStr;
    updated.extendedValue = nextExtendedVal;
    return updated;
  });

  return { lineItems: nextLineItems, sage_lineItems: nextSageLineItems };
}

// Apply every per-unit EHC an invoice reported onto the order's matching lines.
// `invoiceLines` are the parsed invoice's line items ({ partLineCode, partNumber,
// ehcUnit }). Returns the new arrays plus which parts could not be matched, so
// the caller can flag them rather than silently dropping a real charge.
export function applyInvoiceEnvironmentalFees(order, invoiceLines) {
  let working = {
    ...order,
    lineItems: Array.isArray(order?.lineItems) ? order.lineItems : [],
    sage_lineItems:
      Array.isArray(order?.sage_lineItems) && order.sage_lineItems.length
        ? order.sage_lineItems
        : Array.isArray(order?.lineItems)
          ? order.lineItems
          : [],
  };

  const applied = [];
  const unmatched = [];

  for (const invLine of Array.isArray(invoiceLines) ? invoiceLines : []) {
    const feeUnit = Number(invLine?.ehcUnit);
    if (!Number.isFinite(feeUnit) || feeUnit <= 0) continue;

    const wanted = normalizeFeePartKey(invLine.partLineCode, invLine.partNumber);
    // Skip core lines: they mirror their parent part's number and would other-
    // wise swallow the parent's fee.
    const idx = working.lineItems.findIndex(
      (li) => !li?.core && normalizeFeePartKey(li?.partLineCode, li?.partNumber) === wanted
    );
    if (idx < 0) {
      unmatched.push({ part: `${invLine.partLineCode || ""} ${invLine.partNumber || ""}`.trim(), feeUnit });
      continue;
    }
    // Already carries this exact fee (a re-fetch of the same invoice) — leave it
    // alone so the fee is never added into the Sage cost twice.
    const existing = working.lineItems[idx];
    if (
      existing.hasEnvironmentalFee &&
      Number(existing.environmentalFeeAmount) === feeUnit
    ) {
      continue;
    }

    const next = applyEnvironmentalFee(working, idx, feeUnit);
    working = { ...working, lineItems: next.lineItems, sage_lineItems: next.sage_lineItems };
    applied.push({ part: `${invLine.partLineCode || ""} ${invLine.partNumber || ""}`.trim(), feeUnit });
  }

  return {
    lineItems: working.lineItems,
    sage_lineItems: working.sage_lineItems,
    applied,
    unmatched,
  };
}
