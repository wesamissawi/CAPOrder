// Sales Order view — "Stock Flow 2": every real customer order in one place,
// regardless of which queue it's actually in (Stock Flow, Sage AR, or Cash
// Sales), styled like Order Assignment but collapsible instead of the
// draggable free-form workspace.
//
// This view does NOT own its data — it's a different lens on the exact same
// bubbles/items/notes that Stock Flow and Cash Sales already render (unlike
// Order Assignment, which is self-contained via its own IPC).
// Editing a note or hitting Print here calls the SAME App.jsx handlers those
// views use, so nothing here is a separate source of truth.
import React, { useEffect, useMemo, useState } from "react";
import Card from "../components/Card";
import DraftInput from "../components/DraftInput";
import api from "../api";
import { computeBubblePrintSignature } from "../utils/inventory";
import {
  CardTotals,
  CashPadPanel,
  ItemRow,
  MOVE_TARGETS,
  computeCardTotals,
  money,
  useItemHistoryByUid,
} from "../components/orderCardKit";

// Holding areas rather than customer orders. CASHPAD has its own docked panel
// and RETURNS has its own view, so only these two need a home here.
const POOL_NAMES = ["NEW STOCK", "SHELF"];

const ACCOUNTING_META = {
  OUTSTANDING: { label: "Stock Flow", cls: "bg-indigo-50 text-indigo-700 border-indigo-200" },
  SAGE_AR: { label: "Sage AR", cls: "bg-violet-50 text-violet-700 border-violet-200" },
  CASH_SALE: { label: "Cash Sales", cls: "bg-emerald-50 text-emerald-700 border-emerald-200" },
};

const DAY_MS = 86_400_000;

// How old an order is allowed to get before it drops a band. A brand-new order
// is what you're supposed to be working on right now; past three days it's a
// problem rather than a task.
const URGENT_MAX_MS = DAY_MS;
const REGULAR_MAX_MS = 3 * DAY_MS;

const BANDS = [
  {
    key: "URGENT",
    label: "Urgent",
    hint: "opened today",
    headerCls: "border-rose-200 bg-rose-50 text-rose-700",
    cardCls: "border-rose-300 ring-1 ring-rose-100",
    badgeCls: "bg-rose-100 text-rose-700 border-rose-300",
  },
  {
    key: "REGULAR",
    label: "Regular",
    hint: "1–3 days old",
    headerCls: "border-amber-200 bg-amber-50 text-amber-800",
    cardCls: "",
    badgeCls: "bg-amber-100 text-amber-800 border-amber-300",
  },
  {
    key: "STALE",
    label: "Stale",
    hint: "3+ days old",
    headerCls: "border-slate-300 bg-slate-100 text-slate-600",
    cardCls: "border-slate-300 opacity-90",
    badgeCls: "bg-slate-200 text-slate-600 border-slate-300",
  },
];

// An order's age in ms. `meta.createdAt` is the real answer, but it's only
// stamped on bubbles that went through addBubble — plenty are minted
// automatically the moment an item names a bubble that doesn't exist yet. The
// earliest `last_moved_at` across the order's parts is the honest fallback: a
// part sitting untouched in an order still carries the moment it landed there.
// An order with neither (an old, empty bubble) has no clock at all — it returns
// null and gets treated as Regular rather than wrongly called urgent.
function resolveOrderAgeMs(meta, items, nowMs) {
  let earliest = Infinity;
  const created = Date.parse(meta?.createdAt || "");
  if (Number.isFinite(created)) earliest = created;
  items.forEach((it) => {
    const moved = Date.parse(it?.last_moved_at || "");
    if (Number.isFinite(moved) && moved < earliest) earliest = moved;
  });
  return earliest === Infinity ? null : nowMs - earliest;
}

function bandKeyFor(ageMs) {
  if (ageMs === null) return "REGULAR";
  if (ageMs < URGENT_MAX_MS) return "URGENT";
  if (ageMs < REGULAR_MAX_MS) return "REGULAR";
  return "STALE";
}

function ageLabel(ageMs) {
  if (ageMs === null) return "No date";
  const days = Math.floor(ageMs / DAY_MS);
  if (days >= 1) return `${days}d old`;
  const hours = Math.floor(ageMs / 3_600_000);
  return hours < 1 ? "Just now" : `${hours}h old`;
}

function OrderCard({
  bubble,
  items,
  accountingPath,
  meta,
  extraLines,
  arrivalMap,
  historyByUid,
  expanded,
  onToggle,
  onUpdateBubbleNotes,
  onNotesCommit,
  onRequestPrint,
  onSetFlag,
  onSavePrice,
  onMoveItem,
  removingUids,
  onSendToCashPad,
  onSendToReturns,
  onArchiveOrder,
  onSageSalesInvoice,
  band,
  ageMs = null,
  isPool = false,
}) {
  const [sageCode, setSageCode] = useState("");
  const [sageSending, setSageSending] = useState(false);
  // The CashPad / Sage controls are the rarely-used half of the card — they
  // stay folded away so the row you see by default is just the three decisions
  // an order normally ends in.
  const [actionsOpen, setActionsOpen] = useState(false);
  const acct = ACCOUNTING_META[accountingPath] || ACCOUNTING_META.OUTSTANDING;
  const { subtotal, tax, total } = computeCardTotals(items, extraLines);

  const currentSignature = computeBubblePrintSignature(bubble.notes, items, extraLines);
  const printedSignature = meta?.printedSignature || "";
  const everPrinted = Boolean(printedSignature);
  const upToDate = everPrinted && printedSignature === currentSignature;

  const printBadge = !everPrinted
    ? { label: "Not printed", cls: "bg-slate-100 text-slate-500 border-slate-300" }
    : upToDate
      ? { label: "Printed", cls: "bg-emerald-100 text-emerald-700 border-emerald-300" }
      : { label: "Changed since print", cls: "bg-amber-100 text-amber-800 border-amber-300" };

  const arrivedCount = items.filter(
    (it) => arrivalMap[String(it.order_key || "").toUpperCase()] ?? arrivalMap[String(it.reference_num || "").toUpperCase()]
  ).length;

  return (
    <Card className={`relative hover:z-20 h-full flex flex-col ${band?.cardCls || ""}`}>
      <button onClick={onToggle} className="w-full flex items-start justify-between gap-2 text-left">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="text-slate-400 text-xs">{expanded ? "▾" : "▸"}</span>
            <span className="text-xl font-bold text-slate-800 truncate">{bubble.name}</span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <span className={`px-1.5 py-0.5 rounded-full border text-[11px] font-semibold ${acct.cls}`}>
              {acct.label}
            </span>
            {!isPool && band && (
              <span
                className={`px-1.5 py-0.5 rounded-full border text-[11px] font-semibold ${band.badgeCls}`}
                title={`${band.label} — ${band.hint}`}
              >
                {ageLabel(ageMs)}
              </span>
            )}
            <span className="text-[11px] font-semibold text-slate-600">
              {items.length} part{items.length === 1 ? "" : "s"}
            </span>
            {arrivedCount > 0 && (
              <span className="text-[11px] text-emerald-700 font-semibold">{arrivedCount} arrived</span>
            )}
          </div>
        </div>
      </button>

      {/* A stock pool (New Stock, Shelf) is a holding area, not customer
          paperwork — none of the order actions apply to it, so the card is
          just a browsable list of what's sitting there. */}
      {!isPool && (
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1.5 text-xs font-semibold text-slate-600">
          <input
            type="checkbox"
            checked={meta?.delivered === true}
            onChange={(e) => onSetFlag(bubble.id, "delivered", e.target.checked)}
          />
          Delivered
        </label>
        <label className="flex items-center gap-1.5 text-xs font-semibold text-slate-600">
          <input
            type="checkbox"
            checked={meta?.paid === true}
            onChange={(e) => onSetFlag(bubble.id, "paid", e.target.checked)}
          />
          Paid
        </label>

        <span className="flex-1" />

        <span
          className={`px-1.5 py-0.5 rounded-full border text-[10px] font-semibold whitespace-nowrap ${printBadge.cls}`}
          title={everPrinted ? `Last printed ${new Date(meta?.printedAt).toLocaleString()}` : "Never printed"}
        >
          {printBadge.label}
        </span>
        <button
          onClick={() => onRequestPrint(bubble)}
          className="rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50"
        >
          {everPrinted ? "Print Again" : "Print"}
        </button>
      </div>
      )}

      {!isPool && (
      <div className="mt-2 space-y-2 border-t border-slate-100 pt-2">
        {/* Every action an order can take is folded away behind this — the card
            at rest is just the order, its parts and what it's worth. */}
        <button
          onClick={() => setActionsOpen((v) => !v)}
          className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-50"
          title="Show this order's CashPad, Sage, completion and returns actions"
        >
          {actionsOpen ? "▾ Hide actions" : "▸ Actions"}
        </button>

        {actionsOpen && (
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={async () => {
                // An already-empty order has nothing to move — the confirm just
                // asks about deleting the now-pointless bubble, not a fictional
                // "0 items move into CashPad".
                const ok = await api.confirm(
                  items.length === 0
                    ? `Delete "${bubble.name}"?`
                    : `Send "${bubble.name}" to CashPad?`,
                  items.length === 0
                    ? "It has no items left — this just removes the empty order."
                    : `Its ${items.length} item${items.length === 1 ? "" : "s"} move into CashPad and this order stops existing as its own bubble — its notes and this card go away. "Auto-fill from CashPad" can then match them to a payment.`
                );
                if (!ok) return;
                onSendToCashPad(bubble.id);
              }}
              className="rounded-lg border border-emerald-300 bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700 hover:bg-emerald-100"
              title="Fold this order's items into CashPad so Auto-fill from CashPad can match them to a payment"
            >
              Send to Cash Pad
            </button>

            <span className="flex-1" />

            {/* Same rule BubbleColumn's own Sage-sales button uses: nothing sends
                until a customer code is actually typed in. */}
            <input
              value={sageCode}
              onChange={(e) => setSageCode(e.target.value)}
              placeholder="Sage customer code"
              className="w-36 rounded-lg border border-slate-200 px-2 py-1 text-xs"
            />
            <button
              disabled={!sageCode.trim() || sageSending || items.length === 0}
              onClick={async () => {
                setSageSending(true);
                try {
                  await onSageSalesInvoice(bubble.name, sageCode.trim(), bubble.notes || "", "");
                } finally {
                  setSageSending(false);
                }
              }}
              className="rounded-lg border border-violet-300 bg-white px-2.5 py-1 text-xs font-semibold text-violet-700 hover:bg-violet-50 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {sageSending ? "Sending…" : "Send to Sage"}
            </button>

            {/* The two ways an order actually ends. Separated from the routing
                controls above because both delete the order outright. */}
            <div className="w-full flex flex-wrap items-center gap-2 border-t border-slate-100 pt-2">
              <button
                onClick={() =>
                  onArchiveOrder(
                    bubble.id,
                    `Mark "${bubble.name}" delivered and complete?\n\n` +
                      `All accounting for this order is done, so its ${items.length} part(s) ` +
                      `are filed as sold in the Archive — searchable there with their history ` +
                      `intact — and this order stops existing.`
                  )
                }
                className="rounded-lg border border-emerald-400 bg-emerald-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-emerald-700"
                title="All accounting is finished — file this order's parts as sold and close it out"
              >
                Delivered and Complete
              </button>

              <button
                onClick={async () => {
                  const ok = await api.confirm(
                    `Send "${bubble.name}" to Returns?`,
                    items.length === 0
                      ? "It has no items left — this just removes the empty order."
                      : `Its ${items.length} item${items.length === 1 ? "" : "s"} move into RETURNS as unassigned returns stock (Returns Management can put them on a requisition slip) and this order stops existing — its notes and this card go away.`
                  );
                  if (!ok) return;
                  onSendToReturns(bubble.id);
                }}
                className="rounded-lg border border-rose-300 bg-rose-50 px-2.5 py-1 text-xs font-semibold text-rose-700 hover:bg-rose-100"
                title="Move every part in this order into Returns and delete the order"
              >
                Send to Returns
              </button>
            </div>
          </div>
        )}
      </div>
      )}

      {expanded && (
        <div className="mt-3 flex-1 space-y-2">
          <DraftInput
            as="textarea"
            value={bubble.notes || ""}
            onCommit={(next) => {
              // Same pair BubbleColumn uses: update the live bubble immediately
              // (so this note doesn't flash stale until the shared-file round
              // trip lands) and persist to the cross-machine shared file.
              onUpdateBubbleNotes(bubble.id, next);
              onNotesCommit(bubble.id, next);
            }}
            placeholder={isPool ? "Notes…" : "Notes for this order…"}
            rows={2}
            className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm resize-y"
          />
          <div className="space-y-1.5">
            {items.length === 0 && (
              <div className="px-3 py-2 text-sm text-slate-400 italic">
                {isPool ? "Nothing here." : "Nothing in this order."}
              </div>
            )}
            {items.map((it) => (
              <ItemRow
                key={it.uid}
                item={it}
                busy={removingUids.has(it.uid)}
                arrived={Boolean(
                  arrivalMap[String(it.order_key || "").toUpperCase()] ??
                    arrivalMap[String(it.reference_num || "").toUpperCase()]
                )}
                history={historyByUid.get(it.uid) || []}
                onSavePrice={(next) => onSavePrice(it.uid, next)}
                // A part leaving an order goes back on the shelf, onto a cash
                // sale, or back to the warehouse. A part sitting in a pool has
                // already left the order — from there the useful moves are onto
                // a sale or out as a return.
                moveLabel={isPool ? "Move" : "Remove"}
                moveTargets={
                  isPool ? ["CASHPAD", "RETURNS"] : ["NEW STOCK", "CASHPAD", "RETURNS"]
                }
                onMove={(target) => onMoveItem(it, bubble.name, target)}
              />
            ))}
          </div>
        </div>
      )}

      {/* Sits outside the `expanded` block so a collapsed card still shows what
          the order is worth — `mt-auto` pins it to the card's bottom edge in
          either state, keeping the totals aligned across the grid row. */}
      <CardTotals subtotal={subtotal} tax={tax} total={total} />
    </Card>
  );
}

export default function SalesOrderView({
  bubbles,
  itemsByBubble,
  bubbleMeta,
  bubbleAccountingPathByName,
  defaultBubbleNames,
  extraLinesByBubble,
  onUpdateBubbleNotes,
  onBubbleNotesBlur,
  onRequestPrint,
  onSetBubbleFlag,
  onUpdateItem,
  onSendToCashPad,
  onSendToReturns,
  onArchiveOrder,
  onSageSalesInvoice,
}) {
  // Tracks COLLAPSED ids rather than expanded ones, so the default (nothing
  // in the set) means every order starts expanded — including ones that
  // appear later, e.g. a bubble created after this view mounted.
  const [collapsedOrderIds, setCollapsedOrderIds] = useState(() => new Set());
  const [cashPadCollapsed, setCashPadCollapsed] = useState(false);
  // Pools start collapsed — they're reference material you open when you're
  // looking for a part, not the day's work.
  const [poolsOpen, setPoolsOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [arrivalMap, setArrivalMap] = useState({});
  const [arrivalLoading, setArrivalLoading] = useState(false);
  const [error, setError] = useState("");
  // Uids currently mid-removal — the row dims and its buttons disable while a
  // Remove is in flight. The item itself disappears from this list a moment
  // later once the app's own file watcher picks up the write and refreshes
  // `items`; this view has no items state of its own to update directly.
  const [removingUids, setRemovingUids] = useState(() => new Set());
  const historyByUid = useItemHistoryByUid("sales-orders");
  // The banding is a clock, and this app sits open all day — without a tick an
  // order opened at 4pm would still be claiming "Urgent" the next afternoon
  // until something unrelated forced a re-render.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 5 * 60_000);
    return () => clearInterval(t);
  }, []);

  const loadArrivalMap = async () => {
    setArrivalLoading(true);
    try {
      const res = await api.getOrderArrivalMap();
      setArrivalMap(res?.ok ? res.map || {} : {});
    } finally {
      setArrivalLoading(false);
    }
  };

  useEffect(() => {
    loadArrivalMap();
  }, []);

  const orders = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return bubbles
      .filter((b) => !defaultBubbleNames.has(b.name))
      // CashPad is a staging pool "Send to Cash Pad" folds orders INTO — same
      // reasoning as excluding NEW STOCK/SHELF/RETURNS, it's not a customer's
      // order itself.
      .filter((b) => (b.name || "").trim().toUpperCase() !== "CASHPAD")
      .filter((b) => !needle || b.name.toLowerCase().includes(needle))
      .map((b) => ({
        bubble: b,
        items: itemsByBubble.get(b.name) || [],
        accountingPath: bubbleAccountingPathByName.get(b.name) || bubbleMeta[b.id]?.accountingPath || "OUTSTANDING",
        meta: bubbleMeta[b.id] || bubbleMeta[b.name] || {},
        extraLines: extraLinesByBubble?.[b.id] || [],
      }))
      // Cash sales are already sold and paid for — Auto-fill from CashPad mints
      // one bubble per payment ("INTERAC $40.00"), which is a receipt, not an
      // order still being worked. Cash Sales owns them (with the pricing and
      // payment tools they actually need), so they stay out of here.
      //
      // An assigned payment is the second, stronger test. The accounting path
      // is read off the bubble's ITEMS, so a VISA/MASTERCARD bubble whose parts
      // came in via a route that left them on OUTSTANDING slips past the check
      // above — but a bubble with a payment attached to it has been settled by
      // definition, whatever its parts say.
      .filter(
        (o) => o.accountingPath !== "CASH_SALE" && !(o.meta?.paymentIds || []).length
      )
      .map((o) => {
        const ageMs = resolveOrderAgeMs(o.meta, o.items, nowMs);
        return { ...o, ageMs, bandKey: bandKeyFor(ageMs) };
      })
      // Oldest first inside each band, so the order closest to slipping into the
      // next band sits at the top of its section. Unknown ages (no createdAt, no
      // parts) sort last within Regular rather than jumping the queue.
      .sort((a, b) => (b.ageMs ?? -1) - (a.ageMs ?? -1));
  }, [bubbles, itemsByBubble, bubbleAccountingPathByName, bubbleMeta, defaultBubbleNames, extraLinesByBubble, search, nowMs]);

  // Urgent → Regular → Stale, empty bands dropped so the page isn't mostly
  // headers on a quiet day.
  const bandedOrders = useMemo(
    () =>
      BANDS.map((band) => ({ band, rows: orders.filter((o) => o.bandKey === band.key) })).filter(
        (g) => g.rows.length > 0
      ),
    [orders]
  );

  // The stock pools — parts that exist but aren't on anyone's order yet. These
  // used to be bubbles in the Stock Flow workspace; with that gone they live
  // here so New Stock and the Shelf are still browsable. RETURNS is left out on
  // purpose: Returns Management owns it and does far more than a list.
  const pools = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return POOL_NAMES.map((poolName) => {
      const bubble =
        bubbles.find((b) => (b.name || "").trim().toUpperCase() === poolName) || {
          id: `pool-${poolName}`,
          name: poolName,
          notes: "",
        };
      return {
        bubble,
        items: itemsByBubble.get(bubble.name) || [],
        meta: bubbleMeta[bubble.id] || bubbleMeta[bubble.name] || {},
        extraLines: extraLinesByBubble?.[bubble.id] || [],
      };
    }).filter((p) => !needle || p.bubble.name.toLowerCase().includes(needle));
  }, [bubbles, itemsByBubble, bubbleMeta, extraLinesByBubble, search]);

  // CashPad is keyed by its exact bubble name — auto-created uppercase the
  // moment any item's allocated_to becomes "CASHPAD" (Send to Cash Pad, or the
  // existing delete-bubble-to-CashPad flow), same string `Auto-fill from
  // CashPad` already scans for.
  const cashPadItems = itemsByBubble.get("CASHPAD") || [];

  const toggleOrder = (id) =>
    setCollapsedOrderIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // Local-state update — same path BubbleColumn's own price field uses
  // (onUpdateItem = App.jsx's updateItemByKey), so it persists through the
  // app's normal debounced items save rather than a separate write.
  const handleSavePrice = (uid, value) => {
    onUpdateItem(uid, { allocated_for: value });
  };

  // What each destination actually means for the part, spelled out in the
  // confirm — "Remove" used to mean New Stock silently, and the whole point of
  // the picker is that where it lands is now a decision.
  const MOVE_BLURB = {
    "NEW STOCK": "It goes back to New Stock as unallocated stock, and is no longer assigned to this order — Order Assignment will show it as unassigned again.",
    RETURNS:
      "It moves into RETURNS as unassigned returns stock — Returns Management can put it on a requisition slip — and it is no longer assigned to this order.",
    CASHPAD:
      'It moves into CashPad on the cash-sale path, where "Auto-fill from CashPad" can match it to a payment.',
  };

  const handleMoveItem = async (item, fromName, destination) => {
    const label = MOVE_TARGETS[destination]?.label || destination;
    const ok = await api.confirm(
      `Send ${item.itemcode} from ${fromName} to ${label}?`,
      MOVE_BLURB[destination] || ""
    );
    if (!ok) return;
    setError("");
    setRemovingUids((prev) => new Set(prev).add(item.uid));
    try {
      const res = await api.unassignOrderItem({ uid: item.uid, destination });
      if (!res?.ok) setError(res?.error || `Failed to send this part to ${label}.`);
    } finally {
      setRemovingUids((prev) => {
        const next = new Set(prev);
        next.delete(item.uid);
        return next;
      });
    }
  };

  return (
    <div className="flex items-start gap-4 pb-24">
      <div className="flex-1 min-w-0 space-y-4">
        <Card>
          <div className="flex flex-wrap items-center gap-3">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search orders by name…"
              className="flex-1 min-w-[16rem] rounded-xl border border-slate-200 px-3 py-1.5 text-sm"
            />
            <button
              onClick={loadArrivalMap}
              disabled={arrivalLoading}
              className="rounded-xl bg-indigo-600 px-4 py-1.5 text-sm font-semibold text-white shadow hover:bg-indigo-700 disabled:opacity-50"
            >
              {arrivalLoading ? "Refreshing…" : "Refresh arrival status"}
            </button>
            <button
              onClick={() => setCollapsedOrderIds(new Set())}
              className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-sm font-semibold text-slate-600 hover:bg-slate-50"
            >
              Expand all
            </button>
            <button
              onClick={() => setCollapsedOrderIds(new Set(orders.map((o) => o.bubble.id)))}
              className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-sm font-semibold text-slate-600 hover:bg-slate-50"
            >
              Collapse all
            </button>
          </div>
        </Card>

        {error && (
          <div className="rounded-2xl border border-red-300 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">
            {error}
          </div>
        )}

        {orders.length === 0 && (
          <Card>
            <div className="text-sm text-slate-500 italic">No sales orders yet.</div>
          </Card>
        )}

        {bandedOrders.map(({ band, rows }) => (
          <div key={band.key} className="space-y-2">
            <div
              className={`flex items-center gap-2 rounded-xl border px-3 py-1.5 text-sm font-bold ${band.headerCls}`}
            >
              <span className="uppercase tracking-wide">{band.label}</span>
              <span className="rounded-full bg-white/70 px-1.5 py-0.5 text-[11px] font-bold">
                {rows.length}
              </span>
              <span className="text-[11px] font-semibold opacity-70">{band.hint}</span>
            </div>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
              {rows.map(({ bubble, items, accountingPath, meta, extraLines, ageMs }) => (
                <OrderCard
                  key={bubble.id}
                  bubble={bubble}
                  items={items}
                  accountingPath={accountingPath}
                  meta={meta}
                  extraLines={extraLines}
                  arrivalMap={arrivalMap}
                  historyByUid={historyByUid}
                  band={band}
                  ageMs={ageMs}
                  expanded={!collapsedOrderIds.has(bubble.id)}
                  onToggle={() => toggleOrder(bubble.id)}
                  onUpdateBubbleNotes={onUpdateBubbleNotes}
                  onNotesCommit={onBubbleNotesBlur}
                  onRequestPrint={onRequestPrint}
                  onSetFlag={onSetBubbleFlag}
                  onSavePrice={handleSavePrice}
                  onMoveItem={handleMoveItem}
                  removingUids={removingUids}
                  onSendToCashPad={onSendToCashPad}
                  onSendToReturns={onSendToReturns}
                  onArchiveOrder={onArchiveOrder}
                  onSageSalesInvoice={onSageSalesInvoice}
                />
              ))}
            </div>
          </div>
        ))}

        <Card>
          <button
            onClick={() => setPoolsOpen((v) => !v)}
            className="flex w-full items-center gap-2 text-left"
          >
            <span className="text-slate-400 text-xs">{poolsOpen ? "▾" : "▸"}</span>
            <span className="text-base font-bold text-slate-800">Stock pools</span>
            <span className="text-[11px] text-slate-500">
              {pools.map((p) => `${p.bubble.name} (${p.items.length})`).join(" · ")}
            </span>
          </button>
        </Card>

        {poolsOpen && (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {pools.map(({ bubble, items, meta, extraLines }) => (
              <OrderCard
                key={bubble.id}
                isPool
                bubble={bubble}
                items={items}
                accountingPath="OUTSTANDING"
                meta={meta}
                extraLines={extraLines}
                arrivalMap={arrivalMap}
                historyByUid={historyByUid}
                expanded={!collapsedOrderIds.has(bubble.id)}
                onToggle={() => toggleOrder(bubble.id)}
                onUpdateBubbleNotes={onUpdateBubbleNotes}
                onNotesCommit={onBubbleNotesBlur}
                onRequestPrint={onRequestPrint}
                onSetFlag={onSetBubbleFlag}
                onSavePrice={handleSavePrice}
                onMoveItem={handleMoveItem}
                removingUids={removingUids}
              />
            ))}
          </div>
        )}
      </div>

      <CashPadPanel
        items={cashPadItems}
        arrivalMap={arrivalMap}
        historyByUid={historyByUid}
        removingUids={removingUids}
        onSavePrice={handleSavePrice}
        onMoveItem={handleMoveItem}
        collapsed={cashPadCollapsed}
        onToggleCollapse={() => setCashPadCollapsed((v) => !v)}
      />
    </div>
  );
}
