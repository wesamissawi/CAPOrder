import React, { useEffect, useMemo, useRef, useState } from "react";

// Safe API alias so the UI doesn’t crash if opened in a normal browser
const api = window.api ?? {
  readItems: async () => [],
  writeItems: async () => ({ ok: true }),
  exportItems: async () => ({ ok: true }),
  onItemsUpdated: () => () => {},
  getDataPath: async () => ({ path: "(not in Electron)" }),
  revealDataFile: async () => ({ ok: false }),
  chooseItemsFile: async () => ({ ok: false }),
  useDefaultFile: async () => ({ ok: false }),
};

// === Helpers ===
function mergeItems(prev, incoming) {
  const byUid = new Map(prev.map((it) => [it.uid, it]));
  const result = [];

  for (const incomingItem of incoming) {
    const existing = byUid.get(incomingItem.uid);
    if (!existing) {
      // brand new item → add it
      result.push(incomingItem);
      continue;
    }

    // If equal, keep the existing object to avoid remounts
    const same = JSON.stringify(existing) === JSON.stringify(incomingItem);
    if (same) {
      result.push(existing);
    } else {
      // changed on disk → use incoming version
      result.push(incomingItem);
    }

    byUid.delete(incomingItem.uid);
  }

  // Any remaining in byUid were deleted from disk → drop them
  return result;
}

function makeUid() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return "u_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}
const itemKey = (it) => it.uid;

const DEFAULT_BUBBLES = [
  { id: "new", name: "New Stock", notes: "" },
  { id: "cash", name: "Cash Sales", notes: "" },
  { id: "shelf", name: "Shelf", notes: "" },
  { id: "returns", name: "Returns", notes: "" },
];

function uniqueName(baseName, existingNames) {
  if (!existingNames.has(baseName)) return baseName;
  let i = 2;
  while (existingNames.has(`${baseName}${i}`)) i++;
  return `${baseName}${i}`;
}

function normalizeItems(arr) {
  return (arr || []).map((raw) => {
    const it = { ...raw };
    it.uid = it.uid || it.id || makeUid();
    const allocatedToRaw =
      it.allocated_to && it.allocated_to !== "" ? it.allocated_to : "New Stock";
    const allocatedTo =
      allocatedToRaw === "Stock" ? "Shelf" : allocatedToRaw;
    return {
      uid: it.uid,
      allocated_for: it.allocated_for ?? "",
      allocated_to: allocatedTo,
      cost: String(it.cost ?? ""),
      date: String(it.date ?? ""),
      invoice_num: String(it.invoice_num ?? ""),
      ["invoiced date"]: String(it["invoiced date"] ?? ""),
      ["invoiced status"]: String(it["invoiced status"] ?? ""),
      itemcode: String(it.itemcode ?? ""),
      notes1: it.notes1 ?? "",
      notes2: it.notes2 ?? "",
      quantity:
        typeof it.quantity === "number"
          ? it.quantity
          : parseInt(it.quantity || 0, 10) || 0,
      reference_num: String(it.reference_num ?? ""),
      sold_date: String(it.sold_date ?? ""),
      sold_status: String(it.sold_status ?? ""),
    };
  });
}

function ensureBubblesForItems(items, setBubblesFn) {
  setBubblesFn((prev) => {
    const known = new Set(prev.map((b) => b.name));
    const extra = [];

    for (const it of items) {
      const name = it.allocated_to && it.allocated_to.trim();
      if (name && !known.has(name)) {
        known.add(name);
        extra.push({ id: makeUid(), name, notes: "" });
      }
    }

    if (extra.length === 0) return prev;   // nothing new to add
    return [...prev, ...extra];
  });
}


const Card = ({ children, className = "", ...rest }) => (
  <div
    className={
      "rounded-2xl shadow-lg p-3 sm:p-4 bg-white/90 backdrop-blur border border-slate-200 " +
      className
    }
    {...rest}
  >
    {children}
  </div>
);


export default function App() {
  const [bubbles, setBubbles] = useState(DEFAULT_BUBBLES);
  const [items, setItems] = useState([]);
  const [expanded, setExpanded] = useState({});
  const [newBubbleName, setNewBubbleName] = useState("");

// NEW: local edit buffer for allocated_for
  const [editingAllocatedFor, setEditingAllocatedFor] = useState({});

  // Drag state (ITEMS ONLY)
  const draggedItemUidRef = useRef(null);

  // Anti save/watch loop
  const lastSavedRef = useRef("");
  const skipNextSaveRef = useRef(false);

  const isEditingAllocatedForRef = useRef(false);


  // ==== Load once & subscribe ====
  useEffect(() => {
    api.readItems().then((arr) => {
      const norm = normalizeItems(arr || []);
      console.log("[init] readItems ->", norm);
      setItems(norm);
      lastSavedRef.current = JSON.stringify(norm);
      // ⬇️ make sure bubbles exist for all allocated_to values
      ensureBubblesForItems(norm, setBubbles);
    });

    // const off = api.onItemsUpdated((arr) => {
    //   skipNextSaveRef.current = true;
    //   const norm = normalizeItems(arr || []);
    //   console.log("[ipc] items:updated ->", norm);
    //   setItems(norm);
    //   lastSavedRef.current = JSON.stringify(norm);
    //   // ⬇️ also ensure bubbles for new/changed items
    //   ensureBubblesForItems(norm, setBubbles);
    // });
    const off = api.onItemsUpdated((arr) => {
        if (isEditingAllocatedForRef.current) {
            console.log("[ipc] items:updated ignored (user is editing)");
            return;
        }

        
        const norm = normalizeItems(arr || []);
        setItems((prev) => {
            const merged = mergeItems(prev, norm);
            lastSavedRef.current = JSON.stringify(merged);
            ensureBubblesForItems(merged, setBubbles);
            return merged;
        });
    });


    return () => off && off();
  }, []);

//   // ==== Debounced save, no loops ====
//   useEffect(() => {
//     const id = setTimeout(() => {
//       if (skipNextSaveRef.current) {
//         skipNextSaveRef.current = false;
//         return;
//       }
//       const current = JSON.stringify(items);
//       if (current === lastSavedRef.current) return;
//       lastSavedRef.current = current;
//       console.log("[save] writing items to disk", items);
//       api.writeItems(items);
//     }, 300);
//     return () => clearTimeout(id);
//   }, [items]);

// ==== Autosave after 10s of inactivity ====
useEffect(() => {
  // If nothing in items, nothing to save
  if (!items) return;

  const id = setTimeout(() => {
    if (skipNextSaveRef.current) {
      skipNextSaveRef.current = false;
      return;
    }
    const current = JSON.stringify(items);
    if (current === lastSavedRef.current) return;
    lastSavedRef.current = current;
    console.log("[autosave] writing items to disk after idle", items);
    api.writeItems(items);
  }, 10000); // 10 seconds of no changes

  return () => clearTimeout(id); // reset timer on every items change
}, [items]);


  // ==== Helpers ====
  function updateItemByKey(uid, patch) {
    setItems((prev) => prev.map((it) => (it.uid === uid ? { ...it, ...patch } : it)));
  }

  function toggleExpand(uid) {
    setExpanded((p) => ({ ...p, [uid]: !p[uid] }));
  }


    function getAllocatedForDisplay(it) {
        // If we’re editing this item, show the draft; otherwise the saved value
        if (editingAllocatedFor[it.uid] !== undefined) {
        return editingAllocatedFor[it.uid];
        }
        return it.allocated_for ?? "";
    }

  function handleAllocatedForChange(uid, value) {
    setEditingAllocatedFor((prev) => ({
      ...prev,
      [uid]: value,
    }));
  }

//   function handleAllocatedForBlur(it) {
//     const draft = editingAllocatedFor[it.uid];
//     const raw = draft !== undefined ? draft : it.allocated_for;
//     const normalized = raw == null ? "" : String(raw).trim();

//     // Clear the draft buffer for this item
//     setEditingAllocatedFor((prev) => {
//       const { [it.uid]: _ignored, ...rest } = prev;
//       return rest;
//     });

//     // Only touch items if something actually changed
//     if (normalized !== (it.allocated_for ?? "")) {
//       updateItemByKey(it.uid, { allocated_for: normalized });
//     }
//   }

function handleAllocatedForBlur(it) {
  const draft = editingAllocatedFor[it.uid];
  const raw = draft !== undefined ? draft : it.allocated_for;
  const normalized = raw == null ? "" : String(raw).trim();

  setEditingAllocatedFor((prev) => {
    const { [it.uid]: _ignored, ...rest } = prev;
    return rest;
  });

  if (normalized !== (it.allocated_for ?? "")) {
    const uid = it.uid;
    // Update items in React state
    setItems((prev) => {
      const next = prev.map((item) =>
        item.uid === uid ? { ...item, allocated_for: normalized } : item
      );
      // Immediately persist this change
      lastSavedRef.current = JSON.stringify(next);
      api.writeItems(next);
      return next;
    });
  }
}




  function addBubble() {
    const base = newBubbleName.trim() || "New Bubble";
    const names = new Set(bubbles.map((b) => b.name));
    const finalName = uniqueName(base, names);
    const nb = { id: makeUid(), name: finalName, notes: "" };
    setBubbles((p) => [...p, nb]);
    setNewBubbleName("");
  }

  function updateBubbleNotes(id, notes) {
    setBubbles((prev) => prev.map((b) => (b.id === id ? { ...b, notes } : b)));
  }

  const itemsByBubble = useMemo(() => {
    const map = new Map();
    bubbles.forEach((b) => map.set(b.name, []));
    for (const it of items) {
      const target = map.has(it.allocated_to) ? it.allocated_to : "New Stock";
      if (!map.has(target)) map.set(target, []);
      map.get(target).push(it);
    }
    return map;
  }, [items, bubbles]);

  // ==== Drag & drop: ITEMS ONLY ====
  function onDragStartItem(uid) {
    console.log("[drag] start item", uid);
    draggedItemUidRef.current = uid;
  }

  function allowDrop(e) {
    e.preventDefault();
  }

  function onDropOnBubble(targetBubbleName) {
    const uid = draggedItemUidRef.current;
    console.log("[drop] on bubble", targetBubbleName, "item uid:", uid);
    draggedItemUidRef.current = null;
    if (!uid) return;
    updateItemByKey(uid, { allocated_to: targetBubbleName });
  }

  async function handleExport() {
    await api.exportItems(items);
  }

  const countLabel = (name) => itemsByBubble.get(name)?.length || 0;

  // ==== Bubble component (no bubble drag) ====
  function Bubble({ bubble }) {
    const { id, name, notes } = bubble;
    const list = itemsByBubble.get(name) || [];

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
              {countLabel(name)} items
            </span>
          </div>
        </div>

        <textarea
          className="mt-2 w-full rounded-xl border border-slate-300 p-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300"
          placeholder="Bubble notes…"
          value={notes}
          onChange={(e) => updateBubbleNotes(id, e.target.value)}
        />

        <div className="grid grid-cols-1 gap-3">
          {list.map((it) => (
            <Card
              key={itemKey(it)}
              className="bg-white hover:shadow-xl transition-shadow duration-200 cursor-grab"
              draggable
              onDragStart={(e) => {
                // Make sure the drag is for this card, not something else
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
                  onClick={() => toggleExpand(itemKey(it))}
                >
                  {expanded[itemKey(it)] ? "Collapse" : "Expand"}
                </button>
              </div>

              {expanded[itemKey(it)] && (
                <div className="mt-3 grid gap-2 text-sm">
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                        <label className="block text-xs text-slate-500">Allocated To (bubble)</label>
                        <select
                            className="w-full border rounded-lg p-2 bg-white"
                            value={it.allocated_to}
                            onChange={(e) =>
                            updateItemByKey(itemKey(it), { allocated_to: e.target.value })
                            }
                        >
                            {bubbles.map((b) => (
                            <option key={b.id} value={b.name}>
                                {b.name}
                            </option>
                            ))}
                        </select>
                        </div>

                   <div>
                    <label className="block text-xs text-slate-500">Allocated For (price)</label>
                    <input
                        className="w-full border rounded-lg p-2"
                        value={getAllocatedForDisplay(it)}
                        onFocus={() => {
                        isEditingAllocatedForRef.current = true;
                        }}
                        onChange={(e) => handleAllocatedForChange(it.uid, e.target.value)}
                        onBlur={() => {
                        isEditingAllocatedForRef.current = false;
                        handleAllocatedForBlur(it);
                        }}
                    />
                    </div>


                  </div>

                  <div className="grid grid-cols-3 gap-2">
                    <div>
                      <label className="block text-xs text-slate-500">Cost</label>
                      <input
                        className="w-full border rounded-lg p-2"
                        value={it.cost}
                        onChange={(e) =>
                          updateItemByKey(itemKey(it), { cost: e.target.value })
                        }
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-slate-500">
                        Sold Status
                      </label>
                      <input
                        className="w-full border rounded-lg p-2"
                        value={it.sold_status}
                        onChange={(e) =>
                          updateItemByKey(itemKey(it), {
                            sold_status: e.target.value,
                          })
                        }
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-slate-500">
                        Sold Date
                      </label>
                      <input
                        className="w-full border rounded-lg p-2"
                        value={it.sold_date}
                        onChange={(e) =>
                          updateItemByKey(itemKey(it), {
                            sold_date: e.target.value,
                          })
                        }
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="block text-xs text-slate-500">Notes 1</label>
                      <textarea
                        className="w-full border rounded-lg p-2"
                        rows={2}
                        value={it.notes1}
                        onChange={(e) =>
                          updateItemByKey(itemKey(it), { notes1: e.target.value })
                        }
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-slate-500">Notes 2</label>
                      <textarea
                        className="w-full border rounded-lg p-2"
                        rows={2}
                        value={it.notes2}
                        onChange={(e) =>
                          updateItemByKey(itemKey(it), { notes2: e.target.value })
                        }
                      />
                    </div>
                  </div>
                </div>
              )}
            </Card>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen w-full bg-gradient-to-br from-fuchsia-100 via-sky-100 to-emerald-100">
      <div className="max-w-7xl mx-auto p-4 sm:p-6 lg:p-8">
        <header className="flex flex-col sm:flex-row gap-3 sm:items-center sm:justify-between">
          <h1 className="text-2xl sm:text-3xl font-bold text-slate-800">
            Inventory Bubbles — Drag & Drop
          </h1>
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={handleExport}
              className="text-sm px-3 py-2 rounded-xl bg-indigo-600 text-white shadow hover:bg-indigo-700"
            >
              Export updated JSON
            </button>
            <button
              onClick={async () => {
                const { path } = await api.getDataPath();
                alert(`Current data file:\n${path}`);
              }}
              className="text-sm px-3 py-2 rounded-xl bg-white border shadow-sm"
            >
              Show Data File Path
            </button>
            <button
              onClick={() => api.revealDataFile()}
              className="text-sm px-3 py-2 rounded-xl bg-white border shadow-sm"
            >
              Reveal Data File
            </button>
            <button
              onClick={async () => {
                const res = await api.chooseItemsFile();
                if (res?.ok) {
                  const arr = await api.readItems();
                  const norm = normalizeItems(arr || []);
                  setItems(norm);
                  lastSavedRef.current = JSON.stringify(norm);
                }
              }}
              className="text-sm px-3 py-2 rounded-xl bg-emerald-600 text-white shadow hover:bg-emerald-700"
            >
              Choose Items JSON…
            </button>
            <button
              onClick={async () => {
                const res = await api.useDefaultFile?.();
                if (res?.ok) {
                  const arr = await api.readItems();
                  const norm = normalizeItems(arr || []);
                  setItems(norm);
                  lastSavedRef.current = JSON.stringify(norm);
                }
              }}
              className="text-sm px-3 py-2 rounded-xl bg-white border shadow-sm"
            >
              Use Default File
            </button>
          </div>
        </header>

        <section className="mt-4">
          <Card>
            <div className="flex flex-col lg:flex-row gap-3 lg:items-center">
              <div className="flex-1">
                <div className="text-slate-700">Create a new bubble</div>
                <div className="mt-2 flex items-center gap-2">
                  <input
                    className="flex-1 border rounded-xl p-2"
                    placeholder="e.g., Waiting on Customer"
                    value={newBubbleName}
                    onChange={(e) => setNewBubbleName(e.target.value)}
                  />
                  <button
                    onClick={addBubble}
                    className="px-4 py-2 rounded-xl bg-emerald-600 text-white shadow hover:bg-emerald-700"
                  >
                    Add Bubble
                  </button>
                </div>
                <p className="mt-2 text-xs text-slate-500">
                  If a bubble name already exists, a numeric suffix (e.g., “2”) will be
                  added automatically.
                </p>
              </div>
              <div className="text-sm text-slate-600">
                <div>Tip: Drag an item card into a bubble to reassign it.</div>
              </div>
            </div>
          </Card>
        </section>

        <section className="mt-6 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {bubbles.map((b) => (
            <Bubble key={b.id} bubble={b} />
          ))}
        </section>
      </div>
    </div>
  );
}
