import React, { useState, useEffect, useRef } from "react";
import Card from "../components/Card";
import InvoicePreview from "../components/InvoicePreview";
import api from "../api";

// Snapshots are stored flattened (itemcode/description/quantity/price) rather
// than as raw item records, so a stored copy stays readable on its own and
// can't be confused with a live item. InvoicePreview still reads the live item
// field names, so map back on the way in — the alternative, storing dead item
// fields forever just to skip six lines here, ages badly.
function snapshotItemsForPreview(snapshot) {
  return (snapshot?.items || []).map((it, idx) => ({
    uid: it.uid || `snap-${idx}`,
    itemcode: it.itemcode,
    notes1: it.description,
    quantity: it.quantity,
    allocated_for: it.price,
  }));
}

// Replays a printed Sales Order exactly as it went out: the lines, prices,
// letterhead and tax rate all come from the snapshot, never from today's items
// or today's defaults. Read-only on purpose — this is a record, not a document
// you can edit and reprint.
function PrintedCopyModal({ snapshots, bubbleName, onClose }) {
  const [index, setIndex] = useState(0);
  const snapshot = snapshots?.[index] || null;
  if (!snapshot) return null;

  const doc = snapshot.document || {};
  // Rows written before quotes existed carry no `kind` — they're all sales
  // orders, so the absence of the field has to read as SALES_ORDER.
  const isQuote = snapshot.kind === "QUOTE";

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4 overflow-auto">
      <div className="w-full max-w-4xl rounded-2xl bg-white shadow-2xl">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 p-4">
          <div>
            <div className="text-lg font-semibold text-slate-800">
              {isQuote
                ? "Printed copy — Quotation"
                : `Printed copy — Sales Order ${snapshot.salesOrderNumber || "—"}`}
            </div>
            <div className="text-xs text-slate-500">
              {bubbleName ? `${bubbleName} · ` : ""}
              Printed {formatWhen(snapshot.printedAt) || snapshot.printedAt || "unknown"}
              {snapshots.length > 1 ? ` · version ${snapshot.version ?? index + 1}` : ""}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {snapshots.length > 1 && (
              <select
                className="rounded-lg border border-slate-200 px-2 py-1 text-xs"
                value={index}
                onChange={(e) => setIndex(Number(e.target.value))}
              >
                {snapshots.map((s, i) => (
                  <option key={s.id || i} value={i}>
                    v{s.version ?? i + 1} — {formatWhen(s.printedAt) || s.printedAt}
                  </option>
                ))}
              </select>
            )}
            <button
              onClick={onClose}
              className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-semibold text-slate-600 hover:bg-slate-50"
            >
              Close
            </button>
          </div>
        </div>

        {snapshots.length > 1 && index > 0 && (
          <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800">
            This order was printed more than once. Earlier versions are still listed above —
            the customer may be holding any of them.
          </div>
        )}

        <div className="p-4">
          <InvoicePreview
            bubbleName={snapshot.bubbleName}
            bubbleNotes={snapshot.notes}
            items={snapshotItemsForPreview(snapshot)}
            extraLines={snapshot.extraLines || []}
            generatedDate={snapshot.printedAt ? new Date(snapshot.printedAt) : new Date()}
            salesOrderNumber={snapshot.salesOrderNumber}
            variant={isQuote ? "quote" : "salesOrder"}
            discount={isQuote ? Number(snapshot.discount) || 0 : 0}
            documentTitle={doc.title || undefined}
            companyName={doc.companyName || undefined}
            companyAddress={doc.companyAddress || undefined}
            companyContact={doc.companyContact || undefined}
            taxLabel={doc.taxLabel || undefined}
            taxRate={typeof doc.taxRate === "number" ? doc.taxRate : undefined}
          />
        </div>
      </div>
    </div>
  );
}

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

// "Find Anywhere" — the one search that answers "where IS this part", rather
// than "did I buy it" (Search Purchases) or "did I archive it" (Search Sales).
// Its whole point is that a part alive in CashPad reads as not-found in both of
// those, which looks exactly like a lost part.
function FindAnywhere() {
  const [term, setTerm] = useState("");
  const [res, setRes] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function run() {
    const q = term.trim();
    if (!q) return;
    setBusy(true);
    setError("");
    try {
      const out = await api.locatePart(q);
      if (!out?.ok) throw new Error(out?.error || "Lookup failed.");
      setRes(out);
    } catch (e) {
      setError(e?.message || "Lookup failed.");
      setRes(null);
    } finally {
      setBusy(false);
    }
  }

  const Section = ({ title, count, tone, children }) => (
    <Card className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-base font-bold text-slate-800">{title}</span>
        <span className={`rounded-full border px-2 py-0.5 text-[11px] font-bold ${tone}`}>{count}</span>
      </div>
      {children}
    </Card>
  );

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-col gap-3">
          <div>
            <h2 className="text-xl font-semibold text-slate-800">Find Anywhere</h2>
            <p className="text-sm text-slate-500">
              Sweeps every store at once — live stock, the sales archive, purchase orders
              and the full lifecycle log. Part number, description, reference or uid.
            </p>
          </div>
          <div className="flex gap-3 items-end">
            <input
              className="flex-1 rounded-xl border border-slate-200 px-3 py-2 text-sm"
              placeholder="e.g. 661332, PRI C661332, OJ7719, or a description"
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && run()}
            />
            <button
              className="rounded-xl bg-indigo-600 text-white px-4 py-2 font-semibold shadow hover:bg-indigo-700 disabled:opacity-60"
              onClick={run}
              disabled={busy || !term.trim()}
            >
              {busy ? "Looking..." : "Find"}
            </button>
          </div>
          {error && <div className="text-sm text-red-600">{error}</div>}
        </div>
      </Card>

      {res && !res.found && (
        <Card className="text-sm text-slate-500">
          Nothing anywhere matches "{res.term}" — not in stock, not archived, and no purchase
          order has it.
        </Card>
      )}

      {/* A source that failed to read is NOT the same as "the part isn't there",
          so it's called out rather than folded into an empty result. */}
      {res?.unreadable?.length > 0 && (
        <div className="rounded-2xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-800">
          Could not read: {res.unreadable.join(", ")}. Results below may be incomplete.
        </div>
      )}

      {res?.live?.length > 0 && (
        <Section title="In stock right now" count={res.live.length} tone="bg-emerald-100 text-emerald-700 border-emerald-300">
          {res.live.map((it) => (
            <div key={it.uid} className="rounded-xl border border-emerald-200 bg-emerald-50/50 p-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-mono text-base font-bold text-slate-900">{it.itemcode}</span>
                <span className="text-lg font-bold text-emerald-700">📍 {it.bubble}</span>
              </div>
              {it.description && <div className="text-sm text-slate-600">{it.description}</div>}
              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
                <span>{it.queue}</span>
                <span>Qty {it.quantity}</span>
                {it.cost && <span>Cost {it.cost}</span>}
                {it.allocated_for && <span>Sell {it.allocated_for}</span>}
                {it.reference_num && <span>Ref {it.reference_num}</span>}
                {it.warehouse && <span>{it.warehouse}</span>}
                {it.lastMovedAt && <span>Moved {formatWhen(it.lastMovedAt)}</span>}
              </div>
              <div className="mt-1 font-mono text-[10px] text-slate-400">{it.uid}</div>
            </div>
          ))}
        </Section>
      )}

      {res?.archived?.length > 0 && (
        <Section title="Sold / archived" count={res.archived.length} tone="bg-amber-100 text-amber-800 border-amber-300">
          {res.archived.map((it, i) => (
            <div key={`${it.uid}-${i}`} className="rounded-xl border border-slate-200 bg-white p-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-mono text-base font-bold text-slate-900">{it.itemcode}</span>
                <span className="text-sm font-semibold text-amber-700">
                  {it.bubbleName} · {formatDate(it.archivedAt)}
                </span>
              </div>
              {it.description && <div className="text-sm text-slate-600">{it.description}</div>}
              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
                <span>Qty {it.quantity}</span>
                {it.allocated_for && <span>Sold for {it.allocated_for}</span>}
                {it.reference_num && <span>Ref {it.reference_num}</span>}
              </div>
            </div>
          ))}
        </Section>
      )}

      {res?.purchases?.length > 0 && (
        <Section title="Purchased on" count={res.purchases.length} tone="bg-indigo-100 text-indigo-700 border-indigo-300">
          {res.purchases.map((p, i) => (
            <div key={`${p.reference}-${i}`} className="rounded-xl border border-slate-200 bg-white p-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-mono text-base font-bold text-slate-900">{p.line.itemcode}</span>
                <span className="text-sm font-semibold text-indigo-700">
                  {p.reference}
                  {p.list === "archived" ? " (archived order)" : ""}
                </span>
              </div>
              {p.line.description && <div className="text-sm text-slate-600">{p.line.description}</div>}
              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
                {p.warehouse && <span>{p.warehouse}</span>}
                {p.orderDate && <span>{formatDate(p.orderDate)}</span>}
                {p.invoice && <span>Inv {p.invoice}</span>}
                <span>Qty {p.line.quantity}</span>
                {p.line.costPrice && <span>Cost {p.line.costPrice}</span>}
                <span>{p.pickedUp ? "Picked up" : "Not picked up"}</span>
                <span>{p.line.addedToOutstanding ? "Added to stock" : "Never added to stock"}</span>
              </div>
            </div>
          ))}
        </Section>
      )}

      {res?.history?.length > 0 && (
        <Section title="Lifecycle" count={res.history.length} tone="bg-slate-200 text-slate-600 border-slate-300">
          <div className="space-y-1">
            {res.history.map((h, i) => {
              const meta = HISTORY_EVENTS[h.event] || { label: h.event || "Event", dot: "bg-slate-400" };
              const detail = historyDetail(h);
              return (
                <div key={i} className="flex items-center gap-2 text-sm">
                  <span className={`h-2 w-2 shrink-0 rounded-full ${meta.dot}`} />
                  <span className="w-40 shrink-0 text-xs text-slate-400">{formatWhen(h.at)}</span>
                  <span className="font-semibold text-slate-700">{meta.label}</span>
                  <span className="text-slate-500">{detail}</span>
                </div>
              );
            })}
          </div>
        </Section>
      )}
    </div>
  );
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
  const [printedCopy, setPrintedCopy] = useState(null);

  return (
    <div className="space-y-4">
      {printedCopy && (
        <PrintedCopyModal
          snapshots={printedCopy.snapshots}
          bubbleName={printedCopy.bubbleName}
          onClose={() => setPrintedCopy(null)}
        />
      )}
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
        <button
          onClick={() => setTab("anywhere")}
          className={`px-4 py-2 rounded-xl text-sm font-semibold transition-colors ${
            tab === "anywhere"
              ? "bg-indigo-600 text-white shadow"
              : "bg-white border border-slate-200 text-slate-600 hover:bg-slate-50"
          }`}
        >
          Find Anywhere
        </button>
      </div>

      {tab === "anywhere" && <FindAnywhere />}

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
                    {res.salesOrderNumber ? ` · Sales Order ${res.salesOrderNumber}` : ""}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {(res.prints || []).length > 0 && (
                    <button
                      onClick={() =>
                        setPrintedCopy({ snapshots: res.prints, bubbleName: res.bubbleName })
                      }
                      className="rounded-lg border border-indigo-300 bg-indigo-50 px-3 py-1 text-xs font-semibold text-indigo-700 hover:bg-indigo-100"
                      title="Show this order exactly as it was printed for the customer"
                    >
                      View printed copy
                      {res.prints.length > 1 ? ` (${res.prints.length})` : ""}
                    </button>
                  )}
                  <span className="text-xs px-3 py-1 rounded-full bg-slate-100 text-slate-600 border">
                    {res.items?.length ?? 0} matching item(s)
                  </span>
                </div>
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
                    {/* The price the customer's paper actually showed. Called
                        out separately, and highlighted when it disagrees with
                        the archived price, because a line repriced after the
                        print is exactly the case worth noticing. */}
                    {it.printed_price != null && (
                      <div
                        className={`mt-1 inline-flex flex-wrap items-center gap-x-2 rounded-lg border px-2 py-1 text-xs ${
                          Number(it.allocated_for) !== Number(it.printed_price)
                            ? "border-amber-300 bg-amber-50 text-amber-800"
                            : "border-emerald-200 bg-emerald-50 text-emerald-700"
                        }`}
                      >
                        <span className="font-semibold">
                          Printed at ${Number(it.printed_price).toFixed(2)}
                        </span>
                        {it.printed_quantity != null && <span>Qty {it.printed_quantity}</span>}
                        {it.printed_sales_order && <span>SO {it.printed_sales_order}</span>}
                        {it.printed_at && <span>{formatWhen(it.printed_at) || it.printed_at}</span>}
                        {Number(it.allocated_for) !== Number(it.printed_price) && (
                          <span className="font-semibold">— repriced after printing</span>
                        )}
                      </div>
                    )}
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
