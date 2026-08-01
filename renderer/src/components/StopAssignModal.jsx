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

  const list = showAll ? allItems : sessionItems;
  const setPrice = (uid, val) => setDrafts((prev) => ({ ...prev, [uid]: val }));

  const total = list.reduce(
    (sum, it) => sum + (Number(it.quantity) || 0) * (Number(drafts[it.uid]) || 0),
    0
  );

  async function handleConfirm() {
    setSaving(true);
    try {
      const changed = allItems
        .filter((it) => {
          const draft = drafts[it.uid];
          return draft !== undefined && draft.trim() !== String(it.allocated_for ?? "").trim();
        })
        .map((it) => ({
          ...it,
          allocated_for: drafts[it.uid].trim(),
          last_moved_at: new Date().toISOString(),
          rev: (Number(it.rev) || 0) + 1,
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
              price on what you just assigned.
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
                <th className="px-3 py-2 text-right">Sell Price</th>
              </tr>
            </thead>
            <tbody>
              {list.map((it) => {
                const changed = (drafts[it.uid] ?? "").trim() !== String(it.allocated_for ?? "").trim();
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
                  <td className="px-3 py-4 text-center text-slate-500" colSpan={4}>
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
