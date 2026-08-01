// Order Assignment — "where did the parts from this purchase actually go?"
//
// Order Management tracks the PURCHASE (did it reach Sage, is it picked up).
// This view tracks what happened to the physical parts afterwards: which line
// went to a customer, to the shelf, to returns, or nowhere yet.
//
// Read-only for now. All the linking and CAP-code resolution happens in the
// main process (main/domain/orderAssignment.domain.js) — the renderer can't
// resolve item codes, and the linkage between a stock row and the order line it
// came from is a guess for any item created before the order_line_idx stamp
// existed. The "match quality" strip at the top reports how much of what you're
// looking at was guessed, so the numbers can be trusted or distrusted knowingly.
import React, { useCallback, useEffect, useMemo, useState } from "react";
import Card from "../components/Card";
import StopAssignModal from "../components/StopAssignModal";
import api from "../api";

const money = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? `$${n.toFixed(2)}` : "";
};

const fmtDate = (iso, raw) => {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return raw || "Date unknown";
  return new Date(t).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
};

const DESC_LIMIT = 30;
const truncate = (s, n = DESC_LIMIT) => {
  const v = String(s || "").trim();
  return v.length > n ? `${v.slice(0, n)}…` : v;
};

// Per-line colour language. Orange = partially assigned is the one the whole
// view is built around, so it's the loudest.
const LINE_STYLES = {
  unassigned: {
    row: "bg-white border-slate-200",
    label: "Unassigned",
    chip: "bg-slate-100 text-slate-600 border-slate-200",
  },
  staged: {
    row: "bg-slate-50 border-slate-300",
    label: "In New Stock",
    chip: "bg-slate-200 text-slate-700 border-slate-300",
  },
  partial: {
    row: "bg-orange-50 border-orange-300 shadow-[0_0_0_1px_rgba(249,115,22,0.25)]",
    label: "Partial",
    chip: "bg-orange-100 text-orange-800 border-orange-300",
  },
  assigned: {
    row: "bg-emerald-50 border-emerald-300",
    label: "Assigned",
    chip: "bg-emerald-100 text-emerald-800 border-emerald-300",
  },
  over: {
    row: "bg-rose-50 border-rose-300",
    label: "Over-assigned",
    chip: "bg-rose-100 text-rose-800 border-rose-300",
  },
};

// Destination chips are colour-coded by what KIND of place the part went to, so
// "returns" and "a customer" are distinguishable at a glance across a long list.
const DEST_STYLES = {
  returns: "bg-amber-100 text-amber-900 border-amber-300",
  shelf: "bg-sky-100 text-sky-900 border-sky-300",
  cash: "bg-violet-100 text-violet-900 border-violet-300",
  sage: "bg-indigo-100 text-indigo-900 border-indigo-300",
  customer: "bg-blue-100 text-blue-900 border-blue-300",
  staging: "bg-slate-100 text-slate-600 border-slate-300",
};

const EMPTY_ORDERS = [];

const FILTERS = [
  { id: "all", label: "All" },
  { id: "needs", label: "Needs attention" },
  { id: "unassigned", label: "Unassigned" },
  { id: "partial", label: "Partial" },
  { id: "assigned", label: "Assigned" },
];

function StatPill({ label, value }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white/80 px-3 py-2">
      <div className="text-lg font-bold text-slate-800 leading-none">{value}</div>
      <div className="text-[11px] uppercase tracking-wide text-slate-500 mt-1">{label}</div>
    </div>
  );
}

// Part descriptions run long (full application text from the supplier), so the
// line shows a 30-char preview. The native `title` tooltip is slow to appear and
// easy to miss, so this renders its own on hover — instant, and readable at the
// full description length.
function DescriptionWithTooltip({ text }) {
  return (
    <div className="relative group/desc">
      <div className="text-[11px] text-slate-500 leading-tight truncate">{truncate(text)}</div>
      <div
        role="tooltip"
        className="pointer-events-none absolute left-0 top-full z-50 mt-1 hidden w-max max-w-[18rem] whitespace-normal break-words rounded-lg bg-slate-900 px-2 py-1 text-[11px] leading-snug text-white shadow-xl group-hover/desc:block"
      >
        {text}
      </div>
    </div>
  );
}

// Shown only when a destination is armed and this line still has more than one
// unit left. A plain click on the row already assigns everything remaining, so
// this exists purely for PARTIAL amounts: quick buttons for 1 up to (remaining
// - 1), capped at 5 so the row never gets crowded, plus a typed field for
// anything past that. Replaces "click N times to reach the amount you meant" —
// which is exactly how an extra click silently over-assigns — with picking the
// number once.
function QtyPicker({ remainingQty, onPick }) {
  const [custom, setCustom] = useState("");
  if (remainingQty <= 1) return null;

  const quick = Array.from({ length: Math.min(remainingQty - 1, 5) }, (_, i) => i + 1);

  const submitCustom = () => {
    const n = Math.floor(Number(custom));
    if (Number.isInteger(n) && n > 0) onPick(Math.min(n, remainingQty));
    setCustom("");
  };

  return (
    // stopPropagation: without it, clicking anywhere here — a button, or just
    // focusing the input — would bubble up to the row's own click handler and
    // ALSO assign the full remainder on top of whatever was picked here.
    <div onClick={(e) => e.stopPropagation()} className="flex items-center gap-1">
      <span className="text-[10px] font-semibold text-indigo-500">assign</span>
      {quick.map((n) => (
        <button
          key={n}
          onClick={() => onPick(n)}
          title={`Assign ${n} of ${remainingQty} left`}
          className="rounded-md border border-indigo-200 bg-white px-1.5 py-0.5 text-[10px] font-bold text-indigo-700 hover:bg-indigo-50"
        >
          {n}
        </button>
      ))}
      <input
        type="number"
        min={1}
        max={remainingQty}
        value={custom}
        onChange={(e) => setCustom(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submitCustom();
        }}
        placeholder="qty"
        title={`Type an exact amount (up to ${remainingQty}) and press Enter`}
        className="w-11 rounded-md border border-indigo-200 px-1 py-0.5 text-[10px] text-center"
      />
    </div>
  );
}

function LineRow({ line, activeDest, orderResolved, onAssign, onUnassign, busy }) {
  const style = LINE_STYLES[line.state] || LINE_STYLES.unassigned;
  const showCount = line.orderedQty > 0;
  // A line is a click target only while a destination is armed, there's
  // something left to give, and the order it belongs to isn't marked done —
  // otherwise a stray click on a resolved (but still visible, via "Show
  // resolved") order would silently reactivate it.
  const armed = Boolean(activeDest) && line.remainingQty > 0 && !orderResolved;

  const handleClick = (e) => {
    if (!armed || busy) return;
    // Default takes EVERYTHING left on the line — the common case, and safe by
    // construction: once nothing remains the row stops being a click target, so
    // there's no click count to lose track of. Shift-click nudges by exactly
    // one for careful, one-at-a-time control; anything in between goes through
    // QtyPicker below instead of "click it N times and hope."
    onAssign(line.idx, e.shiftKey ? 1 : line.remainingQty);
  };

  return (
    <div
      onClick={handleClick}
      title={
        armed
          ? `Click to assign all ${line.remainingQty} to ${activeDest} · shift-click to add 1`
          : undefined
      }
      className={`rounded-xl border px-2.5 py-1.5 ${style.row} ${
        armed
          ? "cursor-pointer hover:ring-2 hover:ring-indigo-400 hover:border-indigo-400"
          : activeDest
            ? "opacity-60"
            : ""
      } ${busy ? "pointer-events-none" : ""}`}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="font-mono text-sm font-semibold text-slate-800 leading-tight truncate">
            {[line.partLineCode, line.partNumber].filter(Boolean).join(" ")}
          </div>
          {line.description && <DescriptionWithTooltip text={line.description} />}
        </div>

        <span className="text-[11px] text-slate-400 tabular-nums shrink-0">{money(line.cost)}</span>
      </div>

      {/* Counts and destinations get their own wrapping row so a narrow card
          never squeezes the part number. */}
      <div className="mt-1 flex flex-wrap items-center gap-1">
        {showCount && (
          <span className={`rounded-md border px-1.5 py-0.5 text-[11px] font-bold whitespace-nowrap ${style.chip}`}>
            {line.assignedQty} of {line.orderedQty} assigned
          </span>
        )}

        {line.stagedQty > 0 && (
          <span className="rounded-md border px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap bg-slate-100 text-slate-600 border-slate-300">
            {line.stagedQty} in New Stock
          </span>
        )}

        {line.destinations.map((d) => (
          <button
            key={d.name}
            onClick={(e) => {
              e.stopPropagation();
              onUnassign(line.idx, d.name);
            }}
            className={`rounded-md border px-1.5 py-0.5 text-[11px] font-semibold whitespace-nowrap max-w-full truncate hover:line-through ${
              DEST_STYLES[d.kind] || DEST_STYLES.customer
            }`}
            // A historical destination came from the ledger, not a live stock
            // row — the bubble it lived in has since been archived away.
            title={
              d.historical
                ? "Recorded in the assignment ledger (archived out of live stock) — click to clear"
                : `Click to send these ${d.qty} back to New Stock`
            }
          >
            {d.name} ×{d.qty}
            {d.historical ? " ·" : ""}
          </button>
        ))}
      </div>

      {armed && line.remainingQty > 1 && (
        <div className="mt-1">
          <QtyPicker remainingQty={line.remainingQty} onPick={(n) => onAssign(line.idx, n)} />
        </div>
      )}
    </div>
  );
}

function OrderCard({ order, onToggleResolved, activeDest, onAssign, onUnassign, busy }) {
  const stateTone =
    order.state === "assigned"
      ? "border-emerald-300"
      : order.state === "partial"
        ? "border-orange-300"
        : "border-indigo-100";

  return (
    // `relative hover:z-20`: Card sets backdrop-blur, which makes every card its
    // own stacking context painted in DOM order. Without lifting the hovered one
    // a description tooltip that overflows onto the next card would render
    // behind it.
    <Card
      className={`${stateTone} ${
        order.resolved ? "opacity-50" : ""
      } relative hover:z-20 h-full flex flex-col`}
    >
      <div className="min-w-0">
        {/* Warehouse leads and dominates: when you're working a stack of
            invoices you're finding the supplier first, not the number. */}
        <div className="flex items-baseline gap-1.5 min-w-0">
          <span className="text-xl font-bold text-slate-800 truncate">
            {order.warehouse || order.source || "—"}
          </span>
          <span className="text-sm font-normal text-slate-500 truncate shrink-0">
            · {order.reference || order.orderKey || "No reference"}
          </span>
        </div>

        <div className="flex items-baseline justify-between gap-2">
          <span className="text-base font-bold text-slate-600">
            {fmtDate(order.orderDate, order.orderDateRaw)}
          </span>
          {order.total != null && (
            <span className="text-sm font-bold text-slate-700 tabular-nums shrink-0">
              {money(order.total)}
            </span>
          )}
        </div>

        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px]">
          <span className="font-semibold text-slate-600">
            {order.assignedLineCount} / {order.lineCount} lines assigned
          </span>
          {order.sageReference && order.sageReference !== order.reference && (
            <span className="font-mono text-slate-400">inv {order.sageReference}</span>
          )}
          {order.archived && (
            <span className="px-1.5 py-0.5 rounded-full bg-slate-50 text-slate-500 border border-slate-200">
              Archived
            </span>
          )}
          {order.isCredit && (
            <span className="px-1.5 py-0.5 rounded-full bg-rose-50 text-rose-600 border border-rose-200">
              Credit
            </span>
          )}
          {order.enteredInSage && (
            <span className="px-1.5 py-0.5 rounded-full bg-emerald-50 text-emerald-600 border border-emerald-200">
              Sage
            </span>
          )}

          {/* Whole-order resolve — hides it from this view once you're done
              with it (tick "Show resolved" above to bring it back). Lives at
              the order level, not per line: one purchase is one thing to deal
              with, and clearing 20 lines individually was never the point. */}
          <button
            onClick={() => onToggleResolved(!order.resolved)}
            className={`ml-auto px-1.5 py-0.5 rounded-full border font-semibold transition ${
              order.resolved
                ? "bg-slate-200 text-slate-600 border-slate-300 hover:bg-slate-300"
                : "bg-white text-slate-500 border-slate-300 hover:bg-slate-100"
            }`}
            title={order.resolved ? "Show this order again" : "Hide this order — it's dealt with"}
          >
            {order.resolved ? "Undo" : "Resolve"}
          </button>
        </div>
      </div>

      {/* flex-1 makes the line list absorb the extra height a stretched card
          gets, so the spare space lands below the lines rather than being
          spread between the header and the body. */}
      <div className="mt-3 space-y-1.5 flex-1">
        {order.lines.length === 0 && (
          <div className="px-3 py-2 text-sm text-slate-400 italic">This order has no line items.</div>
        )}
        {order.lines.map((line) => (
          <LineRow
            key={line.lineKey}
            line={line}
            activeDest={activeDest}
            orderResolved={order.resolved}
            onAssign={onAssign}
            onUnassign={onUnassign}
            busy={busy}
          />
        ))}

        {order.diagnostics.orphanCount > 0 && (
          // Stock rows that carry this order's reference but couldn't be tied
          // to any line. Usually a duplicate add or a part whose code was
          // edited after purchase. Shown rather than hidden because a silent
          // drop here is what would make the counts above quietly wrong.
          <div className="mt-2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2">
            <div className="text-[11px] font-bold uppercase tracking-wide text-amber-800">
              {order.diagnostics.orphanCount} stock row
              {order.diagnostics.orphanCount === 1 ? "" : "s"} tagged to this order but not matched to a line
            </div>
            <div className="mt-1 flex flex-wrap gap-1">
              {order.diagnostics.orphans.map((o) => (
                <span
                  key={o.uid}
                  className="rounded-lg border border-amber-300 bg-white px-2 py-0.5 text-[11px] font-mono text-amber-900"
                >
                  {o.itemcode} ×{o.quantity} → {o.allocated_to}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}

export default function OrderAssignmentView() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const [scope, setScope] = useState("all");
  const [search, setSearch] = useState("");
  const [searchDraft, setSearchDraft] = useState("");
  const [days, setDays] = useState(30);
  const [filter, setFilter] = useState("all");
  const [includeResolved, setIncludeResolved] = useState(false);
  // Credits (money coming back, not parts going out) are noise in a view about
  // where parts went — hidden by default, opt back in with the checkbox.
  const [includeCredits, setIncludeCredits] = useState(false);
  const [bulkDays, setBulkDays] = useState(30);
  const [bulkNote, setBulkNote] = useState("");

  // The armed destination. While this is set, clicking a line moves real stock,
  // so it's shown as a loud persistent banner rather than a subtle mode.
  const [activeDest, setActiveDest] = useState("");
  const [destDraft, setDestDraft] = useState("");
  // Most-recently-armed destination names, front first. A brand-new destination
  // has zero stock rows yet, so it won't appear in the server's `destinations`
  // list until an assignment actually lands one — this is what makes it visible
  // (at the front, per your ask) the instant you use it rather than after a
  // reload, and keeps it at the front on every reuse afterward too.
  const [recentDests, setRecentDests] = useState([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  // Uids assigned to activeDest during the CURRENT armed session — reset each
  // time a destination is armed. Drives the Stop review modal's default view:
  // a busy destination (CashPad routinely holds 100+ parts) shouldn't dump its
  // whole history into review every time you stop.
  const [sessionTouchedUids, setSessionTouchedUids] = useState(() => new Set());
  const [stopReview, setStopReview] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await api.readOrderAssignments({
        scope,
        search,
        days: Number(days) || 0,
        limit: 300,
        includeResolved,
        includeCredits,
      });
      if (!res?.ok) {
        setError(res?.error || "Failed to load order assignments.");
        setData(null);
      } else {
        setData(res);
      }
    } catch (e) {
      setError(e?.message || "Failed to load order assignments.");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [scope, search, days, includeResolved, includeCredits]);

  useEffect(() => {
    load();
  }, [load]);

  // Stable identity when there's no data yet, so the memo below isn't
  // invalidated by a fresh [] on every render.
  const orders = data?.orders || EMPTY_ORDERS;

  const shown = useMemo(() => {
    if (filter === "all") return orders;
    return orders.filter((o) => {
      const lines = o.lines;
      if (filter === "needs") return lines.some((l) => l.state !== "assigned");
      if (filter === "unassigned")
        return lines.some((l) => l.state === "unassigned" || l.state === "staged");
      if (filter === "partial") return lines.some((l) => l.state === "partial");
      if (filter === "assigned") return lines.length > 0 && lines.every((l) => l.state === "assigned");
      return true;
    });
  }, [orders, filter]);

  // Clearing the pre-tracking backlog. Bulk and hard to eyeball afterwards, so
  // it states the exact cutoff and count before doing anything.
  const handleBulkResolve = async () => {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - bulkDays);
    const label = cutoff.toLocaleDateString();
    const ok = await api.confirm(
      `Mark every order placed before ${label} as resolved?`,
      "They'll be hidden from this view (tick \"Show resolved\" to see them again). This only affects what's displayed here — no stock is moved."
    );
    if (!ok) return;
    const res = await api.resolveOrderAssignmentsBefore({ before: cutoff.toISOString() });
    if (!res?.ok) {
      setError(res?.error || "Failed to bulk-resolve orders.");
      return;
    }
    setBulkNote(`Resolved ${res.resolved} order${res.resolved === 1 ? "" : "s"} placed before ${label}.`);
    await load();
  };

  // Single entry point for arming a destination, whether typed fresh or picked
  // from an existing chip — both cases bump it to the front of recentDests and
  // start a fresh "touched this session" set for the Stop review.
  const armDest = (rawName) => {
    const name = String(rawName || "").trim().toUpperCase();
    if (!name) return;
    setActiveDest(name);
    setRecentDests((prev) => [name, ...prev.filter((n) => n !== name)].slice(0, 20));
    setSessionTouchedUids(new Set());
  };

  const handleAssign = async (orderKey, lineIdx, qty) => {
    if (!activeDest || busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await api.assignOrderLine({ orderKey, lineIdx, qty, destination: activeDest });
      if (!res?.ok) {
        setError(res?.error || "Failed to assign.");
        return;
      }
      // The server clamps to what's actually left, so say what really happened
      // rather than what was asked for.
      setNote(
        `Assigned ${res.assigned} to ${res.destination}${
          res.assigned < res.requested ? ` (only ${res.assigned} left on that line)` : ""
        }`
      );
      if (Array.isArray(res.itemUids) && res.itemUids.length) {
        setSessionTouchedUids((prev) => new Set([...prev, ...res.itemUids]));
      }
      await load();
    } finally {
      setBusy(false);
    }
  };

  const handleUnassign = async (orderKey, lineIdx, destination) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await api.unassignOrderLine({ orderKey, lineIdx, destination });
      if (!res?.ok) {
        setError(res?.error || "Failed to unassign.");
        return;
      }
      setNote(`Returned ${res.returned} from ${res.destination} to New Stock`);
      // A part sent back to New Stock is no longer "just added" — drop it so
      // the Stop review doesn't still list something that's been undone.
      if (Array.isArray(res.itemUids) && res.itemUids.length) {
        setSessionTouchedUids((prev) => {
          const next = new Set(prev);
          res.itemUids.forEach((u) => next.delete(u));
          return next;
        });
      }
      await load();
    } finally {
      setBusy(false);
    }
  };

  // Reviewing needs the raw stock rows (to show/edit selling price), which
  // this view doesn't otherwise hold — it talks to the backend only through
  // the order-assignment summary endpoints. api.readItems() is the same live
  // item store Stock Flow uses. Shared by the standalone "Review" button and
  // by Stop, which both need the identical snapshot.
  const loadReviewItems = async () => {
    const allRaw = await api.readItems();
    const destUpper = activeDest;
    const allItems = (Array.isArray(allRaw) ? allRaw : []).filter(
      (it) => String(it?.allocated_to || "").trim().toUpperCase() === destUpper
    );
    const sessionItems = allItems.filter((it) => sessionTouchedUids.has(it.uid));
    return { allItems, sessionItems };
  };

  // Opens the same modal Stop uses, but purely to look at / adjust prices
  // mid-session — confirming here does NOT stop, so you can keep assigning
  // afterward.
  const handleReviewClick = async () => {
    if (!activeDest) return;
    try {
      const { allItems, sessionItems } = await loadReviewItems();
      setStopReview({ destination: activeDest, sessionItems, allItems, andStop: false });
    } catch (e) {
      setError(e?.message || "Failed to load items for review.");
    }
  };

  const handleStopClick = async () => {
    if (!activeDest) return;
    try {
      const { allItems, sessionItems } = await loadReviewItems();
      if (sessionItems.length === 0) {
        // Nothing new to review — just stop.
        finalizeStop();
        return;
      }
      setStopReview({ destination: activeDest, sessionItems, allItems, andStop: true });
    } catch (e) {
      setError(e?.message || "Failed to load items for review.");
    }
  };

  const finalizeStop = () => {
    setActiveDest("");
    setNote("");
    setSessionTouchedUids(new Set());
    setStopReview(null);
  };

  const handleStopReviewConfirm = async (changedItems) => {
    if (changedItems.length) {
      const res = await api.writeItems(changedItems, [], {});
      if (!res?.ok) {
        setError(res?.error || "Failed to save price changes.");
        return;
      }
    }
    if (stopReview?.andStop) {
      finalizeStop();
    } else {
      // Opened via the standalone Review button — stay armed, just report
      // what changed.
      setNote(
        changedItems.length
          ? `Updated selling price on ${changedItems.length} part${changedItems.length === 1 ? "" : "s"}`
          : ""
      );
      setStopReview(null);
    }
  };

  // Whole-order resolve (lineIdx omitted — see order-assignment:set-resolved).
  const handleToggleResolved = async (orderKey, resolved) => {
    const res = await api.setOrderAssignmentResolved({ orderKey, resolved });
    if (!res?.ok) {
      setError(res?.error || "Failed to update the resolved flag.");
      return;
    }
    await load();
  };

  const totals = data?.totals;
  const diag = data?.diagnostics;

  const destinations = data?.destinations || EMPTY_ORDERS;
  // Recently-armed destinations first (in the order you last used them), then
  // everything else alphabetically, exactly as the server already sorts it.
  const orderedDestinations = useMemo(() => {
    const byName = new Map(destinations.map((d) => [d.name, d]));
    const seen = new Set();
    const front = [];
    recentDests.forEach((name) => {
      const d = byName.get(name);
      if (d) {
        front.push(d);
        seen.add(name);
      }
    });
    return [...front, ...destinations.filter((d) => !seen.has(d.name))];
  }, [destinations, recentDests]);

  return (
    <div className="space-y-4 pb-24">
      {/* Sticky so it stays put while you scroll a long list of orders — you
          need to see which destination is armed at the moment you click. */}
      <div className="sticky top-0 z-40 -mx-1 px-1 py-2 bg-gradient-to-b from-white/95 to-white/70 backdrop-blur rounded-2xl">
        {activeDest ? (
          <div className="flex flex-wrap items-center gap-3 rounded-2xl border-2 border-indigo-500 bg-indigo-50 px-4 py-2.5 shadow">
            <span className="text-xs font-bold uppercase tracking-wide text-indigo-500">Assigning to</span>
            <span className="text-lg font-bold text-indigo-900">{activeDest}</span>

            <span className="w-px h-6 bg-indigo-200" />

            <span className="text-xs text-indigo-600">
              Click a line to assign everything left · shift-click to add 1 · use the number buttons for a partial amount
            </span>

            <span className="flex-1" />

            {busy && <span className="text-xs font-semibold text-indigo-600">Working…</span>}

            <button
              onClick={handleReviewClick}
              className="rounded-xl border border-indigo-300 bg-white px-4 py-1.5 text-sm font-semibold text-indigo-700 shadow-sm hover:bg-indigo-50"
              title="See and edit the selling price on what's been assigned, without stopping"
            >
              Review
            </button>

            <button
              onClick={handleStopClick}
              className="rounded-xl bg-rose-600 px-4 py-1.5 text-sm font-bold text-white shadow hover:bg-rose-700"
            >
              Stop
            </button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-2.5 shadow-sm">
            <span className="text-sm font-semibold text-slate-600">Assign parts to</span>
            <input
              value={destDraft}
              onChange={(e) => setDestDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && destDraft.trim()) {
                  armDest(destDraft);
                  setDestDraft("");
                }
              }}
              placeholder="customer / job name…"
              className="w-56 rounded-xl border border-slate-200 px-3 py-1.5 text-sm"
            />
            <button
              onClick={() => {
                if (!destDraft.trim()) return;
                armDest(destDraft);
                setDestDraft("");
              }}
              className="rounded-xl bg-indigo-600 px-4 py-1.5 text-sm font-semibold text-white shadow hover:bg-indigo-700"
            >
              Start
            </button>

            {orderedDestinations.length > 0 && (
              <>
                <span className="w-px h-6 bg-slate-200 mx-1" />
                <span className="text-xs text-slate-400">or pick one:</span>
                <div className="flex flex-wrap items-center gap-1 max-h-16 overflow-y-auto">
                  {orderedDestinations.map((d) => (
                    <button
                      key={d.name}
                      onClick={() => armDest(d.name)}
                      className={`rounded-lg border px-2 py-0.5 text-[11px] font-semibold hover:ring-2 hover:ring-indigo-300 ${
                        DEST_STYLES[d.kind] || DEST_STYLES.customer
                      }`}
                      title={`${d.items} stock row${d.items === 1 ? "" : "s"} currently here`}
                    >
                      {d.name}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {note && (
          <div className="mt-1.5 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-800 flex items-center gap-2">
            {note}
            <button onClick={() => setNote("")} className="ml-auto text-emerald-600 hover:text-emerald-900">
              ✕
            </button>
          </div>
        )}
      </div>

      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <label className="text-[11px] uppercase tracking-wide text-slate-500">Show</label>
            <div className="flex rounded-xl border border-slate-200 overflow-hidden">
              {["all", "active", "archived"].map((s) => (
                <button
                  key={s}
                  onClick={() => setScope(s)}
                  className={`px-3 py-1.5 text-sm font-semibold capitalize transition ${
                    scope === s ? "bg-indigo-600 text-white" : "bg-white text-slate-600 hover:bg-slate-50"
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-[11px] uppercase tracking-wide text-slate-500">Archive window</label>
            <select
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
              className="rounded-xl border border-slate-200 px-3 py-1.5 text-sm"
            >
              <option value={7}>Last 7 days</option>
              <option value={30}>Last 30 days</option>
              <option value={90}>Last 90 days</option>
              <option value={365}>Last year</option>
              <option value={0}>Everything</option>
            </select>
          </div>

          <div className="flex flex-col gap-1 flex-1 min-w-[16rem]">
            <label className="text-[11px] uppercase tracking-wide text-slate-500">Search</label>
            <div className="flex gap-2">
              <input
                value={searchDraft}
                onChange={(e) => setSearchDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") setSearch(searchDraft.trim());
                }}
                placeholder="reference, PO, part number…"
                className="flex-1 rounded-xl border border-slate-200 px-3 py-1.5 text-sm"
              />
              <button
                onClick={() => setSearch(searchDraft.trim())}
                className="rounded-xl bg-slate-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-slate-800"
              >
                Go
              </button>
            </div>
          </div>

          <button
            onClick={load}
            disabled={loading}
            className="rounded-xl bg-indigo-600 px-4 py-1.5 text-sm font-semibold text-white shadow hover:bg-indigo-700 disabled:opacity-50"
          >
            {loading ? "Loading…" : "Refresh"}
          </button>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              className={`rounded-full border px-3 py-1 text-xs font-semibold transition ${
                filter === f.id
                  ? "bg-indigo-600 text-white border-indigo-600"
                  : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50"
              }`}
            >
              {f.label}
            </button>
          ))}

          <span className="w-px h-5 bg-slate-200 mx-1" />

          <label className="flex items-center gap-1.5 text-xs text-slate-600">
            <input
              type="checkbox"
              checked={includeResolved}
              onChange={(e) => setIncludeResolved(e.target.checked)}
            />
            Show resolved
          </label>

          <label className="flex items-center gap-1.5 text-xs text-slate-600">
            <input
              type="checkbox"
              checked={includeCredits}
              onChange={(e) => setIncludeCredits(e.target.checked)}
            />
            Show credits
          </label>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3">
          <span className="text-xs text-slate-500">
            Clear the backlog from before you started tracking:
          </span>
          <span className="text-xs text-slate-600">resolve everything older than</span>
          <select
            value={bulkDays}
            onChange={(e) => setBulkDays(Number(e.target.value))}
            className="rounded-lg border border-slate-200 px-2 py-1 text-xs"
          >
            <option value={7}>7 days</option>
            <option value={14}>14 days</option>
            <option value={30}>30 days</option>
            <option value={60}>60 days</option>
            <option value={90}>90 days</option>
          </select>
          <button
            onClick={handleBulkResolve}
            className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-800 hover:bg-amber-100"
          >
            Mark as resolved
          </button>
          {bulkNote && <span className="text-xs font-semibold text-emerald-700">{bulkNote}</span>}
        </div>
      </Card>

      {error && (
        <div className="rounded-2xl border border-red-300 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">
          {error}
        </div>
      )}

      {totals && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
          <StatPill label="Orders" value={totals.orders} />
          <StatPill label="Lines" value={totals.lines} />
          <StatPill label="Unassigned" value={totals.unassignedLines} />
          <StatPill label="In New Stock" value={totals.stagedLines} />
          <StatPill label="Partial" value={totals.partialLines} />
          <StatPill label="Assigned" value={totals.assignedLines} />
        </div>
      )}

      {diag && (
        // Honest reporting of how the numbers above were derived. `fallback`
        // links are guesses (reference + item code); `stamped` links are exact.
        // Everything created before this feature existed can only ever be a
        // guess, so early on this strip is expected to read mostly-fallback.
        <div className="rounded-2xl border border-slate-200 bg-white/70 px-4 py-2 text-xs text-slate-600 flex flex-wrap items-center gap-x-4 gap-y-1">
          <span className="font-bold uppercase tracking-wide text-slate-500">Match quality</span>
          <span>
            <b className="text-emerald-700">{diag.stampedLinks}</b> exact (stamped)
          </span>
          <span>
            <b className="text-amber-700">{diag.fallbackLinks}</b> matched by code
          </span>
          <span>
            <b className={diag.orphanCount ? "text-rose-700" : "text-slate-500"}>{diag.orphanCount}</b> unmatched
            stock rows
          </span>
          {data?.truncated && (
            <span className="text-slate-500 italic">
              showing {orders.length} of {data.totalMatched} matching orders — narrow the window or search
            </span>
          )}
        </div>
      )}

      {!loading && shown.length === 0 && (
        <Card>
          <div className="text-sm text-slate-500 italic">No orders match these filters.</div>
        </Card>
      )}

      {/* Same grid as Order Management, going one column denser on very wide
          screens since these cards carry less per line. Grid items stretch by
          default, so every card in a row matches the tallest one — combined with
          `h-full flex flex-col` on the card itself, that gives an even bottom
          edge instead of a ragged one. */}
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
        {shown.map((o) => (
          <OrderCard
            key={`${o.orderKey}|${o.reference}|${o.archived}`}
            order={o}
            onToggleResolved={(resolved) => handleToggleResolved(o.orderKey, resolved)}
            activeDest={activeDest}
            onAssign={(lineIdx, qty) => handleAssign(o.orderKey, lineIdx, qty)}
            onUnassign={(lineIdx, dest) => handleUnassign(o.orderKey, lineIdx, dest)}
            busy={busy}
          />
        ))}
      </div>

      {stopReview && (
        <StopAssignModal
          destination={stopReview.destination}
          sessionItems={stopReview.sessionItems}
          allItems={stopReview.allItems}
          title={stopReview.andStop ? "Review before stopping" : "Review & edit prices"}
          confirmLabel={stopReview.andStop ? "Save & Stop" : "Save"}
          defaultShowAll={!stopReview.andStop}
          onCancel={() => setStopReview(null)}
          onConfirm={handleStopReviewConfirm}
        />
      )}
    </div>
  );
}
