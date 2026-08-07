// Shown either when "Stop" is clicked in Order Assignment's arm bar, or on
// demand via the "Review" button while still armed (in which case confirming
// saves price edits but leaves the destination armed — see `andStop` on the
// caller's state).
//
// The two entry points default to different scopes. Stop defaults to just the
// parts assigned THIS session — a busy destination (CashPad routinely has
// 100+ parts) would otherwise dump its entire history into review every time
// you stop. The standalone Review button, by contrast, defaults to the WHOLE
// order — you clicked it specifically to look things over, not because you're
// about to stop. Either way, the toggle switches views on demand.
import React, { useState } from "react";
import {
  DEFAULT_TAX_RATE,
  computeDocumentTotals,
  formatPrice,
  taxInToPretax,
} from "../utils/quote";

function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? `$${n.toFixed(2)}` : "—";
}

export default function StopAssignModal({
  destination,
  sessionItems,
  allItems,
  title = "Review before stopping",
  confirmLabel = "Save & Stop",
  defaultShowAll = false,
  onCancel,
  onConfirm,
}) {
  const [showAll, setShowAll] = useState(defaultShowAll);
  const [saving, setSaving] = useState(false);
  // Keyed by uid so an edit survives toggling between the session view and the
  // whole-order view (a session item is always also present in allItems).
  const [drafts, setDrafts] = useState(() => {
    const init = {};
    allItems.forEach((it) => {
      init[it.uid] = String(it.allocated_for ?? "");
    });
    return init;
  });

  // Tax-in prices START BLANK and stay blank unless someone types one. They're
  // deliberately NOT derived from the sell price: every part has a sell price,
  // so a derived column would mark every order as "quoted taxes in" and the
  // Quotation printout — which is gated on this — would be offered on orders
  // nobody ever quoted that way. A filled box means a promise was made.
  const [taxInDrafts, setTaxInDrafts] = useState(() => {
    const init = {};
    allItems.forEach((it) => {
      init[it.uid] = String(it.tax_in_price ?? "");
    });
    return init;
  });

  const list = showAll ? allItems : sessionItems;

  // Typing a sell price by hand retires whatever was quoted: the two no longer
  // describe each other, and a stale tax-in figure is worse than none — it's
  // the number the Quotation would print at the customer.
  const setPrice = (uid, val) => {
    setDrafts((prev) => ({ ...prev, [uid]: val }));
    setTaxInDrafts((prev) => ({ ...prev, [uid]: "" }));
  };

  // Customers ask for a part "taxes in" — $100 means $100 out the door, per
  // part, so a qty of 3 is $300. The sell price is what's left with the tax
  // backed out, and that's the only thing this modal ever saves.
  const setTaxIn = (uid, val) => {
    setTaxInDrafts((prev) => ({ ...prev, [uid]: val }));
    const trimmed = String(val ?? "").trim();
    if (trimmed === "") return;
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) return;
    // Four decimals when the division needs them — that's what makes "$100
    // taxes in" come back out of the sales order as exactly $100.
    setDrafts((prev) => ({ ...prev, [uid]: formatPrice(taxInToPretax(parsed, DEFAULT_TAX_RATE)) }));
  };

  const total = list.reduce(
    (sum, it) => sum + (Number(it.quantity) || 0) * (Number(drafts[it.uid]) || 0),
    0
  );
  // Computed the way the printed footer computes it — tax on the rounded
  // subtotal, not the sum of per-line taxes — so this figure is the one the
  // Quotation and the Sales Order will both land on.
  const taxInTotal = computeDocumentTotals(
    list.map((it) => ({
      extension: (Number(it.quantity) || 0) * (Number(drafts[it.uid]) || 0),
      taxable: true,
    })),
    DEFAULT_TAX_RATE
  ).total;

  async function handleConfirm() {
    setSaving(true);
    try {
      // A row counts as changed if EITHER field moved. Keying only off the sell
      // price would drop a tax-in figure that happened to back out to the price
      // already stored — and that figure is what unlocks the Quotation, so
      // losing it silently would leave an order that can't print what it was
      // quoted at.
      const changed = allItems
        .filter((it) => {
          const price = (drafts[it.uid] ?? "").trim();
          const taxIn = (taxInDrafts[it.uid] ?? "").trim();
          return (
            price !== String(it.allocated_for ?? "").trim() ||
            taxIn !== String(it.tax_in_price ?? "").trim()
          );
        })
        .map((it) => ({
          ...it,
          allocated_for: (drafts[it.uid] ?? "").trim(),
          tax_in_price: (taxInDrafts[it.uid] ?? "").trim(),
          last_moved_at: new Date().toISOString(),
        }));
      await onConfirm(changed);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[5000] bg-slate-900/60 flex items-center justify-center px-4">
      <div className="bg-white rounded-3xl shadow-2xl w-full max-w-2xl p-6 flex flex-col gap-4 max-h-[90vh]">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold text-slate-800">{title}</h2>
            <p className="text-sm text-slate-500">
              <span className="font-semibold text-slate-700">{destination}</span> — check the selling
              price on what you just assigned. Quoting a part{" "}
              <span className="font-semibold text-slate-700">taxes in</span>? Type that figure in the
              Tax-in column and the sell price backs the tax out for you.
            </p>
          </div>
          <button className="text-slate-500 hover:text-slate-700 text-lg leading-none" onClick={onCancel}>
            ×
          </button>
        </div>

        <label className="flex items-center gap-2 text-xs font-semibold text-slate-600">
          <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
          Show the entire order ({allItems.length} part{allItems.length === 1 ? "" : "s"}) instead of
          just what was added ({sessionItems.length})
        </label>

        <div className="border rounded-2xl bg-slate-50 overflow-auto max-h-[50vh]">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-wide text-slate-400 border-b border-slate-200">
                <th className="px-3 py-2">Part</th>
                <th className="px-3 py-2 text-center">Qty</th>
                <th className="px-3 py-2 text-right">Cost</th>
                <th className="px-3 py-2 text-right" title="What the customer pays for one, tax included">
                  Tax-in (each)
                </th>
                <th className="px-3 py-2 text-right">Sell Price</th>
              </tr>
            </thead>
            <tbody>
              {list.map((it) => {
                const changed =
                  (drafts[it.uid] ?? "").trim() !== String(it.allocated_for ?? "").trim() ||
                  (taxInDrafts[it.uid] ?? "").trim() !== String(it.tax_in_price ?? "").trim();
                return (
                  <tr key={it.uid} className={`border-b border-slate-100 ${changed ? "bg-amber-50" : "bg-white"}`}>
                    <td className="px-3 py-2">
                      <div className="font-semibold text-slate-800">{it.itemcode}</div>
                      {it.notes1 && <div className="text-xs text-slate-500">{it.notes1}</div>}
                    </td>
                    <td className="px-3 py-2 text-center text-slate-600">{it.quantity}</td>
                    <td className="px-3 py-2 text-right text-slate-500">{money(it.cost)}</td>
                    <td className="px-3 py-2 text-right">
                      <input
                        value={taxInDrafts[it.uid] ?? ""}
                        onChange={(e) => setTaxIn(it.uid, e.target.value)}
                        placeholder="—"
                        title="What you quoted the customer for one of these, tax included"
                        className="w-24 border border-emerald-300 rounded-lg px-2 py-1 text-right text-sm bg-emerald-50/60"
                      />
                    </td>
                    <td className="px-3 py-2 text-right">
                      <input
                        value={drafts[it.uid] ?? ""}
                        onChange={(e) => setPrice(it.uid, e.target.value)}
                        className="w-24 border rounded-lg px-2 py-1 text-right text-sm bg-white"
                      />
                    </td>
                  </tr>
                );
              })}
              {list.length === 0 && (
                <tr>
                  <td className="px-3 py-4 text-center text-slate-500" colSpan={5}>
                    {showAll ? "Nothing in this order." : "Nothing was assigned this session."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-slate-100 pt-3">
          <div className="text-sm text-slate-600">
            Total at these prices: <strong className="text-slate-800">{money(total)}</strong>
            <span className="ml-2 text-slate-500">
              · <strong className="text-emerald-700">{money(taxInTotal)}</strong> taxes in
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              className="px-4 py-2 rounded-full text-sm font-semibold border border-slate-300 text-slate-700 hover:bg-slate-50"
              onClick={onCancel}
              disabled={saving}
            >
              Cancel
            </button>
            <button
              className="px-5 py-2 rounded-full text-sm font-semibold bg-indigo-600 text-white shadow hover:bg-indigo-700 disabled:opacity-50"
              onClick={handleConfirm}
              disabled={saving}
            >
              {saving ? "Saving…" : confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
