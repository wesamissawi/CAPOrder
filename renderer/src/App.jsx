// src/App.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import api from "./api";
import InvoicePreview from "./components/InvoicePreview";
import DashboardView from "./views/DashboardView";
import StockFlowView from "./views/StockFlowView";
import OrderManagementView from "./views/OrderManagementView";
import PaymentManagementView from "./views/PaymentManagementView";
import ReturnsManagementView from "./views/ReturnsManagementView";
import {
  DEFAULT_BUBBLES,
  normalizeItems,
  ensureBubblesForItems,
  groupItemsByBubble,
  mergeItems,
  uniqueName,
  makeUid,
} from "./utils/inventory";

const DEFAULT_BUBBLE_NAMES = new Set(DEFAULT_BUBBLES.map((b) => b.name));
const DELETE_DESTINATIONS = ["New Stock", "Shelf", "Cash Sales", "Returns"];



const VIEWS = [
  { id: "dashboard", label: "Dashboard" },
  { id: "stock-flow", label: "Stock Flow" },
  { id: "returns-management", label: "Returns Management" },
  { id: "order-management", label: "Order Management" },
  { id: "payment-management", label: "Payment Management" },
];

export default function App() {
  const [bubbles, setBubbles] = useState(DEFAULT_BUBBLES);
  const [items, setItems] = useState([]);
  const [expanded, setExpanded] = useState({});
  const [newBubbleName, setNewBubbleName] = useState("");
  const [bubblePositions, setBubblePositions] = useState({});
  const [bubbleSizes, setBubbleSizes] = useState({});
  const [activeBubbleKey, setActiveBubbleKey] = useState(null);
  const [uiStateReady, setUiStateReady] = useState(false);
  const [currentView, setCurrentView] = useState("stock-flow");
  const [returnsFilterEnabled, setReturnsFilterEnabled] = useState(false);
  const [returnsFilterDays, setReturnsFilterDays] = useState(0);
  const [timeFilterEnabled, setTimeFilterEnabled] = useState(false);
  const [timeFilterMinutes, setTimeFilterMinutes] = useState(0);
  const [timeFilterHours, setTimeFilterHours] = useState(0);
  const [timeFilterDays, setTimeFilterDays] = useState(0);
  const [orders, setOrders] = useState([]);
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [ordersError, setOrdersError] = useState(null);
  const [ordersInitialized, setOrdersInitialized] = useState(false);
  const [ordersSourcePath, setOrdersSourcePath] = useState("");
  const [ordersDirty, setOrdersDirty] = useState(false);
  const [ordersSaving, setOrdersSaving] = useState(false);
  const [ordersSearch, setOrdersSearch] = useState("");
  const ordersLastSavedRef = useRef("");

  const [editingItemUid, setEditingItemUid] = useState(null);
  const [editingDraft, setEditingDraft] = useState(null);
  const [printBubbleId, setPrintBubbleId] = useState(null);
  const [printGeneratedAt, setPrintGeneratedAt] = useState(null);

  const editingItemUidRef = useRef(null);
  const printPreviewRef = useRef(null);
  const workspaceRef = useRef(null);
  const bubbleDragRef = useRef(null);
  const bubbleResizeRef = useRef(null);
  const prevBodyUserSelectRef = useRef("");
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
      const needsLastMovedPersist =
        (arr || []).some((it) => !it || !it.last_moved_at);
      if (needsLastMovedPersist) {
        api.writeItems(norm);
      }
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
      prev.map((it) => {
        if (it.uid !== uid) return it;
        const next = { ...it, ...patch };
        if (
          patch.hasOwnProperty("allocated_to") &&
          patch.allocated_to &&
          patch.allocated_to !== it.allocated_to
        ) {
          next.last_moved_at = new Date().toISOString();
        }
        return next;
      })
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

  const filteredItems = useMemo(() => {
    const nowMs = Date.now();
    const specialBubbles = new Set(["Returns", "Cash Sales", "Shelf"]);
    const generalThresholdMs =
      Number(timeFilterMinutes || 0) * 60_000 +
      Number(timeFilterHours || 0) * 3_600_000 +
      Number(timeFilterDays || 0) * 86_400_000;

    return items.filter((it) => {
      const target = it.allocated_to || "New Stock";
      const movedAt = new Date(it.last_moved_at).getTime();
      if (Number.isNaN(movedAt)) return true;
      const ageMs = nowMs - movedAt;

      if (timeFilterEnabled && generalThresholdMs > 0 && ageMs > generalThresholdMs) {
        return false;
      }

      if (returnsFilterEnabled && specialBubbles.has(target)) {
        const limitDays = Number(returnsFilterDays || 0);
        const ageDays = ageMs / 86_400_000;
        if (ageDays > limitDays) return false;
      }

      return true;
    });
  }, [
    items,
    returnsFilterDays,
    returnsFilterEnabled,
    timeFilterDays,
    timeFilterEnabled,
    timeFilterHours,
    timeFilterMinutes,
  ]);

  const itemsByBubble = useMemo(
    () => groupItemsByBubble(filteredItems, bubbles),
    [filteredItems, bubbles]
  );
  const returnsByWarehouse = useMemo(() => {
    const groups = new Map();
    filteredItems.forEach((it) => {
      if ((it.allocated_to || "").toLowerCase() !== "returns") return;
      const warehouse = (it.warehouse || "").trim() || "Unspecified Warehouse";
      if (!groups.has(warehouse)) groups.set(warehouse, []);
      groups.get(warehouse).push(it);
    });
    return Array.from(groups.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([warehouse, groupedItems]) => ({ warehouse, items: groupedItems }));
  }, [filteredItems]);
  useEffect(() => {
    let cancelled = false;
    async function loadUIState() {
      if (!api?.readUIState) {
        if (!cancelled) setUiStateReady(true);
        return;
      }
      try {
        const res = await api.readUIState();
        if (cancelled) return;
        const state = res?.state || {};
        if (state.bubblePositions) {
          setBubblePositions((prev) => ({
            ...prev,
            ...state.bubblePositions,
          }));
        }
        if (state.bubbleSizes) {
          setBubbleSizes((prev) => ({
            ...prev,
            ...state.bubbleSizes,
          }));
        }
      } catch (e) {
        console.warn("[ui-state] read failed", e);
      } finally {
        if (!cancelled) setUiStateReady(true);
      }
    }
    loadUIState();
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    if (!uiStateReady || !api?.writeUIState) return;
    api
      .writeUIState({ bubblePositions, bubbleSizes })
      .catch((e) => console.warn("[ui-state] write failed", e));
  }, [bubblePositions, bubbleSizes, uiStateReady]);
  useEffect(() => {
    setBubblePositions((prev) => {
      let changed = false;
      const next = { ...prev };
      bubbles.forEach((b, index) => {
        const key = b.name || b.id;
        if (!next[key]) {
          const col = index % 3;
          const row = Math.floor(index / 3);
          next[key] = {
            x: col * 360,
            y: row * 360,
          };
          changed = true;
        }
      });
      return changed ? next : prev;
    });
    setBubbleSizes((prev) => {
      let changed = false;
      const next = { ...prev };
      bubbles.forEach((b) => {
        const key = b.name || b.id;
        if (!next[key]) {
          next[key] = 360;
          changed = true;
        }
      });
      return changed ? next : prev;
    });
  }, [bubbles]);
  const printBubble = useMemo(
    () => bubbles.find((b) => b.id === printBubbleId) || null,
    [printBubbleId, bubbles]
  );
  const printItems = useMemo(() => {
    if (!printBubble) return [];
    return filteredItems.filter((it) => it.allocated_to === printBubble.name);
  }, [filteredItems, printBubble]);

  useEffect(() => {
    function handlePointerMove(e) {
      const point = "touches" in e ? e.touches[0] : e;
      if (!point) return;
      const drag = bubbleDragRef.current;
      const resize = bubbleResizeRef.current;
      if (!drag && !resize) return;
      if (!workspaceRef.current) return;
      e.preventDefault();
      if (drag) {
        const rect = workspaceRef.current.getBoundingClientRect();
        const x = Math.max(0, point.clientX - rect.left - drag.offsetX);
        const y = Math.max(0, point.clientY - rect.top - drag.offsetY);
        setBubblePositions((prev) => ({
          ...prev,
          [drag.key]: { x, y },
        }));
      } else if (resize) {
        const delta = point.clientX - resize.startX;
        const width = Math.max(280, Math.min(900, resize.startWidth + delta));
        setBubbleSizes((prev) => ({
          ...prev,
          [resize.key]: width,
        }));
      }
    }

    function endDrag() {
      if (!bubbleDragRef.current && !bubbleResizeRef.current) return;
      bubbleDragRef.current = null;
      bubbleResizeRef.current = null;
      document.body.style.userSelect = prevBodyUserSelectRef.current || "";
    }

    window.addEventListener("mousemove", handlePointerMove);
    window.addEventListener("mouseup", endDrag);
    window.addEventListener("touchmove", handlePointerMove, { passive: false });
    window.addEventListener("touchend", endDrag);
    window.addEventListener("touchcancel", endDrag);
    return () => {
      window.removeEventListener("mousemove", handlePointerMove);
      window.removeEventListener("mouseup", endDrag);
      window.removeEventListener("touchmove", handlePointerMove);
      window.removeEventListener("touchend", endDrag);
      window.removeEventListener("touchcancel", endDrag);
    };
  }, []);

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

  function handleSplitItem(uid, splitQuantity, destinationBubbleName) {
    setItems((prev) => {
      const idx = prev.findIndex((it) => it.uid === uid);
      if (idx === -1) return prev;
      const item = prev[idx];
      const currentQty = Number(item.quantity) || 0;
      const qtyToMove = Math.floor(Number(splitQuantity));
      if (!qtyToMove || qtyToMove <= 0 || qtyToMove >= currentQty) {
        return prev;
      }
      const remainder = currentQty - qtyToMove;
      const targetBubble = destinationBubbleName || item.allocated_to;
      const newItem = {
        ...item,
        uid: makeUid(),
        quantity: qtyToMove,
        allocated_to: targetBubble,
        last_moved_at: new Date().toISOString(),
      };
      const next = [...prev];
      next[idx] = { ...item, quantity: remainder };
      next.splice(idx + 1, 0, newItem);
      ensureBubblesForItems(next, setBubbles);
      return next;
    });
  }

  function handleConsolidateBubbleItems(bubbleName) {
    if (!bubbleName) return;
    setItems((prev) => {
      const groupedByItem = new Map();
      for (const item of prev) {
        if (item.allocated_to !== bubbleName) continue;
        const key = item.itemcode || item.reference_num || item.uid;
        if (!groupedByItem.has(key)) {
          groupedByItem.set(key, []);
        }
        groupedByItem.get(key).push(item);
      }

      let changed = false;
      const replacements = new Map();

      groupedByItem.forEach((itemsForKey) => {
        if (itemsForKey.length < 2) return;
        changed = true;
        const totalQuantity = itemsForKey.reduce(
          (sum, curr) => sum + (Number(curr.quantity) || 0),
          0
        );
        const totalCost = itemsForKey.reduce(
          (sum, curr) => sum + (Number(curr.cost) || 0) * (Number(curr.quantity) || 0),
          0
        );
        const highestPrice = itemsForKey.reduce(
          (max, curr) => Math.max(max, Number(curr.allocated_for) || 0),
          0
        );
        const reference = itemsForKey[0];
        const mergedItem = {
          ...reference,
          uid: reference.uid,
          quantity: totalQuantity,
          cost: totalQuantity ? (totalCost / totalQuantity).toFixed(2) : reference.cost,
          allocated_for: String(highestPrice || ""),
        };
        replacements.set(reference.uid, mergedItem);
        for (let i = 1; i < itemsForKey.length; i++) {
          replacements.set(itemsForKey[i].uid, null);
        }
      });

      if (!changed) return prev;

      return prev
        .map((item) => {
          if (!replacements.has(item.uid)) return item;
          const replacement = replacements.get(item.uid);
          if (replacement === null) return null;
          return replacement;
        })
        .filter(Boolean);
    });
  }

  function handleDeleteBubble(bubbleId, fallbackTargetName) {
    const bubble = bubbles.find((b) => b.id === bubbleId);
    if (!bubble) return;
    const validTargets = DELETE_DESTINATIONS.filter((name) => name !== bubble.name);
    const fallback =
      validTargets.includes(fallbackTargetName) && fallbackTargetName
        ? fallbackTargetName
        : validTargets[0] || "New Stock";
    let updatedItemsSnapshot = null;
    setItems((prev) => {
      const nowIso = new Date().toISOString();
      const next = prev.map((it) =>
        it.allocated_to === bubble.name
          ? { ...it, allocated_to: fallback, last_moved_at: nowIso }
          : it
      );
      updatedItemsSnapshot = next;
      return next;
    });
    if (updatedItemsSnapshot) {
      ensureBubblesForItems(updatedItemsSnapshot, setBubbles);
    }
    setBubbles((prev) => prev.filter((b) => b.id !== bubbleId));
  }

  function handleStartBubbleMove(bubbleKey, clientX, clientY) {
    if (!workspaceRef.current) return;
    const rect = workspaceRef.current.getBoundingClientRect();
    const current = bubblePositions[bubbleKey] || { x: 0, y: 0 };
    prevBodyUserSelectRef.current = document.body.style.userSelect;
    document.body.style.userSelect = "none";
    setActiveBubbleKey(bubbleKey);
    bubbleDragRef.current = {
      key: bubbleKey,
      offsetX: clientX - rect.left - current.x,
      offsetY: clientY - rect.top - current.y,
    };
  }

  function handleStartBubbleResize(bubbleKey, clientX) {
    prevBodyUserSelectRef.current = document.body.style.userSelect;
    document.body.style.userSelect = "none";
    setActiveBubbleKey(bubbleKey);
    bubbleResizeRef.current = {
      key: bubbleKey,
      startX: clientX,
      startWidth: bubbleSizes[bubbleKey] || 360,
    };
  }

  function handleReturnItemToNewStock(uid) {
    setItems((prev) => {
      const next = prev.map((it) =>
        it.uid === uid ? { ...it, allocated_to: "New Stock", last_moved_at: new Date().toISOString() } : it
      );
      ensureBubblesForItems(next, setBubbles);
      return next;
    });
  }

  function handleOpenPrint(bubble) {
    if (!bubble || DEFAULT_BUBBLE_NAMES.has(bubble.name)) return;
    setPrintBubbleId(bubble.id);
    setPrintGeneratedAt(new Date());
  }

  function handleClosePrint() {
    setPrintBubbleId(null);
    setPrintGeneratedAt(null);
  }

  function handleConfirmPrint() {
    if (!printBubble || printItems.length === 0) return;
    const todayStr = new Date().toLocaleDateString("en-CA");
    const ids = new Set(printItems.map((it) => it.uid));
    setItems((prev) =>
      prev.map((it) => (ids.has(it.uid) ? { ...it, sold_date: todayStr } : it))
    );
    setPrintGeneratedAt(new Date());
    setTimeout(() => {
      if (!printPreviewRef.current) return;
      const contents = printPreviewRef.current.innerHTML;
      const printWindow = window.open("", "PRINT", "width=900,height=1100");
      if (!printWindow) return;
      printWindow.document.write(`
        <!doctype html>
        <html>
          <head>
            <title>Invoice - ${printBubble.name}</title>
            <style>
              body {
                margin: 0;
                padding: 24px;
                background: #e2e8f0;
                font-family: 'Inter', 'Segoe UI', sans-serif;
              }
              @media print {
                body {
                  padding: 0;
                  background: white;
                }
              }
              .page {
                width: 8.5in;
                min-height: 11in;
                margin: 0 auto;
              }
            </style>
          </head>
          <body>${contents}</body>
        </html>
      `);
      printWindow.document.close();
      printWindow.focus();
      printWindow.print();
      printWindow.close();
    }, 100);
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

  async function loadOrders() {
    try {
      setOrdersLoading(true);
      setOrdersError(null);
      const [ordersRes, pathRes] = await Promise.all([
        api?.readOrders?.(),
        api?.getOrdersPath?.(),
      ]);
      const list = ordersRes?.state || ordersRes || [];
      const normalized = Array.isArray(list) ? list : [];
      setOrders(normalized);
      ordersLastSavedRef.current = JSON.stringify(normalized);
      setOrdersDirty(false);
      if (pathRes?.path) setOrdersSourcePath(pathRes.path);
      setOrdersInitialized(true);
    } catch (e) {
      console.error("[orders] fetch error", e);
      setOrdersError(e?.message || "Failed to load orders.");
    } finally {
      setOrdersLoading(false);
    }
  }

  function updateOrderAt(index, patch) {
    if (index < 0) return;
    setOrders((prev) => {
      if (index >= prev.length) return prev;
      const next = [...prev];
      const current = next[index] || {};
      next[index] = { ...current, ...patch };
      return next;
    });
    setOrdersDirty(true);
  }

  function handleOrderCheckboxChange(index, field, checked) {
    updateOrderAt(index, { [field]: checked });
  }

  function handleOrderFieldChange(index, field, value) {
    updateOrderAt(index, { [field]: value });
  }

  async function handleSaveOrders() {
    if (!ordersDirty || ordersSaving) return;
    try {
      setOrdersSaving(true);
      setOrdersError(null);
      const res = await api?.writeOrders?.(orders);
      if (!res?.ok) {
        throw new Error("Failed to save orders.");
      }
      ordersLastSavedRef.current = JSON.stringify(orders);
      setOrdersDirty(false);
    } catch (e) {
      console.error("[orders] save error", e);
      setOrdersError(e?.message || "Failed to save orders.");
    } finally {
      setOrdersSaving(false);
    }
  }

  useEffect(() => {
    if (currentView === "order-management" && !ordersInitialized && !ordersLoading) {
      loadOrders();
    }
  }, [currentView, ordersInitialized, ordersLoading]);

  const filteredOrders = useMemo(() => {
    const q = ordersSearch.trim().toLowerCase();
    if (!q) return orders;
    return orders.filter((order) => {
      const fields = [
        order.reference,
        order.warehouse,
        order.invoiceNum,
        order.journalEntry,
        order.customerName,
        order.supplier,
        order.source,
      ];
      return fields.some((val) => {
        if (val === undefined || val === null) return false;
        return String(val).toLowerCase().includes(q);
      });
    });
  }, [orders, ordersSearch]);

  const hasSearch = ordersSearch.trim().length > 0;


  const currentViewMeta = VIEWS.find((v) => v.id === currentView);
  const isStockFlowView = currentView === "stock-flow";

  return (
    <div className="min-h-screen w-full bg-gradient-to-br from-fuchsia-100 via-sky-100 to-emerald-100">
      <div className="max-w-7xl mx-auto p-4 sm:p-6 lg:p-8 space-y-6">
        <header className="bg-white/80 rounded-3xl shadow border border-white/50">
          <div className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h1 className="text-2xl sm:text-3xl font-bold text-slate-800">
                Business Control Center
              </h1>
              <p className="text-sm text-slate-500">Manage pipelines, orders, and payments from one dashboard.</p>
            </div>
            <nav className="flex flex-wrap gap-2">
              {VIEWS.map((view) => (
                <button
                  key={view.id}
                  onClick={() => setCurrentView(view.id)}
                  className={`px-4 py-2 rounded-full border text-sm font-semibold transition ${
                    currentView === view.id
                      ? "bg-indigo-600 text-white border-indigo-600 shadow"
                      : "bg-white border-slate-200 text-slate-600 hover:text-indigo-600"
                  }`}
                >
                  {view.label}
                </button>
              ))}
            </nav>
          </div>
        </header>

        {currentView === "dashboard" ? (
          <DashboardView
            returnsFilterEnabled={returnsFilterEnabled}
            setReturnsFilterEnabled={setReturnsFilterEnabled}
            returnsFilterDays={returnsFilterDays}
            setReturnsFilterDays={setReturnsFilterDays}
            timeFilterEnabled={timeFilterEnabled}
            setTimeFilterEnabled={setTimeFilterEnabled}
            timeFilterMinutes={timeFilterMinutes}
            setTimeFilterMinutes={setTimeFilterMinutes}
            timeFilterHours={timeFilterHours}
            setTimeFilterHours={setTimeFilterHours}
            timeFilterDays={timeFilterDays}
            setTimeFilterDays={setTimeFilterDays}
          />
        ) : isStockFlowView ? (
          <StockFlowView
            newBubbleName={newBubbleName}
            setNewBubbleName={setNewBubbleName}
            handleFieldFocus={handleFieldFocus}
            handleFieldBlur={handleFieldBlur}
            addBubble={addBubble}
            bubbles={bubbles}
            bubblePositions={bubblePositions}
            bubbleSizes={bubbleSizes}
            activeBubbleKey={activeBubbleKey}
            workspaceRef={workspaceRef}
            printBubble={printBubble}
            itemsByBubble={itemsByBubble}
            expanded={expanded}
            toggleExpand={toggleExpand}
            onDragStartItem={onDragStartItem}
            onDropOnBubble={onDropOnBubble}
            onUpdateItem={updateItemByKey}
            onUpdateBubbleNotes={updateBubbleNotes}
            onRequestPrint={handleOpenPrint}
            onEditItem={handleStartEdit}
            onSplitItem={handleSplitItem}
            onConsolidateItems={handleConsolidateBubbleItems}
            onDeleteBubble={handleDeleteBubble}
            deleteTargets={DELETE_DESTINATIONS}
            defaultBubbleNames={DEFAULT_BUBBLE_NAMES}
            onStartBubbleMove={handleStartBubbleMove}
            onStartBubbleResize={handleStartBubbleResize}
            onActivateBubble={setActiveBubbleKey}
          />
        ) : currentView === "returns-management" ? (
          <ReturnsManagementView
            groups={returnsByWarehouse}
            onReturnToNewStock={handleReturnItemToNewStock}
          />
        ) : currentView === "order-management" ? (
          <OrderManagementView
            ordersSourcePath={ordersSourcePath}
            ordersSearch={ordersSearch}
            setOrdersSearch={setOrdersSearch}
            ordersDirty={ordersDirty}
            ordersSaving={ordersSaving}
            ordersLoading={ordersLoading}
            ordersError={ordersError}
            loadOrders={loadOrders}
            handleSaveOrders={handleSaveOrders}
            filteredOrders={filteredOrders}
            handleOrderCheckboxChange={handleOrderCheckboxChange}
            handleOrderFieldChange={handleOrderFieldChange}
            hasSearch={hasSearch}
          />
        ) : (
          <PaymentManagementView currentViewMeta={currentViewMeta} />
        )}
      </div>
      {printBubble && (
        <div className="fixed inset-0 z-[5000] bg-slate-900/60 flex items-center justify-center px-4">
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-5xl p-6 flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <h2 className="text-xl font-semibold text-slate-800">
                Print Preview - {printBubble.name}
              </h2>
              <button
                className="text-slate-500 hover:text-slate-700"
                onClick={handleClosePrint}
              >
                x
              </button>
            </div>
            <div className="flex justify-end gap-3">
              <button
                className="px-4 py-2 rounded-full border border-slate-300 text-slate-700"
                onClick={handleClosePrint}
              >
                Cancel
              </button>
              <button
                className="px-5 py-2 rounded-full bg-indigo-600 text-white shadow hover:bg-indigo-700"
                onClick={handleConfirmPrint}
              >
                Print
              </button>
            </div>
            <div
              ref={printPreviewRef}
              className="max-h-[70vh] overflow-auto rounded-2xl border border-slate-200 bg-slate-50 p-4"
            >
              <InvoicePreview
                bubbleName={printBubble.name}
                bubbleNotes={printBubble.notes}
                items={printItems}
                generatedDate={printGeneratedAt || new Date()}
              />
            </div>
          </div>
        </div>
      )}
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
