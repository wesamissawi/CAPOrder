// src/App.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import api from "./api";
import InvoicePreview from "./components/InvoicePreview";
import DashboardView from "./views/DashboardView";
import StockFlowView from "./views/StockFlowView";
import OrderManagementView from "./views/OrderManagementView";
import RefToInvView from "./views/RefToInvView";
import PaymentManagementView from "./views/PaymentManagementView";
import ReturnsManagementView from "./views/ReturnsManagementView";
import ManageStockView from "./views/ManageStockView";
import ArchiveSearchView from "./views/ArchiveSearchView";
import SettingsView from "./views/SettingsView";
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
const DELETE_DESTINATIONS = ["NEW STOCK", "SHELF", "CASH SALES", "RETURNS"];

const ACCOUNTING_PATHS = {
  OUTSTANDING: "OUTSTANDING",
  SAGE_AR: "SAGE_AR",
  CASH_SALE: "CASH_SALE",
  ARCHIVED: "ARCHIVED",
};



const VIEWS = [
  { id: "dashboard", label: "Dashboard" },
  { id: "stock-flow", label: "Stock Flow" },
  { id: "sage-ar-queue", label: "Sage AR Queue" },
  { id: "cash-sale-flow", label: "Cash Sales" },
  { id: "manage-stock", label: "Manage Stock" },
  { id: "returns-management", label: "Returns Management" },
  { id: "order-management", label: "Order Management" },
  { id: "ref-to-inv", label: "Ref to Inv" },
  { id: "archive-search", label: "Archive" },
  { id: "settings", label: "Settings" },
  { id: "payment-management", label: "Payment Management" },
];

function ViewTabs({ currentView, onSelect }) {
  return (
    <div className="w-full">
      <div className="flex flex-wrap gap-2 justify-start items-stretch">
        {VIEWS.map((view) => (
          <button
            key={view.id}
            onClick={() => onSelect(view.id)}
            className={`h-11 min-w-[150px] px-4 rounded-full border text-sm font-semibold whitespace-nowrap transition ${
              currentView === view.id
                ? "bg-indigo-600 text-white border-indigo-600 shadow"
                : "bg-white border-slate-200 text-slate-600 hover:text-indigo-600"
            }`}
          >
            {view.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export default function App() {
  const [bubbles, setBubbles] = useState(DEFAULT_BUBBLES);
  const [items, setItems] = useState([]);
  const [expanded, setExpanded] = useState({});
  const [newBubbleName, setNewBubbleName] = useState("");
  const [bubblePositions, setBubblePositions] = useState({});
  const [bubbleSizes, setBubbleSizes] = useState({});
  const [bubbleZOrder, setBubbleZOrder] = useState([]);
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
  const [ordersPickupFilter, setOrdersPickupFilter] = useState("all");
  const [ordersTodayOnly, setOrdersTodayOnly] = useState(false);
  const [ordersArchiveRunning, setOrdersArchiveRunning] = useState(false);
  const [ordersArchiveStatus, setOrdersArchiveStatus] = useState("");
  const [ordersArchiveError, setOrdersArchiveError] = useState("");
  const [archiveCleanupDays, setArchiveCleanupDays] = useState(2);
  const [sageIntegrationEnabled, setSageIntegrationEnabled] = useState(false);
  const [sageLockInfo, setSageLockInfo] = useState(null); // { lock, ownMachineId }
  // Bubble edit locks
  const [bubbleLocks, setBubbleLocks] = useState({});
  const [ownMachineId, setOwnMachineId] = useState('');
  const [pendingRequestBubbles, setPendingRequestBubbles] = useState(new Set());
  const pendingRequestsRef = React.useRef({}); // { [bubbleId]: { startedAt, timeoutId } }
  const [sageReadyOrders, setSageReadyOrders] = useState([]);
  const [payments, setPayments] = useState([]);
  const [paymentsLoading, setPaymentsLoading] = useState(false);
  const [paymentsError, setPaymentsError] = useState("");
  const [sageWatchError, setSageWatchError] = useState("");
  const [printExtraLinesByBubble, setPrintExtraLinesByBubble] = useState({});
  const [bubbleMeta, setBubbleMeta] = useState({});
  const [worldOrdersRunning, setWorldOrdersRunning] = useState(false);
  const [worldOrdersStatus, setWorldOrdersStatus] = useState("");
  const [worldOrdersError, setWorldOrdersError] = useState("");
  const [cbkOrdersRunning, setCbkOrdersRunning] = useState(false);
  const [cbkOrdersStatus, setCbkOrdersStatus] = useState("");
  const [cbkOrdersError, setCbkOrdersError] = useState("");
  const [bestBuyOrdersRunning, setBestBuyOrdersRunning] = useState(false);
  const [bestBuyOrdersStatus, setBestBuyOrdersStatus] = useState("");
  const [bestBuyOrdersError, setBestBuyOrdersError] = useState("");
  const [transbecOrdersRunning, setTransbecOrdersRunning] = useState(false);
  const [transbecOrdersStatus, setTransbecOrdersStatus] = useState("");
  const [transbecOrdersError, setTransbecOrdersError] = useState("");
  const [proforceRunning, setProforceRunning] = useState(false);
  const [proforceStatus, setProforceStatus] = useState("");
  const [proforceError, setProforceError] = useState("");
  const [outstandingRunning, setOutstandingRunning] = useState(false);
  const [outstandingStatus, setOutstandingStatus] = useState("");
  const [outstandingError, setOutstandingError] = useState("");
  const [archiveSearchTerm, setArchiveSearchTerm] = useState("");
  const [archiveBubbleSearch, setArchiveBubbleSearch] = useState("");
  const [archiveResults, setArchiveResults] = useState([]);
  const [archiveSearching, setArchiveSearching] = useState(false);
  const [archiveError, setArchiveError] = useState("");
  const [archivePath, setArchivePath] = useState("");
  const ordersLastSavedRef = useRef("");

  const [editingItemUid, setEditingItemUid] = useState(null);
  const [editingDraft, setEditingDraft] = useState(null);
  const [printBubbleId, setPrintBubbleId] = useState(null);
  const [printGeneratedAt, setPrintGeneratedAt] = useState(null);

  const editingItemUidRef = useRef(null);
  const pendingItemsRefreshRef = useRef(false);
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
        pendingItemsRefreshRef.current = true;
        return;
      }

      if (isEditingAnythingRef.current) {
        console.log("[ipc] items:updated ignored (user is editing)");
        pendingItemsRefreshRef.current = true;
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

  async function loadPayments() {
    if (!api?.readPayments) return;
    try {
      setPaymentsLoading(true);
      setPaymentsError("");
      const list = await api.readPayments();
      setPayments(Array.isArray(list) ? list : []);
    } catch (e) {
      setPaymentsError(e?.message || "Failed to load payments.");
    } finally {
      setPaymentsLoading(false);
    }
  }

  useEffect(() => {
    loadPayments();
  }, []);

  useEffect(() => {
    if (currentView === "cash-sale-flow" || currentView === "payment-management") {
      loadPayments();
    }
  }, [currentView]);


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

  function persistSharedBubbleSnapshot(bubbleId, overrides = {}) {
    if (!api?.writeSharedBubbleData || (!bubbleId && !overrides?.name)) return;
    const bubble = bubbles.find((b) => b.id === bubbleId) || bubbles.find((b) => b.name === overrides?.name);
    const hasNotes = Object.prototype.hasOwnProperty.call(overrides, "notes");
    const hasExtras = Object.prototype.hasOwnProperty.call(overrides, "extraLines");
    const hasPayments = Object.prototype.hasOwnProperty.call(overrides, "paymentIds");
    const nextNotes = hasNotes ? overrides.notes : bubble?.notes || "";
    const nextExtras = hasExtras
      ? overrides.extraLines || []
      : printExtraLinesByBubble[bubbleId] || [];
    const meta = bubbleMeta[bubbleId] || bubbleMeta[bubble?.name] || {};
    const nextPaymentIds = hasPayments ? overrides.paymentIds : meta.paymentIds;
    const payload = {
      bubbleId,
      name: bubble?.name || "",
      notes: nextNotes || "",
      extraLines: nextExtras,
      deleted: overrides?.deleted === true,
    };
    if (Array.isArray(nextPaymentIds)) {
      payload.paymentIds = nextPaymentIds;
    }
    api
      .writeSharedBubbleData(payload)
      .catch((e) => console.warn("[shared-bubble] write failed", e));
  }

  function markSharedBubbleDeleted(bubble) {
    if (!bubble || !api?.deleteSharedBubbleData) return;
    const targets = new Set([bubble.id, bubble.name]);
    targets.forEach((key) => {
      if (!key) return;
      api.deleteSharedBubbleData(key).catch((e) => console.warn("[shared-bubble] delete failed", e));
    });
  }

  function applySharedBubbleData(shared = {}) {
    const norm = (n) => (n || "").trim().toLowerCase();
    const entries = Object.keys(shared || {}).map((key) => shared[key]).filter(Boolean);
    const deleteIds = new Set();
    const deleteNames = new Set();
    const extras = {};
    const paymentAssignments = {};
    const createdIds = [];
    const sharedLowerNames = new Set(entries.map((e) => norm(e.name || e.id)));
    const itemsLowerNames = new Set((items || []).map((it) => norm(it.allocated_to)));
    let keptIds = new Set();

    entries.forEach((entry) => {
      if (entry.deleted) {
        if (entry.id) deleteIds.add(entry.id);
        if (entry.name) deleteNames.add(norm(entry.name));
      }
    });

    setBubbles((prev) => {
      const next = [];
      const indexById = new Map();
      const indexByLower = new Map();

      prev.forEach((b) => {
        const lower = norm(b.name);
        if (deleteIds.has(b.id) || deleteNames.has(lower)) return;
        const keep =
          DEFAULT_BUBBLE_NAMES.has(b.name) || itemsLowerNames.has(lower) || sharedLowerNames.has(lower);
        if (!keep) return;
        indexById.set(b.id, next.length);
        if (lower) indexByLower.set(lower, next.length);
        next.push(b);
      });

      entries.forEach((entry) => {
        if (!entry || entry.deleted) return;
        const id = entry.id || entry.bubbleId || entry.name || makeUid();
        const name = (entry.name || id || "").toString().trim().toUpperCase();
        const lower = norm(name);
        if (!name) return;
        const existingIdx =
          (id && indexById.has(id) && indexById.get(id) !== undefined
            ? indexById.get(id)
            : undefined) ?? (indexByLower.has(lower) ? indexByLower.get(lower) : undefined);
        extras[id] = Array.isArray(entry.extraLines) ? entry.extraLines : [];
        if (Array.isArray(entry.paymentIds)) {
          paymentAssignments[id] = entry.paymentIds.filter(Boolean);
          if (entry.name) paymentAssignments[entry.name] = entry.paymentIds.filter(Boolean);
        }
        if (existingIdx !== undefined) {
          const merged = {
            ...next[existingIdx],
            id,
            name,
            notes: typeof entry.notes === "string" ? entry.notes : next[existingIdx].notes,
          };
          next[existingIdx] = merged;
          indexById.set(merged.id, existingIdx);
          if (lower) indexByLower.set(lower, existingIdx);
        } else {
          const newBubble = { id, name, notes: typeof entry.notes === "string" ? entry.notes : "" };
          createdIds.push(id);
          const idx = next.length;
          next.push(newBubble);
          indexById.set(newBubble.id, idx);
          if (lower) indexByLower.set(lower, idx);
        }
      });

      // Enforce case-insensitive uniqueness (first seen wins)
      const seenLower = new Set();
      const deduped = [];
      next.forEach((b) => {
        const lower = norm(b.name);
        if (lower && seenLower.has(lower)) return;
        if (lower) seenLower.add(lower);
        deduped.push(b);
      });
      keptIds = new Set(deduped.map((b) => b.id));

      return deduped;
    });

    setPrintExtraLinesByBubble((prev) => {
      const merged = { ...prev };
      Object.keys(extras).forEach((id) => {
        merged[id] = extras[id];
      });
      deleteIds.forEach((id) => {
        delete merged[id];
      });
      Object.keys(merged).forEach((id) => {
        if (!keptIds.has(id)) delete merged[id];
      });
      return merged;
    });

    if (createdIds.length || deleteIds.size || keptIds.size || Object.keys(paymentAssignments).length) {
      setBubbleMeta((prev) => {
        const next = { ...prev };
        createdIds.forEach((id) => {
          next[id] = { ...(next[id] || {}), accountingPath: ACCOUNTING_PATHS.OUTSTANDING };
        });
        deleteIds.forEach((id) => delete next[id]);
        Object.keys(next).forEach((id) => {
          if (!keptIds.has(id)) delete next[id];
        });
        Object.keys(paymentAssignments).forEach((id) => {
          if (!next[id]) next[id] = {};
          next[id] = { ...next[id], paymentIds: paymentAssignments[id] };
        });
        return next;
      });
    }
  }


  async function addBubble(position) {
    const baseRaw = newBubbleName.trim() || "New Bubble";
    const base = baseRaw.toUpperCase();
    const names = new Set(bubbles.map((b) => (b.name || "").toUpperCase()));
    const finalName = uniqueName(base, names);
    const id = makeUid();
    const nb = { id, name: finalName, notes: "" };
    if (position && typeof position.x === "number" && typeof position.y === "number") {
      setBubblePositions((prev) => ({
        ...prev,
        [id]: { x: position.x, y: position.y },
        [finalName]: { x: position.x, y: position.y },
      }));
    }
    setBubbles((p) => [...p, nb]);
    setBubbleMeta((prev) => ({
      ...prev,
      [id]: { ...(prev[id] || {}), accountingPath: ACCOUNTING_PATHS.OUTSTANDING },
    }));
    setNewBubbleName("");
    if (api?.writeSharedBubbleData) {
      api
        .writeSharedBubbleData({
          bubbleId: id,
          name: finalName,
          notes: "",
          extraLines: [],
        })
        .catch((e) => console.warn("[shared-bubble] write failed (new bubble)", e));
    }
  }

  function updateBubbleNotes(id, notes) {
    setBubbles((prev) =>
      prev.map((b) => (b.id === id ? { ...b, notes } : b))
    );
  }

  function handleBubbleNotesBlur(id) {
    const bubble = bubbles.find((b) => b.id === id);
    if (!bubble) return;
    persistSharedBubbleSnapshot(id, { notes: bubble.notes || "" });
  }

  const filteredItems = useMemo(() => {
    const nowMs = Date.now();
    const specialBubbles = new Set(["RETURNS", "CASH SALES", "SHELF"]);
    const generalThresholdMs =
      Number(timeFilterMinutes || 0) * 60_000 +
      Number(timeFilterHours || 0) * 3_600_000 +
      Number(timeFilterDays || 0) * 86_400_000;

    return items.filter((it) => {
      const target = it.allocated_to || "NEW STOCK";
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

  const bubbleAccountingPathByName = useMemo(() => {
    const map = new Map();
    items.forEach((it) => {
      const name = (it.allocated_to || "").trim();
      if (!name) return;
      const path = it.accountingPath || ACCOUNTING_PATHS.OUTSTANDING;
      if (!map.has(name)) map.set(name, path);
    });
    return map;
  }, [items]);
  const archivableBubbleIds = useMemo(() => {
    const set = new Set();
    bubbles.forEach((b) => {
      const path = bubbleAccountingPathByName.get(b.name);
      if (path === ACCOUNTING_PATHS.SAGE_AR || path === ACCOUNTING_PATHS.CASH_SALE) {
        set.add(b.id);
      }
    });
    return set;
  }, [bubbles, bubbleAccountingPathByName]);
  const visibleAccountingPath = useMemo(() => {
    if (currentView === "stock-flow") return ACCOUNTING_PATHS.OUTSTANDING;
    if (currentView === "sage-ar-queue") return ACCOUNTING_PATHS.SAGE_AR;
    if (currentView === "cash-sale-flow") return ACCOUNTING_PATHS.CASH_SALE;
    return null;
  }, [currentView]);
  const bubblesForView = useMemo(() => {
    if (!visibleAccountingPath) return bubbles;
    return bubbles.filter((b) => {
      const path =
        bubbleAccountingPathByName.get(b.name) || ACCOUNTING_PATHS.OUTSTANDING;
      return path === visibleAccountingPath;
    });
  }, [bubbles, bubbleAccountingPathByName, visibleAccountingPath]);
  const filteredItemsForView = useMemo(() => {
    if (!visibleAccountingPath) return filteredItems;
    return filteredItems.filter((it) => {
      const path = it.accountingPath || ACCOUNTING_PATHS.OUTSTANDING;
      return path === visibleAccountingPath;
    });
  }, [filteredItems, visibleAccountingPath]);
  const itemsByBubbleForView = useMemo(
    () => groupItemsByBubble(filteredItemsForView, bubblesForView),
    [filteredItemsForView, bubblesForView]
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
        if (Array.isArray(state.bubbleZOrder)) {
          setBubbleZOrder(state.bubbleZOrder);
        }
        if (typeof state.sageIntegrationEnabled === "boolean") {
          setSageIntegrationEnabled(state.sageIntegrationEnabled);
        }
        if (typeof state.archiveCleanupDays === "number") {
          setArchiveCleanupDays(state.archiveCleanupDays);
        }
        if (
          state.printExtraLinesByBubble &&
          typeof state.printExtraLinesByBubble === "object"
        ) {
          setPrintExtraLinesByBubble(state.printExtraLinesByBubble);
        }
        if (typeof state.ordersTodayOnly === "boolean") {
          setOrdersTodayOnly(state.ordersTodayOnly);
        }
        if (state.bubbleMeta && typeof state.bubbleMeta === "object") {
          setBubbleMeta((prev) => ({ ...(state.bubbleMeta || {}), ...prev }));
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
    let cancelled = false;
    async function loadSharedBubbleData() {
      if (!api?.readSharedBubbleData) return;
      try {
        const res = await api.readSharedBubbleData();
        if (cancelled) return;
        const shared = res?.data?.bubbles || {};
        applySharedBubbleData(shared);
      } catch (e) {
        console.warn("[shared-bubble] read failed", e);
      }
    }
    loadSharedBubbleData();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!api?.onBubbleSharedUpdated) return;
    const off = api.onBubbleSharedUpdated((payload) => {
      const shared = payload?.bubbles || {};
      applySharedBubbleData(shared);
    });
    return () => off && off();
  }, []);

  // Ensure bubbles exist for all allocated_to values (case-insensitive), create missing ones and persist to shared
  useEffect(() => {
    const norm = (n) => (n || "").trim().toUpperCase();
    const existingUpper = new Set(bubbles.map((b) => norm(b.name)));
    const requiredUpper = new Set(
      (items || [])
        .map((it) => norm(it.allocated_to))
        .filter(Boolean)
    );
    // Always ensure defaults exist
    DEFAULT_BUBBLES.forEach((b) => requiredUpper.add(norm(b.name)));

    const toAdd = Array.from(requiredUpper).filter((name) => name && !existingUpper.has(name));
    if (!toAdd.length) return;

    setBubbles((prev) => {
      const names = new Set(prev.map((b) => b.name));
      const additions = toAdd.map((name) => {
        const finalName = uniqueName(name, names);
        names.add(finalName);
        return { id: makeUid(), name: finalName, notes: "" };
      });
      // persist new bubbles to shared
      additions.forEach((b) => {
        if (api?.writeSharedBubbleData) {
          api
            .writeSharedBubbleData({
              bubbleId: b.id,
              name: b.name,
              notes: "",
              extraLines: [],
            })
            .catch((e) => console.warn("[shared-bubble] write failed (auto add)", e));
        }
      });
      const next = [...prev, ...additions];
      return next;
    });
  }, [items, bubbles]);

  useEffect(() => {
    let cancelled = false;
    if (!api?.getArchivePath) return;
    api
      .getArchivePath()
      .then((res) => {
        if (!cancelled && res?.path) setArchivePath(res.path);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    if (!uiStateReady || !api?.writeUIState) return;
    api
        .writeUIState({
          bubblePositions,
          bubbleSizes,
          bubbleZOrder,
          sageIntegrationEnabled,
          archiveCleanupDays,
          printExtraLinesByBubble,
          ordersTodayOnly,
          bubbleMeta,
        })
      .catch((e) => console.warn("[ui-state] write failed", e));
  }, [
    bubblePositions,
      bubbleSizes,
      bubbleZOrder,
      sageIntegrationEnabled,
      archiveCleanupDays,
      printExtraLinesByBubble,
      ordersTodayOnly,
      bubbleMeta,
      uiStateReady,
    ]);

  function persistUIState(nextBubbleMeta) {
    if (!uiStateReady || !api?.writeUIState) return;
      api
        .writeUIState({
          bubblePositions,
          bubbleSizes,
          bubbleZOrder,
          sageIntegrationEnabled,
          archiveCleanupDays,
          printExtraLinesByBubble,
          ordersTodayOnly,
          bubbleMeta: nextBubbleMeta || bubbleMeta,
        })
      .catch((e) => console.warn("[ui-state] write failed", e));
  }
  useEffect(() => {
    setBubbleMeta((prev) => {
      let changed = false;
      const next = { ...prev };
      bubbles.forEach((b) => {
        const meta = next[b.id] || {};
        if (!meta.accountingPath) {
          next[b.id] = { ...meta, accountingPath: ACCOUNTING_PATHS.OUTSTANDING };
          changed = true;
        }
      });
      return changed ? next : prev;
    });
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
    setBubbleZOrder((prev) => {
      const keys = bubbles.map((b) => b.name || b.id);
      const filtered = prev.filter((k) => keys.includes(k));
      const missing = keys.filter((k) => !filtered.includes(k));
      const next = filtered.concat(missing);
      return JSON.stringify(next) === JSON.stringify(prev) ? prev : next;
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
  const printExtraLines = useMemo(() => {
    if (!printBubble) return [];
    return printExtraLinesByBubble[printBubble.id] || [];
  }, [printBubble, printExtraLinesByBubble]);
  const bubblePaymentAssignments = useMemo(() => {
    const map = {};
    bubbles.forEach((b) => {
      const meta = bubbleMeta[b.id] || bubbleMeta[b.name] || {};
      map[b.id] = Array.isArray(meta.paymentIds) ? meta.paymentIds : [];
    });
    return map;
  }, [bubbles, bubbleMeta]);

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
    const paymentMeta = bubbleMeta[bubbleId] || bubbleMeta[bubble.name] || {};
    if (Array.isArray(paymentMeta.paymentIds) && paymentMeta.paymentIds.length) {
      handleUpdateBubblePayments(bubbleId, []);
    }
    const validTargets = DELETE_DESTINATIONS.filter((name) => name !== bubble.name);
      const fallback =
        validTargets.includes(fallbackTargetName) && fallbackTargetName
          ? fallbackTargetName
          : validTargets[0] || "NEW STOCK";
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

    // Remove all traces of the bubble from UI state (positions, sizes, meta, z-order, print extras)
    const cleanedBubbleMeta = { ...bubbleMeta };
    delete cleanedBubbleMeta[bubbleId];
    if (bubble.name) delete cleanedBubbleMeta[bubble.name];

    const cleanedPositions = { ...bubblePositions };
    delete cleanedPositions[bubbleId];
    if (bubble.name) delete cleanedPositions[bubble.name];

    const cleanedSizes = { ...bubbleSizes };
    delete cleanedSizes[bubbleId];
    if (bubble.name) delete cleanedSizes[bubble.name];

    const cleanedZOrder = bubbleZOrder.filter(
      (key) => key !== bubbleId && key !== bubble.name
    );

    const cleanedPrintExtras = { ...printExtraLinesByBubble };
    delete cleanedPrintExtras[bubbleId];

    setBubbleMeta(cleanedBubbleMeta);
    setBubblePositions(cleanedPositions);
    setBubbleSizes(cleanedSizes);
    setBubbleZOrder(cleanedZOrder);
    setPrintExtraLinesByBubble(cleanedPrintExtras);

    persistUIState(cleanedBubbleMeta);
    if (api?.deleteSharedBubbleData) {
      api.deleteSharedBubbleData(bubbleId).catch((e) => console.warn("[shared-bubble] delete failed", e));
      if (bubble?.name) {
        api.deleteSharedBubbleData(bubble.name).catch(() => {});
      }
    }
    _releaseBubbleLockOnDelete(bubbleId);
    markSharedBubbleDeleted(bubble);
  }

  function handleStartBubbleMove(bubbleKey, clientX, clientY) {
    if (!workspaceRef.current) return;
    const rect = workspaceRef.current.getBoundingClientRect();
    const current = bubblePositions[bubbleKey] || { x: 0, y: 0 };
    prevBodyUserSelectRef.current = document.body.style.userSelect;
    document.body.style.userSelect = "none";
    handleActivateBubble(bubbleKey);
    bubbleDragRef.current = {
      key: bubbleKey,
      offsetX: clientX - rect.left - current.x,
      offsetY: clientY - rect.top - current.y,
    };
  }

  function handleStartBubbleResize(bubbleKey, clientX) {
    prevBodyUserSelectRef.current = document.body.style.userSelect;
    document.body.style.userSelect = "none";
    handleActivateBubble(bubbleKey);
    bubbleResizeRef.current = {
      key: bubbleKey,
      startX: clientX,
      startWidth: bubbleSizes[bubbleKey] || 360,
    };
  }

  function handleReturnItemToNewStock(uid) {
    setItems((prev) => {
      const next = prev.map((it) =>
        it.uid === uid
          ? {
              ...it,
              allocated_to: "NEW STOCK",
              accountingPath: ACCOUNTING_PATHS.OUTSTANDING,
              last_moved_at: new Date().toISOString(),
            }
          : it
      );
      ensureBubblesForItems(next, setBubbles);
      return next;
    });
  }

  function handleActivateBubble(bubbleKey) {
    setActiveBubbleKey(bubbleKey);
    setBubbleZOrder((prev) => {
      const keys = bubbles.map((b) => b.name || b.id);
      const filtered = prev.filter((k) => keys.includes(k) && k !== bubbleKey);
      return [...filtered, bubbleKey];
    });
  }

  function handleMoveBubbleAccounting(bubbleId, targetPath) {
    if (!bubbleId || !targetPath) return;
    const bubble = bubbles.find((b) => b.id === bubbleId);
    const nameKey = bubble?.name;
    const now = new Date().toISOString();
    const meta = bubbleMeta[bubbleId] || bubbleMeta[nameKey] || {};
    const nextMeta = {
      ...meta,
      accountingPath: targetPath,
    };
    if (targetPath === ACCOUNTING_PATHS.SAGE_AR) {
      nextMeta.queuedForSageAt = now;
    } else if (targetPath === ACCOUNTING_PATHS.CASH_SALE) {
      nextMeta.movedToCashSalesAt = now;
    }
    const nextBubbleMeta = {
      ...bubbleMeta,
      ...(nameKey ? { [nameKey]: nextMeta } : {}),
      [bubbleId]: nextMeta,
    };
    setBubbleMeta(nextBubbleMeta);
    persistUIState(nextBubbleMeta);
    if (bubble?.name) {
      const updatedItems = items.map((it) =>
        it.allocated_to === bubble.name
          ? { ...it, accountingPath: targetPath, last_moved_at: now }
          : it
      );
      setItems(updatedItems);
      lastSavedRef.current = JSON.stringify(updatedItems);
      api.writeItems(updatedItems);
    }
  }

  function handleUpdateBubblePayments(bubbleId, paymentIds) {
    if (!bubbleId) return;
    const bubble = bubbles.find((b) => b.id === bubbleId);
    const nameKey = bubble?.name;
    const cleanIds = Array.from(new Set((paymentIds || []).filter(Boolean)));
    const meta = bubbleMeta[bubbleId] || bubbleMeta[nameKey] || {};
    const nextMeta = {
      ...meta,
      paymentIds: cleanIds,
    };
    const nextBubbleMeta = {
      ...bubbleMeta,
      ...(nameKey ? { [nameKey]: nextMeta } : {}),
      [bubbleId]: nextMeta,
    };
    setBubbleMeta(nextBubbleMeta);
    persistUIState(nextBubbleMeta);
    persistSharedBubbleSnapshot(bubbleId, { paymentIds: cleanIds });
  }

  async function handleArchiveBubble(bubbleId) {
    const bubble = bubbles.find((b) => b.id === bubbleId);
    if (!bubble) return;
    const bubbleItems = items.filter((it) => it.allocated_to === bubble.name);
    const path = bubbleItems[0]?.accountingPath || ACCOUNTING_PATHS.OUTSTANDING;
    if (path !== ACCOUNTING_PATHS.SAGE_AR && path !== ACCOUNTING_PATHS.CASH_SALE) {
      alert("Archive is only available for Sage AR Queue or Cash Sales bubbles.");
      return;
    }
    const confirmed =
      typeof window === "undefined"
        ? true
        : window.confirm(
            `Archive "${bubble.name}" and ${bubbleItems.length} item(s)? They will be removed from active views and saved to the archive.`
          );
    if (!confirmed) return;
    try {
      const res = await api.archiveBubble({
        bubble,
        meta: bubbleMeta[bubbleId] || bubbleMeta[bubble.name] || {},
        items: bubbleItems,
      });
      if (!res?.ok) throw new Error(res?.error || "Failed to archive bubble.");
      const archivedAt = res.archivedAt || new Date().toISOString();
      const remainingItems = items.filter((it) => it.allocated_to !== bubble.name);
      setItems(remainingItems);
      lastSavedRef.current = JSON.stringify(remainingItems);
      await api.writeItems(remainingItems);
      const paymentMeta = bubbleMeta[bubbleId] || bubbleMeta[bubble.name] || {};
      if (Array.isArray(paymentMeta.paymentIds) && paymentMeta.paymentIds.length) {
        handleUpdateBubblePayments(bubbleId, []);
      }
      setBubbles((prev) => prev.filter((b) => b.id !== bubbleId));

      const cleanedBubbleMeta = { ...bubbleMeta };
      delete cleanedBubbleMeta[bubbleId];
      if (bubble.name) delete cleanedBubbleMeta[bubble.name];

      const cleanedPositions = { ...bubblePositions };
      delete cleanedPositions[bubbleId];
      if (bubble.name) delete cleanedPositions[bubble.name];

      const cleanedSizes = { ...bubbleSizes };
      delete cleanedSizes[bubbleId];
      if (bubble.name) delete cleanedSizes[bubble.name];

      const cleanedZOrder = bubbleZOrder.filter(
        (key) => key !== bubbleId && key !== bubble.name
      );

      const cleanedPrintExtras = { ...printExtraLinesByBubble };
      delete cleanedPrintExtras[bubbleId];

      setBubbleMeta(cleanedBubbleMeta);
      setBubblePositions(cleanedPositions);
      setBubbleSizes(cleanedSizes);
      setBubbleZOrder(cleanedZOrder);
      setPrintExtraLinesByBubble(cleanedPrintExtras);
      setActiveBubbleKey((prev) => (prev === bubbleId || prev === bubble.name ? null : prev));
      persistUIState(cleanedBubbleMeta);
      if (api?.deleteSharedBubbleData) {
        api.deleteSharedBubbleData(bubbleId).catch((e) => console.warn("[shared-bubble] delete failed", e));
        if (bubble?.name) {
          api.deleteSharedBubbleData(bubble.name).catch(() => {});
        }
      }
      _releaseBubbleLockOnDelete(bubbleId);
      markSharedBubbleDeleted(bubble);
    } catch (e) {
      console.error("[archive] failed", e);
      alert(e?.message || "Failed to archive bubble.");
    }
  }

  async function handleDeleteBubbleItems(bubbleId) {
    const bubble = bubbles.find((b) => b.id === bubbleId);
    if (!bubble) return;
    const bubbleItems = items.filter((it) => it.allocated_to === bubble.name);
    const confirmed = window.confirm(
      `Permanently delete "${bubble.name}" and ${bubbleItems.length} item(s)? This cannot be undone.`
    );
    if (!confirmed) return;
    try {
      const remainingItems = items.filter((it) => it.allocated_to !== bubble.name);
      setItems(remainingItems);
      lastSavedRef.current = JSON.stringify(remainingItems);
      await api.writeItems(remainingItems);
      const paymentMeta = bubbleMeta[bubbleId] || bubbleMeta[bubble.name] || {};
      if (Array.isArray(paymentMeta.paymentIds) && paymentMeta.paymentIds.length) {
        handleUpdateBubblePayments(bubbleId, []);
      }
      setBubbles((prev) => prev.filter((b) => b.id !== bubbleId));
      const cleanedBubbleMeta = { ...bubbleMeta };
      delete cleanedBubbleMeta[bubbleId];
      if (bubble.name) delete cleanedBubbleMeta[bubble.name];
      const cleanedPositions = { ...bubblePositions };
      delete cleanedPositions[bubbleId];
      if (bubble.name) delete cleanedPositions[bubble.name];
      const cleanedSizes = { ...bubbleSizes };
      delete cleanedSizes[bubbleId];
      if (bubble.name) delete cleanedSizes[bubble.name];
      const cleanedZOrder = bubbleZOrder.filter(
        (key) => key !== bubbleId && key !== bubble.name
      );
      const cleanedPrintExtras = { ...printExtraLinesByBubble };
      delete cleanedPrintExtras[bubbleId];
      setBubbleMeta(cleanedBubbleMeta);
      setBubblePositions(cleanedPositions);
      setBubbleSizes(cleanedSizes);
      setBubbleZOrder(cleanedZOrder);
      setPrintExtraLinesByBubble(cleanedPrintExtras);
      setActiveBubbleKey((prev) => (prev === bubbleId || prev === bubble.name ? null : prev));
      persistUIState(cleanedBubbleMeta);
      if (api?.deleteSharedBubbleData) {
        api.deleteSharedBubbleData(bubbleId).catch((e) => console.warn("[shared-bubble] delete failed", e));
        if (bubble?.name) api.deleteSharedBubbleData(bubble.name).catch(() => {});
      }
      _releaseBubbleLockOnDelete(bubbleId);
      markSharedBubbleDeleted(bubble);
    } catch (e) {
      console.error("[delete-bubble] failed", e);
      alert(e?.message || "Failed to delete bubble.");
    }
  }

  function handleOpenPrint(bubble) {
    if (!bubble || DEFAULT_BUBBLE_NAMES.has(bubble.name)) return;
    setPrintBubbleId(bubble.id);
    setPrintGeneratedAt(new Date());
  }

  function handleAddExtraLine() {
    if (!printBubble) return;
    setPrintExtraLinesByBubble((prev) => {
      const current = prev[printBubble.id] || [];
      const nextLine = {
        id: makeUid(),
        description: "",
        quantity: 1,
        unitPrice: "",
        taxable: true,
        partLineCode: "",
      };
      const nextLines = [...current, nextLine];
      return { ...prev, [printBubble.id]: nextLines };
    });
  }

  function handleUpdateExtraLine(lineId, patch) {
    if (!printBubble) return;
    setPrintExtraLinesByBubble((prev) => {
      const current = prev[printBubble.id] || [];
      const next = current.map((line) =>
        line.id === lineId ? { ...line, ...patch } : line
      );
      return { ...prev, [printBubble.id]: next };
    });
  }

  function handleRemoveExtraLine(lineId) {
    if (!printBubble) return;
    setPrintExtraLinesByBubble((prev) => {
      const current = prev[printBubble.id] || [];
      const next = current.filter((line) => line.id !== lineId);
      return { ...prev, [printBubble.id]: next };
    });
  }

  function handleClosePrint() {
    if (printBubble) {
      persistSharedBubbleSnapshot(printBubble.id, { extraLines: printExtraLinesByBubble[printBubble.id] || [] });
    }
    setPrintBubbleId(null);
    setPrintGeneratedAt(null);
  }

  function handleConfirmPrint() {
    if (!printBubble || (printItems.length === 0 && printExtraLines.length === 0))
      return;
    const todayStr = new Date().toLocaleDateString("en-CA");
    if (printItems.length) {
      const ids = new Set(printItems.map((it) => it.uid));
      setItems((prev) =>
        prev.map((it) => (ids.has(it.uid) ? { ...it, sold_date: todayStr } : it))
      );
    }
    setPrintGeneratedAt(new Date());
    persistSharedBubbleSnapshot(printBubble.id, { extraLines: printExtraLinesByBubble[printBubble.id] || [] });
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
      await refreshItemsIfPending();
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
    await refreshItemsIfPending();
  }

  async function refreshItemsIfPending() {
    if (!pendingItemsRefreshRef.current) return;
    try {
      const latest = await api.readItems();
      const norm = normalizeItems(latest || []);
      setItems((prev) => {
        const merged = mergeItems(prev, norm);
        lastSavedRef.current = JSON.stringify(merged);
        ensureBubblesForItems(merged, setBubbles);
        return merged;
      });
    } catch (e) {
      console.error("[items] refresh after edit failed", e);
    } finally {
      pendingItemsRefreshRef.current = false;
    }
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

  function updateOrderByKey(key, patch) {
    if (!key) return;
    setOrders((prev) => {
      let changed = false;
      const next = prev.map((o) => {
        if (!o) return o;
        const refMatch =
          o.reference &&
          String(o.reference).trim().toUpperCase() === String(key).trim().toUpperCase();
        const rowMatch = o.__row && String(o.__row) === String(key);
          if (!refMatch && !rowMatch) return o;
          changed = true;
          const patchVal = typeof patch === "function" ? patch(o) : patch || {};
          return {
            ...o,
            ...(patchVal || {}),
            lastUpdatedAt: new Date().toISOString(),
            _localDirty: true,
          };
        });
      if (changed) setOrdersDirty(true);
      return next;
    });
  }
  function handleOrderFieldChange(referenceKey, field, value) {
    updateOrderByKey(referenceKey, { [field]: value });
  }
  function handleOrderInvoiceChange(referenceKey, value) {
    updateOrderByKey(referenceKey, { source_invoice: value, sage_reference: value });
  }
  function handleOrderCheckboxChange(referenceKey, field, checked) {
    if (field === "inStore") {
      // Marking as arrived should also mark as picked up.
      updateOrderByKey(referenceKey, { inStore: checked, pickedUp: checked || false });
    } else if (field === "totalVerified" && checked) {
      updateOrderByKey(referenceKey, { [field]: checked, valueCheckAlert: false });
    } else {
      updateOrderByKey(referenceKey, { [field]: checked });
    }
  }
  function handleMarkComplete(referenceKey) {
    updateOrderByKey(referenceKey, (order) => {
      const hasInvoice = Boolean((order?.source_invoice || "").toString().trim());
      return {
        pickedUp: true,
        hasInvoiceNum: true,
        totalVerified: true,
        enteredInSage: true,
        inStore: true,
        source_invoice: hasInvoice ? order.source_invoice : "manual",
        status: "complete",
      };
    });
  }
  function handleOrderSageTrigger(referenceKey) {
    updateOrderByKey(referenceKey, { sage_trigger: true });
  }

  function handleRenameBubble(bubbleId, newName) {
    const trimmed = newName.trim();
    if (!trimmed) return;
    const bubble = bubbles.find((b) => b.id === bubbleId);
    if (!bubble) return;
    const oldName = bubble.name;
    if (trimmed === oldName) return;
    if (DEFAULT_BUBBLE_NAMES.has(trimmed.toUpperCase())) return;
    const taken = bubbles.some((b) => b.id !== bubbleId && (b.name || '').toUpperCase() === trimmed.toUpperCase());
    if (taken) { alert(`A bubble named "${trimmed}" already exists.`); return; }

    const renamedItems = items.map((it) =>
      it.allocated_to === oldName ? { ...it, allocated_to: trimmed } : it
    );
    lastSavedRef.current = JSON.stringify(renamedItems);
    setItems(renamedItems);
    setBubbles((prev) => prev.map((b) => b.id === bubbleId ? { ...b, name: trimmed } : b));
    api.writeItems(renamedItems).catch((e) => console.error('[rename] writeItems failed', e));
    setBubblePositions((prev) => {
      if (!prev[oldName]) return prev;
      const next = { ...prev, [trimmed]: prev[oldName] };
      delete next[oldName];
      return next;
    });
    setBubbleSizes((prev) => {
      if (!prev[oldName]) return prev;
      const next = { ...prev, [trimmed]: prev[oldName] };
      delete next[oldName];
      return next;
    });
    if (api?.writeSharedBubbleData) {
      api.writeSharedBubbleData({ bubbleId, name: trimmed, notes: bubble.notes || '', extraLines: [] })
        .catch(() => {});
      api.deleteSharedBubbleData?.(oldName).catch(() => {});
    }
  }

  async function handleBubblifyOrder(refKey) {
    const base = (refKey || 'ORDER').toUpperCase();
    const existingNames = new Set(bubbles.map((b) => (b.name || '').toUpperCase()));
    const bubbleName = uniqueName(base, existingNames);
    const id = makeUid();
    const nb = { id, name: bubbleName, notes: '' };
    setBubbles((prev) => [...prev, nb]);
    setBubbleMeta((prev) => ({
      ...prev,
      [id]: { ...(prev[id] || {}), accountingPath: ACCOUNTING_PATHS.OUTSTANDING },
    }));
    if (api?.writeSharedBubbleData) {
      api.writeSharedBubbleData({ bubbleId: id, name: bubbleName, notes: '', extraLines: [] })
        .catch((e) => console.warn('[shared-bubble] write failed', e));
    }
    const res = await api.bubblifyOrder(refKey, bubbleName);
    if (!res?.ok) {
      alert(res?.error || 'Failed to bubblify order.');
      setBubbles((prev) => prev.filter((b) => b.id !== id));
      setBubbleMeta((prev) => { const n = { ...prev }; delete n[id]; return n; });
      return;
    }
    if (res.added === 0) {
      alert('All items in this order have already been added to outstanding.');
      setBubbles((prev) => prev.filter((b) => b.id !== id));
      setBubbleMeta((prev) => { const n = { ...prev }; delete n[id]; return n; });
      return;
    }
    const freshItems = await api.readItems();
    if (Array.isArray(freshItems)) {
      setItems(freshItems);
      lastSavedRef.current = JSON.stringify(freshItems);
    }
  }

  async function handleReconcileTotals(referenceKey) {
    try {
      setOrdersError(null);
      const normalizedKey = String(referenceKey || "").trim().toUpperCase();
      const currentOrder = (orders || []).find((o) => {
        if (!o) return false;
        const cand = (o.sage_reference || o.reference || o.__row || "").toString().trim().toUpperCase();
        return cand && cand === normalizedKey;
      });
      const res = await api?.reconcileTotals?.(referenceKey, currentOrder);
      if (!res?.ok) {
        setOrdersError(res?.error || "Failed to reconcile totals.");
        return;
      }
      await loadOrders();
    } catch (e) {
      setOrdersError(e?.message || "Failed to reconcile totals.");
    }
  }

  function handleSageIntegrationToggleClick() {
    const timestamp = new Date().toISOString();
    const readyCount = Array.isArray(sageReadyOrders) ? sageReadyOrders.length : 0;
    console.log("[sage-ui] Run Sage / AHK button clicked", {
      timestamp,
      sageReadyCount: readyCount,
    });
    setSageIntegrationEnabled((v) => !v);
  }

  function handleOrdersUpdatedExternally(list) {
    const normalized = Array.isArray(list) ? list : [];
    setSageReadyOrders(
      normalized.filter((o) => o && o.sage_trigger && !o.enteredInSage)
    );
    if (ordersDirty) {
      console.log("[orders] external update skipped (local edits present)");
      return;
    }
    setOrders(normalized);
    ordersLastSavedRef.current = JSON.stringify(normalized);
    setOrdersInitialized(true);
    setOrdersDirty(false);
  }

  async function handleSaveOrders() {
    if (!ordersDirty || ordersSaving) return;
    try {
      setOrdersSaving(true);
      setOrdersError(null);
      const normalized = (orders || []).map((o) => {
        const invFilled = Boolean((o?.source_invoice || "").trim());
        const { _localDirty, ...rest } = o || {};
        return { ...rest, hasInvoiceNum: invFilled };
      });
      const res = await api?.writeOrders?.(normalized);
      if (!res?.ok) {
        throw new Error("Failed to save orders.");
      }
      setOrders(normalized);
      ordersLastSavedRef.current = JSON.stringify(normalized);
      setOrdersDirty(false);
    } catch (e) {
      console.error("[orders] save error", e);
      setOrdersError(e?.message || "Failed to save orders.");
    } finally {
      setOrdersSaving(false);
    }
  }

  async function handleArchiveOrders() {
    if (!api?.archiveOrders) return;
    try {
      setOrdersArchiveRunning(true);
      setOrdersArchiveError("");
      setOrdersArchiveStatus("");
      const res = await api.archiveOrders({ minDays: archiveCleanupDays });
      if (!res?.ok) throw new Error(res?.error || "Failed to archive completed orders.");
      setOrdersArchiveStatus(`Archived ${res.archived || 0} order(s).`);
      await loadOrders();
    } catch (e) {
      setOrdersArchiveError(e?.message || "Failed to archive completed orders.");
    } finally {
      setOrdersArchiveRunning(false);
    }
  }

  async function handleArchiveOrder(refKey) {
    if (!api?.archiveOrder) return;
    try {
      setOrdersError(null);
      const res = await api.archiveOrder(refKey);
      if (!res?.ok) throw new Error(res?.error || "Failed to archive order.");
      await loadOrders();
    } catch (e) {
      setOrdersError(e?.message || "Failed to archive order.");
    }
  }

  async function handleGetWorldOrders() {
    if (!api?.fetchWorldOrders) return;
    try {
      setWorldOrdersRunning(true);
      setWorldOrdersError("");
      setWorldOrdersStatus("");
      setOrdersError(null);
      const res = await api.fetchWorldOrders();
      if (!res?.ok) {
        throw new Error(res?.error || "Failed to fetch World orders.");
      }
      const list = Array.isArray(res.orders) ? res.orders : [];
      setOrders(list);
      ordersLastSavedRef.current = JSON.stringify(list);
      setOrdersDirty(false);
      setOrdersInitialized(true);
      if (res.path) setOrdersSourcePath(res.path);
      const baseMsg = `Fetched ${res.count ?? list.length} orders and saved to ${res.path || "orders.json"}.`;
      const logMsg = Array.isArray(res.statusLog) && res.statusLog.length
        ? `\n${res.statusLog.join("\n")}`
        : "";
      setWorldOrdersStatus(baseMsg + logMsg);
    } catch (e) {
      console.error("[orders] world fetch error", e);
      setWorldOrdersError(e?.message || "Failed to fetch World orders.");
    } finally {
      setWorldOrdersRunning(false);
    }
  }

  async function handleGetCbkOrders() {
    if (!api?.fetchCbkOrders) return;
    try {
      setCbkOrdersRunning(true);
      setCbkOrdersError("");
      setCbkOrdersStatus("");
      setOrdersError(null);
      const res = await api.fetchCbkOrders();
      if (!res?.ok) {
        throw new Error(res?.error || "Failed to fetch CBK orders.");
      }
      const list = Array.isArray(res.orders) ? res.orders : [];
      setOrders(list);
      ordersLastSavedRef.current = JSON.stringify(list);
      setOrdersDirty(false);
      setOrdersInitialized(true);
      if (res.path) setOrdersSourcePath(res.path);
      const baseMsg = `Fetched ${list.length} CBK order(s) and saved to ${res.path || "orders.json"}.`;
      const logMsg =
        Array.isArray(res.statusLog) && res.statusLog.length ? `\n${res.statusLog.join("\n")}` : "";
      setCbkOrdersStatus(baseMsg + logMsg);
    } catch (e) {
      console.error("[orders] cbk fetch error", e);
      setCbkOrdersError(e?.message || "Failed to fetch CBK orders.");
    } finally {
      setCbkOrdersRunning(false);
    }
  }

  async function handleGetBestBuyOrders() {
    if (!api?.fetchBestBuyOrders) return;
    try {
      setBestBuyOrdersRunning(true);
      setBestBuyOrdersError("");
      setBestBuyOrdersStatus("");
      setOrdersError(null);
      const res = await api.fetchBestBuyOrders();
      if (!res?.ok) {
        throw new Error(res?.error || "Failed to fetch BestBuy orders.");
      }
      const list = Array.isArray(res.orders) ? res.orders : [];
      setOrders(list);
      ordersLastSavedRef.current = JSON.stringify(list);
      setOrdersDirty(false);
      setOrdersInitialized(true);
      if (res.path) setOrdersSourcePath(res.path);
      const baseMsg = `Fetched ${list.length} BestBuy order(s) and saved to ${res.path || "orders.json"}.`;
      const logMsg =
        Array.isArray(res.statusLog) && res.statusLog.length ? `\n${res.statusLog.join("\n")}` : "";
      setBestBuyOrdersStatus(baseMsg + logMsg);
    } catch (e) {
      console.error("[orders] bestbuy fetch error", e);
      setBestBuyOrdersError(e?.message || "Failed to fetch BestBuy orders.");
    } finally {
      setBestBuyOrdersRunning(false);
    }
  }

  async function handleGetTransbecOrders() {
    if (!api?.fetchTransbecOrders) return;
    try {
      setTransbecOrdersRunning(true);
      setTransbecOrdersError("");
      setTransbecOrdersStatus("");
      setOrdersError(null);
      const res = await api.fetchTransbecOrders();
      if (!res?.ok) {
        throw new Error(res?.error || "Failed to fetch Transbec orders.");
      }
      const list = Array.isArray(res.orders) ? res.orders : [];
      setOrders(list);
      ordersLastSavedRef.current = JSON.stringify(list);
      setOrdersDirty(false);
      setOrdersInitialized(true);
      if (res.path) setOrdersSourcePath(res.path);
      const baseMsg = `Fetched ${list.length} Transbec order(s) and saved to ${res.path || "orders.json"}.`;
      const logMsg =
        Array.isArray(res.statusLog) && res.statusLog.length ? `\n${res.statusLog.join("\n")}` : "";
      setTransbecOrdersStatus(baseMsg + logMsg);
    } catch (e) {
      console.error("[orders] transbec fetch error", e);
      setTransbecOrdersError(e?.message || "Failed to fetch Transbec orders.");
    } finally {
      setTransbecOrdersRunning(false);
    }
  }

  async function handleGetProforceOrders() {
    if (!api?.fetchProforceOrders) return;
    try {
      setProforceRunning(true);
      setProforceError("");
      setProforceStatus("");
      setOrdersError(null);
      const res = await api.fetchProforceOrders();
      if (!res?.ok) throw new Error(res?.error || "Failed to fetch Proforce orders.");
      const list = Array.isArray(res.orders) ? res.orders : [];
      setOrders(list);
      ordersLastSavedRef.current = JSON.stringify(list);
      setOrdersDirty(false);
      setOrdersInitialized(true);
      if (res.path) setOrdersSourcePath(res.path);
      const baseMsg = `Fetched ${list.length} Proforce order(s) and saved to ${res.path || "orders.json"}.`;
      const logMsg =
        Array.isArray(res.statusLog) && res.statusLog.length ? `\n${res.statusLog.join("\n")}` : "";
      setProforceStatus(baseMsg + logMsg);
    } catch (e) {
      console.error("[orders] proforce fetch error", e);
      setProforceError(e?.message || "Failed to fetch Proforce orders.");
    } finally {
      setProforceRunning(false);
    }
  }

  async function handleAddOutstanding() {
    if (!api?.addOrdersToOutstanding) return;
    try {
      setOutstandingRunning(true);
      setOutstandingError("");
      setOutstandingStatus("");
      const res = await api.addOrdersToOutstanding();
      if (!res?.ok) throw new Error(res?.error || "Failed to add outstanding items.");
      setOutstandingStatus(`Added ${res.added ?? 0} outstanding line(s).`);

      // Pull fresh outstanding items immediately (fs.watch can be skipped while editing)
      const latestItems = await api.readItems();
      const normItems = normalizeItems(latestItems || []);
      setItems((prev) => {
        const merged = mergeItems(prev, normItems);
        lastSavedRef.current = JSON.stringify(merged);
        ensureBubblesForItems(merged, setBubbles);
        return merged;
      });

      if (ordersInitialized) {
        // refresh orders so addedToOutstanding flags are reflected
        const refreshed = await api.readOrders();
        setOrders(Array.isArray(refreshed) ? refreshed : []);
      }
    } catch (e) {
      console.error("[outstanding] add error", e);
      setOutstandingError(e?.message || "Failed to add outstanding items.");
    } finally {
      setOutstandingRunning(false);
    }
  }

  async function handleArchiveSearch() {
    const hasTerm = archiveSearchTerm.trim() || archiveBubbleSearch.trim();
    if (!hasTerm) {
      setArchiveError("Enter a part/description or bubble/customer name to search.");
      setArchiveResults([]);
      return;
    }
    try {
      setArchiveError("");
      setArchiveSearching(true);
      const res = await api.searchArchive({
        term: archiveSearchTerm,
        bubbleName: archiveBubbleSearch,
      });
      if (!res?.ok) throw new Error(res?.error || "Archive search failed.");
      setArchiveResults(res.results || []);
    } catch (e) {
      console.error("[archive search]", e);
      setArchiveError(e?.message || "Failed to search archive.");
      setArchiveResults([]);
    } finally {
      setArchiveSearching(false);
    }
  }

  useEffect(() => {
    if (!api?.watchOrders || !api?.onOrdersUpdated) {
      if (sageIntegrationEnabled) {
        setSageWatchError("Orders watching is unavailable in this environment.");
      }
      return;
    }

    let cancelled = false;
    let offOrdersUpdated = null;

    if (!sageIntegrationEnabled) {
      setSageReadyOrders([]);
      setSageWatchError("");
      api.watchOrders(false).catch(() => {});
      return;
    }

    setSageWatchError("");
    offOrdersUpdated = api.onOrdersUpdated((arr) => handleOrdersUpdatedExternally(arr));

    async function bootstrapWatch() {
      try {
        const res = await api.watchOrders(true);
        if (res && !res.ok) {
          if (!cancelled) {
            if (res.error === 'sage-locked') {
              setSageWatchError(`Sage Interface is active on another machine (${res.lockedBy || 'unknown'}). Turn it off there first.`);
            } else {
              setSageWatchError(res.error || "Failed to watch orders file.");
            }
            setSageIntegrationEnabled(false);
          }
          return;
        }
        const latest = await api.readOrders();
        if (!cancelled) {
          handleOrdersUpdatedExternally(latest);
        }
      } catch (e) {
        console.error("[orders] watch error", e);
        if (!cancelled) setSageWatchError(e?.message || "Failed to watch orders file.");
      }
    }
    bootstrapWatch();

    return () => {
      cancelled = true;
      if (offOrdersUpdated) offOrdersUpdated();
      api.watchOrders(false).catch(() => {});
    };
  }, [sageIntegrationEnabled, ordersDirty]);

  // Subscribe to sage lock changes pushed from main process
  useEffect(() => {
    if (!api?.onSageLockChanged) return;
    const off = api.onSageLockChanged((data) => {
      setSageLockInfo(data ? { lock: data.lock, ownMachineId: data.ownMachineId } : null);
      if (data?.lockedByOther && sageIntegrationEnabled) {
        setSageIntegrationEnabled(false);
        setSageWatchError(`Sage Interface was claimed by ${data.lock?.machineId || 'another machine'}.`);
      }
    });
    // Load initial lock state
    api.getSageLock?.().then((res) => {
      if (res?.ok) setSageLockInfo({ lock: res.lock, ownMachineId: res.ownMachineId });
    }).catch(() => {});
    return () => off?.();
  }, []);

  // ---- Bubble edit locks ----
  const BUBBLE_LOCK_STALE_MS = 10000;

  // Which bubble IDs this machine currently owns (derived from lock file)
  const myEditingBubbleIds = React.useMemo(() => {
    if (!ownMachineId) return new Set();
    const now = Date.now();
    return new Set(
      Object.entries(bubbleLocks)
        .filter(([, l]) => l.owner === ownMachineId && (now - (l.lastActive || 0)) < BUBBLE_LOCK_STALE_MS)
        .map(([id]) => id)
    );
  }, [bubbleLocks, ownMachineId]);

  // Load initial lock state
  useEffect(() => {
    if (!api?.getBubbleLocks) return;
    api.getBubbleLocks().then((res) => {
      if (res?.locks) setBubbleLocks(res.locks);
      if (res?.ownMachineId) setOwnMachineId(res.ownMachineId);
    }).catch(() => {});
  }, []);

  // Subscribe to lock file changes pushed from main process
  useEffect(() => {
    if (!api?.onBubbleLocksUpdated) return;
    const off = api.onBubbleLocksUpdated(({ locks, ownMachineId: mid }) => {
      setBubbleLocks(locks || {});
      if (mid) setOwnMachineId(mid);

      const pending = pendingRequestsRef.current;
      Object.entries(pending).forEach(([bubbleId, req]) => {
        const lock = (locks || {})[bubbleId];
        if (!lock) return;
        if (lock.owner === mid) {
          // Our request was granted (or force-claim was confirmed)
          clearTimeout(req.timeoutId);
          delete pending[bubbleId];
          setPendingRequestBubbles((prev) => { const n = new Set(prev); n.delete(bubbleId); return n; });
        } else if (lock.request?.status === 'denied' && lock.request?.from === mid) {
          // Explicitly denied
          clearTimeout(req.timeoutId);
          delete pending[bubbleId];
          setPendingRequestBubbles((prev) => { const n = new Set(prev); n.delete(bubbleId); return n; });
          alert(`Access to bubble "${lock.bubbleName || bubbleId}" was denied.`);
        }
      });
    });
    return () => off?.();
  }, []);

  // Heartbeat — keep owned bubbles fresh every 3s
  useEffect(() => {
    const ids = Array.from(myEditingBubbleIds);
    if (ids.length === 0) return;
    const interval = setInterval(() => {
      ids.forEach((id) => api.heartbeatBubbleLock?.(id).catch(() => {}));
    }, 3000);
    return () => clearInterval(interval);
  }, [myEditingBubbleIds]);

  // Release all locks when window closes
  useEffect(() => {
    const release = () => {
      myEditingBubbleIds.forEach((id) => api.releaseBubbleLock?.(id).catch(() => {}));
    };
    window.addEventListener('beforeunload', release);
    return () => window.removeEventListener('beforeunload', release);
  }, [myEditingBubbleIds]);

  async function handleRequestBubbleEdit(bubbleId, bubbleName) {
    try {
      const res = await api.claimBubbleLock(bubbleId, bubbleName);
      if (res?.ok && res?.claimed) {
        setBubbleLocks((prev) => ({
          ...prev,
          [bubbleId]: { owner: ownMachineId, bubbleName, lastActive: Date.now(), request: null },
        }));
        return;
      }
      if (!res?.ok && res?.requested) {
        // Start 5-second countdown then force-claim
        const timeoutId = setTimeout(async () => {
          try {
            const r = await api.claimBubbleLock(bubbleId, bubbleName, { force: true });
            if (r?.ok) {
              setBubbleLocks((prev) => ({
                ...prev,
                [bubbleId]: { owner: ownMachineId, bubbleName, lastActive: Date.now(), request: null },
              }));
            }
          } catch {}
          delete pendingRequestsRef.current[bubbleId];
          setPendingRequestBubbles((prev) => { const n = new Set(prev); n.delete(bubbleId); return n; });
        }, 5000);
        pendingRequestsRef.current[bubbleId] = { startedAt: Date.now(), timeoutId };
        setPendingRequestBubbles((prev) => new Set([...prev, bubbleId]));
      }
    } catch (e) {
      console.error('[bubble-lock] claim error', e);
    }
  }

  async function handleDoneBubbleEdit(bubbleId) {
    try { await api.releaseBubbleLock(bubbleId); } catch {}
    _clearBubbleLockLocally(bubbleId);
  }

  // Called when a bubble is destroyed — force-removes the lock regardless of who owns it
  function _releaseBubbleLockOnDelete(bubbleId) {
    api.releaseBubbleLock?.(bubbleId, { force: true }).catch(() => {});
    _clearBubbleLockLocally(bubbleId);
  }

  function _clearBubbleLockLocally(bubbleId) {
    setBubbleLocks((prev) => { const n = { ...prev }; delete n[bubbleId]; return n; });
    const pending = pendingRequestsRef.current;
    if (pending[bubbleId]) {
      clearTimeout(pending[bubbleId].timeoutId);
      delete pending[bubbleId];
      setPendingRequestBubbles((prev) => { const n = new Set(prev); n.delete(bubbleId); return n; });
    }
  }

  async function handleRespondToBubbleRequest(bubbleId, allow) {
    try { await api.respondToBubbleRequest(bubbleId, allow); } catch {}
    // If we denied, we keep ownership; if we allowed, watcher will update our locks
  }

  useEffect(() => {
    const needsOrders = currentView === "order-management" || currentView === "ref-to-inv";
    if (needsOrders && !ordersInitialized && !ordersLoading) {
      loadOrders();
    }
  }, [currentView, ordersInitialized, ordersLoading]);

  useEffect(() => {
    setSageReadyOrders((orders || []).filter((o) => o && o.sage_trigger));
  }, [orders]);

  const filteredOrders = useMemo(() => {
    const q = ordersSearch.trim().toLowerCase();
    const filtered = !q
      ? orders
      : orders.filter((order) => {
          const fields = [
            order.reference,
            order.warehouse,
            order.source_invoice,
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

    const pickupFiltered = filtered.filter((order) => {
      if (order?._localDirty) return true;
      switch (ordersPickupFilter) {
        case "not-picked":
          return !order.pickedUp;
        case "not-arrived":
          return !order.inStore;
        case "not-entered-sage":
          return !order.enteredInSage;
        case "totals-not-verified":
          return order.enteredInSage && !order.totalVerified;
        case "no-invoice": {
          const inv = (order.source_invoice || "").toString().trim();
          return order.enteredInSage && !inv;
        }
        default:
          return true;
      }
    });

    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();

    const todayFiltered = ordersTodayOnly
      ? pickupFiltered.filter((order) => {
          const raw = order?.orderDate || order?.orderDateRaw;
          const time = new Date(raw || 0).getTime();
          if (Number.isNaN(time)) return false;
          return time >= todayStart && time < todayEnd;
        })
      : pickupFiltered;

    // sort by orderDate descending (newest first), fallback to orderDateRaw string
    return [...(todayFiltered || [])].sort((a, b) => {
      const da = new Date(a?.orderDate || a?.orderDateRaw || 0).getTime();
      const db = new Date(b?.orderDate || b?.orderDateRaw || 0).getTime();
      if (Number.isNaN(da) && Number.isNaN(db)) return 0;
      if (Number.isNaN(da)) return 1;
      if (Number.isNaN(db)) return -1;
      return db - da;
    });
  }, [orders, ordersSearch, ordersPickupFilter, ordersTodayOnly]);

  const hasSearch = ordersSearch.trim().length > 0;


  const currentViewMeta = VIEWS.find((v) => v.id === currentView);
  const isBubbleFlowView =
    currentView === "stock-flow" ||
    currentView === "sage-ar-queue" ||
    currentView === "cash-sale-flow";

  return (
    <div className="min-h-screen w-full bg-gradient-to-br from-fuchsia-100 via-sky-100 to-emerald-100">
      <div className="w-full px-4 sm:px-6 lg:px-8 space-y-6">
        <header className="bg-white/70 rounded-3xl shadow border border-white/60">
          <div className="w-full flex flex-col gap-4 p-4 sm:flex-col sm:items-start sm:justify-start">
            <div className="shrink-0 text-left">
              <h1 className="text-2xl sm:text-3xl font-bold text-slate-800">
                Business Control Center
              </h1>
              <p className="text-sm text-slate-500">Manage pipelines, orders, and payments from one dashboard.</p>
            </div>
            <ViewTabs currentView={currentView} onSelect={setCurrentView} />
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
            onGetWorldOrders={handleGetWorldOrders}
            worldOrdersRunning={worldOrdersRunning}
            worldOrdersStatus={worldOrdersStatus}
            worldOrdersError={worldOrdersError}
            onGetCbkOrders={handleGetCbkOrders}
            cbkOrdersRunning={cbkOrdersRunning}
            cbkOrdersStatus={cbkOrdersStatus}
            cbkOrdersError={cbkOrdersError}
            onGetBestBuyOrders={handleGetBestBuyOrders}
            bestBuyOrdersRunning={bestBuyOrdersRunning}
            bestBuyOrdersStatus={bestBuyOrdersStatus}
            bestBuyOrdersError={bestBuyOrdersError}
            onGetTransbecOrders={handleGetTransbecOrders}
            transbecOrdersRunning={transbecOrdersRunning}
            transbecOrdersStatus={transbecOrdersStatus}
            transbecOrdersError={transbecOrdersError}
            onGetProforceOrders={handleGetProforceOrders}
            proforceRunning={proforceRunning}
            proforceStatus={proforceStatus}
            proforceError={proforceError}
            onAddOutstanding={handleAddOutstanding}
            outstandingRunning={outstandingRunning}
            outstandingStatus={outstandingStatus}
            outstandingError={outstandingError}
            onArchiveOrders={handleArchiveOrders}
            ordersArchiveRunning={ordersArchiveRunning}
            ordersArchiveStatus={ordersArchiveStatus}
            ordersArchiveError={ordersArchiveError}
            archiveCleanupDays={archiveCleanupDays}
            setArchiveCleanupDays={setArchiveCleanupDays}
            sageIntegrationEnabled={sageIntegrationEnabled}
            setSageIntegrationEnabled={handleSageIntegrationToggleClick}
            sageLockInfo={sageLockInfo}
            sageReadyOrders={sageReadyOrders}
            sageWatchError={sageWatchError}
          />
        ) : isBubbleFlowView ? (
          <StockFlowView
            newBubbleName={newBubbleName}
            setNewBubbleName={setNewBubbleName}
            handleFieldFocus={handleFieldFocus}
            handleFieldBlur={handleFieldBlur}
            addBubble={addBubble}
            showCreateBubble={currentView === "stock-flow"}
            bubbles={bubblesForView}
            bubblePositions={bubblePositions}
            bubbleSizes={bubbleSizes}
            bubbleZOrder={bubbleZOrder}
            extraLinesByBubble={printExtraLinesByBubble}
            activeBubbleKey={activeBubbleKey}
            workspaceRef={workspaceRef}
            printBubble={printBubble}
            itemsByBubble={itemsByBubbleForView}
            expanded={expanded}
            toggleExpand={toggleExpand}
            onDragStartItem={onDragStartItem}
            onDropOnBubble={onDropOnBubble}
            onUpdateItem={updateItemByKey}
            onUpdateBubbleNotes={updateBubbleNotes}
            onBubbleNotesBlur={handleBubbleNotesBlur}
            onRequestPrint={handleOpenPrint}
            onEditItem={handleStartEdit}
            onSplitItem={handleSplitItem}
            onConsolidateItems={handleConsolidateBubbleItems}
            onDeleteBubble={handleDeleteBubble}
            deleteTargets={DELETE_DESTINATIONS}
            defaultBubbleNames={DEFAULT_BUBBLE_NAMES}
            onStartBubbleMove={handleStartBubbleMove}
            onStartBubbleResize={handleStartBubbleResize}
            onActivateBubble={handleActivateBubble}
            onMoveBubbleToSage={(bubbleId) =>
              handleMoveBubbleAccounting(bubbleId, ACCOUNTING_PATHS.SAGE_AR)
            }
            onMoveBubbleToCashSales={(bubbleId) =>
              handleMoveBubbleAccounting(bubbleId, ACCOUNTING_PATHS.CASH_SALE)
            }
            archivableBubbleIds={archivableBubbleIds}
            onArchiveBubble={handleArchiveBubble}
            onDeleteBubbleItems={currentView === "cash-sale-flow" ? handleDeleteBubbleItems : undefined}
            onRenameBubble={handleRenameBubble}
            bubbleLocks={bubbleLocks}
            myEditingBubbleIds={myEditingBubbleIds}
            pendingRequestBubbles={pendingRequestBubbles}
            onRequestBubbleEdit={handleRequestBubbleEdit}
            onDoneBubbleEdit={handleDoneBubbleEdit}
            onRespondToBubbleRequest={handleRespondToBubbleRequest}
            showCashSalesMetrics={currentView === "cash-sale-flow"}
            payments={payments}
            paymentsLoading={paymentsLoading}
            paymentsError={paymentsError}
            bubblePaymentAssignments={bubblePaymentAssignments}
            onUpdateBubblePayments={handleUpdateBubblePayments}
            showSageSalesAction={currentView === "sage-ar-queue" || currentView === "cash-sale-flow"}
            defaultSageCustomerCode={currentView === "cash-sale-flow" ? "CAS202" : ""}
            onSageSalesInvoice={async (bubbleName, customerCode, notes) => {
              const res = await api.sageSalesInvoice(bubbleName, customerCode, notes || "");
              if (!res?.ok) {
                console.error("[sage-sales] invoice failed", res);
                alert(res?.error || "Sage Sales Invoice failed. Check the console for details.");
              }
            }}
          />
        ) : currentView === "manage-stock" ? (
          <ManageStockView
            items={items}
            bubbles={bubbles}
            onEditItem={handleStartEdit}
            onUpdateItem={updateItemByKey}
          />
        ) : currentView === "returns-management" ? (
          <ReturnsManagementView
            groups={returnsByWarehouse}
            onReturnToNewStock={handleReturnItemToNewStock}
          />
        ) : currentView === "ref-to-inv" ? (
          <RefToInvView
            orders={orders}
            ordersLoading={ordersLoading}
            ordersError={ordersError}
            handleOrderInvoiceChange={handleOrderInvoiceChange}
            handleSaveOrders={handleSaveOrders}
          />
        ) : currentView === "order-management" ? (
          <OrderManagementView
            ordersSourcePath={ordersSourcePath}
            ordersSearch={ordersSearch}
            setOrdersSearch={setOrdersSearch}
            ordersPickupFilter={ordersPickupFilter}
            setOrdersPickupFilter={setOrdersPickupFilter}
            ordersTodayOnly={ordersTodayOnly}
            setOrdersTodayOnly={setOrdersTodayOnly}
            ordersDirty={ordersDirty}
            ordersSaving={ordersSaving}
            ordersLoading={ordersLoading}
            ordersError={ordersError}
            loadOrders={loadOrders}
            handleSaveOrders={handleSaveOrders}
            filteredOrders={filteredOrders}
            handleOrderCheckboxChange={handleOrderCheckboxChange}
            handleOrderFieldChange={handleOrderFieldChange}
            onMarkForSage={handleOrderSageTrigger}
            onBubblifyOrder={handleBubblifyOrder}
            onMarkComplete={handleMarkComplete}
            onReconcileTotals={handleReconcileTotals}
            onArchiveOrder={handleArchiveOrder}
            hasSearch={hasSearch}
          />
        ) : currentView === "archive-search" ? (
          <ArchiveSearchView
            searchTerm={archiveSearchTerm}
            setSearchTerm={setArchiveSearchTerm}
            bubbleName={archiveBubbleSearch}
            setBubbleName={setArchiveBubbleSearch}
            onSearch={handleArchiveSearch}
            searching={archiveSearching}
            results={archiveResults}
            error={archiveError}
            archivePath={archivePath}
          />
        ) : currentView === "settings" ? (
          <SettingsView />
        ) : (
          <PaymentManagementView currentViewMeta={currentViewMeta} />
        )}
      </div>
      {printBubble && (
        <div className="fixed inset-0 z-[5000] bg-slate-900/60 flex items-center justify-center px-4">
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-7xl p-6 flex flex-col gap-4">
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
            <p className="text-sm text-slate-500">
              Bubble items stay read-only while printing. Use extra lines to add print-only charges or notes.
            </p>
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
            <div className="grid gap-4 lg:grid-cols-[420px,1fr]">
              <div className="max-h-[80vh] overflow-auto rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="text-sm font-semibold text-slate-800">
                      Extra lines (print-only)
                    </div>
                    <p className="text-xs text-slate-500">
                      Stored on this bubble so they show up next time you print.
                    </p>
                  </div>
                  <button
                    className="px-3 py-1 rounded-full border border-slate-300 text-sm font-semibold text-slate-700 hover:bg-white"
                    onClick={handleAddExtraLine}
                  >
                    Add line
                  </button>
                </div>
                {printExtraLines.length === 0 ? (
                  <div className="mt-3 rounded-xl border border-dashed border-slate-300 bg-white/80 p-3 text-xs text-slate-500">
                    No extra lines yet. Click “Add line” to include fees, notes, or shipping that
                    should only appear on the printout.
                  </div>
                ) : (
                  <div className="mt-3 space-y-3">
                    {printExtraLines.map((line) => (
                      <div
                        key={line.id}
                        className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm"
                      >
                        <div className="flex items-start gap-2">
                          <input
                            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-200"
                            placeholder="Description"
                            value={line.description || ""}
                            onChange={(e) =>
                              handleUpdateExtraLine(line.id, { description: e.target.value })
                            }
                          />
                          <button
                            className="text-xs text-slate-500 hover:text-red-600"
                            onClick={() => handleRemoveExtraLine(line.id)}
                            title="Remove line"
                          >
                            Remove
                          </button>
                        </div>
                        <div className="mt-2 grid grid-cols-2 sm:grid-cols-4 gap-2">
                          <input
                            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-200"
                            placeholder="Part/Line code"
                            value={line.partLineCode || ""}
                            onChange={(e) =>
                              handleUpdateExtraLine(line.id, { partLineCode: e.target.value })
                            }
                          />
                          <input
                            type="number"
                            min="0"
                            step="1"
                            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-200"
                            placeholder="Qty"
                            value={line.quantity ?? ""}
                            onChange={(e) =>
                              handleUpdateExtraLine(line.id, { quantity: e.target.value })
                            }
                          />
                          <input
                            type="number"
                            min="0"
                            step="0.01"
                            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-200"
                            placeholder="Price"
                            value={line.unitPrice ?? ""}
                            onChange={(e) =>
                              handleUpdateExtraLine(line.id, { unitPrice: e.target.value })
                            }
                          />
                          <label className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-700">
                            <input
                              type="checkbox"
                              checked={line.taxable ?? true}
                              onChange={(e) =>
                                handleUpdateExtraLine(line.id, { taxable: e.target.checked })
                              }
                            />
                            Taxable
                          </label>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div
                ref={printPreviewRef}
                className="max-h-[80vh] overflow-auto rounded-2xl border border-slate-200 bg-slate-50 p-4"
              >
                <InvoicePreview
                  bubbleName={printBubble.name}
                  bubbleNotes={printBubble.notes}
                  items={printItems}
                  extraLines={printExtraLines}
                  generatedDate={printGeneratedAt || new Date()}
                />
              </div>
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
