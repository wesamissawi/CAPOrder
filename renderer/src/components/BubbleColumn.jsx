// src/components/BubbleColumn.jsx
import React from "react";
import Card from "./Card";
import LabeledField from "./LabeledField"; 
import LabeledInput from "./LabeledInput"; // adjust path as needed



import { itemKey } from "../utils/inventory";

const currencyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

const toNumber = (value) => {
  const num = parseFloat(value);
  return Number.isFinite(num) ? num : 0;
};

const FALLBACK_DELETE_INFO = ["NEW STOCK", "SHELF", "CASH SALES", "RETURNS"];

export default function BubbleColumn({
  bubble,
  items,
  bubbles,
  expanded,
  onToggleExpand,
  onDragStartItem,
  onDropOnBubble,
  onUpdateItem,
  onUpdateBubbleNotes,
  onBubbleNotesBlur,
  extraLines = [],
  onSplitItem,
  onConsolidateItems,
  onDeleteBubble,
  deleteTargets = FALLBACK_DELETE_INFO,
  onStartBubbleMove,
  onStartBubbleResize,
  onActivateBubble,
  onMoveToSage,
  onMoveToCashSales,
  isDefaultBubble = false,
  widthPixels = 360,
  canArchive = false,
  onArchiveBubble,

  onFieldFocus,
  onFieldBlur,
  showPrintAction = false,
  onRequestPrint,
  showCashSalesMetrics = false,
  payments = [],
  paymentsLoading = false,
  paymentsError = "",
  assignedPaymentIds = [],
  onUpdateAssignedPayments,
  onDeletePayment,
  showSageSalesAction = false,
  defaultSageCustomerCode = "",
  onSageSalesInvoice,
  onDeleteBubbleItems,
  onRenameBubble,
  // bubble edit lock props
  isEditing = false,
  lockOwner = null,       // machine name that owns the lock, null if free
  incomingRequest = null, // { from, requestedAt } — another machine wants in
  outgoingRequest = null, // { startedAt } — we sent a request, waiting
  onRequestEdit,
  onDoneEditing,
  onRespondToRequest,
}) {
  const { id, name, notes } = bubble;
  const bubbleKey = name || id;
  const list = items || [];
  // Default bubbles (New Stock, Shelf, etc.) are always editable — no lock needed.
  // User-created bubbles require clicking Edit first.
  const canEdit = isEditing || isDefaultBubble;
  const [splitDrafts, setSplitDrafts] = React.useState({});
  const [renameDraft, setRenameDraft] = React.useState(null);
  const [requestCountdown, setRequestCountdown] = React.useState(null);

  // Cancel any in-progress rename if edit access is lost
  React.useEffect(() => {
    if (!isEditing) setRenameDraft(null);
  }, [isEditing]);

  // Countdown timer driven by incomingRequest or outgoingRequest
  React.useEffect(() => {
    const startedAt = incomingRequest?.requestedAt || outgoingRequest?.startedAt;
    if (!startedAt) { setRequestCountdown(null); return; }
    const tick = () => {
      const remaining = Math.max(0, 5 - Math.floor((Date.now() - startedAt) / 1000));
      setRequestCountdown(remaining);
    };
    tick();
    const id = setInterval(tick, 500);
    return () => clearInterval(id);
  }, [incomingRequest, outgoingRequest]);
  const [showAdvancedTools, setShowAdvancedTools] = React.useState(false);
  const [selectedPaymentId, setSelectedPaymentId] = React.useState("");
  const [showDiscountMetrics, setShowDiscountMetrics] = React.useState(false);
  const [activeDiscountPct, setActiveDiscountPct] = React.useState(null);
  const [activePricingLabel, setActivePricingLabel] = React.useState("");
  const [arCustomerCode, setArCustomerCode] = React.useState("");
  const [sageSalesRunning, setSageSalesRunning] = React.useState(false);
  const [lockedToast, setLockedToast] = React.useState(false);
  const toastTimerRef = React.useRef(null);

  function showLockedToast() {
    setLockedToast(true);
    clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setLockedToast(false), 3000);
  }

  const allowDelete = !!onDeleteBubble && !isDefaultBubble;
  const deleteOptions = React.useMemo(() => {
    if (!allowDelete) return [];
    const allowed = deleteTargets || [];
    return allowed.filter((option) => option && option !== name);
  }, [allowDelete, deleteTargets, name]);
  const [deleteSelection, setDeleteSelection] = React.useState(
    deleteOptions[0] || ""
  );
  React.useEffect(() => {
    if (deleteOptions.length === 0) {
      setDeleteSelection("");
      return;
    }
    setDeleteSelection((prev) =>
      deleteOptions.includes(prev) ? prev : deleteOptions[0]
    );
  }, [deleteOptions]);

  const extraLineRows = Array.isArray(extraLines)
    ? extraLines.map((line) => {
        const qty = toNumber(line.quantity);
        const price = toNumber(line.unitPrice);
        return {
          extension: qty * price,
          taxable: line.taxable !== false,
        };
      })
    : [];
  const itemRows = list.map((it) => {
    const qty = toNumber(it.quantity);
    const price = toNumber(it.allocated_for);
    return {
      extension: qty * price,
      taxable: true,
    };
  });
  const rows = [...itemRows, ...extraLineRows];
  const bubbleSubtotal = rows.reduce((sum, row) => sum + row.extension, 0);
  const bubbleTax = rows.reduce((sum, row) => (row.taxable ? sum + row.extension : sum), 0) * 0.13;
  const bubbleTotal = bubbleSubtotal + bubbleTax;
  const cashSalesTotals = showCashSalesMetrics
    ? list.reduce(
        (acc, it) => {
          const qty = toNumber(it.quantity);
          const baseSales = toNumber(it.allocated_for);
          const cost = toNumber(it.cost);
          acc.sales += qty * baseSales;
          acc.cost += qty * cost;
          return acc;
        },
        { sales: 0, cost: 0 }
      )
    : { sales: 0, cost: 0 };
  const cashSalesProfit = cashSalesTotals.sales - cashSalesTotals.cost;
  const cashSalesMargin =
    cashSalesTotals.sales > 0 ? (cashSalesProfit / cashSalesTotals.sales) * 100 : null;
  const discountedTotals = showCashSalesMetrics
    ? list.reduce(
        (acc, it) => {
          const qty = toNumber(it.quantity);
          const baseSales = toNumber(it.allocated_for);
          const discounted =
            it.discounted_price !== undefined && it.discounted_price !== null && it.discounted_price !== ""
              ? toNumber(it.discounted_price)
              : baseSales;
          const cost = toNumber(it.cost);
          acc.sales += qty * discounted;
          acc.cost += qty * cost;
          return acc;
        },
        { sales: 0, cost: 0 }
      )
    : { sales: 0, cost: 0 };
  const discountedProfit = discountedTotals.sales - discountedTotals.cost;
  const discountedMargin =
    discountedTotals.sales > 0 ? (discountedProfit / discountedTotals.sales) * 100 : null;
  const discountedSubtotal = discountedTotals.sales;
  const discountedTax = discountedSubtotal * 0.13;
  const discountedTotal = discountedSubtotal + discountedTax;
  const hiddenCount = extraLineRows.length;
  const countLabelText = `${list.length} items${hiddenCount ? ` (${hiddenCount} hidden)` : ""}`;
  const showSummary = !isDefaultBubble;
  const moveActionsAllowed =
    !(
      isDefaultBubble &&
      ["CASH SALES", "SHELF", "RETURNS"].includes((name || "").toUpperCase())
    );
  const hasAdvancedActions =
    onConsolidateItems ||
    (moveActionsAllowed && onMoveToSage) ||
    (moveActionsAllowed && onMoveToCashSales) ||
    (canArchive && onArchiveBubble) ||
    (allowDelete && deleteOptions.length > 0);

  const updateSplitDraft = (uid, patch) => {
    setSplitDrafts((prev) => {
      const current = prev[uid] || {};
      return {
        ...prev,
        [uid]: {
          quantity: "",
          target: "",
          ...current,
          ...patch,
        },
      };
    });
  };

  const resetSplitDraft = (uid) => {
    setSplitDrafts((prev) => {
      if (!prev[uid]) return prev;
      const next = { ...prev };
      delete next[uid];
      return next;
    });
  };

  function allowDrop(e) {
    e.preventDefault();
  }

  function handleDrop(e) {
    e.preventDefault();
    if (!canEdit) return;
    onDropOnBubble(name);
  }

  function handleGrabBubble(e) {
    e.preventDefault();
    e.stopPropagation();
    const point = "touches" in e ? e.touches[0] : e;
    onStartBubbleMove?.(bubbleKey, point.clientX, point.clientY);
  }

  function handleResizeStart(e) {
    e.preventDefault();
    e.stopPropagation();
    const point = "touches" in e ? e.touches[0] : e;
    onStartBubbleResize?.(bubbleKey, point.clientX);
  }

  function handleActivate(e) {
    onActivateBubble?.(bubbleKey);
  }

  const applyMarkupToBubble = (pct) => {
    if (!onUpdateItem) return;
    const factor = 1 + pct / 100;
    list.forEach((it) => {
      const uid = itemKey(it);
      const baseCost = toNumber(it.cost);
      if (!Number.isFinite(baseCost)) return;
      const markedUp = Number((baseCost * factor).toFixed(2));
      onUpdateItem(uid, { discounted_price: String(markedUp) });
    });
    setShowDiscountMetrics(true);
    setActiveDiscountPct(pct);
    setActivePricingLabel(`+${pct}%`);
  };

  const applyRegularPricing = () => {
    if (!onUpdateItem) return;
    list.forEach((it) => {
      const uid = itemKey(it);
      onUpdateItem(uid, { discounted_price: it.allocated_for ?? "" });
    });
    setShowDiscountMetrics(false);
    setActiveDiscountPct(null);
    setActivePricingLabel("");
  };

  const applyCapAddToBubble = () => {
    if (!onUpdateItem) return;
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
    list.forEach((it) => {
      const uid = itemKey(it);
      const baseCost = toNumber(it.cost);
      if (!Number.isFinite(baseCost)) return;
      const add = computeCapAdd(baseCost);
      const nextPrice = Math.round(baseCost + add);
      onUpdateItem(uid, { discounted_price: String(nextPrice) });
    });
    setShowDiscountMetrics(true);
    setActiveDiscountPct(null);
    setActivePricingLabel("CAP add");
  };

  const paymentOptions = Array.isArray(payments) ? payments : [];
  const assignedPayments = assignedPaymentIds
    .map((id) => paymentOptions.find((p) => p?.id === id))
    .filter(Boolean);
  const availablePayments = paymentOptions.filter((p) => p?.id && !assignedPaymentIds.includes(p.id));
  const formatPaymentLabel = (p) => {
    const date = p?.date || "No date";
    const type = p?.type || "Unknown";
    const amount = currencyFormatter.format(Number(p?.amount || 0));
    const note = p?.note ? ` • ${p.note}` : "";
    return `${date} • ${type} • ${amount}${note}`;
  };

  const handleAssignPayment = () => {
    if (!selectedPaymentId || !onUpdateAssignedPayments) return;
    const next = Array.from(new Set([...(assignedPaymentIds || []), selectedPaymentId]));
    onUpdateAssignedPayments(bubble.id, next);
    setSelectedPaymentId("");
  };

  const handleRemovePayment = (paymentId) => {
    if (!onUpdateAssignedPayments) return;
    const next = (assignedPaymentIds || []).filter((id) => id !== paymentId);
    onUpdateAssignedPayments(bubble.id, next);
  };

  const applyMatchPaymentsToBubble = () => {
    if (!onUpdateItem) return;
    const paymentSum = assignedPayments.reduce((sum, p) => sum + toNumber(p?.amount), 0);
    if (!Number.isFinite(paymentSum) || paymentSum <= 0) return;
    const targetSubtotal = paymentSum / 1.13;
    const rows = list
      .map((it) => {
        const qty = toNumber(it.quantity);
        const baseSales = toNumber(it.allocated_for);
        const discounted =
          it.discounted_price !== undefined && it.discounted_price !== null && it.discounted_price !== ""
            ? toNumber(it.discounted_price)
            : baseSales;
        const subtotal = qty * discounted;
        return { it, qty, discounted, subtotal };
      })
      .filter((r) => r.qty > 0);
    const currentSubtotal = rows.reduce((sum, r) => sum + r.subtotal, 0);
    if (currentSubtotal <= 0) return;

    const diff = targetSubtotal - currentSubtotal;
    let remainder = diff;

    rows.forEach((row, idx) => {
      const share = row.subtotal / currentSubtotal;
      const allocation = idx === rows.length - 1 ? remainder : diff * share;
      const nextSubtotal = row.subtotal + allocation;
      const nextUnit = row.qty > 0 ? nextSubtotal / row.qty : row.discounted;
      const roundedUnit = Math.round(nextUnit * 100) / 100;
      const roundedSubtotal = roundedUnit * row.qty;
      remainder -= roundedSubtotal - row.subtotal;
      onUpdateItem(itemKey(row.it), { discounted_price: String(roundedUnit.toFixed(2)) });
    });

    setShowDiscountMetrics(true);
    setActiveDiscountPct(null);
    setActivePricingLabel("Match payment");
  };

  return (
    <div
      className="relative flex flex-col gap-3 rounded-3xl p-4 sm:p-5 border border-slate-300 shadow-xl bg-gradient-to-br from-indigo-50 to-cyan-50 min-w-[280px]"
      onDragOver={allowDrop}
      onDrop={handleDrop}
      onMouseDownCapture={handleActivate}
      onTouchStartCapture={handleActivate}
      onClick={(e) => {
        if (!canEdit && e.target.readOnly) showLockedToast();
      }}
    >
      {/* Incoming request banner */}
      {incomingRequest && (
        <div className="rounded-2xl border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 flex flex-wrap items-center gap-2">
          <span className="font-semibold">{incomingRequest.from}</span>
          <span>wants edit access</span>
          {requestCountdown !== null && (
            <span className="font-mono text-amber-600">({requestCountdown}s)</span>
          )}
          <div className="ml-auto flex gap-2">
            <button
              type="button"
              className="px-3 py-1 rounded-full text-xs font-semibold bg-emerald-600 text-white hover:bg-emerald-700"
              onClick={() => onRespondToRequest?.(true)}
            >
              Allow
            </button>
            <button
              type="button"
              className="px-3 py-1 rounded-full text-xs font-semibold bg-red-500 text-white hover:bg-red-600"
              onClick={() => onRespondToRequest?.(false)}
            >
              Deny
            </button>
          </div>
        </div>
      )}

      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <div className={`w-3 h-3 rounded-full ${isEditing ? 'bg-emerald-400 animate-pulse' : 'bg-slate-300'}`} />
          {onRenameBubble && !isDefaultBubble && isEditing && renameDraft !== null ? (
            <input
              autoFocus
              className="text-xl font-semibold text-slate-800 border-b-2 border-indigo-400 bg-transparent outline-none w-40"
              value={renameDraft}
              onChange={(e) => setRenameDraft(e.target.value)}
              onBlur={() => {
                const trimmed = renameDraft.trim();
                if (trimmed && trimmed !== name) onRenameBubble(id, trimmed);
                setRenameDraft(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.target.blur();
                if (e.key === 'Escape') setRenameDraft(null);
              }}
            />
          ) : (
            <h2
              className={`text-xl font-semibold text-slate-800 ${onRenameBubble && !isDefaultBubble && isEditing ? 'cursor-pointer hover:text-indigo-600' : ''}`}
              title={onRenameBubble && !isDefaultBubble && isEditing ? 'Click to rename' : undefined}
              onClick={() => { if (onRenameBubble && !isDefaultBubble && isEditing) setRenameDraft(name); }}
            >
              {name}
            </h2>
          )}
          <span className="text-xs px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-700 border border-indigo-200">
            {countLabelText}
          </span>
        </div>
        <div className="flex items-center gap-2 flex-wrap justify-end">
          {/* Lock status indicators */}
          {isEditing && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 border border-emerald-200">
              Editing
            </span>
          )}
          {!isEditing && lockOwner && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-slate-100 text-slate-500 border border-slate-200">
              🔒 {lockOwner}
            </span>
          )}
          {outgoingRequest && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 border border-amber-200">
              Waiting{requestCountdown !== null ? ` ${requestCountdown}s` : '...'}
            </span>
          )}

          {/* Edit / Done toggle — not shown for default bubbles */}
          {!isDefaultBubble && onRequestEdit && !outgoingRequest && (
            isEditing ? (
              <button
                type="button"
                className="text-xs font-semibold px-3 py-1 rounded-full border border-emerald-300 bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
                onClick={() => onDoneEditing?.()}
              >
                Done
              </button>
            ) : (
              <button
                type="button"
                className={`text-xs font-semibold px-3 py-1 rounded-full border ${
                  lockOwner
                    ? 'border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100'
                    : 'border-indigo-200 bg-white text-indigo-700 hover:bg-indigo-50'
                }`}
                onClick={() => onRequestEdit?.()}
              >
                {lockOwner ? 'Request Edit' : 'Edit'}
              </button>
            )
          )}

          <button
            type="button"
            className="text-xs font-semibold uppercase tracking-wide px-3 py-1 rounded-full border border-slate-300 text-slate-600 hover:bg-white cursor-move"
            onMouseDown={handleGrabBubble}
            onTouchStart={handleGrabBubble}
            title="Drag bubble"
          >
            ⇕
          </button>
          {showPrintAction && onRequestPrint && (
            <button
              className="text-xs font-semibold uppercase tracking-wide px-3 py-1 rounded-full border border-slate-300 text-slate-700 hover:bg-slate-100"
              onClick={() => onRequestPrint(bubble)}
              title="Print this bubble"
            >
              Print
            </button>
          )}
        </div>
      </div>

      {showSummary && (
        <div className="flex flex-wrap gap-4 text-sm text-slate-700 bg-white/60 border border-indigo-100 rounded-2xl p-3">
          <div className="flex flex-col">
            <span className="text-xs uppercase tracking-wide text-slate-400">
              Subtotal
            </span>
            <span className="font-semibold">{currencyFormatter.format(bubbleSubtotal)}</span>
          </div>
          <div className="flex flex-col">
            <span className="text-xs uppercase tracking-wide text-slate-400">
              Tax (13%)
            </span>
            <span className="font-semibold">{currencyFormatter.format(bubbleTax)}</span>
          </div>
          <div className="flex flex-col">
            <span className="text-xs uppercase tracking-wide text-slate-400">
              Total
            </span>
            <span className="font-semibold text-indigo-700">
              {currencyFormatter.format(bubbleTotal)}
            </span>
          </div>
        </div>
      )}
      <textarea
        rows={2}
        className={`mt-2 w-full rounded-xl border p-2 text-sm focus:outline-none ${canEdit ? 'border-slate-300 focus:ring-2 focus:ring-indigo-300' : 'border-slate-200 bg-slate-50 text-slate-500 cursor-default'}`}
        placeholder={canEdit ? "Bubble notes…" : ""}
        value={notes}
        readOnly={!canEdit}
        onChange={(e) => canEdit && onUpdateBubbleNotes(id, e.target.value)}
        onFocus={onFieldFocus}
        onBlur={(e) => {
          onFieldBlur?.(e);
          if (canEdit) onBubbleNotesBlur?.(id);
        }}
      />

      <div className="grid grid-cols-1 gap-3">
        {list.map((it) => {
          const uid = itemKey(it);
          const qty = toNumber(it.quantity);
          const salesPrice = toNumber(it.allocated_for);
          const discountedPrice =
            it.discounted_price !== undefined && it.discounted_price !== null && it.discounted_price !== ""
              ? toNumber(it.discounted_price)
              : salesPrice;
          const cost = toNumber(it.cost);
          const diff = salesPrice - cost;
          const marginPct = salesPrice > 0 ? (diff / salesPrice) * 100 : null;
          const itemSubtotal = qty * salesPrice;
          const discountedTotal = qty * discountedPrice;
          const profitTotal = discountedTotal - qty * cost;
          const profitMargin = discountedTotal > 0 ? (profitTotal / discountedTotal) * 100 : null;
          const showWarning =
            !["NEW STOCK RETURNS", "SHELF"].includes((name || "").toUpperCase()) && cost > salesPrice;
          const splitDraft = splitDrafts[uid] || {};
          const splitAmount = splitDraft.quantity ?? "";
          const splitTarget = splitDraft.target || it.allocated_to;
          const splitDisabled = qty < 2;
          const splitAmountNum = Math.floor(parseFloat(splitAmount));
          const canSplit =
            !splitDisabled &&
            Number.isFinite(splitAmountNum) &&
            splitAmountNum > 0 &&
            splitAmountNum < qty;

          return (
            <Card
              key={uid}
              className={`relative bg-white transition-shadow duration-200 ${canEdit ? 'hover:shadow-xl cursor-grab' : 'cursor-default'} ${
                !["NEW STOCK RETURNS", "SHELF"].includes((name || "").toUpperCase()) &&
                toNumber(it.cost) > toNumber(it.allocated_for || 0)
                  ? "border-2 border-red-300 shadow-red-200"
                  : ""
              }`}
              draggable={canEdit}
              onDragStart={(e) => {
                if (!canEdit) { e.preventDefault(); return; }
                e.stopPropagation();
                onDragStartItem(uid);
              }}
            >
              <div className="flex flex-wrap items-center gap-3">
                <div className="text-base font-semibold text-slate-800">
                  {it.itemcode}
                </div>
                <div className="flex items-center gap-1 text-sm text-slate-600">
                  <span className="font-semibold text-slate-800">x</span>
                  {qty || 0}
                </div>
                <div className="flex items-center gap-1 text-sm text-slate-600">
                  <span className="text-xs font-semibold text-slate-500">$</span>
                  <input
                    type="text"
                    step="0.01"
                    inputMode="decimal"
                    className={`w-14 border rounded-lg p-1 text-sm text-center ${!canEdit ? 'bg-slate-50 text-slate-500' : ''}`}
                    readOnly={!canEdit}
                    onFocus={(e) => { if (canEdit) { e.target.select(); onFieldFocus?.(e); } }}
                    value={it.allocated_for ?? ""}
                    onChange={(e) => canEdit && onUpdateItem(uid, { allocated_for: e.target.value })}
                    onBlur={canEdit ? onFieldBlur : undefined}
                  />
                </div>
                {showCashSalesMetrics && (
                  <div className="flex items-center gap-1 text-sm text-slate-600">
                    <span className="text-xs font-semibold text-slate-500">Disc</span>
                    <input
                      type="text"
                      step="0.01"
                      inputMode="decimal"
                      className={`w-16 border rounded-lg p-1 text-sm text-center ${!canEdit ? 'bg-slate-50 text-slate-500' : ''}`}
                      readOnly={!canEdit}
                      onFocus={(e) => { if (canEdit) { e.target.select(); onFieldFocus?.(e); } }}
                      value={
                        it.discounted_price !== undefined && it.discounted_price !== null
                          ? it.discounted_price
                          : it.allocated_for ?? ""
                      }
                      onChange={(e) => canEdit && onUpdateItem(uid, { discounted_price: e.target.value })}
                      onBlur={canEdit ? onFieldBlur : undefined}
                    />
                  </div>
                )}
                <div className="flex items-center gap-2 ml-auto text-sm font-semibold text-slate-800">
                  <span className={showWarning ? "text-red-500" : "text-slate-400"}>→</span>
                  <span
                    className={`${
                      showWarning ? "text-red-600 bg-red-50 px-2 py-0.5 rounded-lg" : ""
                    }`}
                  >
                    {currencyFormatter.format(itemSubtotal)}
                  </span>
                  {showWarning && (
                    <span
                      className="ml-2 text-[10px] uppercase tracking-wide rounded-full bg-red-100 px-2 py-0.5 text-red-600 border border-red-200"
                      title="Selling price is below recorded cost."
                    >
                      below cost
                    </span>
                  )}
                </div>
              </div>

              {showCashSalesMetrics && (
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-600">
                  <span className="px-2 py-0.5 rounded-full bg-slate-100 border">
                    Diff: {currencyFormatter.format(diff)}
                  </span>
                  <span className="px-2 py-0.5 rounded-full bg-slate-100 border">
                    Margin: {marginPct === null ? "--" : `${marginPct.toFixed(1)}%`}
                  </span>
                </div>
              )}

              {showCashSalesMetrics && showDiscountMetrics && (
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-yellow-800 bg-yellow-50 border border-yellow-200 rounded-xl px-2 py-1">
                  <span>Total: {currencyFormatter.format(discountedTotal)}</span>
                  <span>Profit: {currencyFormatter.format(profitTotal)}</span>
                  <span>Margin: {profitMargin === null ? "--" : `${profitMargin.toFixed(1)}%`}</span>
                </div>
              )}

              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-600">
                {it.invoice_num && (
                  <span className="px-2 py-0.5 rounded-full bg-slate-100 border">
                    inv: {it.invoice_num}
                  </span>
                )}
              </div>
              <button
                type="button"
                className={`absolute left-1/2 bottom-0 flex h-6 w-14 -translate-x-1/2 translate-y-1/2 items-center justify-center rounded-full border border-indigo-200 bg-white text-indigo-600 text-xs font-semibold shadow ${
                  expanded[uid] ? "rotate-180" : ""
                }`}
                title={expanded[uid] ? "Collapse" : "Expand"}
                onClick={() => onToggleExpand(uid)}
              >
                ↓
              </button>

              {expanded[uid] && (
                <div className="mt-3 grid gap-2 text-sm">
                  <div className="flex flex-wrap gap-2 text-xs text-slate-600">
                    <span className="px-2 py-0.5 rounded-full bg-slate-100 border">
                    ref: {it.reference_num || "—"}
                  </span>
                  <span className="px-2 py-0.5 rounded-full bg-slate-100 border">
                    date: {it.date || "—"}
                  </span>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  {/* Allocated To */}
                  <LabeledField label="Allocated To (bubble)">
                  
                    <select
                      className={`w-full border rounded-lg p-2 ${canEdit ? 'bg-white' : 'bg-slate-50 text-slate-500'}`}
                      value={it.allocated_to}
                      disabled={!canEdit}
                      onChange={(e) => canEdit && onUpdateItem(itemKey(it), { allocated_to: e.target.value })}
                      onFocus={canEdit ? onFieldFocus : undefined}
                      onBlur={canEdit ? onFieldBlur : undefined}
                    >
                      {bubbles.map((b) => (
                        <option key={b.id} value={b.name}>
                          {b.name}
                        </option>
                      ))}
                    </select>
                  
                  </LabeledField>

                  <LabeledField label="Split Quantity & Move">
                    <div className="flex flex-col gap-2">
                      <div className="flex flex-wrap gap-2">
                        <input
                          type="number"
                          min={1}
                          max={Math.max(1, qty - 1)}
                          className="w-24 border rounded-lg p-2 text-sm"
                          value={splitAmount}
                          disabled={splitDisabled}
                          onChange={(e) =>
                            updateSplitDraft(uid, { quantity: e.target.value })
                          }
                          onFocus={onFieldFocus}
                          onBlur={onFieldBlur}
                        />
                        <select
                          className="flex-1 border rounded-lg p-2 bg-white min-w-[140px]"
                          value={splitTarget}
                          disabled={splitDisabled}
                          onChange={(e) =>
                            updateSplitDraft(uid, { target: e.target.value })
                          }
                          onFocus={onFieldFocus}
                          onBlur={onFieldBlur}
                        >
                          {bubbles.map((b) => (
                            <option key={b.id} value={b.name}>
                              {b.name}
                            </option>
                          ))}
                        </select>
                      </div>
                      <button
                        type="button"
                        className="px-3 py-1.5 rounded-lg text-sm font-semibold text-indigo-700 border border-indigo-200 disabled:opacity-50 disabled:cursor-not-allowed hover:bg-indigo-50"
                        disabled={!canSplit}
                        onClick={() => {
                          onSplitItem?.(uid, splitAmount, splitTarget);
                          resetSplitDraft(uid);
                        }}
                      >
                        Split Item
                      </button>
                      {splitDisabled && (
                        <p className="text-xs text-slate-400">
                          Need quantity of at least 2 to split this item.
                        </p>
                      )}
                    </div>
                  </LabeledField>




                </div>

                <div className="grid grid-cols-3 gap-2">
                  <LabeledField label="Cost">
                    <div className="rounded-lg border border-slate-200 bg-slate-50 p-2 text-sm text-slate-700">
                      {it.cost ?? "—"}
                    </div>
                  </LabeledField>

                  <LabeledInput label="Sold Status"
                    value={it.sold_status}
                    readOnly={!canEdit}
                    onChange={(e) => canEdit && onUpdateItem(itemKey(it), { sold_status: e.target.value })}
                    onFocus={canEdit ? onFieldFocus : undefined}
                    onBlur={canEdit ? onFieldBlur : undefined}
                  />
               


                  <LabeledField label="Sold Date">
                    <div className="rounded-lg border border-slate-200 bg-slate-50 p-2 text-sm text-slate-700">
                      {it.sold_date ?? "—"}
                    </div>
                  </LabeledField>

                </div>

                <div className="grid grid-cols-2 gap-2">
                  
                  
                  <LabeledField label="Notes 1">
                  
                    <textarea
                      className={`w-full border rounded-lg p-2 ${!canEdit ? 'bg-slate-50 text-slate-500' : ''}`}
                      rows={2}
                      readOnly={!canEdit}
                      value={it.notes1}
                      onChange={(e) => canEdit && onUpdateItem(itemKey(it), { notes1: e.target.value })}
                      onFocus={canEdit ? onFieldFocus : undefined}
                      onBlur={canEdit ? onFieldBlur : undefined}
                    />

                  </LabeledField>
                  <LabeledField label="Notes 2">

                    <textarea
                      className={`w-full border rounded-lg p-2 ${!canEdit ? 'bg-slate-50 text-slate-500' : ''}`}
                      rows={2}
                      readOnly={!canEdit}
                      value={it.notes2}
                      onChange={(e) => canEdit && onUpdateItem(itemKey(it), { notes2: e.target.value })}
                      onFocus={canEdit ? onFieldFocus : undefined}
                      onBlur={canEdit ? onFieldBlur : undefined}
                    />

                  
                  </LabeledField>
                </div>
              </div>
            )}
            </Card>
          );
        })}
      </div>

      {showCashSalesMetrics && (
        <div className="mt-2 rounded-2xl border border-slate-200 bg-white/80 p-3 text-sm text-slate-700">
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex flex-col">
              <span className="text-xs uppercase tracking-wide text-slate-400">
                Profit
              </span>
              <span className="font-semibold">
                {currencyFormatter.format(cashSalesProfit)}
              </span>
            </div>
            <div className="flex flex-col">
              <span className="text-xs uppercase tracking-wide text-slate-400">
                Margin
              </span>
              <span className="font-semibold">
                {cashSalesMargin === null ? "--" : `${cashSalesMargin.toFixed(1)}%`}
              </span>
            </div>
          </div>
          {showDiscountMetrics && (
            <div className="mt-3 flex flex-wrap gap-4 rounded-xl border border-yellow-200 bg-yellow-50 px-3 py-2 text-yellow-800">
              <div className="flex flex-col">
                <span className="text-xs uppercase tracking-wide text-yellow-700">
                  Discount Subtotal
                </span>
                <span className="font-semibold">
                  {currencyFormatter.format(discountedSubtotal)}
                </span>
              </div>
              <div className="flex flex-col">
                <span className="text-xs uppercase tracking-wide text-yellow-700">
                  Discount Tax
                </span>
                <span className="font-semibold">
                  {currencyFormatter.format(discountedTax)}
                </span>
              </div>
              <div className="flex flex-col">
                <span className="text-xs uppercase tracking-wide text-yellow-700">
                  Discount Total
                </span>
                <span className="font-semibold">
                  {currencyFormatter.format(discountedTotal)}
                </span>
              </div>
              <div className="flex flex-col">
                <span className="text-xs uppercase tracking-wide text-yellow-700">
                  Discount Profit
                </span>
                <span className="font-semibold">
                  {currencyFormatter.format(discountedProfit)}
                </span>
              </div>
              <div className="flex flex-col">
                <span className="text-xs uppercase tracking-wide text-yellow-700">
                  Discount Margin
                </span>
                <span className="font-semibold">
                  {discountedMargin === null ? "--" : `${discountedMargin.toFixed(1)}%`}
                </span>
              </div>
            </div>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              className="px-3 py-2 rounded-xl border border-amber-200 bg-amber-50 text-amber-700 text-xs font-semibold"
              onClick={() => applyMarkupToBubble(10)}
            >
              +10%
            </button>
            <button
              type="button"
              className="px-3 py-2 rounded-xl border border-amber-200 bg-amber-50 text-amber-700 text-xs font-semibold"
              onClick={() => applyMarkupToBubble(20)}
            >
              +20%
            </button>
            <button
              type="button"
              className="px-3 py-2 rounded-xl border border-amber-200 bg-amber-50 text-amber-700 text-xs font-semibold"
              onClick={applyCapAddToBubble}
            >
              CAP add
            </button>
            <button
              type="button"
              className="px-3 py-2 rounded-xl border border-amber-200 bg-amber-50 text-amber-700 text-xs font-semibold"
              onClick={applyMatchPaymentsToBubble}
              disabled={assignedPayments.length === 0}
            >
              Match payment
            </button>
            <button
              type="button"
              className="px-3 py-2 rounded-xl border border-slate-200 bg-white text-slate-700 text-xs font-semibold"
              onClick={applyRegularPricing}
            >
              Regular Price
            </button>
            {(activeDiscountPct !== null || activePricingLabel) && (
              <span className="text-xs text-slate-500 self-center">
                Active: {activePricingLabel || `+${activeDiscountPct}%`} (highlight on)
              </span>
            )}
          </div>
        </div>
      )}

      {showCashSalesMetrics && (
        <div className="rounded-2xl border border-slate-200 bg-white/80 p-3 text-sm text-slate-700">
          <div className="text-xs uppercase tracking-wide text-slate-400 mb-2">Payments</div>
          {paymentsError && (
            <div className="mb-2 rounded-xl bg-red-50 border border-red-200 px-3 py-2 text-xs text-red-700">
              {paymentsError}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <select
              className="min-w-[220px] border rounded-xl px-3 py-2 text-xs bg-white"
              value={selectedPaymentId}
              onChange={(e) => setSelectedPaymentId(e.target.value)}
              disabled={paymentsLoading || availablePayments.length === 0}
            >
              <option value="">
                {paymentsLoading
                  ? "Loading payments..."
                  : availablePayments.length
                  ? "Select payment"
                  : "No available payments"}
              </option>
              {availablePayments.map((p) => (
                <option key={p.id} value={p.id}>
                  {formatPaymentLabel(p)}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={handleAssignPayment}
              disabled={!selectedPaymentId || paymentsLoading}
              className="px-3 py-2 rounded-xl bg-indigo-600 text-white text-xs font-semibold disabled:opacity-50"
            >
              Assign
            </button>
          </div>
          {assignedPayments.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {assignedPayments.map((p) => (
                <div
                  key={p.id}
                  className="flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1 text-xs text-slate-700"
                >
                  <span>{formatPaymentLabel(p)}</span>
                  <button
                    type="button"
                    onClick={() => handleRemovePayment(p.id)}
                    className="text-slate-400 hover:text-slate-700"
                    title="Unassign payment"
                  >
                    ×
                  </button>
                  {onDeletePayment && (
                    <button
                      type="button"
                      onClick={() => onDeletePayment(p.id)}
                      className="text-red-400 hover:text-red-600"
                      title="Delete payment"
                    >
                      🗑
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {hasAdvancedActions && (
        <div className="mt-auto pt-1">
          {showAdvancedTools ? (
            <div className="rounded-2xl border border-slate-200 bg-white/80 p-3 text-sm text-slate-700 flex flex-col gap-3 shadow-inner">
              <div className="flex items-center justify-between text-xs uppercase tracking-wide text-slate-500">
                <span>Advanced tools</span>
                <button
                  type="button"
                  className="rounded-full border border-slate-200 px-3 py-1 text-[11px] font-semibold text-slate-600 hover:bg-slate-100"
                  onClick={() => setShowAdvancedTools(false)}
                  title="Hide advanced tools"
                >
                  Hide
                </button>
              </div>

              {onConsolidateItems && (
                <button
                  type="button"
                  className="w-full rounded-lg border border-indigo-200 px-3 py-2 text-indigo-700 font-semibold hover:bg-indigo-50 disabled:opacity-40"
                  disabled={!list || list.length === 0}
                  onClick={() => onConsolidateItems?.(name)}
                >
                  Consolidate duplicate items
                </button>
              )}
              {moveActionsAllowed && onMoveToSage && (
                <button
                  type="button"
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-slate-700 font-semibold hover:bg-slate-50"
                  onClick={() => onMoveToSage?.(id)}
                  title="Move entire bubble to Sage AR queue"
                >
                  Move to: Sage AR (Enter into Sage as-is)
                </button>
              )}
              {moveActionsAllowed && onMoveToCashSales && (
                <button
                  type="button"
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-slate-700 font-semibold hover:bg-slate-50"
                  onClick={() => onMoveToCashSales?.(id)}
                  title="Move entire bubble to Cash Sales"
                >
                  Move to: Cash Sales
                </button>
              )}
              {canArchive && onArchiveBubble && (
                <button
                  type="button"
                  className="w-full rounded-lg border border-red-200 px-3 py-2 text-red-700 font-semibold hover:bg-red-50"
                  onClick={() => onArchiveBubble?.(id)}
                  title="Archive this bubble and its items"
                >
                  Archive Bubble
                </button>
              )}
              {allowDelete && deleteOptions.length > 0 && (
                <div className="flex flex-col gap-2 text-xs text-amber-900">
                  <select
                    className="border border-amber-200 rounded-lg bg-white/90 p-2 text-sm text-slate-700"
                    value={deleteSelection}
                    onChange={(e) => setDeleteSelection(e.target.value)}
                  >
                    {deleteOptions.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="w-full px-3 py-2 rounded-lg text-sm font-semibold text-white bg-amber-500 hover:bg-amber-600 disabled:opacity-40"
                    disabled={!deleteSelection}
                    onClick={() => {
                      if (!deleteSelection) return;
                      const confirmed =
                        typeof window === "undefined"
                          ? true
                          : window.confirm(
                              list && list.length > 0
                                ? `Delete "${name}" and move ${list.length} item(s) to ${deleteSelection}?`
                                : `Delete "${name}" bubble?`
                            );
                      if (!confirmed) return;
                      onDeleteBubble?.(id, deleteSelection);
                    }}
                  >
                    {deleteSelection
                      ? `Delete bubble & move items to ${deleteSelection}`
                      : "Delete bubble & move items"}
                  </button>
                  <p className="text-[11px]">
                    Move items manually first if they need different destinations. Any remaining items
                    will be reassigned to the selected bubble.
                  </p>
                </div>
              )}
            </div>
          ) : (
            <button
              type="button"
              className="w-full rounded-full border border-indigo-200 bg-white/80 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-indigo-700 shadow hover:bg-indigo-50"
              onClick={() => setShowAdvancedTools(true)}
              title="Show advanced tools"
            >
              Advanced tools
            </button>
          )}
        </div>
      )}
      {showSageSalesAction && (
        <div className="mt-2 pt-2 border-t border-slate-200 flex flex-col gap-2">
          {!defaultSageCustomerCode && (
            <div className="flex items-center gap-2">
              <label className="text-xs text-slate-500 whitespace-nowrap">Customer code:</label>
              <input
                type="text"
                className="flex-1 rounded border border-slate-200 px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-green-400"
                value={arCustomerCode}
                onChange={(e) => setArCustomerCode(e.target.value)}
                placeholder="e.g. CUST001"
                onFocus={onFieldFocus}
                onBlur={onFieldBlur}
              />
            </div>
          )}
          <button
            type="button"
            disabled={!canEdit || sageSalesRunning || (!defaultSageCustomerCode && !arCustomerCode.trim()) || list.length === 0}
            className="w-full rounded-lg border border-green-300 px-3 py-2 text-sm text-green-800 font-semibold hover:bg-green-50 disabled:opacity-40 disabled:cursor-not-allowed"
            onClick={async () => {
              const code = defaultSageCustomerCode || arCustomerCode.trim();
              if (!code || !onSageSalesInvoice) return;
              const paymentType = assignedPayments.length > 0 ? (assignedPayments[0].type || "") : "";
              setSageSalesRunning(true);
              try {
                await onSageSalesInvoice(name, code, notes || "", paymentType);
              } finally {
                setSageSalesRunning(false);
              }
            }}
          >
            {sageSalesRunning ? "Sending to Sage..." : "Send to Sage Sales"}
          </button>
          {onDeleteBubbleItems && (
            <button
              type="button"
              disabled={list.length === 0}
              className="w-full rounded-lg border border-red-300 px-3 py-2 text-sm text-red-700 font-semibold hover:bg-red-50 disabled:opacity-40 disabled:cursor-not-allowed"
              onClick={() => onDeleteBubbleItems(id)}
            >
              Delete Parts
            </button>
          )}
        </div>
      )}

      {lockedToast && (
        <div
          className="absolute inset-x-4 bottom-10 z-50 flex items-center gap-2 rounded-xl bg-slate-800 px-3 py-2 text-xs text-white shadow-lg"
          onClick={() => setLockedToast(false)}
        >
          <span className="text-base">🔒</span>
          <span>
            This bubble is locked.{" "}
            {lockOwner
              ? `Currently edited by ${lockOwner}.`
              : "Click “Edit” to enable editing."}
          </span>
        </div>
      )}

      <button
        type="button"
        className="absolute right-2 bottom-2 w-5 h-5 rounded-full bg-slate-300 text-white text-[10px] flex items-center justify-center cursor-ew-resize shadow"
        onMouseDown={handleResizeStart}
        onTouchStart={handleResizeStart}
        title="Resize bubble width"
      >
        ⇔
      </button>
    </div>
  );
}
