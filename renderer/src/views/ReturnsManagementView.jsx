import React from "react";
import Card from "../components/Card";

const currencyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

const toNumber = (value) => {
  const num = parseFloat(value);
  return Number.isFinite(num) ? num : 0;
};

const parseFlexibleDate = (value) => {
  if (!value) return null;
  const trimmed = String(value).trim();

  // Handle compact DDMMYYYY format (e.g., 09102025 => 09/10/2025)
  const compactMatch = trimmed.match(/^(\d{2})(\d{2})(\d{4})$/);
  if (compactMatch) {
    const [, dd, mm, yyyy] = compactMatch;
    const day = Number(dd);
    const month = Number(mm);
    const year = Number(yyyy);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const fromParts = new Date(year, month - 1, day);
      if (!Number.isNaN(fromParts.getTime())) return fromParts;
    }
  }

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
};

const getDaysSince = (dateString) => {
  const parsed = parseFlexibleDate(dateString);
  if (!parsed) return null;
  const now = new Date();
  const diff = now.getTime() - parsed.getTime();
  return Math.floor(diff / (1000 * 60 * 60 * 24));
};

export default function ReturnsManagementView({ groups = [], onReturnToNewStock }) {
  const hasReturns = groups.length > 0;

  return (
    <>
      <section>
        <Card>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="text-sm uppercase tracking-wide text-slate-400">Returns management</div>
              <div className="text-base font-semibold text-slate-700">
                Items allocated to Returns, grouped by warehouse
              </div>
            </div>
            <div className="text-xs text-slate-500">
              Showing cost and source invoice only for each item.
            </div>
          </div>
        </Card>
      </section>

      <section>
        {hasReturns ? (
          <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
            {groups.map(({ warehouse, items }) => (
              <Card key={warehouse} className="border-indigo-100 bg-white/80">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-lg font-semibold text-slate-800">{warehouse}</div>
                    <div className="text-xs uppercase tracking-wide text-slate-400">Returns bubble</div>
                  </div>
                  <span className="text-xs px-2 py-1 rounded-full bg-indigo-50 text-indigo-700 border border-indigo-100">
                    {items.length} item{items.length === 1 ? "" : "s"}
                  </span>
                </div>

                <div className="mt-3 grid gap-3">
                  {items.map((it) => (
                    (() => {
                      const daysSincePurchase = getDaysSince(it.date);
                      let urgencyClass = "";
                      if (daysSincePurchase !== null) {
                        if (daysSincePurchase >= 31) {
                          urgencyClass =
                            "border-red-600 bg-red-100 shadow-[0_0_0_3px_rgba(220,38,38,0.4)]";
                        } else if (daysSincePurchase >= 20) {
                          urgencyClass =
                            "border-red-400 shadow-[0_12px_30px_rgba(220,38,38,0.35)]";
                        } else if (daysSincePurchase >= 15) {
                          urgencyClass =
                            "border-amber-300 shadow-[0_12px_26px_rgba(234,179,8,0.45)]";
                        }
                      }
                      return (
                        <div
                          key={it.uid}
                          className={`rounded-2xl border border-slate-200 bg-white/70 p-3 shadow-sm ${urgencyClass}`}
                        >
                          <div className="flex items-center justify-between gap-3 text-sm text-slate-700">
                            <span className="font-semibold text-slate-800">
                              {it.itemcode || "Item"}
                            </span>
                            <span className="font-semibold">
                              {currencyFormatter.format(toNumber(it.cost))}
                            </span>
                          </div>
                          <div className="mt-1 flex items-center justify-between text-sm text-slate-700">
                            <span className="text-slate-500">Invoice number</span>
                            <span className="font-semibold text-indigo-700">
                              {it.source_inv || "—"}
                            </span>
                          </div>
                          <div className="flex items-center justify-between text-xs text-slate-600">
                            <span>Date of purchase</span>
                            <span className="font-semibold text-slate-800">
                              {it.date || "—"}
                            </span>
                          </div>
                          <div className="mt-2">
                            <button
                              type="button"
                              className="w-full rounded-full border border-indigo-200 bg-white px-3 py-2 text-xs font-semibold uppercase tracking-wide text-indigo-700 hover:bg-indigo-50"
                              onClick={() => onReturnToNewStock?.(it.uid)}
                            >
                              Return to New Stock
                            </button>
                          </div>
                        </div>
                      );
                    })()
                  ))}
                </div>
              </Card>
            ))}
          </div>
        ) : (
          <Card>
            <div className="py-10 text-center text-slate-500 text-sm">
              No items currently allocated to Returns.
            </div>
          </Card>
        )}
      </section>
    </>
  );
}
