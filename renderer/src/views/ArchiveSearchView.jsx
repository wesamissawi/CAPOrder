import React, { useState, useEffect, useRef } from "react";
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

function formatWhen(raw) {
  if (!raw) return "";
  const d = new Date(raw);
  if (!isNaN(d.getTime())) {
    return d.toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }
  return String(raw);
}

// Lifecycle event presentation for the item trace.
const HISTORY_EVENTS = {
  created: { label: "Created", dot: "bg-slate-400" },
  moved: { label: "Moved", dot: "bg-indigo-500" },
  sent_to_sage: { label: "Sent to Sage", dot: "bg-violet-600" },
  sent_to_cashpad: { label: "Sent to CashPad", dot: "bg-emerald-600" },
  returned_to_stock: { label: "Returned to stock", dot: "bg-sky-500" },
  archived: { label: "Archived (sold)", dot: "bg-amber-500" },
  credit_received: { label: "Credit received", dot: "bg-emerald-600" },
  deleted: { label: "Deleted", dot: "bg-red-600" },
};

function historyDetail(h) {
  if (h.event === "created") return h.allocated_to ? `into ${h.allocated_to}` : "";
  // Moves/queue changes: show only the destination, not the origin bubble.
  if (h.to_bubble) return `to ${h.to_bubble}`;
  if (
    (h.event === "deleted" || h.event === "archived" || h.event === "credit_received") &&
    h.allocated_to
  ) {
    return `from ${h.allocated_to}`;
  }
  return "";
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
  onMoveItemToBubble,
  items = [],
  itemHistory = [],
}) {
  const [purging, setPurging] = useState(false);
  const [purgeMsg, setPurgeMsg] = useState("");
  const [lineStatus, setLineStatus] = useState({});
  // Which bubble the two views target. Drives both the direct Add button (add
  // straight to Returns/CashPad — no CashPad detour) and the post-add Move
  // button. "returns" -> RETURNS, "cashpad" -> CASHPAD.
  const [moveTarget, setMoveTarget] = useState("returns");
  const targetName = moveTarget === "returns" ? "RETURNS" : "CASHPAD";
  const targetLabel = moveTarget === "returns" ? "Returns" : "CashPad";
  const targetSpec = {
    allocated_to: targetName,
    accountingPath: moveTarget === "returns" ? "OUTSTANDING" : "CASH_SALE",
  };
  const searchInputRef = useRef(null);

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

  function findActiveItem(order, line) {
    if (!items.length) return null;
    const targetCode = (`${line.partLineCode || ''} ${line.partNumber || ''}`).trim().toUpperCase()
      || (line.partNumber || '').toUpperCase();
    if (!targetCode) return null;
    return (
      items.find(
        (it) =>
          (it.itemcode || '').toUpperCase() === targetCode &&
          (it.reference_num || '') === (order.reference || '')
      ) || null
    );
  }

  // Full lifecycle trace for a line (created / moved / sent to Sage-CashPad /
  // deleted), oldest-first, so a looked-up part shows its whole journey.
  function findItemHistory(order, line) {
    if (!itemHistory.length) return [];
    const targetCode = (`${line.partLineCode || ''} ${line.partNumber || ''}`).trim().toUpperCase()
      || (line.partNumber || '').toUpperCase();
    if (!targetCode) return [];
    return itemHistory
      .filter(
        (h) =>
          (h.itemcode || '').toUpperCase() === targetCode &&
          (h.reference_num || '') === (order.reference || '')
      )
      .sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')));
  }

  async function handleAddLine(order, line, key) {
    setLineStatus((prev) => ({ ...prev, [key]: "adding" }));
    try {
      const res = await onAddLineToCashSales(order, line, targetSpec);
      if (!res?.ok) throw new Error(res?.error || "Failed.");
      setLineStatus((prev) => ({ ...prev, [key]: "added" }));
      // Re-focus + select the search box so the next search just needs typing.
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
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
                ref={searchInputRef}
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
          <div className="flex items-center gap-3 border-t border-slate-100 pt-3">
            <span className="text-xs uppercase tracking-wide text-slate-500">
              Move target
            </span>
            <div className="inline-flex overflow-hidden rounded-xl border border-slate-200">
              <button
                type="button"
                onClick={() => setMoveTarget("returns")}
                className={`px-4 py-1.5 text-xs font-semibold transition-colors ${
                  moveTarget === "returns"
                    ? "bg-indigo-600 text-white"
                    : "bg-white text-slate-600 hover:bg-slate-50"
                }`}
              >
                Returns
              </button>
              <button
                type="button"
                onClick={() => setMoveTarget("cashpad")}
                className={`px-4 py-1.5 text-xs font-semibold transition-colors ${
                  moveTarget === "cashpad"
                    ? "bg-indigo-600 text-white"
                    : "bg-white text-slate-600 hover:bg-slate-50"
                }`}
              >
                CashPad
              </button>
            </div>
            <span className="text-xs text-slate-400">
              Found items move to {moveTarget === "returns" ? "RETURNS" : "CASHPAD"}.
            </span>
          </div>
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
              const trail = findItemHistory(order, line);
              const lastEvt = trail.length ? trail[trail.length - 1] : null;
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
                          const active = findActiveItem(order, line);
                          if (active) {
                            const loc = active.allocated_to || "Unknown";
                            const alreadyThere = String(loc).toUpperCase() === targetName;
                            return (
                              <>
                                <div className="text-xs text-indigo-600 font-medium">📍 {loc}</div>
                                {alreadyThere ? (
                                  <div className="text-[11px] text-slate-400">
                                    Already in {targetLabel}
                                  </div>
                                ) : (
                                  <button
                                    className="rounded-xl px-3 py-1.5 text-xs font-semibold bg-emerald-600 text-white hover:bg-emerald-700"
                                    onClick={async () => {
                                      const ok = await api.confirm(
                                        `Move to ${targetLabel}?`,
                                        `This moves ${active.itemcode || "this item"} from ${loc} to ${targetName}.`
                                      );
                                      if (ok) onMoveItemToBubble?.(active.uid, targetName);
                                    }}
                                  >
                                    Move to {targetLabel}
                                  </button>
                                )}
                              </>
                            );
                          }
                          return (
                            <>
                              {(() => {
                                const removal = {
                                  archived: { text: "📦 Archived (sold)", cls: "text-amber-600" },
                                  credit_received: { text: "💳 Credit received", cls: "text-emerald-600" },
                                  deleted: { text: "🗑️ Deleted", cls: "text-red-600" },
                                }[lastEvt?.event];
                                return removal ? (
                                  <div className="text-right leading-tight">
                                    <div className={`text-xs font-semibold ${removal.cls}`}>
                                      {removal.text}
                                      {lastEvt.at ? ` ${formatDate(lastEvt.at)}` : ""}
                                    </div>
                                    {lastEvt.allocated_to && (
                                      <div className="text-[11px] text-slate-500">
                                        from {lastEvt.allocated_to}
                                      </div>
                                    )}
                                  </div>
                                ) : (
                                  <div className="text-xs text-slate-400">Not in active stock</div>
                                );
                              })()}
                              <button
                                className="rounded-xl px-3 py-1.5 text-xs font-semibold bg-amber-100 text-amber-700 border border-amber-200 hover:bg-amber-200 disabled:opacity-50"
                                disabled={status === "adding"}
                                onClick={async () => {
                                  const ok = await api.confirm(
                                    `Re-add to ${targetLabel}?`,
                                    "Check stock in Sage before re-adding. This item was previously added to active stock."
                                  );
                                  if (ok) handleAddLine(order, line, key);
                                }}
                              >
                                Re-add to {targetLabel}
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
                          : `Add to ${targetLabel}`}
                      </button>
                    )}
                  </div>

                  {trail.length > 0 && (
                    <div className="w-full border-t border-slate-100 pt-2">
                      <div className="flex items-center gap-2 overflow-x-auto pb-1">
                        {trail.map((h, hi) => {
                          const meta = HISTORY_EVENTS[h.event] || {
                            label: h.event || "Event",
                            dot: "bg-slate-400",
                          };
                          const detail = historyDetail(h);
                          return (
                            <React.Fragment key={`${key}-hist-${hi}`}>
                              {hi > 0 && <span className="shrink-0 text-slate-300">→</span>}
                              <div className="flex shrink-0 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2 py-1">
                                <span className={`h-2 w-2 shrink-0 rounded-full ${meta.dot}`} />
                                <div className="leading-tight">
                                  <div className="whitespace-nowrap text-xs font-semibold text-slate-700">
                                    {meta.label}
                                    {detail ? ` ${detail}` : ""}
                                  </div>
                                  <div className="whitespace-nowrap text-[10px] text-slate-400">
                                    {formatWhen(h.at)}
                                  </div>
                                </div>
                              </div>
                            </React.Fragment>
                          );
                        })}
                      </div>
                    </div>
                  )}
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
  onMoveItemToBubble,
  items = [],
  itemHistory = [],
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
          onMoveItemToBubble={onMoveItemToBubble}
          items={items}
          itemHistory={itemHistory}
        />
      )}
    </div>
  );
}
