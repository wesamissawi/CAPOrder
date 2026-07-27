import React, { useEffect, useState } from "react";
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

// Aging highlight for a returns part, based on its purchase date.
const urgencyClassFor = (purchaseDate) => {
  const days = getDaysSince(purchaseDate);
  if (days === null) return "";
  if (days >= 31) return "border-red-600 bg-red-100 shadow-[0_0_0_3px_rgba(220,38,38,0.4)]";
  if (days >= 20) return "border-red-400 shadow-[0_12px_30px_rgba(220,38,38,0.35)]";
  if (days >= 15) return "border-amber-300 shadow-[0_12px_26px_rgba(234,179,8,0.45)]";
  return "";
};

// Slip date may be a settable "YYYY-MM-DD" or a legacy ISO timestamp. Parse the
// leading date parts as a LOCAL date so it never drifts a day by timezone.
const slipDateToDate = (raw) => {
  if (!raw) return null;
  const m = String(raw).trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
};

const formatSlipDate = (raw) => {
  const d = slipDateToDate(raw);
  if (!d) return "—";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
};

// Value for an <input type="date"> from either date format.
const toDateInputValue = (raw) => {
  const d = slipDateToDate(raw);
  if (!d) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

// Whole days since the slip's requisition date (never negative).
const daysSinceSlip = (raw) => {
  const d = slipDateToDate(raw);
  if (!d) return null;
  return Math.max(0, Math.floor((Date.now() - d.getTime()) / 86400000));
};

// Purchase date is stored compact (DDMMYYYY) — show it dashed as DD-MM-YYYY.
const formatPurchaseDate = (raw) => {
  if (!raw) return "—";
  const s = String(raw).trim();
  const m = s.match(/^(\d{2})(\d{2})(\d{4})$/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : s;
};

// Quantity (>=1) and line extension (cost × qty) for a part.
const itemQty = (it) => {
  const q = Number(it?.quantity);
  return Number.isFinite(q) && q > 0 ? q : 1;
};
const itemExtension = (it) => toNumber(it?.cost) * itemQty(it);

// Credit we expect back for a slip = sum of line extensions (pre-tax subtotal).
const slipCreditTotal = (items = []) =>
  items.reduce((sum, it) => sum + itemExtension(it), 0);

// PO number as a click-to-edit badge. Collapsed: a badge ("PO 1234" / "Set PO").
// Click → an input + "Set PO" button; committing collapses back to the badge.
function SlipPOField({ value, onCommit }) {
  const [editing, setEditing] = useState(false);
  const [po, setPo] = useState(value || "");
  useEffect(() => {
    setPo(value || "");
  }, [value]);

  if (!editing) {
    return (
      <button
        type="button"
        title="Edit PO number"
        className="text-xs font-semibold px-2 py-1 rounded-full bg-indigo-50 text-indigo-700 border border-indigo-200 hover:bg-indigo-100"
        onClick={() => setEditing(true)}
      >
        {value ? `PO ${value}` : "+ Set PO"}
      </button>
    );
  }

  const commit = () => {
    onCommit(po.trim());
    setEditing(false);
  };
  return (
    <span className="inline-flex items-center gap-1">
      <input
        autoFocus
        className="w-24 rounded-lg border border-slate-200 px-2 py-1 text-sm"
        placeholder="PO #"
        value={po}
        onChange={(e) => setPo(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          else if (e.key === "Escape") setEditing(false);
        }}
      />
      <button
        type="button"
        className="rounded-lg bg-indigo-600 px-2 py-1 text-xs font-semibold text-white hover:bg-indigo-700"
        onClick={commit}
      >
        Set PO
      </button>
    </span>
  );
}

// Requisition date as a click-to-edit badge. Click → a small date picker that
// commits on change and collapses back to the badge on blur.
function SlipDateField({ value, onCommit }) {
  const [editing, setEditing] = useState(false);
  const [d, setD] = useState(toDateInputValue(value));
  useEffect(() => {
    setD(toDateInputValue(value));
  }, [value]);

  if (!editing) {
    return (
      <button
        type="button"
        title="Edit requisition date"
        className="text-xs font-semibold px-2 py-1 rounded-full bg-slate-100 text-slate-600 border border-slate-200 hover:bg-slate-200"
        onClick={() => setEditing(true)}
      >
        {value ? formatSlipDate(value) : "+ Set date"}
      </button>
    );
  }

  return (
    <input
      type="date"
      autoFocus
      className="w-[8.5rem] rounded-lg border border-slate-200 px-2 py-1 text-xs"
      value={d}
      onChange={(e) => {
        setD(e.target.value);
        onCommit(e.target.value);
      }}
      onBlur={() => setEditing(false)}
    />
  );
}

// Shared part row: cost, source invoice, purchase date + a "Return to New
// Stock" action (the only way a part leaves Returns).
//
// In the Unassigned list, while a slip is "selected" a matching-warehouse part
// becomes clickable (assignable) to add it to that slip; a non-matching part is
// dimmed (blocked).
function PartRow({ item, onReturnToNewStock, onRemoveFromSlip, assignable, blocked, onAssign }) {
  const inSlip = typeof onRemoveFromSlip === "function";
  return (
    <div
      className={`relative rounded-2xl border border-slate-200 bg-white/70 px-3 py-2 shadow-sm ${urgencyClassFor(item.date)} ${
        assignable ? "cursor-pointer ring-2 ring-emerald-300 hover:bg-emerald-50" : ""
      } ${blocked ? "opacity-40" : ""}`}
      onClick={assignable ? onAssign : undefined}
      role={assignable ? "button" : undefined}
      title={assignable ? "Click to add to the selected slip" : undefined}
    >
      {inSlip && (
        <button
          type="button"
          title="Remove from slip (back to Unassigned)"
          className="absolute right-1.5 top-1.5 rounded-full border border-slate-200 bg-white px-1.5 text-xs leading-5 text-slate-400 hover:bg-slate-50 hover:text-red-600"
          onClick={(e) => {
            e.stopPropagation();
            onRemoveFromSlip(item.uid);
          }}
        >
          ✕
        </button>
      )}
      <div className={`flex flex-wrap items-center gap-x-3 gap-y-1 text-sm ${inSlip ? "pr-6" : ""}`}>
        <span className="font-bold text-slate-500">{itemQty(item)}×</span>
        <span className="font-bold text-slate-900">{item.itemcode || "Item"}</span>
        <span className="text-lg font-bold text-indigo-700">{item.source_inv || "—"}</span>
        <span className="text-slate-600">{formatPurchaseDate(item.date)}</span>
        <span className="ml-auto text-xs text-slate-500">
          {currencyFormatter.format(toNumber(item.cost))} × {itemQty(item)} ={" "}
          <span className="text-sm font-semibold text-slate-800">
            {currencyFormatter.format(itemExtension(item))}
          </span>
        </span>
      </div>
      {assignable && (
        <div className="mt-1 text-center text-[11px] font-semibold uppercase tracking-wide text-emerald-600">
          Click to add to selected slip
        </div>
      )}
      {!inSlip && (
        <div className="mt-2 flex justify-end">
          <button
            type="button"
            className="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[10px] font-medium text-slate-500 hover:bg-slate-50 hover:text-indigo-700"
            onClick={(e) => {
              e.stopPropagation();
              onReturnToNewStock?.(item.uid);
            }}
          >
            Return to New Stock
          </button>
        </div>
      )}
    </div>
  );
}

export default function ReturnsManagementView({
  unassignedGroups = [],
  slips = [],
  warehouses = [],
  onCreateSlip,
  onAssignItemToSlip,
  onSetSlipPO,
  onSetSlipDate,
  onSetSlipStatus,
  onRemoveItemFromSlip,
  onCreditReceived,
  onDeleteSlip,
  onReturnToNewStock,
}) {
  const [newSlipWarehouse, setNewSlipWarehouse] = useState("");
  // The slip currently "selected" for adding parts. Clicking a matching
  // Unassigned part adds it to this slip. null = normal browsing.
  const [activeSlipId, setActiveSlipId] = useState(null);
  const activeSlip = slips.find((s) => s.id === activeSlipId && s.status !== "waiting") || null;
  // Waiting-on-Credit cards are collapsed to just their header by default.
  const [expandedWaiting, setExpandedWaiting] = useState({});

  const openSlips = slips.filter((s) => s.status !== "waiting");
  const waitingSlips = slips.filter((s) => s.status === "waiting");

  const hasUnassigned = unassignedGroups.length > 0;
  const hasSlips = openSlips.length > 0;

  // Set a slip aside → clear selection if it was the active one.
  const setAside = (slipId) => {
    if (activeSlipId === slipId) setActiveSlipId(null);
    onSetSlipStatus?.(slipId, "waiting");
  };

  const handleCreate = () => {
    const wh = newSlipWarehouse || warehouses[0] || "";
    if (!wh) return;
    onCreateSlip?.(wh);
  };

  return (
    <>
      <section>
        <Card>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <div className="text-sm uppercase tracking-wide text-slate-400">Returns management</div>
              <div className="text-base font-semibold text-slate-700">
                Unassigned returns by warehouse, plus return requisition slips
              </div>
              <div className="text-xs text-slate-500 mt-1">
                A part can only go on a slip for its own warehouse. Parts leave a slip only via
                "Return to New Stock".
              </div>
            </div>
            <div className="flex items-end gap-2">
              <label className="flex flex-col gap-1">
                <span className="text-xs uppercase tracking-wide text-slate-500">Warehouse</span>
                <select
                  className="rounded-xl border border-slate-200 px-3 py-2 text-sm min-w-[10rem]"
                  value={newSlipWarehouse}
                  onChange={(e) => setNewSlipWarehouse(e.target.value)}
                  disabled={!warehouses.length}
                >
                  {!warehouses.length && <option value="">No returns yet</option>}
                  {warehouses.length > 0 && !newSlipWarehouse && (
                    <option value="">Select warehouse…</option>
                  )}
                  {warehouses.map((wh) => (
                    <option key={wh} value={wh}>
                      {wh}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow hover:bg-indigo-700 disabled:opacity-50"
                onClick={handleCreate}
                disabled={!warehouses.length || (!newSlipWarehouse && !warehouses.length)}
              >
                Add Return Slip
              </button>
            </div>
          </div>
        </Card>
      </section>

      {/* Return requisition slips */}
      <section>
        <div className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-400">
          Return requisitions
        </div>
        {hasSlips ? (
          <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
            {openSlips.map((slip) => {
              const isActive = activeSlip?.id === slip.id;
              return (
              <Card
                key={slip.id}
                className={`bg-white/80 transition ${
                  isActive ? "border-emerald-400 ring-2 ring-emerald-400" : "border-emerald-100"
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-lg font-semibold text-slate-800">{slip.warehouse}</div>
                    <div className="text-xs uppercase tracking-wide text-slate-400">Return slip</div>
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      <SlipDateField value={slip.date} onCommit={(d) => onSetSlipDate?.(slip.id, d)} />
                      <SlipPOField value={slip.po} onCommit={(po) => onSetSlipPO?.(slip.id, po)} />
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {slip.items.length > 0 && (
                      <span
                        title="Total expected credit"
                        className="text-xs font-bold px-2 py-1 rounded-full bg-emerald-100 text-emerald-800 border border-emerald-200"
                      >
                        {currencyFormatter.format(slipCreditTotal(slip.items))}
                      </span>
                    )}
                    <span className="text-xs px-2 py-1 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-100">
                      {slip.items.length} item{slip.items.length === 1 ? "" : "s"}
                    </span>
                    {slip.items.length === 0 && (
                      <button
                        type="button"
                        title="Delete empty slip"
                        className="rounded-full border border-slate-200 px-2 py-1 text-xs text-slate-400 hover:bg-slate-50 hover:text-red-600"
                        onClick={() => onDeleteSlip?.(slip.id)}
                      >
                        ✕
                      </button>
                    )}
                  </div>
                </div>

                <div className="mt-3 grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    className={`rounded-full px-3 py-2 text-xs font-semibold uppercase tracking-wide transition ${
                      isActive
                        ? "bg-emerald-600 text-white hover:bg-emerald-700"
                        : "border border-emerald-300 bg-white text-emerald-700 hover:bg-emerald-50"
                    }`}
                    onClick={() => setActiveSlipId(isActive ? null : slip.id)}
                  >
                    {isActive ? "✓ Selecting (done)" : "Select to add parts"}
                  </button>
                  <button
                    type="button"
                    className="rounded-full border border-amber-300 bg-white px-3 py-2 text-xs font-semibold uppercase tracking-wide text-amber-700 hover:bg-amber-50 disabled:opacity-40"
                    onClick={() => setAside(slip.id)}
                    disabled={slip.items.length === 0}
                    title={slip.items.length === 0 ? "Add parts first" : "Move to Waiting on Credit"}
                  >
                    Wait on Credit
                  </button>
                </div>

                <div className="mt-3 grid gap-3">
                  {slip.items.length > 0 ? (
                    slip.items.map((item) => (
                      <PartRow key={item.uid} item={item} onRemoveFromSlip={onRemoveItemFromSlip} />
                    ))
                  ) : (
                    <div className="rounded-2xl border border-dashed border-slate-200 py-6 text-center text-xs text-slate-400">
                      No parts yet — select this slip, then click {slip.warehouse} parts below.
                    </div>
                  )}
                </div>
              </Card>
              );
            })}
          </div>
        ) : (
          <Card>
            <div className="py-6 text-center text-sm text-slate-500">
              No open return slips. Pick a warehouse above and click “Add Return Slip”.
            </div>
          </Card>
        )}
      </section>

      {/* Unassigned returns, grouped by warehouse */}
      <section>
        <div className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-400">
          Unassigned returns
        </div>
        {activeSlip && (
          <div className="mb-3 flex items-center justify-between gap-3 rounded-xl border border-emerald-300 bg-emerald-50 px-4 py-2 text-sm text-emerald-800">
            <span>
              Adding to <strong>{activeSlip.warehouse}</strong> slip
              {activeSlip.po ? ` · PO ${activeSlip.po}` : ""} — click a {activeSlip.warehouse} part
              below.
            </span>
            <button
              type="button"
              className="rounded-full border border-emerald-300 bg-white px-3 py-1 text-xs font-semibold text-emerald-700 hover:bg-emerald-100"
              onClick={() => setActiveSlipId(null)}
            >
              Done
            </button>
          </div>
        )}
        {hasUnassigned ? (
          <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
            {unassignedGroups.map(({ warehouse, items }) => {
              const assignableGroup = activeSlip && activeSlip.warehouse === warehouse;
              const blockedGroup = activeSlip && activeSlip.warehouse !== warehouse;
              return (
                <Card key={warehouse} className="border-indigo-100 bg-white/80">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-lg font-semibold text-slate-800">{warehouse}</div>
                      <div className="text-xs uppercase tracking-wide text-slate-400">
                        Unassigned returns
                      </div>
                    </div>
                    <span className="text-xs px-2 py-1 rounded-full bg-indigo-50 text-indigo-700 border border-indigo-100">
                      {items.length} item{items.length === 1 ? "" : "s"}
                    </span>
                  </div>

                  <div className="mt-3 grid gap-3">
                    {items.map((item) => (
                      <PartRow
                        key={item.uid}
                        item={item}
                        onReturnToNewStock={onReturnToNewStock}
                        assignable={assignableGroup}
                        blocked={blockedGroup}
                        onAssign={
                          assignableGroup
                            ? () => onAssignItemToSlip?.(item.uid, activeSlip)
                            : undefined
                        }
                      />
                    ))}
                  </div>
                </Card>
              );
            })}
          </div>
        ) : (
          <Card>
            <div className="py-10 text-center text-slate-500 text-sm">
              No unassigned items in Returns.
            </div>
          </Card>
        )}
      </section>

      {/* Waiting on Credit — set-aside slips, collapsed to the header by default */}
      {waitingSlips.length > 0 && (
        <section>
          <div className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-400">
            Waiting on Credit
          </div>
          <div className="flex flex-col gap-3 max-w-2xl">
            {waitingSlips.map((slip) => {
              const days = daysSinceSlip(slip.date);
              const expanded = !!expandedWaiting[slip.id];
              return (
                <Card key={slip.id} className="border-amber-200 bg-amber-50/40">
                  <button
                    type="button"
                    className="flex w-full items-start justify-between gap-3 text-left"
                    onClick={() =>
                      setExpandedWaiting((p) => ({ ...p, [slip.id]: !p[slip.id] }))
                    }
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-lg font-semibold text-slate-800">{slip.warehouse}</div>
                      <div className="mt-1 flex flex-wrap items-center gap-2">
                        <span className="text-xs font-semibold px-2 py-1 rounded-full bg-slate-100 text-slate-600 border border-slate-200">
                          {formatSlipDate(slip.date)}
                        </span>
                        {slip.po && (
                          <span className="text-xs font-semibold px-2 py-1 rounded-full bg-indigo-50 text-indigo-700 border border-indigo-200">
                            PO {slip.po}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {slip.items.length > 0 && (
                        <span
                          title="Total expected credit"
                          className="text-xs font-bold px-2 py-1 rounded-full bg-emerald-100 text-emerald-800 border border-emerald-200"
                        >
                          {currencyFormatter.format(slipCreditTotal(slip.items))}
                        </span>
                      )}
                      {days !== null && (
                        <span
                          title="Days waiting since the requisition date"
                          className={`text-xs font-semibold px-2 py-1 rounded-full border ${
                            days >= 30
                              ? "bg-red-100 text-red-700 border-red-200"
                              : days >= 14
                              ? "bg-amber-100 text-amber-700 border-amber-200"
                              : "bg-slate-100 text-slate-600 border-slate-200"
                          }`}
                        >
                          {days}d waiting
                        </span>
                      )}
                      <span className="text-slate-400">{expanded ? "▾" : "▸"}</span>
                    </div>
                  </button>

                  {expanded && (
                    <>
                      <div className="mt-3 grid gap-3">
                        {slip.items.map((item) => (
                          <PartRow
                            key={item.uid}
                            item={item}
                            onRemoveFromSlip={onRemoveItemFromSlip}
                          />
                        ))}
                      </div>
                      <div className="mt-3 flex justify-end gap-2">
                        <button
                          type="button"
                          className="rounded-full border border-slate-300 bg-white px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-600 hover:bg-slate-50"
                          onClick={() => onSetSlipStatus?.(slip.id, "open")}
                        >
                          Reopen
                        </button>
                        <button
                          type="button"
                          className="rounded-full bg-emerald-600 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-white hover:bg-emerald-700"
                          onClick={() => onCreditReceived?.(slip.id)}
                        >
                          Credit received
                        </button>
                      </div>
                    </>
                  )}
                </Card>
              );
            })}
          </div>
        </section>
      )}
    </>
  );
}
