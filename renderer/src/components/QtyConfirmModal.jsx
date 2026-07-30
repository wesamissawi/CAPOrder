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

// Shown when a confirmed billed total doesn't match what the order's line
// items add up to (see qtyDiscrepancy.js) — almost always because the
// warehouse shipped less than it originally took the order for. Quantities
// can only be lowered here, never raised: this is a shortage correction, not
// a general line-item editor.
export default function QtyConfirmModal({ order, refKey, taxRate, threshold, onClose, onSave }) {
  const baseLineItems = useMemo(() => getOrderLineItemsForCalc(order), [order]);
  const hasSageLineItems = Array.isArray(order?.sage_lineItems) && order.sage_lineItems.length > 0;

  const [drafts, setDrafts] = useState(() =>
    baseLineItems.map((li) => {
      const originalQty = toNumber(li?.quantity);
      return { originalQty, qty: originalQty };
    })
  );
  const [saving, setSaving] = useState(false);

  const billedRaw = order?.billed_total ?? order?.billedTotal;
  const billedNum =
    billedRaw === null || billedRaw === undefined || billedRaw === "" ? NaN : Number(billedRaw);

  const draftLineItemsForCalc = useMemo(
    () => baseLineItems.map((li, idx) => ({ ...li, quantity: drafts[idx]?.qty ?? li.quantity })),
    [baseLineItems, drafts]
  );
  const expected = computeExpectedTotal(draftLineItemsForCalc, taxRate);
  const diff = Number.isFinite(billedNum) ? Number((billedNum - expected.total).toFixed(2)) : null;
  const thresholdNum = Number.isFinite(Number(threshold)) ? Number(threshold) : 15;
  const stillOver = diff !== null && Math.abs(diff) > thresholdNum;

  function setQty(idx, nextQty) {
    setDrafts((prev) =>
      prev.map((d, i) => {
        if (i !== idx) return d;
        const clamped = Math.min(Math.max(0, Number.isFinite(nextQty) ? nextQty : 0), d.originalQty);
        return { ...d, qty: clamped };
      })
    );
  }

  function applyQtyToLine(li, idx) {
    const draft = drafts[idx];
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

  async function handleSave() {
    setSaving(true);
    try {
      const nextLineItems = (order?.lineItems || []).map((li, idx) => applyQtyToLine(li, idx));
      const nextSageLineItems = hasSageLineItems
        ? order.sage_lineItems.map((li, idx) => applyQtyToLine(li, idx))
        : null;
      await onSave(refKey, nextLineItems, nextSageLineItems);
      onClose();
    } finally {
      setSaving(false);
    }
  }

  const anyChanged = drafts.some((d) => d.qty !== d.originalQty);

  return (
    <div className="fixed inset-0 z-[5000] bg-slate-900/60 flex items-center justify-center px-4">
      <div className="bg-white rounded-3xl shadow-2xl w-full max-w-2xl p-6 flex flex-col gap-4 max-h-[90vh]">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold text-slate-800">Confirm Quantities</h2>
            <p className="text-sm text-slate-500">
              {order?.warehouse || "-"} - {order?.reference || refKey} — the billed total doesn't
              match what these line items add up to. Lower the quantities that didn't actually
              ship, then save. Quantities can only go down, never up.
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
                const draft = drafts[idx] || { originalQty: 0, qty: 0 };
                const price = toNumber(li?.costPriceValue ?? li?.costPrice);
                const extension = draft.qty * price;
                const changed = draft.qty !== draft.originalQty;
                return (
                  <tr
                    key={`${li?.partNumber || "li"}-${idx}`}
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
                        min="0"
                        max={draft.originalQty}
                        value={draft.qty}
                        onChange={(e) => setQty(idx, parseInt(e.target.value, 10))}
                        className="w-16 border rounded-lg px-2 py-1 text-center text-sm bg-white"
                      />
                    </td>
                    <td className="px-3 py-2 text-right font-semibold text-slate-800">
                      {money(extension)}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button
                        type="button"
                        onClick={() => setQty(idx, 0)}
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
          <div className="flex items-center gap-2">
            <button
              className="px-4 py-2 rounded-full text-sm font-semibold border border-slate-300 text-slate-700 hover:bg-slate-50"
              onClick={onClose}
            >
              Cancel
            </button>
            <button
              className="px-5 py-2 rounded-full text-sm font-semibold bg-indigo-600 text-white shadow hover:bg-indigo-700 disabled:opacity-50"
              onClick={handleSave}
              disabled={!anyChanged || saving}
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
