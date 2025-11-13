import React, { useEffect, useMemo, useRef, useState } from "react";

// === Prototype: Drag-and-drop inventory bubble board ===
// - Load items from a JSON file (same shape as your outstanding_items.json entries)
// - Default bubbles: New Stock, Cash Sales, Stock, Returns
// - Items start in New Stock if allocated_to is blank
// - Drag items into bubbles; allocated_to updates automatically
// - Create new bubbles (auto-suffix if name exists)
// - Edit allocated_for, notes1, notes2 per item; collapsible item cards
// - Drag a whole bubble onto Cash Sales or Returns to reallocate ALL items in that bubble
// - Export the updated items as JSON (download)
//
// No external libs required. Styling uses Tailwind (auto-injected by ChatGPT preview env).





const api = window.api ?? {
  readItems: async () => [],
  writeItems: async () => ({ ok: true }),
  exportItems: async () => ({ ok: true }),
  onItemsUpdated: () => () => {},
  getDataPath: async () => ({ path: '(not in Electron)' }),
  revealDataFile: async () => ({ ok: false }),
  chooseItemsFile: async () => ({ ok: false }),
  useDefaultFile: async () => ({ ok: false }),
};







const DEFAULT_BUBBLES = [
  { id: "new", name: "New Stock", notes: "" },
  { id: "cash", name: "Cash Sales", notes: "" },
  { id: "stock", name: "Stock", notes: "" },
  { id: "returns", name: "Returns", notes: "" },
];

function uniqueName(baseName, existingNames) {
  if (!existingNames.has(baseName)) return baseName;
  let i = 2;
  while (existingNames.has(`${baseName}${i}`)) i++;
  return `${baseName}${i}`;
}

// function downloadFile(filename, text) {
//   const blob = new Blob([text], { type: "application/json;charset=utf-8" });
//   const url = URL.createObjectURL(blob);
//   const a = document.createElement("a");
//   a.href = url;
//   a.download = filename;
//   a.click();
//   URL.revokeObjectURL(url);
// }

const Card = ({ children, className = "" }) => (
  <div className={
    "rounded-2xl shadow-lg p-3 sm:p-4 bg-white/90 backdrop-blur border " +
    "border-slate-200 " + className
  }>
    {children}
  </div>
);

export default function App() {
  const [bubbles, setBubbles] = useState(DEFAULT_BUBBLES);
  const [items, setItems] = useState([]); // array of item objects
  const [expanded, setExpanded] = useState({}); // id -> bool
  const [newBubbleName, setNewBubbleName] = useState("");
  const dragTypeRef = useRef(null); // "item" | "bubble"
  const draggedIdRef = useRef(null); // itemcode or bubble id

//   useEffect(() => {
//   // Load items from disk when the app starts
//   window.api.readItems().then((arr) => {
//     setItems(normalizeItems(arr || []));
//   });

//   // OPTIONAL: Live-reload items if the file is edited externally
//   const off = window.api.onItemsUpdated((arr) => {
//     setItems(normalizeItems(arr || []));
//   });
//   return () => off && off();
// }, []);

// // Debounced save whenever items change
// useEffect(() => {
//   const id = setTimeout(() => {
//     window.api.writeItems(items);
//   }, 400);
//   return () => clearTimeout(id);
// }, [items]);

useEffect(() => {
  api.readItems().then(arr => setItems(normalizeItems(arr || [])));
  const off = api.onItemsUpdated(arr => setItems(normalizeItems(arr || [])));
  return () => off && off();
}, []);

useEffect(() => {
  const id = setTimeout(() => { api.writeItems(items); }, 400);
  return () => clearTimeout(id);
}, [items]);


function handleExport() {
  // if you want a manual export that downloads a copy in the UI
  window.api.exportItems(items); // Electron will show a “Save As…” dialog
}


  // Ensure every loaded item has allocated_to; default to "New Stock"
  function normalizeItems(arr) {
    return (arr || []).map((it) => ({
      allocated_for: it.allocated_for ?? "",
      alocated_to: it.alocated_to && it.alocated_to !== "" ? it.alocated_to : "New Stock",
      cost: String(it.cost ?? ""),
      date: String(it.date ?? ""),
      invoice_num: String(it.invoice_num ?? ""),
      ["invoiced date"]: String(it["invoiced date"] ?? ""),
      ["invoiced status"]: String(it["invoiced status"] ?? ""),
      itemcode: String(it.itemcode ?? ""),
      notes1: it.notes1 ?? "",
      notes2: it.notes2 ?? "",
      quantity: typeof it.quantity === "number" ? it.quantity : parseInt(it.quantity || 0, 10) || 0,
      reference_num: String(it.reference_num ?? ""),
      sold_date: String(it.sold_date ?? ""),
      sold_status: String(it.sold_status ?? ""),
    }));
  }

  // Group items by bubble name
  const itemsByBubble = useMemo(() => {
    const map = new Map();
    bubbles.forEach((b) => map.set(b.name, []));
    for (const it of items) {
      const target = map.has(it.alocated_to) ? it.alocated_to : "New Stock";
      if (!map.has(target)) map.set(target, []);
      map.get(target).push(it);
    }
    return map;
  }, [items, bubbles]);

  // // Import JSON handler
  // function handleImport(e) {
  //   const file = e.target.files?.[0];
  //   if (!file) return;
  //   const reader = new FileReader();
  //   reader.onload = () => {
  //     try {
  //       const arr = JSON.parse(String(reader.result));
  //       if (!Array.isArray(arr)) throw new Error("JSON must be an array of items");
  //       const norm = normalizeItems(arr);
  //       setItems(norm);
  //     } catch (err) {
  //       alert("Failed to parse JSON: " + err.message);
  //     }
  //   };
  //   reader.readAsText(file);
  // }

  // // Export current items
  // function handleExport() {
  //   downloadFile("outstanding_items.updated.json", JSON.stringify(items, null, 2));
  // }

  // Add bubble
  function addBubble() {
    const base = newBubbleName.trim() || "New Bubble";
    const names = new Set(bubbles.map((b) => b.name));
    const finalName = uniqueName(base, names);
    const nb = { id: Math.random().toString(36).slice(2), name: finalName, notes: "" };
    setBubbles((p) => [...p, nb]);
    setNewBubbleName("");
  }

  // Edit bubble notes
  function updateBubbleNotes(id, notes) {
    setBubbles((prev) => prev.map((b) => (b.id === id ? { ...b, notes } : b)));
  }

  // Item editing
  function updateItem(itemcode, patch) {
    setItems((prev) => prev.map((it) => (it.itemcode === itemcode ? { ...it, ...patch } : it)));
  }

  // Drag start (items)
  function onDragStartItem(itemcode) {
    dragTypeRef.current = "item";
    draggedIdRef.current = itemcode;
  }

  // Drag start (bubbles)
  function onDragStartBubble(bubbleId) {
    dragTypeRef.current = "bubble";
    draggedIdRef.current = bubbleId;
  }

  // Drop on bubble
  function onDropOnBubble(targetBubbleName) {
    const type = dragTypeRef.current;
    const id = draggedIdRef.current;
    dragTypeRef.current = null;
    draggedIdRef.current = null;

    if (!type || !id) return;

    if (type === "item") {
      // move single item
      updateItem(id, { alocated_to: targetBubbleName });
    } else if (type === "bubble") {
      // reallocate ALL items in dragged bubble into target bubble
      const draggedBubble = bubbles.find((b) => b.id === id);
      if (!draggedBubble) return;
      const srcName = draggedBubble.name;
      if (srcName === targetBubbleName) return;
      setItems((prev) => prev.map((it) => (it.alocated_to === srcName ? { ...it, alocated_to: targetBubbleName } : it)));
    }
  }

  // Visual helper for drag over
  function allowDrop(e) {
    e.preventDefault();
  }

  // Toggle item expand
  function toggleExpand(itemcode) {
    setExpanded((p) => ({ ...p, [itemcode]: !p[itemcode] }));
  }

  // Pretty bubble count label
  function countLabel(name) {
    return itemsByBubble.get(name)?.length || 0;
  }

  // Bubble component
  function Bubble({ bubble }) {
    const { id, name, notes } = bubble;
    const list = itemsByBubble.get(name) || [];

    return (
      <div
        className="flex flex-col gap-3 rounded-3xl p-4 sm:p-5 border border-slate-300 shadow-xl bg-gradient-to-br from-indigo-50 to-cyan-50 min-w-[280px] max-w-[520px]"
        onDragOver={allowDrop}
        onDrop={() => onDropOnBubble(name)}
        draggable
        onDragStart={() => onDragStartBubble(id)}
        title="Drag this bubble onto another to reallocate all its items"
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
              key={it.itemcode + "@" + it.reference_num}
              className="bg-white hover:shadow-xl transition-shadow duration-200 cursor-grab"
              draggable
              onDragStart={() => onDragStartItem(it.itemcode)}
            >
              <div className="flex items-center justify-between">
                <div className="font-semibold text-slate-800">{it.itemcode}</div>
                <div className="text-sm text-slate-500">qty: {it.quantity}</div>
              </div>

              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-600">
                <span className="px-2 py-0.5 rounded-full bg-slate-100 border">ref: {it.reference_num}</span>
                <span className="px-2 py-0.5 rounded-full bg-slate-100 border">date: {it.date}</span>
                {it.invoice_num && (
                  <span className="px-2 py-0.5 rounded-full bg-slate-100 border">inv: {it.invoice_num}</span>
                )}
                <button
                  className="ml-auto text-indigo-600 hover:text-indigo-800 font-medium"
                  onClick={() => toggleExpand(it.itemcode)}
                >
                  {expanded[it.itemcode] ? "Collapse" : "Expand"}
                </button>
              </div>

              {expanded[it.itemcode] && (
                <div className="mt-3 grid gap-2 text-sm">
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="block text-xs text-slate-500">Allocated To (bubble)</label>
                      <input
                        className="w-full border rounded-lg p-2"
                        value={it.alocated_to}
                        onChange={(e) => updateItem(it.itemcode, { alocated_to: e.target.value })}
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-slate-500">Allocated For (price)</label>
                      <input
                        className="w-full border rounded-lg p-2"
                        value={it.allocated_for}
                        onChange={(e) => updateItem(it.itemcode, { allocated_for: e.target.value })}
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-3 gap-2">
                    <div>
                      <label className="block text-xs text-slate-500">Cost</label>
                      <input
                        className="w-full border rounded-lg p-2"
                        value={it.cost}
                        onChange={(e) => updateItem(it.itemcode, { cost: e.target.value })}
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-slate-500">Sold Status</label>
                      <input
                        className="w-full border rounded-lg p-2"
                        value={it.sold_status}
                        onChange={(e) => updateItem(it.itemcode, { sold_status: e.target.value })}
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-slate-500">Sold Date</label>
                      <input
                        className="w-full border rounded-lg p-2"
                        value={it.sold_date}
                        onChange={(e) => updateItem(it.itemcode, { sold_date: e.target.value })}
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
                        onChange={(e) => updateItem(it.itemcode, { notes1: e.target.value })}
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-slate-500">Notes 2</label>
                      <textarea
                        className="w-full border rounded-lg p-2"
                        rows={2}
                        value={it.notes2}
                        onChange={(e) => updateItem(it.itemcode, { notes2: e.target.value })}
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
          <h1 className="text-2xl sm:text-3xl font-bold text-slate-800">Inventory Bubbles — Drag & Drop</h1>
          <div className="flex flex-wrap items-center gap-2">
            {/* <label className="inline-flex items-center gap-2 text-sm px-3 py-2 rounded-xl bg-white border shadow-sm cursor-pointer">
              <input type="file" className="hidden" accept="application/json,.json" onChange={handleImport} />
              <span>Import items JSON</span>
            </label> */}
            <button
              onClick={handleExport}
              className="text-sm px-3 py-2 rounded-xl bg-indigo-600 text-white shadow hover:bg-indigo-700"
            >
              Export updated JSON
            </button>
          </div>
        </header>

        <br></br>
        <br></br>


        <header className="flex flex-col sm:flex-row gap-3 sm:items-center sm:justify-between">
          <h1 className="text-2xl sm:text-3xl font-bold text-slate-800">Inventory Bubbles — Drag & Drop</h1>

          <div className="flex flex-wrap items-center gap-2">
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
                  // items:updated will fire from main, but you can also re-read here:
                  const arr = await api.readItems();
                  console.log('items loaded', arr)
                  setItems(normalizeItems(arr || []));
                }
              }}
              className="text-sm px-3 py-2 rounded-xl bg-emerald-600 text-white shadow hover:bg-emerald-700"
            >
              Choose Items JSON…
            </button>

            <button
              onClick={async () => {
                const res = await api.useDefaultFile?.(); // only works if you added it
                if (res?.ok) {
                  const arr = await api.readItems();
                  setItems(normalizeItems(arr || []));
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
                  If a bubble name already exists, a numeric suffix (e.g., “2”) will be added automatically.
                </p>
              </div>
              <div className="text-sm text-slate-600">
                <div>Tip: Drag an item card into a bubble to reassign it.</div>
                <div>Pro: Drag a whole bubble onto <b>Cash Sales</b> or <b>Returns</b> to reallocate all its items.</div>
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
