// src/components/BubbleColumn.jsx
import React from "react";
import Card from "./Card";
import LabeledField from "./LabeledField"; 
import LabeledInput from "./LabeledInput"; // adjust path as needed



import { itemKey } from "../utils/inventory";

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

  onFieldFocus,
  onFieldBlur,
  onEditItem,
}) {
  const { id, name, notes } = bubble;
  const list = items || [];

  const countLabel = list.length;

  function allowDrop(e) {
    e.preventDefault();
  }

  return (
    <div
      className="flex flex-col gap-3 rounded-3xl p-4 sm:p-5 border border-slate-300 shadow-xl bg-gradient-to-br from-indigo-50 to-cyan-50 min-w-[280px] max-w-[520px]"
      onDragOver={allowDrop}
      onDrop={() => onDropOnBubble(name)}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded-full bg-indigo-400 animate-pulse" />
          <h2 className="text-xl font-semibold text-slate-800">{name}</h2>
          <span className="text-xs px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-700 border border-indigo-200">
            {countLabel} items
          </span>
        </div>
      </div>

      <textarea
        className="mt-2 w-full rounded-xl border border-slate-300 p-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300"
        placeholder="Bubble notes…"
        value={notes}
        onChange={(e) => onUpdateBubbleNotes(id, e.target.value)}
        onFocus={onFieldFocus}
        onBlur={onFieldBlur}
      />

      <div className="grid grid-cols-1 gap-3">
        {list.map((it) => (
          <Card
            key={itemKey(it)}
            className="bg-white hover:shadow-xl transition-shadow duration-200 cursor-grab"
            draggable
            onDragStart={(e) => {
              e.stopPropagation();
              onDragStartItem(itemKey(it));
            }}
          >
            <div className="flex items-center justify-between">
              <div className="font-semibold text-slate-800">{it.itemcode}</div>
              <div className="text-sm text-slate-500">qty: {it.quantity}</div>
            </div>

            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-600">
              <span className="px-2 py-0.5 rounded-full bg-slate-100 border">
                ref: {it.reference_num}
              </span>
              <span className="px-2 py-0.5 rounded-full bg-slate-100 border">
                date: {it.date}
              </span>
              {it.invoice_num && (
                <span className="px-2 py-0.5 rounded-full bg-slate-100 border">
                  inv: {it.invoice_num}
                </span>
              )}
              <button
                className="ml-auto text-indigo-600 hover:text-indigo-800 font-medium"
                onClick={() => onToggleExpand(itemKey(it))}
              >
                {expanded[itemKey(it)] ? "Collapse" : "Expand"}
              </button>
                
              <button
                onClick={() => onEditItem(it)}
                disabled={it.lock_expires_at && it.lock_expires_at > Date.now()}
                className="text-xs px-2 py-1 rounded-lg bg-sky-600 text-white disabled:bg-gray-300"
                >
                {it.lock_expires_at && it.lock_expires_at > Date.now()
                    ? "Being edited..."
                    : "Edit"}
              </button>
              
            </div>

            {expanded[itemKey(it)] && (
              <div className="mt-3 grid gap-2 text-sm">
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

               



                  <LabeledInput 
                    label="Allocated For (price)"
                    value={it.allocated_for ?? ""}
                    onChange={(e) =>
                      onUpdateItem(itemKey(it), { allocated_for: e.target.value })
                    }
                    onFocus={onFieldFocus}
                    onBlur={onFieldBlur}
                   
                  />

                </div>

                <div className="grid grid-cols-3 gap-2">
                  <LabeledInput 
                      label="Cost"
                      value={it.cost}
                      onChange={(e) =>
                        onUpdateItem(itemKey(it), { cost: e.target.value })
                      }
                      onFocus={onFieldFocus}
                      onBlur={onFieldBlur}
                  />
                
                 
                  
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
               


                  <LabeledInput label="Sold Date"
                          value={it.sold_date}
                          onChange={(e) => onUpdateItem(itemKey(it), {
                              sold_date: e.target.value,
                            })
                          }
                          onFocus={onFieldFocus}
                          onBlur={onFieldBlur}
                          
                  />

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
        ))}
      </div>
    </div>
  );
}
