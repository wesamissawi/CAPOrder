import React, { useState } from "react";
import Card from "../components/Card";

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

// sageDate is DDMMYY (e.g. "170726").
function parseSageDate(ddmmyy) {
  const clean = String(ddmmyy || "").trim();
  if (!/^\d{6}$/.test(clean)) return null;
  const day = Number(clean.slice(0, 2));
  const month = Number(clean.slice(2, 4));
  const year = 2000 + Number(clean.slice(4, 6));
  const date = new Date(year, month - 1, day);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatSageDate(date) {
  const dd = String(date.getDate()).padStart(2, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const yy = String(date.getFullYear()).slice(-2);
  return `${dd}${mm}${yy}`;
}

// Epicor search should span every World bill currently displayed that's still
// missing an invoice, not just the one whose button was clicked — the OCR pass
// discovers matches for every invoice in the range and applies them to every
// order that needs one. The start is padded a day earlier than the earliest
// bill since Epicor sometimes dates a scanned invoice a day before the order.
function getEpicorSearchRange(orders, fallbackSageDate) {
  const dates = (orders || [])
    .filter((o) => o.source === "world" && !o.source_invoice)
    .map((o) => parseSageDate(o.sageDate))
    .filter(Boolean);
  if (!dates.length) {
    return { fromSageDate: fallbackSageDate, toSageDate: fallbackSageDate };
  }
  const minDate = new Date(Math.min(...dates.map((d) => d.getTime())));
  const maxDate = new Date(Math.max(...dates.map((d) => d.getTime())));
  minDate.setDate(minDate.getDate() - 1);
  return { fromSageDate: formatSageDate(minDate), toSageDate: formatSageDate(maxDate) };
}

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
  orderFilterCounts,
  handleOrderCheckboxChange,
  handleOrderFieldChange,
  onMarkForSage,
  onBubblifyOrder,
  onMarkComplete,
  onReconcileTotals,
  onArchiveOrder,
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
  onClearOrderFetchMessage,
  onClearInvoiceFetchMessage,
  onOpenEpicor,
  epicorOpening,
  epicorStatus,
  epicorError,
  onViewEpicorInvoiceImage,
  onVerifyEpicorInvoice,
  onFetchTransbecInvoices,
  transbecFetching,
  transbecStatus,
  transbecError,
  onViewTransbecInvoiceImage,
  onVerifyTransbecInvoice,
  onPrintTransbecInvoice,
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
  invoicePrintingRef,
  onPrintAllNotPrinted,
  printAllRunning,
  onArchiveAllNeedsArchive,
  archiveAllRunning,
  onUpdateInvoiceTrigger,
  onConfirmOrderEdit,
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
    { value: "not-entered-sage", label: "To Process" },
    { value: "not-arrived", label: "Not Arrived", badge: true },
    { value: "no-invoice", label: "Invoice Mismatch", badge: true },
    { value: "not-confirmed", label: "Not Confirmed", badge: true },
    { value: "not-printed", label: "Not Printed", badge: true },
    { value: "not-picked", label: "Not Picked Up", badge: true },
    { value: "needs-archive", label: "Needs Archive", badge: true },
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

  return (
    <>
      <style>{valueCheckStyles}</style>
      <section>
        <Card>
          <div className="text-sm uppercase tracking-wide text-slate-400 font-semibold">Order Fetcher</div>
          <div className="mt-2 flex flex-wrap gap-3">
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
                                ? "bg-white text-red-600"
                                : "bg-red-100 text-red-700 border border-red-200"
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
              <button
                onClick={handleSaveOrders}
                disabled={!ordersDirty || ordersSaving}
                className="px-4 py-2 rounded-xl bg-emerald-600 text-white text-sm font-semibold disabled:opacity-50"
              >
                {ordersSaving ? "Saving..." : ordersDirty ? "Save Changes" : "Saved"}
              </button>
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
          {epicorError && (
            <DismissibleMessage tone="error" onDismiss={() => onClearInvoiceFetchMessage?.("epicor")}>
              {epicorError}
            </DismissibleMessage>
          )}
          {epicorStatus && !epicorError && (
            <DismissibleMessage tone="status" onDismiss={() => onClearInvoiceFetchMessage?.("epicor")}>
              {epicorStatus}
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
        </Card>
      </section>
      <section>
        {ordersLoading && filteredOrders.length === 0 ? (
          <div className="py-12 text-center text-slate-500">Loading orders...</div>
        ) : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {filteredOrders.map((order, idx) => {
              const key = `${order.source || "unknown"}-${order.reference || order.__row || "order"}-${order.warehouse || "warehouse"}-${idx}`;
              const refKey = order.reference || order.__row || key;
              const isSageTriggered = Boolean(order.sage_trigger);
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
              const allBubblified =
                Array.isArray(order.lineItems) &&
                order.lineItems.length > 0 &&
                order.lineItems.every((li) => li?.addedToOutstanding === true);
              const cardTone = needsValueCheck
                ? "value-check-alert border-indigo-400"
                : isDirty
                ? `animate-pulse ${
                    needsSync
                      ? "border-red-500 bg-red-50 ring-2 ring-red-300"
                      : "border-amber-500 bg-amber-50 ring-2 ring-amber-300"
                  }`
                : "border-indigo-100";
              return (
                <Card
                  key={key}
                  className={`${cardTone}`}
                >
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
                        {onBubblifyOrder && (
                          <button
                            type="button"
                            disabled={allBubblified}
                            onClick={() => !allBubblified && onBubblifyOrder(refKey)}
                            className={`px-3 py-1 rounded-full text-xs font-semibold border ${
                              allBubblified
                                ? "bg-teal-50 text-teal-600 border-teal-200 cursor-default opacity-75"
                                : "bg-white text-emerald-700 border-emerald-200 hover:bg-emerald-50"
                            }`}
                          >
                            {allBubblified ? "Bubblified" : "Bubblify"}
                          </button>
                        )}
                        {!order.enteredInSage && (
                          <button
                            type="button"
                            onClick={() => onMarkForSage(refKey)}
                            disabled={isSageTriggered}
                            className={`px-3 py-1 rounded-full text-xs font-semibold border ${
                              isSageTriggered
                                ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                                : "bg-white text-indigo-700 border-indigo-200 hover:bg-indigo-50"
                            }`}
                          >
                            {isSageTriggered ? "Ready for Sage" : "Send to Sage"}
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
                          onClick={() => onArchiveOrder?.(refKey, order.source)}
                          className="px-3 py-2 rounded-xl text-sm font-semibold border bg-slate-900 text-white hover:bg-slate-800"
                        >
                          Archive Order
                        </button>
                      )}
                      {Boolean(order.epicorOnly) && !canArchiveOrder(order) && onDeleteOrder && (
                        <button
                          type="button"
                          onClick={() => onDeleteOrder(order)}
                          className="px-3 py-2 rounded-xl text-sm font-semibold border bg-white text-red-600 border-red-200 hover:bg-red-50"
                          title="Permanently remove this Epicor-generated order from Order Management"
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
                      {order.source === "world" && !order.source_invoice && onOpenEpicor && (
                        <button
                          type="button"
                          onClick={() => {
                            const { fromSageDate, toSageDate } = getEpicorSearchRange(filteredOrders, order.sageDate);
                            onOpenEpicor(order.reference, fromSageDate, toSageDate);
                          }}
                          disabled={epicorOpening}
                          className="mt-1 px-3 py-1 rounded-full text-xs font-semibold border bg-white text-indigo-700 border-indigo-200 hover:bg-indigo-50 disabled:opacity-60 self-start"
                        >
                          {epicorOpening ? "Opening Epicor..." : "Get Invoice from Epicor"}
                        </button>
                      )}
                      {order.epicorInvoiceImage && onViewEpicorInvoiceImage && (
                        <button
                          type="button"
                          onClick={() => onViewEpicorInvoiceImage(order.epicorInvoiceImage)}
                          className="mt-1 px-3 py-1 rounded-full text-xs font-semibold border bg-white text-slate-700 border-slate-200 hover:bg-slate-50 self-start"
                          title="Open the scanned invoice image to compare against the invoice # and total"
                        >
                          View Invoice Image
                        </button>
                      )}
                      {order.epicorInvoiceImage && onVerifyEpicorInvoice && (
                        <button
                          type="button"
                          onClick={() => onVerifyEpicorInvoice(order)}
                          className="mt-1 px-3 py-1 rounded-full text-xs font-semibold border bg-white text-emerald-700 border-emerald-200 hover:bg-emerald-50 self-start"
                          title="Review the scanned invoice side-by-side with the stored invoice # and total, and correct if needed"
                        >
                          Verify Invoice
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
                          Verify Invoice
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
                          Verify Invoice
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
                          Verify Invoice
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
                            const toNumber = (val) => {
                              const n = Number(val);
                              return Number.isFinite(n) ? n : null;
                            };
                            const handleFeeChange = (value) => {
                              const trimmed = String(value || "").trim();
                              const hasFee = trimmed !== "";
                              const parsed = Number(trimmed);
                              const amountVal = hasFee && Number.isFinite(parsed) ? parsed : hasFee ? trimmed : null;

                              const baseLineItems = order.lineItems || [];
                              const baseLineItem = baseLineItems[liIdx] || item || {};
                              const baseCostVal = toNumber(baseLineItem.costPriceValue ?? baseLineItem.costPrice);
                              const baseCostStr =
                                baseLineItem.costPrice ??
                                order.sage_lineItems?.[liIdx]?.costPrice ??
                                "";
                              const baseExtendedVal = toNumber(baseLineItem.extendedValue ?? baseLineItem.extended);
                              const baseExtendedStr =
                                baseLineItem.extended ??
                                order.sage_lineItems?.[liIdx]?.extended ??
                                "";
                              const qtyVal =
                                toNumber(baseLineItem.quantity) ??
                                toNumber(order.sage_lineItems?.[liIdx]?.quantity) ??
                                0;
                              const feeNum = toNumber(amountVal);

                              const nextCostVal =
                                hasFee && feeNum !== null && baseCostVal !== null
                                  ? baseCostVal + feeNum
                                  : baseCostVal;
                              const nextCostStr =
                                hasFee && feeNum !== null && baseCostVal !== null
                                  ? String(nextCostVal)
                                  : baseCostStr;

                              const nextExtendedVal =
                                hasFee && feeNum !== null && baseExtendedVal !== null
                                  ? baseExtendedVal + feeNum * qtyVal
                                  : baseExtendedVal;
                              const nextExtendedStr =
                                hasFee && feeNum !== null && baseExtendedVal !== null
                                  ? String(nextExtendedVal)
                                  : baseExtendedStr;

                              const nextLineItems = (order.lineItems || []).map((li, idx) => {
                                if (idx !== liIdx) return li;
                                const updated = {
                                  ...li,
                                  hasEnvironmentalFee: hasFee,
                                  environmentalFeeAmount: amountVal,
                                };
                                return updated;
                              });

                              const baseSage = Array.isArray(order.sage_lineItems) && order.sage_lineItems.length
                                ? order.sage_lineItems
                                : order.lineItems || [];
                              const nextSageLineItems = baseSage.map((li, idx) => {
                                if (idx !== liIdx) return li;
                                const source = li || baseLineItem;
                                const updated = {
                                  ...source,
                                  hasEnvironmentalFee: hasFee,
                                  environmentalFeeAmount: amountVal,
                                };
                                if (nextCostVal !== null) {
                                  updated.costPrice = nextCostStr;
                                  updated.costPriceValue = nextCostVal;
                                } else {
                                  updated.costPrice = baseCostStr;
                                  updated.costPriceValue = baseCostVal;
                                }
                                if (nextExtendedVal !== null) {
                                  updated.extended = nextExtendedStr;
                                  updated.extendedValue = nextExtendedVal;
                                } else {
                                  updated.extended = baseExtendedStr;
                                  updated.extendedValue = baseExtendedVal;
                                }
                                return updated;
                              });

                              setLineItemFeeDrafts((prev) => ({
                                ...prev,
                                [feeKey]: { editing: true, value },
                              }));
                              markDirty(refKey, "Environmental fee");
                              handleOrderFieldChange(refKey, "lineItems", nextLineItems);
                              handleOrderFieldChange(refKey, "sage_lineItems", nextSageLineItems);
                            };
                            return (
                              <div
                                key={`${order.reference || idx}-li-${liIdx}`}
                                className={`text-xs text-slate-700 flex items-center justify-between gap-3 px-3 py-1.5 rounded-lg ${rowTone}`}
                              >
                                <div className="flex-1 min-w-0 flex items-center gap-2">
                                  <span className="truncate">
                                    {part} <span className="text-slate-400">x</span> {qty}
                                  </span>
                                  <div className="flex items-center gap-2">
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
                        <button
                          type="button"
                          className="px-2 py-1 text-xs rounded-lg border border-red-500 text-red-700 bg-white hover:bg-red-50"
                          onClick={() => onUpdateInvoiceTrigger?.(refKey)}
                        >
                          Update Invoice
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
    </>
  );
}
