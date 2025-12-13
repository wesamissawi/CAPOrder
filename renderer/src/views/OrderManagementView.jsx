import React from "react";
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
  hasSearch,
}) {
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
              <select
                className="w-full sm:w-40 border rounded-xl px-3 py-2 text-sm bg-white"
                value={ordersPickupFilter}
                onChange={(e) => setOrdersPickupFilter(e.target.value)}
              >
                <option value="all">All</option>
                <option value="not-picked">Not picked up</option>
                <option value="picked">Picked up</option>
              </select>
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
              return (
                <Card key={key} className="border-indigo-100">
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
                    </div>
                  </div>
                  <div className="mt-3 flex flex-col gap-2 text-sm">
                      {[
                        { label: "Picked Up", field: "pickedUp" },
                        { label: "Arrived", field: "inStore" },
                        { label: "Entered in Sage", field: "invoiceSageUpdate" },
                        { label: "Value Check", field: "invoiceValueCheck" },
                      ].map((meta) => (
                        <label key={meta.field} className="flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2 bg-white/60">
                          <input
                            type="checkbox"
                            checked={Boolean(order[meta.field])}
                            onChange={(e) => handleOrderCheckboxChange(refKey, meta.field, e.target.checked)}
                          />
                          <span className="text-slate-700 text-sm">{meta.label}</span>
                        </label>
                      ))}
                    </div>
                  <div className="mt-4 grid gap-3 sm:grid-cols-2">
                    <div className="flex flex-col gap-1">
                      <span className="text-xs uppercase tracking-wide text-slate-400">Invoice #</span>
                      <input
                        className="border rounded-xl px-3 py-1.5 bg-slate-100 text-sm text-slate-700 max-w-xs"
                        value={order.source_invoice || ""}
                        readOnly
                        disabled
                      />
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
                            const part = item.partNumber || item.partLineCode || "Item";
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
