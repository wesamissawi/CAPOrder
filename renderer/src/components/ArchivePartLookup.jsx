// "Search Purchases" — find a part in the purchases archive and pull it back
// into active stock.
//
// This lived inside ArchiveSearchView as `PurchasesSearch` until Cash Sales and
// Returns Management wanted the same tool at the top of their own views. The
// only thing that differs between the three mounts is WHERE a found part goes:
//
//   Archive view      — the user picks, RETURNS or CASHPAD (`allowTargetPick`)
//   Cash Sales        — always CASHPAD
//   Returns Mgmt      — always RETURNS
//
// so the target is a prop and the picker is optional. Everything else — the
// code resolution, the lifecycle trace, the re-add confirms — is identical by
// construction rather than by three copies staying in step.
import React, { useState, useEffect, useRef } from "react";
import Card from "./Card";
import api from "../api";

// The two destinations, and the accounting path each one implies. CashPad is
// the cash-sale staging pool, so a part landing there is a cash sale; anything
// else stays on the outstanding (Sage A/R) path. This mirrors the rule
// handleMoveArchiveItemToBubble applies in App.jsx — both sides have to agree
// or a part changes path depending on which button moved it.
export const LOOKUP_TARGETS = {
  returns: { name: "RETURNS", label: "Returns", accountingPath: "OUTSTANDING" },
  cashpad: { name: "CASHPAD", label: "CashPad", accountingPath: "CASH_SALE" },
};

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

export default function ArchivePartLookup({
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
  // Fixed destination for the Cash Sales / Returns mounts. Ignored when
  // `allowTargetPick` is on, which is the archive view's own picker.
  target = "returns",
  allowTargetPick = false,
  // The archive view is the only place that should offer the 90-day purge —
  // it's a destructive maintenance action, not part of looking a part up.
  showPurge = false,
  title = "Search Purchases",
  subtitle = "Search archived orders by part number. Partial matches supported.",
}) {
  const [purging, setPurging] = useState(false);
  const [purgeMsg, setPurgeMsg] = useState("");
  const [lineStatus, setLineStatus] = useState({});
  // Only the picker mount keeps a target in state; a fixed-target mount reads
  // straight off the prop, so it can never drift out of sync with the view
  // it's sitting in.
  const [pickedTarget, setPickedTarget] = useState(target);
  const moveTarget = allowTargetPick ? pickedTarget : target;
  const spec = LOOKUP_TARGETS[moveTarget] || LOOKUP_TARGETS.returns;
  const targetName = spec.name;
  const targetLabel = spec.label;
  const targetSpec = { allocated_to: targetName, accountingPath: spec.accountingPath };
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

  // An archive line and the stock item it became don't necessarily carry the
  // same code: makeOutstandingFromLine resolves every line through the CAP
  // rules first, so for some warehouses the stored itemcode is the Sage code
  // ("TRB BCD1210" -> "BCD 1210" on Transbec). The search hands us that
  // resolved code as line.capCode; the raw form stays as a fallback for items
  // created before the rules were applied.
  function lineCodes(line) {
    const raw = (`${line.partLineCode || ''} ${line.partNumber || ''}`).trim().toUpperCase()
      || (line.partNumber || '').toUpperCase();
    const cap = (line.capCode || '').trim().toUpperCase();
    return [cap, raw].filter(Boolean);
  }

  function codeMatches(record, line) {
    const code = (record?.itemcode || '').toUpperCase();
    return code ? lineCodes(line).includes(code) : false;
  }

  function findActiveItem(order, line) {
    if (!items.length) return null;
    if (!lineCodes(line).length) return null;
    return (
      items.find(
        (it) =>
          codeMatches(it, line) &&
          (it.reference_num || '') === (order.reference || '')
      ) || null
    );
  }

  // Full lifecycle trace for a line (created / moved / sent to Sage-CashPad /
  // deleted), oldest-first, so a looked-up part shows its whole journey.
  function findItemHistory(order, line) {
    if (!itemHistory.length) return [];
    if (!lineCodes(line).length) return [];
    return itemHistory
      .filter(
        (h) =>
          codeMatches(h, line) &&
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
            <h2 className="text-xl font-semibold text-slate-800">{title}</h2>
            <p className="text-sm text-slate-500">{subtitle}</p>
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
          {allowTargetPick ? (
            <div className="flex items-center gap-3 border-t border-slate-100 pt-3">
              <span className="text-xs uppercase tracking-wide text-slate-500">
                Move target
              </span>
              <div className="inline-flex overflow-hidden rounded-xl border border-slate-200">
                <button
                  type="button"
                  onClick={() => setPickedTarget("returns")}
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
                  onClick={() => setPickedTarget("cashpad")}
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
                Found items move to {targetName}.
              </span>
            </div>
          ) : (
            <div className="border-t border-slate-100 pt-3">
              <span className="text-xs text-slate-400">
                Found items move to {targetName}.
              </span>
            </div>
          )}
          {showPurge && (
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
          )}
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
