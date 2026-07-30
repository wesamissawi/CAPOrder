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

// A part with no line code can't be resolved to the right Sage code: capRules
// branches on the line code (NGK + an oxygen sensor -> NTK, TRK -> dash
// stripped), so a blank one silently falls through to the default template.
// Flag it loudly on the scan rather than letting it reach Sage as the wrong part.
function missingLineCode(li) {
  return !String(li?.partLineCode || "").trim();
}

function PartRow({ li, rowKey }) {
  const noCode = missingLineCode(li);
  return (
    <div
      key={rowKey}
      className={`flex flex-wrap items-center justify-between gap-2 rounded-lg border px-2 py-1 ${
        noCode ? "border-red-300 bg-red-50" : "border-slate-100 bg-white/70"
      }`}
    >
      <span className={`font-semibold ${noCode ? "text-red-700" : "text-slate-800"}`}>
        {`${li.partLineCode || ""} ${li.partNumber || ""}`.trim() || "—"}
      </span>
      {noCode && (
        <span
          className="px-2 py-0.5 rounded-full text-[10px] font-semibold border bg-red-100 text-red-700 border-red-300 whitespace-nowrap"
          title="OCR did not read a line code for this part. Without it the Sage code falls back to the default template and may be wrong — fix it before creating the order."
        >
          no line code
        </span>
      )}
      {li.partDescription && (
        <span className="text-slate-500 flex-1 min-w-0 truncate">{li.partDescription}</span>
      )}
      {li.quantity && <span className="text-slate-500">Qty {li.quantity}</span>}
      {li.costPrice && <span className="font-medium text-slate-700">${li.costPrice}</span>}
    </div>
  );
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
  onOpenAssignModal,
  onSetUnmatchable,
  onScanCredits,
  epicorCreditScanning,
  epicorCredits,
  epicorCreditError,
  epicorCreditStatusLog,
  epicorCreditScannedCount,
  epicorCreditUnknownCount,
  onLoadScannedCredits,
  onRescanCredit,
  onCreateCreditOrder,
  onRemoveCreditOrder,
  onMatchCreditToRequisition,
  waitingRequisitionCount,
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
  const [creditCreateStatus, setCreditCreateStatus] = useState({}); // { [creditMemoNumber]: "adding" | "created" | "removing" | "error:msg" }
  // Epicor credit scan (same portal/date range as the invoice scan above, with
  // the "Credit" document type ticked). Pinning a credit memo # returns just
  // that one document.
  const [creditMemoNumber, setCreditMemoNumber] = useState("");
  const [onlyNewEpicorCredits, setOnlyNewEpicorCredits] = useState(true);
  const [epicorCreditStatus, setEpicorCreditStatus] = useState({}); // { [creditNumber]: "adding" | "created" | "removing" | "error:msg" }
  const [epicorCreditRescanStatus, setEpicorCreditRescanStatus] = useState({});
  const [creditFromDate, setCreditFromDate] = useState(daysAgoIso(TRANSBEC_CREDIT_DEFAULT_LOOKBACK_DAYS));
  const [creditToDate, setCreditToDate] = useState(todayIso());
  const [onlyNewCredits, setOnlyNewCredits] = useState(true);

  // On open, list whatever was scanned in past sessions straight from the cache
  // (no browser) so the page isn't empty after a restart.
  useEffect(() => {
    if (onLoadScanned) onLoadScanned();
    if (onLoadScannedCredits) onLoadScannedCredits();
    if (onLoadTransbecCredits) onLoadTransbecCredits();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const epicorCreditList = Array.isArray(epicorCredits) ? epicorCredits : [];
  const visibleEpicorCredits = useMemo(
    // Keep just-created credits visible (with a badge) even though they now
    // count as "on file" — same rule the invoice list uses.
    () =>
      onlyNewEpicorCredits
        ? epicorCreditList.filter((c) => !c.known || c.created)
        : epicorCreditList,
    [epicorCreditList, onlyNewEpicorCredits]
  );

  async function handleCreateEpicorCreditOrder(credit) {
    const key = credit.invoiceNumber || "";
    setEpicorCreditStatus((p) => ({ ...p, [key]: "adding" }));
    try {
      const res = await onCreateCreditOrder(credit);
      if (!res?.ok) throw new Error(res?.error || "Failed to create credit order.");
      setEpicorCreditStatus((p) => ({ ...p, [key]: "created" }));
    } catch (e) {
      setEpicorCreditStatus((p) => ({ ...p, [key]: "error:" + (e?.message || "Failed") }));
    }
  }

  async function handleRemoveEpicorCreditOrder(credit) {
    const key = credit.invoiceNumber || "";
    setEpicorCreditStatus((p) => ({ ...p, [key]: "removing" }));
    try {
      const res = await onRemoveCreditOrder(credit);
      if (!res?.ok) throw new Error(res?.error || "Failed to remove credit order.");
      setEpicorCreditStatus((p) => {
        const next = { ...p };
        delete next[key];
        return next;
      });
    } catch (e) {
      setEpicorCreditStatus((p) => ({ ...p, [key]: "error:" + (e?.message || "Failed") }));
    }
  }

  async function handleRescanEpicorCredit(credit) {
    const key = credit.invoiceNumber || "";
    setEpicorCreditRescanStatus((p) => ({ ...p, [key]: "rescanning" }));
    try {
      const res = await onRescanCredit(credit);
      if (!res?.ok) throw new Error(res?.error || "Rescan failed.");
      setEpicorCreditRescanStatus((p) => {
        const next = { ...p };
        delete next[key];
        return next;
      });
    } catch (e) {
      setEpicorCreditRescanStatus((p) => ({ ...p, [key]: "error:" + (e?.message || "Failed") }));
    }
  }

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
  // `unmatchable` scans are hand-ruled-out and must not count as outstanding
  // work here either, or the badge would keep advertising a queue the assign
  // picker no longer offers.
  const needsAssignmentCount = useMemo(
    () => invoices.filter((i) => !i.known && !i.created && !i.assignedTo && !i.unmatchable).length,
    [invoices]
  );
  const unmatchableCount = useMemo(
    () => invoices.filter((i) => i.unmatchable).length,
    [invoices]
  );
  const visible = useMemo(
    // Keep just-created invoices visible (with a badge) even though they now
    // count as "on file", so the user sees the confirmation. Flagged ones stay
    // listed too — this view is where you undo the flag.
    () =>
      onlyNew
        ? invoices.filter((i) => !i.known || i.created || i.assignedTo || i.unmatchable)
        : invoices,
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
              {onOpenAssignModal && needsAssignmentCount > 0 && (
                <button
                  className="rounded-xl bg-white border border-indigo-200 text-indigo-700 px-4 py-2 font-semibold hover:bg-indigo-50 whitespace-nowrap"
                  onClick={() => onOpenAssignModal(null)}
                  title="Match scanned invoices to the orders they belong to, side by side"
                >
                  Assign scans ({needsAssignmentCount})
                </button>
              )}
              {unmatchableCount > 0 && (
                <span
                  className="rounded-xl bg-slate-100 border border-slate-300 text-slate-600 px-4 py-2 font-semibold whitespace-nowrap"
                  title="Scans flagged as having no order on our side. They're listed below with a Put back button, and are no longer offered when matching."
                >
                  No matching order ({unmatchableCount})
                </span>
              )}
            </div>
          </div>
          {onScanCredits && (
            <div className="border-t border-slate-100 pt-3 grid gap-3 md:grid-cols-[1fr,auto] items-end">
              <div className="flex flex-col gap-1">
                <label className="text-xs uppercase tracking-wide text-slate-500">
                  Credit memo #
                </label>
                <input
                  type="text"
                  className="rounded-xl border border-slate-200 px-3 py-2 text-sm"
                  placeholder="Credit memo number to look up"
                  value={creditMemoNumber}
                  maxLength={25}
                  onChange={(e) => setCreditMemoNumber(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && creditMemoNumber.trim() && !epicorCreditScanning) {
                      onScanCredits(creditMemoNumber.trim());
                    }
                  }}
                />
              </div>
              <button
                className="rounded-xl bg-amber-600 text-white px-4 py-2 font-semibold shadow hover:bg-amber-700 disabled:opacity-60 whitespace-nowrap"
                onClick={() => onScanCredits(creditMemoNumber.trim())}
                disabled={!creditMemoNumber.trim() || epicorCreditScanning}
                title="Look this credit memo up on Epicor by number — it gets OCR'd, saved and totalled exactly like an invoice"
              >
                {epicorCreditScanning ? "Looking up…" : "Scan for Credits"}
              </button>
            </div>
          )}
          <p className="text-xs text-slate-400">
            The list below shows every invoice scanned so far (loaded from cache, no browser). Run a
            scan to add invoices for a new date range — a browser window opens and each invoice is
            read with OCR; ones scanned before are reused from cache.
            {onScanCredits
              ? " Credits are looked up by credit memo number instead (Epicor has no date search for them) — the dates above don’t apply."
              : ""}
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

      {onScanCredits && (
        <Card>
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-xl font-semibold text-slate-800">Epicor Credits</h2>
                <p className="text-sm text-slate-500">
                  Credit memos looked up on the Epicor portal by credit memo number. Each one is
                  OCR'd, imaged and totalled the same way an invoice is.{" "}
                  <strong>Create credit order</strong> puts it in the <strong>Credit</strong> filter
                  in Order Management, where it can be matched to the return requisition it pays
                  back.
                </p>
              </div>
              {epicorCreditScannedCount > 0 && (
                <label className="flex items-center gap-2 text-sm text-slate-600 whitespace-nowrap">
                  <input
                    type="checkbox"
                    checked={onlyNewEpicorCredits}
                    onChange={(e) => setOnlyNewEpicorCredits(e.target.checked)}
                  />
                  Show only credits I don&apos;t have
                </label>
              )}
            </div>
            {epicorCreditScannedCount > 0 && (
              <div className="flex flex-wrap items-center gap-4 text-sm">
                <span className="text-slate-600">
                  Found{" "}
                  <span className="font-semibold text-slate-800">{epicorCreditScannedCount}</span>{" "}
                  credit(s)
                </span>
                <span
                  className={`px-2 py-1 rounded-full border font-semibold ${
                    epicorCreditUnknownCount > 0
                      ? "bg-amber-100 text-amber-800 border-amber-300"
                      : "bg-emerald-50 text-emerald-700 border-emerald-200"
                  }`}
                >
                  {epicorCreditUnknownCount} not in records
                </span>
              </div>
            )}
            {epicorCreditError && (
              <div className="text-sm text-red-600 whitespace-pre-line">{epicorCreditError}</div>
            )}
            {Array.isArray(epicorCreditStatusLog) && epicorCreditStatusLog.length > 0 && (
              <details className="text-xs text-slate-500">
                <summary className="cursor-pointer select-none">Credit scan log</summary>
                <pre className="mt-2 whitespace-pre-wrap text-slate-500">
                  {epicorCreditStatusLog.join("\n")}
                </pre>
              </details>
            )}
            {epicorCreditList.length === 0 && !epicorCreditScanning && (
              <p className="text-sm text-slate-500">
                No credits looked up yet. Enter a credit memo # above and click{" "}
                <strong>Scan for Credits</strong>.
              </p>
            )}
            {epicorCreditList.length > 0 && visibleEpicorCredits.length === 0 && (
              <p className="text-sm text-slate-500">
                Every credit found is already in your records. 🎉 Untick “only new” to see them all.
              </p>
            )}
            {visibleEpicorCredits.map((credit, idx) => {
              const key = credit.invoiceNumber || "";
              const total = Number(credit.balanceDue);
              const status = epicorCreditStatus[key];
              const isError = status?.startsWith("error:");
              const rescan = epicorCreditRescanStatus[key];
              const rescanError = rescan?.startsWith("error:");
              const created = credit.known || credit.created || status === "created";
              const creditNoCodeCount = (credit.lineItems || []).filter(missingLineCode).length;
              // Every saved page of the credit memo, so a 2-page one can be
              // opened page by page. Older entries only ever have page 1.
              const pages =
                Array.isArray(credit.pageImageFileNames) && credit.pageImageFileNames.length
                  ? credit.pageImageFileNames
                  : credit.imageFileName
                  ? [credit.imageFileName]
                  : [];
              return (
                <div
                  key={`${key || "credit"}-${idx}`}
                  className={`rounded-xl border px-3 py-2 ${
                    created ? "border-slate-100" : "border-amber-300 bg-amber-50/40"
                  }`}
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="flex flex-wrap items-center gap-4">
                      <div>
                        <div className="text-xs uppercase tracking-wide text-slate-400 leading-none mb-0.5">
                          Credit #
                        </div>
                        <div className="text-xl font-bold text-amber-700">{key || "—"}</div>
                      </div>
                      {credit.date && (
                        <div>
                          <div className="text-xs uppercase tracking-wide text-slate-400 leading-none mb-0.5">
                            Date
                          </div>
                          <div className="text-base font-semibold text-slate-800">{credit.date}</div>
                        </div>
                      )}
                      {Number.isFinite(total) && (
                        <div>
                          <div className="text-xs uppercase tracking-wide text-slate-400 leading-none mb-0.5">
                            Credit Total
                          </div>
                          <div className="text-base font-semibold text-slate-800">
                            ${total.toFixed(2)}
                          </div>
                        </div>
                      )}
                      {credit.reference && (
                        <div>
                          <div className="text-xs uppercase tracking-wide text-slate-400 leading-none mb-0.5">
                            Order ref (OCR)
                          </div>
                          <div className="text-base font-semibold text-slate-800">
                            {credit.reference}
                          </div>
                        </div>
                      )}
                      {credit.accountName && (
                        <div>
                          <div className="text-xs uppercase tracking-wide text-slate-400 leading-none mb-0.5">
                            Account
                          </div>
                          <div className="text-sm font-medium text-slate-700">
                            {credit.accountName}
                          </div>
                        </div>
                      )}
                    </div>
                    <div className="flex flex-col items-end gap-2">
                      <div className="flex flex-wrap justify-end gap-2">
                        <span
                          className={`px-2 py-1 rounded-full text-xs border ${
                            created
                              ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                              : "bg-amber-100 text-amber-800 border-amber-300 font-semibold"
                          }`}
                        >
                          {created ? "On file" : "Not in records"}
                        </span>
                        {pages.length > 1 && (
                          <span
                            className="px-2 py-1 rounded-full text-xs border bg-slate-50 text-slate-600 border-slate-200"
                            title="Every page of this credit memo was read — parts continuing onto later pages are included below."
                          >
                            {pages.length} pages read
                          </span>
                        )}
                        {/* Set only when the document says it continues but we
                            did not read past page 1 (i.e. it was scanned before
                            multi-page support). Only page 1 was ever downloaded,
                            so "Rescan this one" can't recover page 2 — the credit
                            has to be looked up again. */}
                        {credit.continuesOnNextPage && (
                          <span
                            className="px-2 py-1 rounded-full text-xs border bg-orange-50 text-orange-700 border-orange-200"
                            title="This credit memo continues on another page that was never downloaded, so parts printed there are missing. Look the credit up again above to re-read every page."
                          >
                            Page 1 only — look up again
                          </span>
                        )}
                      </div>
                      {pages.length > 0 && onViewInvoiceImage && (
                        <div className="flex flex-wrap justify-end gap-1">
                          {pages.map((fileName, pageIdx) => (
                            <button
                              key={fileName}
                              className="px-3 py-1 rounded-full text-xs font-semibold border bg-white text-indigo-700 border-indigo-200 hover:bg-indigo-50"
                              onClick={() => onViewInvoiceImage(fileName)}
                            >
                              {pages.length > 1
                                ? `View page ${pageIdx + 1}`
                                : "View credit image"}
                            </button>
                          ))}
                        </div>
                      )}
                      {onRescanCredit && (
                        <button
                          className={`px-3 py-1 rounded-full text-xs font-semibold border disabled:opacity-60 ${
                            rescanError
                              ? "bg-red-50 text-red-600 border-red-200"
                              : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50"
                          }`}
                          disabled={rescan === "rescanning"}
                          title={
                            rescanError
                              ? rescan.slice(6)
                              : "Re-OCR this credit's saved image (refreshes its total and parts) — no Epicor login needed"
                          }
                          onClick={() => handleRescanEpicorCredit(credit)}
                        >
                          {rescan === "rescanning"
                            ? "Rescanning…"
                            : rescanError
                            ? "Retry rescan"
                            : "Rescan this one"}
                        </button>
                      )}
                      {!created && onMatchCreditToRequisition && (
                        <button
                          className="px-3 py-1 rounded-full text-xs font-semibold border bg-white text-amber-700 border-amber-300 hover:bg-amber-50"
                          title={
                            waitingRequisitionCount
                              ? `Match this credit to one of the ${waitingRequisitionCount} requisition(s) waiting on a credit, check the parts, then add it to orders`
                              : "Review the parts on this credit and add it to orders (no requisitions are waiting on a credit right now)"
                          }
                          onClick={() => onMatchCreditToRequisition(credit)}
                        >
                          Match to requisition…
                        </button>
                      )}
                      {created
                        ? onRemoveCreditOrder && (
                            <button
                              className="px-3 py-1 rounded-full text-xs font-semibold border bg-white text-red-600 border-red-200 hover:bg-red-50 disabled:opacity-60"
                              disabled={status === "removing"}
                              title={
                                isError
                                  ? status.slice(6)
                                  : "Remove this credit order from Order Management"
                              }
                              onClick={() => handleRemoveEpicorCreditOrder(credit)}
                            >
                              {status === "removing"
                                ? "Removing…"
                                : isError
                                ? "Retry remove"
                                : "Remove"}
                            </button>
                          )
                        : onCreateCreditOrder && (
                            <button
                              className={`px-3 py-1 rounded-full text-xs font-semibold border disabled:opacity-60 ${
                                isError
                                  ? "bg-red-50 text-red-600 border-red-200"
                                  : "bg-white text-emerald-700 border-emerald-200 hover:bg-emerald-50"
                              }`}
                              disabled={status === "adding" || !key}
                              title={
                                isError
                                  ? status.slice(6)
                                  : "Add this credit to Order Management under the Credit filter"
                              }
                              onClick={() => handleCreateEpicorCreditOrder(credit)}
                            >
                              {status === "adding"
                                ? "Creating…"
                                : isError
                                ? "Retry create"
                                : "Create credit order"}
                            </button>
                          )}
                    </div>
                  </div>
                  {(credit.poNumber || credit.releaseNumber) && (
                    <div className="mt-2 text-xs text-slate-500">
                      {credit.poNumber ? `PO: ${credit.poNumber}` : ""}
                      {credit.poNumber && credit.releaseNumber ? " · " : ""}
                      {credit.releaseNumber ? `Release: ${credit.releaseNumber}` : ""}
                    </div>
                  )}
                  {Array.isArray(credit.lineItems) && credit.lineItems.length > 0 && (
                    <details className="mt-2 text-xs text-slate-600" open={creditNoCodeCount > 0}>
                      <summary className="cursor-pointer select-none text-slate-500">
                        {credit.lineItems.length} returned part(s) read from credit (OCR — verify)
                        {creditNoCodeCount > 0 && (
                          <span className="ml-2 px-2 py-0.5 rounded-full text-[10px] font-semibold border bg-red-100 text-red-700 border-red-300">
                            {creditNoCodeCount} with no line code
                          </span>
                        )}
                      </summary>
                      <div className="mt-2 space-y-1">
                        {credit.lineItems.map((li, li2) => (
                          <PartRow
                            key={`${key || "credit"}-${idx}-part-${li2}`}
                            rowKey={`${key || "credit"}-${idx}-part-${li2}`}
                            li={li}
                          />
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
                {/* A scan ruled out by hand: say so plainly and offer the undo.
                    Shown ahead of the assign/create actions because while it's
                    flagged those don't apply. */}
                {!inv.known && inv.unmatchable && (
                  <span className="flex items-center gap-2">
                    <span
                      className="px-3 py-1 rounded-full text-xs font-semibold border bg-slate-100 text-slate-600 border-slate-300"
                      title={
                        inv.unmatchableAt
                          ? `Flagged as having no order on ${new Date(inv.unmatchableAt).toLocaleString()}`
                          : "Flagged as having no order on our side"
                      }
                    >
                      No matching order
                    </span>
                    {onSetUnmatchable && (
                      <button
                        className="px-3 py-1 rounded-full text-xs font-semibold border bg-white text-indigo-700 border-indigo-200 hover:bg-indigo-50"
                        title="Put this scan back in the assign picker"
                        onClick={() => onSetUnmatchable(inv.invoiceNumber, false)}
                      >
                        Put back
                      </button>
                    )}
                  </span>
                )}
                {!inv.known && !inv.unmatchable && onOpenAssignModal && (() => {
                  if (inv.assignedTo) {
                    return (
                      <span className="px-3 py-1 rounded-full text-xs font-semibold border bg-emerald-50 text-emerald-700 border-emerald-200">
                        Assigned to {inv.assignedTo} ✓
                      </span>
                    );
                  }
                  const options = Array.isArray(assignableOrders) ? assignableOrders : [];
                  if (options.length === 0) {
                    return <span className="text-xs text-slate-400">No unassigned orders to link</span>;
                  }
                  return (
                    <>
                      <button
                        className="px-3 py-1 rounded-full text-xs font-semibold border bg-white text-indigo-700 border-indigo-200 hover:bg-indigo-50"
                        title="Open the assign picker with this invoice selected, and pick the order it belongs to"
                        onClick={() => onOpenAssignModal(inv)}
                      >
                        Assign to an order…
                      </button>
                      {onSetUnmatchable && (
                        <button
                          className="px-3 py-1 rounded-full text-xs font-semibold border bg-white text-slate-600 border-slate-300 hover:bg-amber-50 hover:text-amber-800 hover:border-amber-300"
                          title="This scan belongs to no order of ours (counter sale, another branch, duplicate). Stops it being offered when matching — reversible."
                          onClick={() => onSetUnmatchable(inv.invoiceNumber, true)}
                        >
                          No matching order
                        </button>
                      )}
                    </>
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
            {Array.isArray(inv.lineItems) && inv.lineItems.length > 0 && (() => {
              const noCodeCount = inv.lineItems.filter(missingLineCode).length;
              return (
                <details className="mt-2 text-xs text-slate-600" open={noCodeCount > 0}>
                  <summary className="cursor-pointer select-none text-slate-500">
                    {inv.lineItems.length} part(s) read from invoice (OCR — verify)
                    {noCodeCount > 0 && (
                      <span className="ml-2 px-2 py-0.5 rounded-full text-[10px] font-semibold border bg-red-100 text-red-700 border-red-300">
                        {noCodeCount} with no line code
                      </span>
                    )}
                  </summary>
                  <div className="mt-2 space-y-1">
                    {inv.lineItems.map((li, li2) => (
                      <PartRow
                        key={`${inv.invoiceNumber || "inv"}-${idx}-part-${li2}`}
                        rowKey={`${inv.invoiceNumber || "inv"}-${idx}-part-${li2}`}
                        li={li}
                      />
                    ))}
                  </div>
                </details>
              );
            })()}
          </Card>
        );
      })}
    </div>
  );
}
