// src/App.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import api from "./api";
import Card from "./components/Card";
import BubbleColumn from "./components/BubbleColumn";
import {
  DEFAULT_BUBBLES,
  normalizeItems,
  ensureBubblesForItems,
  groupItemsByBubble,
  mergeItems,
  itemKey,
  uniqueName,
  makeUid,
} from "./utils/inventory";




export default function App() {
  const [bubbles, setBubbles] = useState(DEFAULT_BUBBLES);
  const [items, setItems] = useState([]);
  const [expanded, setExpanded] = useState({});
  const [newBubbleName, setNewBubbleName] = useState("");

  const [editingItemUid, setEditingItemUid] = useState(null);
  const [editingDraft, setEditingDraft] = useState(null);

  const editingItemUidRef = useRef(null);
  useEffect(() => {
    editingItemUidRef.current = editingItemUid;
  }, [editingItemUid]);



  // Drag state (items only)
  const draggedItemUidRef = useRef(null);

  // Save / watch bookkeeping
  const lastSavedRef = useRef("");
  const skipNextSaveRef = useRef(false);

  // "User is editing any field" flag
  const isEditingAnythingRef = useRef(false);
  

  // === Load once & subscribe to file changes ===
  useEffect(() => {
    api.readItems().then((arr) => {
      const norm = normalizeItems(arr || []);
      console.log("[init] readItems ->", norm);
      setItems(norm);
      lastSavedRef.current = JSON.stringify(norm);
      ensureBubblesForItems(norm, setBubbles);
    });

    // const off = api.onItemsUpdated((arr) => {
    //   if (isEditingAnythingRef.current) {
    //     console.log("[ipc] items:updated ignored (user is editing)");
    //     return;
    //   }

    //   const norm = normalizeItems(arr || []);
    //   setItems((prev) => {
    //     const merged = mergeItems(prev, norm);
    //     const prevStr = JSON.stringify(prev);
    //     const mergedStr = JSON.stringify(merged);
    //     if (mergedStr === prevStr) {
    //       lastSavedRef.current = mergedStr;
    //       return prev;
    //     }
    //     lastSavedRef.current = mergedStr;
    //     ensureBubblesForItems(merged, setBubbles);
    //     return merged;
    //   });
    // });
    const off = api.onItemsUpdated((arr) => {
      // If a modal edit is open, ignore external changes
      if (editingItemUidRef.current) {
        console.log("[ipc] items:updated ignored (modal editing)");
        return;
      }

      if (isEditingAnythingRef.current) {
        console.log("[ipc] items:updated ignored (user is editing)");
        return;
      }

      const norm = normalizeItems(arr || []);
      setItems((prev) => {
        const merged = mergeItems(prev, norm);
        const prevStr = JSON.stringify(prev);
        const mergedStr = JSON.stringify(merged);
        if (mergedStr === prevStr) {
          lastSavedRef.current = mergedStr;
          return prev;
        }
        lastSavedRef.current = mergedStr;
        ensureBubblesForItems(merged, setBubbles);
        return merged;
      });
    });


    return () => off && off();
  }, []);

  // === Autosave after 10s of inactivity ===
  useEffect(() => {
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
    }, 10000);

    return () => clearTimeout(id);
  }, [items]);


  useEffect(() => {
    if (!editingItemUid) return;
    const timer = setTimeout(() => {
      alert("Edit timed out after 20 seconds. Changes were not saved.");
      handleCancelEdit();
    }, 20000);
    return () => clearTimeout(timer);
  }, [editingItemUid]);

  // === Helpers ===
  function updateItemByKey(uid, patch) {
    setItems((prev) =>
      prev.map((it) => (it.uid === uid ? { ...it, ...patch } : it))
    );
  }

  function toggleExpand(uid) {
    setExpanded((p) => ({ ...p, [uid]: !p[uid] }));
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
    setBubbles((prev) =>
      prev.map((b) => (b.id === id ? { ...b, notes } : b))
    );
  }

  const itemsByBubble = useMemo(
    () => groupItemsByBubble(items, bubbles),
    [items, bubbles]
  );

  // Drag & drop
  function onDragStartItem(uid) {
    console.log("[drag] start item", uid);
    draggedItemUidRef.current = uid;
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

  // "editing anything" flags for all text inputs
  function handleFieldFocus() {
    isEditingAnythingRef.current = true;
  }
  function handleFieldBlur() {
    isEditingAnythingRef.current = false;
  }

  async function handleStartEdit(item) {
    try {
      const res = await api.lockItem(item.uid);
      if (!res?.ok) {
        if (res?.reason === "locked") {
          alert("This item is currently being edited by another user.");
        } else {
          alert("Could not start editing this item.");
        }
        return;
      }

      // Lock acquired; open modal with a local draft
      setEditingItemUid(item.uid);
      setEditingDraft({ ...item }); // or pick only fields you want editable
    } catch (e) {
      console.error("lockItem error", e);
      alert("Error starting edit.");
    }
  }

  async function handleSaveEdit() {
    if (!editingItemUid || !editingDraft) return;
    try {
      const res = await api.applyEdit(editingItemUid, editingDraft);
      if (!res?.ok) {
        if (res?.reason === "lock-expired") {
          alert("Your edit timed out (>20s). Please reopen the editor.");
        } else {
          alert("Could not save changes.");
        }
        // Close modal and let next fs.watch refresh bring us up-to-date
        setEditingItemUid(null);
        setEditingDraft(null);
        return;
      }

      // Update local items so UI reflects immediately
      setItems((prev) => {
        const next = prev.map((it) =>
          it.uid === editingItemUid ? res.item : it
        );
        lastSavedRef.current = JSON.stringify(next);
        return next;
      });

      setEditingItemUid(null);
      setEditingDraft(null);
    } catch (e) {
      console.error("applyEdit error", e);
      alert("Error saving changes.");
    }
  }

  async function handleCancelEdit() {
    if (editingItemUid) {
      try {
        await api.releaseLock(editingItemUid);
      } catch (e) {
        console.error("releaseLock error", e);
      }
    }
    setEditingItemUid(null);
    setEditingDraft(null);
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
                  ensureBubblesForItems(norm, setBubbles);
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
                  ensureBubblesForItems(norm, setBubbles);
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
                    onFocus={handleFieldFocus}
                    onBlur={handleFieldBlur}
                  />
                  <button
                    onClick={addBubble}
                    className="px-4 py-2 rounded-xl bg-emerald-600 text-white shadow hover:bg-emerald-700"
                  >
                    Add Bubble
                  </button>
                </div>
                <p className="mt-2 text-xs text-slate-500">
                  If a bubble name already exists, a numeric suffix (e.g., “2”)
                  will be added automatically.
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
            <BubbleColumn
              key={b.id}
              bubble={b}
              items={itemsByBubble.get(b.name) || []}
              bubbles={bubbles}
              expanded={expanded}
              onToggleExpand={toggleExpand}
              onDragStartItem={onDragStartItem}
              onDropOnBubble={onDropOnBubble}
              onUpdateItem={updateItemByKey}
              onUpdateBubbleNotes={updateBubbleNotes}
              
              onFieldFocus={handleFieldFocus}
              onFieldBlur={handleFieldBlur}
              onEditItem={handleStartEdit}  
            />
          ))}
        </section>
      </div>
            {editingDraft && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white rounded-2xl shadow-xl p-6 w-full max-w-xl">
            <h2 className="text-xl font-semibold text-slate-800 mb-4">
              Edit Item
            </h2>

            <div className="space-y-3">
              <div>
                <label className="block text-sm text-slate-600 mb-1">
                  Allocated For
                </label>
                <input
                  className="w-full border rounded-xl px-3 py-2"
                  value={editingDraft.allocated_for || ""}
                  onChange={(e) =>
                    setEditingDraft((d) => ({
                      ...d,
                      allocated_for: e.target.value,
                    }))
                  }
                />
              </div>

              <div>
                <label className="block text-sm text-slate-600 mb-1">
                  Allocated To (bubble)
                </label>
                <input
                  className="w-full border rounded-xl px-3 py-2"
                  value={editingDraft.allocated_to || ""}
                  onChange={(e) =>
                    setEditingDraft((d) => ({
                      ...d,
                      allocated_to: e.target.value,
                    }))
                  }
                />
              </div>

              <div>
                <label className="block text-sm text-slate-600 mb-1">
                  Notes
                </label>
                <textarea
                  className="w-full border rounded-xl px-3 py-2"
                  rows={3}
                  value={editingDraft.notes1 || ""}
                  onChange={(e) =>
                    setEditingDraft((d) => ({
                      ...d,
                      notes1: e.target.value,
                    }))
                  }
                />
              </div>
            </div>

            <div className="mt-6 flex justify-end gap-3">
              <button
                onClick={handleCancelEdit}
                className="px-4 py-2 rounded-xl border text-sm"
              >
                Cancel
              </button>
              <button
                onClick={handleSaveEdit}
                className="px-4 py-2 rounded-xl bg-emerald-600 text-white text-sm"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
