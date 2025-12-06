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
  onGetWorldOrders,
  worldOrdersRunning,
  worldOrdersStatus,
  worldOrdersError,
  onGetTransbecOrders,
  transbecOrdersRunning,
  transbecOrdersStatus,
  transbecOrdersError,
  onGetProforceOrders,
  proforceRunning,
  proforceStatus,
  proforceError,
  onAddOutstanding,
  outstandingRunning,
  outstandingStatus,
  outstandingError,
  storagePaths,
  onChooseItemsFolder,
  onChooseOrdersFolder,
  onUseDefaultFolders,
  pathsLoading,
}) {
  return (
    <section className="grid gap-4 lg:grid-cols-2">
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
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-lg font-semibold text-slate-800">Data locations</p>
              <p className="text-sm text-slate-500">
                Choose where <code>outstanding_items.json</code> and <code>orders.json</code> live. macOS
                prefers a local folder; Windows defaults to the UNC share.
              </p>
            </div>
            <button
              type="button"
              onClick={onUseDefaultFolders}
              disabled={pathsLoading}
              className="px-3 py-2 rounded-full bg-white border border-slate-200 text-xs font-semibold text-slate-700 disabled:opacity-60"
            >
              Use OS defaults
            </button>
          </div>
          <div className="text-xs text-slate-500">
            macOS → local folder you pick. Windows → server UNC path you pick (defaults to the share if not set).
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-2xl border border-slate-200 bg-white/70 p-3 shadow-sm">
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-1">
                  <div className="text-xs uppercase tracking-wide text-slate-500">Outstanding items</div>
                  <div className="text-sm text-slate-700 break-all">
                    <code className="text-indigo-600 break-all">
                      {storagePaths?.itemsPath || "outstanding_items.json"}
                    </code>
                  </div>
                  {storagePaths?.defaults?.itemsPath && (
                    <div className="text-[11px] text-slate-500">
                      Default: {storagePaths.defaults.itemsPath}
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  onClick={onChooseItemsFolder}
                  disabled={pathsLoading}
                  className="px-3 py-2 rounded-xl bg-indigo-600 text-white text-xs font-semibold disabled:opacity-60"
                >
                  Choose folder
                </button>
              </div>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-white/70 p-3 shadow-sm">
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-1">
                  <div className="text-xs uppercase tracking-wide text-slate-500">Orders</div>
                  <div className="text-sm text-slate-700 break-all">
                    <code className="text-indigo-600 break-all">
                      {storagePaths?.ordersPath || "orders.json"}
                    </code>
                  </div>
                  {storagePaths?.defaults?.ordersPath && (
                    <div className="text-[11px] text-slate-500">
                      Default: {storagePaths.defaults.ordersPath}
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  onClick={onChooseOrdersFolder}
                  disabled={pathsLoading}
                  className="px-3 py-2 rounded-xl bg-indigo-600 text-white text-xs font-semibold disabled:opacity-60"
                >
                  Choose folder
                </button>
              </div>
            </div>
          </div>
        </div>
      </Card>

      <Card className="bg-white/80">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-lg font-semibold text-slate-800">World orders pull</p>
            <p className="text-sm text-slate-500">
              Opens iautoparts and saves the latest orders using your stored credentials.
            </p>
          </div>
          <button
            type="button"
            onClick={onGetWorldOrders}
            disabled={worldOrdersRunning}
            className="px-4 py-2 rounded-full bg-indigo-600 text-white text-sm font-semibold disabled:opacity-60"
          >
            {worldOrdersRunning ? "Fetching..." : "GetWorldOrders"}
          </button>
        </div>
        {worldOrdersError && (
          <div className="mt-3 rounded-xl bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">
            {worldOrdersError}
          </div>
        )}
        {worldOrdersStatus && !worldOrdersError && (
          <div className="mt-3 rounded-xl bg-emerald-50 border border-emerald-200 px-3 py-2 text-sm text-emerald-700">
            {worldOrdersStatus}
          </div>
        )}
      </Card>

      <Card className="bg-white/80">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-lg font-semibold text-slate-800">Transbec orders pull</p>
            <p className="text-sm text-slate-500">
              Opens Transbec and saves the latest orders/products using stored credentials.
            </p>
          </div>
          <button
            type="button"
            onClick={onGetTransbecOrders}
            disabled={transbecOrdersRunning}
            className="px-4 py-2 rounded-full bg-indigo-600 text-white text-sm font-semibold disabled:opacity-60"
          >
            {transbecOrdersRunning ? "Fetching..." : "GetTransbecOrders"}
          </button>
        </div>
        {transbecOrdersError && (
          <div className="mt-3 rounded-xl bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">
            {transbecOrdersError}
          </div>
        )}
        {transbecOrdersStatus && !transbecOrdersError && (
          <div className="mt-3 rounded-xl bg-emerald-50 border border-emerald-200 px-3 py-2 text-sm text-emerald-700">
            {transbecOrdersStatus}
          </div>
        )}
      </Card>

      <Card className="bg-white/80">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-lg font-semibold text-slate-800">Proforce orders pull</p>
            <p className="text-sm text-slate-500">Logs in, scrapes Proforce orders, and saves to orders.json.</p>
          </div>
          <button
            type="button"
            onClick={onGetProforceOrders}
            disabled={proforceRunning}
            className="px-4 py-2 rounded-full bg-indigo-600 text-white text-sm font-semibold disabled:opacity-60"
          >
            {proforceRunning ? "Fetching..." : "GetProforceOrders"}
          </button>
        </div>
        {proforceError && (
          <div className="mt-3 rounded-xl bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">
            {proforceError}
          </div>
        )}
        {proforceStatus && !proforceError && (
          <div className="mt-3 rounded-xl bg-emerald-50 border border-emerald-200 px-3 py-2 text-sm text-emerald-700">
            {proforceStatus}
          </div>
        )}
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
