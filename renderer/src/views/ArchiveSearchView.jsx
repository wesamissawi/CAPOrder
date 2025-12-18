import React from "react";
import Card from "../components/Card";

export default function ArchiveSearchView({
  searchTerm,
  setSearchTerm,
  bubbleName,
  setBubbleName,
  onSearch,
  searching,
  results,
  error,
  archivePath,
}) {
  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-col gap-3">
          <div>
            <h2 className="text-xl font-semibold text-slate-800">Archive Search</h2>
            <p className="text-sm text-slate-500">
              Search archived bubbles by part number, description, or bubble / customer name. Results load only when you search to keep the archive fast.
            </p>
            {archivePath && (
              <p className="text-xs text-slate-400 mt-1">
                Archive file: {archivePath}
              </p>
            )}
          </div>
          <div className="grid gap-3 md:grid-cols-[2fr,1.4fr,auto] items-end">
            <div className="flex flex-col gap-1">
              <label className="text-xs uppercase tracking-wide text-slate-500">
                Part number / description
              </label>
              <input
                className="rounded-xl border border-slate-200 px-3 py-2 text-sm"
                placeholder="Part number, line code, or description"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs uppercase tracking-wide text-slate-500">
                Bubble or customer (optional)
              </label>
              <input
                className="rounded-xl border border-slate-200 px-3 py-2 text-sm"
                placeholder="Bubble name or customer"
                value={bubbleName}
                onChange={(e) => setBubbleName(e.target.value)}
              />
            </div>
            <button
              className="rounded-xl bg-indigo-600 text-white px-4 py-2 font-semibold shadow hover:bg-indigo-700 disabled:opacity-60"
              onClick={onSearch}
              disabled={searching}
            >
              {searching ? "Searching..." : "Search Archive"}
            </button>
          </div>
          {error && <div className="text-sm text-red-600">{error}</div>}
        </div>
      </Card>

      {results.length === 0 && !error && (
        <Card className="text-sm text-slate-500">
          Enter a search term to find archived items. Nothing is loaded until you search.
        </Card>
      )}

      {results.map((res) => (
        <Card key={`${res.bubbleId}-${res.archivedAt}`} className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="text-lg font-semibold text-slate-800">
                {res.bubbleName || "Archived Bubble"}
              </div>
              <div className="text-xs text-slate-500">
                Archived at: {res.archivedAt || "unknown"}
              </div>
            </div>
            <span className="text-xs px-3 py-1 rounded-full bg-slate-100 text-slate-600 border">
              {res.items?.length ?? 0} matching item(s)
            </span>
          </div>
          <div className="space-y-2">
            {(res.items || []).map((it, idx) => (
              <div
                key={`${res.bubbleId}-${idx}-${it.itemcode || "item"}`}
                className="rounded-xl border border-slate-200 bg-white/80 p-3"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-sm font-semibold text-slate-800">
                    {it.itemcode || "Item"}
                  </div>
                  <div className="text-xs text-slate-500">
                    Qty: {it.quantity ?? "—"}
                  </div>
                </div>
                {it.description && (
                  <div className="text-sm text-slate-600">{it.description}</div>
                )}
                {it.notes2 && (
                  <div className="text-xs text-slate-500">Notes: {it.notes2}</div>
                )}
                <div className="text-xs text-slate-500 mt-1">
                  {it.reference_num ? `Ref: ${it.reference_num} · ` : ""}
                  {it.allocated_for ? `Price: ${it.allocated_for}` : ""}
                </div>
              </div>
            ))}
          </div>
        </Card>
      ))}
    </div>
  );
}
