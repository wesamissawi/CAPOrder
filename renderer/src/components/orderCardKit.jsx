// Shared building blocks for the card-grid order views (Sales Orders and Cash
// Sales). Both render the same kind of thing — a collapsible card per bubble
// with a list of parts inside — so the part row, the history trail and the
// money formatting live here rather than being reimplemented per view.
//
// Nothing in here owns data: every mutation goes back out through a callback to
// App.jsx's handlers, same as the views themselves.
import React, { useEffect, useMemo, useState } from "react";
import Card from "./Card";
import api from "../api";

export const money = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? `$${n.toFixed(2)}` : "";
};

export const toNum = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

// An item's effective sell price for cash sales: the discounted price when one
// has actually been set (empty string counts as "not set"), otherwise the
// regular allocated_for. Same precedence BubbleColumn used.
export const effectivePrice = (item) =>
  item.discounted_price !== undefined &&
  item.discounted_price !== null &&
  item.discounted_price !== ""
    ? toNum(item.discounted_price)
    : toNum(item.allocated_for);

const DESC_LIMIT = 30;
const truncate = (s, n = DESC_LIMIT) => {
  const v = String(s || "").trim();
  return v.length > n ? `${v.slice(0, n)}…` : v;
};

// Instant-tooltip pattern from Order Assignment — the native `title` lags.
export function DescriptionWithTooltip({ text }) {
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

// Readable names for events that describe something other than a move, so they
// don't surface as the raw jsonl event key. A move still shows its destination
// bubble — that's the more useful label when there is one.
const EVENT_LABELS = {
  created: "Created",
  sent_to_sage: "Sent to Sage",
  sent_to_cashpad: "Sent to CashPad",
  returned_to_stock: "Returned to stock",
  archived: "Archived (sold)",
  credit_received: "Credit received",
  deleted: "Deleted",
  moved: "Moved",
};

// One entry per bubble the part has passed through — created/moved/queue-change
// events all carry from_bubble/to_bubble, so this reads directly off
// item_history.jsonl rather than being a second, separate trail.
export function HistoryTrail({ records }) {
  if (!records.length) {
    return <div className="text-[11px] text-slate-400 italic">No history recorded yet.</div>;
  }
  return (
    <div className="space-y-1">
      {records.map((r, i) => (
        <div key={i} className="text-[11px] text-slate-600 flex items-center gap-1.5">
          <span className="text-slate-400 tabular-nums shrink-0">
            {new Date(r.at).toLocaleString(undefined, {
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>
          <span className="font-semibold text-slate-700">
            {r.to_bubble || r.from_bubble || EVENT_LABELS[r.event] || r.event}
          </span>
          {r.from_bubble && r.to_bubble && r.from_bubble !== r.to_bubble && (
            <span className="text-slate-400">← {r.from_bubble}</span>
          )}
          {/* Only Sage sends carry this, and it's the whole point of the entry. */}
          {r.sage_invoice_number && (
            <span className="font-mono text-violet-600">inv {r.sage_invoice_number}</span>
          )}
        </div>
      ))}
    </div>
  );
}

// The full item lifecycle log — same one Archive Search reads — loaded once and
// grouped by uid so every row's "History" toggle is a map lookup rather than a
// per-row fetch. History runs into the thousands of records over time.
export function useItemHistoryByUid(label) {
  const [log, setLog] = useState([]);
  useEffect(() => {
    api
      .readItemHistory()
      .then((res) => {
        if (res?.ok) setLog(res.history || []);
      })
      .catch((e) => console.error(`[${label}] history load failed`, e));
  }, [label]);

  return useMemo(() => {
    const map = new Map();
    log.forEach((r) => {
      if (!r?.uid) return;
      if (!map.has(r.uid)) map.set(r.uid, []);
      map.get(r.uid).push(r);
    });
    return map;
  }, [log]);
}

// A commit-on-demand price box. Typing is local; a Save button appears only
// once the draft differs from what's stored, so a half-typed number is never
// written. Re-syncs when the stored value changes underneath (another machine's
// edit landing via the file watcher) but only while nothing is unsaved locally,
// so an in-progress edit is never clobbered.
function PriceField({ label, value, onSave, width = "w-16" }) {
  const stored = String(value ?? "");
  const [draft, setDraft] = useState(stored);
  const dirty = draft.trim() !== stored.trim();
  useEffect(() => {
    if (!dirty) setDraft(stored);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stored]);

  return (
    <label className="flex items-center gap-1 font-semibold text-slate-700">
      {label}
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        className={`${width} rounded-md border border-slate-200 px-1 py-0.5 text-right text-[11px]`}
      />
      {dirty && (
        <button
          onClick={() => onSave(draft.trim())}
          className="rounded-md border border-indigo-300 bg-indigo-50 px-1.5 py-0.5 text-[10px] font-bold text-indigo-700 hover:bg-indigo-100"
        >
          Save
        </button>
      )}
    </label>
  );
}

// One part inside an order card. `showDiscount` turns on the cash-sales extras:
// a second "Disc" price box plus the cost/margin readout, which is the only
// thing that differs between the two views' rows.
export function ItemRow({
  item,
  arrived,
  busy,
  history,
  showDiscount = false,
  onSavePrice,
  onSaveDiscount,
  onRemove,
}) {
  const [showHistory, setShowHistory] = useState(false);
  const qty = toNum(item.quantity);
  const cost = toNum(item.cost);
  const sell = toNum(item.allocated_for);
  const unit = showDiscount ? effectivePrice(item) : sell;
  const lineTotal = qty * unit;
  const profit = lineTotal - qty * cost;
  const margin = lineTotal > 0 ? (profit / lineTotal) * 100 : null;
  // Same guard BubbleColumn used: the stock pools aren't priced for sale, so
  // "below cost" there is noise rather than a problem.
  const belowCost = cost > 0 && sell > 0 && cost > sell;

  return (
    <div
      className={`rounded-xl border bg-white px-2.5 py-1.5 ${
        belowCost ? "border-red-300" : "border-slate-200"
      } ${busy ? "opacity-50 pointer-events-none" : ""}`}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="font-mono text-sm font-semibold text-slate-800 leading-tight truncate">
            {item.itemcode}
          </div>
          {item.notes1 && <DescriptionWithTooltip text={item.notes1} />}
        </div>
        {belowCost && (
          <span
            className="shrink-0 rounded-md border border-red-200 bg-red-50 px-1.5 py-0.5 text-[10px] font-bold text-red-600"
            title="Selling price is below recorded cost."
          >
            Below cost
          </span>
        )}
        {arrived && (
          <span
            className="shrink-0 rounded-md border border-emerald-300 bg-emerald-100 px-1.5 py-0.5 text-[10px] font-bold text-emerald-800"
            title="The purchase this part came from has arrived"
          >
            Arrived
          </span>
        )}
        {onRemove && (
          <button
            onClick={onRemove}
            className="shrink-0 rounded-md border border-rose-300 bg-rose-50 px-1.5 py-0.5 text-[10px] font-bold text-rose-700 hover:bg-rose-100"
            title="Unassign this part — it goes back to New Stock"
          >
            Remove
          </button>
        )}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500">
        <span>Qty {item.quantity}</span>
        <span>Cost {money(cost)}</span>
        <PriceField label="Sell" value={item.allocated_for} onSave={onSavePrice} />
        {showDiscount && (
          <PriceField
            label="Disc"
            value={
              item.discounted_price !== undefined && item.discounted_price !== null
                ? item.discounted_price
                : item.allocated_for
            }
            onSave={onSaveDiscount}
          />
        )}
        <button
          onClick={() => setShowHistory((v) => !v)}
          className="rounded-md border border-slate-200 bg-white px-1.5 py-0.5 text-[10px] font-semibold text-slate-500 hover:bg-slate-50"
          title="Which bubbles this part has been in"
        >
          {showHistory ? "Hide history" : "History"}
        </button>
      </div>
      {showDiscount && (
        <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px] text-slate-600">
          <span className="rounded-full border border-slate-200 bg-slate-50 px-1.5 py-0.5">
            Line {money(lineTotal)}
          </span>
          <span className="rounded-full border border-slate-200 bg-slate-50 px-1.5 py-0.5">
            Profit {money(profit)}
          </span>
          <span className="rounded-full border border-slate-200 bg-slate-50 px-1.5 py-0.5">
            Margin {margin === null ? "--" : `${margin.toFixed(1)}%`}
          </span>
        </div>
      )}
      {showHistory && (
        <div className="mt-1.5 border-t border-slate-100 pt-1.5">
          <HistoryTrail records={history || []} />
        </div>
      )}
    </div>
  );
}

// The CashPad sidebar — a vertical listing of whatever's currently sitting in
// the CashPad staging bubble, docked to the right of the card grid so it's
// visible while you work rather than needing its own tab. Collapses
// HORIZONTALLY (to a thin edge tab) rather than the vertical collapse the cards
// use, since it's meant to sit there persistently. Shared by Sales Orders and
// Cash Sales, which both dock it on the right.
export function CashPadPanel({
  items,
  arrivalMap = {},
  historyByUid,
  removingUids,
  onSavePrice,
  onRemoveItem,
  collapsed,
  onToggleCollapse,
}) {
  const total = items.reduce((sum, it) => sum + toNum(it.quantity) * toNum(it.allocated_for), 0);

  if (collapsed) {
    return (
      <button
        onClick={onToggleCollapse}
        title="Show CashPad"
        className="sticky top-0 shrink-0 flex flex-col items-center gap-2 rounded-2xl border border-emerald-300 bg-emerald-50 px-2 py-4 text-emerald-700 hover:bg-emerald-100"
      >
        <span className="text-sm">◂</span>
        <span className="text-xs font-bold [writing-mode:vertical-rl] rotate-180 whitespace-nowrap">
          CASH PAD ({items.length})
        </span>
      </button>
    );
  }

  return (
    <div className="sticky top-0 w-72 shrink-0">
      <Card className="max-h-[calc(100vh-2rem)] flex flex-col">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="text-lg font-bold text-slate-800">CashPad</div>
            <div className="text-[11px] text-slate-500">
              {items.length} part{items.length === 1 ? "" : "s"} · {money(total)}
            </div>
          </div>
          <button
            onClick={onToggleCollapse}
            title="Hide CashPad"
            className="shrink-0 rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-50"
          >
            ▸
          </button>
        </div>
        <div className="mt-3 flex-1 overflow-y-auto space-y-1.5 pr-0.5">
          {items.length === 0 && (
            <div className="px-3 py-2 text-sm text-slate-400 italic">CashPad is empty.</div>
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
              onRemove={() => onRemoveItem(it, "CashPad")}
            />
          ))}
        </div>
      </Card>
    </div>
  );
}

// Subtotal / tax / total for one card. Extra print lines count toward the
// subtotal and only taxable rows are taxed (items always are; an extra line
// opts out with taxable === false) — the same arithmetic the printed slip uses,
// so a card and its printout can't disagree.
export function computeCardTotals(items, extraLines, priceOf = (it) => toNum(it.allocated_for)) {
  const rows = [
    ...items.map((it) => ({ extension: toNum(it.quantity) * priceOf(it), taxable: true })),
    ...(Array.isArray(extraLines) ? extraLines : []).map((line) => ({
      extension: toNum(line.quantity) * toNum(line.unitPrice),
      taxable: line.taxable !== false,
    })),
  ];
  const subtotal = rows.reduce((sum, r) => sum + r.extension, 0);
  const tax = rows.reduce((sum, r) => (r.taxable ? sum + r.extension : sum), 0) * 0.13;
  return { subtotal, tax, total: subtotal + tax };
}

// The bottom-of-card money block. Outside any collapse guard in both views so a
// collapsed card still shows what it's worth.
export function CardTotals({ subtotal, tax, total, extra }) {
  return (
    <div className="mt-auto pt-2 border-t border-slate-200">
      <div className="flex items-center justify-between text-[11px] text-slate-500">
        <span>Subtotal</span>
        <span className="tabular-nums">{money(subtotal)}</span>
      </div>
      <div className="flex items-center justify-between text-[11px] text-slate-500">
        <span>Tax (13%)</span>
        <span className="tabular-nums">{money(tax)}</span>
      </div>
      <div className="mt-0.5 flex items-center justify-between text-sm font-bold text-slate-800">
        <span>Total</span>
        <span className="tabular-nums">{money(total)}</span>
      </div>
      {extra}
    </div>
  );
}
