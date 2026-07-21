import React from "react";
import Card from "../components/Card";

export default function DashboardView({
  returnsFilterEnabled,
  setReturnsFilterEnabled,
  returnsFilterDays,
  setReturnsFilterDays,
  timeFilterEnabled,
  setTimeFilterEnabled,
  timeFilterMinutes,
  setTimeFilterMinutes,
  timeFilterHours,
  setTimeFilterHours,
  timeFilterDays,
  setTimeFilterDays,
  onAddOutstanding,
  outstandingRunning,
  outstandingStatus,
  outstandingError,
  onArchiveOrders,
  ordersArchiveRunning,
  ordersArchiveStatus,
  ordersArchiveError,
  archiveCleanupDays,
  setArchiveCleanupDays,
  sagePoEnabled,
  onToggleSagePo,
  sageInvoiceEnabled,
  onToggleSageInvoice,
  sageLockInfo,
  sageReadyOrders,
  sageInvoiceReadyOrders,
  sageWatchError,
  sageInvoiceError,
}) {
  const lockOwner = sageLockInfo?.lock?.machineId || null;
  const ownMachineId = sageLockInfo?.ownMachineId || null;
  // Only a live (still-heartbeating) lock blocks this machine; a stale one is claimable.
  const lockedByOther = Boolean(
    lockOwner && ownMachineId && lockOwner !== ownMachineId && sageLockInfo?.lockIsLive
  );
  const lockIsRunning = sageLockInfo?.lock?.running === true;
  const poReadyCount = Array.isArray(sageReadyOrders) ? sageReadyOrders.length : 0;
  const invoiceReadyCount = Array.isArray(sageInvoiceReadyOrders) ? sageInvoiceReadyOrders.length : 0;
  return (
    <section className="grid gap-4 lg:grid-cols-2 items-start text-left">
      {/* Purchase orders — cross-machine exclusive via the shared lock */}
      <Card className="bg-white/80">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1">
            <p className="text-lg font-semibold text-slate-800">Sage purchase orders</p>
            <p className="text-sm text-slate-500">
              Enters flagged purchase orders into Sage on the machine running Sage + AutoHotkey. Only
              <strong className="mx-1">one machine</strong>can run this at a time.
            </p>
            {sagePoEnabled && (
              <p className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-xl px-3 py-2">
                Watching orders.json — {poReadyCount} order{poReadyCount === 1 ? "" : "s"} ready for Sage.
              </p>
            )}
            {!sagePoEnabled && lockedByOther && (
              <p className="text-xs rounded-xl px-3 py-2 border text-amber-700 bg-amber-50 border-amber-200">
                {lockIsRunning
                  ? `🔒 Running on ${lockOwner}. Turn it off there before enabling here.`
                  : `🔒 Held by ${lockOwner}. Turn it off there before enabling here.`}
              </p>
            )}
            {sageWatchError && (
              <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-xl px-3 py-2">
                {sageWatchError}
              </p>
            )}
          </div>
          <button
            type="button"
            disabled={!sagePoEnabled && lockedByOther}
            onClick={onToggleSagePo}
            className={`px-4 py-2 rounded-full text-sm font-semibold border transition ${
              sagePoEnabled
                ? "bg-emerald-100 text-emerald-700 border-emerald-200"
                : lockedByOther
                ? "bg-slate-100 text-slate-400 border-slate-200 cursor-not-allowed"
                : "bg-white text-slate-700 border-slate-200"
            }`}
          >
            {sagePoEnabled ? "POs On" : "POs Off"}
          </button>
        </div>
      </Card>

      {/* Invoices — local to this machine, never gated by the lock */}
      <Card className="bg-white/80">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1">
            <p className="text-lg font-semibold text-slate-800">Sage invoices</p>
            <p className="text-sm text-slate-500">
              Sends invoice updates to Sage on <strong className="mx-1">this machine</strong>. Runs
              independently — no cross-machine lock.
            </p>
            {sageInvoiceEnabled && (
              <p className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-xl px-3 py-2">
                Watching orders.json — {invoiceReadyCount} invoice update{invoiceReadyCount === 1 ? "" : "s"} queued.
              </p>
            )}
            {sageInvoiceError && (
              <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-xl px-3 py-2">
                {sageInvoiceError}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onToggleSageInvoice}
            className={`px-4 py-2 rounded-full text-sm font-semibold border transition ${
              sageInvoiceEnabled
                ? "bg-emerald-100 text-emerald-700 border-emerald-200"
                : "bg-white text-slate-700 border-slate-200"
            }`}
          >
            {sageInvoiceEnabled ? "Invoices On" : "Invoices Off"}
          </button>
        </div>
      </Card>

      <Card className="bg-white/80">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-lg font-semibold text-slate-800">Orders archive cleanup</p>
            <p className="text-sm text-slate-500">
              Move completed orders into the archive after the cooldown window.
            </p>
          </div>
          <button
            type="button"
            onClick={onArchiveOrders}
            disabled={ordersArchiveRunning}
            className="px-4 py-2 rounded-full bg-slate-900 text-white text-sm font-semibold disabled:opacity-60"
          >
            {ordersArchiveRunning ? "Archiving..." : "Archive Completed"}
          </button>
        </div>
        <div className="mt-4 flex items-center gap-4">
          <input
            type="range"
            min={0}
            max={14}
            value={archiveCleanupDays}
            onChange={(e) => setArchiveCleanupDays(Number(e.target.value) || 0)}
            className="flex-1 accent-indigo-600"
          />
          <div className="text-sm text-slate-700 w-24 text-right">
            {archiveCleanupDays} day{archiveCleanupDays === 1 ? "" : "s"}
          </div>
        </div>
        {ordersArchiveError && (
          <div className="mt-3 rounded-xl bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">
            {ordersArchiveError}
          </div>
        )}
        {ordersArchiveStatus && !ordersArchiveError && (
          <div className="mt-3 rounded-xl bg-emerald-50 border border-emerald-200 px-3 py-2 text-sm text-emerald-700">
            {ordersArchiveStatus}
          </div>
        )}
      </Card>

      <Card className="bg-white/80">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-lg font-semibold text-slate-800">Returns/Shelf filter</p>
            <p className="text-sm text-slate-500">
              Hide items in Returns, Cash Sales, and Shelf older than the slider value (days).
            </p>
          </div>
          <button
            type="button"
            className={`px-3 py-1 rounded-full text-xs font-semibold border ${
              returnsFilterEnabled
                ? "bg-emerald-100 text-emerald-700 border-emerald-200"
                : "bg-white text-slate-600 border-slate-200"
            }`}
            onClick={() => setReturnsFilterEnabled((v) => !v)}
          >
            {returnsFilterEnabled ? "Filtering On" : "Filtering Off"}
          </button>
        </div>
        <div className="mt-4 flex items-center gap-4">
          <input
            type="range"
            min={0}
            max={7}
            value={returnsFilterDays}
            onChange={(e) => setReturnsFilterDays(Number(e.target.value) || 0)}
            disabled={!returnsFilterEnabled}
            className="flex-1 accent-indigo-600"
          />
          <div className="text-sm text-slate-700 w-20 text-right">
            {returnsFilterDays} day{returnsFilterDays === 1 ? "" : "s"}
          </div>
        </div>
      </Card>

      <Card className="bg-white/80">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-lg font-semibold text-slate-800">Stock Flow age filter</p>
            <p className="text-sm text-slate-500">
              Hide any items older than the combined minutes / hours / days below.
            </p>
          </div>
          <button
            type="button"
            className={`px-3 py-1 rounded-full text-xs font-semibold border ${
              timeFilterEnabled
                ? "bg-emerald-100 text-emerald-700 border-emerald-200"
                : "bg-white text-slate-600 border-slate-200"
            }`}
            onClick={() => setTimeFilterEnabled((v) => !v)}
          >
            {timeFilterEnabled ? "Filtering On" : "Filtering Off"}
          </button>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <div className="flex flex-col gap-1">
            <label className="text-xs uppercase tracking-wide text-slate-500">Minutes</label>
            <input
              type="range"
              min={0}
              max={60}
              value={timeFilterMinutes}
              onChange={(e) => setTimeFilterMinutes(Number(e.target.value) || 0)}
              disabled={!timeFilterEnabled}
              className="accent-indigo-600"
            />
            <span className="text-xs text-slate-700">{timeFilterMinutes}m</span>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs uppercase tracking-wide text-slate-500">Hours</label>
            <input
              type="range"
              min={0}
              max={23}
              value={timeFilterHours}
              onChange={(e) => setTimeFilterHours(Number(e.target.value) || 0)}
              disabled={!timeFilterEnabled}
              className="accent-indigo-600"
            />
            <span className="text-xs text-slate-700">{timeFilterHours}h</span>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs uppercase tracking-wide text-slate-500">Days</label>
            <input
              type="range"
              min={0}
              max={30}
              value={timeFilterDays}
              onChange={(e) => setTimeFilterDays(Number(e.target.value) || 0)}
              disabled={!timeFilterEnabled}
              className="accent-indigo-600"
            />
            <span className="text-xs text-slate-700">{timeFilterDays}d</span>
          </div>
        </div>
      </Card>

      <Card className="bg-white/80">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-lg font-semibold text-slate-800">Add to Outstanding</p>
            <p className="text-sm text-slate-500">
              Scans orders.json for line items not yet added and appends them to outstanding_items.
            </p>
          </div>
          <button
            type="button"
            onClick={onAddOutstanding}
            disabled={outstandingRunning}
            className="px-4 py-2 rounded-full bg-emerald-600 text-white text-sm font-semibold disabled:opacity-60"
          >
            {outstandingRunning ? "Adding..." : "Add Outstanding"}
          </button>
        </div>
        {outstandingError && (
          <div className="mt-3 rounded-xl bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">
            {outstandingError}
          </div>
        )}
        {outstandingStatus && !outstandingError && (
          <div className="mt-3 rounded-xl bg-emerald-50 border border-emerald-200 px-3 py-2 text-sm text-emerald-700">
            {outstandingStatus}
          </div>
        )}
      </Card>
    </section>
  );
}
