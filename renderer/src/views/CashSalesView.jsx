// Cash Sales — the same collapsible card grid Sales Orders uses, replacing the
// draggable bubble workspace this view used to share with Stock Flow.
//
// Like Sales Orders, this view owns no data: bubbles/items come in already
// filtered to the CASH_SALE accounting path by App.jsx, and every mutation goes
// back out through the same handlers the bubble workspace called. The
// cash-sales-only machinery that used to live in BubbleColumn is here now:
// per-item discounted pricing, the bulk pricing tools, payment assignment, and
// the profit/margin readout.
import React, { useMemo, useState } from "react";
import Card from "../components/Card";
import DraftInput from "../components/DraftInput";
import api from "../api";
import { computeBubblePrintSignature } from "../utils/inventory";
import {
  CardTotals,
  CashPadPanel,
  ItemRow,
  computeCardTotals,
  effectivePrice,
  money,
  toNum,
  useItemHistoryByUid,
} from "../components/orderCardKit";

const formatPaymentLabel = (p) => {
  const date = p?.date || "No date";
  const type = p?.type || "Unknown";
  const amount = money(Number(p?.amount || 0));
  const note = p?.note ? ` • ${p.note}` : "";
  return `${date} • ${type} • ${amount}${note}`;
};

// The CAP price ladder — a flat dollar add that grows in steps with cost.
// Ported verbatim from BubbleColumn so "CAP add" prices identically.
const computeCapAdd = (base) => {
  if (base < 2) return 1;
  if (base < 5) return 2;
  if (base < 15) return 3;
  if (base < 20) return 5;
  if (base < 50) return 10;
  if (base < 70) return 15;
  if (base < 150) return 20;
  if (base < 220) return 30;
  return 0;
};

// The bulk pricing tools. Each one rewrites every part's discounted_price in
// the card; `Regular Price` puts them back to the plain sell price. The active
// label is local UI state only — nothing about which tool was last used is
// persisted, same as before.
function PricingTools({ items, onUpdateItem, assignedPayments, activeLabel, setActiveLabel }) {
  const applyMarkup = (pct) => {
    const factor = 1 + pct / 100;
    items.forEach((it) => {
      const baseCost = toNum(it.cost);
      if (!baseCost) return;
      onUpdateItem(it.uid, { discounted_price: String(Number((baseCost * factor).toFixed(2))) });
    });
    setActiveLabel(`+${pct}%`);
  };

  const applyCapAdd = () => {
    items.forEach((it) => {
      const baseCost = toNum(it.cost);
      if (!baseCost) return;
      onUpdateItem(it.uid, { discounted_price: String(Math.round(baseCost + computeCapAdd(baseCost))) });
    });
    setActiveLabel("CAP add");
  };

  const applyRegular = () => {
    items.forEach((it) => onUpdateItem(it.uid, { discounted_price: it.allocated_for ?? "" }));
    setActiveLabel("");
  };

  // Spreads the assigned payments' total across the parts proportionally, so
  // the card's subtotal lands exactly on what was actually collected (payment
  // total is tax-in, hence the /1.13). The last row absorbs the rounding
  // remainder so the pennies always add up.
  const applyMatchPayments = () => {
    const paymentSum = assignedPayments.reduce((sum, p) => sum + toNum(p?.amount), 0);
    if (paymentSum <= 0) return;
    const targetSubtotal = paymentSum / 1.13;
    const rows = items
      .map((it) => {
        const qty = toNum(it.quantity);
        return { it, qty, subtotal: qty * effectivePrice(it) };
      })
      .filter((r) => r.qty > 0);
    const currentSubtotal = rows.reduce((sum, r) => sum + r.subtotal, 0);
    if (currentSubtotal <= 0) return;

    const diff = targetSubtotal - currentSubtotal;
    let remainder = diff;
    rows.forEach((row, idx) => {
      const allocation = idx === rows.length - 1 ? remainder : diff * (row.subtotal / currentSubtotal);
      const nextUnit = (row.subtotal + allocation) / row.qty;
      const roundedUnit = Math.round(nextUnit * 100) / 100;
      remainder -= roundedUnit * row.qty - row.subtotal;
      onUpdateItem(row.it.uid, { discounted_price: String(roundedUnit.toFixed(2)) });
    });
    setActiveLabel("Match payment");
  };

  const btn =
    "rounded-lg border border-amber-300 bg-amber-50 px-2 py-1 text-[11px] font-bold text-amber-800 hover:bg-amber-100 disabled:opacity-40 disabled:cursor-not-allowed";

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <button className={btn} onClick={() => applyMarkup(10)} disabled={items.length === 0}>
        +10%
      </button>
      <button className={btn} onClick={() => applyMarkup(20)} disabled={items.length === 0}>
        +20%
      </button>
      <button className={btn} onClick={applyCapAdd} disabled={items.length === 0}>
        CAP add
      </button>
      <button className={btn} onClick={applyMatchPayments} disabled={assignedPayments.length === 0}>
        Match payment
      </button>
      <button
        className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-[11px] font-bold text-slate-600 hover:bg-slate-50"
        onClick={applyRegular}
        disabled={items.length === 0}
      >
        Regular price
      </button>
      {activeLabel && <span className="text-[11px] text-slate-500">Active: {activeLabel}</span>}
    </div>
  );
}

function PaymentsPanel({
  payments,
  paymentsLoading,
  paymentsError,
  assignedPaymentIds,
  assignedPayments,
  onUpdateAssignedPayments,
  onDeletePayment,
  bubbleId,
}) {
  const [selectedPaymentId, setSelectedPaymentId] = useState("");
  const available = (Array.isArray(payments) ? payments : []).filter(
    (p) => p?.id && !assignedPaymentIds.includes(p.id)
  );

  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50 px-2 py-1.5">
      <div className="text-[10px] uppercase tracking-wide text-slate-400">Payments</div>
      {paymentsError && (
        <div className="mt-1 rounded-lg border border-red-200 bg-red-50 px-2 py-1 text-[11px] text-red-700">
          {paymentsError}
        </div>
      )}
      <div className="mt-1 flex items-center gap-1.5">
        <select
          className="min-w-0 flex-1 rounded-md border border-slate-200 bg-white px-1.5 py-1 text-[11px]"
          value={selectedPaymentId}
          onChange={(e) => setSelectedPaymentId(e.target.value)}
          disabled={paymentsLoading || available.length === 0}
        >
          <option value="">
            {paymentsLoading
              ? "Loading payments…"
              : available.length
                ? "Select payment"
                : "No available payments"}
          </option>
          {available.map((p) => (
            <option key={p.id} value={p.id}>
              {formatPaymentLabel(p)}
            </option>
          ))}
        </select>
        <button
          onClick={() => {
            if (!selectedPaymentId) return;
            onUpdateAssignedPayments(
              bubbleId,
              Array.from(new Set([...(assignedPaymentIds || []), selectedPaymentId]))
            );
            setSelectedPaymentId("");
          }}
          disabled={!selectedPaymentId || paymentsLoading}
          className="shrink-0 rounded-md bg-indigo-600 px-2 py-1 text-[11px] font-bold text-white disabled:opacity-40"
        >
          Assign
        </button>
      </div>
      {assignedPayments.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {assignedPayments.map((p) => (
            <span
              key={p.id}
              className="flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[10px] text-slate-700"
            >
              {formatPaymentLabel(p)}
              <button
                onClick={() =>
                  onUpdateAssignedPayments(
                    bubbleId,
                    (assignedPaymentIds || []).filter((id) => id !== p.id)
                  )
                }
                className="text-slate-400 hover:text-slate-700"
                title="Unassign payment"
              >
                ×
              </button>
              {onDeletePayment && (
                <button
                  onClick={() => onDeletePayment(p.id)}
                  className="text-red-400 hover:text-red-600"
                  title="Delete payment"
                >
                  🗑
                </button>
              )}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function CashSaleCard({
  bubble,
  items,
  meta,
  extraLines,
  isDefaultBubble,
  historyByUid,
  expanded,
  onToggle,
  onUpdateBubbleNotes,
  onNotesCommit,
  onRequestPrint,
  onSetFlag,
  onUpdateItem,
  onRemoveItem,
  removingUids,
  payments,
  paymentsLoading,
  paymentsError,
  assignedPaymentIds,
  onUpdateAssignedPayments,
  onDeletePayment,
  onArchiveSale,
  onSageSalesInvoice,
  onSetInvoiceNumber,
  sageCustomerCode,
}) {
  const [sageSending, setSageSending] = useState(false);
  const [activePricingLabel, setActivePricingLabel] = useState("");

  // Cash sales price on the discounted figure, so the card total is what the
  // customer actually pays rather than the list price.
  const { subtotal, tax, total } = computeCardTotals(items, extraLines, effectivePrice);
  const cost = items.reduce((sum, it) => sum + toNum(it.quantity) * toNum(it.cost), 0);
  const profit = subtotal - cost;
  const margin = subtotal > 0 ? (profit / subtotal) * 100 : null;

  const assignedPayments = (assignedPaymentIds || [])
    .map((id) => (Array.isArray(payments) ? payments : []).find((p) => p?.id === id))
    .filter(Boolean);
  const paidTotal = assignedPayments.reduce((sum, p) => sum + toNum(p?.amount), 0);
  // Compared against the tax-in total, since that's what a payment covers.
  const paymentGap = assignedPayments.length > 0 ? paidTotal - total : null;

  const currentSignature = computeBubblePrintSignature(bubble.notes, items, extraLines);
  const printedSignature = meta?.printedSignature || "";
  const everPrinted = Boolean(printedSignature);
  const printBadge = !everPrinted
    ? { label: "Not printed", cls: "bg-slate-100 text-slate-500 border-slate-300" }
    : printedSignature === currentSignature
      ? { label: "Printed", cls: "bg-emerald-100 text-emerald-700 border-emerald-300" }
      : { label: "Changed since print", cls: "bg-amber-100 text-amber-800 border-amber-300" };

  return (
    <Card className="relative hover:z-20 h-full flex flex-col">
      <button onClick={onToggle} className="w-full flex items-start justify-between gap-2 text-left">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="text-slate-400 text-xs">{expanded ? "▾" : "▸"}</span>
            <span className="text-xl font-bold text-slate-800 truncate">{bubble.name}</span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <span className="px-1.5 py-0.5 rounded-full border text-[11px] font-semibold bg-emerald-50 text-emerald-700 border-emerald-200">
              Cash Sales
            </span>
            <span className="text-[11px] font-semibold text-slate-600">
              {items.length} part{items.length === 1 ? "" : "s"}
            </span>
          </div>
        </div>
      </button>

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

        {/* The stock pools aren't customer paperwork, so they never print —
            same rule the bubble workspace applied via showPrintAction. */}
        {!isDefaultBubble && (
          <>
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
          </>
        )}
      </div>

      {expanded && (
        <div className="mt-3 flex-1 space-y-2">
          <DraftInput
            as="textarea"
            value={bubble.notes || ""}
            onCommit={(next) => {
              onUpdateBubbleNotes(bubble.id, next);
              onNotesCommit(bubble.id, next);
            }}
            placeholder="Notes for this sale…"
            rows={2}
            className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm resize-y"
          />

          <PricingTools
            items={items}
            onUpdateItem={onUpdateItem}
            assignedPayments={assignedPayments}
            activeLabel={activePricingLabel}
            setActiveLabel={setActivePricingLabel}
          />

          <PaymentsPanel
            payments={payments}
            paymentsLoading={paymentsLoading}
            paymentsError={paymentsError}
            assignedPaymentIds={assignedPaymentIds || []}
            assignedPayments={assignedPayments}
            onUpdateAssignedPayments={onUpdateAssignedPayments}
            onDeletePayment={onDeletePayment}
            bubbleId={bubble.id}
          />

          <div className="space-y-1.5">
            {items.length === 0 && (
              <div className="px-3 py-2 text-sm text-slate-400 italic">Nothing in this sale.</div>
            )}
            {items.map((it) => (
              <ItemRow
                key={it.uid}
                item={it}
                busy={removingUids.has(it.uid)}
                history={historyByUid.get(it.uid) || []}
                showDiscount
                onSavePrice={(next) => onUpdateItem(it.uid, { allocated_for: next })}
                onSaveDiscount={(next) => onUpdateItem(it.uid, { discounted_price: next })}
                onRemove={() => onRemoveItem(it, bubble.name)}
              />
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 pt-2">
            <button
              disabled={sageSending || items.length === 0}
              onClick={async () => {
                const paymentType = assignedPayments[0]?.type || "";
                setSageSending(true);
                try {
                  await onSageSalesInvoice(bubble.name, sageCustomerCode, bubble.notes || "", paymentType);
                } finally {
                  setSageSending(false);
                }
              }}
              className="rounded-lg border border-green-300 bg-white px-2.5 py-1 text-xs font-semibold text-green-800 hover:bg-green-50 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {sageSending ? "Sending…" : "Send to Sage Sales"}
            </button>

            {/* The invoice number the AHK read off the Sage form. Editable
                because that read can miss (a form that wasn't where the script
                expected), and clearable because a run that turned out not to
                count shouldn't leave a number behind. Both write through to
                the run-log row the report prints from. */}
            {(meta?.sageInvoiceNumber || meta?.sageRunId) && (
              <div className="flex items-center gap-1">
                <span className="text-[11px] font-semibold text-slate-500">Sage inv</span>
                <DraftInput
                  value={meta.sageInvoiceNumber || ""}
                  onCommit={(next) => onSetInvoiceNumber(bubble.id, next)}
                  placeholder="not captured"
                  className="w-28 rounded-md border border-slate-200 px-1.5 py-0.5 text-[11px] font-mono"
                />
                {meta.sageInvoiceNumber && (
                  <button
                    onClick={() => onSetInvoiceNumber(bubble.id, "")}
                    className="text-slate-400 hover:text-red-600 text-[11px]"
                    title="Clear the invoice number"
                  >
                    ✕
                  </button>
                )}
              </div>
            )}

            <span className="flex-1" />
            {onArchiveSale && (
              <button
                onClick={() => onArchiveSale(bubble.id)}
                className="rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                title="This sale is done — move it and its parts to the Archive, history intact"
              >
                Archive Sale
              </button>
            )}
          </div>
        </div>
      )}

      <CardTotals
        subtotal={subtotal}
        tax={tax}
        total={total}
        extra={
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 border-t border-slate-100 pt-1 text-[11px]">
            <span className="text-slate-500">
              Profit <span className="font-semibold text-slate-700">{money(profit)}</span>
            </span>
            <span className="text-slate-500">
              Margin{" "}
              <span className="font-semibold text-slate-700">
                {margin === null ? "--" : `${margin.toFixed(1)}%`}
              </span>
            </span>
            {paymentGap !== null && (
              <span
                className={`font-semibold ${
                  Math.abs(paymentGap) < 0.01 ? "text-emerald-600" : "text-amber-600"
                }`}
                title="Assigned payments minus this sale's total"
              >
                {Math.abs(paymentGap) < 0.01
                  ? "Payment matches"
                  : `Payment off by ${money(paymentGap)}`}
              </span>
            )}
          </div>
        }
      />
    </Card>
  );
}

export default function CashSalesView({
  bubbles,
  itemsByBubble,
  bubbleMeta,
  defaultBubbleNames,
  extraLinesByBubble,
  addBubble,
  onUpdateBubbleNotes,
  onBubbleNotesBlur,
  onRequestPrint,
  onSetBubbleFlag,
  onUpdateItem,
  onArchiveSale,
  onSageSalesInvoice,
  onSetInvoiceNumber,
  sageCustomerCode = "CAS202",
  payments = [],
  paymentsLoading = false,
  paymentsError = "",
  bubblePaymentAssignments = {},
  onUpdateBubblePayments,
  onDeletePayment,
  // Passed in separately rather than read out of itemsByBubble: that map is
  // filtered to the CASH_SALE accounting path, but CashPad holds parts folded
  // in from Sales Orders that are still on the OUTSTANDING path, so looking it
  // up here would come back empty.
  cashPadItems = [],
}) {
  const [collapsedIds, setCollapsedIds] = useState(() => new Set());
  const [cashPadCollapsed, setCashPadCollapsed] = useState(false);
  const [search, setSearch] = useState("");
  const [newName, setNewName] = useState("");
  const [error, setError] = useState("");
  const [removingUids, setRemovingUids] = useState(() => new Set());
  const historyByUid = useItemHistoryByUid("cash-sales");

  // No accounting-path filtering here: App.jsx already hands this view only the
  // CASH_SALE bubbles, exactly as it did the bubble workspace, so which cards
  // appear is unchanged by the switch away from bubbles.
  //
  // Ordered oldest-first, so the sales that have been sitting longest are the
  // ones you meet at the top. A bubble carries no date of its own, so the key
  // is the payment it settles — that IS the sale's date. A sale with no payment
  // assigned yet falls back to when its parts last moved, and one with neither
  // sorts to the bottom by name rather than landing somewhere arbitrary.
  const cards = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const paymentById = new Map(
      (Array.isArray(payments) ? payments : []).filter((p) => p?.id).map((p) => [p.id, p])
    );

    const saleTimeMs = (bubbleId, items) => {
      const times = (bubblePaymentAssignments[bubbleId] || [])
        .map((id) => Date.parse(paymentById.get(id)?.date))
        .filter((t) => !Number.isNaN(t));
      if (times.length) return Math.min(...times);
      const moved = items
        .map((it) => Date.parse(it?.last_moved_at))
        .filter((t) => !Number.isNaN(t));
      // MAX_SAFE_INTEGER rather than Infinity: two undated cards would subtract
      // to NaN and leave the comparator inconsistent, so they'd never reach the
      // name tie-break below.
      return moved.length ? Math.min(...moved) : Number.MAX_SAFE_INTEGER;
    };

    return bubbles
      // CashPad has the docked panel on the right and is a staging pool, not a
      // sale. It's on the CASH_SALE path like everything else here, so without
      // this it also renders as a card in the grid — the same list twice. Same
      // exclusion Sales Orders makes.
      .filter((b) => (b.name || "").trim().toUpperCase() !== "CASHPAD")
      .filter((b) => !needle || (b.name || "").toLowerCase().includes(needle))
      .map((b) => {
        const items = itemsByBubble.get(b.name) || [];
        return {
          bubble: b,
          items,
          meta: bubbleMeta[b.id] || bubbleMeta[b.name] || {},
          extraLines: extraLinesByBubble?.[b.id] || [],
          isDefaultBubble: defaultBubbleNames.has(b.name),
          sortKey: saleTimeMs(b.id, items),
        };
      })
      .sort(
        (a, b) =>
          a.sortKey - b.sortKey || (a.bubble.name || "").localeCompare(b.bubble.name || "")
      );
  }, [
    bubbles,
    itemsByBubble,
    bubbleMeta,
    extraLinesByBubble,
    defaultBubbleNames,
    search,
    payments,
    bubblePaymentAssignments,
  ]);

  const toggle = (id) =>
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const handleRemoveItem = async (item, bubbleName) => {
    const ok = await api.confirm(
      `Remove ${item.itemcode} from ${bubbleName}?`,
      "It goes back to New Stock and is no longer part of this sale."
    );
    if (!ok) return;
    setError("");
    setRemovingUids((prev) => new Set(prev).add(item.uid));
    try {
      const res = await api.unassignOrderItem({ uid: item.uid });
      if (!res?.ok) setError(res?.error || "Failed to remove this part.");
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
            placeholder="Search cash sales by name…"
            className="flex-1 min-w-[14rem] rounded-xl border border-slate-200 px-3 py-1.5 text-sm"
          />
          <div className="flex items-center gap-2">
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="New cash sale name"
              className="w-48 rounded-xl border border-slate-200 px-3 py-1.5 text-sm"
            />
            <button
              onClick={() => {
                // addBubble stamps the CASH_SALE path from the active view.
                addBubble(newName);
                setNewName("");
              }}
              className="rounded-xl bg-emerald-600 px-4 py-1.5 text-sm font-semibold text-white shadow hover:bg-emerald-700"
            >
              Add
            </button>
          </div>
          <button
            onClick={() => setCollapsedIds(new Set())}
            className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-sm font-semibold text-slate-600 hover:bg-slate-50"
          >
            Expand all
          </button>
          <button
            onClick={() => setCollapsedIds(new Set(cards.map((c) => c.bubble.id)))}
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

      {cards.length === 0 && (
        <Card>
          <div className="text-sm text-slate-500 italic">No cash sales yet.</div>
        </Card>
      )}

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
        {cards.map(({ bubble, items, meta, extraLines, isDefaultBubble }) => (
          <CashSaleCard
            key={bubble.id}
            bubble={bubble}
            items={items}
            meta={meta}
            extraLines={extraLines}
            isDefaultBubble={isDefaultBubble}
            historyByUid={historyByUid}
            expanded={!collapsedIds.has(bubble.id)}
            onToggle={() => toggle(bubble.id)}
            onUpdateBubbleNotes={onUpdateBubbleNotes}
            onNotesCommit={onBubbleNotesBlur}
            onRequestPrint={onRequestPrint}
            onSetFlag={onSetBubbleFlag}
            onUpdateItem={onUpdateItem}
            onRemoveItem={handleRemoveItem}
            removingUids={removingUids}
            payments={payments}
            paymentsLoading={paymentsLoading}
            paymentsError={paymentsError}
            assignedPaymentIds={bubblePaymentAssignments[bubble.id] || []}
            onUpdateAssignedPayments={onUpdateBubblePayments}
            onDeletePayment={onDeletePayment}
            onArchiveSale={onArchiveSale}
            onSageSalesInvoice={onSageSalesInvoice}
            onSetInvoiceNumber={onSetInvoiceNumber}
            sageCustomerCode={sageCustomerCode}
          />
        ))}
        </div>
      </div>

      <CashPadPanel
        items={cashPadItems}
        historyByUid={historyByUid}
        removingUids={removingUids}
        onSavePrice={(uid, next) => onUpdateItem(uid, { allocated_for: next })}
        onRemoveItem={handleRemoveItem}
        collapsed={cashPadCollapsed}
        onToggleCollapse={() => setCashPadCollapsed((v) => !v)}
      />
    </div>
  );
}
