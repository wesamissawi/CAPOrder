import React, { useState } from "react";
import Card from "../components/Card";
import { DescriptionWithTooltip } from "../components/orderCardKit";
import { isOrderSageLocked, sageLockLabel } from "../utils/sageLock";
import { getOrderQtyDiscrepancy } from "../utils/qtyDiscrepancy";
import { applyEnvironmentalFee } from "../utils/environmentalFee";

function DismissibleMessage({ tone, onDismiss, children }) {
  const boxStyles =
    tone === "error"
      ? "bg-red-50 border-red-200 text-red-700"
      : "bg-emerald-50 border-emerald-200 text-emerald-700";
  const btnStyles =
    tone === "error" ? "text-red-400 hover:text-red-700" : "text-emerald-500 hover:text-emerald-800";
  return (
    <div className={`mt-3 flex items-start gap-2 rounded-xl border px-3 py-2 text-sm whitespace-pre-line ${boxStyles}`}>
      <div className="flex-1">{children}</div>
      <button
        type="button"
        onClick={onDismiss}
        className={`shrink-0 font-bold leading-none ${btnStyles}`}
        title="Dismiss"
      >
        ×
      </button>
    </div>
  );
}

// BestBuy specifically: order is already in Sage but its emailed invoice
// hasn't been matched yet (see handleFetchBestbuyInvoices in App.jsx and the
// "Get Invoice from Gmail" button below).
function isWaitingOnInvoice(order) {
  return (
    (order?.source || "").toString().trim().toLowerCase() === "bestbuy" &&
    Boolean(order?.enteredInSage) &&
    !order?.bestbuyInvoiceFile &&
    !order?.bestbuyCreditFile
  );
}

// Only meaningful in the unfiltered "all" view — buckets orders by how far
// along the arrival workflow they are so the most urgent ones (nothing done
// yet) surface at the top, with BestBuy orders waiting on their emailed
// invoice pulled out into their own bucket at the bottom. Checking "Arrived"
// always force-sets "Picked Up" too (see handleOrderCheckboxChange in
// App.jsx), so these four buckets are mutually exclusive and exhaustive.
function orderPickupSection(order) {
  if (isWaitingOnInvoice(order)) return "waiting-invoice";
  if (!order?.pickedUp) return "not-picked";
  if (!order?.inStore) return "not-arrived";
  return "rest";
}

const PICKUP_SECTION_LABELS = {
  "not-picked": "Not Picked Up",
  "not-arrived": "Picked Up, Not Arrived",
  rest: "Arrived",
  "waiting-invoice": "Waiting on Invoice",
};

export default function OrderManagementView({
  ordersSourcePath,
  ordersSearch,
  setOrdersSearch,
  ordersPickupFilter,
  setOrdersPickupFilter,
  ordersTodayOnly,
  setOrdersTodayOnly,
  ordersDirty,
  ordersSaving,
  ordersLoading,
  ordersError,
  loadOrders,
  handleSaveOrders,
  filteredOrders,
  // Parallel to filteredOrders (same length, same order): the section each card
  // belongs to, as decided by App's sorting memo. It comes from there rather
  // than being recomputed here because the memo may be holding a pickup pin —
  // a card clicked to "Arrived" keeps its old section until the next Refresh,
  // and the header has to agree with the position or the list looks broken.
  filteredOrderSections,
  // How many cards are being held out of place by the pickup pin, and the way
  // to let go of it. Refreshing releases the pin too, but that re-reads
  // orders.json — this is the cheap "tidy the list up" version.
  pinnedOutOfPlaceCount = 0,
  onReleasePickupPin,
  orderFilterCounts,
  handleOrderCheckboxChange,
  handleOrderFieldChange,
  onMarkForSage,
  sageQueuedCount = 0,
  sagePendingCount = 0,
  onSendSageQueue,
  sageQueueSending = false,
  onReleaseSageLock,
  onMarkComplete,
  onClearValueCheck,
  onReconcileTotals,
  onArchiveOrder,
  recentArchivedOrders,
  onDeleteOrder,
  hasSearch,
  onGetWorldOrders,
  worldOrdersRunning,
  worldOrdersStatus,
  worldOrdersError,
  onGetCbkOrders,
  cbkOrdersRunning,
  cbkOrdersStatus,
  cbkOrdersError,
  onGetTigerOrders,
  tigerOrdersRunning,
  tigerOrdersStatus,
  tigerOrdersError,
  onGetBestBuyOrders,
  bestBuyOrdersRunning,
  bestBuyOrdersStatus,
  bestBuyOrdersError,
  onGetTransbecOrders,
  transbecOrdersRunning,
  transbecOrdersStatus,
  transbecOrdersError,
  onGetProforceOrders,
  proforceRunning,
  proforceStatus,
  proforceError,
  onGetAllOrders,
  getAllOrdersRunning,
  getAllOrdersError,
  getAllOrdersDisabledReason,
  ghostMode,
  ghostBusy,
  ghostLog,
  ghostRunning,
  onRunGhostCycleNow,
  automationJobBusy,
  onClearOrderFetchMessage,
  onClearInvoiceFetchMessage,
  onFetchWorldInvoices,
  worldFetching,
  worldStatus,
  worldError,
  onViewWorldInvoiceImage,
  onVerifyWorldInvoice,
  onPrintWorldInvoice,
  onFetchTransbecInvoices,
  transbecFetching,
  transbecStatus,
  transbecError,
  onViewTransbecInvoiceImage,
  onVerifyTransbecInvoice,
  onPrintTransbecInvoice,
  onViewTransbecCreditInvoiceImage,
  onViewWorldCreditInvoiceImage,
  onPrintWorldCreditInvoice,
  onMatchWorldCreditToRequisition,
  onMatchTransbecCreditToRequisition,
  onFetchBestbuyInvoices,
  bestbuyFetching,
  bestbuyStatus,
  bestbuyError,
  onViewBestbuyInvoiceImage,
  onVerifyBestbuyInvoice,
  onPrintBestbuyInvoice,
  onViewBestbuyCreditInvoiceImage,
  onPrintBestbuyCreditInvoice,
  onFetchCbkInvoices,
  cbkFetching,
  cbkStatus,
  cbkError,
  onViewCbkInvoiceImage,
  onVerifyCbkInvoice,
  onPrintCbkInvoice,
  onFetchProforceCreditInvoices,
  proforceCreditFetching,
  proforceCreditStatus,
  proforceCreditError,
  onViewProforceCreditInvoiceImage,
  onPrintProforceCreditInvoice,
  onMatchProforceCreditToRequisition,
  waitingCreditSlipCount,
  invoicePrintingRef,
  onPrintAllNotPrinted,
  printAllRunning,
  onArchiveAllNeedsArchive,
  archiveAllRunning,
  onUpdateInvoiceTrigger,
  onConfirmOrderEdit,
  qtyDiscrepancyThreshold,
  qtyDiscrepancyTaxRate,
  onOpenQtyConfirm,
}) {
  const [invoiceEdits, setInvoiceEdits] = useState({});
  const [dirtyRefs, setDirtyRefs] = useState({});
  const [dirtyReasons, setDirtyReasons] = useState({});
  const [lineItemFeeDrafts, setLineItemFeeDrafts] = useState({});
  const [billedEdits, setBilledEdits] = useState({});

  const markDirty = (key, reason) => {
    if (!key) return;
    setDirtyRefs((prev) => ({ ...prev, [key]: true }));
    if (reason) {
      setDirtyReasons((prev) => {
        const existing = prev[key] || [];
        if (existing.includes(reason)) return prev;
        return { ...prev, [key]: [...existing, reason] };
      });
    }
  };

  const getInvoiceEntry = (key, current) => {
    const entry = invoiceEdits[key];
    if (entry) return entry;
    return { editing: false, value: current || "", dirty: false, original: current || "" };
  };

  const startInvoiceEdit = (key, current) => {
    if (!key) return;
    setInvoiceEdits((prev) => ({
      ...prev,
      [key]: { editing: true, value: current || "", original: current || "", dirty: false },
    }));
  };

  const stopInvoiceEdit = (key) => {
    if (!key) return;
    setInvoiceEdits((prev) => {
      const existing = prev[key];
      if (!existing) return prev;
      return { ...prev, [key]: { ...existing, editing: false } };
    });
  };

  const updateInvoiceDraft = (key, value) => {
    markDirty(key);
    setInvoiceEdits((prev) => {
      const existing = prev[key] || { editing: true, original: value || "" };
      const dirty = value !== (existing.original || "");
      return {
        ...prev,
        [key]: { ...existing, value, dirty, editing: true },
      };
    });
  };

  React.useEffect(() => {
    if (!ordersDirty) {
      setDirtyRefs({});
      setDirtyReasons({});
      setInvoiceEdits({});
      setLineItemFeeDrafts({});
      setBilledEdits({});
    }
  }, [ordersDirty]);

  const getBilledEntry = (key, current) => {
    const entry = billedEdits[key];
    if (entry) return entry;
    const normalized =
      current === null || current === undefined || current === ""
        ? ""
        : Number.isFinite(current)
        ? Number(current).toFixed(2)
        : String(current);
    return { editing: false, value: normalized, dirty: false, original: normalized };
  };

  const startBilledEdit = (key, current) => {
    if (!key) return;
    setBilledEdits((prev) => {
      const normalized =
        current === null || current === undefined || current === ""
          ? ""
          : Number.isFinite(current)
          ? Number(current).toFixed(2)
          : String(current);
      return {
        ...prev,
        [key]: { editing: true, value: normalized, original: normalized, dirty: false },
      };
    });
  };

  const stopBilledEdit = (key) => {
    if (!key) return;
    setBilledEdits((prev) => {
      const existing = prev[key];
      if (!existing) return prev;
      return { ...prev, [key]: { ...existing, editing: false } };
    });
  };

  const clampTwoDecimals = (val) => {
    if (val === null || val === undefined) return "";
    const str = String(val).replace(/[^0-9.-]/g, "");
    const parts = str.split(".");
    if (parts.length > 1) {
      parts[1] = parts[1].slice(0, 2);
      return parts[0] + "." + parts[1];
    }
    return str;
  };

  const updateBilledDraft = (key, value) => {
    if (!key) return;
    const limited = clampTwoDecimals(value);
    const num = parseFloat(limited);
    const normalized = Number.isFinite(num) ? num.toFixed(2) : "";
    const dirty = normalized !== (getBilledEntry(key, "").original || "");
    setBilledEdits((prev) => ({
      ...prev,
      [key]: { editing: true, value: limited, original: getBilledEntry(key, "").original, dirty },
    }));
    markDirty(key, "Billed total");
    handleOrderFieldChange(key, "billed_total", Number.isFinite(num) ? Number(num.toFixed(2)) : null);
  };

  const filters = [
    { value: "all", label: "All" },
    { value: "not-entered-sage", label: "To Process", badge: true, badgeTone: "green" },
    { value: "not-arrived", label: "Not Arrived", badge: true },
    { value: "no-invoice", label: "Invoice Mismatch", badge: true },
    { value: "not-confirmed", label: "Not Confirmed", badge: true },
    { value: "not-printed", label: "Not Printed", badge: true },
    { value: "not-picked", label: "Not Picked Up", badge: true },
    { value: "needs-archive", label: "Needs Archive", badge: true, badgeTone: "green" },
    { value: "credit", label: "Credit", badge: true },
  ];
  const primaryFilter = filters[0];
  const secondaryFilters = filters.slice(1);

  const valueCheckStyles = `
  @keyframes valueCheckPulse {
    0% { box-shadow: 0 0 0 0 rgba(59,130,246,0.45); background-color: rgba(239,246,255,0.8); border-color: rgba(59,130,246,0.8); }
    50% { box-shadow: 0 0 0 3px rgba(239,68,68,0.45); background-color: rgba(254,242,242,0.85); border-color: rgba(239,68,68,0.9); }
    100% { box-shadow: 0 0 0 0 rgba(59,130,246,0.45); background-color: rgba(239,246,255,0.8); border-color: rgba(59,130,246,0.8); }
  }
  .value-check-alert {
    animation: valueCheckPulse 1.2s ease-in-out infinite;
    border-width: 2px !important;
  }
  /* An order that has been handed to Sage is frozen until the run reports back:
     everything on the card is blurred and inert, so nothing can be typed into
     it and no stale copy of it can be saved back over the Sage result. */
  .sage-locked-card {
    position: relative;
    border-color: rgba(99,102,241,0.7) !important;
    border-width: 2px !important;
  }
  .sage-locked-card > *:not(.sage-lock-overlay) {
    filter: blur(2.5px);
    opacity: 0.5;
    pointer-events: none;
    user-select: none;
  }
  .sage-lock-overlay {
    position: absolute;
    inset: 0;
    z-index: 10;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    text-align: center;
    padding: 1rem;
    border-radius: 1rem;
    background: rgba(238,242,255,0.55);
  }
  @keyframes sageLockSpin { to { transform: rotate(360deg); } }
  .sage-lock-spinner {
    width: 1.25rem;
    height: 1.25rem;
    border-radius: 9999px;
    border: 2px solid rgba(99,102,241,0.25);
    border-top-color: rgba(79,70,229,0.95);
    animation: sageLockSpin 0.8s linear infinite;
  }
  `;

  const orderFetchButtons = [
    { key: "world", label: "World", onClick: onGetWorldOrders, running: worldOrdersRunning, status: worldOrdersStatus, error: worldOrdersError },
    { key: "transbec-orders", label: "Transbec", onClick: onGetTransbecOrders, running: transbecOrdersRunning, status: transbecOrdersStatus, error: transbecOrdersError },
    { key: "bestbuy-orders", label: "BestBuy", onClick: onGetBestBuyOrders, running: bestBuyOrdersRunning, status: bestBuyOrdersStatus, error: bestBuyOrdersError },
    { key: "cbk", label: "CBK", onClick: onGetCbkOrders, running: cbkOrdersRunning, status: cbkOrdersStatus, error: cbkOrdersError },
    { key: "proforce", label: "Proforce", onClick: onGetProforceOrders, running: proforceRunning, status: proforceStatus, error: proforceError },
    { key: "tiger", label: "Tiger", onClick: onGetTigerOrders, running: tigerOrdersRunning, status: tigerOrdersStatus, error: tigerOrdersError },
  ];

  const isInvoiceNotPrinted = (order) => {
    const vendor = (order?.source || "").toString().trim().toLowerCase();
    // World invoices do not have to be printed before archiving.
    if (!["bestbuy", "transbec", "cbk"].includes(vendor)) return false;
    const hasInvoiceFile = Boolean(
      order.transbecInvoiceFile ||
        order.transbecInvoiceImage ||
        order.bestbuyInvoiceFile ||
        order.bestbuyCreditFile ||
        order.cbkInvoiceFile
    );
    if (!hasInvoiceFile) return false;
    const printed = Boolean(
      order.transbecInvoicePrinted ||
        order.bestbuyInvoicePrinted ||
        order.bestbuyCreditInvoicePrinted ||
        order.cbkInvoicePrinted
    );
    return !printed;
  };

  const canArchiveOrder = (order) =>
    Boolean(
      order &&
        order.detailStored === true &&
        order.pickedUp === true &&
        order.hasInvoiceNum === true &&
        order.totalVerified === true &&
        order.enteredInSage === true &&
        order.inStore === true &&
        order.invoiceNeedsSync !== true &&
        order.valueCheckAlert !== true &&
        !isInvoiceNotPrinted(order)
    );

  // Same conditions as canArchiveOrder, in the same order, but as prose. The
  // Archive button simply isn't rendered while any of them fails, which leaves
  // no way to tell WHICH one — and the print gate in particular has no checkbox
  // of its own, so an order can sit there looking complete with nothing to
  // click. Credit orders hit that hardest: they're excluded from the
  // "Not Printed" filter (and so from Print All) by design, so their only print
  // affordance is the per-card Print Credit button.
  const archiveBlockers = (order) => {
    if (!order) return [];
    const reasons = [];
    if (order.detailStored !== true) reasons.push("order detail hasn't been fetched");
    if (order.pickedUp !== true) reasons.push('"Picked Up" not checked');
    if (order.inStore !== true) reasons.push('"Arrived" not checked');
    if (order.hasInvoiceNum !== true) reasons.push("invoice # not confirmed");
    if (order.totalVerified !== true) reasons.push('"Value Check" not confirmed');
    if (order.enteredInSage !== true) reasons.push('"Entered in Sage" not checked');
    if (order.invoiceNeedsSync === true) reasons.push("invoice # changed — Sage needs re-syncing");
    if (order.valueCheckAlert === true) reasons.push("value check still open (see above)");
    if (isInvoiceNotPrinted(order)) {
      reasons.push(
        order.bestbuyCreditFile && !order.bestbuyInvoiceFile
          ? 'credit invoice not printed — use "Print Credit" above'
          : 'invoice not printed — use "Print Invoice" above'
      );
    }
    return reasons;
  };

  return (
    <>
      <style>{valueCheckStyles}</style>
      <section>
        <Card>
          <div className="text-sm uppercase tracking-wide text-slate-400 font-semibold">Order Fetcher</div>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={onGetAllOrders}
              disabled={getAllOrdersRunning || Boolean(getAllOrdersDisabledReason)}
              title={
                getAllOrdersRunning
                  ? "Fetching every vendor at once..."
                  : getAllOrdersDisabledReason || "Fetch World, Transbec, BestBuy, CBK, Proforce and Tiger all at once"
              }
              className="px-5 py-2.5 rounded-xl bg-emerald-600 text-white text-sm font-semibold disabled:opacity-60"
            >
              {getAllOrdersRunning ? "Fetching All..." : "Get All"}
            </button>
            <span className="w-px self-stretch bg-slate-200" />
            {orderFetchButtons.map((v) => (
              <button
                key={v.key}
                type="button"
                onClick={v.onClick}
                disabled={v.running}
                className="px-5 py-2.5 rounded-xl bg-indigo-600 text-white text-sm font-semibold disabled:opacity-60"
              >
                {v.running ? "Fetching..." : v.label}
              </button>
            ))}
          </div>
          {automationJobBusy && (
            <div className="mt-3 rounded-xl border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-800">
              <span className="font-semibold">Working for another machine</span> - {automationJobBusy}
            </div>
          )}
          {ghostMode && (
            <div className="mt-3 flex items-start gap-3 rounded-xl border border-violet-200 bg-violet-50 px-3 py-2 text-sm text-violet-700">
              <div className="flex-1">
                <span className="font-semibold">Ghost mode</span> - this machine runs the fetch,
                Gmail, Sage and print steps by itself every 30 minutes between 8am and 5pm.
                <div className="mt-0.5 text-xs text-violet-600 whitespace-pre-line">
                  {ghostBusy || ghostLog || "Waiting for the next half hour."}
                </div>
              </div>
              {onRunGhostCycleNow && (
                <button
                  type="button"
                  onClick={onRunGhostCycleNow}
                  disabled={ghostRunning}
                  title="Run one full cycle right now instead of waiting for the next half hour. Same checks as a scheduled run."
                  className="shrink-0 px-3 py-1.5 rounded-full border border-violet-300 bg-white text-xs font-semibold text-violet-700 hover:bg-violet-100 disabled:opacity-60"
                >
                  {ghostRunning ? "Running..." : "Run one now"}
                </button>
              )}
            </div>
          )}
          {getAllOrdersError && (
            <div className="mt-3 flex items-start gap-2 rounded-xl bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">
              <div className="flex-1 whitespace-pre-line">{getAllOrdersError}</div>
              <button
                type="button"
                onClick={() => onClearOrderFetchMessage?.("get-all")}
                className="shrink-0 text-red-400 hover:text-red-700 font-bold leading-none"
                title="Dismiss"
              >
                ×
              </button>
            </div>
          )}
          {orderFetchButtons.map((v) =>
            v.error ? (
              <div
                key={`${v.key}-error`}
                className="mt-3 flex items-start gap-2 rounded-xl bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700"
              >
                <div className="flex-1 whitespace-pre-line">{v.error}</div>
                <button
                  type="button"
                  onClick={() => onClearOrderFetchMessage?.(v.key)}
                  className="shrink-0 text-red-400 hover:text-red-700 font-bold leading-none"
                  title="Dismiss"
                >
                  ×
                </button>
              </div>
            ) : v.status ? (
              <div
                key={`${v.key}-status`}
                className="mt-3 flex items-start gap-2 rounded-xl bg-emerald-50 border border-emerald-200 px-3 py-2 text-sm text-emerald-700"
              >
                <div className="flex-1 whitespace-pre-line">{v.status}</div>
                <button
                  type="button"
                  onClick={() => onClearOrderFetchMessage?.(v.key)}
                  className="shrink-0 text-emerald-500 hover:text-emerald-800 font-bold leading-none"
                  title="Dismiss"
                >
                  ×
                </button>
              </div>
            ) : null
          )}

          <div className="mt-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-start">
            <div className="flex flex-col sm:flex-row sm:items-center gap-2">
              <input
                type="search"
                value={ordersSearch}
                onChange={(e) => setOrdersSearch(e.target.value)}
                placeholder="Search orders..."
                className="w-full sm:w-56 border rounded-xl px-3 py-2 text-sm bg-white"
              />
              <div className="flex flex-wrap gap-2">
                {primaryFilter && (
                  <button
                    key={primaryFilter.value}
                    type="button"
                    onClick={() => setOrdersPickupFilter(primaryFilter.value)}
                    className={`px-3 py-2 rounded-xl text-xs sm:text-sm font-semibold border transition ${
                      ordersPickupFilter === primaryFilter.value
                        ? "bg-indigo-600 text-white border-indigo-600 shadow-sm"
                        : "bg-white text-slate-700 border-slate-200 hover:bg-indigo-50"
                    }`}
                  >
                    {primaryFilter.label}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setOrdersTodayOnly(!ordersTodayOnly)}
                  className={`px-3 py-2 rounded-xl text-xs sm:text-sm font-semibold border transition ${
                    ordersTodayOnly
                      ? "bg-emerald-600 text-white border-emerald-600 shadow-sm"
                      : "bg-white text-slate-700 border-slate-200 hover:bg-emerald-50"
                  }`}
                >
                  Today
                </button>
                {secondaryFilters.map((filter) => {
                  const isActive = ordersPickupFilter === filter.value;
                  const count = orderFilterCounts?.[filter.value] ?? 0;
                  const badgeActiveOn =
                    filter.badgeTone === "green" ? "bg-white text-emerald-600" : "bg-white text-red-600";
                  const badgeIdleOn =
                    filter.badgeTone === "green"
                      ? "bg-emerald-100 text-emerald-700 border border-emerald-200"
                      : "bg-red-100 text-red-700 border border-red-200";
                  return (
                    <button
                      key={filter.value}
                      type="button"
                      onClick={() => setOrdersPickupFilter(filter.value)}
                      className={`flex items-center gap-2 px-3 py-2 rounded-xl text-xs sm:text-sm font-semibold border transition ${
                        isActive
                          ? "bg-indigo-600 text-white border-indigo-600 shadow-sm"
                          : "bg-white text-slate-700 border-slate-200 hover:bg-indigo-50"
                      }`}
                    >
                      {filter.label}
                      {filter.badge && (
                        <span
                          className={`px-1.5 py-0.5 rounded-full text-[11px] font-bold ${
                            count > 0
                              ? isActive
                                ? badgeActiveOn
                                : badgeIdleOn
                              : isActive
                              ? "bg-white/20 text-white"
                              : "bg-slate-100 text-slate-500 border border-slate-200"
                          }`}
                        >
                          {count}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
              {ordersDirty && !ordersLoading && (
                <span className="text-xs px-3 py-1 rounded-full bg-amber-100 text-amber-700 border border-amber-200">
                  Unsaved changes
                </span>
              )}
              {/* Picked Up / Arrived save on click but deliberately leave the
                  card where it is (see pinPickupPositions in App.jsx). This is
                  the way to ask for the list to catch up without a full
                  Refresh — no disk read, no data change, just a re-sort. */}
              {pinnedOutOfPlaceCount > 0 && onReleasePickupPin && (
                <button
                  type="button"
                  onClick={onReleasePickupPin}
                  className="text-xs px-3 py-1 rounded-full bg-sky-50 text-sky-700 border border-sky-200 hover:bg-sky-100 font-semibold"
                  title={`${pinnedOutOfPlaceCount} card${
                    pinnedOutOfPlaceCount === 1 ? " is" : "s are"
                  } being held in place so they don't move while you work. Click to re-sort them into their sections.`}
                >
                  Re-sort list ({pinnedOutOfPlaceCount})
                </button>
              )}
              <button
                onClick={handleSaveOrders}
                disabled={!ordersDirty || ordersSaving}
                className="px-4 py-2 rounded-xl bg-emerald-600 text-white text-sm font-semibold disabled:opacity-50"
              >
                {ordersSaving ? "Saving..." : ordersDirty ? "Save Changes" : "Saved"}
              </button>
              {/* The queue's one and only exit. "Add to Sage Queue" on a card
                  just parks the order; nothing is typed into Sage until this is
                  pressed. Pressable from ANY machine — releasing the queue is a
                  data change, and whichever machine is running Sage picks the
                  work up from there. The count is everything still owed to
                  Sage, so it keeps ticking down while the run is in progress. */}
              {onSendSageQueue && (
                <button
                  onClick={onSendSageQueue}
                  disabled={sageQueuedCount === 0 || sageQueueSending}
                  className="px-4 py-2 rounded-xl bg-violet-600 text-white text-sm font-semibold disabled:opacity-50"
                  title={
                    sageQueuedCount === 0
                      ? sagePendingCount > 0
                        ? `${sagePendingCount} order${sagePendingCount === 1 ? "" : "s"} already on the way to Sage`
                        : "Nothing is queued for Sage"
                      : `Release ${sageQueuedCount} queued order${sageQueuedCount === 1 ? "" : "s"} — the machine running Sage enters them, oldest first`
                  }
                >
                  {sageQueueSending
                    ? "Sending..."
                    : `Send to Sage${sagePendingCount ? ` (${sagePendingCount})` : ""}`}
                </button>
              )}
              <button
                onClick={loadOrders}
                disabled={ordersLoading}
                className="px-4 py-2 rounded-xl bg-indigo-600 text-white text-sm font-semibold disabled:opacity-50"
              >
                {ordersLoading ? "Refreshing..." : "Refresh Orders"}
              </button>
            </div>
          </div>
          {ordersPickupFilter === "not-printed" && (
            <div className="mt-4">
              <button
                type="button"
                onClick={() => onPrintAllNotPrinted?.(filteredOrders)}
                disabled={printAllRunning || filteredOrders.length === 0}
                className="px-4 py-2 rounded-xl bg-indigo-600 text-white text-sm font-semibold disabled:opacity-60"
              >
                {printAllRunning ? "Printing..." : `Print All (${filteredOrders.length})`}
              </button>
            </div>
          )}
          {ordersPickupFilter === "needs-archive" && (
            <div className="mt-4">
              <button
                type="button"
                onClick={() => onArchiveAllNeedsArchive?.(filteredOrders)}
                disabled={archiveAllRunning || filteredOrders.length === 0}
                className="px-4 py-2 rounded-xl bg-slate-900 text-white text-sm font-semibold disabled:opacity-60"
              >
                {archiveAllRunning ? "Archiving..." : `Archive All (${filteredOrders.length})`}
              </button>
            </div>
          )}
          {ordersError && (
            <DismissibleMessage tone="error" onDismiss={() => onClearInvoiceFetchMessage?.("orders")}>
              {ordersError}
            </DismissibleMessage>
          )}
          {worldError && (
            <DismissibleMessage tone="error" onDismiss={() => onClearInvoiceFetchMessage?.("world")}>
              {worldError}
            </DismissibleMessage>
          )}
          {worldStatus && !worldError && (
            <DismissibleMessage tone="status" onDismiss={() => onClearInvoiceFetchMessage?.("world")}>
              {worldStatus}
            </DismissibleMessage>
          )}
          {transbecError && (
            <DismissibleMessage tone="error" onDismiss={() => onClearInvoiceFetchMessage?.("transbec")}>
              {transbecError}
            </DismissibleMessage>
          )}
          {transbecStatus && !transbecError && (
            <DismissibleMessage tone="status" onDismiss={() => onClearInvoiceFetchMessage?.("transbec")}>
              {transbecStatus}
            </DismissibleMessage>
          )}
          {bestbuyError && (
            <DismissibleMessage tone="error" onDismiss={() => onClearInvoiceFetchMessage?.("bestbuy")}>
              {bestbuyError}
            </DismissibleMessage>
          )}
          {bestbuyStatus && !bestbuyError && (
            <DismissibleMessage tone="status" onDismiss={() => onClearInvoiceFetchMessage?.("bestbuy")}>
              {bestbuyStatus}
            </DismissibleMessage>
          )}
          {cbkError && (
            <DismissibleMessage tone="error" onDismiss={() => onClearInvoiceFetchMessage?.("cbk")}>
              {cbkError}
            </DismissibleMessage>
          )}
          {cbkStatus && !cbkError && (
            <DismissibleMessage tone="status" onDismiss={() => onClearInvoiceFetchMessage?.("cbk")}>
              {cbkStatus}
            </DismissibleMessage>
          )}
          {proforceCreditError && (
            <DismissibleMessage tone="error" onDismiss={() => onClearInvoiceFetchMessage?.("proforce")}>
              {proforceCreditError}
            </DismissibleMessage>
          )}
          {proforceCreditStatus && !proforceCreditError && (
            <DismissibleMessage tone="status" onDismiss={() => onClearInvoiceFetchMessage?.("proforce")}>
              {proforceCreditStatus}
            </DismissibleMessage>
          )}
        </Card>
      </section>
      <div className="flex flex-col xl:flex-row items-start gap-4">
        <section className="flex-1 min-w-0">
        {ordersLoading && filteredOrders.length === 0 ? (
          <div className="py-12 text-center text-slate-500">Loading orders...</div>
        ) : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {filteredOrders.map((order, idx) => {
              const key = `${order.source || "unknown"}-${order.reference || order.__row || "order"}-${order.warehouse || "warehouse"}-${idx}`;
              const refKey = order.reference || order.__row || key;
              // Two distinct states: waiting in the queue (removable), versus
              // already released and on its way into Sage (not removable here —
              // that is the lock overlay's Release button).
              const isSageQueued = Boolean(order.sage_queued);
              const isSageTriggered = Boolean(order.sage_trigger);
              // The invoice-update queue: same two states, its own fields.
              const isInvoiceQueued = Boolean(order.sage_invoice_queued);
              const isInvoiceTriggered = Boolean(order.sage_invoice_trigger);
              const sageLocked = isOrderSageLocked(order);
              const invoiceEntry = getInvoiceEntry(refKey, order.source_invoice || "");
              const needsSync = Boolean(order.invoiceNeedsSync);
              const reasons = dirtyReasons[refKey] || [];
              const isDirty = (ordersDirty && dirtyRefs[refKey]) || invoiceEntry.dirty || needsSync;
              const billedTotal = order.billed_total ?? order.billedTotal;
              const sageTotal = order.sage_total_synced ?? order.sageTotalSynced;
              const billedNum = billedTotal === null || billedTotal === undefined ? NaN : Number(billedTotal);
              const sageNum = sageTotal === null || sageTotal === undefined ? NaN : Number(sageTotal);
              const showReconcile =
                Boolean(order.enteredInSage) &&
                Number.isFinite(billedNum) &&
                Number.isFinite(sageNum) &&
                Math.abs(billedNum - sageNum) > 0.009;
              const needsValueCheck = Boolean(order.valueCheckAlert);
              const qtyDiscrepancy = getOrderQtyDiscrepancy(
                order,
                qtyDiscrepancyTaxRate,
                qtyDiscrepancyThreshold
              );
              const hasQtyDiscrepancy = Boolean(qtyDiscrepancy?.overThreshold);
              const cardTone = needsValueCheck
                ? "value-check-alert border-indigo-400"
                : isDirty
                ? `animate-pulse ${
                    needsSync
                      ? "border-red-500 bg-red-50 ring-2 ring-red-300"
                      : "border-amber-500 bg-amber-50 ring-2 ring-amber-300"
                  }`
                : "border-indigo-100";
              const sectionOf = (i) =>
                filteredOrderSections?.[i] ?? orderPickupSection(filteredOrders[i]);
              const section = sectionOf(idx);
              const showSectionHeader =
                ordersPickupFilter === "all" && (idx === 0 || sectionOf(idx - 1) !== section);
              return (
                <React.Fragment key={key}>
                  {showSectionHeader && (
                    <div className="col-span-full mt-6 first:mt-0 flex items-center gap-3">
                      <span className="whitespace-nowrap text-sm font-bold uppercase tracking-wide text-slate-600">
                        {PICKUP_SECTION_LABELS[section]}
                      </span>
                      <hr className="flex-1 border-t-2 border-slate-300" />
                    </div>
                  )}
                  <Card className={`${cardTone} ${sageLocked ? "sage-locked-card" : ""}`}>
                  {sageLocked && (
                    <div className="sage-lock-overlay">
                      <div className="sage-lock-spinner" />
                      <div className="text-sm font-semibold text-indigo-800">
                        {order.reference || "Order"} - locked by Sage
                      </div>
                      <div className="text-xs text-indigo-700">{sageLockLabel(order)}</div>
                      <div className="text-[11px] text-slate-500 max-w-[16rem]">
                        No changes can be made until the Sage run reports back.
                      </div>
                      {order.sage_lock?.lastError && (
                        <div className="text-[11px] text-red-600 max-w-[16rem] break-words">
                          {order.sage_lock.lastError}
                        </div>
                      )}
                      {onReleaseSageLock && (
                        <button
                          type="button"
                          onClick={() => onReleaseSageLock(order)}
                          className="mt-1 px-3 py-1 rounded-full text-xs font-semibold border bg-white text-slate-700 border-slate-300 hover:bg-slate-50"
                          title="Only if Sage is not actually processing this order"
                        >
                          Release
                        </button>
                      )}
                    </div>
                  )}
                  <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                    <div>
                      <div className="text-lg font-semibold text-slate-800">
                        {order.warehouse || "-"} - {order.reference || "No reference"}
                      </div>
                      <div className="text-xs uppercase tracking-wide text-slate-400">
                        {order.orderDateRaw || "Date unknown"}
                      </div>
                    </div>
                    <div className="flex flex-col items-end gap-2">
                      <div className="flex gap-2 text-xs">
                        {Boolean(order.enteredInSage) && (
                          <span className="px-2 py-1 rounded-full bg-emerald-50 text-emerald-600 border border-emerald-200">
                            Sage
                          </span>
                        )}
                        {Boolean(order.inStore) && (
                          <span className="px-2 py-1 rounded-full bg-blue-50 text-blue-600 border border-blue-200">
                            Arrived
                          </span>
                        )}
                        {Boolean(order.totalVerified) && (
                          <span className="px-2 py-1 rounded-full bg-teal-50 text-teal-600 border border-teal-200">
                            Confirmed
                          </span>
                        )}
                        {Boolean(order.transbecInvoicePrinted || order.bestbuyInvoicePrinted || order.bestbuyCreditInvoicePrinted || order.cbkInvoicePrinted) && (
                          <span className="px-2 py-1 rounded-full bg-teal-50 text-teal-600 border border-teal-200">
                            Printed
                          </span>
                        )}
                      </div>
                      <div className="flex flex-row items-center gap-2">
                        {hasQtyDiscrepancy && (
                          <button
                            type="button"
                            onClick={() => onOpenQtyConfirm?.(refKey)}
                            className="px-3 py-1 rounded-full text-xs font-semibold border bg-red-600 text-white border-red-600 hover:bg-red-700 animate-pulse"
                            title={`Billed total is ${qtyDiscrepancy.diff >= 0 ? "+" : ""}$${qtyDiscrepancy.diff.toFixed(2)} vs. the line items total ($${qtyDiscrepancy.expectedTotal.toFixed(2)}) — confirm quantities${
                              order.enteredInSage
                                ? " (this order is already in Sage; saving corrects the record only, not the Sage entry)"
                                : " before sending to Sage"
                            }`}
                          >
                            Confirm Quantities
                          </button>
                        )}
                        {!order.enteredInSage && !hasQtyDiscrepancy && (
                          // Doubles as the way back out: while an order is only
                          // queued it carries no Sage lock, so the Release
                          // button inside the lock overlay isn't there to
                          // un-queue it.
                          <button
                            type="button"
                            onClick={() =>
                              isSageQueued ? onReleaseSageLock?.(order) : onMarkForSage(refKey)
                            }
                            disabled={isSageTriggered}
                            className={`px-3 py-1 rounded-full text-xs font-semibold border ${
                              isSageTriggered
                                ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                                : isSageQueued
                                ? "bg-violet-50 text-violet-700 border-violet-300 hover:bg-violet-100"
                                : "bg-white text-indigo-700 border-indigo-200 hover:bg-indigo-50"
                            }`}
                            title={
                              isSageTriggered
                                ? "Released — waiting for the machine running Sage to enter it"
                                : isSageQueued
                                ? 'Waiting in the Sage queue — press "Send to Sage" at the top to release it, or click here to take it back out'
                                : "Add this order to the Sage queue. Nothing is entered in Sage until the queue is sent."
                            }
                          >
                            {isSageTriggered
                              ? "Sending to Sage"
                              : isSageQueued
                              ? "In Sage Queue — remove"
                              : "Add to Sage Queue"}
                          </button>
                        )}
                      </div>
                      {showReconcile && (
                        <button
                          type="button"
                          onClick={() => onReconcileTotals?.(refKey)}
                          className="px-3 py-1 rounded-full text-xs font-semibold border bg-amber-50 text-amber-800 border-amber-200 hover:bg-amber-100"
                          title="Adjust Sage tax to match billed total"
                        >
                          Reconcile totals
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
                    {[
                      { label: "Picked Up", field: "pickedUp" },
                      { label: "Arrived", field: "inStore" },
                      { label: "Entered in Sage", field: "enteredInSage" },
                      { label: "Value Check", field: "totalVerified" },
                    ].map((meta) => {
                      const checked = Boolean(order[meta.field]);
                      const billedEntry = getBilledEntry(refKey, order.billed_total ?? "");
                      return (
                        <label
                          key={meta.field}
                          className={`flex items-center gap-2 rounded-xl border px-3 py-2 transition ${
                            checked
                              ? "bg-indigo-50 border-indigo-200"
                              : "bg-white/60 border-slate-200"
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(e) => {
                              markDirty(refKey, meta.label);
                              handleOrderCheckboxChange(refKey, meta.field, e.target.checked);
                            }}
                          />
                          <span className="text-slate-700 text-sm">{meta.label}</span>
                          {meta.field === "totalVerified" && (
                            <div className="flex items-center gap-2 ml-auto">
                              <input
                                type="text"
                                value={billedEntry.value}
                                readOnly={!billedEntry.editing}
                                disabled={!billedEntry.editing}
                                onChange={(e) => updateBilledDraft(refKey, e.target.value)}
                                onBlur={() => {
                                  const num = parseFloat(billedEntry.value);
                                  const normalized = Number.isFinite(num) ? num.toFixed(2) : "";
                                  const wasDirty = normalized !== (billedEntry.original || "");
                                  updateBilledDraft(refKey, normalized);
                                  stopBilledEdit(refKey);
                                  if (wasDirty) onConfirmOrderEdit?.(refKey);
                                }}
                                placeholder="Billed total"
                                className={`w-24 border rounded-lg px-2 py-1 text-xs ${
                                  billedEntry.editing ? "bg-white" : "bg-slate-100"
                                }`}
                              />
                              <button
                                type="button"
                                className="px-2 py-1 text-xs rounded-lg border bg-white text-slate-700 disabled:opacity-60 disabled:cursor-not-allowed"
                                disabled={billedEntry.editing}
                                onClick={() => startBilledEdit(refKey, order.billed_total ?? "")}
                                title="Edit billed total"
                              >
                                Edit
                              </button>
                            </div>
                          )}
                        </label>
                      );
                    })}
                  </div>
                  <div className="mt-2">
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => onMarkComplete(refKey)}
                        className="px-3 py-2 rounded-xl text-sm font-semibold border bg-emerald-600 text-white hover:bg-emerald-700"
                      >
                        Mark Complete
                      </button>
                      {canArchiveOrder(order) && (
                        <button
                          type="button"
                          onClick={() => onArchiveOrder?.(order)}
                          className="px-3 py-2 rounded-xl text-sm font-semibold border bg-slate-900 text-white hover:bg-slate-800"
                        >
                          Archive Order
                        </button>
                      )}
                      {/* epicorOnly is a legacy flag from the retired Epicor
                          scrape — nothing sets it now, but existing orders that
                          carry it still need a way to be removed. */}
                      {Boolean(order.epicorOnly) && !canArchiveOrder(order) && onDeleteOrder && (
                        <button
                          type="button"
                          onClick={() => onDeleteOrder(order)}
                          className="px-3 py-2 rounded-xl text-sm font-semibold border bg-white text-red-600 border-red-200 hover:bg-red-50"
                          title="Permanently remove this scan-generated order from Order Management"
                        >
                          Delete Order
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={handleSaveOrders}
                        disabled={!ordersDirty || ordersSaving}
                        className="px-4 py-2 rounded-xl bg-emerald-600 text-white text-sm font-semibold disabled:opacity-50"
                      >
                        {ordersSaving ? "Saving..." : ordersDirty ? "Save Changes" : "Saved"}
                      </button>
                    </div>
                    {!canArchiveOrder(order) && archiveBlockers(order).length > 0 && (
                      <div className="mt-2 text-xs text-amber-700">
                        <span className="font-semibold">Can't archive yet:</span>{" "}
                        {archiveBlockers(order).join("; ")}.
                      </div>
                    )}
                  </div>
                  <div className="mt-4 grid gap-3 sm:grid-cols-2">
                    <div className="flex flex-col gap-1">
                      <span className="text-xs uppercase tracking-wide text-slate-400">Invoice #</span>
                      <div className="flex items-center gap-2 w-full max-w-xs">
                        <input
                          className={`flex-1 min-w-0 border rounded-xl px-3 py-1.5 text-sm text-slate-700 ${
                            invoiceEntry.editing ? "bg-white" : "bg-slate-100"
                          }`}
                          value={invoiceEntry.value}
                          readOnly={!invoiceEntry.editing}
                          disabled={!invoiceEntry.editing}
                          onChange={(e) => {
                            const nextVal = e.target.value;
                            const orig = invoiceEntry.original || "";
                            const needsSync =
                              Boolean(order.invoiceSageUpdate) &&
                              String(nextVal).trim() !== String(orig).trim();
                            updateInvoiceDraft(refKey, nextVal);
                            markDirty(refKey, "Invoice changed");
                            handleOrderFieldChange(refKey, "source_invoice", nextVal);
                            handleOrderFieldChange(refKey, "sage_reference", nextVal);
                            handleOrderFieldChange(refKey, "hasInvoiceNum", true);
                            handleOrderFieldChange(refKey, "invoiceNeedsSync", needsSync);
                          }}
                          onBlur={() => {
                            const wasDirty = invoiceEntry.dirty;
                            stopInvoiceEdit(refKey);
                            if (wasDirty) onConfirmOrderEdit?.(refKey);
                          }}
                        />
                        <button
                          type="button"
                          className="px-2 py-1 text-xs rounded-lg border bg-white text-slate-700 disabled:opacity-60 disabled:cursor-not-allowed"
                          disabled={invoiceEntry.editing}
                          onClick={() => startInvoiceEdit(refKey, order.source_invoice || "")}
                        >
                          Edit
                        </button>
                      </div>
                      {order.source === "world" && !order.source_invoice && onFetchWorldInvoices && (
                        <button
                          type="button"
                          onClick={() => onFetchWorldInvoices(order.reference)}
                          disabled={worldFetching}
                          className="mt-1 px-3 py-1 rounded-full text-xs font-semibold border bg-white text-indigo-700 border-indigo-200 hover:bg-indigo-50 disabled:opacity-60 self-start"
                        >
                          {worldFetching ? "Checking Gmail..." : "Get Invoice from Gmail"}
                        </button>
                      )}
                      {order.worldInvoiceFile && onViewWorldInvoiceImage && (
                        <button
                          type="button"
                          onClick={() => onViewWorldInvoiceImage(order)}
                          className="mt-1 px-3 py-1 rounded-full text-xs font-semibold border bg-white text-slate-700 border-slate-200 hover:bg-slate-50 self-start"
                          title="Open the invoice PDF in your default viewer to compare against the invoice # and total"
                        >
                          View Invoice PDF
                        </button>
                      )}
                      {order.worldInvoiceFile && onVerifyWorldInvoice && (
                        <button
                          type="button"
                          onClick={() => onVerifyWorldInvoice(order)}
                          className="mt-1 px-3 py-1 rounded-full text-xs font-semibold border bg-white text-emerald-700 border-emerald-200 hover:bg-emerald-50 self-start"
                          title="Review the invoice PDF side-by-side with the stored invoice # and total, and correct if needed"
                        >
                          {order.totalVerified ? "Verify Again" : "Verify Invoice"}
                        </button>
                      )}
                      {order.worldInvoiceFile && onPrintWorldInvoice && (
                        <button
                          type="button"
                          onClick={() => onPrintWorldInvoice(order)}
                          disabled={invoicePrintingRef === `world:${order.reference}`}
                          className="mt-1 px-3 py-1 rounded-full text-xs font-semibold border bg-white text-indigo-700 border-indigo-200 hover:bg-indigo-50 disabled:opacity-60 self-start"
                          title="Print page 1 of the invoice"
                        >
                          {invoicePrintingRef === `world:${order.reference}`
                            ? "Printing..."
                            : order.worldInvoicePrinted
                            ? "Print Invoice Again"
                            : "Print Invoice"}
                        </button>
                      )}
                      {order.source === "transbec" && !order.source_invoice && onFetchTransbecInvoices && (
                        <button
                          type="button"
                          onClick={() => onFetchTransbecInvoices(order.reference)}
                          disabled={transbecFetching}
                          className="mt-1 px-3 py-1 rounded-full text-xs font-semibold border bg-white text-indigo-700 border-indigo-200 hover:bg-indigo-50 disabled:opacity-60 self-start"
                        >
                          {transbecFetching ? "Checking Gmail..." : "Get Invoice from Gmail"}
                        </button>
                      )}
                      {(order.transbecInvoiceFile || order.transbecInvoiceImage) && onViewTransbecInvoiceImage && (
                        <button
                          type="button"
                          onClick={() => onViewTransbecInvoiceImage(order)}
                          className="mt-1 px-3 py-1 rounded-full text-xs font-semibold border bg-white text-slate-700 border-slate-200 hover:bg-slate-50 self-start"
                          title="Open the invoice PDF in your default viewer to compare against the invoice # and total"
                        >
                          View Invoice PDF
                        </button>
                      )}
                      {(order.transbecInvoiceFile || order.transbecInvoiceImage) && onVerifyTransbecInvoice && (
                        <button
                          type="button"
                          onClick={() => onVerifyTransbecInvoice(order)}
                          className="mt-1 px-3 py-1 rounded-full text-xs font-semibold border bg-white text-emerald-700 border-emerald-200 hover:bg-emerald-50 self-start"
                          title="Review the invoice PDF side-by-side with the stored invoice # and total, and correct if needed"
                        >
                          {order.totalVerified ? "Verify Again" : "Verify Invoice"}
                        </button>
                      )}
                      {(order.transbecInvoiceFile || order.transbecInvoiceImage) && onPrintTransbecInvoice && (
                        <button
                          type="button"
                          onClick={() => onPrintTransbecInvoice(order)}
                          disabled={invoicePrintingRef === `transbec:${order.reference}`}
                          className="mt-1 px-3 py-1 rounded-full text-xs font-semibold border bg-white text-indigo-700 border-indigo-200 hover:bg-indigo-50 disabled:opacity-60 self-start"
                          title="Print page 1 of the invoice"
                        >
                          {invoicePrintingRef === `transbec:${order.reference}`
                            ? "Printing..."
                            : order.transbecInvoicePrinted
                            ? "Print Invoice Again"
                            : "Print Invoice"}
                        </button>
                      )}
                      {/* Transbec credit orders (isCredit: true) never have a
                          transbecInvoiceFile — only this one — so View/Print
                          here are the only way to see the attachment. */}
                      {order.transbecCreditFile && onViewTransbecCreditInvoiceImage && (
                        <button
                          type="button"
                          onClick={() => onViewTransbecCreditInvoiceImage(order)}
                          className="mt-1 px-3 py-1 rounded-full text-xs font-semibold border bg-white text-slate-700 border-slate-200 hover:bg-slate-50 self-start"
                          title="Open the credit memo PDF in your default viewer"
                        >
                          View Credit PDF
                        </button>
                      )}
                      {order.transbecCreditFile && onPrintTransbecInvoice && (
                        <button
                          type="button"
                          onClick={() => onPrintTransbecInvoice(order)}
                          disabled={invoicePrintingRef === `transbec:${order.reference}`}
                          className="mt-1 px-3 py-1 rounded-full text-xs font-semibold border bg-white text-indigo-700 border-indigo-200 hover:bg-indigo-50 disabled:opacity-60 self-start"
                          title="Print page 1 of the credit memo"
                        >
                          {invoicePrintingRef === `transbec:${order.reference}`
                            ? "Printing..."
                            : order.transbecInvoicePrinted
                            ? "Print Credit Again"
                            : "Print Credit"}
                        </button>
                      )}
                      {order.source === "transbec" &&
                        order.isCredit &&
                        !order.returnSlipId &&
                        onMatchTransbecCreditToRequisition && (
                          <button
                            type="button"
                            onClick={() => onMatchTransbecCreditToRequisition(order)}
                            className="mt-1 px-3 py-1 rounded-full text-xs font-semibold border bg-white text-amber-700 border-amber-300 hover:bg-amber-50 self-start"
                            title={
                              waitingCreditSlipCount
                                ? `Match this credit to one of the ${waitingCreditSlipCount} requisition(s) waiting on a credit`
                                : "Match this credit to a return requisition (none are waiting on a credit right now)"
                            }
                          >
                            Match to Requisition…
                          </button>
                        )}
                      {order.source === "transbec" && order.isCredit && order.returnSlipId && (
                        <span
                          className="mt-1 px-3 py-1 rounded-full text-xs font-semibold border bg-emerald-50 text-emerald-700 border-emerald-200 self-start"
                          title={`Matched to a requisition${order.returnSlipWarehouse ? ` (${order.returnSlipWarehouse})` : ""}`}
                        >
                          Matched to Requisition
                        </span>
                      )}
                      {/* World credit orders (isCredit: true) never have a
                          worldInvoiceFile — only this one. */}
                      {order.worldCreditFile && onViewWorldCreditInvoiceImage && (
                        <button
                          type="button"
                          onClick={() => onViewWorldCreditInvoiceImage(order)}
                          className="mt-1 px-3 py-1 rounded-full text-xs font-semibold border bg-white text-slate-700 border-slate-200 hover:bg-slate-50 self-start"
                          title="Open the credit memo PDF in your default viewer"
                        >
                          View Credit PDF
                        </button>
                      )}
                      {order.worldCreditFile && onPrintWorldCreditInvoice && (
                        <button
                          type="button"
                          onClick={() => onPrintWorldCreditInvoice(order)}
                          disabled={invoicePrintingRef === `world-credit:${order.reference}`}
                          className="mt-1 px-3 py-1 rounded-full text-xs font-semibold border bg-white text-indigo-700 border-indigo-200 hover:bg-indigo-50 disabled:opacity-60 self-start"
                          title="Print the credit memo"
                        >
                          {invoicePrintingRef === `world-credit:${order.reference}`
                            ? "Printing..."
                            : order.worldCreditInvoicePrinted
                            ? "Print Credit Again"
                            : "Print Credit"}
                        </button>
                      )}
                      {order.source === "world" &&
                        order.isCredit &&
                        !order.returnSlipId &&
                        onMatchWorldCreditToRequisition && (
                          <button
                            type="button"
                            onClick={() => onMatchWorldCreditToRequisition(order)}
                            className="mt-1 px-3 py-1 rounded-full text-xs font-semibold border bg-white text-amber-700 border-amber-300 hover:bg-amber-50 self-start"
                            title={
                              waitingCreditSlipCount
                                ? `Match this credit to one of the ${waitingCreditSlipCount} requisition(s) waiting on a credit`
                                : "Match this credit to a return requisition (none are waiting on a credit right now)"
                            }
                          >
                            Match to Requisition…
                          </button>
                        )}
                      {order.source === "world" && order.isCredit && order.returnSlipId && (
                        <span
                          className="mt-1 px-3 py-1 rounded-full text-xs font-semibold border bg-emerald-50 text-emerald-700 border-emerald-200 self-start"
                          title={`Matched to a requisition${order.returnSlipWarehouse ? ` (${order.returnSlipWarehouse})` : ""}`}
                        >
                          Matched to Requisition
                        </span>
                      )}
                      {order.source === "bestbuy" && !order.bestbuyInvoiceFile && !order.bestbuyCreditFile && onFetchBestbuyInvoices && (
                        <button
                          type="button"
                          onClick={() => onFetchBestbuyInvoices(order.reference)}
                          disabled={bestbuyFetching}
                          className="mt-1 px-3 py-1 rounded-full text-xs font-semibold border bg-white text-indigo-700 border-indigo-200 hover:bg-indigo-50 disabled:opacity-60 self-start"
                        >
                          {bestbuyFetching ? "Checking Gmail..." : "Get Invoice from Gmail"}
                        </button>
                      )}
                      {order.bestbuyInvoiceFile && onViewBestbuyInvoiceImage && (
                        <button
                          type="button"
                          onClick={() => onViewBestbuyInvoiceImage(order)}
                          className="mt-1 px-3 py-1 rounded-full text-xs font-semibold border bg-white text-slate-700 border-slate-200 hover:bg-slate-50 self-start"
                          title="Open the invoice PDF in your default viewer to compare against the invoice # and total"
                        >
                          View Invoice PDF
                        </button>
                      )}
                      {order.bestbuyInvoiceFile && onVerifyBestbuyInvoice && (
                        <button
                          type="button"
                          onClick={() => onVerifyBestbuyInvoice(order)}
                          className="mt-1 px-3 py-1 rounded-full text-xs font-semibold border bg-white text-emerald-700 border-emerald-200 hover:bg-emerald-50 self-start"
                          title="Review the invoice PDF side-by-side with the stored invoice # and total, and correct if needed"
                        >
                          {order.totalVerified ? "Verify Again" : "Verify Invoice"}
                        </button>
                      )}
                      {order.bestbuyInvoiceFile && onPrintBestbuyInvoice && (
                        <button
                          type="button"
                          onClick={() => onPrintBestbuyInvoice(order)}
                          disabled={invoicePrintingRef === `bestbuy:${order.reference}`}
                          className="mt-1 px-3 py-1 rounded-full text-xs font-semibold border bg-white text-indigo-700 border-indigo-200 hover:bg-indigo-50 disabled:opacity-60 self-start"
                          title="Print page 1 of the invoice"
                        >
                          {invoicePrintingRef === `bestbuy:${order.reference}`
                            ? "Printing..."
                            : order.bestbuyInvoicePrinted
                            ? "Print Invoice Again"
                            : "Print Invoice"}
                        </button>
                      )}
                      {/* Credit invoice check piggybacks on the button above — no
                          separate fetch button, it's found in the same Gmail check.
                          The invoice # and billed total fill the normal fields; only
                          the View/Print Credit actions are credit-specific. */}
                      {order.bestbuyCreditFile && onViewBestbuyCreditInvoiceImage && (
                        <button
                          type="button"
                          onClick={() => onViewBestbuyCreditInvoiceImage(order)}
                          className="mt-1 px-3 py-1 rounded-full text-xs font-semibold border bg-white text-slate-700 border-slate-200 hover:bg-slate-50 self-start"
                          title="Open the credit invoice PDF in your default viewer"
                        >
                          View Credit PDF
                        </button>
                      )}
                      {order.bestbuyCreditFile && onPrintBestbuyCreditInvoice && (
                        <button
                          type="button"
                          onClick={() => onPrintBestbuyCreditInvoice(order)}
                          disabled={invoicePrintingRef === `bestbuy-credit:${order.reference}`}
                          className="mt-1 px-3 py-1 rounded-full text-xs font-semibold border bg-white text-indigo-700 border-indigo-200 hover:bg-indigo-50 disabled:opacity-60 self-start"
                          title="Print page 1 of the credit invoice"
                        >
                          {invoicePrintingRef === `bestbuy-credit:${order.reference}`
                            ? "Printing..."
                            : order.bestbuyCreditInvoicePrinted
                            ? "Print Credit Again"
                            : "Print Credit"}
                        </button>
                      )}
                      {order.source === "cbk" && !order.cbkInvoiceFile && onFetchCbkInvoices && (
                        <button
                          type="button"
                          onClick={() => onFetchCbkInvoices(order.reference)}
                          disabled={cbkFetching}
                          className="mt-1 px-3 py-1 rounded-full text-xs font-semibold border bg-white text-indigo-700 border-indigo-200 hover:bg-indigo-50 disabled:opacity-60 self-start"
                        >
                          {cbkFetching ? "Checking Gmail..." : "Get Invoice from Gmail"}
                        </button>
                      )}
                      {order.cbkInvoiceFile && onViewCbkInvoiceImage && (
                        <button
                          type="button"
                          onClick={() => onViewCbkInvoiceImage(order)}
                          className="mt-1 px-3 py-1 rounded-full text-xs font-semibold border bg-white text-slate-700 border-slate-200 hover:bg-slate-50 self-start"
                          title="Open the invoice PDF in your default viewer to compare against the invoice # and total"
                        >
                          View Invoice PDF
                        </button>
                      )}
                      {order.cbkInvoiceFile && onVerifyCbkInvoice && (
                        <button
                          type="button"
                          onClick={() => onVerifyCbkInvoice(order)}
                          className="mt-1 px-3 py-1 rounded-full text-xs font-semibold border bg-white text-emerald-700 border-emerald-200 hover:bg-emerald-50 self-start"
                          title="Review the invoice PDF side-by-side with the stored invoice # and total, and correct if needed"
                        >
                          {order.totalVerified ? "Verify Again" : "Verify Invoice"}
                        </button>
                      )}
                      {order.cbkInvoiceFile && onPrintCbkInvoice && (
                        <button
                          type="button"
                          onClick={() => onPrintCbkInvoice(order)}
                          disabled={invoicePrintingRef === `cbk:${order.reference}`}
                          className="mt-1 px-3 py-1 rounded-full text-xs font-semibold border bg-white text-indigo-700 border-indigo-200 hover:bg-indigo-50 disabled:opacity-60 self-start"
                          title="Print page 1 of the invoice"
                        >
                          {invoicePrintingRef === `cbk:${order.reference}`
                            ? "Printing..."
                            : order.cbkInvoicePrinted
                            ? "Print Invoice Again"
                            : "Print Invoice"}
                        </button>
                      )}
                      {/* Proforce never emails regular invoices (those are
                          already fully captured off the portal scrape) - only
                          credit memos, so this fetch/view/print is restricted
                          to orders proforceScraper.js already flagged isCredit. */}
                      {order.source === "proforce" &&
                        order.isCredit &&
                        !order.proforceCreditFile &&
                        onFetchProforceCreditInvoices && (
                          <button
                            type="button"
                            onClick={() => onFetchProforceCreditInvoices(order.reference)}
                            disabled={proforceCreditFetching}
                            className="mt-1 px-3 py-1 rounded-full text-xs font-semibold border bg-white text-indigo-700 border-indigo-200 hover:bg-indigo-50 disabled:opacity-60 self-start"
                          >
                            {proforceCreditFetching ? "Checking Gmail..." : "Get Invoice from Gmail"}
                          </button>
                        )}
                      {order.proforceCreditFile && onViewProforceCreditInvoiceImage && (
                        <button
                          type="button"
                          onClick={() => onViewProforceCreditInvoiceImage(order)}
                          className="mt-1 px-3 py-1 rounded-full text-xs font-semibold border bg-white text-slate-700 border-slate-200 hover:bg-slate-50 self-start"
                          title="Open the credit invoice PDF in your default viewer"
                        >
                          View Credit PDF
                        </button>
                      )}
                      {order.proforceCreditFile && onPrintProforceCreditInvoice && (
                        <button
                          type="button"
                          onClick={() => onPrintProforceCreditInvoice(order)}
                          disabled={invoicePrintingRef === `proforce-credit:${order.reference}`}
                          className="mt-1 px-3 py-1 rounded-full text-xs font-semibold border bg-white text-indigo-700 border-indigo-200 hover:bg-indigo-50 disabled:opacity-60 self-start"
                          title="Print the credit invoice"
                        >
                          {invoicePrintingRef === `proforce-credit:${order.reference}`
                            ? "Printing..."
                            : order.proforceCreditInvoicePrinted
                            ? "Print Credit Again"
                            : "Print Credit"}
                        </button>
                      )}
                      {order.source === "proforce" &&
                        order.isCredit &&
                        !order.returnSlipId &&
                        onMatchProforceCreditToRequisition && (
                          <button
                            type="button"
                            onClick={() => onMatchProforceCreditToRequisition(order)}
                            className="mt-1 px-3 py-1 rounded-full text-xs font-semibold border bg-white text-amber-700 border-amber-300 hover:bg-amber-50 self-start"
                            title={
                              waitingCreditSlipCount
                                ? `Match this credit to one of the ${waitingCreditSlipCount} requisition(s) waiting on a credit`
                                : "Match this credit to a return requisition (none are waiting on a credit right now)"
                            }
                          >
                            Match to Requisition…
                          </button>
                        )}
                      {order.source === "proforce" && order.isCredit && order.returnSlipId && (
                        <span
                          className="mt-1 px-3 py-1 rounded-full text-xs font-semibold border bg-emerald-50 text-emerald-700 border-emerald-200 self-start"
                          title={`Matched to a requisition${order.returnSlipWarehouse ? ` (${order.returnSlipWarehouse})` : ""}`}
                        >
                          Matched to Requisition
                        </span>
                      )}
                    </div>
                    <div className="flex flex-col gap-1">
                      <span className="text-xs uppercase tracking-wide text-slate-400">Journal Entry</span>
                      <input
                        className="border rounded-xl px-3 py-1.5 bg-white text-sm text-slate-700 max-w-xs"
                        value={order.journalEntry || ""}
                        onChange={(e) => handleOrderFieldChange(refKey, "journalEntry", e.target.value)}
                        />
                      </div>
                    </div>
                    {Array.isArray(order.lineItems) && order.lineItems.length > 0 && (
                      <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
                        <div className="text-xs uppercase tracking-wide text-slate-400 mb-1">
                          Line Items
                        </div>
                        <div className="space-y-1">
                          {order.lineItems.map((item, liIdx) => {
                            const qty = item.quantity ?? "";
                            const part =
                              item.partLineCode || item.partNumber
                                ? `${item.partLineCode || ""} ${item.partNumber || ""}`.trim()
                                : "Item";
                            const desc = (item.partDescription || "").trim();
                            const cost = item.costPrice ?? item.extended ?? "";
                            const rowTone = liIdx % 2 === 0 ? "bg-blue-50" : "bg-white";
                            const feeKey = `${refKey}-li-${liIdx}`;
                            const draft = lineItemFeeDrafts[feeKey];
                            const rawFee = draft?.value ?? (item.environmentalFeeAmount ?? "");
                            const hasFeeVal =
                              Boolean(item?.hasEnvironmentalFee) ||
                              (draft?.value !== undefined && String(draft.value || "").trim() !== "") ||
                              (draft?.value === undefined &&
                                item &&
                                item.environmentalFeeAmount !== null &&
                                item.environmentalFeeAmount !== undefined &&
                                String(item.environmentalFeeAmount).trim() !== "");
                            const showFeeInput = hasFeeVal || Boolean(draft?.editing);
                            const handleFeeChange = (value) => {
                              // Shared with the World Gmail invoice fetch, which
                              // applies the same per-unit fee automatically —
                              // see utils/environmentalFee.js.
                              const next = applyEnvironmentalFee(order, liIdx, value);

                              setLineItemFeeDrafts((prev) => ({
                                ...prev,
                                [feeKey]: { editing: true, value },
                              }));
                              markDirty(refKey, "Environmental fee");
                              handleOrderFieldChange(refKey, "lineItems", next.lineItems);
                              handleOrderFieldChange(refKey, "sage_lineItems", next.sage_lineItems);
                            };
                            return (
                              <div
                                key={`${order.reference || idx}-li-${liIdx}`}
                                className={`text-xs text-slate-700 flex items-center justify-between gap-3 px-3 py-1.5 rounded-lg ${rowTone}`}
                              >
                                <div className="flex-1 min-w-0 flex items-center gap-2">
                                  <span className="shrink-0">
                                    {part} <span className="text-slate-400">x</span> {qty}
                                  </span>
                                  <div className="flex items-center gap-2 shrink-0">
                                    {showFeeInput ? (
                                      <input
                                        type="text"
                                        value={rawFee ?? ""}
                                        onChange={(e) => handleFeeChange(e.target.value)}
                                        onBlur={() => {
                                          const currentVal =
                                            lineItemFeeDrafts[feeKey]?.value ??
                                            item.environmentalFeeAmount ??
                                            "";
                                          const hasVal = String(currentVal || "").trim() !== "";
                                          if (!hasVal) {
                                            setLineItemFeeDrafts((prev) => {
                                              const { [feeKey]: _, ...rest } = prev;
                                              return rest;
                                            });
                                          } else {
                                            setLineItemFeeDrafts((prev) => ({
                                              ...prev,
                                              [feeKey]: { ...(prev[feeKey] || {}), editing: false },
                                            }));
                                          }
                                        }}
                                        placeholder="Env fee"
                                        className="w-20 border border-emerald-200 rounded-lg px-2 py-1 text-[11px] text-emerald-800 bg-white shadow-inner"
                                      />
                                    ) : (
                                      <button
                                        type="button"
                                        title="Add Environmental Fee"
                                        className="px-2 py-1 rounded-full text-[11px] font-semibold border border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
                                        onClick={() =>
                                          setLineItemFeeDrafts((prev) => ({
                                            ...prev,
                                            [feeKey]: {
                                              editing: true,
                                              value: item.environmentalFeeAmount ?? "",
                                            },
                                          }))
                                        }
                                      >
                                        +ev
                                      </button>
                                    )}
                                  </div>
                                  {desc && (
                                    <div className="min-w-0 flex-1">
                                      <DescriptionWithTooltip text={desc} />
                                    </div>
                                  )}
                                </div>
                                <span className="font-semibold text-slate-800 tabular-nums">{cost}</span>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                    {needsSync && (
                      <div className="mt-3 text-xs font-semibold text-red-700 flex items-center gap-2 flex-wrap">
                        <span className="inline-block h-2 w-2 rounded-full bg-red-600"></span>
                        <span>
                          {order.sage_reference_synced
                            ? `Invoice differs from last Sage update (${order.sage_reference_synced})`
                            : "Invoice differs from last Sage update"}
                        </span>
                        {/* Same three states as "Add to Sage Queue" on a
                            purchase: the update is parked in the Sage queue and
                            nothing is typed into Sage until "Send to Sage"
                            releases it to the machine running Sage. Clicking it
                            while queued takes it back out. */}
                        <button
                          type="button"
                          disabled={isInvoiceTriggered}
                          className={`px-2 py-1 text-xs rounded-lg border ${
                            isInvoiceTriggered
                              ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                              : isInvoiceQueued
                              ? "bg-violet-50 text-violet-700 border-violet-300 hover:bg-violet-100"
                              : "border-red-500 text-red-700 bg-white hover:bg-red-50"
                          }`}
                          title={
                            isInvoiceTriggered
                              ? "Released — waiting for the machine running Sage to update it"
                              : isInvoiceQueued
                              ? 'Waiting in the Sage queue — press "Send to Sage" at the top to release it, or click here to take it back out'
                              : "Add this invoice update to the Sage queue. Nothing is changed in Sage until the queue is sent."
                          }
                          onClick={() =>
                            isInvoiceQueued
                              ? onReleaseSageLock?.(order)
                              : onUpdateInvoiceTrigger?.(refKey)
                          }
                        >
                          {isInvoiceTriggered
                            ? "Updating in Sage"
                            : isInvoiceQueued
                            ? "In Sage Queue — remove"
                            : "Update Invoice"}
                        </button>
                      </div>
                    )}
                    {hasQtyDiscrepancy && (
                      <div className="mt-3 text-xs font-semibold text-red-700 flex items-center gap-2 flex-wrap">
                        <span className="inline-block h-2 w-2 rounded-full bg-red-600"></span>
                        <span>
                          Billed total ${qtyDiscrepancy.billedTotal.toFixed(2)} vs. line items total $
                          {qtyDiscrepancy.expectedTotal.toFixed(2)} (diff {qtyDiscrepancy.diff >= 0 ? "+" : ""}
                          ${qtyDiscrepancy.diff.toFixed(2)}) — confirm quantities
                          {order.enteredInSage
                            ? " (already in Sage; this corrects the record only)."
                            : " before sending to Sage."}
                        </span>
                        <button
                          type="button"
                          className="px-2 py-1 text-xs rounded-lg border border-red-500 text-red-700 bg-white hover:bg-red-50"
                          onClick={() => onOpenQtyConfirm?.(refKey)}
                        >
                          Confirm Quantities
                        </button>
                      </div>
                    )}
                    {Boolean(order.sage_run_warning) && (
                      <div className="mt-3 text-xs font-semibold text-amber-700 flex items-center gap-2 flex-wrap">
                        <span className="inline-block h-2 w-2 rounded-full bg-amber-600"></span>
                        <span className="flex-1 min-w-[12rem]">{order.sage_run_warning}</span>
                        <button
                          type="button"
                          className="px-2 py-1 text-xs rounded-lg border border-amber-500 text-amber-700 bg-white hover:bg-amber-50"
                          onClick={() => {
                            markDirty(refKey, "Sage run warning checked");
                            handleOrderFieldChange(refKey, "sage_run_warning", "");
                          }}
                        >
                          Checked
                        </button>
                      </div>
                    )}
                    {/* The value check only tinted the card before, with no
                        statement of what was wrong and no way to clear it — so
                        an order could sit unarchivable with nothing explaining
                        why. Sage is routinely corrected by hand after the run
                        that raised this, and nothing tells the app that, so the
                        figures are labelled "last synced" and clearing is a
                        first-class action rather than an override. */}
                    {needsValueCheck && (
                      <div className="mt-3 rounded-xl border border-indigo-300 bg-indigo-50/70 px-3 py-2">
                        <div className="text-xs font-semibold text-indigo-800 flex items-center gap-2">
                          <span className="inline-block h-2 w-2 rounded-full bg-indigo-600"></span>
                          Value check — Sage and the bill disagree
                        </div>
                        {Number.isFinite(billedNum) && Number.isFinite(sageNum) && (
                          <div className="mt-1 text-xs text-slate-600 flex flex-wrap gap-x-4 gap-y-0.5">
                            <span>
                              Sage (last synced):{" "}
                              <span className="font-semibold text-slate-800">${sageNum.toFixed(2)}</span>
                            </span>
                            <span>
                              Bill: <span className="font-semibold text-slate-800">${billedNum.toFixed(2)}</span>
                            </span>
                            <span>
                              Difference:{" "}
                              <span className="font-semibold text-indigo-700">
                                ${Math.abs(billedNum - sageNum).toFixed(2)}
                              </span>
                            </span>
                          </div>
                        )}
                        <button
                          type="button"
                          className="mt-2 px-2 py-1 text-xs font-semibold rounded-lg border border-indigo-500 text-indigo-700 bg-white hover:bg-indigo-50"
                          onClick={() => onClearValueCheck?.(refKey)}
                          title="Clears this alert so the order can be archived. Use when Sage is correct now — including when you have already fixed it by hand."
                        >
                          Sage fixed by hand — clear alert
                        </button>
                      </div>
                    )}
                    {Boolean(order.environmentalFeeAlert) && (
                      <div className="mt-3 text-xs font-semibold text-amber-700 flex items-center gap-2 flex-wrap">
                        <span className="inline-block h-2 w-2 rounded-full bg-amber-600"></span>
                        <span>
                          Environmental fee detected on invoice
                          {order.environmentalFeeAmount ? ` ($${order.environmentalFeeAmount})` : ""} — needs to
                          be entered.
                        </span>
                        <button
                          type="button"
                          className="px-2 py-1 text-xs rounded-lg border border-amber-500 text-amber-700 bg-white hover:bg-amber-50"
                          onClick={() => {
                            markDirty(refKey, "Environmental fee entered");
                            handleOrderFieldChange(refKey, "environmentalFeeAlert", false);
                          }}
                        >
                          Mark Entered
                        </button>
                      </div>
                    )}
                    {!needsSync && isDirty && reasons.length > 0 && (
                      <div className="mt-3 text-xs font-semibold text-amber-700 flex items-center gap-2">
                        <span className="inline-block h-2 w-2 rounded-full bg-amber-600"></span>
                        Unsaved changes: {reasons.join(", ")}
                      </div>
                    )}
                    {needsSync && (
                      <div className="mt-3 text-xs font-semibold text-red-700 flex items-center gap-2">
                        <span className="inline-block h-2 w-2 rounded-full bg-red-600"></span>
                        Invoice differs from last Sage update
                      </div>
                    )}
                  </Card>
                </React.Fragment>
              );
            })}
            {!ordersLoading && filteredOrders.length === 0 && !ordersError && (
              <Card>
                <div className="py-10 text-center text-slate-500 text-sm">
                  {hasSearch ? "No orders match your search." : "No orders available from the data source."}
                </div>
              </Card>
            )}
          </div>
        )}
      </section>
      <aside className="w-full xl:w-72 shrink-0 xl:sticky xl:top-4">
        <Card>
          <div className="text-sm uppercase tracking-wide text-slate-400 font-semibold">
            Recently Archived
          </div>
          <div className="mt-3 flex flex-col gap-2">
            {(recentArchivedOrders || []).length === 0 && (
              <div className="text-sm text-slate-400">Nothing archived yet.</div>
            )}
            {(recentArchivedOrders || []).map((row, idx) => (
              <div
                key={`${row.reference || row.invoice || "archived"}-${row.archivedAt || idx}`}
                className={`rounded-xl border px-3 py-2 text-xs ${
                  idx === 0
                    ? "border-indigo-300 bg-indigo-50 ring-1 ring-indigo-200"
                    : "border-slate-200 bg-white/60"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className={`font-semibold uppercase ${idx === 0 ? "text-indigo-700" : "text-slate-600"}`}>
                    {(row.warehouse || "-").slice(0, 5)}
                  </span>
                  <span className="text-slate-500">{row.invoice || "-"}</span>
                </div>
                <div className="mt-1 flex items-center justify-between gap-2">
                  <span className="text-slate-700 font-semibold">
                    {Number.isFinite(row.total) ? `$${row.total.toFixed(2)}` : "-"}
                  </span>
                  <span className="text-slate-500 truncate max-w-[9rem]" title={row.journalEntry || ""}>
                    {row.journalEntry || "-"}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </Card>
      </aside>
      </div>
    </>
  );
}
