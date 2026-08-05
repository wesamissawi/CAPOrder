import React, { useCallback, useEffect, useState } from "react";

// Concurrent-edit review.
//
// The replicated store always converges, so the data is never left in two
// states — but reaching agreement means one machine's change was discarded, and
// that change was somebody's work. Two counters selling the same part is the
// case that matters: the store will settle on one bubble, and without this
// panel the other sale would simply not be there, with nobody the wiser.
//
// Only genuine collisions reach here. Ordinary edits, and two people taking
// turns on the same bubble, raise nothing — see the causal test in
// main/crdt/merge.js. So a badge showing up is meant to be worth a look.

function shortMachine(name) {
  return String(name || "").split(".")[0] || "another machine";
}

function when(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return d.toLocaleDateString();
}

// Values can be anything a record field holds — a string, a number, an array of
// payment ids. Render them compactly rather than dumping JSON at someone who is
// trying to decide whether a part got double-sold.
function preview(value) {
  if (value === null || value === undefined || value === "") return "(empty)";
  if (Array.isArray(value)) return value.length ? `${value.length} item(s)` : "(none)";
  if (typeof value === "object") return JSON.stringify(value).slice(0, 60);
  if (typeof value === "boolean") return value ? "yes" : "no";
  return String(value);
}

export default function ConflictReview() {
  const [conflicts, setConflicts] = useState([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await window.api?.readConflicts?.();
      if (res?.ok) setConflicts(res.conflicts || []);
    } catch (e) {
      console.warn("[conflicts] load failed", e);
    }
  }, []);

  useEffect(() => {
    load();
    // Pushed the moment a collision is detected, including one that arrived in
    // another machine's log — waiting for the next poll would mean somebody
    // walks away first.
    const off = window.api?.onConflicts?.((list) => setConflicts(list || []));
    return () => {
      if (typeof off === "function") off();
    };
  }, [load]);

  const dismiss = useCallback(async (id) => {
    setBusy(true);
    try {
      const res = await window.api?.dismissConflict?.(id);
      if (res?.ok) setConflicts(res.conflicts || []);
    } finally {
      setBusy(false);
    }
  }, []);

  const dismissAll = useCallback(async () => {
    setBusy(true);
    try {
      const res = await window.api?.dismissAllConflicts?.();
      if (res?.ok) setConflicts(res.conflicts || []);
    } finally {
      setBusy(false);
    }
  }, []);

  if (!conflicts.length) return null;

  return (
    <div className="fixed bottom-4 right-4 z-[4000] flex flex-col items-end gap-2">
      {open && (
        <div className="w-[26rem] max-h-[60vh] overflow-auto bg-white rounded-2xl shadow-2xl border border-amber-200">
          <div className="sticky top-0 bg-amber-50 border-b border-amber-200 px-4 py-3 flex items-start justify-between gap-3">
            <div>
              <div className="font-semibold text-amber-900 text-sm">Edited on two machines at once</div>
              <p className="text-xs text-amber-700 mt-0.5">
                Both machines now agree on the value shown as <b>kept</b>. Check whether the
                other change still needs doing.
              </p>
            </div>
            <button
              className="text-amber-700 hover:text-amber-900 text-lg leading-none"
              onClick={() => setOpen(false)}
              aria-label="Close"
            >
              ×
            </button>
          </div>

          <div className="divide-y divide-slate-100">
            {conflicts.map((c) => (
              <div key={c.id} className="px-4 py-3 text-sm">
                <div className="flex items-baseline justify-between gap-2">
                  <div className="font-semibold text-slate-800">{c.subject || c.key}</div>
                  <div className="text-[10px] uppercase tracking-wide text-slate-400">{when(c.at)}</div>
                </div>
                <div className="text-xs text-slate-500 mb-2">{c.fieldLabel} changed on both</div>

                <div className="rounded-xl bg-slate-50 border border-slate-200 divide-y divide-slate-200">
                  <div className="px-3 py-2 flex items-center justify-between gap-2">
                    <div>
                      <div className="text-[10px] uppercase tracking-wide text-emerald-700">kept</div>
                      <div className="font-medium text-slate-800">{preview(c.winner?.value)}</div>
                    </div>
                    <div className="text-xs text-slate-400">{shortMachine(c.winner?.machine)}</div>
                  </div>
                  <div className="px-3 py-2 flex items-center justify-between gap-2">
                    <div>
                      <div className="text-[10px] uppercase tracking-wide text-rose-600">discarded</div>
                      <div className="font-medium text-slate-600 line-through">{preview(c.loser?.value)}</div>
                    </div>
                    <div className="text-xs text-slate-400">{shortMachine(c.loser?.machine)}</div>
                  </div>
                </div>

                <div className="mt-2 flex justify-end">
                  <button
                    className="text-xs px-3 py-1 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 disabled:opacity-50"
                    onClick={() => dismiss(c.id)}
                    disabled={busy}
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            ))}
          </div>

          <div className="sticky bottom-0 bg-white border-t border-slate-200 px-4 py-2 flex justify-end">
            <button
              className="text-xs px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-white disabled:opacity-50"
              onClick={dismissAll}
              disabled={busy}
            >
              Dismiss all
            </button>
          </div>
        </div>
      )}

      <button
        className="rounded-full shadow-lg bg-amber-500 hover:bg-amber-600 text-white px-4 py-2 text-sm font-semibold flex items-center gap-2"
        onClick={() => setOpen((v) => !v)}
      >
        <span>⚠</span>
        <span>
          {conflicts.length} concurrent {conflicts.length === 1 ? "edit" : "edits"}
        </span>
      </button>
    </div>
  );
}
