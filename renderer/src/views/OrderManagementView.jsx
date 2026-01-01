import React, { useState } from "react";
import Card from "../components/Card";

export default function OrderManagementView({
  ordersSourcePath,
  ordersSearch,
  setOrdersSearch,
  ordersPickupFilter,
  setOrdersPickupFilter,
  ordersDirty,
  ordersSaving,
  ordersLoading,
  ordersError,
  loadOrders,
  handleSaveOrders,
  filteredOrders,
  handleOrderCheckboxChange,
  handleOrderFieldChange,
  onMarkForSage,
  onMarkComplete,
  hasSearch,
}) {
  const [invoiceEdits, setInvoiceEdits] = useState({});
  const [dirtyRefs, setDirtyRefs] = useState({});
  const [dirtyReasons, setDirtyReasons] = useState({});

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
    }
  }, [ordersDirty]);

  const filters = [
    { value: "all", label: "All" },
    { value: "not-picked", label: "Not Picked Up" },
    { value: "not-arrived", label: "Not Arrived" },
    { value: "not-entered-sage", label: "Not Entered in Sage" },
    { value: "totals-not-verified", label: "Totals Not Verified" },
    { value: "no-invoice", label: "No Invoice #" },
  ];

  return (
    <>
      <section>
        <Card>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
            <div className="text-sm uppercase tracking-wide text-slate-400">Orders feed</div>
            <div className="text-base font-semibold text-slate-700">Live orders from your local server</div>
            <div className="text-xs text-slate-400 mt-1">
              Source:{" "}
              <code className="text-indigo-600 break-all">
                  {ordersSourcePath || "orders.json (user data folder)"}
                </code>
              </div>
            </div>
            <div className="flex flex-col sm:flex-row sm:items-center gap-2">
              <input
                type="search"
                value={ordersSearch}
                onChange={(e) => setOrdersSearch(e.target.value)}
                placeholder="Search orders..."
                className="w-full sm:w-56 border rounded-xl px-3 py-2 text-sm bg-white"
              />
              <div className="flex flex-wrap gap-2">
                {filters.map((filter) => {
                  const isActive = ordersPickupFilter === filter.value;
                  return (
                    <button
                      key={filter.value}
                      type="button"
                      onClick={() => setOrdersPickupFilter(filter.value)}
                      className={`px-3 py-2 rounded-xl text-xs sm:text-sm font-semibold border transition ${
                        isActive
                          ? "bg-indigo-600 text-white border-indigo-600 shadow-sm"
                          : "bg-white text-slate-700 border-slate-200 hover:bg-indigo-50"
                      }`}
                    >
                      {filter.label}
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
          {ordersError && (
            <div className="mt-3 rounded-xl bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">
              {ordersError}
            </div>
          )}
        </Card>
      </section>
      <section>
        {ordersLoading && filteredOrders.length === 0 ? (
          <div className="py-12 text-center text-slate-500">Loading orders...</div>
        ) : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {filteredOrders.map((order, idx) => {
              const key = `${order.reference || "order"}-${order.warehouse || idx}`;
              const refKey = order.reference || order.__row || key;
              const isSageTriggered = Boolean(order.sage_trigger);
              const invoiceEntry = getInvoiceEntry(refKey, order.source_invoice || "");
              const needsSync = Boolean(order.invoiceNeedsSync);
              const reasons = dirtyReasons[refKey] || [];
              const isDirty = (ordersDirty && dirtyRefs[refKey]) || invoiceEntry.dirty || needsSync;
              return (
                <Card
                  key={key}
                  className={`${
                    isDirty
                      ? `animate-pulse ${
                          needsSync
                            ? "border-red-500 bg-red-50 ring-2 ring-red-300"
                            : "border-amber-500 bg-amber-50 ring-2 ring-amber-300"
                        }`
                      : "border-indigo-100"
                  }`}
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
                      </div>
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
                  </div>
                  <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
                    {[
                      { label: "Picked Up", field: "pickedUp" },
                      { label: "Arrived", field: "inStore" },
                      { label: "Entered in Sage", field: "enteredInSage" },
                      { label: "Value Check", field: "totalVerified" },
                    ].map((meta) => {
                      const checked = Boolean(order[meta.field]);
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
                        </label>
                      );
                    })}
                  </div>
                  <div className="mt-2">
                    <button
                      type="button"
                      onClick={() => onMarkComplete(refKey)}
                      className="px-3 py-2 rounded-xl text-sm font-semibold border bg-emerald-600 text-white hover:bg-emerald-700"
                    >
                      Mark Complete
                    </button>
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
                          onBlur={() => stopInvoiceEdit(refKey)}
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
                            return (
                              <div
                                key={`${order.reference || idx}-li-${liIdx}`}
                                className="text-xs text-slate-700 flex items-center justify-between gap-2"
                              >
                                <span className="truncate">
                                  {part} <span className="text-slate-400">x</span> {qty}
                                </span>
                                <span className="font-semibold text-slate-800 tabular-nums">
                                  {cost}
                                </span>
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
                          onClick={() => {
                            markDirty(refKey, "Invoice update queued");
                            handleOrderFieldChange(refKey, "sage_invoice_trigger", true);
                          }}
                        >
                          Update Invoice
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
