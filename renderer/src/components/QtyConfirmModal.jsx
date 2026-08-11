import React, { useMemo, useState } from "react";
import { computeExpectedTotal, getOrderLineItemsForCalc } from "../utils/qtyDiscrepancy";

function money(n) {
  const v = Number(n);
  return Number.isFinite(v) ? `$${v.toFixed(2)}` : "—";
}

function toNumber(val) {
  const n = Number(val);
  return Number.isFinite(n) ? n : 0;
}

function partLabel(li) {
  return `${li?.partLineCode || li?.sageCode || ""} ${li?.partNumber || ""}`.trim() || "Item";
}

function normPart(v) {
  return String(v || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

// Identity used to pair a row with its counterpart in the OTHER line-item array.
// lineItems and sage_lineItems are born as a 1:1 map of each other
// (sageStandardize.js), but nothing keeps them that way — an edit that filters
// or reorders one leaves the other untouched. Matching by array position would
// then quietly write a quantity onto the wrong part, so pair on part identity
// instead. The occurrence counter keeps an order that legitimately lists the
// same part twice from collapsing onto one draft; a line with nothing to
// identify it by falls back to its position.
function buildLineKeys(lineItems) {
  const seen = new Map();
  return (lineItems || []).map((li, idx) => {
    const base = `${normPart(li?.partLineCode)}|${normPart(li?.partNumber)}`;
    if (base === "|") return `__pos:${idx}`;
    const n = seen.get(base) || 0;
    seen.set(base, n + 1);
    return `${base}#${n}`;
  });
}

// Quantities move toward zero, never away from it: a purchase line can only be
// lowered (4 -> 0) and a credit line only reduced in magnitude (-4 -> 0). Both
// are "somewhere between zero and what was ordered", which is the same clamp
// once the bounds are ordered — the earlier Math.min(Math.max(0, n), original)
// silently pinned every negative line to its original value, leaving the modal
// unable to change anything at all.
function clampTowardZero(next, originalQty) {
  const lo = Math.min(0, originalQty);
  const hi = Math.max(0, originalQty);
  return Math.min(Math.max(Number.isFinite(next) ? next : 0, lo), hi);
}

// Shown when a confirmed billed total doesn't match what the order's line
// items add up to (see qtyDiscrepancy.js) — almost always because the
// warehouse shipped less than it originally took the order for. Quantities can
// only be reduced here, never increased: this is a shortage correction, not a
// general line-item editor. When the gap can't be closed that way (a fee or
// core charge on the invoice, so the billed total is HIGHER than the lines),
// "Send to Sage anyway" records the discrepancy as reviewed and unblocks the
// order rather than leaving it unsendable.
export default function QtyConfirmModal({
  order,
  refKey,
  taxRate,
  threshold,
  onClose,
  onSave,
  onAcknowledge,
}) {
  const alreadyEntered = Boolean(order?.enteredInSage);
  const baseLineItems = useMemo(() => getOrderLineItemsForCalc(order), [order]);
  const baseKeys = useMemo(() => buildLineKeys(baseLineItems), [baseLineItems]);
  const hasSageLineItems = Array.isArray(order?.sage_lineItems) && order.sage_lineItems.length > 0;

  // Keyed by part identity, not position — see buildLineKeys.
  const [drafts, setDrafts] = useState(() => {
    const init = {};
    baseLineItems.forEach((li, idx) => {
      const originalQty = toNumber(li?.quantity);
      init[baseKeys[idx]] = { originalQty, qty: originalQty };
    });
    return init;
  });
  const [saving, setSaving] = useState(false);
  const [acking, setAcking] = useState(false);

  const billedRaw = order?.billed_total ?? order?.billedTotal;
  const billedNum =
    billedRaw === null || billedRaw === undefined || billedRaw === "" ? NaN : Number(billedRaw);

  const draftLineItemsForCalc = useMemo(
    () =>
      baseLineItems.map((li, idx) => ({
        ...li,
        quantity: drafts[baseKeys[idx]]?.qty ?? li.quantity,
      })),
    [baseLineItems, baseKeys, drafts]
  );
  const expected = computeExpectedTotal(draftLineItemsForCalc, taxRate);
  const diff = Number.isFinite(billedNum) ? Number((billedNum - expected.total).toFixed(2)) : null;
  const thresholdNum = Number.isFinite(Number(threshold)) ? Number(threshold) : 15;
  const stillOver = diff !== null && Math.abs(diff) > thresholdNum;

  function setQty(key, nextQty) {
    setDrafts((prev) => {
      const d = prev[key];
      if (!d) return prev;
      return { ...prev, [key]: { ...d, qty: clampTowardZero(nextQty, d.originalQty) } };
    });
  }

  // Applies a draft to whichever array this line came from, matched by identity.
  // A line with no draft (present in lineItems but not in sage_lineItems, or
  // vice versa) is deliberately left exactly as it was.
  function applyQtyToLine(li, key) {
    const draft = drafts[key];
    if (!draft) return li;
    const qty = draft.qty;
    const price = toNumber(li?.costPriceValue ?? li?.costPrice);
    return {
      ...li,
      quantity: qty,
      extendedValue: qty * price,
      extended: String(qty * price),
    };
  }

  function applyToArray(lineItems) {
    const keys = buildLineKeys(lineItems);
    return (lineItems || []).map((li, idx) => applyQtyToLine(li, keys[idx]));
  }

  async function handleSave() {
    setSaving(true);
    try {
      const nextLineItems = applyToArray(order?.lineItems || []);
      const nextSageLineItems = hasSageLineItems ? applyToArray(order.sage_lineItems) : null;
      await onSave(refKey, nextLineItems, nextSageLineItems);
      onClose();
    } finally {
      setSaving(false);
    }
  }

  async function handleAcknowledge() {
    if (!onAcknowledge || diff === null) return;
    setAcking(true);
    try {
      await onAcknowledge(refKey, diff);
      onClose();
    } finally {
      setAcking(false);
    }
  }

  const anyChanged = Object.values(drafts).some((d) => d.qty !== d.originalQty);
  const busy = saving || acking;

  return (
    <div className="fixed inset-0 z-[5000] bg-slate-900/60 flex items-center justify-center px-4">
      <div className="bg-white rounded-3xl shadow-2xl w-full max-w-2xl p-6 flex flex-col gap-4 max-h-[90vh]">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold text-slate-800">Confirm Quantities</h2>
            <p className="text-sm text-slate-500">
              {order?.warehouse || "-"} - {order?.reference || refKey} — the billed total doesn't
              match what these line items add up to. Lower the quantities that didn't actually
              ship, then save. Quantities can only be reduced, never increased.
              {alreadyEntered && (
                <>
                  {" "}
                  This order is already entered in Sage — saving here only corrects the record of
                  what shipped; it does not change the amount already posted in Sage. Use
                  "Reconcile totals" on the card for that.
                </>
              )}
            </p>
          </div>
          <button className="text-slate-500 hover:text-slate-700 text-lg leading-none" onClick={onClose}>
            x
          </button>
        </div>

        <div className="border rounded-2xl bg-slate-50 overflow-auto max-h-[45vh]">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-wide text-slate-400 border-b border-slate-200">
                <th className="px-3 py-2">Part</th>
                <th className="px-3 py-2 text-right">Price</th>
                <th className="px-3 py-2 text-center">Ordered Qty</th>
                <th className="px-3 py-2 text-center">New Qty</th>
                <th className="px-3 py-2 text-right">Extension</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {baseLineItems.map((li, idx) => {
                const key = baseKeys[idx];
                const draft = drafts[key] || { originalQty: 0, qty: 0 };
                const price = toNumber(li?.costPriceValue ?? li?.costPrice);
                const extension = draft.qty * price;
                const changed = draft.qty !== draft.originalQty;
                return (
                  <tr
                    key={key}
                    className={`border-b border-slate-100 ${changed ? "bg-amber-50" : "bg-white"}`}
                  >
                    <td className="px-3 py-2">
                      <div className="font-semibold text-slate-800">{partLabel(li)}</div>
                      {li?.partDescription && (
                        <div className="text-xs text-slate-500">{li.partDescription}</div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right text-slate-700">{money(price)}</td>
                    <td className="px-3 py-2 text-center text-slate-500">{draft.originalQty}</td>
                    <td className="px-3 py-2 text-center">
                      <input
                        type="number"
                        min={Math.min(0, draft.originalQty)}
                        max={Math.max(0, draft.originalQty)}
                        value={draft.qty}
                        onChange={(e) => setQty(key, parseInt(e.target.value, 10))}
                        className="w-16 border rounded-lg px-2 py-1 text-center text-sm bg-white"
                      />
                    </td>
                    <td className="px-3 py-2 text-right font-semibold text-slate-800">
                      {money(extension)}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button
                        type="button"
                        onClick={() => setQty(key, 0)}
                        disabled={draft.qty === 0}
                        className="px-2 py-1 rounded-lg text-xs font-semibold border bg-white text-red-600 border-red-200 hover:bg-red-50 disabled:opacity-40 disabled:cursor-not-allowed"
                        title="Set quantity to zero"
                      >
                        Zero
                      </button>
                    </td>
                  </tr>
                );
              })}
              {baseLineItems.length === 0 && (
                <tr>
                  <td className="px-3 py-4 text-center text-slate-500" colSpan={6}>
                    No line items on this order.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* The gap is the wrong way round for a shortage: the invoice is asking
            for MORE than the parts come to, so no reduction here can close it.
            Say so plainly rather than letting the user hunt for a quantity to
            lower that doesn't exist. */}
        {stillOver && diff !== null && diff > 0 && (
          <div className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">
            The billed total is <strong>higher</strong> than these line items, so lowering
            quantities will only widen the gap. That usually means an environmental fee, core
            charge or freight on the invoice that isn't a line here — in which case use
            <strong>{alreadyEntered ? " Mark reviewed" : " Send to Sage anyway"}</strong>.
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-3">
          <div className="text-sm text-slate-600 space-y-0.5">
            <div>
              Subtotal {money(expected.subtotal)} + Tax {money(expected.tax)} = Expected total{" "}
              <strong className="text-slate-800">{money(expected.total)}</strong>
            </div>
            <div>
              Billed total <strong className="text-slate-800">{money(billedNum)}</strong>
              {diff !== null && (
                <span className={stillOver ? "text-red-600 font-semibold" : "text-emerald-600 font-semibold"}>
                  {" "}
                  (diff {diff >= 0 ? "+" : ""}
                  {money(diff)})
                </span>
              )}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              className="px-4 py-2 rounded-full text-sm font-semibold border border-slate-300 text-slate-700 hover:bg-slate-50"
              onClick={onClose}
              disabled={busy}
            >
              Cancel
            </button>
            {/* Escape hatch: without it an order whose gap can't be closed by
                lowering quantities has no route to Sage at all. Post-entry there
                is nothing left to send, but the gap still needs a way to be
                dismissed as reviewed instead of nagging forever. */}
            {stillOver && onAcknowledge && (
              <button
                className="px-4 py-2 rounded-full text-sm font-semibold border border-amber-400 text-amber-800 bg-white hover:bg-amber-50 disabled:opacity-50"
                onClick={handleAcknowledge}
                disabled={busy}
                title={
                  alreadyEntered
                    ? "Record this difference as reviewed. The check returns if the billed total or the line items change."
                    : "Record this difference as reviewed and let the order go to Sage. The check returns if the billed total or the line items change."
                }
              >
                {acking ? "Recording…" : alreadyEntered ? "Mark reviewed" : "Send to Sage anyway"}
              </button>
            )}
            <button
              className="px-5 py-2 rounded-full text-sm font-semibold bg-indigo-600 text-white shadow hover:bg-indigo-700 disabled:opacity-50"
              onClick={handleSave}
              disabled={!anyChanged || busy}
              title={!anyChanged ? "Lower at least one quantity before saving" : ""}
            >
              {saving ? "Saving…" : "Save Quantities"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
