import React from "react";
import Card from "../components/Card";

export default function RefToInvView({
  orders,
  ordersLoading,
  ordersError,
  handleOrderInvoiceChange,
  handleSaveOrders,
}) {
  const targets = (orders || []).map((order, index) => ({ order, index })).filter(({ order }) => {
    return !order?.hasInvoiceNum || !order?.source_invoice;
  });

  return (
    <section className="space-y-4">
      <Card>
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-sm uppercase tracking-wide text-slate-400">Reference → Invoice</div>
            <div className="text-lg font-semibold text-slate-800">
              Map scraped references to invoice numbers
            </div>
            <div className="text-xs text-slate-500">
              Enter the invoice number for each reference below, then save.
            </div>
          </div>
          <button
            type="button"
            onClick={handleSaveOrders}
            disabled={ordersLoading}
            className="px-4 py-2 rounded-xl bg-indigo-600 text-white text-sm font-semibold disabled:opacity-60"
          >
            Save All
          </button>
        </div>
        {ordersError && (
          <div className="mt-3 rounded-xl bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">
            {ordersError}
          </div>
        )}
      </Card>

      {ordersLoading && targets.length === 0 ? (
        <div className="py-12 text-center text-slate-500">Loading orders…</div>
      ) : targets.length === 0 ? (
        <Card>
          <div className="py-8 text-center text-slate-500 text-sm">
            All orders have an invoice number recorded.
          </div>
        </Card>
      ) : (
        <div className="grid gap-3">
          {targets.map(({ order, index }) => (
            <Card key={`${order.reference || "order"}-${index}`} className="border-amber-100">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <div className="text-base font-semibold text-slate-800">
                    {order.reference || "No reference"}
                  </div>
                  <div className="text-xs text-slate-500">
                    {order.warehouse || order.seller || "Unknown warehouse"}
                  </div>
                </div>
                <input
                  type="text"
                  className="border rounded-xl px-3 py-2 text-sm w-full sm:w-64"
                  placeholder="Invoice number"
                  value={order.source_invoice || ""}
                  onChange={(e) => handleOrderInvoiceChange(order.reference || order.__row || index, e.target.value)}
                />
              </div>
            </Card>
          ))}
        </div>
      )}
    </section>
  );
}
