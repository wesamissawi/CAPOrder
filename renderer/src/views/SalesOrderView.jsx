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
import React, { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import Card from "../components/Card";
import DraftInput from "../components/DraftInput";
import api from "../api";
import { computeBubblePrintSignature } from "../utils/inventory";
import {
  CardTotals,
  CashPadPanel,
  EMPTY_ARRAY,
  ItemRow,
  MOVE_TARGETS,
  computeCardTotals,
  money,
  useItemHistoryByUid,
} from "../components/orderCardKit";

// Holding areas rather than customer orders. CASHPAD has its own docked panel
// and RETURNS has its own view, so only these two need a home here.
const POOL_NAMES = ["NEW STOCK", "SHELF"];

// Stand-ins for a pool that has no bubble of its own yet. Built once so the
// pool card keeps the same `bubble` object across renders.
const POOL_FALLBACK_BUBBLES = Object.fromEntries(
  POOL_NAMES.map((name) => [name, { id: `pool-${name}`, name, notes: "" }])
);

// Shared fallbacks and fixed option lists. These are the props every card and
// row receives, so they have to be stable identities — a `{}` or `[...]` built
// inside render is a new object each time, which alone would make the
// React.memo on OrderCard/ItemRow never bail out.
const EMPTY_META = {};
const ORDER_MOVE_TARGETS = ["NEW STOCK", "CASHPAD", "RETURNS"];
const POOL_MOVE_TARGETS = ["CASHPAD", "RETURNS"];

// What each destination actually means for the part, spelled out in the
// confirm — "Remove" used to mean New Stock silently, and the whole point of
// the picker is that where it lands is now a decision.
const MOVE_BLURB = {
  "NEW STOCK":
    "It goes back to New Stock as unallocated stock, and is no longer assigned to this order — Order Assignment will show it as unassigned again.",
  RETURNS:
    "It moves into RETURNS as unassigned returns stock — Returns Management can put it on a requisition slip — and it is no longer assigned to this order.",
  CASHPAD:
    'It moves into CashPad on the cash-sale path, where "Auto-fill from CashPad" can match it to a payment.',
};

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
  // The two status bands. They sit AFTER the age bands on purpose: an order
  // that's on the counter or already out the door isn't work you're chasing,
  // so it drops out of the age queue at the top and parks down here until it's
  // archived. Both are driven by their checkbox, not by the clock.
  {
    key: "COUNTER",
    label: "Counter",
    hint: "waiting to be picked up",
    headerCls: "border-sky-200 bg-sky-50 text-sky-700",
    cardCls: "border-sky-300 ring-1 ring-sky-100",
    badgeCls: "bg-sky-100 text-sky-700 border-sky-300",
  },
  {
    key: "DELIVERED",
    label: "Delivered",
    hint: "handed off to the customer",
    headerCls: "border-emerald-200 bg-emerald-50 text-emerald-700",
    cardCls: "border-emerald-300",
    badgeCls: "bg-emerald-100 text-emerald-700 border-emerald-300",
  },
];

const BAND_LABEL_BY_KEY = Object.fromEntries(BANDS.map((b) => [b.key, b.label]));

// How long a card sits in its OLD section after Counter/Delivered changes
// before it actually reflows — long enough to keep editing the same order
// (prices, notes, items) without it vanishing out from under you, short
// enough that it still lands where it belongs on its own.
const BAND_HOLD_MS = 10_000;

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

// Status beats the clock: once an order is on the counter or delivered, how
// old it is stops being the thing that decides where it sits. Delivered wins
// over Counter for the same reason — it's the later state — though the
// checkboxes clear each other, so an order carrying both is only ever a
// leftover from an older build.
function bandKeyFor(ageMs, meta) {
  if (meta?.delivered === true) return "DELIVERED";
  if (meta?.counter === true) return "COUNTER";
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

// The Sage customer code is typed one character at a time into state, so it
// lives in its own component: keeping it on OrderCard meant every character
// re-rendered the card's notes box and its whole part list.
function SageSendRow({ bubbleName, bubbleNotes, itemCount, onSageSalesInvoice }) {
  const [sageCode, setSageCode] = useState("");
  const [sageSending, setSageSending] = useState(false);

  return (
    <>
      {/* Same rule BubbleColumn's own Sage-sales button uses: nothing sends
          until a customer code is actually typed in. */}
      <input
        value={sageCode}
        onChange={(e) => setSageCode(e.target.value)}
        placeholder="Sage customer code"
        className="w-36 rounded-lg border border-slate-200 px-2 py-1 text-xs"
      />
      <button
        disabled={!sageCode.trim() || sageSending || itemCount === 0}
        onClick={async () => {
          setSageSending(true);
          try {
            await onSageSalesInvoice(bubbleName, sageCode.trim(), bubbleNotes || "", "");
          } finally {
            setSageSending(false);
          }
        }}
        className="rounded-lg border border-violet-300 bg-white px-2.5 py-1 text-xs font-semibold text-violet-700 hover:bg-violet-50 disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {sageSending ? "Sending…" : "Send to Sage"}
      </button>
    </>
  );
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
  pendingMove = null,
  onMoveNow,
  onExtendHold,
}) {
  // The CashPad / Sage controls are the rarely-used half of the card — they
  // stay folded away so the row you see by default is just the three decisions
  // an order normally ends in.
  const [actionsOpen, setActionsOpen] = useState(false);
  const acct = ACCOUNTING_META[accountingPath] || ACCOUNTING_META.OUTSTANDING;
  const { subtotal, tax, total } = computeCardTotals(items, extraLines);
  // One function object shared by every row in this card, so the memoized rows
  // only re-render when their own item changes.
  const handleRowMove = useCallback(
    (item, target) => onMoveItem(item, bubble.name, target),
    [onMoveItem, bubble.name]
  );
  const handleToggle = useCallback(() => onToggle(bubble.id), [onToggle, bubble.id]);

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
      <button onClick={handleToggle} className="w-full flex items-start justify-between gap-2 text-left">
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
        {/* Counter and Delivered are the same order at two different moments,
            so each clears the other — sent as ONE patch, because two separate
            flag calls would both read the same pre-change meta. */}
        <label
          className="flex items-center gap-1.5 text-xs font-semibold text-slate-600"
          title="Picked and sitting on the counter, waiting for the customer"
        >
          <input
            type="checkbox"
            checked={meta?.counter === true}
            onChange={(e) =>
              onSetFlag(bubble.id, { counter: e.target.checked, delivered: false })
            }
          />
          Counter
        </label>
        <label className="flex items-center gap-1.5 text-xs font-semibold text-slate-600">
          <input
            type="checkbox"
            checked={meta?.delivered === true}
            onChange={(e) =>
              onSetFlag(bubble.id, { delivered: e.target.checked, counter: false })
            }
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

      {/* Counter/Delivered saved instantly, but the card holds its OLD section
          for a few seconds so ticking the box mid-edit doesn't yank the card
          away — it lands in its new section on its own once the hold expires,
          or right away via "Move now". */}
      {pendingMove && (
        <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-2 py-1 text-xs font-semibold text-amber-800">
          <span>
            Moving to {BAND_LABEL_BY_KEY[pendingMove.targetBandKey] || pendingMove.targetBandKey} in{" "}
            {pendingMove.secondsLeft}s…
          </span>
          <button
            onClick={() => onMoveNow(bubble.id)}
            className="rounded border border-amber-400 bg-white px-1.5 py-0.5 font-semibold text-amber-800 hover:bg-amber-100"
          >
            Move now
          </button>
          <button
            onClick={() => onExtendHold(bubble.id)}
            className="rounded border border-amber-400 bg-white px-1.5 py-0.5 font-semibold text-amber-800 hover:bg-amber-100"
          >
            Keep here +10s
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

            <SageSendRow
              bubbleName={bubble.name}
              bubbleNotes={bubble.notes}
              itemCount={items.length}
              onSageSalesInvoice={onSageSalesInvoice}
            />

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
                history={historyByUid.get(it.uid) || EMPTY_ARRAY}
                onSavePrice={onSavePrice}
                // A part leaving an order goes back on the shelf, onto a cash
                // sale, or back to the warehouse. A part sitting in a pool has
                // already left the order — from there the useful moves are onto
                // a sale or out as a return.
                moveLabel={isPool ? "Move" : "Remove"}
                moveTargets={isPool ? POOL_MOVE_TARGETS : ORDER_MOVE_TARGETS}
                onMove={handleRowMove}
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

// Every prop this card takes is either a primitive, a value straight out of
// state, or one of the stable callbacks/constants above — so a keystroke that
// only re-orders or re-filters the grid leaves untouched cards alone instead of
// re-running their totals, print signature and every row inside them.
const MemoOrderCard = React.memo(OrderCard);

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
  // The input stays on `search` so it never drops a character, while the grid
  // rebuilds off `deferredSearch` at a lower priority. Without this, every
  // keystroke re-derived, re-banded and re-sorted the whole order list before
  // the character could paint.
  const deferredSearch = useDeferredValue(search);
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

  // Orders whose Counter/Delivered flag just changed but are still holding
  // their OLD section — keyed by bubble id, cleared (and the card released to
  // reflow) once the hold expires, "Move now" is clicked, or the card is
  // collapsed. The flag itself is already saved by the time an entry exists
  // here; this only delays where the card is drawn.
  const [pendingMoves, setPendingMoves] = useState({});
  const pendingTimeouts = useRef({});
  // A second, faster clock than `nowMs` — only ticking while there's
  // something to count down, so the countdown pill can update every half
  // second without putting the whole board on a 500ms re-render forever.
  const [pendingTickMs, setPendingTickMs] = useState(() => Date.now());
  const hasPendingMoves = Object.keys(pendingMoves).length > 0;
  useEffect(() => {
    if (!hasPendingMoves) return;
    const t = setInterval(() => setPendingTickMs(Date.now()), 500);
    return () => clearInterval(t);
  }, [hasPendingMoves]);

  const finalizePendingMove = useCallback((id) => {
    clearTimeout(pendingTimeouts.current[id]);
    delete pendingTimeouts.current[id];
    setPendingMoves((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  const schedulePendingMove = useCallback(
    (id, frozenBandKey, targetBandKey, ms = BAND_HOLD_MS) => {
      clearTimeout(pendingTimeouts.current[id]);
      pendingTimeouts.current[id] = setTimeout(() => finalizePendingMove(id), ms);
      setPendingMoves((prev) => ({
        ...prev,
        [id]: { frozenBandKey, targetBandKey, moveAt: Date.now() + ms },
      }));
    },
    [finalizePendingMove]
  );

  const extendPendingMove = useCallback((id) => {
    clearTimeout(pendingTimeouts.current[id]);
    pendingTimeouts.current[id] = setTimeout(() => finalizePendingMove(id), BAND_HOLD_MS);
    setPendingMoves((prev) => {
      if (!(id in prev)) return prev;
      return { ...prev, [id]: { ...prev[id], moveAt: Date.now() + BAND_HOLD_MS } };
    });
  }, [finalizePendingMove]);

  // Timers outlive the render that scheduled them — anything still pending
  // when the view unmounts (navigated away, etc.) needs its timeout cleared
  // too, or it fires into a component that's gone.
  useEffect(() => {
    const timeouts = pendingTimeouts.current;
    return () => {
      Object.values(timeouts).forEach(clearTimeout);
    };
  }, []);

  // App.jsx hands several of these callbacks down as inline arrows, so their
  // identity changes on every App render. Reading them through a ref lets the
  // wrappers below stay stable for the life of the view, which is what the
  // memoized cards compare against — without it a background items push would
  // re-render every card even though nothing about them changed.
  const handlersRef = useRef(null);
  // Read by stableSetFlag to check whether a flag change actually crosses a
  // band boundary — kept as a ref (not a useCallback dep) so `orders`
  // recomputing on every clock tick doesn't churn every stable callback below.
  const ordersRef = useRef([]);
  handlersRef.current = {
    onUpdateBubbleNotes,
    onBubbleNotesBlur,
    onRequestPrint,
    onSetBubbleFlag,
    onUpdateItem,
    onSendToCashPad,
    onSendToReturns,
    onArchiveOrder,
    onSageSalesInvoice,
  };
  const stableUpdateBubbleNotes = useCallback((id, notes) => handlersRef.current.onUpdateBubbleNotes(id, notes), []);
  const stableNotesCommit = useCallback((id, notes) => handlersRef.current.onBubbleNotesBlur(id, notes), []);
  const stableRequestPrint = useCallback((bubble) => handlersRef.current.onRequestPrint(bubble), []);
  // `flag` is either a key ("paid") or a whole patch ({ counter, delivered }) —
  // App.jsx accepts both, and the patch form is what keeps Counter/Delivered
  // from clobbering each other. Only a patch touching counter/delivered can
  // move an order between bands, so that's the only case checked against
  // `ordersRef` for a hold; anything else just passes through.
  const stableSetFlag = useCallback(
    (id, flag, value) => {
      if (flag && typeof flag === "object" && ("counter" in flag || "delivered" in flag)) {
        const entry = ordersRef.current.find((o) => o.bubble.id === id);
        if (entry) {
          const targetBandKey = bandKeyFor(entry.ageMs, { ...entry.meta, ...flag });
          if (targetBandKey !== entry.bandKey) {
            schedulePendingMove(id, entry.bandKey, targetBandKey);
          } else {
            // Toggled back to where it already sits (e.g. re-checked before the
            // hold ran out) — nothing left to hold for.
            finalizePendingMove(id);
          }
        }
      }
      handlersRef.current.onSetBubbleFlag(id, flag, value);
    },
    [schedulePendingMove, finalizePendingMove]
  );
  const stableSendToCashPad = useCallback((id) => handlersRef.current.onSendToCashPad(id), []);
  const stableSendToReturns = useCallback((id) => handlersRef.current.onSendToReturns(id), []);
  const stableArchiveOrder = useCallback((id, message) => handlersRef.current.onArchiveOrder(id, message), []);
  const stableSageSalesInvoice = useCallback(
    (name, code, notes, paymentType) =>
      handlersRef.current.onSageSalesInvoice(name, code, notes, paymentType),
    []
  );

  const loadArrivalMap = useCallback(async () => {
    setArrivalLoading(true);
    try {
      const res = await api.getOrderArrivalMap();
      setArrivalMap(res?.ok ? res.map || {} : {});
    } finally {
      setArrivalLoading(false);
    }
  }, []);

  useEffect(() => {
    loadArrivalMap();
  }, [loadArrivalMap]);

  const orders = useMemo(() => {
    const needle = deferredSearch.trim().toLowerCase();
    return bubbles
      .filter((b) => !defaultBubbleNames.has(b.name))
      // CashPad is a staging pool "Send to Cash Pad" folds orders INTO — same
      // reasoning as excluding NEW STOCK/SHELF/RETURNS, it's not a customer's
      // order itself.
      .filter((b) => (b.name || "").trim().toUpperCase() !== "CASHPAD")
      .filter((b) => !needle || b.name.toLowerCase().includes(needle))
      .map((b) => ({
        bubble: b,
        items: itemsByBubble.get(b.name) || EMPTY_ARRAY,
        accountingPath: bubbleAccountingPathByName.get(b.name) || bubbleMeta[b.id]?.accountingPath || "OUTSTANDING",
        meta: bubbleMeta[b.id] || bubbleMeta[b.name] || EMPTY_META,
        extraLines: extraLinesByBubble?.[b.id] || EMPTY_ARRAY,
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
        const trueBandKey = bandKeyFor(ageMs, o.meta);
        // A hold in progress keeps the card in its OLD section (`bandKey`
        // below) even though `trueBandKey` — what onSetFlag already saved —
        // has moved on.
        const pending = pendingMoves[o.bubble.id];
        const bandKey = pending ? pending.frozenBandKey : trueBandKey;
        const pendingMove = pending
          ? {
              targetBandKey: pending.targetBandKey,
              secondsLeft: Math.max(0, Math.ceil((pending.moveAt - pendingTickMs) / 1000)),
            }
          : null;
        return { ...o, ageMs, bandKey, pendingMove };
      })
      // Oldest first inside each band, so the order closest to slipping into the
      // next band sits at the top of its section. Unknown ages (no createdAt, no
      // parts) sort last within Regular rather than jumping the queue.
      .sort((a, b) => (b.ageMs ?? -1) - (a.ageMs ?? -1));
  }, [
    bubbles,
    itemsByBubble,
    bubbleAccountingPathByName,
    bubbleMeta,
    defaultBubbleNames,
    extraLinesByBubble,
    deferredSearch,
    nowMs,
    pendingMoves,
    pendingTickMs,
  ]);
  ordersRef.current = orders;

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
    const needle = deferredSearch.trim().toLowerCase();
    return POOL_NAMES.map((poolName) => {
      const bubble =
        bubbles.find((b) => (b.name || "").trim().toUpperCase() === poolName) ||
        POOL_FALLBACK_BUBBLES[poolName];
      return {
        bubble,
        items: itemsByBubble.get(bubble.name) || EMPTY_ARRAY,
        meta: bubbleMeta[bubble.id] || bubbleMeta[bubble.name] || EMPTY_META,
        extraLines: extraLinesByBubble?.[bubble.id] || EMPTY_ARRAY,
      };
    }).filter((p) => !needle || p.bubble.name.toLowerCase().includes(needle));
  }, [bubbles, itemsByBubble, bubbleMeta, extraLinesByBubble, deferredSearch]);

  // CashPad is keyed by its exact bubble name — auto-created uppercase the
  // moment any item's allocated_to becomes "CASHPAD" (Send to Cash Pad, or the
  // existing delete-bubble-to-CashPad flow), same string `Auto-fill from
  // CashPad` already scans for.
  const cashPadItems = itemsByBubble.get("CASHPAD") || EMPTY_ARRAY;

  const toggleOrder = useCallback(
    (id) =>
      setCollapsedOrderIds((prev) => {
        const next = new Set(prev);
        if (next.has(id)) {
          next.delete(id);
        } else {
          next.add(id);
          // Collapsing reads as "I'm done with this one" — let a held move
          // land immediately instead of waiting out the rest of its timer.
          finalizePendingMove(id);
        }
        return next;
      }),
    [finalizePendingMove]
  );

  const toggleCashPad = useCallback(() => setCashPadCollapsed((v) => !v), []);

  // Local-state update — same path BubbleColumn's own price field uses
  // (onUpdateItem = App.jsx's updateItemByKey). App's write-through save
  // publishes it a beat later, so this needs no write of its own.
  const handleSavePrice = useCallback((uid, value) => {
    handlersRef.current.onUpdateItem(uid, { allocated_for: value });
  }, []);

  const handleMoveItem = useCallback(async (item, fromName, destination) => {
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
  }, []);

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
              {rows.map(({ bubble, items, accountingPath, meta, extraLines, ageMs, pendingMove }) => (
                <MemoOrderCard
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
                  pendingMove={pendingMove}
                  onMoveNow={finalizePendingMove}
                  onExtendHold={extendPendingMove}
                  expanded={!collapsedOrderIds.has(bubble.id)}
                  onToggle={toggleOrder}
                  onUpdateBubbleNotes={stableUpdateBubbleNotes}
                  onNotesCommit={stableNotesCommit}
                  onRequestPrint={stableRequestPrint}
                  onSetFlag={stableSetFlag}
                  onSavePrice={handleSavePrice}
                  onMoveItem={handleMoveItem}
                  removingUids={removingUids}
                  onSendToCashPad={stableSendToCashPad}
                  onSendToReturns={stableSendToReturns}
                  onArchiveOrder={stableArchiveOrder}
                  onSageSalesInvoice={stableSageSalesInvoice}
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
              <MemoOrderCard
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
                onToggle={toggleOrder}
                onUpdateBubbleNotes={stableUpdateBubbleNotes}
                onNotesCommit={stableNotesCommit}
                onRequestPrint={stableRequestPrint}
                onSetFlag={stableSetFlag}
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
        onToggleCollapse={toggleCashPad}
      />
    </div>
  );
}
