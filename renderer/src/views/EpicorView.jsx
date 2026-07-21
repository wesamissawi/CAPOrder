import React, { useEffect, useMemo, useState } from "react";
import Card from "../components/Card";

function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

function daysAgoIso(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

// Default trailing window for the Transbec Credits Gmail search — a plain
// "check for credits" click looks back 5 days rather than scanning every
// credit memo Transbec has ever sent.
const TRANSBEC_CREDIT_DEFAULT_LOOKBACK_DAYS = 5;

// Dedicated view for reconciling Epicor invoices against our own records.
// Scan a date range; every scanned invoice is OCR'd, then flagged "New" when its
// invoice number isn't found in active orders, the orders archive, or any
// archived invoices.csv manifest — i.e. an invoice we don't have on file yet.
export default function EpicorView({
  onScan,
  scanning,
  results,
  error,
  statusLog,
  scannedCount,
  unknownCount,
  onViewInvoiceImage,
  onCreateOrder,
  onRemoveOrder,
  onRescanInvoice,
  onLoadScanned,
  assignableOrders,
  onAssignOrder,
  transbecCredits,
  transbecCreditScanning,
  transbecCreditError,
  transbecCreditLog,
  onFetchTransbecCredits,
  onLoadTransbecCredits,
  onCreateTransbecCreditOrder,
  onRemoveTransbecCreditOrder,
  onViewTransbecCreditImage,
  onResetTransbecCredits,
}) {
  const [transbecResetStatus, setTransbecResetStatus] = useState("");
  const [fromDate, setFromDate] = useState(todayIso());
  const [toDate, setToDate] = useState(todayIso());
  const [onlyNew, setOnlyNew] = useState(true);
  const [createStatus, setCreateStatus] = useState({}); // { [invoiceNumber]: "adding" | "created" | "error:msg" }
  const [rescanStatus, setRescanStatus] = useState({}); // { [invoiceNumber]: "rescanning" | "error:msg" }
  const [assignSelection, setAssignSelection] = useState({}); // { [invoiceNumber]: orderReference }
  const [assignStatus, setAssignStatus] = useState({}); // { [invoiceNumber]: "assigning" | "assigned" | "error:msg" }
  const [creditCreateStatus, setCreditCreateStatus] = useState({}); // { [creditMemoNumber]: "adding" | "created" | "removing" | "error:msg" }
  const [creditFromDate, setCreditFromDate] = useState(daysAgoIso(TRANSBEC_CREDIT_DEFAULT_LOOKBACK_DAYS));
  const [creditToDate, setCreditToDate] = useState(todayIso());
  const [onlyNewCredits, setOnlyNewCredits] = useState(true);

  // On open, list whatever was scanned in past sessions straight from the cache
  // (no browser) so the page isn't empty after a restart.
  useEffect(() => {
    if (onLoadScanned) onLoadScanned();
    if (onLoadTransbecCredits) onLoadTransbecCredits();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const credits = Array.isArray(transbecCredits) ? transbecCredits : [];
  const creditUnknownCount = useMemo(
    () => credits.filter((c) => !c.known && !c.created).length,
    [credits]
  );
  const visibleCredits = useMemo(
    // Keep just-created credits visible (with a badge) even though they now
    // count as "on file", so the user sees the confirmation — same rule the
    // Epicor invoice list above uses for its "only new" toggle.
    () => (onlyNewCredits ? credits.filter((c) => !c.known || c.created) : credits),
    [credits, onlyNewCredits]
  );

  async function handleCreateCreditOrder(credit) {
    const key = credit.creditMemoNumber || "";
    setCreditCreateStatus((p) => ({ ...p, [key]: "adding" }));
    try {
      const res = await onCreateTransbecCreditOrder(credit);
      if (!res?.ok) throw new Error(res?.error || "Failed to create order.");
      setCreditCreateStatus((p) => ({ ...p, [key]: "created" }));
    } catch (e) {
      setCreditCreateStatus((p) => ({ ...p, [key]: "error:" + (e?.message || "Failed") }));
    }
  }

  async function handleResetTransbec() {
    if (!onResetTransbecCredits) return;
    setTransbecResetStatus("resetting");
    try {
      const res = await onResetTransbecCredits();
      setTransbecResetStatus(res?.ok ? "" : res?.error ? `error:${res.error}` : "");
    } catch (e) {
      setTransbecResetStatus(`error:${e?.message || "Failed"}`);
    }
  }

  async function handleRemoveCreditOrder(credit) {
    const key = credit.creditMemoNumber || "";
    setCreditCreateStatus((p) => ({ ...p, [key]: "removing" }));
    try {
      const res = await onRemoveTransbecCreditOrder(credit);
      if (!res?.ok) throw new Error(res?.error || "Failed to remove order.");
      setCreditCreateStatus((p) => {
        const next = { ...p };
        delete next[key];
        return next;
      });
    } catch (e) {
      setCreditCreateStatus((p) => ({ ...p, [key]: "error:" + (e?.message || "Failed") }));
    }
  }

  const invoices = Array.isArray(results) ? results : [];
  const needsAssignmentCount = useMemo(
    () => invoices.filter((i) => !i.known && !i.created && !i.assignedTo).length,
    [invoices]
  );
  const visible = useMemo(
    // Keep just-created invoices visible (with a badge) even though they now
    // count as "on file", so the user sees the confirmation.
    () => (onlyNew ? invoices.filter((i) => !i.known || i.created || i.assignedTo) : invoices),
    [invoices, onlyNew]
  );

  const canScan = Boolean(fromDate && toDate) && !scanning;

  async function handleCreate(inv) {
    const key = inv.invoiceNumber || "";
    setCreateStatus((p) => ({ ...p, [key]: "adding" }));
    try {
      const res = await onCreateOrder(inv);
      if (!res?.ok) throw new Error(res?.error || "Failed to create order.");
      setCreateStatus((p) => ({ ...p, [key]: "created" }));
    } catch (e) {
      setCreateStatus((p) => ({ ...p, [key]: "error:" + (e?.message || "Failed") }));
    }
  }

  async function handleRescan(inv) {
    const key = inv.invoiceNumber || "";
    setRescanStatus((p) => ({ ...p, [key]: "rescanning" }));
    try {
      const res = await onRescanInvoice(inv);
      if (!res?.ok) throw new Error(res?.error || "Rescan failed.");
      setRescanStatus((p) => {
        const next = { ...p };
        delete next[key];
        return next;
      });
    } catch (e) {
      setRescanStatus((p) => ({ ...p, [key]: "error:" + (e?.message || "Failed") }));
    }
  }

  async function handleAssign(inv) {
    const key = inv.invoiceNumber || "";
    const orderRef = assignSelection[key];
    if (!orderRef) return;
    setAssignStatus((p) => ({ ...p, [key]: "assigning" }));
    try {
      const res = await onAssignOrder(inv, orderRef);
      if (!res?.ok) throw new Error(res?.error || "Failed to assign invoice.");
      setAssignStatus((p) => ({ ...p, [key]: "assigned" }));
    } catch (e) {
      setAssignStatus((p) => ({ ...p, [key]: "error:" + (e?.message || "Failed") }));
    }
  }

  async function handleRemove(inv) {
    const key = inv.invoiceNumber || "";
    setCreateStatus((p) => ({ ...p, [key]: "removing" }));
    try {
      const res = await onRemoveOrder(inv);
      if (!res?.ok) throw new Error(res?.error || "Failed to remove order.");
      setCreateStatus((p) => {
        const next = { ...p };
        delete next[key];
        return next;
      });
    } catch (e) {
      setCreateStatus((p) => ({ ...p, [key]: "error:" + (e?.message || "Failed") }));
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-col gap-3">
          <div>
            <h2 className="text-xl font-semibold text-slate-800">Epicor Invoice Scan</h2>
            <p className="text-sm text-slate-500">
              Scan a date range on the Epicor vendor portal, then find invoices that aren&apos;t yet
              in your records (active orders, the archive, or filed invoice manifests).
            </p>
          </div>
          <div className="grid gap-3 md:grid-cols-[1fr,1fr,auto] items-end">
            <div className="flex flex-col gap-1">
              <label className="text-xs uppercase tracking-wide text-slate-500">From date</label>
              <input
                type="date"
                className="rounded-xl border border-slate-200 px-3 py-2 text-sm"
                value={fromDate}
                max={toDate || undefined}
                onChange={(e) => setFromDate(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs uppercase tracking-wide text-slate-500">To date</label>
              <input
                type="date"
                className="rounded-xl border border-slate-200 px-3 py-2 text-sm"
                value={toDate}
                min={fromDate || undefined}
                onChange={(e) => setToDate(e.target.value)}
              />
            </div>
            <div className="flex gap-2">
              <button
                className="rounded-xl bg-indigo-600 text-white px-4 py-2 font-semibold shadow hover:bg-indigo-700 disabled:opacity-60"
                onClick={() => onScan(fromDate, toDate)}
                disabled={!canScan}
              >
                {scanning ? "Scanning…" : "Scan Epicor"}
              </button>
              {onLoadScanned && (
                <button
                  className="rounded-xl bg-white border border-slate-200 text-slate-600 px-4 py-2 font-semibold hover:bg-slate-50 disabled:opacity-60"
                  onClick={() => onLoadScanned()}
                  disabled={scanning}
                  title="Reload the list of already-scanned invoices from cache (no browser)"
                >
                  Refresh list
                </button>
              )}
            </div>
          </div>
          <p className="text-xs text-slate-400">
            The list below shows every invoice scanned so far (loaded from cache, no browser). Run a
            scan to add invoices for a new date range — a browser window opens and each invoice is
            read with OCR; ones scanned before are reused from cache.
          </p>
          {error && <div className="text-sm text-red-600 whitespace-pre-line">{error}</div>}
          {Array.isArray(statusLog) && statusLog.length > 0 && (
            <details className="text-xs text-slate-500">
              <summary className="cursor-pointer select-none">Scan log</summary>
              <pre className="mt-2 whitespace-pre-wrap text-slate-500">{statusLog.join("\n")}</pre>
            </details>
          )}
        </div>
      </Card>

      {onFetchTransbecCredits && (
        <Card>
          <div className="flex flex-col gap-3">
            <div>
              <h2 className="text-xl font-semibold text-slate-800">Transbec Credits</h2>
              <p className="text-sm text-slate-500">
                Check Gmail for Transbec credit memo emails (from{" "}
                <span className="font-mono">donotreply@transbec.ca</span>, subject &quot;Credit
                Memo for … Cust PO&quot;). These have no existing order, so each one gets its own{" "}
                <strong>Create order</strong> button.
              </p>
            </div>
            <div className="grid gap-3 md:grid-cols-[1fr,1fr,auto] items-end">
              <div className="flex flex-col gap-1">
                <label className="text-xs uppercase tracking-wide text-slate-500">From date</label>
                <input
                  type="date"
                  className="rounded-xl border border-slate-200 px-3 py-2 text-sm"
                  value={creditFromDate}
                  max={creditToDate || undefined}
                  onChange={(e) => setCreditFromDate(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs uppercase tracking-wide text-slate-500">To date</label>
                <input
                  type="date"
                  className="rounded-xl border border-slate-200 px-3 py-2 text-sm"
                  value={creditToDate}
                  min={creditFromDate || undefined}
                  onChange={(e) => setCreditToDate(e.target.value)}
                />
              </div>
              <button
                className="rounded-xl bg-indigo-600 text-white px-4 py-2 font-semibold shadow hover:bg-indigo-700 disabled:opacity-60 whitespace-nowrap"
                onClick={() => onFetchTransbecCredits(creditFromDate, creditToDate)}
                disabled={transbecCreditScanning || !creditFromDate || !creditToDate}
              >
                {transbecCreditScanning ? "Checking…" : "Check for Transbec Credits"}
              </button>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-slate-400">
                Defaults to the last {TRANSBEC_CREDIT_DEFAULT_LOOKBACK_DAYS} days. Widen the range to
                check further back — credit memos already found stay listed below regardless of the
                range.
              </p>
              {onResetTransbecCredits && (
                <button
                  className="px-3 py-1 rounded-full text-xs font-semibold border bg-white text-red-600 border-red-200 hover:bg-red-50 disabled:opacity-60 whitespace-nowrap"
                  onClick={handleResetTransbec}
                  disabled={transbecResetStatus === "resetting"}
                  title="Dev-only: wipe the cached scan results and downloaded PDFs so the scan can be re-tested from scratch. Does not affect orders already created."
                >
                  {transbecResetStatus === "resetting" ? "Clearing…" : "Clear scan data (dev)"}
                </button>
              )}
            </div>
            {transbecResetStatus?.startsWith("error:") && (
              <div className="text-sm text-red-600">{transbecResetStatus.slice(6)}</div>
            )}
            {transbecCreditError && (
              <div className="text-sm text-red-600 whitespace-pre-line">{transbecCreditError}</div>
            )}
            {Array.isArray(transbecCreditLog) && transbecCreditLog.length > 0 && (
              <details className="text-xs text-slate-500">
                <summary className="cursor-pointer select-none">Check log</summary>
                <pre className="mt-2 whitespace-pre-wrap text-slate-500">
                  {transbecCreditLog.join("\n")}
                </pre>
              </details>
            )}
            {credits.length > 0 && (
              <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
                <div className="flex flex-wrap items-center gap-4">
                  <span className="text-slate-600">
                    Found <span className="font-semibold text-slate-800">{credits.length}</span> credit
                    memo(s)
                  </span>
                  <span
                    className={`px-2 py-1 rounded-full border font-semibold ${
                      creditUnknownCount > 0
                        ? "bg-amber-100 text-amber-800 border-amber-300"
                        : "bg-emerald-50 text-emerald-700 border-emerald-200"
                    }`}
                  >
                    {creditUnknownCount} not yet made into an order
                  </span>
                </div>
                <label className="flex items-center gap-2 text-sm text-slate-600">
                  <input
                    type="checkbox"
                    checked={onlyNewCredits}
                    onChange={(e) => setOnlyNewCredits(e.target.checked)}
                  />
                  Show only invoices I don&apos;t have
                </label>
              </div>
            )}
            {credits.length === 0 && !transbecCreditScanning && (
              <p className="text-sm text-slate-500">
                No credit memos found yet. Click <strong>Check for Transbec Credits</strong> to
                search Gmail.
              </p>
            )}
            {credits.length > 0 && visibleCredits.length === 0 && (
              <p className="text-sm text-slate-500">
                Every credit memo found is already saved to an order. 🎉 Untick “only new” to see
                them all.
              </p>
            )}
            {visibleCredits.map((credit, idx) => {
              const totalNum = Number(credit.total);
              const key = credit.creditMemoNumber || "";
              const status = creditCreateStatus[key];
              const isError = status?.startsWith("error:");
              // credit.known persists across restarts (backend-derived from the
              // actual order matching this credit's number); credit.created is
              // only set in-session right after the button click.
              const created = credit.known || credit.created || status === "created";
              return (
                <div
                  key={`${key || "credit"}-${idx}`}
                  className={`flex flex-wrap items-center justify-between gap-3 rounded-xl border px-3 py-2 ${
                    credit.known || created ? "border-slate-100" : "border-amber-300 bg-amber-50/40"
                  }`}
                >
                  <div className="flex flex-wrap items-center gap-4">
                    <div>
                      <div className="text-xs uppercase tracking-wide text-slate-400 leading-none mb-0.5">
                        Packing Slip (reference)
                      </div>
                      <div className="text-base font-bold text-indigo-700">
                        {credit.reference || "—"}
                      </div>
                    </div>
                    {credit.creditMemoNumber && (
                      <div>
                        <div className="text-xs uppercase tracking-wide text-slate-400 leading-none mb-0.5">
                          Credit Memo #
                        </div>
                        <div className="text-sm font-semibold text-slate-800">
                          {credit.creditMemoNumber}
                        </div>
                      </div>
                    )}
                    {Number.isFinite(totalNum) && (
                      <div>
                        <div className="text-xs uppercase tracking-wide text-slate-400 leading-none mb-0.5">
                          Credit Total
                        </div>
                        <div className="text-sm font-semibold text-slate-800">
                          ${totalNum.toFixed(2)}
                        </div>
                      </div>
                    )}
                    {credit.poNumber && (
                      <div>
                        <div className="text-xs uppercase tracking-wide text-slate-400 leading-none mb-0.5">
                          Customer PO #
                        </div>
                        <div className="text-sm font-medium text-slate-700">{credit.poNumber}</div>
                      </div>
                    )}
                    {credit.customerNumber && (
                      <div>
                        <div className="text-xs uppercase tracking-wide text-slate-400 leading-none mb-0.5">
                          Customer #
                        </div>
                        <div className="text-sm font-medium text-slate-700">{credit.customerNumber}</div>
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    {credit.fileName && onViewTransbecCreditImage && (
                      <button
                        className="px-3 py-1 rounded-full text-xs font-semibold border bg-white text-indigo-700 border-indigo-200 hover:bg-indigo-50"
                        onClick={() => onViewTransbecCreditImage(credit.fileName)}
                      >
                        View attachment
                      </button>
                    )}
                    {created ? (
                      <>
                        <span className="px-3 py-1 rounded-full text-xs font-semibold border bg-emerald-50 text-emerald-700 border-emerald-200">
                          Order created ✓
                        </span>
                        {onRemoveTransbecCreditOrder && (
                          <button
                            className="px-3 py-1 rounded-full text-xs font-semibold border bg-white text-red-600 border-red-200 hover:bg-red-50 disabled:opacity-60"
                            disabled={status === "removing"}
                            title={isError ? status.slice(6) : "Remove this order from Order Management"}
                            onClick={() => handleRemoveCreditOrder(credit)}
                          >
                            {status === "removing" ? "Removing…" : isError ? "Retry remove" : "Remove"}
                          </button>
                        )}
                      </>
                    ) : (
                      onCreateTransbecCreditOrder && (
                        <button
                          className={`px-3 py-1 rounded-full text-xs font-semibold border disabled:opacity-60 ${
                            isError
                              ? "bg-red-50 text-red-600 border-red-200"
                              : "bg-white text-emerald-700 border-emerald-200 hover:bg-emerald-50"
                          }`}
                          disabled={status === "adding" || !key}
                          title={isError ? status.slice(6) : "Add this credit memo to Order Management as an order"}
                          onClick={() => handleCreateCreditOrder(credit)}
                        >
                          {status === "adding" ? "Creating…" : isError ? "Retry create" : "Create order"}
                        </button>
                      )
                    )}
                  </div>
                  {Array.isArray(credit.lineItems) && credit.lineItems.length > 0 && (
                    <details className="w-full mt-2 text-xs text-slate-600">
                      <summary className="cursor-pointer select-none text-slate-500">
                        {credit.lineItems.length} returned part(s) (verify)
                      </summary>
                      <div className="mt-2 space-y-1">
                        {credit.lineItems.map((li, li2) => (
                          <div
                            key={`${key || "credit"}-${idx}-part-${li2}`}
                            className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-100 bg-white/70 px-2 py-1"
                          >
                            <span className="font-semibold text-slate-800">
                              {`${li.partLineCode || ""} ${li.partNumber || ""}`.trim() || "—"}
                            </span>
                            {li.partDescription && (
                              <span className="text-slate-500 flex-1 min-w-0 truncate">
                                {li.partDescription}
                              </span>
                            )}
                            {Number.isFinite(Number(li.quantity)) && (
                              <span className="text-slate-500">Qty {li.quantity}</span>
                            )}
                            {li.costPrice && (
                              <span className="font-medium text-slate-700">${li.costPrice}</span>
                            )}
                          </div>
                        ))}
                      </div>
                    </details>
                  )}
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {scannedCount > 0 && (
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-4 text-sm">
              <span className="text-slate-600">
                Scanned <span className="font-semibold text-slate-800">{scannedCount}</span> invoice(s)
              </span>
              <span className="px-2 py-1 rounded-full bg-amber-50 text-amber-700 border border-amber-200">
                {unknownCount} not in records
              </span>
              <span className="px-2 py-1 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">
                {scannedCount - unknownCount} already on file
              </span>
              <span
                className={`px-2 py-1 rounded-full border font-semibold ${
                  needsAssignmentCount > 0
                    ? "bg-red-100 text-red-700 border-red-200"
                    : "bg-slate-100 text-slate-500 border-slate-200"
                }`}
              >
                {needsAssignmentCount} not assigned to an order
              </span>
            </div>
            <label className="flex items-center gap-2 text-sm text-slate-600">
              <input
                type="checkbox"
                checked={onlyNew}
                onChange={(e) => setOnlyNew(e.target.checked)}
              />
              Show only invoices I don&apos;t have
            </label>
          </div>
        </Card>
      )}

      {scannedCount === 0 && !scanning && (
        <Card className="text-sm text-slate-500">
          No invoices scanned yet. Pick a date range and click <strong>Scan Epicor</strong> to read
          invoices for that range — they&apos;ll stay listed here afterwards.
        </Card>
      )}

      {scannedCount > 0 && visible.length === 0 && (
        <Card className="text-sm text-slate-500">
          {onlyNew
            ? "Every scanned invoice is already in your records. 🎉 Untick “only new” to see them all."
            : "No invoices to show."}
        </Card>
      )}

      {visible.map((inv, idx) => {
        const balance = Number(inv.balanceDue);
        return (
          <Card
            key={`${inv.invoiceNumber || "inv"}-${idx}`}
            className={inv.known ? "border-slate-100" : "border-amber-300 bg-amber-50/40"}
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="flex flex-wrap items-center gap-4">
                <div>
                  <div className="text-xs uppercase tracking-wide text-slate-400 leading-none mb-0.5">
                    Invoice
                  </div>
                  <div className="text-xl font-bold text-indigo-700">
                    {inv.invoiceNumber || "—"}
                  </div>
                </div>
                {inv.date && (
                  <div>
                    <div className="text-xs uppercase tracking-wide text-slate-400 leading-none mb-0.5">
                      Date
                    </div>
                    <div className="text-base font-semibold text-slate-800">{inv.date}</div>
                  </div>
                )}
                {Number.isFinite(balance) && (
                  <div>
                    <div className="text-xs uppercase tracking-wide text-slate-400 leading-none mb-0.5">
                      Total
                    </div>
                    <div className="text-base font-semibold text-slate-800">
                      ${balance.toFixed(2)}
                    </div>
                  </div>
                )}
                {inv.reference && (
                  <div>
                    <div className="text-xs uppercase tracking-wide text-slate-400 leading-none mb-0.5">
                      Order ref (OCR)
                    </div>
                    <div className="text-base font-semibold text-slate-800">{inv.reference}</div>
                  </div>
                )}
                {inv.accountName && (
                  <div>
                    <div className="text-xs uppercase tracking-wide text-slate-400 leading-none mb-0.5">
                      Account
                    </div>
                    <div className="text-sm font-medium text-slate-700">{inv.accountName}</div>
                  </div>
                )}
              </div>
              <div className="flex flex-col items-end gap-2">
                <div className="flex gap-2 text-xs">
                  {inv.known ? (
                    <span className="px-2 py-1 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">
                      On file
                    </span>
                  ) : (
                    <span className="px-2 py-1 rounded-full bg-amber-100 text-amber-800 border border-amber-300 font-semibold">
                      Not in records
                    </span>
                  )}
                  {Boolean(inv.hasEnvironmentalFee) && (
                    <span className="px-2 py-1 rounded-full bg-lime-50 text-lime-700 border border-lime-200">
                      EHC{inv.environmentalFeeAmount ? ` $${inv.environmentalFeeAmount}` : ""}
                    </span>
                  )}
                </div>
                {inv.imageFileName && onViewInvoiceImage && (
                  <button
                    className="px-3 py-1 rounded-full text-xs font-semibold border bg-white text-indigo-700 border-indigo-200 hover:bg-indigo-50"
                    onClick={() => onViewInvoiceImage(inv.imageFileName)}
                  >
                    View invoice image
                  </button>
                )}
                {onRescanInvoice && (() => {
                  const status = rescanStatus[inv.invoiceNumber || ""];
                  const isError = status?.startsWith("error:");
                  return (
                    <button
                      className={`px-3 py-1 rounded-full text-xs font-semibold border disabled:opacity-60 ${
                        isError
                          ? "bg-red-50 text-red-600 border-red-200"
                          : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50"
                      }`}
                      disabled={status === "rescanning"}
                      title={
                        isError
                          ? status.slice(6)
                          : "Re-OCR this invoice's saved image (refreshes its total, reference and parts) — no Epicor login needed"
                      }
                      onClick={() => handleRescan(inv)}
                    >
                      {status === "rescanning"
                        ? "Rescanning…"
                        : isError
                        ? "Retry rescan"
                        : "Rescan this one"}
                    </button>
                  );
                })()}
                {!inv.known && onAssignOrder && (() => {
                  const key = inv.invoiceNumber || "";
                  const status = assignStatus[key];
                  const isError = status?.startsWith("error:");
                  if (status === "assigned" || inv.assignedTo) {
                    return (
                      <span className="px-3 py-1 rounded-full text-xs font-semibold border bg-emerald-50 text-emerald-700 border-emerald-200">
                        Assigned to {inv.assignedTo || assignSelection[key]} ✓
                      </span>
                    );
                  }
                  const options = Array.isArray(assignableOrders) ? assignableOrders : [];
                  if (options.length === 0) {
                    return <span className="text-xs text-slate-400">No unassigned orders to link</span>;
                  }
                  const selected = assignSelection[key] || "";
                  return (
                    <div className="flex items-center gap-2">
                      <select
                        className="rounded-full border border-slate-200 px-2 py-1 text-xs text-slate-700 max-w-[220px]"
                        value={selected}
                        onChange={(e) => setAssignSelection((p) => ({ ...p, [key]: e.target.value }))}
                        title="Assign this invoice to an existing order that has no invoice yet"
                      >
                        <option value="">Assign to order…</option>
                        {options.map((o) => (
                          <option key={o.reference} value={o.reference}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                      <button
                        className={`px-3 py-1 rounded-full text-xs font-semibold border disabled:opacity-60 ${
                          isError
                            ? "bg-red-50 text-red-600 border-red-200"
                            : "bg-white text-indigo-700 border-indigo-200 hover:bg-indigo-50"
                        }`}
                        disabled={!selected || status === "assigning"}
                        title={isError ? status.slice(6) : "Assign this invoice to the selected order"}
                        onClick={() => handleAssign(inv)}
                      >
                        {status === "assigning" ? "Assigning…" : isError ? "Retry assign" : "Assign"}
                      </button>
                    </div>
                  );
                })()}
                {(!inv.known || inv.created) && onCreateOrder && (() => {
                  const status = createStatus[inv.invoiceNumber || ""];
                  const isError = status?.startsWith("error:");
                  if (inv.created || status === "created") {
                    return (
                      <div className="flex items-center gap-2">
                        <span className="px-3 py-1 rounded-full text-xs font-semibold border bg-emerald-50 text-emerald-700 border-emerald-200">
                          Order created ✓
                        </span>
                        {onRemoveOrder && (
                          <button
                            className="px-3 py-1 rounded-full text-xs font-semibold border bg-white text-red-600 border-red-200 hover:bg-red-50 disabled:opacity-60"
                            disabled={status === "removing"}
                            title={isError ? status.slice(6) : "Remove this order from Order Management"}
                            onClick={() => handleRemove(inv)}
                          >
                            {status === "removing" ? "Removing…" : isError ? "Retry remove" : "Remove"}
                          </button>
                        )}
                      </div>
                    );
                  }
                  return (
                    <button
                      className={`px-3 py-1 rounded-full text-xs font-semibold border disabled:opacity-60 ${
                        isError
                          ? "bg-red-50 text-red-600 border-red-200"
                          : "bg-white text-emerald-700 border-emerald-200 hover:bg-emerald-50"
                      }`}
                      disabled={status === "adding"}
                      title={isError ? status.slice(6) : "Add this invoice to Order Management as an order"}
                      onClick={() => handleCreate(inv)}
                    >
                      {status === "adding" ? "Creating…" : isError ? "Retry create" : "Create order"}
                    </button>
                  );
                })()}
              </div>
            </div>
            {(inv.poNumber || inv.releaseNumber) && (
              <div className="mt-2 text-xs text-slate-500">
                {inv.poNumber ? `PO: ${inv.poNumber}` : ""}
                {inv.poNumber && inv.releaseNumber ? " · " : ""}
                {inv.releaseNumber ? `Release: ${inv.releaseNumber}` : ""}
              </div>
            )}
            {Array.isArray(inv.lineItems) && inv.lineItems.length > 0 && (
              <details className="mt-2 text-xs text-slate-600">
                <summary className="cursor-pointer select-none text-slate-500">
                  {inv.lineItems.length} part(s) read from invoice (OCR — verify)
                </summary>
                <div className="mt-2 space-y-1">
                  {inv.lineItems.map((li, li2) => (
                    <div
                      key={`${inv.invoiceNumber || "inv"}-${idx}-part-${li2}`}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-100 bg-white/70 px-2 py-1"
                    >
                      <span className="font-semibold text-slate-800">
                        {`${li.partLineCode || ""} ${li.partNumber || ""}`.trim() || "—"}
                      </span>
                      {li.partDescription && (
                        <span className="text-slate-500 flex-1 min-w-0 truncate">{li.partDescription}</span>
                      )}
                      {li.quantity && <span className="text-slate-500">Qty {li.quantity}</span>}
                      {li.costPrice && <span className="font-medium text-slate-700">${li.costPrice}</span>}
                    </div>
                  ))}
                </div>
              </details>
            )}
          </Card>
        );
      })}
    </div>
  );
}
