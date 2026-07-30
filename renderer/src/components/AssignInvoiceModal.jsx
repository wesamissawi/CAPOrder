import React, { useMemo, useState } from "react";

function money(n) {
  const v = Number(n);
  return Number.isFinite(v) ? `$${v.toFixed(2)}` : "";
}

function haystack(...parts) {
  return parts.filter(Boolean).join(" ").toLowerCase();
}

// Loose part identity for the "does this scan belong to this order?" hint.
// Punctuation and case are stripped so the invoice's "BC-3510" still lines up
// with the order's "BC3510" — this only tints rows and counts overlaps, it
// never decides anything, so erring toward matching is the useful direction.
function partKey(li) {
  return String(li?.partNumber || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function partLabel(li) {
  return `${li?.partLineCode || ""} ${li?.partNumber || ""}`.trim() || "—";
}

function partKeySet(lineItems) {
  return new Set((Array.isArray(lineItems) ? lineItems : []).map(partKey).filter(Boolean));
}

// Compact parts list shown on both invoice and order cards. `matchKeys` is the
// other side's part keys when something is selected there, so overlapping rows
// light up green on both cards at once.
function PartsList({ lineItems, matchKeys, emptyLabel }) {
  const items = Array.isArray(lineItems) ? lineItems : [];
  if (items.length === 0) {
    return <div className="text-[11px] text-slate-400 px-1">{emptyLabel}</div>;
  }
  return (
    <div className="max-h-32 overflow-auto rounded-lg border border-slate-100 bg-white/70 divide-y divide-slate-50">
      {items.map((li, idx) => {
        const key = partKey(li);
        const hit = Boolean(matchKeys && key && matchKeys.has(key));
        const qty = li?.quantity ?? "";
        return (
          <div
            key={`${key || "part"}-${idx}`}
            className={`flex items-center gap-2 px-1.5 py-0.5 text-[11px] ${
              hit ? "bg-emerald-50" : ""
            }`}
          >
            <span className={`font-semibold ${hit ? "text-emerald-800" : "text-slate-800"}`}>
              {hit ? "✓ " : ""}
              {partLabel(li)}
            </span>
            <span className="text-slate-400 flex-1 min-w-0 truncate">
              {li?.partDescription || li?.description || ""}
            </span>
            {String(qty).trim() !== "" && <span className="text-slate-500">x{qty}</span>}
            {li?.costPrice && <span className="text-slate-600">${li.costPrice}</span>}
          </div>
        );
      })}
    </div>
  );
}

// "3/4 parts match" — the headline signal when scanning either list for the
// counterpart of whatever is selected on the other side.
function MatchBadge({ lineItems, matchKeys }) {
  const items = Array.isArray(lineItems) ? lineItems : [];
  if (!matchKeys || matchKeys.size === 0 || items.length === 0) return null;
  const keys = items.map(partKey).filter(Boolean);
  if (keys.length === 0) return null;
  const hits = keys.filter((k) => matchKeys.has(k)).length;
  if (hits === 0) return null;
  const all = hits === keys.length;
  return (
    <span
      className={`px-2 py-0.5 rounded-full text-[10px] font-semibold border whitespace-nowrap ${
        all
          ? "bg-emerald-100 text-emerald-800 border-emerald-300"
          : "bg-amber-100 text-amber-800 border-amber-300"
      }`}
    >
      {hits}/{keys.length} parts match
    </span>
  );
}

// Side-by-side picker for pairing an already-scanned Epicor invoice with an
// order that has no invoice yet. It replaces the per-invoice "assign to order"
// dropdown that used to live on each Epicor scan card: the dropdown could only
// ever be driven from the invoice side, and gave no way to compare an order's
// details while choosing.
//
// Both lists are live — after an assignment the invoice becomes "on file" and
// the order gains an invoice number, so each drops out of its list on its own.
// Opened from Order Management it also carries the escape hatch: if no scan
// matches, "Get Invoice from Epicor" runs the real portal fetch from here.
export default function AssignInvoiceModal({
  invoices,
  orders,
  preselectInvoice,
  preselectOrder,
  onAssign,
  onViewInvoiceImage,
  onMarkUnmatchable,
  onFetchFromEpicor,
  epicorOpening,
  onRefreshScans,
  onClose,
}) {
  const invoiceList = Array.isArray(invoices) ? invoices : [];
  const orderList = Array.isArray(orders) ? orders : [];

  const [selectedInvoice, setSelectedInvoice] = useState(
    () => String(preselectInvoice || "").trim().toUpperCase()
  );
  const [selectedOrder, setSelectedOrder] = useState(
    () => String(preselectOrder || "").trim().toUpperCase()
  );
  const [invoiceFilter, setInvoiceFilter] = useState("");
  const [orderFilter, setOrderFilter] = useState("");
  const [status, setStatus] = useState(""); // "assigning" | "error:msg" | ""
  const [assigned, setAssigned] = useState([]); // [{invoiceNumber, reference}]
  const [refreshing, setRefreshing] = useState(false);
  // Invoice numbers flagged during THIS session. The parent drops them from
  // `invoices` on success, but keeping the key lets the row show a confirmation
  // for the instant before the list updates, and disables a double-click.
  const [dismissing, setDismissing] = useState({}); // { [invoiceNumber]: true }

  const norm = (v) => String(v || "").trim().toUpperCase();

  // Part numbers are in the haystack on both sides: typing a part off one
  // document is the fastest way to find its counterpart on the other.
  const visibleInvoices = useMemo(() => {
    const q = invoiceFilter.trim().toLowerCase();
    if (!q) return invoiceList;
    return invoiceList.filter((i) =>
      haystack(
        i.invoiceNumber,
        i.reference,
        i.date,
        i.accountName,
        i.poNumber,
        (i.lineItems || []).map(partLabel).join(" ")
      ).includes(q)
    );
  }, [invoiceList, invoiceFilter]);

  const visibleOrders = useMemo(() => {
    const q = orderFilter.trim().toLowerCase();
    if (!q) return orderList;
    return orderList.filter((o) =>
      haystack(
        o.reference,
        o.seller,
        o.warehouse,
        o.sageDate,
        o.total,
        (o.lineItems || []).map(partLabel).join(" ")
      ).includes(q)
    );
  }, [orderList, orderFilter]);

  const invoice = invoiceList.find((i) => norm(i.invoiceNumber) === selectedInvoice) || null;
  const order = orderList.find((o) => norm(o.reference) === selectedOrder) || null;
  // Each side is tinted against the OTHER side's selection, so picking an
  // invoice lights up the candidate orders and vice versa.
  const invoiceKeys = useMemo(() => partKeySet(invoice?.lineItems), [invoice]);
  const orderKeys = useMemo(() => partKeySet(order?.lineItems), [order]);
  const isError = status.startsWith("error:");
  const busy = status === "assigning";

  async function handleAssign() {
    if (!invoice || !order) return;
    setStatus("assigning");
    try {
      const res = await onAssign(invoice, order.reference);
      if (!res?.ok) throw new Error(res?.error || "Failed to assign invoice.");
      const wasTargetOrder = norm(order.reference) === norm(preselectOrder);
      setAssigned((prev) => [
        ...prev,
        { invoiceNumber: invoice.invoiceNumber, reference: order.reference },
      ]);
      setSelectedInvoice("");
      setSelectedOrder("");
      setStatus("");
      // Opened from Order Management for one specific order: that order is now
      // settled, so the modal has done its job — get out of the way.
      if (wasTargetOrder) onClose();
    } catch (e) {
      setStatus("error:" + (e?.message || "Failed to assign invoice."));
    }
  }

  // "This scan has no order on our side." Flags it in the Epicor cache so it
  // stops being offered here on every future match. Reversible from the Epicor
  // tab, so it needs no confirmation prompt.
  async function handleMarkUnmatchable(inv) {
    if (!onMarkUnmatchable) return;
    const key = norm(inv?.invoiceNumber);
    if (!key || dismissing[key]) return;
    setDismissing((p) => ({ ...p, [key]: true }));
    try {
      const res = await onMarkUnmatchable(inv);
      if (!res?.ok) throw new Error(res?.error || "Failed to flag the invoice.");
      if (norm(selectedInvoice) === key) setSelectedInvoice("");
    } catch (e) {
      setStatus("error:" + (e?.message || "Failed to flag the invoice."));
      setDismissing((p) => {
        const next = { ...p };
        delete next[key];
        return next;
      });
    }
  }

  async function handleRefresh() {
    if (!onRefreshScans) return;
    setRefreshing(true);
    try {
      await onRefreshScans();
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[5000] bg-slate-900/60 flex items-center justify-center px-4">
      <div className="bg-white rounded-3xl shadow-2xl w-full max-w-[95vw] p-6 flex flex-col gap-4 max-h-[95vh]">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold text-slate-800">Assign a Scanned Invoice</h2>
            <p className="text-sm text-slate-500">
              Pick a scanned invoice on the left and the order it belongs to on the right, then
              click <strong>Assign</strong>. Nothing is fetched from Epicor — these invoices were
              already scanned, they just never got matched to an order (usually because OCR
              misread the order reference). Each card lists its parts: select one side and the
              parts it shares with the other side turn green, so the right pairing stands out
              while you scroll. Filtering by a part number works on both lists too.
            </p>
          </div>
          <button className="text-slate-500 hover:text-slate-700 text-lg leading-none" onClick={onClose}>
            x
          </button>
        </div>

        {isError && (
          <div className="text-sm text-red-600 whitespace-pre-line">{status.slice(6)}</div>
        )}
        {assigned.length > 0 && (
          <div className="text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-xl px-3 py-2">
            {assigned.map((a) => (
              <div key={`${a.invoiceNumber}-${a.reference}`}>
                Invoice <strong>{a.invoiceNumber}</strong> assigned to order{" "}
                <strong>{a.reference}</strong> ✓
              </div>
            ))}
          </div>
        )}

        <div className="grid gap-4 lg:grid-cols-2 overflow-hidden">
          {/* Left: scans with no order. */}
          <div className="flex flex-col gap-2 min-w-0">
            <div className="flex items-center justify-between gap-2">
              <div className="text-sm font-semibold text-slate-700">
                Scanned invoices with no order ({invoiceList.length})
              </div>
              {onRefreshScans && (
                <button
                  className="px-3 py-1 rounded-full text-xs font-semibold border bg-white text-slate-600 border-slate-200 hover:bg-slate-50 disabled:opacity-60"
                  onClick={handleRefresh}
                  disabled={refreshing}
                  title="Reload scanned invoices from the local cache (no browser)"
                >
                  {refreshing ? "Refreshing…" : "Refresh"}
                </button>
              )}
            </div>
            <input
              className="rounded-xl border border-slate-200 px-3 py-2 text-sm"
              placeholder="Filter by invoice #, ref, date, account…"
              value={invoiceFilter}
              onChange={(e) => setInvoiceFilter(e.target.value)}
            />
            <div className="border rounded-2xl bg-slate-50 overflow-auto max-h-[55vh] p-2 flex flex-col gap-2">
              {invoiceList.length === 0 && (
                <p className="text-sm text-slate-500 p-3">
                  No unassigned scans left — every invoice scanned so far is either on an order or
                  flagged as having none. Flagged scans are listed in the Epicor tab if you need to
                  put one back.
                </p>
              )}
              {invoiceList.length > 0 && visibleInvoices.length === 0 && (
                <p className="text-sm text-slate-500 p-3">No scan matches that filter.</p>
              )}
              {visibleInvoices.map((inv, idx) => {
                const key = norm(inv.invoiceNumber);
                const active = key && key === selectedInvoice;
                return (
                  <div
                    key={`${key || "inv"}-${idx}`}
                    className={`rounded-xl border px-3 py-2 ${
                      active
                        ? "border-indigo-500 bg-indigo-50 ring-1 ring-indigo-300"
                        : "border-slate-200 bg-white hover:bg-slate-50"
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => setSelectedInvoice(active ? "" : key)}
                      className="w-full text-left flex flex-wrap items-center gap-x-4 gap-y-1"
                    >
                      <div>
                        <div className="text-[10px] uppercase tracking-wide text-slate-400 leading-none mb-0.5">
                          Invoice
                        </div>
                        <div className="text-base font-bold text-indigo-700">
                          {inv.invoiceNumber || "—"}
                        </div>
                      </div>
                      {inv.date && (
                        <div>
                          <div className="text-[10px] uppercase tracking-wide text-slate-400 leading-none mb-0.5">
                            Date
                          </div>
                          <div className="text-sm font-semibold text-slate-800">{inv.date}</div>
                        </div>
                      )}
                      {Number.isFinite(Number(inv.balanceDue)) && (
                        <div>
                          <div className="text-[10px] uppercase tracking-wide text-slate-400 leading-none mb-0.5">
                            Total
                          </div>
                          <div className="text-sm font-semibold text-slate-800">
                            {money(inv.balanceDue)}
                          </div>
                        </div>
                      )}
                      {inv.reference && (
                        <div>
                          <div className="text-[10px] uppercase tracking-wide text-slate-400 leading-none mb-0.5">
                            Order ref (OCR)
                          </div>
                          <div className="text-sm font-semibold text-slate-800">{inv.reference}</div>
                        </div>
                      )}
                      {inv.accountName && (
                        <div className="text-xs text-slate-500 min-w-0 truncate">
                          {inv.accountName}
                        </div>
                      )}
                      <MatchBadge lineItems={inv.lineItems} matchKeys={orderKeys} />
                    </button>
                    <div className="mt-1">
                      <PartsList
                        lineItems={inv.lineItems}
                        matchKeys={orderKeys}
                        emptyLabel="No parts read from this invoice."
                      />
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                      {Array.isArray(inv.lineItems) && inv.lineItems.length > 0 && (
                        <span>{inv.lineItems.length} part(s)</span>
                      )}
                      {inv.imageFileName && onViewInvoiceImage && (
                        <button
                          type="button"
                          className="px-2 py-0.5 rounded-full font-semibold border bg-white text-indigo-700 border-indigo-200 hover:bg-indigo-50"
                          onClick={() => onViewInvoiceImage(inv.imageFileName)}
                        >
                          View image
                        </button>
                      )}
                      {onMarkUnmatchable && (
                        <button
                          type="button"
                          className="px-2 py-0.5 rounded-full font-semibold border bg-white text-slate-600 border-slate-300 hover:bg-amber-50 hover:text-amber-800 hover:border-amber-300 disabled:opacity-50 ml-auto"
                          onClick={() => handleMarkUnmatchable(inv)}
                          disabled={Boolean(dismissing[norm(inv.invoiceNumber)])}
                          title="This scan belongs to no order of ours (counter sale, another branch, duplicate). Hides it from this picker for good — reversible from the Epicor tab."
                        >
                          {dismissing[norm(inv.invoiceNumber)] ? "Hiding…" : "No matching order"}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Right: orders with no invoice. */}
          <div className="flex flex-col gap-2 min-w-0">
            <div className="text-sm font-semibold text-slate-700">
              Orders with no invoice ({orderList.length})
            </div>
            <input
              className="rounded-xl border border-slate-200 px-3 py-2 text-sm"
              placeholder="Filter by reference, seller, date…"
              value={orderFilter}
              onChange={(e) => setOrderFilter(e.target.value)}
            />
            <div className="border rounded-2xl bg-slate-50 overflow-auto max-h-[55vh] p-2 flex flex-col gap-2">
              {orderList.length === 0 && (
                <p className="text-sm text-slate-500 p-3">
                  No World orders are waiting on an invoice.
                </p>
              )}
              {orderList.length > 0 && visibleOrders.length === 0 && (
                <p className="text-sm text-slate-500 p-3">No order matches that filter.</p>
              )}
              {visibleOrders.map((o, idx) => {
                const key = norm(o.reference);
                const active = key && key === selectedOrder;
                const isTarget = key && key === norm(preselectOrder);
                return (
                  <div
                    key={`${key || "order"}-${idx}`}
                    className={`rounded-xl border px-3 py-2 ${
                      active
                        ? "border-indigo-500 bg-indigo-50 ring-1 ring-indigo-300"
                        : "border-slate-200 bg-white hover:bg-slate-50"
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => setSelectedOrder(active ? "" : key)}
                      className="w-full text-left flex flex-wrap items-center gap-x-4 gap-y-1"
                    >
                      <div>
                        <div className="text-[10px] uppercase tracking-wide text-slate-400 leading-none mb-0.5">
                          Order ref
                        </div>
                        <div className="text-base font-bold text-slate-800">
                          {o.reference || "—"}
                        </div>
                      </div>
                      {o.sageDate && (
                        <div>
                          <div className="text-[10px] uppercase tracking-wide text-slate-400 leading-none mb-0.5">
                            Date
                          </div>
                          <div className="text-sm font-semibold text-slate-800">{o.sageDate}</div>
                        </div>
                      )}
                      {o.total && (
                        <div>
                          <div className="text-[10px] uppercase tracking-wide text-slate-400 leading-none mb-0.5">
                            Order total
                          </div>
                          <div className="text-sm font-semibold text-slate-800">{o.total}</div>
                        </div>
                      )}
                      {(o.seller || o.warehouse) && (
                        <div className="text-xs text-slate-500 min-w-0 truncate">
                          {o.seller || o.warehouse}
                        </div>
                      )}
                      {isTarget && (
                        <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold border bg-amber-100 text-amber-800 border-amber-300">
                          the order you clicked
                        </span>
                      )}
                      <MatchBadge lineItems={o.lineItems} matchKeys={invoiceKeys} />
                    </button>
                    <div className="mt-1">
                      <PartsList
                        lineItems={o.lineItems}
                        matchKeys={invoiceKeys}
                        emptyLabel="No parts recorded on this order."
                      />
                    </div>
                    {Array.isArray(o.lineItems) && o.lineItems.length > 0 && (
                      <div className="mt-1 text-xs text-slate-500">{o.lineItems.length} part(s)</div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-3">
          <div className="text-sm text-slate-600 min-w-0">
            {invoice && order ? (
              <span>
                Assign invoice <strong className="text-indigo-700">{invoice.invoiceNumber}</strong>{" "}
                {Number.isFinite(Number(invoice.balanceDue)) ? `(${money(invoice.balanceDue)}) ` : ""}
                to order <strong className="text-slate-800">{order.reference}</strong>
                {order.total ? ` (${order.total})` : ""}
              </span>
            ) : (
              <span className="text-slate-400">
                {invoice
                  ? "Now pick the order this invoice belongs to."
                  : order
                  ? "Now pick the scanned invoice for this order."
                  : "Pick one invoice and one order."}
              </span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {onFetchFromEpicor && (
              <button
                className="px-4 py-2 rounded-full text-sm font-semibold border bg-white text-indigo-700 border-indigo-200 hover:bg-indigo-50 disabled:opacity-60"
                onClick={onFetchFromEpicor}
                disabled={epicorOpening || busy}
                title="No scan matches? Open the Epicor portal and search for this order's invoice."
              >
                {epicorOpening ? "Opening Epicor…" : "Get Invoice from Epicor"}
              </button>
            )}
            <button
              className="px-4 py-2 rounded-full text-sm font-semibold border border-slate-300 text-slate-700 hover:bg-slate-50"
              onClick={onClose}
            >
              Close
            </button>
            <button
              className="px-5 py-2 rounded-full text-sm font-semibold bg-indigo-600 text-white shadow hover:bg-indigo-700 disabled:opacity-50"
              onClick={handleAssign}
              disabled={!invoice || !order || busy}
            >
              {busy ? "Assigning…" : "Assign"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
