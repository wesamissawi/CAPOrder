import React, { useMemo, useState } from "react";
import Card from "../components/Card";

const currencyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

const numberFormatter = new Intl.NumberFormat("en-US");

const normalizeBubbleName = (name) => {
  const trimmed = (name || "").trim();
  return trimmed || "New Stock";
};

const isSold = (item) => {
  const status = (item.sold_status || "").trim().toLowerCase();
  const soldDate = (item.sold_date || "").trim();
  if (soldDate) return true;
  if (!status) return false;
  if (["pending", "unsold", "na", "n/a"].includes(status)) return false;
  return true;
};

const dateLabel = (value) => {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "—";
  return parsed.toLocaleString();
};

export default function ManageStockView({ items = [], bubbles = [], onEditItem, onUpdateItem }) {
  const [search, setSearch] = useState("");
  const [bubbleFilter, setBubbleFilter] = useState("all");
  const [warehouseFilter, setWarehouseFilter] = useState("all");
  const [soldFilter, setSoldFilter] = useState("all");
  const [sortBy, setSortBy] = useState("recent");

  const bubbleOptions = useMemo(() => {
    const names = new Set();
    bubbles.forEach((b) => names.add(normalizeBubbleName(b.name)));
    items.forEach((it) => names.add(normalizeBubbleName(it.allocated_to)));
    return Array.from(names).sort((a, b) => a.localeCompare(b));
  }, [bubbles, items]);

  const warehouseOptions = useMemo(() => {
    const names = new Set();
    let hasUnspecified = false;
    items.forEach((it) => {
      const warehouse = (it.warehouse || "").trim();
      if (warehouse) {
        names.add(warehouse);
      } else {
        hasUnspecified = true;
      }
    });
    const sorted = Array.from(names).sort((a, b) => a.localeCompare(b));
    return hasUnspecified ? ["Unspecified", ...sorted] : sorted;
  }, [items]);

  const stats = useMemo(() => {
    const totalQty = items.reduce((sum, it) => sum + (Number(it.quantity) || 0), 0);
    const soldCount = items.filter(isSold).length;
    const unsoldCount = items.length - soldCount;
    const lastTouched = items.reduce((latest, it) => {
      const ts = Date.parse(it.last_moved_at || it.date || "");
      if (Number.isNaN(ts)) return latest;
      return Math.max(latest, ts);
    }, 0);
    return {
      totalQty,
      soldCount,
      unsoldCount,
      lastTouchedLabel: lastTouched ? new Date(lastTouched).toLocaleString() : "—",
    };
  }, [items]);

  const filteredItems = useMemo(() => {
    const query = search.trim().toLowerCase();
    const normalizeWarehouse = (value) => {
      const trimmed = (value || "").trim();
      return trimmed || "Unspecified";
    };

    const matchesQuery = (item) => {
      if (!query) return true;
      const fields = [
        item.itemcode,
        item.reference_num,
        item.source_inv,
        item.invoice_num,
        item.notes1,
        item.notes2,
        item.allocated_to,
        item.allocated_for,
        item.warehouse,
        item.sold_status,
      ];
      return fields.some((val) => val && String(val).toLowerCase().includes(query));
    };

    const sorted = [...items].filter((it) => {
      const bubbleName = normalizeBubbleName(it.allocated_to);
      const warehouseName = normalizeWarehouse(it.warehouse);
      const sold = isSold(it);
      if (bubbleFilter !== "all" && bubbleName !== bubbleFilter) return false;
      if (warehouseFilter !== "all" && warehouseName !== warehouseFilter) return false;
      if (soldFilter === "sold" && !sold) return false;
      if (soldFilter === "unsold" && sold) return false;
      if (!matchesQuery(it)) return false;
      return true;
    });

    sorted.sort((a, b) => {
      if (sortBy === "bubble") {
        return normalizeBubbleName(a.allocated_to).localeCompare(normalizeBubbleName(b.allocated_to));
      }
      if (sortBy === "quantity") {
        return (Number(b.quantity) || 0) - (Number(a.quantity) || 0);
      }
      // default: most recently moved/created first
      const aTs = Date.parse(a.last_moved_at || a.date || "") || 0;
      const bTs = Date.parse(b.last_moved_at || b.date || "") || 0;
      return bTs - aTs;
    });

    return sorted;
  }, [bubbleFilter, items, search, soldFilter, sortBy, warehouseFilter]);

  return (
    <>
      <section>
        <Card>
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div>
              <div className="text-sm uppercase tracking-wide text-slate-400">Manage stock</div>
              <div className="text-base font-semibold text-slate-700">
                Full inventory list, regardless of bubble or status
              </div>
              <p className="text-xs text-slate-500">
                Every item that appears in Stock Flow (New Stock, Shelf, custom bubbles, and more) is surfaced here
                so you can search and filter without leaving this view.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 md:max-w-xl w-full">
              <div className="rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2">
                <div className="text-[11px] uppercase tracking-wide text-slate-400">Items</div>
                <div className="text-lg font-semibold text-slate-800">{numberFormatter.format(items.length)}</div>
              </div>
              <div className="rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2">
                <div className="text-[11px] uppercase tracking-wide text-slate-400">Total qty</div>
                <div className="text-lg font-semibold text-slate-800">{numberFormatter.format(stats.totalQty)}</div>
              </div>
              <div className="rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2">
                <div className="text-[11px] uppercase tracking-wide text-slate-400">Unsold</div>
                <div className="text-lg font-semibold text-indigo-700">
                  {numberFormatter.format(stats.unsoldCount)}
                </div>
              </div>
              <div className="rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2">
                <div className="text-[11px] uppercase tracking-wide text-slate-400">Last movement</div>
                <div className="text-sm font-semibold text-slate-800">{stats.lastTouchedLabel}</div>
              </div>
            </div>
          </div>
        </Card>
      </section>

      <section>
        <Card>
          <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
            <div className="flex flex-1 flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search item code, invoice, reference, notes..."
                className="w-full sm:w-72 border rounded-xl px-3 py-2 text-sm bg-white shadow-inner"
              />
              <select
                value={bubbleFilter}
                onChange={(e) => setBubbleFilter(e.target.value)}
                className="border rounded-xl px-3 py-2 text-sm bg-white min-w-[160px]"
              >
                <option value="all">All bubbles</option>
                {bubbleOptions.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
              <select
                value={warehouseFilter}
                onChange={(e) => setWarehouseFilter(e.target.value)}
                className="border rounded-xl px-3 py-2 text-sm bg-white min-w-[160px]"
              >
                <option value="all">All warehouses</option>
                {warehouseOptions.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
              <select
                value={soldFilter}
                onChange={(e) => setSoldFilter(e.target.value)}
                className="border rounded-xl px-3 py-2 text-sm bg-white"
              >
                <option value="all">Sold + Unsold</option>
                <option value="unsold">Unsold only</option>
                <option value="sold">Marked sold</option>
              </select>
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value)}
                className="border rounded-xl px-3 py-2 text-sm bg-white"
              >
                <option value="recent">Most recently moved</option>
                <option value="bubble">Bubble (A→Z)</option>
                <option value="quantity">Quantity (high→low)</option>
              </select>
              <div className="text-xs text-slate-500">
                {numberFormatter.format(filteredItems.length)} result{filteredItems.length === 1 ? "" : "s"}
              </div>
            </div>
          </div>
        </Card>
      </section>

      <section>
        <Card className="p-0">
          <div className="overflow-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 text-slate-500 text-xs uppercase tracking-wide">
                <tr>
                  <th className="px-4 py-3 text-left">Item</th>
                  <th className="px-4 py-3 text-left">Pricing</th>
                  <th className="px-4 py-3 text-left">Source</th>
                  <th className="px-4 py-3 text-left">Status</th>
                  <th className="px-4 py-3 text-left">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredItems.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-8 text-center text-slate-500">
                      No items match the current filters.
                    </td>
                  </tr>
                ) : (
                  filteredItems.map((it) => {
                    const bubbleName = normalizeBubbleName(it.allocated_to);
                    const sold = isSold(it);
                    return (
                      <tr key={it.uid} className="border-b last:border-0 border-slate-200">
                        <td className="px-4 py-3 align-top">
                          <div className="flex items-start gap-3">
                            <div>
                              <div className="text-base font-semibold text-slate-800">
                                {it.itemcode || "Item"}
                              </div>
                              <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-600">
                                <span className="px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-700 border border-indigo-100">
                                  {bubbleName}
                                </span>
                                <span className="px-2 py-0.5 rounded-full bg-slate-100 border border-slate-200">
                                  Qty {numberFormatter.format(Number(it.quantity) || 0)}
                                </span>
                                {it.warehouse && (
                                  <span className="px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-100">
                                    {it.warehouse}
                                  </span>
                                )}
                              </div>
                              {(it.notes1 || it.notes2) && (
                                <div className="mt-2 text-xs text-slate-500 max-w-xl whitespace-pre-wrap">
                                  {it.notes1 || it.notes2}
                                </div>
                              )}
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3 align-top">
                          <div className="text-slate-700">
                            <div className="font-semibold">
                              Sell: {currencyFormatter.format(Number(it.allocated_for) || 0)}
                            </div>
                            <div className="text-xs text-slate-500">
                              Cost: {currencyFormatter.format(Number(it.cost) || 0)}
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3 align-top">
                          <div className="text-xs text-slate-600 flex flex-col gap-1">
                            <div>Invoice: {it.invoice_num || "—"}</div>
                            <div>Source Inv: {it.source_inv || "—"}</div>
                            <div>Reference: {it.reference_num || "—"}</div>
                            <div>Purchased: {it.date || "—"}</div>
                          </div>
                        </td>
                        <td className="px-4 py-3 align-top">
                          <div className="flex flex-col gap-1 text-xs text-slate-600">
                            <span
                              className={`px-2 py-1 rounded-full text-[11px] font-semibold border inline-flex w-fit ${
                                sold
                                  ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                                  : "bg-amber-50 text-amber-700 border-amber-200"
                              }`}
                            >
                              {sold ? "Marked sold" : "Outstanding"}
                            </span>
                            <span>Sold status: {it.sold_status || "—"}</span>
                            <span>Sold date: {it.sold_date || "—"}</span>
                            <span>Last moved: {dateLabel(it.last_moved_at)}</span>
                          </div>
                        </td>
                        <td className="px-4 py-3 align-top">
                          <div className="flex flex-col gap-2">
                            {onUpdateItem && (
                              <select
                                value={bubbleName}
                                onChange={(e) =>
                                  onUpdateItem(it.uid, {
                                    allocated_to: e.target.value,
                                  })
                                }
                                className="border rounded-xl px-3 py-2 text-sm bg-white"
                              >
                                {bubbleOptions.map((name) => (
                                  <option key={name} value={name}>
                                    Move to: {name}
                                  </option>
                                ))}
                              </select>
                            )}
                            {onEditItem && (
                              <button
                                type="button"
                                onClick={() => onEditItem(it)}
                                className="px-3 py-2 rounded-xl text-sm font-semibold border border-indigo-200 text-indigo-700 bg-white hover:bg-indigo-50"
                              >
                                Edit details
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </Card>
      </section>
    </>
  );
}
