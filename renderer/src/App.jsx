// src/App.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import api from "./api";
import InvoicePreview from "./components/InvoicePreview";
import DashboardView from "./views/DashboardView";
import StockFlowView from "./views/StockFlowView";
import OrderManagementView from "./views/OrderManagementView";
import EpicorView from "./views/EpicorView";
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

// Shared between the orders pickup-filter switch and the filter-button badge
// counts, so the two never drift out of sync.
function matchesOrdersPickupFilter(order, value) {
  // Credit orders live entirely under their own "Credit" filter — regardless
  // of what state they're in (confirmed, picked up, invoiced, etc.) they must
  // never surface under any other filter, including "All".
  if (value !== "credit" && order?.isCredit === true) return false;
  switch (value) {
    case "not-picked":
      return !order.pickedUp;
    case "not-arrived":
      return !order.inStore;
    case "not-entered-sage":
      return !order.enteredInSage;
    case "no-invoice": {
      const inv = (order.source_invoice || "").toString().trim();
      return (
        (order.enteredInSage && !inv) ||
        Boolean(order.invoiceNeedsSync) ||
        Boolean(order.environmentalFeeAlert)
      );
    }
    case "not-confirmed":
      return !order.totalVerified;
    case "not-printed": {
      const vendor = (order.source || "").toString().trim().toLowerCase();
      if (!["bestbuy", "transbec", "cbk"].includes(vendor)) return false;
      const hasInvoiceFile = Boolean(
        order.transbecInvoiceFile ||
          order.transbecInvoiceImage ||
          order.bestbuyInvoiceFile ||
          order.bestbuyCreditFile ||
          order.cbkInvoiceFile
      );
      if (!hasInvoiceFile) return false;
      const printed = Boolean(
        order.transbecInvoicePrinted ||
          order.bestbuyInvoicePrinted ||
          order.bestbuyCreditInvoicePrinted ||
          order.cbkInvoicePrinted
      );
      return !printed;
    }
    // Every credit invoice, any vendor — Transbec's standalone credit orders
    // set isCredit at creation; BestBuy's credit patch (handleFetchBestbuyInvoices)
    // sets it on the existing order it patches. A future vendor's credit
    // pipeline just needs to set this same flag to show up in this filter.
    case "credit":
      return order.isCredit === true;
    // Mirrors OrderManagementView's canArchiveOrder — everything required to
    // actually click "Archive Order" is already true.
    case "needs-archive":
      return Boolean(
        order &&
          order.detailStored === true &&
          order.pickedUp === true &&
          order.hasInvoiceNum === true &&
          order.totalVerified === true &&
          order.enteredInSage === true &&
          order.inStore === true &&
          order.invoiceNeedsSync !== true &&
          order.valueCheckAlert !== true &&
          !matchesOrdersPickupFilter(order, "not-printed")
      );
    default:
      return true;
  }
}

// Best-effort convert an Epicor grid date into Sage's DDMMYY, so an order
// created from an Epicor invoice lands in the right world_YYYYMM folder when
// archived. Returns "" for anything we can't confidently parse, in which case
// archiving falls back to the archive timestamp's month.
function epicorDateToSageDate(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  let y, m, d, match;
  if ((match = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/))) {
    [, y, m, d] = match; // YYYY-MM-DD
  } else if ((match = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})$/))) {
    [, m, d, y] = match; // MM/DD/YYYY or MM/DD/YY (Epicor uses US month-first)
  } else {
    return "";
  }
  const yy = String(y).slice(-2).padStart(2, "0");
  const mm = String(m).padStart(2, "0");
  const dd = String(d).padStart(2, "0");
  if (Number(mm) < 1 || Number(mm) > 12 || Number(dd) < 1 || Number(dd) > 31) return "";
  return `${dd}${mm}${yy}`;
}
const DELETE_DESTINATIONS = ["NEW STOCK", "SHELF", "CASH SALES", "RETURNS"];
const CASH_SALE_DELETE_DESTINATIONS = ["CashPad"];

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
  { id: "epicor", label: "Epicor" },
  { id: "archive-search", label: "Archive" },
  { id: "settings", label: "Settings" },
  { id: "payment-management", label: "Payment Management" },
];

function ViewTabs({ currentView, onSelect, badges }) {
  return (
    <div className="w-full">
      <div className="flex flex-wrap gap-2 justify-start items-stretch">
        {VIEWS.map((view) => {
          const badgeCount = badges?.[view.id] || 0;
          const hasBadge = badgeCount > 0;
          const isActive = currentView === view.id;
          return (
            <button
              key={view.id}
              onClick={() => onSelect(view.id)}
              className={`relative h-11 min-w-[150px] px-4 rounded-full border text-sm font-semibold whitespace-nowrap transition ${
                isActive
                  ? "bg-indigo-600 text-white border-indigo-600 shadow"
                  : hasBadge
                  ? "bg-red-50 border-red-300 text-red-700 hover:bg-red-100"
                  : "bg-white border-slate-200 text-slate-600 hover:text-indigo-600"
              }`}
            >
              {view.label}
              {hasBadge && (
                <span className="absolute -top-1.5 -right-1.5 min-w-[20px] h-5 px-1 rounded-full bg-red-600 text-white text-[11px] font-bold flex items-center justify-center shadow">
                  {badgeCount}
                </span>
              )}
            </button>
          );
        })}
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
  const [currentView, setCurrentView] = useState("order-management");
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
  // Purchase-order processing is coordinated across machines via a shared lock
  // (only one machine at a time). Invoice processing runs locally and is unlocked.
  const [sagePoEnabled, setSagePoEnabled] = useState(false);
  const [sageInvoiceEnabled, setSageInvoiceEnabled] = useState(false);
  const [sageLockInfo, setSageLockInfo] = useState(null); // { lock, ownMachineId }
  // Bubble edit locks
  const [bubbleLocks, setBubbleLocks] = useState({});
  const [ownMachineId, setOwnMachineId] = useState('');
  const [pendingRequestBubbles, setPendingRequestBubbles] = useState(new Set());
  const pendingRequestsRef = React.useRef({}); // { [bubbleId]: { startedAt, timeoutId } }
  const [sageReadyOrders, setSageReadyOrders] = useState([]);
  const [sageInvoiceReadyOrders, setSageInvoiceReadyOrders] = useState([]);
  const [payments, setPayments] = useState([]);
  const [paymentsLoading, setPaymentsLoading] = useState(false);
  const [paymentsError, setPaymentsError] = useState("");
  const [cashPadMarkup, setCashPadMarkup] = useState("30");
  const [fillCashPadResult, setFillCashPadResult] = useState(null);
  const [sageWatchError, setSageWatchError] = useState(""); // purchase-order (locked) errors
  const [sageInvoiceError, setSageInvoiceError] = useState(""); // invoice (local) errors
  const [printExtraLinesByBubble, setPrintExtraLinesByBubble] = useState({});
  const [bubbleMeta, setBubbleMeta] = useState({});
  const [worldOrdersRunning, setWorldOrdersRunning] = useState(false);
  const [worldOrdersStatus, setWorldOrdersStatus] = useState("");
  const [worldOrdersError, setWorldOrdersError] = useState("");
  const [cbkOrdersRunning, setCbkOrdersRunning] = useState(false);
  const [cbkOrdersStatus, setCbkOrdersStatus] = useState("");
  const [cbkOrdersError, setCbkOrdersError] = useState("");
  const [tigerOrdersRunning, setTigerOrdersRunning] = useState(false);
  const [tigerOrdersStatus, setTigerOrdersStatus] = useState("");
  const [tigerOrdersError, setTigerOrdersError] = useState("");
  const [bestBuyOrdersRunning, setBestBuyOrdersRunning] = useState(false);
  const [bestBuyOrdersStatus, setBestBuyOrdersStatus] = useState("");
  const [bestBuyOrdersError, setBestBuyOrdersError] = useState("");
  const [transbecOrdersRunning, setTransbecOrdersRunning] = useState(false);
  const [transbecOrdersStatus, setTransbecOrdersStatus] = useState("");
  const [transbecOrdersError, setTransbecOrdersError] = useState("");
  const [proforceRunning, setProforceRunning] = useState(false);
  const [proforceStatus, setProforceStatus] = useState("");
  const [proforceError, setProforceError] = useState("");
  const [epicorOpening, setEpicorOpening] = useState(false);
  const [epicorStatus, setEpicorStatus] = useState("");
  const [epicorError, setEpicorError] = useState("");
  const [epicorReviewOrder, setEpicorReviewOrder] = useState(null);
  const [epicorReviewImageDataUrl, setEpicorReviewImageDataUrl] = useState("");
  const [epicorReviewInvoiceDraft, setEpicorReviewInvoiceDraft] = useState("");
  const [epicorReviewTotalDraft, setEpicorReviewTotalDraft] = useState("");
  // Editable line items shown in the Verify Invoice modal for epicor-only orders.
  const [epicorReviewLinesDraft, setEpicorReviewLinesDraft] = useState([]);
  // Epicor view: bulk date-range scan for invoices not yet in our records.
  const [epicorScanning, setEpicorScanning] = useState(false);
  const [epicorScanError, setEpicorScanError] = useState("");
  const [epicorScanLog, setEpicorScanLog] = useState([]);
  const [epicorScanInvoices, setEpicorScanInvoices] = useState([]);
  const [epicorScanCounts, setEpicorScanCounts] = useState({ scanned: 0, unknown: 0 });
  const [epicorReviewLoading, setEpicorReviewLoading] = useState(false);
  const [epicorReviewSaving, setEpicorReviewSaving] = useState(false);
  const [epicorReviewError, setEpicorReviewError] = useState("");
  // Epicor view: Transbec credit memos from Gmail — unlike the World scan
  // above, there's no vendor site to scan; it's a Gmail search (periodic
  // "Check for Transbec Credits" button) whose hits have no pre-existing
  // order, so each one gets its own "Create order" action.
  const [transbecCreditScanning, setTransbecCreditScanning] = useState(false);
  const [transbecCreditError, setTransbecCreditError] = useState("");
  const [transbecCreditLog, setTransbecCreditLog] = useState([]);
  const [transbecCredits, setTransbecCredits] = useState([]);
  const [transbecFetching, setTransbecFetching] = useState(false);
  const [transbecStatus, setTransbecStatus] = useState("");
  const [transbecError, setTransbecError] = useState("");
  const [bestbuyFetching, setBestbuyFetching] = useState(false);
  const [bestbuyStatus, setBestbuyStatus] = useState("");
  const [bestbuyError, setBestbuyError] = useState("");
  const [cbkFetching, setCbkFetching] = useState(false);
  const [cbkStatus, setCbkStatus] = useState("");
  const [cbkError, setCbkError] = useState("");
  const [invoicePrintingRef, setInvoicePrintingRef] = useState("");
  const [printAllRunning, setPrintAllRunning] = useState(false);
  const [archiveAllRunning, setArchiveAllRunning] = useState(false);
  const [outstandingRunning, setOutstandingRunning] = useState(false);
  const [outstandingStatus, setOutstandingStatus] = useState("");
  const [outstandingError, setOutstandingError] = useState("");
  const [archiveSearchTerm, setArchiveSearchTerm] = useState("");
  const [archiveBubbleSearch, setArchiveBubbleSearch] = useState("");
  const [archiveResults, setArchiveResults] = useState([]);
  const [archiveSearching, setArchiveSearching] = useState(false);
  const [archiveError, setArchiveError] = useState("");
  const [archivePath, setArchivePath] = useState("");
  const [purchasesSearchTerm, setPurchasesSearchTerm] = useState("");
  const [purchasesResults, setPurchasesResults] = useState([]);
  const [purchasesSearching, setPurchasesSearching] = useState(false);
  const [purchasesError, setPurchasesError] = useState("");
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

  // Save / watch bookkeeping.
  // Initialize to the serialized initial state ("[]") so the idle autosave can
  // never see "unsaved changes" before the first successful load — that window
  // used to allow an empty state to overwrite the real item files.
  const lastSavedRef = useRef("[]");
  const skipNextSaveRef = useRef(false);
  const itemsLoadedRef = useRef(false);
  // Uids the user explicitly deleted but whose deletion hasn't been confirmed
  // saved yet. Saves are upserts — an item absent from our state is NOT
  // deleted on disk unless its uid is sent in this list. The ledger also keeps
  // incoming file updates from resurrecting a just-deleted item.
  const deletedUidsRef = useRef(new Set());

  function markItemsDeleted(uids) {
    (uids || []).forEach((u) => { if (u) deletedUidsRef.current.add(u); });
  }
  function confirmItemsDeleted(uids) {
    (uids || []).forEach((u) => deletedUidsRef.current.delete(u));
  }
  function filterPendingDeleted(list) {
    if (!deletedUidsRef.current.size) return list;
    return (list || []).filter((it) => !deletedUidsRef.current.has(it?.uid));
  }

  // "User is editing any field" flag
  const isEditingAnythingRef = useRef(false);
  

  // === Load once & subscribe to file changes ===
  useEffect(() => {
    let loadAttempts = 0;
    function loadItemsInitial() {
      loadAttempts += 1;
      api.readItems().then((arr) => {
        const norm = normalizeItems(arr || []);
        console.log("[init] readItems ->", norm);
        itemsLoadedRef.current = true;
        setItems(norm);
        lastSavedRef.current = JSON.stringify(norm);
        ensureBubblesForItems(norm, setBubbles);
        const needsLastMovedPersist =
          (arr || []).some((it) => !it || !it.last_moved_at);
        if (needsLastMovedPersist) {
          api.writeItems(norm);
        }
      }).catch((e) => {
        // Never treat a failed read as "no items" — retry, then tell the user.
        console.error("[init] readItems failed", e);
        if (loadAttempts < 3) {
          setTimeout(loadItemsInitial, 3000);
        } else {
          alert(
            "Could not load items from the shared folder.\n\n" +
            (e?.message || "Unknown error") +
            "\n\nCheck the network share and restart the app. Saving is disabled until items load."
          );
        }
      });
    }
    loadItemsInitial();

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

      const norm = filterPendingDeleted(normalizeItems(arr || []));
      itemsLoadedRef.current = true; // main only pushes successfully-read data
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
    // Never autosave before the first successful load — the state would be
    // empty and the write would erase the real item files.
    if (!itemsLoadedRef.current) return;
    const id = setTimeout(() => {
      if (skipNextSaveRef.current) {
        skipNextSaveRef.current = false;
        return;
      }
      const current = JSON.stringify(items);
      const pendingDeletes = Array.from(deletedUidsRef.current);
      if (current === lastSavedRef.current && pendingDeletes.length === 0) return;
      lastSavedRef.current = current;
      console.log("[autosave] writing items to disk after idle", items);
      api.writeItems(items, pendingDeletes).then((res) => {
        if (res && res.ok === false) {
          console.error("[autosave] write rejected by main:", res.error);
          // Allow a retry on the next change; keep pending deletions queued
          lastSavedRef.current = "";
        } else {
          confirmItemsDeleted(pendingDeletes);
        }
      }).catch((e) => {
        console.error("[autosave] write failed", e);
        lastSavedRef.current = "";
      });
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
      [id]: { ...(prev[id] || {}), accountingPath: visibleAccountingPath || ACCOUNTING_PATHS.OUTSTANDING },
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
        bubbleAccountingPathByName.get(b.name) ||
        bubbleMeta[b.id]?.accountingPath ||
        ACCOUNTING_PATHS.OUTSTANDING;
      return path === visibleAccountingPath;
    });
  }, [bubbles, bubbleAccountingPathByName, bubbleMeta, visibleAccountingPath]);
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
        // Back-compat: the old single `sageIntegrationEnabled` flag drove both flows.
        if (typeof state.sagePoEnabled === "boolean") {
          setSagePoEnabled(state.sagePoEnabled);
        } else if (typeof state.sageIntegrationEnabled === "boolean") {
          setSagePoEnabled(state.sageIntegrationEnabled);
        }
        if (typeof state.sageInvoiceEnabled === "boolean") {
          setSageInvoiceEnabled(state.sageInvoiceEnabled);
        } else if (typeof state.sageIntegrationEnabled === "boolean") {
          setSageInvoiceEnabled(state.sageIntegrationEnabled);
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
          sagePoEnabled,
          sageInvoiceEnabled,
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
      sagePoEnabled,
      sageInvoiceEnabled,
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
          sagePoEnabled,
          sageInvoiceEnabled,
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
    window.addEventListener("blur", endDrag);
    window.addEventListener("touchmove", handlePointerMove, { passive: false });
    window.addEventListener("touchend", endDrag);
    window.addEventListener("touchcancel", endDrag);
    return () => {
      window.removeEventListener("mousemove", handlePointerMove);
      window.removeEventListener("mouseup", endDrag);
      window.removeEventListener("blur", endDrag);
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
    // Computed from current state (not inside the updater) so the merged-away
    // uids can be recorded as explicit deletions for the next save.
    const prev = items;
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
    const removedUids = [];

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
        removedUids.push(itemsForKey[i].uid);
      }
    });

    if (!changed) return;

    const next = prev
      .map((item) => {
        if (!replacements.has(item.uid)) return item;
        const replacement = replacements.get(item.uid);
        if (replacement === null) return null;
        return replacement;
      })
      .filter(Boolean);

    markItemsDeleted(removedUids); // autosave will carry these deletions
    setItems(next);
  }

  function handleDeleteBubble(bubbleId, fallbackTargetName) {
    const bubble = bubbles.find((b) => b.id === bubbleId);
    if (!bubble) return;
    const paymentMeta = bubbleMeta[bubbleId] || bubbleMeta[bubble.name] || {};
    if (Array.isArray(paymentMeta.paymentIds) && paymentMeta.paymentIds.length) {
      handleUpdateBubblePayments(bubbleId, []);
    }
    const validTargets = DELETE_DESTINATIONS.filter((name) => name !== bubble.name);
    const bubblePath = bubbleAccountingPathByName.get(bubble.name);
    const fallback = fallbackTargetName
      ? fallbackTargetName
      : (bubblePath === ACCOUNTING_PATHS.CASH_SALE && validTargets.includes("CASH SALES"))
        ? "CASH SALES"
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

  async function handleDeletePayment(paymentId, bubbleId) {
    if (!paymentId) return;
    const next = (payments || []).filter((p) => p?.id !== paymentId);
    await api.writePayments(next);
    setPayments(next);
    if (bubbleId) {
      const meta = bubbleMeta[bubbleId] || {};
      const cleanIds = (meta.paymentIds || []).filter((id) => id !== paymentId);
      handleUpdateBubblePayments(bubbleId, cleanIds);
    }
  }

  function handleFillFromCashPad() {
    const TAX = 0.13;
    const markup = Math.max(0, parseFloat(cashPadMarkup) || 0) / 100;
    const toAmt = (v) => parseFloat((v ?? '').toString().replace(/[^0-9.-]/g, '')) || 0;

    // Only unassigned payments
    const assignedIds = new Set(
      Object.values(bubbleMeta).flatMap((m) => m.paymentIds || [])
    );
    const unassigned = (payments || []).filter((p) => p?.id && !assignedIds.has(p.id));
    if (!unassigned.length) { alert('No unassigned payments found.'); return; }

    // CASHPAD items only
    const cashpadItems = items.filter(
      (it) => (it.allocated_to || '').toUpperCase() === 'CASHPAD'
    );
    if (!cashpadItems.length) { alert('CashPad is empty.'); return; }

    // Effective price: cost × (1 + markup) × (1 + tax), sort largest first
    const priced = cashpadItems
      .map((it) => ({ ...it, _eff: toAmt(it.cost) * (Number(it.quantity) || 1) * (1 + markup) * (1 + TAX) }))
      .sort((a, b) => b._eff - a._eff);

    // Payments largest first
    const sortedPayments = [...unassigned].sort((a, b) => toAmt(b.amount) - toAmt(a.amount));

    // Greedy largest-first fill
    const pool = [...priced];
    const assignments = [];
    for (const payment of sortedPayments) {
      const target = toAmt(payment.amount);
      const chosen = [];
      let spent = 0;
      const takenIdx = [];
      for (let i = 0; i < pool.length; i++) {
        if (spent + pool[i]._eff <= target + 0.005) {
          chosen.push(pool[i]);
          takenIdx.push(i);
          spent += pool[i]._eff;
        }
      }
      // Remove chosen from pool (reverse order to keep indices valid)
      for (let i = takenIdx.length - 1; i >= 0; i--) pool.splice(takenIdx[i], 1);
      assignments.push({ payment, chosen });
    }

    if (!assignments.some((a) => a.chosen.length > 0)) {
      alert('No items could be assigned — all items may exceed individual payment amounts.');
      return;
    }

    // Build new bubbles + meta
    const now = new Date().toISOString();
    const newBubbles = [];
    const newMetaEntries = {};
    const itemToBubble = new Map();
    const sharedWrites = [];
    const existingNames = new Set(bubbles.map((b) => (b.name || '').toUpperCase()));
    let bubblesCreated = 0;
    let itemsMoved = 0;

    for (const { payment, chosen } of assignments) {
      if (chosen.length === 0) continue;
      const label = `${(payment.type || 'PAYMENT').toUpperCase()} $${toAmt(payment.amount).toFixed(2)}`;
      const bubbleName = uniqueName(label, existingNames);
      existingNames.add(bubbleName.toUpperCase());
      const bubbleId = makeUid();
      const meta = { accountingPath: ACCOUNTING_PATHS.CASH_SALE, paymentIds: [payment.id] };
      newBubbles.push({ id: bubbleId, name: bubbleName, notes: '' });
      newMetaEntries[bubbleId] = meta;
      newMetaEntries[bubbleName] = meta;
      chosen.forEach((it) => itemToBubble.set(it.uid, bubbleName));
      sharedWrites.push({ bubbleId, bubbleName, paymentIds: [payment.id] });
      bubblesCreated++;
      itemsMoved += chosen.length;
    }

    setBubbles((prev) => [...prev, ...newBubbles]);
    setBubbleMeta((prev) => {
      const next = { ...prev, ...newMetaEntries };
      persistUIState(next);
      return next;
    });
    setItems((prev) =>
      prev.map((it) => {
        const dest = itemToBubble.get(it.uid);
        if (!dest) return it;
        const discounted_price = (toAmt(it.cost) * (1 + markup)).toFixed(2);
        return { ...it, allocated_to: dest, last_moved_at: now, discounted_price };
      })
    );
    sharedWrites.forEach(({ bubbleId, bubbleName, paymentIds }) => {
      api.writeSharedBubbleData?.({
        bubbleId, name: bubbleName, notes: '', extraLines: [], paymentIds,
      }).catch((e) => console.warn('[cashpad-fill] shared write failed', e));
    });

    setFillCashPadResult(
      `Created ${bubblesCreated} bubble${bubblesCreated !== 1 ? 's' : ''}, moved ${itemsMoved} item${itemsMoved !== 1 ? 's' : ''}.`
    );
    setTimeout(() => setFillCashPadResult(null), 5000);
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
      const removedUids = bubbleItems.map((it) => it.uid);
      markItemsDeleted(removedUids);
      setItems(remainingItems);
      lastSavedRef.current = JSON.stringify(remainingItems);
      const writeRes = await api.writeItems(remainingItems, removedUids);
      if (writeRes?.ok === false) {
        throw new Error(writeRes.error || "Failed to remove archived items from active files.");
      }
      confirmItemsDeleted(removedUids);
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
      const removedUids = bubbleItems.map((it) => it.uid);
      markItemsDeleted(removedUids);
      setItems(remainingItems);
      lastSavedRef.current = JSON.stringify(remainingItems);
      const writeRes = await api.writeItems(remainingItems, removedUids);
      if (writeRes?.ok === false) {
        throw new Error(writeRes.error || "Failed to delete items.");
      }
      confirmItemsDeleted(removedUids);
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
      const norm = filterPendingDeleted(normalizeItems(latest || []));
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
    if (!key) return null;
    let result = null;
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
      result = next;
      return next;
    });
    return result;
  }
  function normalizeOrdersForSave(list) {
    return (list || []).map((o) => {
      const invFilled = Boolean((o?.source_invoice || "").trim());
      const { _localDirty, ...rest } = o || {};
      return { ...rest, hasInvoiceNum: invFilled };
    });
  }
  function handleOrderFieldChange(referenceKey, field, value) {
    updateOrderByKey(referenceKey, { [field]: value });
  }
  function handleOrderInvoiceChange(referenceKey, value) {
    updateOrderByKey(referenceKey, { source_invoice: value, sage_reference: value });
  }
  // Like updateOrderByKey, but writes the result to orders.json immediately
  // instead of leaving it as an unsaved React-state change for the user to
  // save later via the "Save Changes" button.
  async function updateOrderByKeyAndSave(key, patch) {
    const patchedOrders = updateOrderByKey(key, patch);
    if (!patchedOrders || !api?.writeOrders) return patchedOrders;
    const normalized = normalizeOrdersForSave(patchedOrders);
    try {
      const saveRes = await api.writeOrders(normalized);
      if (saveRes?.ok) {
        setOrders(normalized);
        ordersLastSavedRef.current = JSON.stringify(normalized);
        setOrdersDirty(false);
      } else {
        console.error("[orders] failed to save", saveRes);
        setOrdersError("Failed to save order.");
      }
    } catch (e) {
      console.error("[orders] failed to save", e);
      setOrdersError(e?.message || "Failed to save order.");
    }
    return patchedOrders;
  }
  function handleUpdateInvoiceTrigger(referenceKey) {
    updateOrderByKeyAndSave(referenceKey, { sage_invoice_trigger: true });
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
      const filtered = filterPendingDeleted(freshItems);
      setItems(filtered);
      lastSavedRef.current = JSON.stringify(filtered);
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

  function handleSagePoToggleClick() {
    const readyCount = Array.isArray(sageReadyOrders) ? sageReadyOrders.length : 0;
    console.log("[sage-ui] Sage purchase-orders toggle clicked", {
      timestamp: new Date().toISOString(),
      sageReadyCount: readyCount,
    });
    setSagePoEnabled((v) => !v);
  }

  function handleSageInvoiceToggleClick() {
    console.log("[sage-ui] Sage invoices toggle clicked", {
      timestamp: new Date().toISOString(),
    });
    setSageInvoiceEnabled((v) => !v);
  }

  function handleOrdersUpdatedExternally(list) {
    const normalized = Array.isArray(list) ? list : [];
    setSageReadyOrders(
      normalized.filter((o) => o && o.sage_trigger && !o.enteredInSage)
    );
    setSageInvoiceReadyOrders(
      normalized.filter((o) => o && o.sage_invoice_trigger)
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
      const normalized = normalizeOrdersForSave(orders);
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

  async function handleArchiveOrder(refKey, source) {
    if (!api?.archiveOrder) return;
    try {
      setOrdersError(null);
      const res = await api.archiveOrder(refKey, source);
      if (!res?.ok) throw new Error(res?.error || "Failed to archive order.");
      await loadOrders();
    } catch (e) {
      setOrdersError(e?.message || "Failed to archive order.");
    }
  }

  // The individual "Archive Order" button's confirmation — same journal-entry
  // reminder popup as "Archive All" (below) gives each order, just for the
  // one order being archived. Cancel aborts, nothing is archived.
  async function handleArchiveOrderWithConfirm(order) {
    if (!order) return;
    const refKey = order.reference || order.__row;
    if (!refKey) return;
    const proceed = api?.confirm
      ? await api.confirm(
          `Record the journal entry before archiving order ${order.reference || refKey}.`,
          `Journal Entry: ${order.journalEntry || "(none recorded)"}`
        )
      : true;
    if (!proceed) return;
    await handleArchiveOrder(refKey, order.source);
  }

  // "Archive All" for the Needs Archive filter: archives each order the same
  // way its own "Archive Order" button would, but first pops a native message
  // box per order reminding the user to record the journal entry (showing
  // whatever's currently stored in that order's journalEntry field) as a last
  // confirmation — Cancel skips just that order and moves on to the next.
  async function handleArchiveAllNeedsArchive(ordersToArchive) {
    const list = Array.isArray(ordersToArchive) ? ordersToArchive : [];
    if (!list.length || archiveAllRunning) return;
    setArchiveAllRunning(true);
    try {
      for (const order of list) {
        const refKey = order.reference || order.__row;
        if (!refKey) continue;
        const proceed = api?.confirm
          ? await api.confirm(
              `Record the journal entry before archiving order ${order.reference || refKey}.`,
              `Journal Entry: ${order.journalEntry || "(none recorded)"}`
            )
          : true;
        if (!proceed) continue;
        await handleArchiveOrder(refKey, order.source);
      }
    } finally {
      setArchiveAllRunning(false);
    }
  }

  // A vendor crawler builds its result from orders.json ON DISK, and we then
  // replace renderer state with that result wholesale. Edits that only live in
  // React state would therefore be silently dropped — and most order fields
  // (the invoice box, the checkboxes) go through updateOrderByKey, which marks
  // dirty but does NOT save. Flush those to disk first so the crawler merges on
  // top of them (it keeps existing orders untouched) instead of erasing them.
  // Returns false if the flush failed, in which case the caller must not fetch.
  async function flushPendingOrderEdits() {
    if (!ordersDirty || !api?.writeOrders) return true;
    try {
      const normalized = normalizeOrdersForSave(orders);
      const res = await api.writeOrders(normalized);
      if (!res?.ok) return false;
      setOrders(normalized);
      ordersLastSavedRef.current = JSON.stringify(normalized);
      setOrdersDirty(false);
      return true;
    } catch (e) {
      console.error("[orders] failed to flush pending edits before fetch", e);
      return false;
    }
  }

  const FLUSH_FAILED_MSG =
    "You have unsaved order changes that could not be saved, so the fetch was cancelled to avoid losing them. Click Save, then try again.";

  async function handleGetWorldOrders() {
    if (!api?.fetchWorldOrders) return;
    try {
      setWorldOrdersRunning(true);
      setWorldOrdersError("");
      setWorldOrdersStatus("");
      setOrdersError(null);
      if (!(await flushPendingOrderEdits())) throw new Error(FLUSH_FAILED_MSG);
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
      if (!(await flushPendingOrderEdits())) throw new Error(FLUSH_FAILED_MSG);
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

  async function handleGetTigerOrders() {
    if (!api?.fetchTigerOrders) return;
    try {
      setTigerOrdersRunning(true);
      setTigerOrdersError("");
      setTigerOrdersStatus("");
      setOrdersError(null);
      if (!(await flushPendingOrderEdits())) throw new Error(FLUSH_FAILED_MSG);
      const res = await api.fetchTigerOrders();
      if (!res?.ok) {
        throw new Error(res?.error || "Failed to fetch Tiger orders.");
      }
      const list = Array.isArray(res.orders) ? res.orders : [];
      setOrders(list);
      ordersLastSavedRef.current = JSON.stringify(list);
      setOrdersDirty(false);
      setOrdersInitialized(true);
      if (res.path) setOrdersSourcePath(res.path);
      const baseMsg = `Fetched ${list.length} Tiger order(s) and saved to ${res.path || "orders.json"}.`;
      const logMsg =
        Array.isArray(res.statusLog) && res.statusLog.length ? `\n${res.statusLog.join("\n")}` : "";
      setTigerOrdersStatus(baseMsg + logMsg);
    } catch (e) {
      console.error("[orders] tiger fetch error", e);
      setTigerOrdersError(e?.message || "Failed to fetch Tiger orders.");
    } finally {
      setTigerOrdersRunning(false);
    }
  }

  async function handleGetBestBuyOrders() {
    if (!api?.fetchBestBuyOrders) return;
    try {
      setBestBuyOrdersRunning(true);
      setBestBuyOrdersError("");
      setBestBuyOrdersStatus("");
      setOrdersError(null);
      if (!(await flushPendingOrderEdits())) throw new Error(FLUSH_FAILED_MSG);
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
      if (!(await flushPendingOrderEdits())) throw new Error(FLUSH_FAILED_MSG);
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
      if (!(await flushPendingOrderEdits())) throw new Error(FLUSH_FAILED_MSG);
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

  function clearOrderFetchMessage(vendor) {
    switch (vendor) {
      case "world":
        setWorldOrdersStatus("");
        setWorldOrdersError("");
        break;
      case "cbk":
        setCbkOrdersStatus("");
        setCbkOrdersError("");
        break;
      case "tiger":
        setTigerOrdersStatus("");
        setTigerOrdersError("");
        break;
      case "bestbuy-orders":
        setBestBuyOrdersStatus("");
        setBestBuyOrdersError("");
        break;
      case "transbec-orders":
        setTransbecOrdersStatus("");
        setTransbecOrdersError("");
        break;
      case "proforce":
        setProforceStatus("");
        setProforceError("");
        break;
      default:
        break;
    }
  }

  function clearInvoiceFetchMessage(vendor) {
    switch (vendor) {
      case "orders":
        setOrdersError(null);
        break;
      case "epicor":
        setEpicorStatus("");
        setEpicorError("");
        break;
      case "transbec":
        setTransbecStatus("");
        setTransbecError("");
        break;
      case "bestbuy":
        setBestbuyStatus("");
        setBestbuyError("");
        break;
      case "cbk":
        setCbkStatus("");
        setCbkError("");
        break;
      default:
        break;
    }
  }

  async function handleOpenEpicor(reference, fromSageDate, toSageDate) {
    if (!api?.openEpicor) return;
    try {
      setEpicorOpening(true);
      setEpicorError("");
      setEpicorStatus("");
      const res = await api.openEpicor({ reference, fromSageDate, toSageDate });
      if (!res?.ok) throw new Error(res?.error || "Failed to open Epicor site.");
      const logMsg = Array.isArray(res.statusLog) && res.statusLog.length ? res.statusLog.join("\n") : "";

      // The date-range search discovers references for every invoice checked in
      // that range, not just the one that was clicked — apply a match to every
      // order in Order Management that has one, not only the order that triggered this run.
      // Only orders that already have this exact reference get patched, and only
      // if they don't already have an invoice recorded (so a manually-verified
      // entry never gets silently overwritten by a re-scan).
      const discoveries = Array.isArray(res.discoveries) ? res.discoveries : [];
      let patchedOrders = null;
      let appliedCount = 0;

      if (discoveries.length > 0) {
        setOrders((prev) => {
          const next = prev.map((o) => {
            if (!o?.reference || (o.source_invoice || "").toString().trim()) return o;
            const orderRef = String(o.reference).trim().toUpperCase();
            const found = discoveries.find(
              (d) => d.reference && String(d.reference).trim().toUpperCase() === orderRef
            );
            if (!found) return o;
            appliedCount += 1;
            const balanceDueNum = Number(found.balanceDue);
            // Same mechanism as typing an invoice into the textbox: if the order
            // was already entered in Sage (invoiceSageUpdate) and the new invoice
            // differs from what Sage last synced, flag it so the red
            // "Invoice differs from last Sage update / Update Invoice" UI appears.
            const invoiceNeedsSync =
              Boolean(o.invoiceSageUpdate) &&
              String(found.invoiceNumber || "").trim() !== String(o.sage_reference_synced || "").trim();
            return {
              ...o,
              source_invoice: found.invoiceNumber,
              sage_reference: found.invoiceNumber,
              hasInvoiceNum: true,
              invoiceNeedsSync,
              ...(Number.isFinite(balanceDueNum) ? { billed_total: balanceDueNum } : {}),
              ...(found.imageFileName ? { epicorInvoiceImage: found.imageFileName } : {}),
              environmentalFeeAlert: Boolean(found.hasEnvironmentalFee),
              ...(found.environmentalFeeAmount ? { environmentalFeeAmount: found.environmentalFeeAmount } : {}),
              lastUpdatedAt: new Date().toISOString(),
              _localDirty: true,
            };
          });
          patchedOrders = next;
          return next;
        });
        // Dirty BEFORE attempting the save: if the write to orders.json fails
        // (transient network-share error), this keeps the Save button live for a
        // manual retry and stops the next full-orders refresh (watcher push or a
        // crawler fetch) from silently discarding the never-persisted data.
        setOrdersDirty(true);
      }

      let saveFailed = false;
      if (appliedCount > 0 && patchedOrders && api?.writeOrders) {
        const normalized = normalizeOrdersForSave(patchedOrders);
        try {
          const saveRes = await api.writeOrders(normalized);
          if (saveRes?.ok) {
            setOrders(normalized);
            ordersLastSavedRef.current = JSON.stringify(normalized);
            setOrdersDirty(false);
          } else {
            saveFailed = true;
            console.error("[vendor] failed to auto-save epicor matches", saveRes);
          }
        } catch (saveErr) {
          saveFailed = true;
          console.error("[vendor] failed to auto-save epicor matches", saveErr);
        }
      }

      if (saveFailed) {
        setEpicorError(
          "Filled invoice data but could not save it to orders.json. It will not survive a page refresh or another fetch until you click Save. Click Save now to retry."
        );
      }
      const appliedMsg = appliedCount > 0 ? `Filled invoice/total for ${appliedCount} order(s) in Order Management.` : "";
      setEpicorStatus([logMsg, appliedMsg].filter(Boolean).join("\n") || "Logged into Epicor.");
    } catch (e) {
      console.error("[vendor] epicor open error", e);
      setEpicorError(e?.message || "Failed to open Epicor site.");
    } finally {
      setEpicorOpening(false);
    }
  }

  // Load previously-scanned invoices straight from the on-disk cache (no
  // browser). Called when the Epicor view opens so a restart still shows prior
  // results instead of an empty page.
  async function handleLoadEpicorScanned() {
    if (!api?.getEpicorScanned) return;
    try {
      setEpicorScanError("");
      const res = await api.getEpicorScanned();
      if (!res?.ok) throw new Error(res?.error || "Failed to load scanned invoices.");
      const invoices = Array.isArray(res.invoices) ? res.invoices : [];
      setEpicorScanInvoices(invoices);
      setEpicorScanCounts({
        scanned: res.scannedCount ?? invoices.length,
        unknown: res.unknownCount ?? invoices.filter((i) => !i.known).length,
      });
      await backfillEpicorOrders(invoices);
    } catch (e) {
      console.error("[vendor] load scanned epicor invoices failed", e);
      setEpicorScanError(e?.message || "Failed to load scanned invoices.");
    }
  }

  // Bring already-created epicorOnly orders up to date after a scan/refresh:
  //  - fill the invoice date on orders whose cache entry gained a Date only
  //    later (older entries were cached before grid fields were stored), matched
  //    by the authoritative invoice number; and
  //  - stamp detailStored:true on any epicor order missing it, so orders created
  //    before that field was set can still meet the archive criteria (their
  //    line-item detail was captured at creation — nothing more is fetched).
  // Only these fields are touched; all Sage processing state / totals / line
  // items are left exactly as-is, so a fully-processed order keeps everything.
  // Reads/writes orders.json directly since the Epicor view can be used without
  // Order Management ever being open (in-memory state may be stale).
  async function backfillEpicorOrders(invoices) {
    if (!api?.readOrders || !api?.writeOrders) return;
    const dateByInvoice = new Map();
    for (const inv of Array.isArray(invoices) ? invoices : []) {
      const key = inv?.invoiceNumber ? String(inv.invoiceNumber).trim().toUpperCase() : "";
      if (key && inv.date && !dateByInvoice.has(key)) dateByInvoice.set(key, inv.date);
    }
    try {
      const ordersRes = await api.readOrders();
      const currentList = ordersRes?.state || ordersRes || [];
      const base = Array.isArray(currentList) ? currentList : [];
      let changed = false;
      const norm = (v) => (v ? String(v).trim().toUpperCase() : "");
      const next = base.map((o) => {
        if (!o?.epicorOnly) return o;
        const patch = {};
        if (o.detailStored !== true) patch.detailStored = true;
        if (!(o.orderDateRaw || "").toString().trim()) {
          const date = dateByInvoice.get(norm(o.source_invoice)) || dateByInvoice.get(norm(o.invoiceNum));
          if (date) {
            patch.epicorInvoiceDate = date;
            patch.orderDateRaw = date;
            patch.sageDate = epicorDateToSageDate(date);
          }
        }
        if (Object.keys(patch).length === 0) return o;
        changed = true;
        return { ...o, ...patch };
      });
      if (!changed) return;
      const saveRes = await api.writeOrders(normalizeOrdersForSave(next));
      if (!saveRes?.ok) throw new Error(saveRes?.error || "Failed to save backfilled dates.");
      if (ordersInitialized) {
        setOrders(next);
        ordersLastSavedRef.current = JSON.stringify(next);
        setOrdersDirty(false);
      }
    } catch (e) {
      console.error("[vendor] backfill epicor orders failed", e);
    }
  }

  async function handleScanEpicorRange(fromDate, toDate, force = false) {
    if (!api?.scanEpicorRange) return;
    try {
      setEpicorScanning(true);
      setEpicorScanError("");
      const res = await api.scanEpicorRange({ fromDate, toDate, force });
      setEpicorScanLog(Array.isArray(res?.statusLog) ? res.statusLog : []);
      if (!res?.ok) throw new Error(res?.error || "Failed to scan Epicor range.");
      const invoices = Array.isArray(res.invoices) ? res.invoices : [];
      setEpicorScanInvoices(invoices);
      setEpicorScanCounts({
        scanned: res.scannedCount ?? invoices.length,
        unknown: res.unknownCount ?? invoices.filter((i) => !i.known).length,
      });
      await backfillEpicorOrders(invoices);
    } catch (e) {
      console.error("[vendor] epicor scan error", e);
      setEpicorScanError(e?.message || "Failed to scan Epicor range.");
    } finally {
      setEpicorScanning(false);
    }
  }

  // Re-OCR a single invoice from its already-saved image (no browser, no Epicor,
  // no date), then merge the fresh total/reference/parts back into that one row.
  // Lets the user refresh a stale or imperfect cached parse before creating an
  // order from it.
  async function handleRescanEpicorInvoice(inv) {
    if (!api?.rescanEpicorInvoice) return { ok: false, error: "Rescan is not available." };
    const invNum = String(inv?.invoiceNumber || "").trim();
    if (!invNum) return { ok: false, error: "This invoice has no number." };
    try {
      const res = await api.rescanEpicorInvoice(invNum);
      if (!res?.ok) throw new Error(res?.error || "Rescan failed.");
      const refreshed = res.invoice;
      if (!refreshed) throw new Error("Rescan returned no data.");
      const norm = (v) => (v ? String(v).trim().toUpperCase() : "");
      setEpicorScanInvoices((prev) =>
        prev.map((i) => (norm(i.invoiceNumber) === norm(invNum) ? { ...i, ...refreshed, created: i.created } : i))
      );
      return { ok: true };
    } catch (e) {
      console.error("[vendor] rescan invoice failed", e);
      return { ok: false, error: e?.message || "Rescan failed." };
    }
  }

  // Turn a scanned Epicor invoice into an order in Order Management — the same
  // kind of order the World scrape produces (source "world"), pre-filled with
  // the invoice number, total, scanned image, and OCR'd reference. Reads the
  // freshest orders from disk first (the Epicor view can be used without ever
  // opening Order Management, so in-memory state may be empty/stale).
  async function handleCreateOrderFromEpicorInvoice(inv) {
    if (!inv || !api?.writeOrders) return { ok: false, error: "Saving orders is not available." };
    const invNum = String(inv.invoiceNumber || "").trim();
    if (!invNum) return { ok: false, error: "This invoice has no number to key an order by." };
    try {
      const ordersRes = await api?.readOrders?.();
      const currentList = ordersRes?.state || ordersRes || [];
      const base = Array.isArray(currentList) ? currentList : [];

      const norm = (v) => (v ? String(v).trim().toUpperCase() : "");
      const invKey = norm(invNum);
      const already = base.some(
        (o) => o && (norm(o.source_invoice) === invKey || norm(o.invoiceNum) === invKey)
      );

      if (!already) {
        const balanceDueNum = Number(inv.balanceDue);
        // Prefer the order reference OCR read off the invoice; only when OCR
        // found none do we fall back to the invoice number so the bubble still
        // has a real identity instead of "No reference". The order key (__row)
        // mirrors whichever we use; source_invoice always stays the invoice #.
        const ocrRef = inv.reference ? String(inv.reference).trim() : "";
        const refValue = ocrRef || invNum;
        const newOrder = {
          source: "world",
          epicorOnly: true,
          reference: refValue,
          __row: refValue,
          warehouse: inv.accountName || "Epicor invoice",
          sage_source: "WOR505",
          source_invoice: invNum,
          sage_reference: invNum,
          hasInvoiceNum: true,
          // Epicor orders capture their line-item detail at creation from OCR;
          // there is no separate detail-fetch step (unlike World/Transbec), so
          // the detail is "stored" from the start — same as cbk/bestbuy orders.
          // Without this the order can never satisfy the archive criteria.
          detailStored: true,
          ...(Number.isFinite(balanceDueNum) ? { billed_total: balanceDueNum } : {}),
          ...(inv.imageFileName ? { epicorInvoiceImage: inv.imageFileName } : {}),
          environmentalFeeAlert: Boolean(inv.hasEnvironmentalFee),
          ...(inv.environmentalFeeAmount ? { environmentalFeeAmount: inv.environmentalFeeAmount } : {}),
          epicorInvoiceDate: inv.date || "",
          orderDateRaw: inv.date || "",
          sageDate: epicorDateToSageDate(inv.date),
          lineItems: Array.isArray(inv.lineItems) ? inv.lineItems : [],
          lastUpdatedAt: new Date().toISOString(),
        };
        const nextList = normalizeOrdersForSave(base.concat(newOrder));
        const saveRes = await api.writeOrders(nextList);
        if (!saveRes?.ok) throw new Error(saveRes?.error || "Failed to save the new order.");
        if (ordersInitialized) {
          setOrders(nextList);
          ordersLastSavedRef.current = JSON.stringify(nextList);
          setOrdersDirty(false);
        }
      }

      // Reflect in the Epicor list: it's now on file (and stays visible with a
      // "Created" badge even under the "only new" filter).
      setEpicorScanInvoices((prev) =>
        prev.map((i) => (norm(i.invoiceNumber) === invKey ? { ...i, known: true, created: true } : i))
      );
      if (!already) {
        setEpicorScanCounts((prev) => ({
          scanned: prev.scanned,
          unknown: Math.max(0, prev.unknown - 1),
        }));
      }
      return { ok: true, duplicate: already };
    } catch (e) {
      console.error("[vendor] create order from epicor invoice failed", e);
      return { ok: false, error: e?.message || "Failed to create order." };
    }
  }

  // Attach a scanned Epicor invoice to an EXISTING order that has no invoice yet
  // — the manual counterpart to the OCR auto-match, for invoices where OCR could
  // not read the order reference. Patches only the invoice-related fields (number,
  // total, image, EHC, date) exactly like the auto-match does; the order's own
  // line items / detail / Sage flags are untouched. Reads fresh from disk since
  // the Epicor view can be used without Order Management being open.
  async function handleAssignEpicorInvoiceToOrder(inv, orderReference) {
    if (!api?.writeOrders) return { ok: false, error: "Saving orders is not available." };
    const invNum = String(inv?.invoiceNumber || "").trim();
    if (!invNum) return { ok: false, error: "This invoice has no number." };
    const targetRef = String(orderReference || "").trim();
    if (!targetRef) return { ok: false, error: "Pick an order to assign this invoice to." };
    try {
      const ordersRes = await api?.readOrders?.();
      const currentList = ordersRes?.state || ordersRes || [];
      const base = Array.isArray(currentList) ? currentList : [];
      const norm = (v) => (v ? String(v).trim().toUpperCase() : "");
      const invKey = norm(invNum);
      const targetKey = norm(targetRef);

      // Guard: don't attach the same invoice number to two different orders.
      const clash = base.find(
        (o) => o && norm(o.source_invoice) === invKey && norm(o.reference) !== targetKey
      );
      if (clash) {
        return { ok: false, error: `Invoice ${invNum} is already on order ${clash.reference}.` };
      }

      let applied = false;
      const balanceDueNum = Number(inv.balanceDue);
      const next = base.map((o) => {
        // Scope to the same World order the dropdown offered: reference is unique
        // per vendor but can rarely collide across vendors, so match source too.
        if (!o || o.epicorOnly || String(o.source || "").trim().toLowerCase() !== "world") return o;
        if (norm(o.reference) !== targetKey) return o;
        applied = true;
        // Mirror the auto-match: flag a Sage re-sync when the order was already
        // entered in Sage and this invoice differs from what Sage last synced.
        const invoiceNeedsSync =
          Boolean(o.invoiceSageUpdate) &&
          String(invNum).trim() !== String(o.sage_reference_synced || "").trim();
        return {
          ...o,
          source_invoice: invNum,
          sage_reference: invNum,
          hasInvoiceNum: true,
          invoiceNeedsSync,
          ...(Number.isFinite(balanceDueNum) ? { billed_total: balanceDueNum } : {}),
          ...(inv.imageFileName ? { epicorInvoiceImage: inv.imageFileName } : {}),
          environmentalFeeAlert: Boolean(inv.hasEnvironmentalFee),
          ...(inv.environmentalFeeAmount ? { environmentalFeeAmount: inv.environmentalFeeAmount } : {}),
          ...(inv.date
            ? { epicorInvoiceDate: inv.date, orderDateRaw: o.orderDateRaw || inv.date, sageDate: o.sageDate || epicorDateToSageDate(inv.date) }
            : {}),
          lastUpdatedAt: new Date().toISOString(),
        };
      });
      if (!applied) return { ok: false, error: `Order ${targetRef} was not found (it may already have an invoice).` };

      const normalized = normalizeOrdersForSave(next);
      const saveRes = await api.writeOrders(normalized);
      if (!saveRes?.ok) throw new Error(saveRes?.error || "Failed to save the assignment.");
      if (ordersInitialized) {
        setOrders(normalized);
        ordersLastSavedRef.current = JSON.stringify(normalized);
        setOrdersDirty(false);
      }

      // The invoice now belongs to an order, so it's on file: mark it known and
      // drop the "not in records" count.
      setEpicorScanInvoices((prev) =>
        prev.map((i) => (norm(i.invoiceNumber) === invKey ? { ...i, known: true, assignedTo: targetRef } : i))
      );
      setEpicorScanCounts((prev) => ({
        scanned: prev.scanned,
        unknown: Math.max(0, prev.unknown - 1),
      }));
      return { ok: true };
    } catch (e) {
      console.error("[vendor] assign epicor invoice to order failed", e);
      return { ok: false, error: e?.message || "Failed to assign invoice." };
    }
  }

  // Orders eligible to receive a scanned Epicor invoice: World orders (Epicor is
  // the World vendor portal) that don't have an invoice number yet, and that
  // aren't themselves Epicor-generated. Sorted by reference for a stable dropdown.
  const assignableEpicorOrders = useMemo(() => {
    return (orders || [])
      .filter(
        (o) =>
          o &&
          !o.epicorOnly &&
          String(o.source || "").trim().toLowerCase() === "world" &&
          !String(o.source_invoice || "").trim() &&
          String(o.reference || "").trim()
      )
      .map((o) => ({
        reference: String(o.reference).trim(),
        label: `${String(o.reference).trim()}${o.seller || o.warehouse ? ` — ${o.seller || o.warehouse}` : ""}${
          o.total || o.totalRaw ? ` (${o.totalRaw || o.total})` : ""
        }`,
      }))
      .sort((a, b) => a.reference.localeCompare(b.reference));
  }, [orders]);

  // Permanently remove an order from orders.json (no archive/manifest). Used to
  // clean up Epicor-created orders. Returns {ok,error} for the caller's UI.
  async function handleDeleteOrder(refKey, source) {
    if (!api?.deleteOrder || !refKey) return { ok: false, error: "Delete is not available." };
    try {
      const res = await api.deleteOrder(refKey, source);
      if (!res?.ok) throw new Error(res?.error || "Failed to remove order.");
      if (ordersInitialized) await loadOrders();
      return { ok: true };
    } catch (e) {
      console.error("[vendor] delete order failed", e);
      return { ok: false, error: e?.message || "Failed to remove order." };
    }
  }

  // Remove the order created from an Epicor invoice, and flip the row in the
  // Epicor scan list back to "not in records" (outstanding — as if the order was
  // never made) so it can be re-created if needed.
  async function handleRemoveEpicorOrder(inv, source = "world") {
    const invNum = String(inv?.invoiceNumber || "").trim();
    if (!invNum) return { ok: false, error: "This invoice has no number." };
    // Epicor-created orders are stored with source "world"; scoping the delete to
    // that source stops a same-numbered order from another vendor being removed.
    const res = await handleDeleteOrder(invNum, source);
    if (!res.ok) return res;
    const norm = (v) => (v ? String(v).trim().toUpperCase() : "");
    const invKey = norm(invNum);
    // Only bump the "not in records" count if a matching row is actually on
    // screen and was counted as known/created (avoids drifting the tally when
    // the delete came from Order Management and the view isn't showing this row).
    const wasCounted = epicorScanInvoices.some(
      (i) => norm(i.invoiceNumber) === invKey && (i.known || i.created)
    );
    setEpicorScanInvoices((prev) =>
      prev.map((i) => (norm(i.invoiceNumber) === invKey ? { ...i, known: false, created: false } : i))
    );
    if (wasCounted) {
      setEpicorScanCounts((prev) => ({ scanned: prev.scanned, unknown: prev.unknown + 1 }));
    }
    return { ok: true };
  }

  // Delete an Epicor-generated order straight from the Order Management bubble.
  // Confirms first (permanent), then reuses the Epicor removal path so the
  // matching scan flips back to "not in records".
  async function handleDeleteEpicorOrder(order) {
    const invNum = String(order?.source_invoice || order?.invoiceNum || "").trim();
    const label = order?.reference || invNum || "this order";
    const proceed = api?.confirm
      ? await api.confirm(
          `Delete Epicor order ${label}?`,
          "This permanently removes it from Order Management. The invoice will show as not-in-records again in the Epicor view."
        )
      : true;
    if (!proceed) return;
    const src = order?.source || "world";
    const res = invNum
      ? await handleRemoveEpicorOrder({ invoiceNumber: invNum }, src)
      : await handleDeleteOrder(order?.reference || order?.__row, src);
    if (!res?.ok) setOrdersError(res?.error || "Failed to delete order.");
  }

  // Load whatever Transbec credit memos are already cached (no Gmail call) —
  // mirrors handleLoadEpicorScanned, so a restart still shows prior results.
  async function handleLoadTransbecCredits() {
    if (!api?.getTransbecCredits) return;
    try {
      setTransbecCreditError("");
      const res = await api.getTransbecCredits();
      if (!res?.ok) throw new Error(res?.error || "Failed to load Transbec credits.");
      setTransbecCredits(Array.isArray(res.credits) ? res.credits : []);
    } catch (e) {
      console.error("[vendor] load transbec credits failed", e);
      setTransbecCreditError(e?.message || "Failed to load Transbec credits.");
    }
  }

  // The "Check for Transbec Credits" button: searches Gmail for credit memo
  // emails from Transbec (subject "Credit Memo for T30252 Cust PO") and lists
  // whatever is found. There's no existing order to auto-match against — the
  // user turns a discovery into an order with the per-row "Create order" button.
  async function handleFetchTransbecCredits(fromDate, toDate) {
    if (!api?.fetchTransbecCreditInvoices) return;
    try {
      setTransbecCreditScanning(true);
      setTransbecCreditError("");
      const res = await api.fetchTransbecCreditInvoices({ fromDate, toDate });
      setTransbecCreditLog(Array.isArray(res?.statusLog) ? res.statusLog : []);
      if (!res?.ok) throw new Error(res?.error || "Failed to check for Transbec credits.");
      setTransbecCredits(Array.isArray(res.discoveries) ? res.discoveries : []);
    } catch (e) {
      console.error("[vendor] fetch transbec credits failed", e);
      setTransbecCreditError(e?.message || "Failed to check for Transbec credits.");
    } finally {
      setTransbecCreditScanning(false);
    }
  }

  // Turn a discovered Transbec credit memo into a new order in Order
  // Management — there is no existing order to patch (unlike BestBuy credits),
  // so this always creates one, keyed by the credit memo number the same way
  // Epicor-created orders are keyed by invoice number. Reads the freshest
  // orders from disk since the Epicor view can be used without Order
  // Management being open.
  async function handleCreateOrderFromTransbecCredit(credit) {
    if (!credit || !api?.writeOrders) return { ok: false, error: "Saving orders is not available." };
    const memoNum = String(credit.creditMemoNumber || "").trim();
    if (!memoNum) return { ok: false, error: "This credit memo has no number to key an order by." };
    try {
      const ordersRes = await api?.readOrders?.();
      const currentList = ordersRes?.state || ordersRes || [];
      const base = Array.isArray(currentList) ? currentList : [];

      const norm = (v) => (v ? String(v).trim().toUpperCase() : "");
      const memoKey = norm(memoNum);
      const already = base.some(
        (o) => o && (norm(o.source_invoice) === memoKey || norm(o.invoiceNum) === memoKey)
      );

      if (!already) {
        const totalNum = Number(credit.total);
        const refValue = credit.reference ? String(credit.reference).trim() : memoNum;
        const newOrder = {
          source: "transbec",
          isCredit: true,
          reference: refValue,
          __row: refValue,
          warehouse: "Transbec Credit",
          // Same Sage source code regular (scraped) Transbec orders use
          // (transbecScraper.js) — credit orders are built manually here, so
          // they'd otherwise go into Sage with no source code at all.
          sage_source: "TRA505",
          source_invoice: memoNum,
          sage_reference: memoNum,
          hasInvoiceNum: true,
          // Credit orders have no separate detail-fetch step, same as
          // Epicor/CBK/BestBuy Gmail orders — the credit total IS the detail.
          detailStored: true,
          ...(Number.isFinite(totalNum) ? { billed_total: totalNum } : {}),
          ...(credit.fileName ? { transbecCreditFile: credit.fileName } : {}),
          // The returned parts (qty/price), read straight off the credit memo
          // — same field shape as any other Transbec order's lineItems, so
          // e.g. archiving this order feeds them through the same
          // addOrderLineItemsToNewStock path as a normal order (negative
          // quantities net the returned units out of New Stock).
          lineItems: Array.isArray(credit.lineItems) ? credit.lineItems : [],
          ...(credit.poNumber ? { transbecCreditPoNumber: credit.poNumber } : {}),
          ...(credit.customerNumber ? { transbecCreditCustomerNumber: credit.customerNumber } : {}),
          lastUpdatedAt: new Date().toISOString(),
        };
        const nextList = normalizeOrdersForSave(base.concat(newOrder));
        const saveRes = await api.writeOrders(nextList);
        if (!saveRes?.ok) throw new Error(saveRes?.error || "Failed to save the new order.");
        if (ordersInitialized) {
          setOrders(nextList);
          ordersLastSavedRef.current = JSON.stringify(nextList);
          setOrdersDirty(false);
        }
      }

      setTransbecCredits((prev) =>
        prev.map((c) => (norm(c.creditMemoNumber) === memoKey ? { ...c, known: true, created: true } : c))
      );
      return { ok: true, duplicate: already };
    } catch (e) {
      console.error("[vendor] create order from transbec credit failed", e);
      return { ok: false, error: e?.message || "Failed to create order." };
    }
  }

  // Remove the order created from a Transbec credit memo, flipping the row
  // back to "not created" so it can be re-created if needed — mirrors
  // handleRemoveEpicorOrder.
  async function handleRemoveTransbecCreditOrder(credit) {
    const memoNum = String(credit?.creditMemoNumber || "").trim();
    if (!memoNum) return { ok: false, error: "This credit memo has no number." };
    const res = await handleDeleteOrder(memoNum, "transbec");
    if (!res.ok) return res;
    const norm = (v) => (v ? String(v).trim().toUpperCase() : "");
    const memoKey = norm(memoNum);
    setTransbecCredits((prev) =>
      prev.map((c) => (norm(c.creditMemoNumber) === memoKey ? { ...c, known: false, created: false } : c))
    );
    return { ok: true };
  }

  // DEV-ONLY: wipe every cached Transbec credit scan result and downloaded PDF
  // so a scan can be re-run from scratch while this feature is being built.
  // Does not touch any order already created from a credit.
  async function handleResetTransbecCredits() {
    if (!api?.resetTransbecCredits) return { ok: false, error: "Reset is not available." };
    const proceed = api?.confirm
      ? await api.confirm(
          "Clear all Transbec credit scan data?",
          "This deletes the cached scan results and every downloaded credit memo PDF. Orders already created from a credit are not affected."
        )
      : true;
    if (!proceed) return { ok: false };
    try {
      const res = await api.resetTransbecCredits();
      if (!res?.ok) throw new Error(res?.error || "Failed to clear Transbec credit scans.");
      setTransbecCredits([]);
      setTransbecCreditLog([]);
      setTransbecCreditError("");
      return { ok: true };
    } catch (e) {
      console.error("[vendor] reset transbec credits failed", e);
      setTransbecCreditError(e?.message || "Failed to clear Transbec credit scans.");
      return { ok: false, error: e?.message };
    }
  }

  // Credit memo PDFs share the gmail data dir with regular Transbec invoices,
  // so viewing reuses that same IPC handler by file name.
  async function handleViewTransbecCreditImage(fileName) {
    if (!api?.openTransbecInvoiceImage || !fileName) return;
    try {
      const res = await api.openTransbecInvoiceImage(fileName);
      if (!res?.ok) {
        setTransbecCreditError(res?.error || "Failed to open credit memo file.");
      }
    } catch (e) {
      console.error("[vendor] failed to open transbec credit file", e);
      setTransbecCreditError(e?.message || "Failed to open credit memo file.");
    }
  }

  async function handleViewEpicorInvoiceImage(fileName) {
    if (!api?.openEpicorInvoiceImage || !fileName) return;
    try {
      const res = await api.openEpicorInvoiceImage(fileName);
      if (!res?.ok) {
        setEpicorError(res?.error || "Failed to open invoice image.");
      }
    } catch (e) {
      console.error("[vendor] failed to open invoice image", e);
      setEpicorError(e?.message || "Failed to open invoice image.");
    }
  }

  // The Verify modal is shared between the Epicor (World) and Gmail (Transbec)
  // flows. Each vendor saves its invoice preview in its own folder behind its own
  // IPC channel, so pick the right image field + read/open API from the order.
  // The invoice PDF filename for a Transbec order. Back-compat: earlier builds
  // stored a (broken) PNG preview name in transbecInvoiceImage; the PDF sits
  // beside it with the same base name, so derive it for those older records.
  function transbecPdfName(order) {
    if (order?.transbecInvoiceFile) return order.transbecInvoiceFile;
    // Credit orders (isCredit: true) never have a regular invoice file, only
    // this one — safe to fall back to unconditionally.
    if (order?.transbecCreditFile) return order.transbecCreditFile;
    if (order?.transbecInvoiceImage) return order.transbecInvoiceImage.replace(/\.png$/i, ".pdf");
    return "";
  }

  function invoiceReviewApis(order) {
    if (order?.bestbuyInvoiceFile) {
      return {
        imageFile: order.bestbuyInvoiceFile,
        read: api?.readBestbuyInvoiceImage,
        open: api?.openBestbuyInvoiceImage,
      };
    }
    if (order?.cbkInvoiceFile) {
      return {
        imageFile: order.cbkInvoiceFile,
        read: api?.readCbkInvoiceImage,
        open: api?.openCbkInvoiceImage,
      };
    }
    const transbecFile = transbecPdfName(order);
    if (transbecFile) {
      return {
        imageFile: transbecFile,
        read: api?.readTransbecInvoiceImage,
        open: api?.openTransbecInvoiceImage,
      };
    }
    return {
      imageFile: order?.epicorInvoiceImage,
      read: api?.readEpicorInvoiceImage,
      open: api?.openEpicorInvoiceImage,
    };
  }

  async function handleOpenEpicorReview(order) {
    const { imageFile, read } = invoiceReviewApis(order);
    if (!imageFile) return;
    setEpicorReviewOrder(order);
    setEpicorReviewInvoiceDraft(order.source_invoice || "");
    setEpicorReviewTotalDraft(
      order.billed_total !== null && order.billed_total !== undefined ? String(order.billed_total) : ""
    );
    // Seed editable line items (epicor-only orders). "part" is the code+number
    // shown as one field; on confirm it's stored back into partNumber.
    setEpicorReviewLinesDraft(
      (Array.isArray(order.lineItems) ? order.lineItems : []).map((li) => ({
        part: `${li.partLineCode || ""} ${li.partNumber || ""}`.trim(),
        quantity: li.quantity ?? "",
        partDescription: li.partDescription || "",
        costPrice: li.costPrice ?? "",
        __orig: li,
      }))
    );
    setEpicorReviewImageDataUrl("");
    setEpicorReviewError("");
    setEpicorReviewLoading(true);
    try {
      const res = await read?.(imageFile);
      if (res?.ok && res.dataUrl) {
        setEpicorReviewImageDataUrl(res.dataUrl);
      } else {
        setEpicorReviewError(res?.error || "Failed to load invoice image.");
      }
    } catch (e) {
      setEpicorReviewError(e?.message || "Failed to load invoice image.");
    } finally {
      setEpicorReviewLoading(false);
    }
  }

  function handleCloseEpicorReview() {
    setEpicorReviewOrder(null);
    setEpicorReviewImageDataUrl("");
    setEpicorReviewInvoiceDraft("");
    setEpicorReviewTotalDraft("");
    setEpicorReviewLinesDraft([]);
    setEpicorReviewError("");
  }

  function updateEpicorReviewLine(idx, field, value) {
    setEpicorReviewLinesDraft((prev) => prev.map((l, i) => (i === idx ? { ...l, [field]: value } : l)));
  }
  function removeEpicorReviewLine(idx) {
    setEpicorReviewLinesDraft((prev) => prev.filter((_, i) => i !== idx));
  }
  function addEpicorReviewLine() {
    setEpicorReviewLinesDraft((prev) => prev.concat({ part: "", quantity: "", partDescription: "", costPrice: "" }));
  }

  async function handleConfirmEpicorReview() {
    if (!epicorReviewOrder?.reference) return;
    setEpicorReviewSaving(true);
    setEpicorReviewError("");
    try {
      const reference = epicorReviewOrder.reference;
      const nextInvoice = epicorReviewInvoiceDraft.trim();
      const totalNum = parseFloat(epicorReviewTotalDraft);
      const nextTotal = Number.isFinite(totalNum) ? Number(totalNum.toFixed(2)) : null;

      // Only epicor-generated orders get their line items edited here; other
      // vendors' orders keep whatever line items they already had.
      const nextLineItems = epicorReviewOrder.epicorOnly
        ? epicorReviewLinesDraft
            .map((l) => {
              const part = String(l.part || "").trim();
              return {
                ...(l.__orig || { addedToOutstanding: false, source: "epicor-ocr" }),
                partLineCode: "",
                partNumber: part,
                quantity: l.quantity,
                partDescription: String(l.partDescription || "").trim(),
                ...(l.costPrice !== undefined && l.costPrice !== "" ? { costPrice: l.costPrice } : {}),
              };
            })
            .filter((li) => String(li.partNumber || "").trim() || String(li.partDescription || "").trim())
        : null;

      let patchedOrders = null;
      setOrders((prev) => {
        const next = prev.map((o) => {
          if (!o?.reference || String(o.reference).trim().toUpperCase() !== String(reference).trim().toUpperCase()) {
            return o;
          }
          // Same mechanism as the manual invoice textbox: flag for Sage re-sync
          // if this order was already entered in Sage and the confirmed invoice
          // differs from what Sage last synced.
          const invoiceNeedsSync =
            Boolean(o.invoiceSageUpdate) && nextInvoice !== String(o.sage_reference_synced || "").trim();

          // Mark the total as human-verified if it matches what Sage already has
          // (or there's no Sage total yet to conflict with) — otherwise leave the
          // existing Reconcile Totals flow to surface the discrepancy.
          const sageTotalNum = Number(o.sage_total_synced ?? o.sageTotalSynced);
          const totalsMatch =
            nextTotal !== null && (!Number.isFinite(sageTotalNum) || Math.abs(nextTotal - sageTotalNum) < 0.01);

          return {
            ...o,
            source_invoice: nextInvoice,
            sage_reference: nextInvoice,
            hasInvoiceNum: Boolean(nextInvoice),
            invoiceNeedsSync,
            ...(nextTotal !== null ? { billed_total: nextTotal, totalVerified: totalsMatch } : {}),
            ...(nextLineItems ? { lineItems: nextLineItems } : {}),
            lastUpdatedAt: new Date().toISOString(),
            _localDirty: true,
          };
        });
        patchedOrders = next;
        return next;
      });
      // Dirty BEFORE attempting the save: if the write fails and the user closes
      // this modal, the corrected values stay protected (Save button live, and
      // external refreshes won't overwrite them) instead of silently vanishing.
      setOrdersDirty(true);

      if (patchedOrders && api?.writeOrders) {
        const normalized = normalizeOrdersForSave(patchedOrders);
        const saveRes = await api.writeOrders(normalized);
        if (!saveRes?.ok) throw new Error("Failed to save order. Your corrections are kept on screen — click Save to retry.");
        setOrders(normalized);
        ordersLastSavedRef.current = JSON.stringify(normalized);
        setOrdersDirty(false);
      }

      handleCloseEpicorReview();
    } catch (e) {
      console.error("[vendor] failed to save verified invoice", e);
      setEpicorReviewError(e?.message || "Failed to save.");
    } finally {
      setEpicorReviewSaving(false);
    }
  }

  // Transbec analog of handleOpenEpicor: pull invoice data from Gmail and batch-
  // fill every matching Transbec order (not just the one clicked). Reuses the
  // same invoiceNeedsSync / totalVerified logic as manual entry and Epicor.
  async function handleFetchTransbecInvoices(reference) {
    if (!api?.fetchTransbecInvoices) return;
    try {
      setTransbecFetching(true);
      setTransbecError("");
      setTransbecStatus("");
      const res = await api.fetchTransbecInvoices({ reference });
      if (!res?.ok) throw new Error(res?.error || "Failed to fetch Transbec invoices.");
      const logMsg = Array.isArray(res.statusLog) && res.statusLog.length ? res.statusLog.join("\n") : "";

      const discoveries = Array.isArray(res.discoveries) ? res.discoveries : [];
      let patchedOrders = null;
      let appliedCount = 0;

      if (discoveries.length > 0) {
        setOrders((prev) => {
          const next = prev.map((o) => {
            if (!o?.reference || (o.source_invoice || "").toString().trim()) return o;
            const orderRef = String(o.reference).trim().toUpperCase();
            const found = discoveries.find(
              (d) => d.reference && String(d.reference).trim().toUpperCase() === orderRef
            );
            if (!found) return o;
            appliedCount += 1;
            const totalNum = Number(found.total ?? found.balanceDue);
            const invoiceNeedsSync =
              Boolean(o.invoiceSageUpdate) &&
              String(found.invoiceNumber || "").trim() !== String(o.sage_reference_synced || "").trim();
            return {
              ...o,
              source_invoice: found.invoiceNumber,
              sage_reference: found.invoiceNumber,
              hasInvoiceNum: true,
              invoiceNeedsSync,
              ...(Number.isFinite(totalNum) ? { billed_total: totalNum } : {}),
              ...(found.fileName ? { transbecInvoiceFile: found.fileName } : {}),
              lastUpdatedAt: new Date().toISOString(),
              _localDirty: true,
            };
          });
          patchedOrders = next;
          return next;
        });
        // Dirty BEFORE attempting the save — see handleFetchBestbuyInvoices for
        // the full rationale (protects against silent data loss on save failure).
        setOrdersDirty(true);
      }

      let saveFailed = false;
      if (appliedCount > 0 && patchedOrders && api?.writeOrders) {
        const normalized = normalizeOrdersForSave(patchedOrders);
        try {
          const saveRes = await api.writeOrders(normalized);
          if (saveRes?.ok) {
            setOrders(normalized);
            ordersLastSavedRef.current = JSON.stringify(normalized);
            setOrdersDirty(false);
          } else {
            saveFailed = true;
            console.error("[vendor] failed to auto-save transbec matches", saveRes);
          }
        } catch (saveErr) {
          saveFailed = true;
          console.error("[vendor] failed to auto-save transbec matches", saveErr);
        }
      }

      if (saveFailed) {
        setTransbecError(
          "Filled invoice data but could not save it to orders.json. It will not survive a page refresh or another fetch until you click Save. Click Save now to retry."
        );
      }
      const appliedMsg =
        appliedCount > 0 ? `Filled invoice/total for ${appliedCount} order(s) in Order Management.` : "";
      setTransbecStatus([logMsg, appliedMsg].filter(Boolean).join("\n") || "Checked Gmail.");
    } catch (e) {
      console.error("[vendor] transbec fetch error", e);
      setTransbecError(e?.message || "Failed to fetch Transbec invoices.");
    } finally {
      setTransbecFetching(false);
    }
  }

  async function handleViewTransbecInvoiceImage(order) {
    const fileName = typeof order === "string" ? order : transbecPdfName(order);
    if (!api?.openTransbecInvoiceImage || !fileName) return;
    try {
      const res = await api.openTransbecInvoiceImage(fileName);
      if (!res?.ok) {
        setTransbecError(res?.error || "Failed to open invoice image.");
      }
    } catch (e) {
      console.error("[vendor] failed to open transbec invoice image", e);
      setTransbecError(e?.message || "Failed to open invoice image.");
    }
  }

  // BestBuy: one "BESTBUY INVOICES FOR TODAY" email holds many invoices. We match
  // each invoice to an order by packing slip (the order's reference when scraped
  // early), falling back to the invoice number, then fill total + confirm invoice #.
  //
  // Same click also checks for a BestBuy CREDIT invoice (a separate Gmail search
  // — see bestbuyCreditInvoice.js) matching this order, and — if found — fills
  // bestbuyCreditFile/bestbuyCreditTotal alongside it. Both patches land in one
  // setOrders/save pass so a credit fetch failure can't clobber an invoice match
  // that was just applied (or vice versa).
  async function handleFetchBestbuyInvoices(reference) {
    if (!api?.fetchBestbuyInvoices) return;
    try {
      setBestbuyFetching(true);
      setBestbuyError("");
      setBestbuyStatus("");
      const res = await api.fetchBestbuyInvoices({ reference });
      if (!res?.ok) throw new Error(res?.error || "Failed to fetch BestBuy invoices.");
      const logMsg = Array.isArray(res.statusLog) && res.statusLog.length ? res.statusLog.join("\n") : "";
      const discoveries = Array.isArray(res.discoveries) ? res.discoveries : [];

      let creditLogMsg = "";
      let creditDiscoveries = [];
      if (api?.fetchBestbuyCreditInvoices) {
        try {
          const creditRes = await api.fetchBestbuyCreditInvoices({ reference });
          if (creditRes?.ok) {
            creditLogMsg =
              Array.isArray(creditRes.statusLog) && creditRes.statusLog.length ? creditRes.statusLog.join("\n") : "";
            creditDiscoveries = Array.isArray(creditRes.discoveries) ? creditRes.discoveries : [];
          } else {
            console.error("[vendor] bestbuy credit invoice fetch failed", creditRes);
          }
        } catch (creditErr) {
          console.error("[vendor] bestbuy credit invoice fetch error", creditErr);
        }
      }

      let patchedOrders = null;
      let appliedCount = 0;
      let appliedCreditCount = 0;

      if (discoveries.length > 0 || creditDiscoveries.length > 0) {
        setOrders((prev) => {
          const next = prev.map((o) => {
            if (!o?.reference || o.source !== "bestbuy") return o;
            const keys = [o.reference, o.source_invoice, o.invoiceNum]
              .map((v) => (v ? String(v).trim().toUpperCase() : ""))
              .filter(Boolean);

            let patch = null;

            // Unlike World/Transbec, a BestBuy order usually already has an
            // invoice number from the site scrape, so we can't skip on that.
            // Skip only once the invoice PDF is actually attached.
            if (!o.bestbuyInvoiceFile) {
              // The order's reference is the packing slip when scraped before the
              // warehouse invoiced it, and the invoice number after — so try both,
              // and also match against an already-known invoice number.
              const found = discoveries.find(
                (d) =>
                  (d.packingSlip && keys.includes(String(d.packingSlip).trim().toUpperCase())) ||
                  (d.invoiceNumber && keys.includes(String(d.invoiceNumber).trim().toUpperCase()))
              );
              if (found) {
                appliedCount += 1;
                const totalNum = Number(found.total);
                // Keep an invoice number that's already recorded (scraped or
                // hand-corrected); only fill it in when there isn't one.
                const existingInvoice = (o.source_invoice || "").toString().trim();
                const nextInvoice = existingInvoice || found.invoiceNumber || "";
                const invoiceNeedsSync =
                  Boolean(o.invoiceSageUpdate) &&
                  String(nextInvoice).trim() !== String(o.sage_reference_synced || "").trim();
                patch = {
                  ...(nextInvoice
                    ? { source_invoice: nextInvoice, sage_reference: nextInvoice, hasInvoiceNum: true }
                    : {}),
                  invoiceNeedsSync,
                  ...(Number.isFinite(totalNum) ? { billed_total: totalNum } : {}),
                  ...(found.fileName ? { bestbuyInvoiceFile: found.fileName } : {}),
                  environmentalFeeAlert: Boolean(found.hasEnvironmentalFee),
                };
              }
            }

            // A credit invoice fills the SAME invoice # / billed total fields as
            // a regular one (a credit order carries no invoice number until the
            // warehouse credits it): its real invoice number (from the PDF body,
            // not the subject) goes in source_invoice, and its total goes in
            // billed_total — as a POSITIVE amount, even though the PDF prints it
            // as an accounting negative. bestbuyCreditFile is also kept so the
            // credit PDF stays viewable/printable and the row is flagged as a
            // credit. Skip once a credit PDF is already attached.
            if (!o.bestbuyCreditFile) {
              const foundCredit = creditDiscoveries.find(
                (d) =>
                  (d.packingSlip && keys.includes(String(d.packingSlip).trim().toUpperCase())) ||
                  (d.invoiceNumber && keys.includes(String(d.invoiceNumber).trim().toUpperCase()))
              );
              if (foundCredit) {
                appliedCreditCount += 1;
                // Guard null explicitly: Number(null) is 0, which would wrongly
                // record a $0.00 credit when the total failed to parse. Store the
                // magnitude — billed_total is always positive.
                const rawCreditTotal = foundCredit.total == null ? NaN : Number(foundCredit.total);
                const creditTotalNum = Number.isFinite(rawCreditTotal) ? Math.abs(rawCreditTotal) : NaN;
                const existingInvoice = (patch?.source_invoice || o.source_invoice || "").toString().trim();
                const nextInvoice = existingInvoice || foundCredit.invoiceNumber || "";
                const invoiceNeedsSync =
                  Boolean(o.invoiceSageUpdate) &&
                  String(nextInvoice).trim() !== String(o.sage_reference_synced || "").trim();
                patch = {
                  ...(patch || {}),
                  ...(nextInvoice
                    ? { source_invoice: nextInvoice, sage_reference: nextInvoice, hasInvoiceNum: true }
                    : {}),
                  invoiceNeedsSync,
                  ...(Number.isFinite(creditTotalNum) ? { billed_total: creditTotalNum } : {}),
                  ...(foundCredit.fileName ? { bestbuyCreditFile: foundCredit.fileName } : {}),
                  // Uniform cross-vendor marker so the "Credit" order filter can
                  // find every vendor's credits with one predicate — same flag
                  // Transbec credit orders already set at creation.
                  isCredit: true,
                };
              }
            }

            if (!patch) return o;
            return {
              ...o,
              ...patch,
              lastUpdatedAt: new Date().toISOString(),
              _localDirty: true,
            };
          });
          patchedOrders = next;
          return next;
        });
        // Mark dirty the moment the in-memory patch is applied, BEFORE the save
        // below is even attempted. If the save fails (thrown error or {ok:false}
        // — e.g. a transient failure writing orders.json on the network share),
        // this is what keeps the data from being silently lost: it re-enables
        // the Save button for a manual retry, and it stops any later full-orders
        // refresh (the file watcher's push, or another vendor fetch) from
        // overwriting these never-persisted fields with stale disk contents.
        setOrdersDirty(true);
      }

      let saveFailed = false;
      if ((appliedCount > 0 || appliedCreditCount > 0) && patchedOrders && api?.writeOrders) {
        const normalized = normalizeOrdersForSave(patchedOrders);
        try {
          const saveRes = await api.writeOrders(normalized);
          if (saveRes?.ok) {
            setOrders(normalized);
            ordersLastSavedRef.current = JSON.stringify(normalized);
            setOrdersDirty(false);
          } else {
            saveFailed = true;
            console.error("[vendor] failed to auto-save bestbuy matches", saveRes);
          }
        } catch (saveErr) {
          saveFailed = true;
          console.error("[vendor] failed to auto-save bestbuy matches", saveErr);
        }
      }

      const appliedMsg =
        appliedCount > 0 ? `Filled invoice/total for ${appliedCount} order(s) in Order Management.` : "";
      const appliedCreditMsg =
        appliedCreditCount > 0 ? `Filled credit invoice for ${appliedCreditCount} order(s).` : "";
      if (saveFailed) {
        setBestbuyError(
          "Filled invoice data but could not save it to orders.json. It will not survive a page refresh or another fetch until you click Save. Click Save now to retry."
        );
      }
      setBestbuyStatus(
        [logMsg, creditLogMsg, appliedMsg, appliedCreditMsg].filter(Boolean).join("\n") || "Checked Gmail."
      );
    } catch (e) {
      console.error("[vendor] bestbuy fetch error", e);
      setBestbuyError(e?.message || "Failed to fetch BestBuy invoices.");
    } finally {
      setBestbuyFetching(false);
    }
  }

  async function handleViewBestbuyInvoiceImage(order) {
    const fileName = typeof order === "string" ? order : order?.bestbuyInvoiceFile;
    if (!api?.openBestbuyInvoiceImage || !fileName) return;
    try {
      const res = await api.openBestbuyInvoiceImage(fileName);
      if (!res?.ok) {
        setBestbuyError(res?.error || "Failed to open invoice image.");
      }
    } catch (e) {
      console.error("[vendor] failed to open bestbuy invoice image", e);
      setBestbuyError(e?.message || "Failed to open invoice image.");
    }
  }

  // Credit invoice PDFs land in the same gmail assets dir as regular BestBuy
  // invoices, so viewing reuses that same generic open-by-filename IPC call.
  async function handleViewBestbuyCreditInvoiceImage(order) {
    const fileName = typeof order === "string" ? order : order?.bestbuyCreditFile;
    if (!api?.openBestbuyInvoiceImage || !fileName) return;
    try {
      const res = await api.openBestbuyInvoiceImage(fileName);
      if (!res?.ok) {
        setBestbuyError(res?.error || "Failed to open credit invoice image.");
      }
    } catch (e) {
      console.error("[vendor] failed to open bestbuy credit invoice image", e);
      setBestbuyError(e?.message || "Failed to open credit invoice image.");
    }
  }

  // CBK: one email per order (subject carries the order number = the order's
  // reference, attachment is one invoice named by invoice number). Mirrors the
  // BestBuy flow — fetch discovers invoices for every CBK email and batch-applies
  // them to matching orders, not just the one whose button was clicked.
  async function handleFetchCbkInvoices(reference) {
    if (!api?.fetchCbkInvoices) return;
    try {
      setCbkFetching(true);
      setCbkError("");
      setCbkStatus("");
      const res = await api.fetchCbkInvoices({ reference });
      if (!res?.ok) throw new Error(res?.error || "Failed to fetch CBK invoices.");
      const logMsg = Array.isArray(res.statusLog) && res.statusLog.length ? res.statusLog.join("\n") : "";

      const discoveries = Array.isArray(res.discoveries) ? res.discoveries : [];
      let appliedCount = 0;

      // Build the patched list synchronously from current state (NOT as a
      // side-effect inside a setState updater) so the disk write below always
      // runs with the real result. This is what makes Gmail-sourced changes
      // persist immediately: the invoice #, total and file are saved to
      // orders.json right away, without waiting for a manual Save.
      const patchedOrders = orders.map((o) => {
        if (!o?.reference || o.source !== "cbk") return o;
        // Skip once the invoice PDF is already attached (don't overwrite a
        // verified entry on a re-fetch).
        if (o.cbkInvoiceFile) return o;
        // Match on the CBK order number (the order's reference), falling back
        // to an already-known invoice number.
        const keys = [o.reference, o.source_invoice, o.invoiceNum]
          .map((v) => (v ? String(v).trim().toUpperCase() : ""))
          .filter(Boolean);
        const found = discoveries.find(
          (d) =>
            (d.reference && keys.includes(String(d.reference).trim().toUpperCase())) ||
            (d.invoiceNumber && keys.includes(String(d.invoiceNumber).trim().toUpperCase()))
        );
        if (!found) return o;
        appliedCount += 1;
        const totalNum = Number(found.total);
        // The CBK order scrape seeds source_invoice with the order number
        // (same as the reference), which is not the real invoice number — so
        // whenever the Gmail search turns up an actual invoice number, it
        // REPLACES what's there. Only fall back to the existing value if the
        // email didn't carry one.
        const existingInvoice = (o.source_invoice || "").toString().trim();
        const nextInvoice = found.invoiceNumber || existingInvoice || "";
        const invoiceNeedsSync =
          Boolean(o.invoiceSageUpdate) &&
          String(nextInvoice).trim() !== String(o.sage_reference_synced || "").trim();
        return {
          ...o,
          ...(nextInvoice ? { source_invoice: nextInvoice, sage_reference: nextInvoice, hasInvoiceNum: true } : {}),
          invoiceNeedsSync,
          ...(Number.isFinite(totalNum) ? { billed_total: totalNum } : {}),
          ...(found.fileName ? { cbkInvoiceFile: found.fileName } : {}),
          lastUpdatedAt: new Date().toISOString(),
          _localDirty: true,
        };
      });

      let saveFailed = false;
      if (appliedCount > 0) {
        // Reflect in the UI, and mark dirty BEFORE the write so a failed save
        // keeps the data recoverable (Save button stays live, and a later
        // full-orders refresh can't silently discard the never-persisted data).
        setOrders(patchedOrders);
        setOrdersDirty(true);
        if (api?.writeOrders) {
          const normalized = normalizeOrdersForSave(patchedOrders);
          try {
            const saveRes = await api.writeOrders(normalized);
            if (saveRes?.ok) {
              setOrders(normalized);
              ordersLastSavedRef.current = JSON.stringify(normalized);
              setOrdersDirty(false);
            } else {
              saveFailed = true;
              console.error("[vendor] failed to auto-save cbk matches", saveRes);
            }
          } catch (saveErr) {
            saveFailed = true;
            console.error("[vendor] failed to auto-save cbk matches", saveErr);
          }
        }
      }

      if (saveFailed) {
        setCbkError(
          "Filled invoice data but could not save it to orders.json. It will not survive a page refresh or another fetch until you click Save. Click Save now to retry."
        );
      }
      const appliedMsg =
        appliedCount > 0 ? `Filled invoice/total for ${appliedCount} order(s) in Order Management.` : "";
      setCbkStatus([logMsg, appliedMsg].filter(Boolean).join("\n") || "Checked Gmail.");
    } catch (e) {
      console.error("[vendor] cbk fetch error", e);
      setCbkError(e?.message || "Failed to fetch CBK invoices.");
    } finally {
      setCbkFetching(false);
    }
  }

  async function handleViewCbkInvoiceImage(order) {
    const fileName = typeof order === "string" ? order : order?.cbkInvoiceFile;
    if (!api?.openCbkInvoiceImage || !fileName) return;
    try {
      const res = await api.openCbkInvoiceImage(fileName);
      if (!res?.ok) {
        setCbkError(res?.error || "Failed to open invoice image.");
      }
    } catch (e) {
      console.error("[vendor] failed to open cbk invoice image", e);
      setCbkError(e?.message || "Failed to open invoice image.");
    }
  }

  // Sends page 1 of the invoice straight to the printer with no dialog, same
  // as Sage's print button — uses the printer configured in Settings, or the
  // OS default if none is set. Because it's silent there's no "did the user
  // actually print" signal to wait for, so "printed" is recorded once the
  // print job is handed off successfully.
  async function handlePrintVendorInvoice(order, vendor) {
    const fileName =
      vendor === "transbec"
        ? transbecPdfName(order)
        : vendor === "cbk"
        ? order?.cbkInvoiceFile
        : vendor === "bestbuy-credit"
        ? order?.bestbuyCreditFile
        : order?.bestbuyInvoiceFile;
    const setError =
      vendor === "transbec" ? setTransbecError : vendor === "cbk" ? setCbkError : setBestbuyError;
    if (!fileName || !api?.printInvoiceSilent || !order?.reference) return;
    const printKey = `${vendor}:${order.reference}`;
    // Transbec credit memos print in full — the actual "Credit Memo BALANCE
    // DUE" and signature stub live on page 2, unlike a regular invoice where
    // page 1 alone is enough. Every other vendor/print stays page-1-only.
    const allPages = vendor === "transbec" && fileName === order?.transbecCreditFile;
    try {
      setInvoicePrintingRef(printKey);
      setError("");
      const res = await api.printInvoiceSilent(fileName, allPages);
      if (!res?.ok) {
        throw new Error(res?.error || "Failed to print invoice.");
      }

      const field =
        vendor === "transbec"
          ? "transbecInvoicePrinted"
          : vendor === "cbk"
          ? "cbkInvoicePrinted"
          : vendor === "bestbuy-credit"
          ? "bestbuyCreditInvoicePrinted"
          : "bestbuyInvoicePrinted";
      updateOrderByKeyAndSave(order.reference, { [field]: true, [`${field}At`]: new Date().toISOString() });
    } catch (e) {
      console.error(`[vendor] failed to print ${vendor} invoice`, e);
      setError(e?.message || "Failed to print invoice.");
    } finally {
      setInvoicePrintingRef("");
    }
  }

  // "Print All" for the Not Printed filter: prints each order the same way its
  // own "Print Invoice" button would, one at a time (reuses invoicePrintingRef
  // so there's never more than one silent print job in flight).
  async function handlePrintAllNotPrinted(ordersToPrint) {
    const list = Array.isArray(ordersToPrint) ? ordersToPrint : [];
    if (!list.length || printAllRunning) return;
    setPrintAllRunning(true);
    try {
      for (const order of list) {
        if ((order.transbecInvoiceFile || order.transbecInvoiceImage) && !order.transbecInvoicePrinted) {
          await handlePrintVendorInvoice(order, "transbec");
        }
        if (order.bestbuyInvoiceFile && !order.bestbuyInvoicePrinted) {
          await handlePrintVendorInvoice(order, "bestbuy");
        }
        if (order.bestbuyCreditFile && !order.bestbuyCreditInvoicePrinted) {
          await handlePrintVendorInvoice(order, "bestbuy-credit");
        }
        if (order.cbkInvoiceFile && !order.cbkInvoicePrinted) {
          await handlePrintVendorInvoice(order, "cbk");
        }
      }
    } finally {
      setPrintAllRunning(false);
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
      const normItems = filterPendingDeleted(normalizeItems(latestItems || []));
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

  async function handlePurchasesSearch() {
    const q = purchasesSearchTerm.trim();
    if (!q) {
      setPurchasesError("Enter a part number to search.");
      setPurchasesResults([]);
      return;
    }
    try {
      setPurchasesError("");
      setPurchasesSearching(true);
      const res = await api.searchOrdersArchive(q);
      if (!res?.ok) throw new Error(res?.error || "Search failed.");
      setPurchasesResults(res.results || []);
    } catch (e) {
      console.error("[purchases search]", e);
      setPurchasesError(e?.message || "Failed to search purchases archive.");
      setPurchasesResults([]);
    } finally {
      setPurchasesSearching(false);
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

  // Whenever either Sage flow is on, subscribe to orders.json updates pushed
  // from main (the main process owns the file watcher itself) and do one read.
  const sageAnyEnabled = sagePoEnabled || sageInvoiceEnabled;
  useEffect(() => {
    if (!api?.onOrdersUpdated) return;
    if (!sageAnyEnabled) {
      setSageReadyOrders([]);
      setSageInvoiceReadyOrders([]);
      return;
    }
    let cancelled = false;
    const offOrdersUpdated = api.onOrdersUpdated((arr) => handleOrdersUpdatedExternally(arr));
    (async () => {
      try {
        const latest = await api.readOrders?.();
        if (!cancelled) handleOrdersUpdatedExternally(latest);
      } catch (e) {
        console.error("[orders] read error", e);
      }
    })();
    return () => {
      cancelled = true;
      offOrdersUpdated?.();
    };
  }, [sageAnyEnabled, ordersDirty]);

  // Purchase-order processing: claim/release the cross-machine lock.
  useEffect(() => {
    if (!api?.setSagePoActive) {
      if (sagePoEnabled) setSageWatchError("Sage is unavailable in this environment.");
      return;
    }
    let cancelled = false;
    if (!sagePoEnabled) {
      setSageWatchError("");
      api.setSagePoActive(false).catch(() => {});
      return;
    }
    setSageWatchError("");
    (async () => {
      try {
        const res = await api.setSagePoActive(true);
        if (res && !res.ok && !cancelled) {
          if (res.error === 'sage-locked') {
            setSageWatchError(`Sage purchase orders are active on another machine (${res.lockedBy || 'unknown'}). Turn it off there first.`);
          } else {
            setSageWatchError(res.error || "Failed to enable Sage purchase orders.");
          }
          setSagePoEnabled(false);
        }
      } catch (e) {
        console.error("[sage-po] enable error", e);
        if (!cancelled) setSageWatchError(e?.message || "Failed to enable Sage purchase orders.");
      }
    })();
    return () => { cancelled = true; };
  }, [sagePoEnabled]);

  // Invoice processing: local only, no lock.
  useEffect(() => {
    if (!api?.setSageInvoiceActive) {
      if (sageInvoiceEnabled) setSageInvoiceError("Sage is unavailable in this environment.");
      return;
    }
    if (!sageInvoiceEnabled) {
      setSageInvoiceError("");
      api.setSageInvoiceActive(false).catch(() => {});
      return;
    }
    setSageInvoiceError("");
    api.setSageInvoiceActive(true).catch((e) => {
      console.error("[sage-invoice] enable error", e);
      setSageInvoiceError(e?.message || "Failed to enable Sage invoices.");
      setSageInvoiceEnabled(false);
    });
  }, [sageInvoiceEnabled]);

  // Subscribe to sage lock changes pushed from main process (purchase orders only)
  useEffect(() => {
    if (!api?.onSageLockChanged) return;
    const off = api.onSageLockChanged((data) => {
      setSageLockInfo(data ? { lock: data.lock, lockIsLive: data.lockIsLive, ownMachineId: data.ownMachineId } : null);
      if (data?.forcedOff && sagePoEnabled) {
        setSagePoEnabled(false);
        setSageWatchError(`Sage purchase orders were claimed by ${data.lock?.machineId || 'another machine'}.`);
      }
    });
    // Load initial lock state
    api.getSageLock?.().then((res) => {
      if (res?.ok) setSageLockInfo({ lock: res.lock, lockIsLive: res.lockIsLive, ownMachineId: res.ownMachineId });
    }).catch(() => {});
    return () => off?.();
  }, [sagePoEnabled]);

  // A crashed lock-holder stops writing the lock file, so no watcher event fires
  // when its heartbeat goes stale. While a foreign live lock is shown, re-poll so
  // the "held by X" state clears on its own once the lock expires.
  useEffect(() => {
    const foreignLive =
      sageLockInfo?.lockIsLive &&
      sageLockInfo?.lock?.machineId &&
      sageLockInfo?.ownMachineId &&
      sageLockInfo.lock.machineId !== sageLockInfo.ownMachineId;
    if (!foreignLive || !api?.getSageLock) return;
    const id = setInterval(() => {
      api.getSageLock().then((res) => {
        if (res?.ok) setSageLockInfo({ lock: res.lock, lockIsLive: res.lockIsLive, ownMachineId: res.ownMachineId });
      }).catch(() => {});
    }, 15000);
    return () => clearInterval(id);
  }, [sageLockInfo?.lockIsLive, sageLockInfo?.lock?.machineId, sageLockInfo?.ownMachineId]);

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
    const needsOrders = currentView === "order-management";
    if (needsOrders && !ordersInitialized && !ordersLoading) {
      loadOrders();
    }
  }, [currentView, ordersInitialized, ordersLoading]);

  useEffect(() => {
    setSageReadyOrders((orders || []).filter((o) => o && o.sage_trigger));
  }, [orders]);

  const todayRangeMs = () => {
    const now = new Date();
    return {
      start: new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime(),
      end: new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime(),
    };
  };

  const isOrderToday = (order, todayStart, todayEnd) => {
    const raw = order?.orderDate || order?.orderDateRaw;
    const time = new Date(raw || 0).getTime();
    if (Number.isNaN(time)) return false;
    return time >= todayStart && time < todayEnd;
  };

  const { filteredOrders, orderFilterCounts } = useMemo(() => {
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
      // Credit orders are excluded even ahead of the dirty-edit bypass below —
      // an in-progress edit on a credit order still must not leak it into any
      // filter other than "Credit".
      if (order?.isCredit === true) return ordersPickupFilter === "credit";
      if (order?._localDirty) return true;
      return matchesOrdersPickupFilter(order, ordersPickupFilter);
    });

    const { start: todayStart, end: todayEnd } = todayRangeMs();

    const todayFiltered = ordersTodayOnly
      ? pickupFiltered.filter((order) => isOrderToday(order, todayStart, todayEnd))
      : pickupFiltered;

    // sort by orderDate descending (newest first), fallback to orderDateRaw string
    const sorted = [...(todayFiltered || [])].sort((a, b) => {
      const da = new Date(a?.orderDate || a?.orderDateRaw || 0).getTime();
      const db = new Date(b?.orderDate || b?.orderDateRaw || 0).getTime();
      if (Number.isNaN(da) && Number.isNaN(db)) return 0;
      if (Number.isNaN(da)) return 1;
      if (Number.isNaN(db)) return -1;
      return db - da;
    });

    // Badge counts for the filter buttons: scoped by search + Today (same as
    // the visible list) but NOT by which pickup filter is currently selected,
    // so every button always shows how many orders it would surface.
    const countScope = ordersTodayOnly
      ? filtered.filter((order) => isOrderToday(order, todayStart, todayEnd))
      : filtered;
    const counts = {};
    [
      "not-picked",
      "not-arrived",
      "not-entered-sage",
      "no-invoice",
      "not-confirmed",
      "not-printed",
      "needs-archive",
      "credit",
    ].forEach((value) => {
      counts[value] = countScope.filter((order) => matchesOrdersPickupFilter(order, value)).length;
    });

    return { filteredOrders: sorted, orderFilterCounts: counts };
  }, [orders, ordersSearch, ordersPickupFilter, ordersTodayOnly]);

  const hasSearch = ordersSearch.trim().length > 0;

  const epicorNeedsAssignmentCount = useMemo(
    () => epicorScanInvoices.filter((i) => !i.known && !i.created && !i.assignedTo).length,
    [epicorScanInvoices]
  );
  const viewBadges = { epicor: epicorNeedsAssignmentCount };

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
            <ViewTabs currentView={currentView} onSelect={setCurrentView} badges={viewBadges} />
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
            sagePoEnabled={sagePoEnabled}
            onToggleSagePo={handleSagePoToggleClick}
            sageInvoiceEnabled={sageInvoiceEnabled}
            onToggleSageInvoice={handleSageInvoiceToggleClick}
            sageLockInfo={sageLockInfo}
            sageReadyOrders={sageReadyOrders}
            sageInvoiceReadyOrders={sageInvoiceReadyOrders}
            sageWatchError={sageWatchError}
            sageInvoiceError={sageInvoiceError}
          />
        ) : isBubbleFlowView ? (
          <>
            {currentView === "cash-sale-flow" && (
              <div className="px-4 pt-3 pb-1">
                <div className="inline-flex items-center gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 shadow-sm flex-wrap">
                  <span className="text-sm font-medium text-slate-600 whitespace-nowrap">Auto-fill from CashPad</span>
                  <div className="flex items-center gap-1.5">
                    <label className="text-xs text-slate-500 whitespace-nowrap">Markup %</label>
                    <input
                      type="number"
                      min="0"
                      step="1"
                      className="w-20 rounded-lg border border-slate-200 px-2 py-1 text-sm text-center focus:outline-none focus:ring-1 focus:ring-indigo-400"
                      value={cashPadMarkup}
                      onChange={(e) => setCashPadMarkup(e.target.value)}
                      onFocus={handleFieldFocus}
                      onBlur={handleFieldBlur}
                    />
                    <span className="text-xs text-slate-400">% + 13% tax</span>
                  </div>
                  <button
                    onClick={handleFillFromCashPad}
                    className="rounded-xl bg-indigo-600 px-4 py-1.5 text-sm font-semibold text-white shadow hover:bg-indigo-700 whitespace-nowrap"
                  >
                    Fill Payments
                  </button>
                  {fillCashPadResult && (
                    <span className="text-sm text-emerald-700 font-medium">{fillCashPadResult}</span>
                  )}
                </div>
              </div>
            )}
          <StockFlowView
            newBubbleName={newBubbleName}
            setNewBubbleName={setNewBubbleName}
            handleFieldFocus={handleFieldFocus}
            handleFieldBlur={handleFieldBlur}
            addBubble={addBubble}
            showCreateBubble={currentView === "stock-flow" || currentView === "cash-sale-flow"}
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
            deleteTargets={currentView === "cash-sale-flow" ? CASH_SALE_DELETE_DESTINATIONS : DELETE_DESTINATIONS}
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
            onDeletePayment={handleDeletePayment}
            showSageSalesAction={currentView === "sage-ar-queue" || currentView === "cash-sale-flow"}
            defaultSageCustomerCode={currentView === "cash-sale-flow" ? "CAS202" : ""}
            onSageSalesInvoice={async (bubbleName, customerCode, notes, paymentType) => {
              const res = await api.sageSalesInvoice(bubbleName, customerCode, notes || "", paymentType || "");
              if (!res?.ok) {
                console.error("[sage-sales] invoice failed", res);
                alert(res?.error || "Sage Sales Invoice failed. Check the console for details.");
              }
            }}
          />
          </>
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
            orderFilterCounts={orderFilterCounts}
            handleOrderCheckboxChange={handleOrderCheckboxChange}
            handleOrderFieldChange={handleOrderFieldChange}
            onMarkForSage={handleOrderSageTrigger}
            onBubblifyOrder={handleBubblifyOrder}
            onMarkComplete={handleMarkComplete}
            onReconcileTotals={handleReconcileTotals}
            onArchiveOrder={handleArchiveOrderWithConfirm}
            onDeleteOrder={handleDeleteEpicorOrder}
            hasSearch={hasSearch}
            onGetWorldOrders={handleGetWorldOrders}
            worldOrdersRunning={worldOrdersRunning}
            worldOrdersStatus={worldOrdersStatus}
            worldOrdersError={worldOrdersError}
            onGetCbkOrders={handleGetCbkOrders}
            cbkOrdersRunning={cbkOrdersRunning}
            cbkOrdersStatus={cbkOrdersStatus}
            cbkOrdersError={cbkOrdersError}
            onGetTigerOrders={handleGetTigerOrders}
            tigerOrdersRunning={tigerOrdersRunning}
            tigerOrdersStatus={tigerOrdersStatus}
            tigerOrdersError={tigerOrdersError}
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
            onClearOrderFetchMessage={clearOrderFetchMessage}
            onClearInvoiceFetchMessage={clearInvoiceFetchMessage}
            onOpenEpicor={handleOpenEpicor}
            onConfirmOrderEdit={(key) => updateOrderByKeyAndSave(key, {})}
            epicorOpening={epicorOpening}
            epicorStatus={epicorStatus}
            epicorError={epicorError}
            onViewEpicorInvoiceImage={handleViewEpicorInvoiceImage}
            onVerifyEpicorInvoice={handleOpenEpicorReview}
            onFetchTransbecInvoices={handleFetchTransbecInvoices}
            transbecFetching={transbecFetching}
            transbecStatus={transbecStatus}
            transbecError={transbecError}
            onViewTransbecInvoiceImage={handleViewTransbecInvoiceImage}
            onVerifyTransbecInvoice={handleOpenEpicorReview}
            onPrintTransbecInvoice={(order) => handlePrintVendorInvoice(order, "transbec")}
            onViewTransbecCreditInvoiceImage={(order) => handleViewTransbecCreditImage(order?.transbecCreditFile)}
            onFetchBestbuyInvoices={handleFetchBestbuyInvoices}
            bestbuyFetching={bestbuyFetching}
            bestbuyStatus={bestbuyStatus}
            bestbuyError={bestbuyError}
            onViewBestbuyInvoiceImage={handleViewBestbuyInvoiceImage}
            onVerifyBestbuyInvoice={handleOpenEpicorReview}
            onPrintBestbuyInvoice={(order) => handlePrintVendorInvoice(order, "bestbuy")}
            onViewBestbuyCreditInvoiceImage={handleViewBestbuyCreditInvoiceImage}
            onPrintBestbuyCreditInvoice={(order) => handlePrintVendorInvoice(order, "bestbuy-credit")}
            onFetchCbkInvoices={handleFetchCbkInvoices}
            cbkFetching={cbkFetching}
            cbkStatus={cbkStatus}
            cbkError={cbkError}
            onViewCbkInvoiceImage={handleViewCbkInvoiceImage}
            onVerifyCbkInvoice={handleOpenEpicorReview}
            onPrintCbkInvoice={(order) => handlePrintVendorInvoice(order, "cbk")}
            invoicePrintingRef={invoicePrintingRef}
            onPrintAllNotPrinted={handlePrintAllNotPrinted}
            printAllRunning={printAllRunning}
            onArchiveAllNeedsArchive={handleArchiveAllNeedsArchive}
            archiveAllRunning={archiveAllRunning}
            onUpdateInvoiceTrigger={handleUpdateInvoiceTrigger}
          />
        ) : currentView === "epicor" ? (
          <EpicorView
            onScan={handleScanEpicorRange}
            scanning={epicorScanning}
            results={epicorScanInvoices}
            error={epicorScanError}
            statusLog={epicorScanLog}
            scannedCount={epicorScanCounts.scanned}
            unknownCount={epicorScanCounts.unknown}
            onViewInvoiceImage={handleViewEpicorInvoiceImage}
            onCreateOrder={handleCreateOrderFromEpicorInvoice}
            onRemoveOrder={handleRemoveEpicorOrder}
            onRescanInvoice={handleRescanEpicorInvoice}
            onLoadScanned={handleLoadEpicorScanned}
            assignableOrders={assignableEpicorOrders}
            onAssignOrder={handleAssignEpicorInvoiceToOrder}
            transbecCredits={transbecCredits}
            transbecCreditScanning={transbecCreditScanning}
            transbecCreditError={transbecCreditError}
            transbecCreditLog={transbecCreditLog}
            onFetchTransbecCredits={handleFetchTransbecCredits}
            onLoadTransbecCredits={handleLoadTransbecCredits}
            onCreateTransbecCreditOrder={handleCreateOrderFromTransbecCredit}
            onRemoveTransbecCreditOrder={handleRemoveTransbecCreditOrder}
            onViewTransbecCreditImage={handleViewTransbecCreditImage}
            onResetTransbecCredits={handleResetTransbecCredits}
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
            purchasesSearchTerm={purchasesSearchTerm}
            setPurchasesSearchTerm={setPurchasesSearchTerm}
            onPurchasesSearch={handlePurchasesSearch}
            purchasesSearching={purchasesSearching}
            purchasesResults={purchasesResults}
            purchasesError={purchasesError}
            items={items}
            onPurgeOldOrders={() => api.purgeOldOrdersArchive()}
            onAddLineToCashSales={async (order, line) => {
              const res = await api.addArchiveLineToCashSales(order, line);
              if (res?.ok) {
                try {
                  const latest = await api.readItems();
                  const norm = filterPendingDeleted(normalizeItems(latest || []));
                  setItems((prev) => {
                    const merged = mergeItems(prev, norm);
                    lastSavedRef.current = JSON.stringify(merged);
                    ensureBubblesForItems(merged, setBubbles);
                    return merged;
                  });
                } catch (e) {
                  console.error("[archive-add] item refresh failed", e);
                }
              }
              return res;
            }}
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

      {epicorReviewOrder && (
        <div className="fixed inset-0 z-[5000] bg-slate-900/60 flex items-center justify-center px-4">
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-[95vw] p-6 flex flex-col gap-4 max-h-[95vh]">
            <div className="flex items-center justify-between">
              <h2 className="text-xl font-semibold text-slate-800">
                Verify Invoice — {epicorReviewOrder.reference}
              </h2>
              <button className="text-slate-500 hover:text-slate-700" onClick={handleCloseEpicorReview}>
                x
              </button>
            </div>
            <p className="text-sm text-slate-500">
              Compare the invoice against the stored values below. Edit either field if it was read
              wrong, then confirm.
            </p>
            {epicorReviewError && (
              <div className="rounded-xl bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">
                {epicorReviewError}
              </div>
            )}
            <div className="grid gap-4 lg:grid-cols-[1fr,320px] overflow-auto">
              <div className="rounded-2xl border border-slate-200 bg-slate-50 flex items-center justify-center overflow-auto min-h-[400px] max-h-[85vh]">
                {epicorReviewLoading ? (
                  <div className="text-sm text-slate-500 p-6">Loading invoice...</div>
                ) : epicorReviewImageDataUrl.startsWith("data:application/pdf") ? (
                  // Transbec invoices are shown as the real PDF (Chromium's viewer);
                  // rasterizing them to an image drops most of the page.
                  <iframe
                    src={epicorReviewImageDataUrl}
                    title="Invoice PDF"
                    className="w-full h-[85vh] border-0"
                  />
                ) : epicorReviewImageDataUrl ? (
                  <img src={epicorReviewImageDataUrl} alt="Scanned invoice" className="max-w-full max-h-[85vh] h-auto" />
                ) : (
                  <div className="text-sm text-slate-500 p-6">No invoice available.</div>
                )}
              </div>
              <div className="flex flex-col gap-4">
                <div className="flex flex-col gap-1">
                  <label className="text-sm uppercase tracking-wide text-slate-500">Invoice #</label>
                  <input
                    className="rounded-lg border border-slate-300 px-4 py-3 text-2xl font-semibold"
                    value={epicorReviewInvoiceDraft}
                    onChange={(e) => setEpicorReviewInvoiceDraft(e.target.value)}
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-sm uppercase tracking-wide text-slate-500">Billed Total</label>
                  <input
                    className="rounded-lg border border-slate-300 px-4 py-3 text-2xl font-semibold"
                    value={epicorReviewTotalDraft}
                    onChange={(e) => setEpicorReviewTotalDraft(e.target.value)}
                  />
                </div>

                {epicorReviewOrder.epicorOnly && (
                  <div className="flex flex-col gap-2">
                    <div className="flex items-center justify-between">
                      <label className="text-sm uppercase tracking-wide text-slate-500">
                        Line Items ({epicorReviewLinesDraft.length})
                      </label>
                      <button
                        type="button"
                        className="text-xs font-semibold text-emerald-700 border border-emerald-200 rounded-full px-2 py-1 hover:bg-emerald-50"
                        onClick={addEpicorReviewLine}
                      >
                        + Add line
                      </button>
                    </div>
                    <p className="text-xs text-slate-400">
                      Read by OCR — check each against the invoice and fix the part #, quantity, or
                      description as needed.
                    </p>
                    {epicorReviewLinesDraft.length === 0 && (
                      <div className="text-xs text-slate-400 border border-dashed border-slate-200 rounded-lg p-3">
                        No line items were read. Use “Add line” to enter them from the invoice.
                      </div>
                    )}
                    <div className="flex flex-col gap-2 max-h-[45vh] overflow-auto pr-1">
                      {epicorReviewLinesDraft.map((l, idx) => (
                        <div key={idx} className="rounded-xl border border-slate-200 p-2 flex flex-col gap-1.5">
                          <input
                            className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm font-semibold"
                            placeholder="Part #"
                            value={l.part}
                            onChange={(e) => updateEpicorReviewLine(idx, "part", e.target.value)}
                          />
                          <input
                            className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
                            placeholder="Description"
                            value={l.partDescription}
                            onChange={(e) => updateEpicorReviewLine(idx, "partDescription", e.target.value)}
                          />
                          <div className="flex items-center gap-2">
                            <input
                              className="w-16 rounded-lg border border-slate-300 px-2 py-1.5 text-sm text-center"
                              placeholder="Qty"
                              value={l.quantity}
                              onChange={(e) => updateEpicorReviewLine(idx, "quantity", e.target.value)}
                            />
                            {l.costPrice !== "" && l.costPrice !== undefined && (
                              <span className="text-xs text-slate-400">@ ${l.costPrice}</span>
                            )}
                            <button
                              type="button"
                              className="ml-auto text-xs font-semibold text-red-600 hover:text-red-700"
                              onClick={() => removeEpicorReviewLine(idx)}
                            >
                              Remove
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
            <div className="flex justify-end gap-3">
              <button
                className="px-4 py-2 rounded-full border border-slate-300 text-slate-700"
                onClick={handleCloseEpicorReview}
                disabled={epicorReviewSaving}
              >
                Cancel
              </button>
              <button
                className="px-5 py-2 rounded-full bg-indigo-600 text-white shadow hover:bg-indigo-700 disabled:opacity-60"
                onClick={handleConfirmEpicorReview}
                disabled={epicorReviewSaving}
              >
                {epicorReviewSaving ? "Saving..." : "Confirm"}
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
