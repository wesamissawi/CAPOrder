// src/components/BubbleColumn.jsx
import React from "react";
import Card from "./Card";
import LabeledField from "./LabeledField"; 
import LabeledInput from "./LabeledInput"; // adjust path as needed



import { itemKey } from "../utils/inventory";

const currencyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

const toNumber = (value) => {
  const num = parseFloat(value);
  return Number.isFinite(num) ? num : 0;
};

const FALLBACK_DELETE_INFO = [
  "New Stock",
  "Stock",
  "Cash Sales",
  "Returns",
];

export default function BubbleColumn({
  bubble,
  items,
  bubbles,
  expanded,
  onToggleExpand,
  onDragStartItem,
  onDropOnBubble,
  onUpdateItem,
  onUpdateBubbleNotes,
  onSplitItem,
  onConsolidateItems,
  onDeleteBubble,
  deleteTargets = FALLBACK_DELETE_INFO,
  onStartBubbleMove,
  onStartBubbleResize,
  onActivateBubble,
  isDefaultBubble = false,
  widthPixels = 360,

  onFieldFocus,
  onFieldBlur,
  showPrintAction = false,
  onRequestPrint,
}) {
  const { id, name, notes } = bubble;
  const bubbleKey = name || id;
  const list = items || [];
  const [splitDrafts, setSplitDrafts] = React.useState({});
  const allowDelete = !!onDeleteBubble && !isDefaultBubble;
  const deleteOptions = React.useMemo(() => {
    if (!allowDelete) return [];
    const allowed = deleteTargets || [];
    return allowed.filter((option) => option && option !== name);
  }, [allowDelete, deleteTargets, name]);
  const [deleteSelection, setDeleteSelection] = React.useState(
    deleteOptions[0] || ""
  );
  React.useEffect(() => {
    if (deleteOptions.length === 0) {
      setDeleteSelection("");
      return;
    }
    setDeleteSelection((prev) =>
      deleteOptions.includes(prev) ? prev : deleteOptions[0]
    );
  }, [deleteOptions]);

  const countLabel = list.length;
  const bubbleSubtotal = list.reduce((sum, it) => {
    const qty = toNumber(it.quantity);
    const price = toNumber(it.allocated_for);
    return sum + qty * price;
  }, 0);
  const bubbleTax = bubbleSubtotal * 0.13;
  const bubbleTotal = bubbleSubtotal + bubbleTax;
  const showSummary = !isDefaultBubble;

  const updateSplitDraft = (uid, patch) => {
    setSplitDrafts((prev) => {
      const current = prev[uid] || {};
      return {
        ...prev,
        [uid]: {
          quantity: "",
          target: "",
          ...current,
          ...patch,
        },
      };
    });
  };

  const resetSplitDraft = (uid) => {
    setSplitDrafts((prev) => {
      if (!prev[uid]) return prev;
      const next = { ...prev };
      delete next[uid];
      return next;
    });
  };

  function allowDrop(e) {
    e.preventDefault();
  }

  function handleDrop(e) {
    e.preventDefault();
    onDropOnBubble(name);
  }

  function handleGrabBubble(e) {
    e.preventDefault();
    e.stopPropagation();
    const point = "touches" in e ? e.touches[0] : e;
    onStartBubbleMove?.(bubbleKey, point.clientX, point.clientY);
  }

  function handleResizeStart(e) {
    e.preventDefault();
    e.stopPropagation();
    const point = "touches" in e ? e.touches[0] : e;
    onStartBubbleResize?.(bubbleKey, point.clientX);
  }

  function handleActivate(e) {
    onActivateBubble?.(bubbleKey);
  }

  return (
    <div
      className="relative flex flex-col gap-3 rounded-3xl p-4 sm:p-5 border border-slate-300 shadow-xl bg-gradient-to-br from-indigo-50 to-cyan-50 min-w-[280px]"
      onDragOver={allowDrop}
      onDrop={handleDrop}
      onMouseDownCapture={handleActivate}
      onTouchStartCapture={handleActivate}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded-full bg-indigo-400 animate-pulse" />
          <h2 className="text-xl font-semibold text-slate-800">{name}</h2>
          <span className="text-xs px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-700 border border-indigo-200">
            {countLabel} items
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="text-xs font-semibold uppercase tracking-wide px-3 py-1 rounded-full border border-slate-300 text-slate-600 hover:bg-white cursor-move"
            onMouseDown={handleGrabBubble}
            onTouchStart={handleGrabBubble}
            title="Drag bubble"
          >
            ⇕
          </button>
          {showPrintAction && onRequestPrint && (
            <button
              className="text-xs font-semibold uppercase tracking-wide px-3 py-1 rounded-full border border-slate-300 text-slate-700 hover:bg-slate-100"
              onClick={() => onRequestPrint(bubble)}
              title="Print this bubble"
            >
              Print
            </button>
          )}
        </div>
      </div>

      {showSummary && (
        <div className="flex flex-wrap gap-4 text-sm text-slate-700 bg-white/60 border border-indigo-100 rounded-2xl p-3">
          <div className="flex flex-col">
            <span className="text-xs uppercase tracking-wide text-slate-400">
              Subtotal
            </span>
            <span className="font-semibold">{currencyFormatter.format(bubbleSubtotal)}</span>
          </div>
          <div className="flex flex-col">
            <span className="text-xs uppercase tracking-wide text-slate-400">
              Tax (13%)
            </span>
            <span className="font-semibold">{currencyFormatter.format(bubbleTax)}</span>
          </div>
          <div className="flex flex-col">
            <span className="text-xs uppercase tracking-wide text-slate-400">
              Total
            </span>
            <span className="font-semibold text-indigo-700">
              {currencyFormatter.format(bubbleTotal)}
            </span>
          </div>
        </div>
      )}
      {onConsolidateItems || (allowDelete && deleteOptions.length > 0) ? (
        <div className="rounded-2xl border border-slate-200 bg-white/70 p-3 text-sm text-slate-700 flex flex-col gap-3">
          {onConsolidateItems && (
            <button
              type="button"
              className="w-full rounded-lg border border-indigo-200 px-3 py-2 text-indigo-700 font-semibold hover:bg-indigo-50 disabled:opacity-40"
              disabled={!list || list.length === 0}
              onClick={() => onConsolidateItems?.(name)}
            >
              Consolidate duplicate items
            </button>
          )}
          {allowDelete && deleteOptions.length > 0 && (
            <div className="flex flex-col gap-2 text-xs text-amber-900">
              <select
                className="border border-amber-200 rounded-lg bg-white/90 p-2 text-sm text-slate-700"
                value={deleteSelection}
                onChange={(e) => setDeleteSelection(e.target.value)}
              >
                {deleteOptions.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="w-full px-3 py-2 rounded-lg text-sm font-semibold text-white bg-amber-500 hover:bg-amber-600 disabled:opacity-40"
                disabled={!deleteSelection}
                onClick={() => {
                  if (!deleteSelection) return;
                  const confirmed =
                    typeof window === "undefined"
                      ? true
                      : window.confirm(
                          list && list.length > 0
                            ? `Delete "${name}" and move ${list.length} item(s) to ${deleteSelection}?`
                            : `Delete "${name}" bubble?`
                        );
                  if (!confirmed) return;
                  onDeleteBubble?.(id, deleteSelection);
                }}
              >
                {deleteSelection
                  ? `Delete bubble & move items to ${deleteSelection}`
                  : "Delete bubble & move items"}
              </button>
              <p className="text-[11px]">
                Move items manually first if they need different destinations. Any remaining items
                will be reassigned to the selected bubble.
              </p>
            </div>
          )}
        </div>
      ) : null}
      <textarea
        rows={2}
        className="mt-2 w-full rounded-xl border border-slate-300 p-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300"
        placeholder="Bubble notes…"
        value={notes}
        onChange={(e) => onUpdateBubbleNotes(id, e.target.value)}
        onFocus={onFieldFocus}
        onBlur={onFieldBlur}
      />

      <div className="grid grid-cols-1 gap-3">
        {list.map((it) => {
          const uid = itemKey(it);
          const qty = toNumber(it.quantity);
          const salesPrice = toNumber(it.allocated_for);
          const cost = toNumber(it.cost);
          const itemSubtotal = qty * salesPrice;
          const showWarning =
            !["New Stock Returns", "Stock"].includes(name) && cost > salesPrice;
          const splitDraft = splitDrafts[uid] || {};
          const splitAmount = splitDraft.quantity ?? "";
          const splitTarget = splitDraft.target || it.allocated_to;
          const splitDisabled = qty < 2;
          const splitAmountNum = Math.floor(parseFloat(splitAmount));
          const canSplit =
            !splitDisabled &&
            Number.isFinite(splitAmountNum) &&
            splitAmountNum > 0 &&
            splitAmountNum < qty;

          return (
            <Card
              key={uid}
              className={`relative bg-white hover:shadow-xl transition-shadow duration-200 cursor-grab ${
                !["New Stock Returns", "Stock"].includes(name) &&
                toNumber(it.cost) > toNumber(it.allocated_for || 0)
                  ? "border-2 border-red-300 shadow-red-200"
                  : ""
              }`}
              draggable
              onDragStart={(e) => {
                e.stopPropagation();
                onDragStartItem(uid);
              }}
            >
              <div className="flex flex-wrap items-center gap-3">
                <div className="text-base font-semibold text-slate-800">
                  {it.itemcode}
                </div>
                <div className="flex items-center gap-1 text-sm text-slate-600">
                  <span className="font-semibold text-slate-800">x</span>
                  {qty || 0}
                </div>
                <div className="flex items-center gap-1 text-sm text-slate-600">
                  <span className="text-xs font-semibold text-slate-500">$</span>
                  <input
                    type="text"
                    step="0.01"
                    inputMode="decimal"
                    className="w-14 border rounded-lg p-1 text-sm text-center"
                    onFocus={(e) => {
                      e.target.select();
                      onFieldFocus?.(e);
                    }}
                    value={it.allocated_for ?? ""}
                    onChange={(e) =>
                      onUpdateItem(uid, {
                        allocated_for: e.target.value,
                      })
                    }
                    onBlur={onFieldBlur}
                  />
                </div>
                <div className="flex items-center gap-2 ml-auto text-sm font-semibold text-slate-800">
                  <span className={showWarning ? "text-red-500" : "text-slate-400"}>→</span>
                  <span
                    className={`${
                      showWarning ? "text-red-600 bg-red-50 px-2 py-0.5 rounded-lg" : ""
                    }`}
                  >
                    {currencyFormatter.format(itemSubtotal)}
                  </span>
                  {showWarning && (
                    <span
                      className="ml-2 text-[10px] uppercase tracking-wide rounded-full bg-red-100 px-2 py-0.5 text-red-600 border border-red-200"
                      title="Selling price is below recorded cost."
                    >
                      below cost
                    </span>
                  )}
                </div>
              </div>

              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-600">
                {it.invoice_num && (
                  <span className="px-2 py-0.5 rounded-full bg-slate-100 border">
                    inv: {it.invoice_num}
                  </span>
                )}
              </div>
              <button
                type="button"
                className={`absolute left-1/2 bottom-0 flex h-6 w-14 -translate-x-1/2 translate-y-1/2 items-center justify-center rounded-full border border-indigo-200 bg-white text-indigo-600 text-xs font-semibold shadow ${
                  expanded[uid] ? "rotate-180" : ""
                }`}
                title={expanded[uid] ? "Collapse" : "Expand"}
                onClick={() => onToggleExpand(uid)}
              >
                ↓
              </button>

              {expanded[uid] && (
                <div className="mt-3 grid gap-2 text-sm">
                  <div className="flex flex-wrap gap-2 text-xs text-slate-600">
                    <span className="px-2 py-0.5 rounded-full bg-slate-100 border">
                    ref: {it.reference_num || "—"}
                  </span>
                  <span className="px-2 py-0.5 rounded-full bg-slate-100 border">
                    date: {it.date || "—"}
                  </span>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  {/* Allocated To */}
                  <LabeledField label="Allocated To (bubble)">
                  
                    <select
                      className="w-full border rounded-lg p-2 bg-white"
                      value={it.allocated_to}
                      onChange={(e) =>
                        onUpdateItem(itemKey(it), {
                          allocated_to: e.target.value,
                        })
                      }
                      onFocus={onFieldFocus}
                      onBlur={onFieldBlur}
                    >
                      {bubbles.map((b) => (
                        <option key={b.id} value={b.name}>
                          {b.name}
                        </option>
                      ))}
                    </select>
                  
                  </LabeledField>

                  <LabeledField label="Split Quantity & Move">
                    <div className="flex flex-col gap-2">
                      <div className="flex flex-wrap gap-2">
                        <input
                          type="number"
                          min={1}
                          max={Math.max(1, qty - 1)}
                          className="w-24 border rounded-lg p-2 text-sm"
                          value={splitAmount}
                          disabled={splitDisabled}
                          onChange={(e) =>
                            updateSplitDraft(uid, { quantity: e.target.value })
                          }
                          onFocus={onFieldFocus}
                          onBlur={onFieldBlur}
                        />
                        <select
                          className="flex-1 border rounded-lg p-2 bg-white min-w-[140px]"
                          value={splitTarget}
                          disabled={splitDisabled}
                          onChange={(e) =>
                            updateSplitDraft(uid, { target: e.target.value })
                          }
                          onFocus={onFieldFocus}
                          onBlur={onFieldBlur}
                        >
                          {bubbles.map((b) => (
                            <option key={b.id} value={b.name}>
                              {b.name}
                            </option>
                          ))}
                        </select>
                      </div>
                      <button
                        type="button"
                        className="px-3 py-1.5 rounded-lg text-sm font-semibold text-indigo-700 border border-indigo-200 disabled:opacity-50 disabled:cursor-not-allowed hover:bg-indigo-50"
                        disabled={!canSplit}
                        onClick={() => {
                          onSplitItem?.(uid, splitAmount, splitTarget);
                          resetSplitDraft(uid);
                        }}
                      >
                        Split Item
                      </button>
                      {splitDisabled && (
                        <p className="text-xs text-slate-400">
                          Need quantity of at least 2 to split this item.
                        </p>
                      )}
                    </div>
                  </LabeledField>




                </div>

                <div className="grid grid-cols-3 gap-2">
                  <LabeledField label="Cost">
                    <div className="rounded-lg border border-slate-200 bg-slate-50 p-2 text-sm text-slate-700">
                      {it.cost ?? "—"}
                    </div>
                  </LabeledField>

                  <LabeledInput label="Sold Status"
                    
                    value={it.sold_status}
                    onChange={(e) =>
                      onUpdateItem(itemKey(it), {
                        sold_status: e.target.value,
                      })
                    }
                    onFocus={onFieldFocus}
                    onBlur={onFieldBlur}
                  />
               


                  <LabeledField label="Sold Date">
                    <div className="rounded-lg border border-slate-200 bg-slate-50 p-2 text-sm text-slate-700">
                      {it.sold_date ?? "—"}
                    </div>
                  </LabeledField>

                </div>

                <div className="grid grid-cols-2 gap-2">
                  
                  
                  <LabeledField label="Notes 1">
                  
                    <textarea
                      className="w-full border rounded-lg p-2"
                      rows={2}
                      value={it.notes1}
                      onChange={(e) =>
                        onUpdateItem(itemKey(it), { notes1: e.target.value })
                      }
                      onFocus={onFieldFocus}
                      onBlur={onFieldBlur}
                    />
                  
                  </LabeledField>
                  <LabeledField label="Notes 2">
                 
                    <textarea
                      className="w-full border rounded-lg p-2"
                      rows={2}
                      value={it.notes2}
                      onChange={(e) =>
                        onUpdateItem(itemKey(it), { notes2: e.target.value })
                      }
                      onFocus={onFieldFocus}
                      onBlur={onFieldBlur}
                    />

                  
                  </LabeledField>
                </div>
              </div>
            )}
            </Card>
          );
        })}
      </div>
      <button
        type="button"
        className="absolute right-2 bottom-2 w-5 h-5 rounded-full bg-slate-300 text-white text-[10px] flex items-center justify-center cursor-ew-resize shadow"
        onMouseDown={handleResizeStart}
        onTouchStart={handleResizeStart}
        title="Resize bubble width"
      >
        ⇔
      </button>
    </div>
  );
}
