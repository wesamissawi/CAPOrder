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
    </section>
  );
}
