import React, { useState, useEffect } from "react";
import Card from "../components/Card";
import api from "../api";

function formatDate(raw) {
  if (!raw) return null;
  const d = new Date(raw);
  if (!isNaN(d.getTime())) {
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }
  return raw;
}

function PurchasesSearch({
  searchTerm,
  setSearchTerm,
  onSearch,
  searching,
  results,
  error,
  onPurge,
  onAddLineToCashSales,
  items = [],
}) {
  const [purging, setPurging] = useState(false);
  const [purgeMsg, setPurgeMsg] = useState("");
  const [lineStatus, setLineStatus] = useState({});

  useEffect(() => {
    const initial = {};
    results.forEach((order, oi) => {
      order.lines.forEach((line, li) => {
        if (line.addedToOutstanding) initial[`${oi}-${li}`] = "added";
      });
    });
    setLineStatus(initial);
  }, [results]);

  const handleKey = (e) => { if (e.key === "Enter") onSearch(); };

  function findItemLocation(order, line) {
    if (!items.length) return null;
    const targetCode = (`${line.partLineCode || ''} ${line.partNumber || ''}`).trim().toUpperCase()
      || (line.partNumber || '').toUpperCase();
    if (!targetCode) return null;
    const match = items.find(
      (it) =>
        (it.itemcode || '').toUpperCase() === targetCode &&
        (it.reference_num || '') === (order.reference || '')
    );
    return match ? (match.allocated_to || 'Unknown') : null;
  }

  async function handleAddLine(order, line, key) {
    setLineStatus((prev) => ({ ...prev, [key]: "adding" }));
    try {
      const res = await onAddLineToCashSales(order, line);
      if (!res?.ok) throw new Error(res?.error || "Failed.");
      setLineStatus((prev) => ({ ...prev, [key]: "added" }));
    } catch (e) {
      setLineStatus((prev) => ({ ...prev, [key]: "error:" + (e?.message || "Failed") }));
    }
  }

  async function handlePurge() {
    const ok = await api.confirm(
      "Delete all archived orders 90 days or older?",
      "This cannot be undone."
    );
    if (!ok) return;
    try {
      setPurging(true);
      setPurgeMsg("");
      const res = await onPurge();
      if (!res?.ok) throw new Error(res?.error || "Purge failed.");
      setPurgeMsg(`Deleted ${res.removed} order${res.removed !== 1 ? "s" : ""}. ${res.remaining} remaining.`);
    } catch (e) {
      setPurgeMsg(e?.message || "Failed to purge.");
    } finally {
      setPurging(false);
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-col gap-3">
          <div>
            <h2 className="text-xl font-semibold text-slate-800">Search Purchases</h2>
            <p className="text-sm text-slate-500">
              Search archived orders by part number. Partial matches supported.
            </p>
          </div>
          <div className="flex gap-3 items-end">
            <div className="flex flex-col gap-1 flex-1">
              <label className="text-xs uppercase tracking-wide text-slate-500">
                Part number
              </label>
              <input
                className="rounded-xl border border-slate-200 px-3 py-2 text-sm"
                placeholder="e.g. RDA540 or NAPA 540"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                onKeyDown={handleKey}
              />
            </div>
            <button
              className="rounded-xl bg-indigo-600 text-white px-4 py-2 font-semibold shadow hover:bg-indigo-700 disabled:opacity-60"
              onClick={onSearch}
              disabled={searching}
            >
              {searching ? "Searching..." : "Search"}
            </button>
          </div>
          {error && <div className="text-sm text-red-600">{error}</div>}
          <div className="border-t border-slate-100 pt-3 flex items-center gap-3">
            <button
              className="rounded-xl bg-red-600 text-white px-4 py-2 text-sm font-semibold shadow hover:bg-red-700 disabled:opacity-60"
              onClick={handlePurge}
              disabled={purging}
            >
              {purging ? "Deleting..." : "Delete 90-Day-Old Orders"}
            </button>
            {purgeMsg && <span className="text-sm text-slate-600">{purgeMsg}</span>}
          </div>
        </div>
      </Card>

      {results.length === 0 && !error && (
        <Card className="text-sm text-slate-500">
          Enter a part number to search purchased orders.
        </Card>
      )}

      {results.map((order, oi) => (
        <Card key={`${order.reference}-${oi}`} className="space-y-3">
          {/* Order header */}
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex flex-wrap gap-4 items-center">
              {order.warehouse && (
                <div>
                  <div className="text-xs uppercase tracking-wide text-slate-400 leading-none mb-0.5">Warehouse</div>
                  <div className="text-2xl font-bold text-slate-800">{order.warehouse}</div>
                </div>
              )}
              {order.invoice && (
                <div>
                  <div className="text-xs uppercase tracking-wide text-slate-400 leading-none mb-0.5">Invoice</div>
                  <div className="text-xl font-bold text-indigo-700">{order.invoice}</div>
                </div>
              )}
              {order.date && (
                <div>
                  <div className="text-xs uppercase tracking-wide text-slate-400 leading-none mb-0.5">Date</div>
                  <div className="text-base font-semibold text-slate-800">{formatDate(order.date)}</div>
                </div>
              )}
            </div>
            <div className="flex flex-col items-end gap-1">
              <span className="text-xs px-3 py-1 rounded-full bg-slate-100 text-slate-600 border capitalize">
                {order.source || order.reference}
              </span>
            </div>
          </div>

          {/* Line items */}
          <div className="space-y-2">
            {order.lines.map((line, li) => {
              const key = `${oi}-${li}`;
              const status = lineStatus[key];
              return (
                <div
                  key={`${order.reference}-${li}-${line.partNumber}`}
                  className="rounded-xl border border-slate-200 bg-white/80 p-3 flex flex-wrap items-center justify-between gap-3"
                >
                  <div className="flex flex-col gap-0.5">
                    <div className="text-base font-bold text-slate-900 tracking-wide">
                      {line.itemcode || line.partNumber || "Part"}
                    </div>
                    {line.partDescription && (
                      <div className="text-sm text-slate-500">{line.partDescription}</div>
                    )}
                  </div>
                  <div className="flex gap-5 items-center">
                    {line.quantity != null && (
                      <div className="text-center">
                        <div className="text-xs uppercase tracking-wide text-slate-400 leading-none mb-0.5">Qty</div>
                        <div className="text-sm font-semibold text-slate-700">{line.quantity}</div>
                      </div>
                    )}
                    {line.costPrice && (
                      <div className="text-center">
                        <div className="text-xs uppercase tracking-wide text-slate-400 leading-none mb-0.5">Price</div>
                        <div className="text-lg font-bold text-slate-900">{line.costPrice}</div>
                      </div>
                    )}
                    {status === "added" ? (
                      <div className="flex flex-col items-end gap-1.5 min-w-[110px]">
                        <div className="text-xs font-semibold text-green-700">Added ✓</div>
                        {(() => {
                          const loc = findItemLocation(order, line);
                          if (loc) {
                            return <div className="text-xs text-indigo-600 font-medium">📍 {loc}</div>;
                          }
                          return (
                            <>
                              <div className="text-xs text-slate-400">Not in active stock</div>
                              <button
                                className="rounded-xl px-3 py-1.5 text-xs font-semibold bg-amber-100 text-amber-700 border border-amber-200 hover:bg-amber-200 disabled:opacity-50"
                                disabled={status === "adding"}
                                onClick={async () => {
                                  const ok = await api.confirm(
                                    "Re-add to CashPad?",
                                    "Check stock in Sage before re-adding. This item was previously added to CashPad."
                                  );
                                  if (ok) handleAddLine(order, line, key);
                                }}
                              >
                                Re-add to CashPad
                              </button>
                            </>
                          );
                        })()}
                      </div>
                    ) : (
                      <button
                        className={`rounded-xl px-3 py-1.5 text-xs font-semibold transition-colors ${
                          status === "adding"
                            ? "bg-slate-100 text-slate-400 cursor-wait"
                            : status?.startsWith("error:")
                            ? "bg-red-100 text-red-600 border border-red-200"
                            : "bg-indigo-600 text-white hover:bg-indigo-700"
                        }`}
                        disabled={status === "adding"}
                        onClick={() => handleAddLine(order, line, key)}
                      >
                        {status === "adding"
                          ? "Adding..."
                          : status?.startsWith("error:")
                          ? "Retry"
                          : "Add to CashPad"}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      ))}
    </div>
  );
}

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
  purchasesSearchTerm,
  setPurchasesSearchTerm,
  onPurchasesSearch,
  purchasesSearching,
  purchasesResults,
  purchasesError,
  onPurgeOldOrders,
  onAddLineToCashSales,
  items = [],
}) {
  const [tab, setTab] = useState("purchases");

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        <button
          onClick={() => setTab("purchases")}
          className={`px-4 py-2 rounded-xl text-sm font-semibold transition-colors ${
            tab === "purchases"
              ? "bg-indigo-600 text-white shadow"
              : "bg-white border border-slate-200 text-slate-600 hover:bg-slate-50"
          }`}
        >
          Search Purchases
        </button>
        <button
          onClick={() => setTab("sales")}
          className={`px-4 py-2 rounded-xl text-sm font-semibold transition-colors ${
            tab === "sales"
              ? "bg-indigo-600 text-white shadow"
              : "bg-white border border-slate-200 text-slate-600 hover:bg-slate-50"
          }`}
        >
          Search Sales
        </button>
      </div>

      {tab === "sales" && (
        <div className="space-y-4">
          <Card>
            <div className="flex flex-col gap-3">
              <div>
                <h2 className="text-xl font-semibold text-slate-800">Search Sales</h2>
                <p className="text-sm text-slate-500">
                  Search archived bubbles by part number, description, or bubble / customer name.
                </p>
                {archivePath && (
                  <p className="text-xs text-slate-400 mt-1">Archive file: {archivePath}</p>
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
      )}

      {tab === "purchases" && (
        <PurchasesSearch
          searchTerm={purchasesSearchTerm}
          setSearchTerm={setPurchasesSearchTerm}
          onSearch={onPurchasesSearch}
          searching={purchasesSearching}
          results={purchasesResults}
          error={purchasesError}
          onPurge={onPurgeOldOrders}
          onAddLineToCashSales={onAddLineToCashSales}
          items={items}
        />
      )}
    </div>
  );
}
