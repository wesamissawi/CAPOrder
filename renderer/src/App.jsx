// src/App.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import api from "./api";
import InvoicePreview, {
  INVOICE_DOCUMENT_DEFAULTS,
  QUOTE_DOCUMENT_TITLE,
} from "./components/InvoicePreview";
import DraftInput from "./components/DraftInput";
import QtyConfirmModal from "./components/QtyConfirmModal";
import ConflictReview from "./components/ConflictReview";
import DashboardView from "./views/DashboardView";
import OrderManagementView from "./views/OrderManagementView";
import OrderAssignmentView from "./views/OrderAssignmentView";
import SalesOrderView from "./views/SalesOrderView";
import CashSalesView from "./views/CashSalesView";
import CreditsView from "./views/CreditsView";
import PaymentManagementView from "./views/PaymentManagementView";
import SageRunsView from "./views/SageRunsView";
import ReturnsManagementView from "./views/ReturnsManagementView";
import ArchiveSearchView from "./views/ArchiveSearchView";
import SettingsView from "./views/SettingsView";
import RulesView from "./views/RulesView";
import {
  DEFAULT_BUBBLES,
  normalizeItems,
  ensureBubblesForItems,
  groupItemsByBubble,
  uniqueName,
  makeUid,
  bubbleIdForName,
  computeBubblePrintSignature,
} from "./utils/inventory";
import { computeDiscountedItemPrices, computeDocumentTotals } from "./utils/quote";
import { looksLikeCredit } from "./utils/qtyDiscrepancy";
import { isOrderSageLocked, orderKeyMatches } from "./utils/sageLock";
import { applyInvoiceEnvironmentalFees } from "./utils/environmentalFee";
import {
  JOB_CLAIM_POLL_MS,
  JOB_LABELS,
  JOB_POLL_MS,
  isTerminalJob,
  jobTimeoutMs,
  resolveRoleTarget,
} from "./utils/automation";
import {
  GHOST_SAGE_POLL_MS,
  GHOST_SAGE_WAIT_MS,
  GHOST_TICK_MS,
  sagePoMachine,
  ghostDayKey,
  ghostOrderKey,
  ghostPrintTargets,
  ghostQueuedKeys,
  ghostSagePendingCount,
  ghostSageInvoiceUpdateTargets,
  ghostSageQueueTargets,
  ghostSlotKey,
  ghostCreditsRunKey,
  ghostTigerRunKey,
  ghostWorldPoRunKey,
  isWithinGhostHours,
  shouldFetchBestbuyInvoices,
  shouldFetchCredits,
  shouldFetchTigerOrders,
  shouldFetchWorldPoInvoices,
} from "./utils/ghostMode";

const DEFAULT_BUBBLE_NAMES = new Set(DEFAULT_BUBBLES.map((b) => b.name));

// How long an item change is allowed to sit in memory before it is published.
// Short enough to be invisible, long enough that one user action (which often
// fires several setItems calls in a row) becomes one commit rather than four.
// See the write-through save effect for why this is no longer a ten-second
// "don't hammer the share" window.
const SAVE_COALESCE_MS = 250;
// How long to wait before retrying a save the main process refused (a transient
// SMB error, typically). See saveRetryTick for why a retry has to be automatic.
const SAVE_RETRY_MS = 3000;

// Union of the field names already edited on an order and the ones in a new
// patch. Bookkeeping fields are excluded — they change on every edit and would
// otherwise make every order look like it had been touched everywhere.
const DIRTY_FIELD_IGNORE = new Set(["lastUpdatedAt", "_localDirty", "_dirtyFields"]);
function mergeDirtyFields(existing, patchVal) {
  const set = new Set(Array.isArray(existing) ? existing : []);
  Object.keys(patchVal || {}).forEach((f) => {
    if (!DIRTY_FIELD_IGNORE.has(f)) set.add(f);
  });
  return Array.from(set);
}

// Debug logger — prints to the renderer DevTools console AND forwards to the
// main-process terminal (via api.debugLog) so logs can be copied from the
// window where `npm start` runs. Prefixed/tagged so they're easy to grep.
function dbg(tag, ...args) {
  try {
    console.log(`[cashpad] ${tag}`, ...args);
    api.debugLog?.(`[cashpad] ${tag}`, ...args);
  } catch {
    /* never let logging throw */
  }
}

// Shared between the orders pickup-filter switch and the filter-button badge
// counts, so the two never drift out of sync.
// BestBuy specifically: order is already in Sage but its emailed invoice
// hasn't been matched yet (see handleFetchBestbuyInvoices). Mirrors the
// "no invoice file yet" check gating the "Get Invoice from Gmail" button in
// OrderManagementView.jsx.
function isWaitingOnInvoice(order) {
  return (
    (order?.source || "").toString().trim().toLowerCase() === "bestbuy" &&
    Boolean(order?.enteredInSage) &&
    !order?.bestbuyInvoiceFile &&
    !order?.bestbuyCreditFile
  );
}

// Identity for the pickup pin (see pinnedPickup below). Prefers __uid so the
// pin survives a reference being corrected mid-session, and otherwise falls
// back to the same reference/__row key the order cards use.
function orderPinKey(order) {
  const uid = (order?.__uid || "").toString().trim();
  if (uid) return `uid:${uid}`;
  return `ref:${(order?.reference || order?.__row || "").toString().trim().toUpperCase()}`;
}

// The order as the list should sort and filter it right now. Checking "Picked
// Up"/"Arrived" saves immediately (handleOrderCheckboxChange), which used to
// re-bucket the card the instant it was clicked — yanking it out from under
// the cursor, or off the page entirely when the current pickup filter excludes
// it. While a pin is held these two fields read as they were when the pin was
// taken, so the card stays put. Only the list position is frozen; the checkbox
// itself, the card body and the badge counts all still show live values.
function pinnedOrderView(order, pinnedPickup) {
  const pin = pinnedPickup?.get(orderPinKey(order));
  if (!pin) return order;
  return { ...order, pickedUp: pin.pickedUp, inStore: pin.inStore };
}

function matchesOrdersPickupFilter(order, value) {
  // Credit orders live entirely under their own "Credit" filter — regardless
  // of what state they're in (confirmed, picked up, invoiced, etc.) they must
  // never surface under any other filter, including "All".
  if (value !== "credit" && looksLikeCredit(order)) return false;
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
    // Every credit invoice, any vendor. Two ways in, both covered by
    // looksLikeCredit: an explicit `isCredit` (Transbec's standalone credit
    // orders set it at creation, BestBuy's credit patch in
    // handleFetchBestbuyInvoices sets it on the order it patches, and every
    // scraper now stamps it via sageStandardize), or the order's own negative
    // shape — which is what catches a return scraped before any credit invoice
    // for it exists, and what reclassifies orders scraped by older builds.
    case "credit":
      return looksLikeCredit(order);
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

// Build the return-requisition slips out of a list of items plus the tracked
// slip metadata. Slips = the metadata list unioned with any slip ids found on
// items, so a slip still shows even if the (per-machine) empty-slip metadata was
// lost. Once a slip has parts the ITEMS are the source of truth for its PO and
// status, since those sync between machines and the metadata does not.
// Callers choose which item list to pass: the Returns view passes the
// age-filtered list, the credit matcher passes every item (see its call site).
function deriveReturnSlips(itemList, slipMeta, unspecifiedWarehouse) {
  const slipItems = new Map(); // slipId -> items[]
  (itemList || []).forEach((it) => {
    if ((it.allocated_to || "").toLowerCase() !== "returns") return;
    const slipId = it.return_slip_id || "";
    if (!slipId) return;
    if (!slipItems.has(slipId)) slipItems.set(slipId, []);
    slipItems.get(slipId).push(it);
  });

  const byId = new Map();
  (slipMeta || []).forEach((s) => {
    if (s && s.id) {
      byId.set(s.id, {
        id: s.id,
        warehouse: s.warehouse || "",
        date: s.date || "",
        po: s.po || "",
        status: s.status || "open",
      });
    }
  });
  slipItems.forEach((its, id) => {
    if (!byId.has(id)) {
      const sample = its[0] || {};
      byId.set(id, {
        id,
        warehouse: (sample.warehouse || "").trim() || unspecifiedWarehouse,
        date: sample.return_slip_date || "",
        po: sample.return_slip_po || "",
        status: sample.return_slip_status || "open",
      });
    }
  });

  return Array.from(byId.values())
    .map((s) => {
      const its = slipItems.get(s.id) || [];
      const sample = its[0];
      return {
        ...s,
        items: its,
        po: sample ? sample.return_slip_po || "" : s.po || "",
        status: (sample ? sample.return_slip_status : s.status) || "open",
      };
    })
    .sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
}

// Split a "CODE NUMBER" string (how both invoice-review modals edit a part) back
// into the separate partLineCode / partNumber the rest of the pipeline needs.
//
// This split MATTERS and must not be collapsed: capRules.resolveCapCode()
// branches on the LINE CODE to build the Sage code (World + "NGK" + an oxygen
// sensor -> "NTK 21514"; World + "TRK" -> the dash is stripped). With an empty
// line code every one of those rules misses and it falls through to the default
// `linecode + " " + partnumber` template — the wrong code, and formerly a
// leading space too.
//
// Splits on the LAST space, not the first: measured over all 1978 stored line
// items, a real partNumber NEVER contains a space, while line codes are 3 chars
// (1953), occasionally 2 ("BS"), and core-charge lines carry a two-word code
// ("CORE PKT 20-66989"). Last-space therefore handles core lines with no special
// case. A string with no space at all (or an implausible left side) is left
// whole rather than guessed at.
function splitPartCode(part) {
  const raw = String(part || "").trim().replace(/\s+/g, " ");
  const at = raw.lastIndexOf(" ");
  if (at <= 0) return { partLineCode: "", partNumber: raw };
  const code = raw.slice(0, at);
  const number = raw.slice(at + 1);
  if (!/^[A-Za-z][A-Za-z ]{0,11}$/.test(code)) return { partLineCode: "", partNumber: raw };
  return { partLineCode: code.toUpperCase(), partNumber: number };
}

// World documents from any source must
// carry the same warehouse string the World scrape stores. It drives two things:
// capRules.resolveCapCode (via the "World" alias) and the item's `warehouse`,
// which Returns Management groups and locks requisition slips by — with the
// a different account name here instead, that stock could never share a slip with
// scraped World stock. NOTE: this must keep matching what worldScraper reads off
// the site; capRules.json's warehouseAliases.World lists the same strings.
const WORLD_WAREHOUSE = "World Automotive Warehouse";

// Vendor order fetches used to print the scraper's whole statusLog: login
// steps, page counts, per-order detail chatter, product aggregation. None of it
// is read after the run — the only number that matters is how many orders came
// back, so the status line is just that count under the warehouse they land in.
// The full log still goes to the devtools console (logScanDetail) so a bad run
// — a login step that stalled, a detail page that failed — is still traceable.
const FETCH_WAREHOUSES = {
  world: WORLD_WAREHOUSE,
  cbk: "CBK",
  tiger: "Tiger",
  bestbuy: "BestBuy",
  transbec: "Transbec",
  proforce: "Proforce",
};

function logScanDetail(tag, res) {
  if (Array.isArray(res?.statusLog) && res.statusLog.length) {
    console.info(`[scan:${tag}]\n${res.statusLog.join("\n")}`);
  }
}

function fetchStatusLine(vendor, res) {
  logScanDetail(vendor, res);
  const warehouse = FETCH_WAREHOUSES[vendor] || vendor;
  const raw = Number(res?.detailFetched ?? res?.added);
  const scraped = Number.isFinite(raw) ? raw : 0;
  return `${warehouse} — ${scraped} order${scraped === 1 ? "" : "s"} scraped.`;
}

// Gmail invoice/credit scans get the same treatment: their statusLog narrates
// the search, every skipped email and every parsed PDF, but the only thing
// worth reading afterwards is how many documents came back.
function gmailStatusLine(vendor, res, noun = "invoice") {
  logScanDetail(`${vendor}-gmail`, res);
  const warehouse = FETCH_WAREHOUSES[vendor] || vendor;
  const n = Array.isArray(res?.discoveries) ? res.discoveries.length : 0;
  return `${warehouse} — ${n} ${noun}${n === 1 ? "" : "s"} found.`;
}

const DELETE_DESTINATIONS = ["NEW STOCK", "SHELF", "CASH SALES", "RETURNS"];

const ACCOUNTING_PATHS = {
  OUTSTANDING: "OUTSTANDING",
  SAGE_AR: "SAGE_AR",
  CASH_SALE: "CASH_SALE",
  ARCHIVED: "ARCHIVED",
};



// Tabs are grouped by workflow, and the groups render as clusters separated by
// a divider so related views stay visually adjacent instead of reflowing into
// one another. Order within each group is deliberate; the trailing group is the
// catch-all for everything that isn't part of a specific flow.
const VIEW_GROUPS = [
  [
    { id: "order-management", label: "Order Management" },
    { id: "order-assignment", label: "Order Assignment" },
    { id: "sales-orders", label: "Sales Orders" },
  ],
  [
    { id: "cash-sale-flow", label: "Cash Sales" },
    { id: "payment-management", label: "Payments" },
    { id: "sage-runs", label: "Sage Runs" },
  ],
  [
    { id: "credits", label: "Credits" },
    { id: "returns-management", label: "Returns Management" },
  ],
  [
    { id: "dashboard", label: "Dashboard" },
    { id: "archive-search", label: "Archive" },
    { id: "settings", label: "Settings" },
    { id: "rules", label: "Rules" },
  ],
];

const VIEWS = VIEW_GROUPS.flat();

function ViewTabs({ currentView, onSelect, badges }) {
  return (
    <div className="w-full">
      <div className="flex flex-wrap gap-x-3 gap-y-2 justify-start items-stretch">
        {VIEW_GROUPS.map((group, groupIndex) => (
          <React.Fragment key={groupIndex}>
            {groupIndex > 0 && (
              <div className="self-center h-7 w-px bg-slate-300/70" aria-hidden="true" />
            )}
            <div className="flex flex-wrap gap-2 justify-start items-stretch">
              {group.map((view) => {
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
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}

export default function App() {
  const [bubbles, setBubbles] = useState(DEFAULT_BUBBLES);
  const [items, setItems] = useState([]);
  // Leftovers from the removed drag-and-drop bubble workspace. Nothing reads
  // them for layout any more, but the create/delete/rename paths still keep
  // them tidy and they're still round-tripped through ui_state.json, so a
  // machine that hasn't updated yet doesn't lose its saved workspace.
  const [uiStateReady, setUiStateReady] = useState(false);
  const [currentView, setCurrentView] = useState("order-management");
  const [returnsFilterEnabled, setReturnsFilterEnabled] = useState(false);
  const [returnsFilterDays, setReturnsFilterDays] = useState(0);
  const [timeFilterEnabled, setTimeFilterEnabled] = useState(false);
  const [timeFilterMinutes, setTimeFilterMinutes] = useState(0);
  const [timeFilterHours, setTimeFilterHours] = useState(0);
  const [timeFilterDays, setTimeFilterDays] = useState(0);
  const [orders, setOrders] = useState([]);
  // Always-current mirror of `orders`, kept because the vendor invoice fetches
  // are long-running async handlers: by the time one comes back, the `orders`
  // captured in its closure can be stale (the file watcher may have pushed a
  // refresh mid-fetch), and reading state inside a setOrders updater is no help
  // either — React may run that updater later, during render, which is exactly
  // how the auto-save after a fetch used to be skipped. Building the patched
  // list from this ref makes the save deterministic.
  const ordersRef = useRef([]);
  useEffect(() => {
    ordersRef.current = orders;
  }, [orders]);
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [ordersError, setOrdersError] = useState(null);
  const [ordersInitialized, setOrdersInitialized] = useState(false);
  const [ordersSourcePath, setOrdersSourcePath] = useState("");
  const [ordersDirty, setOrdersDirty] = useState(false);
  const [ordersSaving, setOrdersSaving] = useState(false);
  const [ordersSearch, setOrdersSearch] = useState("");
  const [ordersPickupFilter, setOrdersPickupFilter] = useState("all");
  const [ordersTodayOnly, setOrdersTodayOnly] = useState(false);
  // Map<orderPinKey, {pickedUp, inStore}> | null. Non-null once a Picked Up /
  // Arrived checkbox has been clicked: it holds every card's pickup standing as
  // it was at that moment so the list stops re-sorting under the user. Cleared
  // on an explicit Refresh or pickup-filter change (see pinPickupPositions).
  const [pinnedPickup, setPinnedPickup] = useState(null);
  const [ordersArchiveRunning, setOrdersArchiveRunning] = useState(false);
  const [ordersArchiveStatus, setOrdersArchiveStatus] = useState("");
  const [ordersArchiveError, setOrdersArchiveError] = useState("");
  const [archiveCleanupDays, setArchiveCleanupDays] = useState(2);
  // Order Management's "recently archived" log — most recent first, refreshed
  // whenever an archive action here completes (single, bulk, or Needs Archive).
  const [recentArchivedOrders, setRecentArchivedOrders] = useState([]);
  async function loadRecentArchivedOrders() {
    try {
      const res = await api?.getRecentArchivedOrders?.(10);
      if (res?.ok) setRecentArchivedOrders(Array.isArray(res.orders) ? res.orders : []);
    } catch (e) {
      console.error("[orders-archive] failed to load recent archive log", e);
    }
  }
  // Purchase-order processing is coordinated across machines via a shared lock
  // (only one machine at a time). Invoice processing runs locally and is unlocked.
  const [sagePoEnabled, setSagePoEnabled] = useState(false);
  const [sageInvoiceEnabled, setSageInvoiceEnabled] = useState(false);
  const [sageLockInfo, setSageLockInfo] = useState(null); // { lock, ownMachineId }
  const [sageReadyOrders, setSageReadyOrders] = useState([]);
  // True only while the "Send N to Sage" click is in flight. The AHK run itself
  // outlives it — progress after that shows on the cards, which blur one by one
  // as the queue works through them.
  const [sageQueueSending, setSageQueueSending] = useState(false);
  const [sageInvoiceReadyOrders, setSageInvoiceReadyOrders] = useState([]);
  const [payments, setPayments] = useState([]);
  const [paymentsLoading, setPaymentsLoading] = useState(false);
  const [paymentsError, setPaymentsError] = useState("");
  const [cashPadMarkup, setCashPadMarkup] = useState("30");
  // Whether Send to Sage types the obfuscated grand-total line into the notes
  // block. Defaults on — that's what it did before the toggle existed.
  const [sageGrandTotalLine, setSageGrandTotalLine] = useState(true);
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
  // "Get All" fires every vendor fetch above at once. Tracked separately from
  // the per-vendor `*Running` flags so the button can show its own "Fetching
  // All..." state even though it's really just awaiting all six of them.
  const [getAllOrdersRunning, setGetAllOrdersRunning] = useState(false);
  const [getAllOrdersError, setGetAllOrdersError] = useState("");
  const [worldFetching, setWorldFetching] = useState(false);
  const [worldStatus, setWorldStatus] = useState("");
  const [worldError, setWorldError] = useState("");
  // World invoices that arrived with no order behind them (worldStandaloneInvoice.js).
  const [worldPoFetching, setWorldPoFetching] = useState(false);
  const [worldPoStatus, setWorldPoStatus] = useState("");
  const [worldPoError, setWorldPoError] = useState("");
  // Pre-Sage quantity-vs-billed-total check (see utils/qtyDiscrepancy.js).
  // Defaults mirror main.js's normalizeAppConfig fallback so the UI matches
  // what's actually on disk before the config load below completes.
  const [qtyDiscrepancyThreshold, setQtyDiscrepancyThreshold] = useState(15);
  const [qtyDiscrepancyTaxRate, setQtyDiscrepancyTaxRate] = useState(0.13);
  // Ghost mode (see utils/ghostMode.js and runGhostCycle below): this machine
  // clicks its own way through Order Management every half hour. Per-machine
  // setting, off until switched on in Settings.
  const [ghostMode, setGhostMode] = useState(false);
  const [ghostBusy, setGhostBusy] = useState(""); // the step running right now
  const [ghostLog, setGhostLog] = useState(""); // what the last cycle did
  const [ghostRunning, setGhostRunning] = useState(false);
  // The ref is what the cycle itself tests (state is a render behind); the
  // state above is only for disabling the "Run one now" button.
  const ghostRunningRef = useRef(false);
  // Seeded with the half-hour the app STARTED in, so launching at 10:05 waits
  // for 10:30 rather than firing a full cycle on startup — and so restarting
  // repeatedly can never re-run the same slot.
  const ghostSlotRef = useRef(ghostSlotKey());
  const ghostCycleRef = useRef(null);
  // The day the once-daily BestBuy invoice check last ran on, and the day+slot
  // of the last twice-daily Tiger order pull.
  const ghostBestbuyDayRef = useRef("");
  const ghostWorldPoRunRef = useRef("");
  const ghostCreditsRunRef = useRef("");
  const ghostTigerRunRef = useRef("");
  // Cross-machine automation: the roster and who has which role. Kept in state
  // for the admin screen; every dispatch re-reads them fresh, because a machine
  // can go offline between one cycle and the next.
  const [automationMachines, setAutomationMachines] = useState([]);
  const [automationRoles, setAutomationRoles] = useState({ fetch: "", print: "", sage: "" });
  const [ownMachineId, setOwnMachineId] = useState("");
  // Non-empty while this machine is running a job for another machine.
  const [automationJobBusy, setAutomationJobBusy] = useState("");
  const automationJobBusyRef = useRef(false);
  const automationExecRef = useRef(null);
  // Whether this machine's PO toggle was switched on by the `sage` role rather
  // than by a person, so giving the role away can switch it back off without
  // ever countermanding somebody's own click.
  const sageRoleAutoEnabledRef = useRef(false);
  // The sage assignment this machine has already acted on, and a render-current
  // mirror of the PO toggle — see the role-follower effect for why it reads the
  // toggle through a ref instead of depending on it.
  const sageRoleAppliedRef = useRef("");
  const sagePoEnabledRef = useRef(false);
  const [qtyConfirmModal, setQtyConfirmModal] = useState(null); // { order, refKey }
  const [invoiceReviewOrder, setInvoiceReviewOrder] = useState(null);
  const [invoiceReviewImageDataUrl, setInvoiceReviewImageDataUrl] = useState("");
  const [invoiceReviewInvoiceDraft, setInvoiceReviewInvoiceDraft] = useState("");
  const [invoiceReviewTotalDraft, setInvoiceReviewTotalDraft] = useState("");
  // Editable line items shown in the Verify Invoice modal for scan-generated orders.
  const [invoiceReviewLinesDraft, setInvoiceReviewLinesDraft] = useState([]);
  const [invoiceReviewLoading, setInvoiceReviewLoading] = useState(false);
  const [invoiceReviewSaving, setInvoiceReviewSaving] = useState(false);
  const [invoiceReviewError, setInvoiceReviewError] = useState("");
  // Credits view: Transbec credit memos from Gmail — unlike the World invoice
  // above, there's no vendor site to scan; it's a Gmail search (periodic
  // "Check for Transbec Credits" button) whose hits have no pre-existing
  // order, so each one gets its own "Create order" action.
  const [transbecCreditScanning, setTransbecCreditScanning] = useState(false);
  const [transbecCreditError, setTransbecCreditError] = useState("");
  const [transbecCreditLog, setTransbecCreditLog] = useState([]);
  const [transbecCredits, setTransbecCredits] = useState([]);
  const [transbecCreditMatch, setTransbecCreditMatch] = useState(null); // the order being matched
  const [transbecCreditMatchSlipId, setTransbecCreditMatchSlipId] = useState("");
  const [transbecCreditMatchSaving, setTransbecCreditMatchSaving] = useState(false);
  const [transbecCreditMatchError, setTransbecCreditMatchError] = useState("");
  const [worldCreditScanning, setWorldCreditScanning] = useState(false);
  const [worldCreditError, setWorldCreditError] = useState("");
  const [worldCreditLog, setWorldCreditLog] = useState([]);
  const [worldCredits, setWorldCredits] = useState([]);
  const [worldCreditMatch, setWorldCreditMatch] = useState(null); // the order being matched
  const [worldCreditMatchSlipId, setWorldCreditMatchSlipId] = useState("");
  const [worldCreditMatchSaving, setWorldCreditMatchSaving] = useState(false);
  const [worldCreditMatchError, setWorldCreditMatchError] = useState("");
  const [transbecFetching, setTransbecFetching] = useState(false);
  const [transbecStatus, setTransbecStatus] = useState("");
  const [transbecError, setTransbecError] = useState("");
  const [bestbuyFetching, setBestbuyFetching] = useState(false);
  const [bestbuyStatus, setBestbuyStatus] = useState("");
  const [bestbuyError, setBestbuyError] = useState("");
  const [cbkFetching, setCbkFetching] = useState(false);
  const [cbkStatus, setCbkStatus] = useState("");
  const [cbkError, setCbkError] = useState("");
  const [proforceCreditFetching, setProforceCreditFetching] = useState(false);
  const [proforceCreditStatus, setProforceCreditStatus] = useState("");
  const [proforceCreditError, setProforceCreditError] = useState("");
  // Proforce credit orders already exist (unlike scanned "discoveries")
  // with real lineItems from the portal scrape, so matching them to a return
  // requisition needs none of a scan modal's image/line-correction
  // steps — just pick a waiting slip and stamp the order with it.
  const [proforceCreditMatch, setProforceCreditMatch] = useState(null); // the order being matched
  const [proforceCreditMatchSlipId, setProforceCreditMatchSlipId] = useState("");
  const [proforceCreditMatchSaving, setProforceCreditMatchSaving] = useState(false);
  const [proforceCreditMatchError, setProforceCreditMatchError] = useState("");
  // Resolved CAP codes for the credit currently being matched, parallel to its
  // lineItems. Only one match modal can be open at a time, so both share this.
  // Empty until rules:resolve-lines answers (and for any line the rules can't
  // resolve) — creditLinePartKeys falls back to the raw pair for those.
  const [creditMatchCapCodes, setCreditMatchCapCodes] = useState([]);
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
  const [itemHistory, setItemHistory] = useState([]);
  // Return requisition slips. The item↔slip link lives on items (synced); this
  // list carries slip metadata (warehouse + date), notably for slips that are
  // still empty. Persisted in per-machine UI state.
  const [returnSlips, setReturnSlips] = useState([]);
  const ordersLastSavedRef = useRef("");

  const [printBubbleId, setPrintBubbleId] = useState(null);
  const [printGeneratedAt, setPrintGeneratedAt] = useState(null);
  // "salesOrder" or "quote". The same preview modal draws both — a quote is the
  // same sheet with the tax folded into the line prices — but the two confirm
  // paths are deliberately different: a quote draws no Sales Order number,
  // marks nothing sold, and doesn't touch the printed-signature badge.
  const [printMode, setPrintMode] = useState("salesOrder");

  const pendingItemsRefreshRef = useRef(false);
  const printPreviewRef = useRef(null);
  const workspaceRef = useRef(null);
  // Load the qty-discrepancy threshold/tax rate once so Order Management can
  // decide whether to show "Confirm Quantities" without SettingsView being
  // open. SettingsView owns editing these; this just needs the read.
  useEffect(() => {
    api.getAppConfig?.()
      .then((res) => {
        if (!res?.ok) return;
        const cfg = res.config || {};
        const thresholdNum = Number(cfg.qtyDiscrepancyThreshold);
        if (Number.isFinite(thresholdNum)) setQtyDiscrepancyThreshold(thresholdNum);
        const taxRateNum = Number(cfg.qtyDiscrepancyTaxRate);
        if (Number.isFinite(taxRateNum)) setQtyDiscrepancyTaxRate(taxRateNum);
        setGhostMode(cfg.ghostMode === true);
      })
      .catch(() => {});
  }, []);



  // Drag state (items only)

  // Save / watch bookkeeping.
  // Initialize to the serialized initial state ("[]") so the save effect can
  // never see "unsaved changes" before the first successful load — that window
  // used to allow an empty state to overwrite the real item files.
  const lastSavedRef = useRef("[]");
  const itemsLoadedRef = useRef(false);
  // Always-current mirror of `items`. The items:updated listener is registered
  // once, on mount, so it cannot read `items` out of its own closure.
  const itemsRef = useRef(items);
  itemsRef.current = items;
  // True from the moment a save is handed to the main process until it answers.
  const saveInFlightRef = useRef(false);
  // Bumped to re-run the save effect after a failed write. Without it a failure
  // would wait for the user's next edit to retry — and because incoming pushes
  // are now DEFERRED while this side holds unsent changes (rather than being
  // merged over them), a machine left alone after a hiccup would stop seeing
  // other machines entirely. Deferring is only safe if the flush is guaranteed.
  const [saveRetryTick, setSaveRetryTick] = useState(0);
  // Uids the user explicitly deleted but whose deletion hasn't been confirmed
  // saved yet. Saves are upserts — an item absent from our state is NOT deleted
  // on disk unless its uid is sent in this list.
  //
  // It used to double as a filter over incoming pushes, alongside a second
  // permanent `archivedUidsRef` set, because a watcher event that had read the
  // file BEFORE the delete landed would put the parts back for a tick and
  // ensureBubblesForItems would rebuild the bubble around them — the empty
  // ghost card. Neither filter is needed now. A pending deletion makes
  // hasUnsentItemChanges true, so the push is deferred rather than applied, and
  // once the write lands the store holds a tombstone stamped later than the
  // item, so no later push can resurrect it.
  const deletedUidsRef = useRef(new Set());

  function markItemsDeleted(uids) {
    (uids || []).forEach((u) => { if (u) deletedUidsRef.current.add(u); });
  }
  function confirmItemsDeleted(uids) {
    (uids || []).forEach((u) => deletedUidsRef.current.delete(u));
  }

  // "User is editing any field" flag
  const isEditingAnythingRef = useRef(false);
  

  // Is this renderer holding item changes the main process hasn't been told
  // about? Either not sent yet, or sent and still in flight.
  function hasUnsentItemChanges() {
    if (saveInFlightRef.current) return true;
    if (deletedUidsRef.current.size > 0) return true;
    return JSON.stringify(itemsRef.current) !== lastSavedRef.current;
  }

  // Adopt a push from the main process as the truth, wholesale.
  //
  // There is no client-side merge any more, and there must not be one. The push
  // IS the merged state: the store resolved it field-by-field against every
  // machine's op log before sending it (main/crdt/merge.js), so anything this
  // side did to "defend" its own values could only undo that work. mergeItems
  // kept whichever copy carried the higher `rev`, which meant discarding the
  // ENTIRE incoming item — including fields another machine had legitimately
  // changed and this one had never touched. It then set lastSavedRef to that
  // half-local result, which told the save effect those local edits were
  // already on disk and quietly cancelled the write that would have published
  // them. That is how a sell price could be typed, accepted on screen, and
  // never reach the share.
  //
  // The one thing this side knows that the store does not is whether it is
  // holding changes it hasn't sent. Those are never merged in here — the push
  // is deferred until the save has gone out, and then the state is re-read.
  // Flush, then adopt; never both at once.
  function adoptPushedItems(arr) {
    const norm = normalizeItems(arr || []);
    const incoming = JSON.stringify(norm);
    // Our own commit echoing back is the common case — the store pushes after
    // every local write. Nothing moved, so don't touch state at all.
    if (incoming === lastSavedRef.current) return;
    dbg('items:ADOPT', { incomingCount: norm.length });
    setItems((prev) => {
      // Reuse the previous object for any item that came back byte-identical.
      // This is NOT a merge — the value always comes from the push, and an item
      // that differs is taken wholesale. It only keeps object identity stable
      // so the memoized order cards don't all re-render on a push that changed
      // one part. Pushes are frequent now; without this every save would
      // re-render every card in the view.
      const before = new Map(prev.map((it) => [it.uid, it]));
      return norm.map((it) => {
        const old = before.get(it.uid);
        return old && JSON.stringify(old) === JSON.stringify(it) ? old : it;
      });
    });
    lastSavedRef.current = incoming;
    ensureBubblesForItems(norm, setBubbles);
  }

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

    const off = api.onItemsUpdated((arr) => {
      itemsLoadedRef.current = true; // main only pushes successfully-read data
      // Defer rather than merge — see adoptPushedItems. The deferred push is
      // collected by refreshItemsIfPending once the save has landed.
      if (isEditingAnythingRef.current || hasUnsentItemChanges()) {
        pendingItemsRefreshRef.current = true;
        dbg('items:PUSH-DEFERRED', {
          editing: isEditingAnythingRef.current,
          saveInFlight: saveInFlightRef.current,
        });
        return;
      }
      adoptPushedItems(arr);
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


  // === Write-through save ===
  //
  // Every item mutation in this file goes through state and is persisted here,
  // so this effect is the single place that decides how long a change lives
  // only in memory. That used to be ten seconds of item-inactivity, with the
  // timer restarting on every change — which is why "Send to Sage" and the
  // CashPad fill each grew their own hand-rolled flush, and why editing a sell
  // price could look like the app was refusing the edit.
  //
  // The delay existed to keep whole-file rewrites off the share: back then every
  // save replaced all three queue files, so saving often was expensive and
  // saving a stale array was destructive. Neither is true now. A save is diffed
  // field-by-field against the exact state this renderer was handed and
  // publishes only what actually changed (main/crdt/merge.js) — a save with
  // nothing in it emits zero ops and writes zero bytes, and a save that is
  // minutes stale still can't revert a field it didn't touch.
  //
  // What's left is a coalescing window, not a delay: one user action often fires
  // several setItems calls, and this folds them into one commit.
  useEffect(() => {
    if (!items) return;
    // Never save before the first successful load — the state would be empty
    // and the write would erase the real item files.
    if (!itemsLoadedRef.current) return;
    const id = setTimeout(() => {
      const current = JSON.stringify(items);
      const pendingDeletes = Array.from(deletedUidsRef.current);
      if (current === lastSavedRef.current && pendingDeletes.length === 0) return;
      lastSavedRef.current = current;
      dbg('save:WRITE', { itemCount: items.length, pendingDeletes });
      saveInFlightRef.current = true;
      let failed = false;
      api.writeItems(items, pendingDeletes).then((res) => {
        if (res && res.ok === false) {
          dbg('save:REJECTED', res.error);
          console.error("[save] write rejected by main:", res.error);
          // Allow a retry; keep pending deletions queued
          lastSavedRef.current = "";
          failed = true;
        } else {
          dbg('save:OK', { itemCount: items.length, ops: res?.ops ?? 0 });
          confirmItemsDeleted(pendingDeletes);
        }
      }).catch((e) => {
        dbg('save:FAILED', String(e));
        console.error("[save] write failed", e);
        lastSavedRef.current = "";
        failed = true;
      }).finally(() => {
        saveInFlightRef.current = false;
        if (failed) {
          setTimeout(() => setSaveRetryTick((t) => t + 1), SAVE_RETRY_MS);
          return; // still dirty — a push must keep waiting for a clean flush
        }
        // Any push that arrived while this was in flight was deferred, not
        // merged. Now that our side is clean, go and get it.
        refreshItemsIfPending();
      });
    }, SAVE_COALESCE_MS);

    return () => clearTimeout(id);
  }, [items, saveRetryTick]);

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
    // Sales Order view fields (delivered/paid checkboxes, print tracking) —
    // same pattern as paymentIds above: only sent when this call is actually
    // the one changing them, otherwise carried forward from what's cached
    // locally so an unrelated save (e.g. a notes edit) doesn't blank them out.
    ["createdAt", "delivered", "counter", "paid", "noNewParts", "printedSignature", "printedAt", "salesOrderNumber", "quoteDiscount", "quoteDiscountApplied", "quoteDiscountPriorPrices", "sageInvoiceNumber", "sageSentAt", "sageRunId"].forEach((key) => {
      const has = Object.prototype.hasOwnProperty.call(overrides, key);
      const val = has ? overrides[key] : meta[key];
      if (val !== undefined) payload[key] = val;
    });
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
    // Sales Order view fields (delivered/paid + print tracking), keyed the
    // same way paymentAssignments is — by bubble id.
    const salesOrderMeta = {};
    const createdIds = [];
    const sharedLowerNames = new Set(entries.map((e) => norm(e.name || e.id)));
    // itemsRef, NOT the `items` in scope. This function is reached from the
    // onBubbleSharedUpdated subscription, which is registered once on mount —
    // so the handler holds the FIRST render's copy of this function, closing
    // over the first render's `items`: the empty array useState was seeded
    // with. Read that way, `itemsLowerNames` is permanently empty and the
    // "this bubble still has parts in it" test below can never pass.
    //
    // That is what resurrected a closed order. The moment the other machine's
    // delete arrived, this side dropped the bubble from local state even though
    // its own parts were still pointing at that name (the parts push is a
    // separate channel and lands a beat later). The ensure-bubbles effect then
    // saw a part naming a bubble that no longer existed, re-minted it, and
    // PUBLISHED it back to the share — as a bare {name, notes:""} shell, with
    // no createdAt and no flags. By the time the parts push landed and moved
    // them out, the empty shell was already on the share and every machine kept
    // it, because a name present in the shared set is kept by definition.
    const itemsLowerNames = new Set((itemsRef.current || []).map((it) => norm(it.allocated_to)));
    let keptIds = new Set();
    dbg('applyShared:IN', {
      incomingEntryCount: entries.length,
      incomingNames: entries.map((e) => ({ id: e.id, name: e.name, deleted: !!e.deleted })),
      sharedLowerNames: Array.from(sharedLowerNames),
      itemsLowerNames: Array.from(itemsLowerNames),
    });

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
        if (deleteIds.has(b.id) || deleteNames.has(lower)) {
          dbg('applyShared:DROP(explicit-delete)', { id: b.id, name: b.name });
          return;
        }
        const keep =
          DEFAULT_BUBBLE_NAMES.has(b.name) || itemsLowerNames.has(lower) || sharedLowerNames.has(lower);
        if (!keep) {
          dbg('applyShared:DROP(not-kept)', {
            id: b.id,
            name: b.name,
            isDefault: DEFAULT_BUBBLE_NAMES.has(b.name),
            hasItems: itemsLowerNames.has(lower),
            inShared: sharedLowerNames.has(lower),
          });
          return;
        }
        indexById.set(b.id, next.length);
        if (lower) indexByLower.set(lower, next.length);
        next.push(b);
      });

      entries.forEach((entry) => {
        if (!entry || entry.deleted) return;
        const name = (entry.name || entry.id || entry.bubbleId || "")
          .toString()
          .trim()
          .toUpperCase();
        if (!name) return;
        // Re-derived rather than taken from the entry, so a record published by
        // a machine still on a build that mints uuids lands under the same key
        // as everything else here instead of splitting this order in two on
        // screen. The store-side collapse folds the record itself at startup.
        const id = bubbleIdForName(name);
        const lower = norm(name);
        const existingIdx =
          (id && indexById.has(id) && indexById.get(id) !== undefined
            ? indexById.get(id)
            : undefined) ?? (indexByLower.has(lower) ? indexByLower.get(lower) : undefined);
        extras[id] = Array.isArray(entry.extraLines) ? entry.extraLines : [];
        if (Array.isArray(entry.paymentIds)) {
          paymentAssignments[id] = entry.paymentIds.filter(Boolean);
          if (entry.name) paymentAssignments[entry.name] = entry.paymentIds.filter(Boolean);
        }
        {
          const som = {};
          if (typeof entry.createdAt === "string") som.createdAt = entry.createdAt;
          if (typeof entry.delivered === "boolean") som.delivered = entry.delivered;
          if (typeof entry.counter === "boolean") som.counter = entry.counter;
          if (typeof entry.paid === "boolean") som.paid = entry.paid;
          if (typeof entry.noNewParts === "boolean") som.noNewParts = entry.noNewParts;
          if (typeof entry.printedSignature === "string") som.printedSignature = entry.printedSignature;
          if (typeof entry.printedAt === "string") som.printedAt = entry.printedAt;
          if (typeof entry.salesOrderNumber === "string") som.salesOrderNumber = entry.salesOrderNumber;
          if (typeof entry.quoteDiscount === "number") som.quoteDiscount = entry.quoteDiscount;
          if (typeof entry.quoteDiscountApplied === "boolean")
            som.quoteDiscountApplied = entry.quoteDiscountApplied;
          if (Array.isArray(entry.quoteDiscountPriorPrices))
            som.quoteDiscountPriorPrices = entry.quoteDiscountPriorPrices;
          if (typeof entry.sageInvoiceNumber === "string") som.sageInvoiceNumber = entry.sageInvoiceNumber;
          if (typeof entry.sageSentAt === "string") som.sageSentAt = entry.sageSentAt;
          if (typeof entry.sageRunId === "string") som.sageRunId = entry.sageRunId;
          if (Object.keys(som).length) salesOrderMeta[id] = som;
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
      dbg('applyShared:setBubbles', {
        before: prev.length,
        after: deduped.length,
        keptNames: deduped.map((b) => b.name),
      });

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

    if (
      createdIds.length ||
      deleteIds.size ||
      keptIds.size ||
      Object.keys(paymentAssignments).length ||
      Object.keys(salesOrderMeta).length
    ) {
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
        Object.keys(salesOrderMeta).forEach((id) => {
          if (!next[id]) next[id] = {};
          next[id] = { ...next[id], ...salesOrderMeta[id] };
        });
        return next;
      });
    }
  }


  async function addBubble(nameInput = "") {
    const baseRaw = (nameInput || "").trim() || "New Bubble";
    const base = baseRaw.toUpperCase();
    const names = new Set(bubbles.map((b) => (b.name || "").toUpperCase()));
    const finalName = uniqueName(base, names);
    // Derived, not minted — see bubbleIdForName. `uniqueName` has already made
    // sure this name isn't taken, so the key it produces is free too.
    const id = bubbleIdForName(finalName);
    const nb = { id, name: finalName, notes: "" };
    // The order's own clock. Sales Orders bands cards by this into
    // Urgent/Regular/Stale, so it's stamped once at creation and never touched
    // again — moving parts around must not make an old order look fresh.
    const createdAt = new Date().toISOString();
    setBubbles((p) => [...p, nb]);
    setBubbleMeta((prev) => ({
      ...prev,
      [id]: {
        ...(prev[id] || {}),
        createdAt,
        accountingPath: visibleAccountingPath || ACCOUNTING_PATHS.OUTSTANDING,
      },
    }));
    if (api?.writeSharedBubbleData) {
      api
        .writeSharedBubbleData({
          bubbleId: id,
          name: finalName,
          notes: "",
          extraLines: [],
          createdAt,
        })
        .catch((e) => console.warn("[shared-bubble] write failed (new bubble)", e));
    }
  }

  function updateBubbleNotes(id, notes) {
    setBubbles((prev) =>
      prev.map((b) => (b.id === id ? { ...b, notes } : b))
    );
  }

  function handleBubbleNotesBlur(id, notesValue) {
    // Prefer the value the field just committed — setBubbles is async, so a
    // bubbles.find() here can still read the pre-edit notes on the same tick.
    const notes =
      notesValue !== undefined
        ? notesValue
        : bubbles.find((b) => b.id === id)?.notes || "";
    persistSharedBubbleSnapshot(id, { notes });
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
  const visibleAccountingPath = useMemo(() => {
    if (currentView === "cash-sale-flow") return ACCOUNTING_PATHS.CASH_SALE;
    return null;
  }, [currentView]);
  // Which bubbles Cash Sales owns.
  //
  // The accounting path is read off a bubble's ITEMS, and parts that arrive via
  // "Send to Cash Pad" were historically never stamped CASH_SALE — so an
  // Auto-fill bubble like "MASTERCARD $250.00" could read as OUTSTANDING. That
  // made it invisible in BOTH views: Cash Sales dropped it on the path, and
  // Sales Orders dropped it for having a payment assigned. An assigned payment
  // is therefore treated as decisive here, exactly as Sales Orders treats it,
  // so the two views stay strict complements with nothing falling between them.
  // (Newly filled bubbles now get the stamp too — see handleFillFromCashPad —
  // this also heals the ones already in that state.)
  const cashSaleBubbleNames = useMemo(() => {
    const names = new Set();
    bubbles.forEach((b) => {
      const meta = bubbleMeta[b.id] || bubbleMeta[b.name] || {};
      if ((meta.paymentIds || []).filter(Boolean).length) {
        names.add(b.name);
        return;
      }
      const path =
        bubbleAccountingPathByName.get(b.name) ||
        meta.accountingPath ||
        ACCOUNTING_PATHS.OUTSTANDING;
      if (path === ACCOUNTING_PATHS.CASH_SALE) names.add(b.name);
    });
    return names;
  }, [bubbles, bubbleMeta, bubbleAccountingPathByName]);

  const bubblesForView = useMemo(() => {
    if (!visibleAccountingPath) return bubbles;
    if (visibleAccountingPath === ACCOUNTING_PATHS.CASH_SALE) {
      return bubbles.filter((b) => cashSaleBubbleNames.has(b.name));
    }
    return bubbles.filter((b) => {
      const path =
        bubbleAccountingPathByName.get(b.name) ||
        bubbleMeta[b.id]?.accountingPath ||
        ACCOUNTING_PATHS.OUTSTANDING;
      return path === visibleAccountingPath;
    });
  }, [bubbles, bubbleAccountingPathByName, bubbleMeta, visibleAccountingPath, cashSaleBubbleNames]);

  const filteredItemsForView = useMemo(() => {
    if (!visibleAccountingPath) return filteredItems;
    return filteredItems.filter((it) => {
      const path = it.accountingPath || ACCOUNTING_PATHS.OUTSTANDING;
      if (path === visibleAccountingPath) return true;
      // Keep the parts sitting in a cash-sale bubble whose own path lags behind,
      // or the card above would render with nothing in it.
      return (
        visibleAccountingPath === ACCOUNTING_PATHS.CASH_SALE &&
        cashSaleBubbleNames.has((it.allocated_to || "").trim())
      );
    });
  }, [filteredItems, visibleAccountingPath, cashSaleBubbleNames]);
  const itemsByBubbleForView = useMemo(
    () => groupItemsByBubble(filteredItemsForView, bubblesForView),
    [filteredItemsForView, bubblesForView]
  );
  // Deliberately off the UNFILTERED list: CashPad is a staging pool that holds
  // parts folded in from Sales Orders, which are still on the OUTSTANDING path.
  // Reading it out of itemsByBubbleForView would come back empty in Cash Sales,
  // where that map is narrowed to CASH_SALE.
  const cashPadItems = useMemo(
    () => filteredItems.filter((it) => (it.allocated_to || "").trim().toUpperCase() === "CASHPAD"),
    [filteredItems]
  );
  const UNSPECIFIED_WAREHOUSE = "Unspecified Warehouse";
  const returnsView = useMemo(() => {
    const unassigned = new Map(); // warehouse -> items[]
    filteredItems.forEach((it) => {
      if ((it.allocated_to || "").toLowerCase() !== "returns") return;
      if (it.return_slip_id) return;
      const warehouse = (it.warehouse || "").trim() || UNSPECIFIED_WAREHOUSE;
      if (!unassigned.has(warehouse)) unassigned.set(warehouse, []);
      unassigned.get(warehouse).push(it);
    });

    const unassignedGroups = Array.from(unassigned.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([warehouse, groupedItems]) => ({ warehouse, items: groupedItems }));

    const slips = deriveReturnSlips(filteredItems, returnSlips, UNSPECIFIED_WAREHOUSE);

    // Warehouses a new slip can be created for: any warehouse that currently has
    // returns (assigned or not), so you can only make a slip where stock exists.
    const warehouseSet = new Set();
    unassignedGroups.forEach((g) => warehouseSet.add(g.warehouse));
    slips.forEach((s) => s.warehouse && warehouseSet.add(s.warehouse));
    const warehouses = Array.from(warehouseSet).sort((a, b) => a.localeCompare(b));

    return { unassignedGroups, slips, warehouses };
  }, [filteredItems, returnSlips]);
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
        if (typeof state.sageGrandTotalLine === "boolean") {
          setSageGrandTotalLine(state.sageGrandTotalLine);
        }
        if (typeof state.ordersTodayOnly === "boolean") {
          setOrdersTodayOnly(state.ordersTodayOnly);
        }
        if (state.bubbleMeta && typeof state.bubbleMeta === "object") {
          setBubbleMeta((prev) => ({ ...(state.bubbleMeta || {}), ...prev }));
        }
        if (Array.isArray(state.returnSlips)) {
          setReturnSlips(state.returnSlips);
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
      dbg('event:onBubbleSharedUpdated', {
        keys: Object.keys(shared),
        isPartial: !!payload?.partial,
      });
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
        // The path that caused the duplicates: every machine runs this the
        // moment it sees a part pointing at a name it has no bubble for, so a
        // minted id gave one order as many records as there were machines.
        return { id: bubbleIdForName(finalName), name: finalName, notes: "" };
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
          sagePoEnabled,
          sageInvoiceEnabled,
          archiveCleanupDays,
          printExtraLinesByBubble,
          ordersTodayOnly,
          sageGrandTotalLine,
          bubbleMeta,
          returnSlips,
        })
      .catch((e) => console.warn("[ui-state] write failed", e));
  }, [
      sagePoEnabled,
      sageInvoiceEnabled,
      archiveCleanupDays,
      printExtraLinesByBubble,
      ordersTodayOnly,
      sageGrandTotalLine,
      bubbleMeta,
      returnSlips,
      uiStateReady,
    ]);

  function persistUIState(nextBubbleMeta) {
    if (!uiStateReady || !api?.writeUIState) return;
      api
        .writeUIState({
          sagePoEnabled,
          sageInvoiceEnabled,
          archiveCleanupDays,
          printExtraLinesByBubble,
          ordersTodayOnly,
          sageGrandTotalLine,
          bubbleMeta: nextBubbleMeta || bubbleMeta,
          returnSlips,
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
  }, [bubbles]);
  const printBubble = useMemo(
    () => bubbles.find((b) => b.id === printBubbleId) || null,
    [printBubbleId, bubbles]
  );
  // Blank until this bubble has actually been printed once — the number is
  // drawn from the shared counter at print time, not at preview time.
  const printSalesOrderNumber = useMemo(() => {
    if (!printBubble) return "";
    const meta = bubbleMeta[printBubble.id] || bubbleMeta[printBubble.name] || {};
    return meta.salesOrderNumber || "";
  }, [printBubble, bubbleMeta]);
  const printItems = useMemo(() => {
    if (!printBubble) return [];
    return filteredItems.filter((it) => it.allocated_to === printBubble.name);
  }, [filteredItems, printBubble]);
  const printExtraLines = useMemo(() => {
    if (!printBubble) return [];
    return printExtraLinesByBubble[printBubble.id] || [];
  }, [printBubble, printExtraLinesByBubble]);
  // The "make it 240 even" concession, in tax-in dollars. Kept on the bubble so
  // a reprint says the same thing, and so the flag below can stop it being
  // pushed into the prices twice.
  const printQuoteMeta = useMemo(() => {
    if (!printBubble) return { discount: 0, applied: false, priorPrices: null };
    const meta = bubbleMeta[printBubble.id] || bubbleMeta[printBubble.name] || {};
    return {
      discount: Number(meta.quoteDiscount) || 0,
      applied: meta.quoteDiscountApplied === true,
      // What each part cost before the discount was pushed into the prices.
      priorPrices: Array.isArray(meta.quoteDiscountPriorPrices)
        ? meta.quoteDiscountPriorPrices
        : null,
    };
  }, [printBubble, bubbleMeta]);
  // The discount belongs on the QUOTE as its own line — full prices above, then
  // Total / Discount / Post-Discount. Only the Sales Order swallows it into the
  // line prices. So once it's been applied, the quote has to go on showing what
  // the parts cost BEFORE the drop, or the column would stop adding up to the
  // Total printed under it. The prices are stashed at apply time for exactly
  // this; parts added since simply show their current price.
  const printQuoteItems = useMemo(() => {
    if (!printQuoteMeta.applied || !printQuoteMeta.priorPrices) return printItems;
    const prior = new Map(printQuoteMeta.priorPrices.map((p) => [p.uid, p.allocated_for]));
    return printItems.map((it) =>
      prior.has(it.uid) ? { ...it, allocated_for: prior.get(it.uid) } : it
    );
  }, [printItems, printQuoteMeta]);
  const bubblePaymentAssignments = useMemo(() => {
    const map = {};
    bubbles.forEach((b) => {
      const meta = bubbleMeta[b.id] || bubbleMeta[b.name] || {};
      map[b.id] = Array.isArray(meta.paymentIds) ? meta.paymentIds : [];
    });
    return map;
  }, [bubbles, bubbleMeta]);

  // The same data inverted — paymentId -> the sale currently holding it — so
  // Payment Management can badge a payment as already spent without needing its
  // own copy of the bubble state. Only covers OPEN sales; archived ones come
  // from api.getArchivedPaymentUsage(), since archiving clears the live link.
  const saleNameByPaymentId = useMemo(() => {
    const map = {};
    bubbles.forEach((b) => {
      const meta = bubbleMeta[b.id] || bubbleMeta[b.name] || {};
      (Array.isArray(meta.paymentIds) ? meta.paymentIds : []).forEach((pid) => {
        if (pid && !map[pid]) map[pid] = b.name;
      });
    });
    return map;
  }, [bubbles, bubbleMeta]);

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
    // Landing in CashPad or CASH SALES puts the part on the cash-sale path —
    // the same rule handleMoveArchiveItemToBubble applies. Any other
    // destination leaves the path alone.
    const fallbackUpper = String(fallback || "").trim().toUpperCase();
    const fallbackPath =
      fallbackUpper === "CASHPAD" || fallbackUpper === "CASH SALES"
        ? ACCOUNTING_PATHS.CASH_SALE
        : null;
    let updatedItemsSnapshot = null;
    setItems((prev) => {
      const nowIso = new Date().toISOString();
      const next = prev.map((it) =>
        it.allocated_to === bubble.name
            ? {
                ...it,
                allocated_to: fallback,
                ...(fallbackPath ? { accountingPath: fallbackPath } : {}),
                last_moved_at: nowIso,
              }
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

    const cleanedPrintExtras = { ...printExtraLinesByBubble };
    delete cleanedPrintExtras[bubbleId];

    setBubbleMeta(cleanedBubbleMeta);
    setPrintExtraLinesByBubble(cleanedPrintExtras);

    persistUIState(cleanedBubbleMeta);
    if (api?.deleteSharedBubbleData) {
      api.deleteSharedBubbleData(bubbleId).catch((e) => console.warn("[shared-bubble] delete failed", e));
      if (bubble?.name) {
        api.deleteSharedBubbleData(bubble.name).catch(() => {});
      }
    }
    markSharedBubbleDeleted(bubble);
  }

  function handleReturnItemToNewStock(uid) {
    setItems((prev) => {
      const next = prev.map((it) =>
        it.uid === uid
          ? {
              ...it,
              allocated_to: "NEW STOCK",
              accountingPath: ACCOUNTING_PATHS.OUTSTANDING,
              // Leaving returns → drop any requisition-slip association.
              return_slip_id: "",
              return_slip_date: "",
              last_moved_at: new Date().toISOString(),
            }
          : it
      );
      ensureBubblesForItems(next, setBubbles);
      return next;
    });
  }

  // Create an empty return requisition slip for a warehouse. Tracked in UI
  // state until parts are assigned (at which point items carry the link).
  function handleCreateReturnSlip(warehouse) {
    const wh = (warehouse || "").trim();
    if (!wh) return;
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const slip = { id: makeUid(), warehouse: wh, date: today, po: "", status: "open" };
    setReturnSlips((prev) => [...prev, slip]);
  }

  // Set a slip's (editable) requisition date. Stored on its items (synced) and
  // mirrored on local metadata, same as PO/status.
  function handleSetSlipDate(slipId, date) {
    if (!slipId) return;
    const value = String(date ?? "");
    setReturnSlips((prev) =>
      prev.some((s) => s.id === slipId)
        ? prev.map((s) => (s.id === slipId ? { ...s, date: value } : s))
        : prev
    );
    setItems((prev) =>
      prev.map((it) =>
        it.return_slip_id === slipId
          ? { ...it, return_slip_date: value }
          : it
      )
    );
  }

  // Assign a returns item to a slip. Guarded to the slip's own warehouse — a
  // part can only join a slip from the same warehouse it belongs to.
  function handleAssignItemToSlip(uid, slip) {
    if (!uid || !slip?.id) return;
    const item = items.find((it) => it.uid === uid);
    if (!item) return;
    const itemWh = (item.warehouse || "").trim() || UNSPECIFIED_WAREHOUSE;
    const slipWh = (slip.warehouse || "").trim() || UNSPECIFIED_WAREHOUSE;
    if (itemWh !== slipWh) {
      alert(`This part is from "${itemWh}" and can only go on a "${itemWh}" return slip.`);
      return;
    }
    updateItemByKey(uid, {
      return_slip_id: slip.id,
      return_slip_date: slip.date || "",
      return_slip_po: slip.po || "",
      return_slip_status: slip.status || "open",
    });
  }

  // Set a slip's status: "waiting" (set aside, awaiting return) or "open".
  // Stored on the slip's items (synced) and mirrored on local metadata.
  function handleSetSlipStatus(slipId, status) {
    if (!slipId) return;
    const value = status === "waiting" ? "waiting" : "open";
    setReturnSlips((prev) =>
      prev.some((s) => s.id === slipId)
        ? prev.map((s) => (s.id === slipId ? { ...s, status: value } : s))
        : prev
    );
    setItems((prev) =>
      prev.map((it) =>
        it.return_slip_id === slipId
          ? { ...it, return_slip_status: value }
          : it
      )
    );
  }

  // Set/clear a slip's PO number. Stored on the slip's items (synced) and, when
  // the slip is tracked locally (e.g. still empty), on its UI-state metadata.
  function handleSetSlipPO(slipId, po) {
    if (!slipId) return;
    const value = String(po ?? "");
    setReturnSlips((prev) =>
      prev.some((s) => s.id === slipId)
        ? prev.map((s) => (s.id === slipId ? { ...s, po: value } : s))
        : prev
    );
    setItems((prev) =>
      prev.map((it) =>
        it.return_slip_id === slipId
          ? { ...it, return_slip_po: value }
          : it
      )
    );
  }

  // Pull a part out of its slip and back to Unassigned Returns (stays in
  // RETURNS — not New Stock, not CashPad). Just clears the slip association.
  function handleRemoveItemFromSlip(uid) {
    if (!uid) return;
    updateItemByKey(uid, {
      return_slip_id: "",
      return_slip_date: "",
      return_slip_po: "",
      return_slip_status: "",
    });
  }

  // Credit came back for a waiting slip: remove its parts from active stock and
  // record it in the lifecycle history (traced as "credit_received"), then drop
  // the slip metadata.
  // Close out a return requisition because its credit came back: drop its parts
  // from active stock (traced as "credit_received" in the lifecycle log) and
  // forget the slip. No confirmation of its own — callers decide whether to ask.
  // Awaitable so a caller can report a failed write instead of assuming success.
  async function settleSlipAsCreditReceived(slipId) {
    if (!slipId) return { ok: true, removedCount: 0 };
    const slipItems = items.filter(
      (it) =>
        it.return_slip_id === slipId &&
        (it.allocated_to || "").toLowerCase() === "returns"
    );
    const removedUids = slipItems.map((it) => it.uid);
    const removedSet = new Set(removedUids);
    const remainingItems = items.filter((it) => !removedSet.has(it.uid));
    markItemsDeleted(removedUids);
    setItems(remainingItems);
    lastSavedRef.current = JSON.stringify(remainingItems);
    setReturnSlips((prev) => prev.filter((s) => s.id !== slipId));
    try {
      const res = await api.writeItems(remainingItems, removedUids, {
        deleteReason: "credit_received",
      });
      if (res?.ok === false) {
        lastSavedRef.current = "";
        console.error("[credit-received] write rejected", res.error);
        return { ok: false, error: res.error || "Failed to save.", removedCount: removedUids.length };
      }
      confirmItemsDeleted(removedUids);
      return { ok: true, removedCount: removedUids.length };
    } catch (e) {
      lastSavedRef.current = "";
      console.error("[credit-received] writeItems failed", e);
      return { ok: false, error: e?.message || "Failed to save.", removedCount: removedUids.length };
    }
  }

  // The Returns Management "Credit received" button — confirms, then settles.
  function handleCreditReceived(slipId) {
    if (!slipId) return;
    const count = items.filter(
      (it) =>
        it.return_slip_id === slipId &&
        (it.allocated_to || "").toLowerCase() === "returns"
    ).length;
    const confirmed =
      typeof window === "undefined"
        ? true
        : window.confirm(
            `Credit received for this slip? ${count} item(s) will be removed from Returns and recorded in history.`
          );
    if (!confirmed) return;
    settleSlipAsCreditReceived(slipId);
  }

  // Remove a slip. Only allowed while empty (one-way: assigned parts stay put).
  function handleDeleteReturnSlip(slipId) {
    if (!slipId) return;
    const hasItems = items.some(
      (it) =>
        it.return_slip_id === slipId &&
        (it.allocated_to || "").toLowerCase() === "returns"
    );
    if (hasItems) {
      alert("This slip still has parts. Return those parts to New Stock first.");
      return;
    }
    setReturnSlips((prev) => prev.filter((s) => s.id !== slipId));
  }

  // Move an already-active item (matched from an archived purchase line) into a
  // target bubble — used by the Archive → Search Purchases view. The view picks
  // the destination (RETURNS or CASHPAD); CASHPAD also flips to the CASH_SALE
  // accounting path, mirroring addArchiveLineToCashSales.
  function handleMoveArchiveItemToBubble(uid, bubbleName) {
    if (!uid || !bubbleName) return;
    const targetName = String(bubbleName).trim().toUpperCase();
    const nowIso = new Date().toISOString();
    const accountingPath =
      targetName === "CASHPAD"
        ? ACCOUNTING_PATHS.CASH_SALE
        : ACCOUNTING_PATHS.OUTSTANDING;
    const updatedItems = items.map((it) =>
      it.uid === uid
        ? {
            ...it,
            allocated_to: targetName,
            accountingPath,
            last_moved_at: nowIso,
          }
        : it
    );
    setItems(updatedItems);
    ensureBubblesForItems(updatedItems, setBubbles);
    lastSavedRef.current = JSON.stringify(updatedItems);
    api
      .writeItems(updatedItems)
      .catch((e) => console.error("[archive-move] writeItems failed", e));
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

  // Sales Order view's Delivered/Counter/Paid checkboxes — same dual-write
  // (local bubbleMeta + cross-machine shared file) as every other per-bubble
  // field.
  //
  // Takes either a single (key, value) or a whole patch object. The patch form
  // exists because Counter and Delivered are mutually exclusive: ticking one
  // has to clear the other, and two back-to-back single-key calls would BOTH
  // read the same stale `bubbleMeta` off this closure, so the second would
  // silently undo the first.
  function handleSetBubbleFlag(bubbleId, key, value) {
    if (!bubbleId) return;
    const patch = key && typeof key === "object" ? key : { [key]: value };
    const bubble = bubbles.find((b) => b.id === bubbleId);
    const nameKey = bubble?.name;
    const meta = bubbleMeta[bubbleId] || bubbleMeta[nameKey] || {};
    const nextMeta = { ...meta, ...patch };
    const nextBubbleMeta = {
      ...bubbleMeta,
      ...(nameKey ? { [nameKey]: nextMeta } : {}),
      [bubbleId]: nextMeta,
    };
    setBubbleMeta(nextBubbleMeta);
    persistUIState(nextBubbleMeta);
    persistSharedBubbleSnapshot(bubbleId, patch);
  }

  // Shared by every view that offers "Send to Sage Sales" (Cash Sales and
  // Sales Orders) — one place for the failure alert so they can't drift into
  // different error-handling behavior.
  async function handleSageSalesInvoice(bubbleName, customerCode, notes, paymentType) {
    // Flush unsaved item state to disk FIRST.
    //
    // items:sage-sales-invoice reads the items back off DISK in the main
    // process — it can't see React state. Price edits (Match payment, CAP add,
    // a typed discount) only call updateItemByKey, which sets state and leaves
    // persistence to the write-through save effect. That lands in a fraction of
    // a second, but "a fraction of a second" is not "before the next line of
    // this function", and Sage typing yesterday's prices is not a failure worth
    // racing for. Flushing here makes what's on screen and what the AHK types
    // the same thing by construction rather than by timing.
    const pending = JSON.stringify(items);
    if (pending !== lastSavedRef.current) {
      try {
        const flushed = await api.writeItems(items);
        if (flushed?.ok === false) throw new Error(flushed.error || "Unknown error");
        // Keeps the autosave from immediately rewriting the same snapshot.
        lastSavedRef.current = pending;
      } catch (e) {
        lastSavedRef.current = "";
        alert(
          "The latest prices could not be saved before sending to Sage:\n\n" +
            (e?.message || String(e)) +
            "\n\nNothing was sent — Sage would have been given the old prices. Try again in a moment."
        );
        return { ok: false, error: e?.message || "Failed to save prices before sending." };
      }
    }

    const res = await api.sageSalesInvoice(bubbleName, customerCode, notes || "", paymentType || "", {
      includeGrandTotal: sageGrandTotalLine,
    });
    if (!res?.ok) {
      console.error("[sage-sales] invoice failed", res);
      alert(res?.error || "Sage Sales Invoice failed. Check the console for details.");
      return res;
    }

    // Everything below is bookkeeping about a run that already happened in
    // Sage. None of it may throw far enough to make a successful entry look
    // like a failure, so each step reports and carries on.
    const invoiceNumber = String(res.sageInvoiceNumber || "").trim();
    const nowIso = new Date().toISOString();
    const bubble = bubbles.find((b) => b.name === bubbleName);
    const saleItems = items.filter((it) => it.allocated_to === bubbleName);
    const meta = bubble ? bubbleMeta[bubble.id] || bubbleMeta[bubble.name] || {} : {};
    const assignedPayments = (meta.paymentIds || [])
      .map((id) => (payments || []).find((p) => p?.id === id))
      .filter(Boolean);

    // 1. Trace it on every part in the sale. Sending to Sage moves nothing
    //    between bubbles or queues, so writeItems can't infer the event —
    //    hence the explicit historyEvent. Only the sale's own items are sent
    //    (writeItems upserts by uid and keeps everything else), which is also
    //    what stops the event being logged against the whole store.
    if (saleItems.length) {
      const stampedSaleItems = saleItems.map((it) => ({
        ...it,
        sage_invoice_number: invoiceNumber,
        sage_sent_at: nowIso,
      }));
      const byUid = new Map(stampedSaleItems.map((it) => [it.uid, it]));
      const nextItems = items.map((it) => byUid.get(it.uid) || it);
      setItems(nextItems);
      lastSavedRef.current = JSON.stringify(nextItems);
      try {
        const wrote = await api.writeItems(stampedSaleItems, [], {
          historyEvent: {
            event: "sent_to_sage",
            extra: { sage_invoice_number: invoiceNumber, sale: bubbleName },
          },
        });
        if (wrote?.ok === false) throw new Error(wrote.error || "Unknown error");
      } catch (e) {
        lastSavedRef.current = "";
        console.error("[sage-sales] failed to stamp items", e);
      }
    }

    // 2. Log the run itself — the record that outlives the sale once it's
    //    archived and its bubble is gone.
    const subtotal = saleItems.reduce((sum, it) => {
      const unit =
        it.discounted_price !== undefined && it.discounted_price !== null && it.discounted_price !== ""
          ? Number(it.discounted_price) || 0
          : Number(it.allocated_for) || 0;
      return sum + (Number(it.quantity) || 0) * unit;
    }, 0);

    let runId = "";
    try {
      const logged = await api.appendSageRun({
        saleName: bubbleName,
        customerCode: customerCode || "",
        sageInvoiceNumber: invoiceNumber,
        notes: notes || "",
        itemCount: saleItems.length,
        payments: assignedPayments.map((p) => ({
          id: p.id,
          amount: Number(p.amount) || 0,
          date: p.date || "",
          time: p.time || "",
          note: p.note || "",
          type: p.type || "",
        })),
        saleTotal: Number((subtotal * 1.13).toFixed(2)),
      });
      if (logged?.ok) runId = logged.run?.id || "";
      else console.error("[sage-sales] failed to log the run", logged);
    } catch (e) {
      console.error("[sage-sales] failed to log the run", e);
    }

    // 3. Put the invoice number on the sale card, where it can be corrected or
    //    cleared. `sageRunId` is what ties an edit there back to the log row.
    if (bubble) {
      const nextMeta = {
        ...meta,
        sageInvoiceNumber: invoiceNumber,
        sageSentAt: nowIso,
        sageRunId: runId,
      };
      const nextBubbleMeta = {
        ...bubbleMeta,
        [bubble.id]: nextMeta,
        ...(bubble.name ? { [bubble.name]: nextMeta } : {}),
      };
      setBubbleMeta(nextBubbleMeta);
      persistUIState(nextBubbleMeta);
      persistSharedBubbleSnapshot(bubble.id, {
        sageInvoiceNumber: invoiceNumber,
        sageSentAt: nowIso,
        sageRunId: runId,
      });
    }

    return { ...res, sageInvoiceNumber: invoiceNumber };
  }

  // Correcting or clearing the Sage invoice number on a sale card. Writes both
  // places it lives: the card (bubbleMeta + the shared file) and the run log
  // row the report prints from, so the two can't drift.
  async function handleSetSaleInvoiceNumber(bubbleId, value) {
    const bubble = bubbles.find((b) => b.id === bubbleId);
    if (!bubble) return;
    const next = String(value ?? "").trim();
    const meta = bubbleMeta[bubbleId] || bubbleMeta[bubble.name] || {};
    const nextMeta = { ...meta, sageInvoiceNumber: next };
    const nextBubbleMeta = {
      ...bubbleMeta,
      [bubbleId]: nextMeta,
      ...(bubble.name ? { [bubble.name]: nextMeta } : {}),
    };
    setBubbleMeta(nextBubbleMeta);
    persistUIState(nextBubbleMeta);
    persistSharedBubbleSnapshot(bubbleId, { sageInvoiceNumber: next });
    if (meta.sageRunId) {
      const res = await api.setSageRunInvoice({ id: meta.sageRunId, sageInvoiceNumber: next });
      if (res?.ok === false) console.warn("[sage-sales] run log not updated", res.error);
    }
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

  async function handleFillFromCashPad() {
    dbg('fill:START', {
      markupInput: cashPadMarkup,
      totalPayments: (payments || []).length,
      totalItems: (items || []).length,
      totalBubbles: bubbles.length,
      bubbleMetaKeys: Object.keys(bubbleMeta).length,
    });
    const TAX = 0.13;
    const markup = Math.max(0, parseFloat(cashPadMarkup) || 0) / 100;
    const toAmt = (v) => parseFloat((v ?? '').toString().replace(/[^0-9.-]/g, '')) || 0;

    // Only payments that are genuinely still free to spend.
    //
    // Three ways money can already be accounted for, and all three have to be
    // excluded or Auto-fill invents a second sale for takings that were banked
    // once:
    //   1. attached to a sale that's open right now;
    //   2. flagged recordedInSage — archiving a sale CLEARS its attachment and
    //      sets this instead, so without it every invoiced payment looks free
    //      again the moment its sale is filed away;
    //   3. named by an archived sale in the bubble archive — the same case as
    //      (2) for sales archived before that flag existed.
    const assignedIds = new Set(
      Object.values(bubbleMeta).flatMap((m) => m.paymentIds || [])
    );

    let archivedIds = new Set();
    try {
      const usage = await api.getArchivedPaymentUsage?.();
      if (usage?.ok) archivedIds = new Set(Object.keys(usage.usage || {}));
    } catch (e) {
      // Best effort. The recordedInSage flag still covers everything archived
      // since it was introduced, so a failed lookup narrows the check rather
      // than disabling it.
      console.warn('[cashpad-fill] archived payment lookup failed', e);
    }

    const spent = [];
    const unassigned = [];
    (payments || []).forEach((p) => {
      if (!p?.id) return;
      if (assignedIds.has(p.id)) return; // on an open sale — not "spent", just busy
      if (p.recordedInSage === true) { spent.push(p); return; }
      if (archivedIds.has(p.id)) { spent.push(p); return; }
      unassigned.push(p);
    });

    dbg('fill:payments', {
      assignedPaymentIds: Array.from(assignedIds),
      skippedAlreadyInSage: spent.map((p) => ({ id: p.id, type: p.type, amount: p.amount })),
      unassignedCount: unassigned.length,
      unassigned: unassigned.map((p) => ({ id: p.id, type: p.type, amount: p.amount })),
    });
    if (!unassigned.length) {
      alert(
        spent.length
          ? `No payments left to fill.\n\n${spent.length} payment${spent.length === 1 ? " is" : "s are"} already recorded in Sage and won't be reused.`
          : 'No unassigned payments found.'
      );
      return;
    }

    // CASHPAD items only
    const cashpadItems = items.filter(
      (it) => (it.allocated_to || '').toUpperCase() === 'CASHPAD'
    );
    dbg('fill:cashpadItems', {
      count: cashpadItems.length,
      items: cashpadItems.map((it) => ({ uid: it.uid, cost: it.cost, qty: it.quantity, desc: it.description })),
    });
    if (!cashpadItems.length) { alert('CashPad is empty.'); return; }

    // Every part is priced the same way here, off cost: cost × (1 + markup),
    // then × (1 + tax) for what the customer actually hands over. A price
    // already sitting on the part is deliberately NOT used as the basis — the
    // fit below and the discount written back afterwards have to agree, or a
    // card's total won't land on the payment it was chosen for. The SELLING
    // price (allocated_for) is never touched; only discounted_price, which is
    // the cash-sale price by definition.
    const unitPriceFor = (it) => toAmt(it.cost) * (1 + markup);
    // What one CashPad row adds to a card's tax-in total — its "line total".
    const lineTotalFor = (it) => unitPriceFor(it) * (Number(it.quantity) || 1) * (1 + TAX);

    const priced = cashpadItems
      .map((it) => ({ ...it, _eff: lineTotalFor(it) }))
      // A row with no cost recorded prices to nothing, so it would "fit" every
      // payment for free and pad cards with parts that move no money.
      .filter((it) => it._eff > 0);
    dbg('fill:priced', {
      count: priced.length,
      skippedNoCost: cashpadItems.length - priced.length,
    });
    if (!priced.length) {
      alert('Nothing in CashPad has a cost recorded, so no line totals could be worked out.');
      return;
    }

    // Payments oldest first — the earliest payment gets first pick of the
    // CashPad pool, so stock clears in the order the money actually came in.
    // Same date/createdAt fallback the Payment Management list sorts by.
    const paymentTime = (p) => {
      const t = new Date(p?.date || p?.createdAt || 0).getTime();
      return Number.isFinite(t) ? t : 0;
    };
    const sortedPayments = [...unassigned].sort((a, b) => {
      const diff = paymentTime(a) - paymentTime(b);
      if (diff) return diff;
      // Same day: fall back to when the payment was recorded, then largest first.
      const ca = new Date(a?.createdAt || 0).getTime() || 0;
      const cb = new Date(b?.createdAt || 0).getTime() || 0;
      if (ca !== cb) return ca - cb;
      return toAmt(b.amount) - toAmt(a.amount);
    });

    // Best fit, one part at a time.
    //
    // For each payment: of everything still in CashPad whose line total fits
    // under what's left of the payment, take the part that leaves the SMALLEST
    // delta (delta = payment − the card's running total). Then look again with
    // the reduced budget, and stop when nothing fits.
    //
    // Taking the largest that fits IS minimizing the delta — the delta shrinks
    // by exactly the line total added — so each step is one scan of the pool
    // rather than a search over combinations. That also makes the multi-part
    // case fall out for free: every part after the first is chosen against the
    // remaining budget, so it's the running sum being fitted to the payment,
    // not each part on its own.
    const pool = [...priced];
    const assignments = [];
    for (const payment of sortedPayments) {
      const target = toAmt(payment.amount);
      const chosen = [];
      let spent = 0;
      for (;;) {
        let bestIdx = -1;
        let bestEff = 0;
        for (let i = 0; i < pool.length; i++) {
          const eff = pool[i]._eff;
          // Half a cent of slack, so a line total that lands exactly on the
          // payment isn't rejected by floating-point drift.
          if (spent + eff > target + 0.005) continue;
          if (eff <= bestEff) continue;
          bestIdx = i;
          bestEff = eff;
        }
        if (bestIdx < 0) break;
        chosen.push(pool[bestIdx]);
        spent += bestEff;
        pool.splice(bestIdx, 1);
      }
      assignments.push({ payment, chosen });
      dbg('fill:assign', {
        paymentId: payment.id,
        target: target.toFixed(2),
        spent: spent.toFixed(2),
        delta: (target - spent).toFixed(2),
        chosenUids: chosen.map((c) => c.uid),
        chosenLineTotals: chosen.map((c) => c._eff.toFixed(2)),
        poolRemaining: pool.length,
      });
    }

    if (!assignments.some((a) => a.chosen.length > 0)) {
      dbg('fill:ABORT', 'no items could be assigned to any payment');
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
      const bubbleId = bubbleIdForName(bubbleName);
      const meta = { accountingPath: ACCOUNTING_PATHS.CASH_SALE, paymentIds: [payment.id] };
      newBubbles.push({ id: bubbleId, name: bubbleName, notes: '' });
      newMetaEntries[bubbleId] = meta;
      newMetaEntries[bubbleName] = meta;
      chosen.forEach((it) => itemToBubble.set(it.uid, bubbleName));
      sharedWrites.push({ bubbleId, bubbleName, paymentIds: [payment.id] });
      bubblesCreated++;
      itemsMoved += chosen.length;
      dbg('fill:newBubble', { bubbleId, bubbleName, paymentId: payment.id, itemCount: chosen.length });
    }

    dbg('fill:applying', {
      bubblesCreated,
      itemsMoved,
      newBubbleNames: newBubbles.map((b) => b.name),
      itemToBubble: Array.from(itemToBubble.entries()),
    });

    setBubbles((prev) => {
      const next = [...prev, ...newBubbles];
      dbg('fill:setBubbles', { before: prev.length, after: next.length });
      return next;
    });
    setBubbleMeta((prev) => {
      const next = { ...prev, ...newMetaEntries };
      persistUIState(next);
      return next;
    });

    // Build the moved-items array explicitly so we can persist it to disk
    // immediately (below) rather than leaving it to the write-through save.
    // This one is worth doing by hand: the shared-bubble writes just below have
    // to describe parts that are already committed, or another machine reads a
    // payment bubble whose contents haven't arrived yet.
    let moved = 0;
    const updatedItems = items.map((it) => {
      const dest = itemToBubble.get(it.uid);
      if (!dest) return it;
      moved++;
      // Stamped CASH_SALE here because this IS the moment a part becomes one.
      // Without it a part that reached CashPad via "Send to Cash Pad" (which
      // leaves it on OUTSTANDING) kept that path inside its payment bubble, and
      // the bubble then read as OUTSTANDING and vanished from Cash Sales.
      const patch = {
        ...it,
        allocated_to: dest,
        accountingPath: ACCOUNTING_PATHS.CASH_SALE,
        last_moved_at: now,
      };
      // The cash-sale price, per unit, on exactly the basis the fit above used
      // — anything else and the card's total wouldn't add up to the payment it
      // was chosen for. Written unconditionally: re-running with a different
      // markup has to re-price, otherwise the second run's split and the prices
      // on screen would describe different numbers. `allocated_for` (the
      // selling price) is deliberately left alone.
      patch.discounted_price = unitPriceFor(it).toFixed(2);
      return patch;
    });
    dbg('fill:setItems', { movedInThisUpdate: moved, expected: itemsMoved, totalItems: updatedItems.length });
    setItems(updatedItems);
    // Keep autosave from immediately re-writing the same snapshot.
    lastSavedRef.current = JSON.stringify(updatedItems);

    sharedWrites.forEach(({ bubbleId, bubbleName, paymentIds }) => {
      dbg('fill:sharedWrite', { bubbleId, bubbleName, paymentIds });
      api.writeSharedBubbleData?.({
        bubbleId, name: bubbleName, notes: '', extraLines: [], paymentIds,
      }).catch((e) => { dbg('fill:sharedWrite:FAILED', String(e)); console.warn('[cashpad-fill] shared write failed', e); });
    });

    // Persist the moves right away. On failure (e.g. a transient SMB EPERM on
    // the atomic rename) clear lastSavedRef so autosave retries, and tell the
    // user rather than leaving the move only in memory.
    dbg('fill:writeItems', { itemCount: updatedItems.length });
    try {
      const res = await api.writeItems(updatedItems);
      if (res && res.ok === false) {
        dbg('fill:writeItems:REJECTED', res.error);
        lastSavedRef.current = "";
        alert(
          "The cash-sale fill was applied on screen but could not be saved to the shared folder:\n\n" +
          (res.error || "Unknown error") +
          "\n\nIt will retry automatically, but if other machines are open the fill may be reverted. Re-check after a few seconds."
        );
      } else {
        dbg('fill:writeItems:OK', { itemCount: updatedItems.length });
      }
    } catch (e) {
      dbg('fill:writeItems:FAILED', String(e));
      lastSavedRef.current = "";
      alert(
        "The cash-sale fill was applied on screen but could not be saved to the shared folder:\n\n" +
        (e?.message || String(e)) +
        "\n\nIt will retry automatically."
      );
    }

    dbg('fill:DONE', { bubblesCreated, itemsMoved, skipped: spent.length });
    setFillCashPadResult(
      `Created ${bubblesCreated} bubble${bubblesCreated !== 1 ? 's' : ''}, moved ${itemsMoved} item${itemsMoved !== 1 ? 's' : ''}.` +
      // Said out loud rather than silently skipped, so a payment that doesn't
      // show up is explained instead of looking like a bug.
      (spent.length
        ? ` Skipped ${spent.length} already in Sage.`
        : '')
    );
    setTimeout(() => setFillCashPadResult(null), 5000);
  }

  // The undo for Auto-fill: pull every open cash sale's parts back into CashPad
  // and drop the per-payment bubbles it created, so the split can be redone
  // (e.g. after fixing a markup or a wrong payment amount).
  //
  // Deliberately NOT a loop over handleDeleteBubble. That reads `bubbles` and
  // `bubbleMeta` out of the render closure, so N calls in a row would each work
  // from the same stale snapshot and only one bubble's cleanup would survive —
  // a React closure problem, not a persistence one. This does the whole set in
  // one pass, exactly as Auto-fill does.
  async function handleReturnAllToCashPad() {
    // Exactly the set Cash Sales displays — NOT a second, parallel rule. When
    // this filtered on the accounting path alone it silently skipped any card
    // the view showed on the strength of an assigned payment (a "MASTERCARD
    // $250.00" whose parts still read OUTSTANDING), so a button labelled "all"
    // quietly left some behind.
    //
    // Archived sales can't appear here at all: archiving removes their parts
    // from `items` and their bubble from `bubbles`, so there is nothing left
    // for this to match. It only ever sees what's currently on screen.
    const targets = bubbles.filter((b) => {
      const name = (b.name || "").trim();
      if (!name || DEFAULT_BUBBLE_NAMES.has(name)) return false;
      // CashPad is the destination, not a sale to empty.
      if (name.toUpperCase() === "CASHPAD") return false;
      return cashSaleBubbleNames.has(b.name);
    });

    if (!targets.length) {
      setFillCashPadResult("No cash sales to send back.");
      setTimeout(() => setFillCashPadResult(null), 5000);
      return;
    }

    // Matched case-insensitively, the same way groupItemsByBubble puts parts
    // onto cards. Comparing raw strings here would move a subset of what the
    // card visibly contains if a part's allocated_to differed only in case.
    const targetNames = new Set(targets.map((b) => (b.name || "").trim().toUpperCase()));
    const targetIds = new Set(targets.map((b) => b.id));
    const isTargetItem = (it) => targetNames.has((it.allocated_to || "").trim().toUpperCase());
    const moving = items.filter(isTargetItem);

    const confirmed = window.confirm(
      `Send all ${targets.length} cash sale${targets.length === 1 ? "" : "s"} back to CashPad?\n\n` +
        `${moving.length} part${moving.length === 1 ? "" : "s"} move into CashPad and these sales stop existing — ` +
        `their notes and payment assignments go away. The payments themselves are untouched, so ` +
        `"Fill Payments" can rebuild the split.`
    );
    if (!confirmed) return;

    const nowIso = new Date().toISOString();
    const updatedItems = items.map((it) =>
      isTargetItem(it)
        ? {
            ...it,
            allocated_to: "CASHPAD",
            // Same rule handleMoveArchiveItemToBubble applies: sitting in
            // CashPad means the part is on the cash-sale path.
            accountingPath: ACCOUNTING_PATHS.CASH_SALE,
            last_moved_at: nowIso,
          }
        : it
    );

    setItems(updatedItems);
    lastSavedRef.current = JSON.stringify(updatedItems);
    // Creates the CASHPAD bubble if this is the first thing to land there;
    // the filter below then removes the emptied sales.
    ensureBubblesForItems(updatedItems, setBubbles);
    setBubbles((prev) => prev.filter((b) => !targetIds.has(b.id)));

    const cleanedBubbleMeta = { ...bubbleMeta };
    const cleanedPrintExtras = { ...printExtraLinesByBubble };
    targets.forEach((b) => {
      delete cleanedBubbleMeta[b.id];
      if (b.name) delete cleanedBubbleMeta[b.name];
      delete cleanedPrintExtras[b.id];
    });
    setBubbleMeta(cleanedBubbleMeta);
    setPrintExtraLinesByBubble(cleanedPrintExtras);
    persistUIState(cleanedBubbleMeta);

    targets.forEach((b) => {
      if (api?.deleteSharedBubbleData) {
        api.deleteSharedBubbleData(b.id).catch((e) =>
          console.warn("[shared-bubble] delete failed", e)
        );
        if (b.name) api.deleteSharedBubbleData(b.name).catch(() => {});
      }
      markSharedBubbleDeleted(b);
    });

    // Persist the moves here rather than leaving them to the write-through
    // save, so the bubble deletions above and the parts they released are
    // committed together instead of a moment apart.
    try {
      const res = await api.writeItems(updatedItems);
      if (res && res.ok === false) throw new Error(res.error || "Unknown error");
    } catch (e) {
      lastSavedRef.current = "";
      alert(
        "The parts were moved back on screen but could not be saved to the shared folder:\n\n" +
          (e?.message || String(e)) +
          "\n\nIt will retry automatically, but re-check after a few seconds."
      );
    }

    setFillCashPadResult(
      `Sent ${moving.length} part${moving.length === 1 ? "" : "s"} back to CashPad from ${
        targets.length
      } sale${targets.length === 1 ? "" : "s"}.`
    );
    setTimeout(() => setFillCashPadResult(null), 5000);
  }

  // End of the line for a cash sale that's been through the workflow — it's
  // been invoiced into Sage, returned, or otherwise dealt with. Nothing is
  // destroyed: the sale and its parts are copied into archived_bubbles.json
  // (searchable from the Archive tab) and the removal is tagged `archived`, so
  // each part's lifecycle trail ends with "Archived" rather than "deleted".
  // Shared by Cash Sales ("Archive Sale") and Sales Orders ("Delivered and
  // Complete"). Both mean the same thing to the books — the sale is finished,
  // so the parts leave the active queue as sold and the bubble stops existing.
  // Only the wording of the confirm differs, hence `confirmMessage`.
  async function handleArchiveCashSale(bubbleId, confirmMessage) {
    const bubble = bubbles.find((b) => b.id === bubbleId);
    if (!bubble) return;
    const bubbleItems = items.filter((it) => it.allocated_to === bubble.name);
    const confirmed = window.confirm(
      // An empty order has nothing to file, so don't promise an archive entry
      // that would contain nothing — this is purely clearing the card away.
      bubbleItems.length === 0
        ? `Close "${bubble.name}"?\n\nIt has no parts left, so there's nothing to file in the Archive — this just removes the empty order.`
        : confirmMessage ||
          `Archive "${bubble.name}" and its ${bubbleItems.length} part(s)?\n\nThey leave Cash Sales and move to the Archive — searchable there, with each part's history kept intact.`
    );
    if (!confirmed) return;
    try {
      // Only write an archive entry when there is something to archive. An
      // empty bubble would otherwise add a zero-item row to
      // archived_bubbles.json that no search can ever return — noise that reads
      // like a lost sale when you go looking for one.
      if (bubbleItems.length) {
        const res = await api.archiveBubble({
          bubble,
          meta: bubbleMeta[bubbleId] || bubbleMeta[bubble.name] || {},
          items: bubbleItems,
        });
        if (!res?.ok) throw new Error(res?.error || "Failed to archive this sale.");
        const remainingItems = items.filter((it) => it.allocated_to !== bubble.name);
        const removedUids = bubbleItems.map((it) => it.uid);
        markItemsDeleted(removedUids);
        setItems(remainingItems);
        lastSavedRef.current = JSON.stringify(remainingItems);
        // Only clears the active queue files — the archive copy above is what
        // persists. `archived` is what makes the history read "Archived (sold)".
        const writeRes = await api.writeItems(remainingItems, removedUids, {
          deleteReason: "archived",
        });
        if (writeRes?.ok === false) {
          throw new Error(writeRes.error || "Failed to clear archived parts from the active files.");
        }
        confirmItemsDeleted(removedUids);
      }
      const paymentMeta = bubbleMeta[bubbleId] || bubbleMeta[bubble.name] || {};
      const assignedIds = Array.isArray(paymentMeta.paymentIds)
        ? paymentMeta.paymentIds.filter(Boolean)
        : [];
      if (assignedIds.length) {
        // Flagged rather than deleted. The money is now in Sage, so the payment
        // has done its job — but it still has to be reconcilable against a bank
        // deposit, and deleting it here would make that impossible. The Payments
        // view shows these as Recorded and offers a purge when you're ready.
        const idSet = new Set(assignedIds);
        const recordedAt = new Date().toISOString();
        const nextPayments = (payments || []).map((p) =>
          p?.id && idSet.has(p.id)
            ? {
                ...p,
                recordedInSage: true,
                recordedAt,
                recordedForSale: bubble.name || "",
                sageInvoiceNumber: paymentMeta.sageInvoiceNumber || p.sageInvoiceNumber || "",
              }
            : p
        );
        try {
          await api.writePayments(nextPayments);
          setPayments(nextPayments);
        } catch (e) {
          // The sale still archives — the flag is bookkeeping, not the point.
          console.error("[archive-cash-sale] failed to flag payments as recorded", e);
        }
        handleUpdateBubblePayments(bubbleId, []);
      }
      setBubbles((prev) => prev.filter((b) => b.id !== bubbleId));
      const cleanedBubbleMeta = { ...bubbleMeta };
      delete cleanedBubbleMeta[bubbleId];
      if (bubble.name) delete cleanedBubbleMeta[bubble.name];
      const cleanedPrintExtras = { ...printExtraLinesByBubble };
      delete cleanedPrintExtras[bubbleId];
      setBubbleMeta(cleanedBubbleMeta);
      setPrintExtraLinesByBubble(cleanedPrintExtras);
      persistUIState(cleanedBubbleMeta);
      if (api?.deleteSharedBubbleData) {
        api.deleteSharedBubbleData(bubbleId).catch((e) => console.warn("[shared-bubble] delete failed", e));
        if (bubble?.name) api.deleteSharedBubbleData(bubble.name).catch(() => {});
      }
      markSharedBubbleDeleted(bubble);
    } catch (e) {
      console.error("[archive-cash-sale] failed", e);
      alert(e?.message || "Failed to archive this sale.");
    }
  }

  function handleOpenPrint(bubble, mode = "salesOrder") {
    if (!bubble || DEFAULT_BUBBLE_NAMES.has(bubble.name)) return;
    setPrintMode(mode === "quote" ? "quote" : "salesOrder");
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

  // Writes the discount straight through to the bubble so both machines and a
  // later reprint see the same number. Applying it to the prices is a separate,
  // explicit action — see handleApplyQuoteDiscount.
  function handleSetQuoteDiscount(value) {
    if (!printBubble) return;
    const amount = Math.max(0, Math.round((Number(value) || 0) * 100) / 100);
    const nameKey = printBubble.name;
    const meta = bubbleMeta[printBubble.id] || bubbleMeta[nameKey] || {};
    const nextMeta = { ...meta, quoteDiscount: amount };
    const nextBubbleMeta = {
      ...bubbleMeta,
      ...(nameKey ? { [nameKey]: nextMeta } : {}),
      [printBubble.id]: nextMeta,
    };
    setBubbleMeta(nextBubbleMeta);
    persistUIState(nextBubbleMeta);
    persistSharedBubbleSnapshot(printBubble.id, { quoteDiscount: amount });
  }

  // Pushes an agreed discount down into the individual sell prices, so the
  // Sales Order's own footer lands on the number the customer accepted without
  // the word "discount" ever appearing on it.
  //
  // Deliberately a button rather than a side effect of printing the quote:
  // this rewrites the price on every part in the order, and printing a quote to
  // show someone shouldn't silently do that. Flagged once done so a second
  // click can't stack the same concession twice.
  async function handleApplyQuoteDiscount() {
    if (!printBubble) return;
    const { discount, applied } = printQuoteMeta;
    if (applied || !(discount > 0)) return;

    const plan = computeDiscountedItemPrices(
      printItems,
      printExtraLines,
      discount,
      INVOICE_DOCUMENT_DEFAULTS.taxRate
    );
    if (!plan.ok) {
      alert(plan.error);
      return;
    }

    const n = plan.updates.length;
    // The footer rounds the subtotal and the tax separately, so as the subtotal
    // moves by a cent the total moves by one or two — which leaves some totals
    // simply unreachable. When the asked-for discount lands on one of those, the
    // DISCOUNT is what gives, not the agreement between the two documents: the
    // quote is re-stated as the concession actually made, so its Post-Discount
    // and the Sales Order's Total stay the same number.
    const effectiveDiscount = Math.round((plan.before - plan.achieved) * 100) / 100;

    const ok = await api.confirm(
      `Take $${discount.toFixed(2)} off "${printBubble.name}"?`,
      `The Sales Order total goes from $${plan.before.toFixed(2)} to ` +
        `$${plan.achieved.toFixed(2)} taxes in. The Quotation is unchanged — it keeps the full ` +
        `prices with the discount on its own line.\n\n` +
        `It comes out of margin: each of the ${n} part${n === 1 ? "" : "s"} gives up a share of ` +
        `what it makes, so nothing is sold below cost and a part coming back as a return ` +
        `refunds only what it was invoiced. $${plan.marginLeft.toFixed(2)} of margin is left ` +
        `on the order.\n\n` +
        `This overwrites the sell price on ${n} part${n === 1 ? "" : "s"} — but the Quotation ` +
        `remembers what they were.` +
        (plan.noCostCount
          ? `\n\n${plan.noCostCount} part${plan.noCostCount === 1 ? " has" : "s have"} no cost ` +
            `recorded, so ${plan.noCostCount === 1 ? "it stays" : "they stay"} at full price — ` +
            `there's no way to know what ${plan.noCostCount === 1 ? "it can" : "they can"} give up.`
          : "") +
        (effectiveDiscount !== discount
          ? `\n\n$${discount.toFixed(2)} isn't reachable — the tax rounding skips it — so this ` +
            `takes off $${effectiveDiscount.toFixed(2)} and the quote will say that too, keeping ` +
            `both documents on $${plan.achieved.toFixed(2)}.`
          : "")
    );
    if (!ok) return;

    // Captured BEFORE the writes — this is what the quote goes on printing, so
    // the discount stays a visible line on it rather than disappearing into the
    // prices the way it does on the sales order.
    const priorPrices = plan.updates.map((u) => ({
      uid: u.uid,
      allocated_for: String(printItems.find((it) => it.uid === u.uid)?.allocated_for ?? ""),
    }));

    plan.updates.forEach((u) => updateItemByKey(u.uid, { allocated_for: u.allocated_for }));

    const nameKey = printBubble.name;
    const meta = bubbleMeta[printBubble.id] || bubbleMeta[nameKey] || {};
    const nextMeta = {
      ...meta,
      quoteDiscount: effectiveDiscount,
      quoteDiscountApplied: true,
      quoteDiscountPriorPrices: priorPrices,
    };
    const nextBubbleMeta = {
      ...bubbleMeta,
      ...(nameKey ? { [nameKey]: nextMeta } : {}),
      [printBubble.id]: nextMeta,
    };
    setBubbleMeta(nextBubbleMeta);
    persistUIState(nextBubbleMeta);
    persistSharedBubbleSnapshot(printBubble.id, {
      quoteDiscount: effectiveDiscount,
      quoteDiscountApplied: true,
      quoteDiscountPriorPrices: priorPrices,
    });
  }

  // The preview node is the printed page — same DOM, so what's on screen and
  // what comes out of the printer can't drift. Shared by both confirm paths.
  function openPrintWindow(title) {
    setTimeout(() => {
      if (!printPreviewRef.current) return;
      const contents = printPreviewRef.current.innerHTML;
      const printWindow = window.open("", "PRINT", "width=900,height=1100");
      if (!printWindow) return;
      printWindow.document.write(`
        <!doctype html>
        <html>
          <head>
            <title>${title}</title>
            <style>
              body {
                margin: 0;
                padding: 24px;
                background: #e2e8f0;
                font-family: 'Inter', 'Segoe UI', sans-serif;
              }
              @page { size: letter; margin: 0.5in; }
              @media print {
                body {
                  padding: 0;
                  background: white;
                }
                /* The sheet is sized for the screen preview (8.5x11 with its
                   own margin baked in as padding). On paper the printer's own
                   0.5in margin supplies that, so drop the padding and shrink to
                   the printable area — otherwise the sheet overflows onto a
                   second, near-empty page. */
                .invoice-sheet {
                  width: auto !important;
                  min-height: 0 !important;
                  height: 9.9in !important;
                  padding: 0 !important;
                  border-radius: 0 !important;
                  box-shadow: none !important;
                }
                /* Keep the header/table fills — printers strip backgrounds by
                   default, which would flatten the whole grid to plain white. */
                * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
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

  // Nothing has been ordered yet, so this deliberately does NONE of what a
  // Sales Order print does: no number off the shared counter, no `sold_date` on
  // the parts, no printedSignature. Stamping any of those would mark unsold
  // stock as sold and flip the card's "Printed" badge for paperwork that was
  // never issued.
  async function handleConfirmQuotePrint() {
    if (!printBubble || (printItems.length === 0 && printExtraLines.length === 0)) return;
    const printedAt = new Date().toISOString();
    setPrintGeneratedAt(new Date());

    const rowsForTotal = [
      ...printQuoteItems.map((it) => ({
        extension: (Number(it.quantity) || 0) * (Number(it.allocated_for) || 0),
        taxable: true,
      })),
      ...printExtraLines.map((l) => ({
        extension: (Number(l.quantity) || 0) * (Number(l.unitPrice) || 0),
        taxable: l.taxable !== false,
      })),
    ];
    const gross = computeDocumentTotals(rowsForTotal, INVOICE_DOCUMENT_DEFAULTS.taxRate).total;

    // Same reasoning as the Sales Order snapshot: never fatal. The paper is
    // going out either way, so a failed record is a warning, not an abort.
    try {
      const res = await api?.appendPrintSnapshot?.({
        kind: "QUOTE",
        salesOrderNumber: "",
        printedAt,
        bubbleId: printBubble.id,
        bubbleName: printBubble.name,
        notes: printBubble.notes || "",
        items: printQuoteItems,
        extraLines: printExtraLines,
        discount: printQuoteMeta.discount,
        quoteTotal: Math.round((gross - printQuoteMeta.discount) * 100) / 100,
        document: {
          title: QUOTE_DOCUMENT_TITLE,
          companyName: INVOICE_DOCUMENT_DEFAULTS.companyName,
          companyAddress: INVOICE_DOCUMENT_DEFAULTS.companyAddress,
          companyContact: INVOICE_DOCUMENT_DEFAULTS.companyContact,
          taxLabel: INVOICE_DOCUMENT_DEFAULTS.taxLabel,
          taxRate: INVOICE_DOCUMENT_DEFAULTS.taxRate,
        },
      });
      if (res?.ok === false) console.warn("[quote] snapshot not recorded", res.error);
    } catch (e) {
      console.warn("[quote] snapshot not recorded", e?.message || e);
    }

    openPrintWindow(`Quotation - ${printBubble.name}`);
  }

  async function handleConfirmPrint() {
    if (!printBubble || (printItems.length === 0 && printExtraLines.length === 0))
      return;
    // The Sales Order number comes off a shared counter and is drawn here, not
    // when the preview opens, so previewing and cancelling never burns a
    // number. Once a bubble has one it keeps it — a reprint has to carry the
    // same number as the copy already in the customer's hands.
    let salesOrderNumber = printSalesOrderNumber;
    if (!salesOrderNumber) {
      try {
        const res = await api?.nextSalesOrderNumber?.();
        if (!res?.ok || !res.label) throw new Error(res?.error || "No number returned.");
        salesOrderNumber = res.label;
      } catch (e) {
        console.error("[print] sales order number failed", e);
        alert(
          `Couldn't assign a Sales Order number, so nothing was printed.\n\n${
            e?.message || e
          }`
        );
        return;
      }
    }
    const todayStr = new Date().toLocaleDateString("en-CA");
    if (printItems.length) {
      const ids = new Set(printItems.map((it) => it.uid));
      setItems((prev) =>
        prev.map((it) => (ids.has(it.uid) ? { ...it, sold_date: todayStr } : it))
      );
    }
    setPrintGeneratedAt(new Date());
    // Stamp what got printed so the Sales Order view can tell "printed, still
    // current" from "printed, but changed since" — computed from the exact
    // items/notes/extras this print run used, not whatever's on screen later.
    const printedExtraLines = printExtraLinesByBubble[printBubble.id] || [];
    const printedSignature = computeBubblePrintSignature(printBubble.notes, printItems, printedExtraLines);
    const printedAt = new Date().toISOString();
    {
      const nameKey = printBubble.name;
      const meta = bubbleMeta[printBubble.id] || bubbleMeta[nameKey] || {};
      const nextMeta = { ...meta, printedSignature, printedAt, salesOrderNumber };
      const nextBubbleMeta = {
        ...bubbleMeta,
        ...(nameKey ? { [nameKey]: nextMeta } : {}),
        [printBubble.id]: nextMeta,
      };
      setBubbleMeta(nextBubbleMeta);
      persistUIState(nextBubbleMeta);
    }
    persistSharedBubbleSnapshot(printBubble.id, {
      extraLines: printedExtraLines,
      printedSignature,
      printedAt,
      salesOrderNumber,
    });
    // Freeze what this print actually said. `printedSignature` above only
    // detects that the order changed afterwards; this is the copy that can be
    // read back line by line when a customer questions a price months later.
    // Awaited so a reprint gets the right version number, but never fatal — the
    // paper is already going out, so a failed record is a warning, not an abort.
    try {
      const res = await api?.appendPrintSnapshot?.({
        salesOrderNumber,
        printedAt,
        printedSignature,
        bubbleId: printBubble.id,
        bubbleName: printBubble.name,
        notes: printBubble.notes || "",
        items: printItems,
        extraLines: printedExtraLines,
        document: {
          title: INVOICE_DOCUMENT_DEFAULTS.documentTitle,
          companyName: INVOICE_DOCUMENT_DEFAULTS.companyName,
          companyAddress: INVOICE_DOCUMENT_DEFAULTS.companyAddress,
          companyContact: INVOICE_DOCUMENT_DEFAULTS.companyContact,
          taxLabel: INVOICE_DOCUMENT_DEFAULTS.taxLabel,
          taxRate: INVOICE_DOCUMENT_DEFAULTS.taxRate,
        },
      });
      if (res?.ok === false) {
        console.warn("[print] snapshot not recorded", res.error);
      }
    } catch (e) {
      console.warn("[print] snapshot not recorded", e?.message || e);
    }
    openPrintWindow(`Sales Order ${salesOrderNumber} - ${printBubble.name}`);
  }

  // "editing anything" flags for all text inputs
  function handleFieldFocus() {
    isEditingAnythingRef.current = true;
  }
  function handleFieldBlur() {
    isEditingAnythingRef.current = false;
  }

  // Collect a push that was deferred because this side had unsent changes.
  //
  // By the time this runs the flush has landed, so a straight read is the
  // merged truth — it already contains both what we sent and whatever the
  // deferred push was carrying. That is the whole reason deferring is safe:
  // nothing is dropped, it is only picked up a beat later from the one place
  // that is entitled to decide what the answer is.
  async function refreshItemsIfPending() {
    if (!pendingItemsRefreshRef.current) return;
    // Still dirty (a failed save, or the user typed again) — leave the flag up
    // and try after the next save rather than reading over live changes.
    if (isEditingAnythingRef.current || hasUnsentItemChanges()) return;
    pendingItemsRefreshRef.current = false;
    try {
      adoptPushedItems(await api.readItems());
    } catch (e) {
      pendingItemsRefreshRef.current = true;
      console.error("[items] deferred refresh failed", e);
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
      adoptSavedOrders(normalized);
      setOrdersDirty(false);
      // A reload is the moment the list is allowed to re-sort: drop any pickup
      // pin so cards land in the sections their saved state actually says.
      setPinnedPickup(null);
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
    const prev = ordersRef.current || [];
    if (index >= prev.length) return;
    const next = [...prev];
    next[index] = { ...(next[index] || {}), ...patch };
    commitOrders(next);
    setOrdersDirty(true);
  }

  // Builds the patched list from ordersRef.current and commits it, instead of
  // reading state back out of a setOrders updater. React only runs that updater
  // synchronously when the component has no other update already pending, so a
  // caller that set any other state first — handlePrintVendorInvoice raises its
  // spinner and clears the error banner before marking the bill printed — got
  // null back, and updateOrderByKeyAndSave then returned WITHOUT saving. That is
  // how "printed" lived in memory only, was wiped by the next cycle's
  // loadOrders(), and had ghost mode reprint the same Transbec bills every half
  // hour (CB7170 came out six times). Same reasoning as the note on ordersRef.
  function updateOrderByKey(key, patch) {
    if (!key) return null;
    const prev = ordersRef.current || [];
    if (isOrderSageLocked(prev.find((o) => orderKeyMatches(o, key)))) {
      // The order is in the hands of the Sage pipeline. Anything typed here now
      // would be written back on the next save and could revert the result the
      // processing machine is about to report — the card is blurred for exactly
      // this reason, so just drop the edit.
      console.warn("[orders] edit ignored — order is locked by Sage", key);
      return null;
    }
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
        // WHICH fields the user changed, not just that the order changed.
        // Tracking this per field is what lets two machines edit different
        // fields of the same order without either silently losing the
        // other's work — see the external merge below and
        // mergeOrdersForWrite. Accumulates until the order is saved.
        _dirtyFields: mergeDirtyFields(o._dirtyFields, patchVal),
      };
    });
    // Nothing matched the key: hand back the list untouched rather than a new
    // array, so no render is scheduled and the caller still saves a coherent list.
    if (!changed) return prev;
    commitOrders(next);
    setOrdersDirty(true);
    return next;
  }
  // `_dirtyFields` rides along on the wire so main can tell a real edit from a
  // stale value this window merely happened to be holding. It is stripped in
  // mergeOrdersForWrite and so never reaches orders.json; `_localDirty` is
  // renderer-only and is stripped here.
  function normalizeOrdersForSave(list) {
    return (list || []).map((o) => {
      const invFilled = Boolean((o?.source_invoice || "").trim());
      const { _localDirty, ...rest } = o || {};
      return { ...rest, hasInvoiceNum: invFilled };
    });
  }
  // Drop the edit-tracking marks once a save has been accepted, so the next
  // external update doesn't keep re-protecting fields that are already on disk.
  function clearDirtyMarks(list) {
    return (list || []).map((o) => {
      const { _localDirty, _dirtyFields, ...rest } = o || {};
      return rest;
    });
  }
  // Every path that replaces the orders list goes through here. State lands a
  // render later, so the ref is the only copy something running right now can
  // read: a save built moments after a load, or ghostPrintTargets at the top of
  // the print job, would otherwise still be looking at the previous list.
  function commitOrders(list) {
    const next = Array.isArray(list) ? list : [];
    ordersRef.current = next;
    setOrders(next);
    return next;
  }
  // Take an array that is now believed to match disk, put it in state and make
  // it the clean baseline. Always goes through clearDirtyMarks so a saved edit
  // stops being treated as pending — otherwise the next external update would
  // keep re-applying it over fresher values from another machine.
  function adoptSavedOrders(list) {
    const cleaned = clearDirtyMarks(list);
    commitOrders(cleaned);
    ordersLastSavedRef.current = JSON.stringify(cleaned);
    return cleaned;
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
        // Adopt what main actually wrote (it reconciles against disk), and drop
        // the edit marks now that they're committed.
        adoptSavedOrders(Array.isArray(saveRes.orders) ? saveRes.orders : normalized);
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
  // Sending to Sage is a hand-off, not a field edit: flush whatever is unsaved
  // (the invoice number typed on the card has to be on disk before the AHK run
  // reads it), then let main set the trigger and the lock in one atomic
  // read-modify-write of orders.json. From here until the run reports back the
  // order belongs to Sage — the card blurs and refuses edits.
  async function sendOrderToSage(referenceKey, kind) {
    if (!referenceKey) return;
    setOrdersError(null);
    if (!(await flushPendingOrderEdits())) {
      setOrdersError(FLUSH_FAILED_MSG);
      return;
    }
    try {
      const res = await api?.triggerOrderSage?.(referenceKey, kind);
      if (!res?.ok) {
        setOrdersError(res?.error || "Failed to send the order to Sage.");
      }
    } catch (e) {
      setOrdersError(e?.message || "Failed to send the order to Sage.");
    }
    await loadOrders();
  }

  function handleUpdateInvoiceTrigger(referenceKey) {
    sendOrderToSage(referenceKey, "invoice");
  }

  // Escape hatch for a lock that will never resolve (the Sage machine was shut
  // down mid-run). Clears the trigger too, so releasing cannot leave the order
  // silently queued to be entered later.
  async function handleReleaseSageLock(order) {
    const refKey = order?.reference || order?.__row;
    if (!refKey) return;
    // An order that is merely queued has no lock and nothing running against
    // it — taking it back out is free and reversible, so it does not deserve
    // the "check Sage first" warning that a live lock does.
    const proceed =
      api?.confirm && isOrderSageLocked(order)
        ? await api.confirm(
            `Release ${order.reference || refKey} from Sage?`,
            "Only do this if Sage is NOT currently processing this order — check Sage first. The order will go back to unsent; if it was already entered, mark it entered by hand instead of sending it again."
          )
        : true;
    if (!proceed) return;
    try {
      const res = await api?.releaseOrderSageLock?.(refKey);
      if (!res?.ok) setOrdersError(res?.error || "Failed to release the order.");
    } catch (e) {
      setOrdersError(e?.message || "Failed to release the order.");
    }
    await loadOrders();
  }
  // Take the pickup pin if we don't already hold one. Taking it once and then
  // leaving it alone is the whole point: re-snapshotting on every click would
  // let the card move on the second toggle, and the pin has to cover every
  // order (not just the clicked one) so nothing else shuffles around it either.
  function pinPickupPositions() {
    setPinnedPickup((prev) => {
      if (prev) return prev;
      const snap = new Map();
      (ordersRef.current || []).forEach((o) => {
        snap.set(orderPinKey(o), {
          pickedUp: Boolean(o?.pickedUp),
          inStore: Boolean(o?.inStore),
        });
      });
      return snap;
    });
  }
  // Let the list catch up with reality. Called from an explicit Refresh and
  // from a pickup-filter change — both are the user deliberately asking for a
  // re-scoped list, so holding cards in stale positions there would be wrong.
  function releasePickupPin() {
    setPinnedPickup(null);
  }
  function handleOrdersPickupFilterChange(value) {
    releasePickupPin();
    setOrdersPickupFilter(value);
  }
  function handleOrderCheckboxChange(referenceKey, field, checked) {
    if (field === "inStore") {
      // Marking as arrived should also mark as picked up.
      pinPickupPositions();
      updateOrderByKeyAndSave(referenceKey, { inStore: checked, pickedUp: checked || false });
    } else if (field === "pickedUp") {
      pinPickupPositions();
      updateOrderByKeyAndSave(referenceKey, { [field]: checked });
    } else if (field === "totalVerified" && checked) {
      updateOrderByKey(referenceKey, { [field]: checked, valueCheckAlert: false });
    } else {
      updateOrderByKey(referenceKey, { [field]: checked });
    }
  }
  // Clear the post-Sage value check. The alert means "Sage's total disagreed
  // with the bill at the last run" — which stops being true the moment someone
  // corrects Sage by hand, and nothing reports that back, so this is a normal
  // ending rather than an override. What Sage last reported is deliberately
  // NOT overwritten: sage_total_synced is a record of what came back from a
  // run, and asserting a new value here would fabricate one. Stamped so the
  // archive can still show the gap was waived and by whom.
  function handleClearValueCheck(referenceKey) {
    updateOrderByKey(referenceKey, (order) => {
      const billed = Number(order?.billed_total ?? order?.billedTotal);
      const sage = Number(order?.sage_total_synced ?? order?.sageTotalSynced);
      return {
        valueCheckAlert: false,
        valueCheckClearedAt: new Date().toISOString(),
        valueCheckClearedBy: ownMachineId || "",
        valueCheckClearedDiff:
          Number.isFinite(billed) && Number.isFinite(sage)
            ? Number(Math.abs(billed - sage).toFixed(2))
            : null,
      };
    });
  }

  // Mark Complete ticks every readiness flag at once, and is the escape hatch
  // for "Sage and the bill disagree and I don't want to reconcile it".
  //
  // The gate that actually blocks archiving here is `valueCheckAlert`, NOT
  // totalVerified: the Sage run sets it when |billed_total - sage_total_synced|
  // exceeds 0.1 (main/domain/sage.domain.js), and canArchiveOrder refuses while
  // it stands. totalVerified was never the obstacle — Mark Complete already
  // forced it true. So clearing the alert is what "let me archive it anyway"
  // means, and because that discards a real money check, it is confirmed first.
  //
  // Only this one check is waived. invoiceNeedsSync is left alone, so an order
  // with an unsynced invoice number still can't be waved through.
  async function handleMarkComplete(referenceKey) {
    const normalizedKey = String(referenceKey || "").trim().toUpperCase();
    const order = (orders || []).find((o) => {
      if (!o) return false;
      const cand = (o.sage_reference || o.reference || o.__row || "").toString().trim().toUpperCase();
      return cand && cand === normalizedKey;
    });

    const billedNum = Number(order?.billed_total ?? order?.billedTotal);
    const sageNum = Number(order?.sage_total_synced ?? order?.sageTotalSynced);
    const bothKnown = Number.isFinite(billedNum) && Number.isFinite(sageNum);
    // Prompt on the standing alert, or on a gap the Sage run hasn't judged yet.
    const needsConfirm =
      order?.valueCheckAlert === true || (bothKnown && Math.abs(billedNum - sageNum) > 0.009);

    if (needsConfirm) {
      const money = (n) => `$${n.toFixed(2)}`;
      const figures = bothKnown
        ? `Last synced from Sage: ${money(sageNum)}\nBill: ${money(billedNum)}\n` +
          `Difference: ${money(Math.abs(billedNum - sageNum))}\n\n`
        : "";
      // The figures above are what Sage reported at its LAST run, which is
      // routinely out of date here — the usual reason for saying yes is that
      // Sage has since been corrected by hand, and nothing tells the app that.
      const detail =
        figures +
        `Say OK if Sage is correct now — including when you have already fixed it by hand. ` +
        `That clears the value-check alert and lets this order be archived.\n\n` +
        `The figure above is only what Sage reported at its last run; it is left as-is ` +
        `until the next sync.`;
      const ok = api?.confirm
        ? await api.confirm("Please confirm the sage value matches what's on the bill.", detail)
        : window.confirm(`Please confirm the sage value matches what's on the bill.\n\n${detail}`);
      if (!ok) return;
    }

    updateOrderByKey(referenceKey, (order) => {
      const hasInvoice = Boolean((order?.source_invoice || "").toString().trim());
      return {
        pickedUp: true,
        hasInvoiceNum: true,
        totalVerified: true,
        enteredInSage: true,
        inStore: true,
        // Confirmed above — this is the flag that was blocking the archive.
        valueCheckAlert: false,
        source_invoice: hasInvoice ? order.source_invoice : "manual",
        status: "complete",
      };
    });
  }
  // Adds the order to the Sage purchase queue. This only sets `sage_queued`,
  // which no processor looks at — nothing reaches Sage until "Send to Sage"
  // promotes it to a real trigger.
  function handleOrderSageTrigger(referenceKey) {
    sendOrderToSage(referenceKey, "purchase");
  }

  // Release the whole queue. This machine does not have to be the Sage machine:
  // the promotion writes replicated order data, so whichever machine holds the
  // Sage PO lock sees the triggers arrive and does the typing. Each order it
  // finishes pushes back here, so the counter empties on its own.
  async function handleSendSageQueue() {
    if (sageQueueSending) return;
    setOrdersError(null);
    if (!(await flushPendingOrderEdits())) {
      setOrdersError(FLUSH_FAILED_MSG);
      return;
    }
    setSageQueueSending(true);
    try {
      const res = await api?.sendSageQueue?.();
      if (!res?.ok) {
        setOrdersError(res?.error || "Failed to send the Sage queue.");
      } else if (res.sent > 0 && !sagePoEnabled && !sageLockInfo?.lock?.machineId) {
        // Queued and released, but nobody is holding the Sage PO lock, so no
        // machine will pick them up yet. Say so rather than let the orders sit
        // looking sent.
        setOrdersError(
          `${res.sent} order${res.sent === 1 ? "" : "s"} released to Sage, but no machine is running Sage right now — they will be entered as soon as one turns "Run Sage" on.`
        );
      }
    } catch (e) {
      setOrdersError(e?.message || "Failed to send the Sage queue.");
    } finally {
      setSageQueueSending(false);
    }
    await loadOrders();
  }

  function handleOpenQtyConfirm(refKey) {
    const found = orders.find((o) => orderKeyMatches(o, refKey));
    if (!found) return;
    setQtyConfirmModal({ order: found, refKey });
  }

  // Quantities can only be lowered in the modal, so this always shrinks the
  // billed-vs-line-items gap; saved immediately (like the billed-total edit)
  // rather than left for "Save Changes" since it gates whether the order can
  // go to Sage at all.
  async function handleSaveQtyConfirm(refKey, nextLineItems, nextSageLineItems) {
    const patch = { lineItems: nextLineItems };
    if (nextSageLineItems) patch.sage_lineItems = nextSageLineItems;
    // Correcting the quantities makes any earlier "send it anyway" moot — drop
    // it so the check judges the new numbers on their own merits.
    patch.qtyDiscrepancyAckDiff = null;
    patch.qtyDiscrepancyAckAt = "";
    await updateOrderByKeyAndSave(refKey, patch);
  }

  // "Send to Sage anyway": record the exact gap the user reviewed, so the gate
  // stops blocking THIS discrepancy without going blind to a future one — see
  // qtyDiscrepancyAcknowledged. Needed because a gap where the invoice exceeds
  // the line items (environmental fee, core charge, freight) can't be closed by
  // lowering quantities, and without an override such an order could never
  // reach Sage at all.
  async function handleAcknowledgeQtyDiscrepancy(refKey, diff) {
    await updateOrderByKeyAndSave(refKey, {
      qtyDiscrepancyAckDiff: Number(diff),
      qtyDiscrepancyAckAt: new Date().toISOString(),
    });
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
      // Do NOT skip the whole push just because something on the page is
      // unsaved — that is how this window used to end up holding a copy of an
      // order that was already entered in Sage, and offering to send it again.
      //
      // Merge per FIELD, not per order. Keeping the whole locally-edited order
      // meant that if another machine changed the same order, its change was
      // invisible here until a refresh — and then quietly overwritten on the
      // next save. Two people editing different fields of one order is not
      // actually a conflict, so take the incoming (disk) copy as the base and
      // re-apply only the fields this user actually touched.
      console.log("[orders] external update merged (local edits present)");
      const localDirty = new Map();
      (ordersRef.current || []).forEach((o) => {
        if (!o?._localDirty) return;
        const key = (o.reference || o.__row || "").toString().trim().toUpperCase();
        if (key) localDirty.set(key, o);
      });
      commitOrders(
        !localDirty.size
          ? normalized
          : normalized.map((o) => {
              const key = (o?.reference || o?.__row || "").toString().trim().toUpperCase();
              const mine = key ? localDirty.get(key) : null;
              // An order the Sage pipeline has claimed always comes from disk,
              // even if this window has unsaved changes to it — main would
              // refuse them anyway, so showing them would be a lie.
              if (!mine || isOrderSageLocked(o)) return o;
              const fields = Array.isArray(mine._dirtyFields) ? mine._dirtyFields : null;
              // No field list (an edit made before this tracking existed): fall
              // back to the old whole-order behaviour rather than dropping the edit.
              if (!fields) return mine;
              const merged = { ...o, _localDirty: true, _dirtyFields: fields };
              fields.forEach((f) => {
                merged[f] = mine[f];
              });
              return merged;
            })
      );
      setOrdersInitialized(true);
      return;
    }
    adoptSavedOrders(normalized);
    setOrdersInitialized(true);
    setOrdersDirty(false);
  }

  async function handleSaveOrders() {
    if (!ordersDirty || ordersSaving) return;
    try {
      setOrdersSaving(true);
      setOrdersError(null);
      const normalized = normalizeOrdersForSave(ordersRef.current || []);
      const res = await api?.writeOrders?.(normalized);
      if (!res?.ok) {
        throw new Error("Failed to save orders.");
      }
      // Main reconciles the save against disk and hands back what it actually
      // wrote, so adopt that rather than our own array: any order it refused to
      // change (locked by Sage, or where our Sage fields were stale) is already
      // corrected in there.
      adoptSavedOrders(Array.isArray(res.orders) ? res.orders : normalized);
      setOrdersDirty(false);
      // Pressing Save (toolbar or card) is a "done clicking" signal, so let the
      // list re-sort. Only on success — a failed save leaves the cards where
      // they are, since nothing has been committed to sort by.
      setPinnedPickup(null);
      if (res.blocked?.length) {
        setOrdersError(
          `Skipped ${res.blocked.length} order(s) currently being processed in Sage: ${res.blocked.join(", ")}.`
        );
      }
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
      await loadRecentArchivedOrders();
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
      await loadRecentArchivedOrders();
    } catch (e) {
      setOrdersError(e?.message || "Failed to archive order.");
    }
  }

  // The individual "Archive Order" button — archives straight away, no
  // confirmation popup. "Archive All" (below) still confirms per order since
  // that's a bulk action archiving several orders at once unattended.
  async function handleArchiveOrderWithConfirm(order) {
    if (!order) return;
    const refKey = order.reference || order.__row;
    if (!refKey) return;
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
      const normalized = normalizeOrdersForSave(ordersRef.current || []);
      const res = await api.writeOrders(normalized);
      if (!res?.ok) return false;
      adoptSavedOrders(Array.isArray(res.orders) ? res.orders : normalized);
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
      commitOrders(list);
      ordersLastSavedRef.current = JSON.stringify(list);
      setOrdersDirty(false);
      setOrdersInitialized(true);
      if (res.path) setOrdersSourcePath(res.path);
      setWorldOrdersStatus(fetchStatusLine("world", res));
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
      commitOrders(list);
      ordersLastSavedRef.current = JSON.stringify(list);
      setOrdersDirty(false);
      setOrdersInitialized(true);
      if (res.path) setOrdersSourcePath(res.path);
      setCbkOrdersStatus(fetchStatusLine("cbk", res));
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
      commitOrders(list);
      ordersLastSavedRef.current = JSON.stringify(list);
      setOrdersDirty(false);
      setOrdersInitialized(true);
      if (res.path) setOrdersSourcePath(res.path);
      setTigerOrdersStatus(fetchStatusLine("tiger", res));
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
      commitOrders(list);
      ordersLastSavedRef.current = JSON.stringify(list);
      setOrdersDirty(false);
      setOrdersInitialized(true);
      if (res.path) setOrdersSourcePath(res.path);
      setBestBuyOrdersStatus(fetchStatusLine("bestbuy", res));
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
      commitOrders(list);
      ordersLastSavedRef.current = JSON.stringify(list);
      setOrdersDirty(false);
      setOrdersInitialized(true);
      if (res.path) setOrdersSourcePath(res.path);
      setTransbecOrdersStatus(fetchStatusLine("transbec", res));
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
      commitOrders(list);
      ordersLastSavedRef.current = JSON.stringify(list);
      setOrdersDirty(false);
      setOrdersInitialized(true);
      if (res.path) setOrdersSourcePath(res.path);
      setProforceStatus(fetchStatusLine("proforce", res));
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
      case "world-po":
        setWorldPoStatus("");
        setWorldPoError("");
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
      case "get-all":
        setGetAllOrdersError("");
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
      case "world":
        setWorldStatus("");
        setWorldError("");
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
      case "proforce":
        setProforceCreditStatus("");
        setProforceCreditError("");
        break;
      default:
        break;
    }
  }

  // Permanently remove an order from orders.json (no archive/manifest). Used to
  // clean up throwaway orders created from a vendor scan. Returns {ok,error} for
  // the caller's UI.
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

  // Order Management's "Delete Order" button, shown only on scan-generated
  // orders. Permanent and unarchived, so it confirms first.
  async function handleDeleteScanOrder(order) {
    const refKey = order?.reference || order?.__row;
    if (!refKey) return { ok: false, error: "Order has no reference." };
    const ok = window.confirm(
      `Permanently remove order ${refKey}? It is not archived and no invoice manifest row is written.`
    );
    if (!ok) return { ok: false, error: "" };
    const res = await handleDeleteOrder(refKey, order?.source);
    if (!res.ok && res.error) setWorldError(res.error);
    return res;
  }
  // Compare a credit line's part against a requisition part. Same normalization
  // the stock reconciliation uses (uppercase, single-spaced) so "matched" here
  // means the same thing it will mean when the credit is archived.
  const normalizePartKey = (v) => String(v || "").trim().toUpperCase().replace(/\s+/g, " ");
  // Date fields for a credit order, from whatever the memo printed.
  //
  // A credit MUST be posted in Sage under the date it was issued, not the day
  // it happened to be entered. enterSagePurchases.ahk reads sageDate first (it
  // is already ddmmyy and needs no parsing), then `date`, then orderDate — and
  // when all three are missing it falls back to A_DD/A_MM/A_YYYY, i.e. today.
  // Credit orders are built by hand here and carried no date at all, which is
  // how Transbec 01HW9352 (Jul 15) / 01IA3146 (Jul 31) and World 02KQ8236
  // (Aug 10) all posted on Aug 11. BestBuy was never affected because its
  // credits patch an order that already came from the order scrape with dates.
  //
  // Accepts ISO "YYYY-MM-DD" (Transbec's parser) or "MM/DD/YY" (World's
  // "Credit Memo DATE" column, as printed). Returns {} when nothing parses, so
  // a credit with an unreadable date is left dateless rather than being given
  // a wrong one — the AHK's today-fallback is bad, but a silently invented
  // date is worse.
  function creditOrderDateFields(raw) {
    const s = String(raw || "").trim();
    if (!s) return {};
    let y;
    let m;
    let d;
    const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
    if (iso) {
      y = Number(iso[1]);
      m = Number(iso[2]);
      d = Number(iso[3]);
    } else if (us) {
      m = Number(us[1]);
      d = Number(us[2]);
      y = Number(us[3]);
      if (y < 100) y += 2000;
      // Only reading that is possible if the first field is > 12.
      if (m > 12 && d <= 12) {
        const swap = m;
        m = d;
        d = swap;
      }
    } else {
      return {};
    }
    if (!(y > 1990 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return {};
    const p2 = (n) => String(n).padStart(2, "0");
    return {
      // Noon UTC, not midnight: a midnight timestamp renders as the previous
      // day in any negative-offset timezone, which is exactly where this runs.
      orderDate: new Date(Date.UTC(y, m - 1, d, 12, 0, 0)).toISOString(),
      orderDateRaw: `${p2(m)}/${p2(d)}/${y}`,
      // ddmmyy — the form the AHK types straight into Sage.
      sageDate: `${p2(d)}${p2(m)}${String(y).slice(-2)}`,
    };
  }

  // The codes a credit line may be sitting under in the RETURNS bubble, best
  // first — the renderer twin of creditLineCodeKeys in main.js, and it must stay
  // in step with it so a badge here means what archiving will actually do.
  //
  // A credit's lineItems are RAW off the vendor's PDF ("WAG" + "ZD1852"), but a
  // Returns item holds the code the CAP rules RESOLVED it to, which for plenty
  // of families is not the raw pair at all: World drops the line code for WAG
  // QC/ZD/MX/PD/SX ("WAG ZD1852" is stocked as "ZD1852"), rewrites LUA -> LUC
  // and BSH wipers -> BOS, and strips dashes for TRK/SPE. Comparing either raw
  // form alone therefore matches one half of a credit and misses the other.
  // Resolution only exists in the main process, so resolvedCode arrives from
  // rules:resolve-lines; the raw pair stays as the fallback for items stocked
  // before the rules existed. See [[cap-code-single-source-resolve]].
  const creditLinePartKeys = (line, resolvedCode) => {
    const keys = [];
    const resolved = normalizePartKey(resolvedCode);
    if (resolved) keys.push(resolved);
    const raw = normalizePartKey(`${line?.partLineCode || ""} ${line?.partNumber || ""}`);
    if (raw && raw !== resolved) keys.push(raw);
    return keys;
  };

  // Ask the main process for the resolved codes of a credit's lines. Best-effort:
  // on failure the modals just fall back to the raw pair, which is what they did
  // before this existed.
  async function loadCreditMatchCapCodes(order) {
    const lines = Array.isArray(order?.lineItems) ? order.lineItems : [];
    setCreditMatchCapCodes([]);
    if (!lines.length || !api?.resolveCapLines) return;
    try {
      const res = await api.resolveCapLines({
        warehouse: order?.warehouse || order?.seller || order?.source || "",
        lines: lines.map((l) => ({
          partLineCode: l?.partLineCode || "",
          partNumber: l?.partNumber || "",
          // capRules branches on the description for NGK (oxygen -> NTK),
          // BSH (wipers -> BOS) and EUR (shoes), so it must go along.
          partDescription: l?.partDescription || l?.description || "",
        })),
      });
      if (res?.ok && Array.isArray(res.codes)) setCreditMatchCapCodes(res.codes);
    } catch (e) {
      console.error("[vendor] failed to resolve CAP codes for credit match", e);
    }
  }

  // Requisitions that are waiting on a credit — the only ones a credit can be
  // matched to, per the Returns Management model.
  // Built from the UNFILTERED items on purpose: returnsView uses the age-filtered
  // list, and a requisition that has been waiting weeks for its credit is exactly
  // what those filters hide — matching must never be shown a short list.
  const waitingCreditSlips = useMemo(
    () =>
      deriveReturnSlips(items, returnSlips, UNSPECIFIED_WAREHOUSE).filter(
        (s) => s.status === "waiting"
      ),
    [items, returnSlips, UNSPECIFIED_WAREHOUSE]
  );

  // Load whatever Transbec credit memos are already cached (no Gmail call) —
  // so a restart still shows prior results.
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
      // Also puts the scan's full statusLog on the console; a failure shows the
      // error on its own rather than a misleading "0 found".
      const line = gmailStatusLine("transbec", res, "credit memo");
      if (!res?.ok) {
        setTransbecCreditLog([]);
        throw new Error(res?.error || "Failed to check for Transbec credits.");
      }
      setTransbecCreditLog([line]);
      const discoveries = Array.isArray(res.discoveries) ? res.discoveries : [];
      setTransbecCredits(discoveries);
      // See handleFetchWorldCredits: returned for the unattended path.
      return discoveries;
    } catch (e) {
      console.error("[vendor] fetch transbec credits failed", e);
      setTransbecCreditError(e?.message || "Failed to check for Transbec credits.");
      return [];
    } finally {
      setTransbecCreditScanning(false);
    }
  }

  // Turn a discovered Transbec credit memo into a new order in Order
  // Management — there is no existing order to patch (unlike BestBuy credits),
  // so this always creates one, keyed by the credit memo number the same way
  // Scan-created orders are keyed by invoice number. Reads the freshest
  // orders from disk since the credits view can be used without Order
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
          // The REAL warehouse, not a "Transbec Credit" label. capRules matches
          // warehouse names exactly (ci() is equality, not substring), so a
          // decorated name resolves nothing and every rewritten Transbec code
          // (TRB BCD1210 -> BCD 1210, the trsToCAP interchange, TK -> UC K...)
          // silently falls through to the raw "<line> <part>" — which then fails
          // to match the RETURNS stock those parts are actually filed under.
          // See [[cap-rules-warehouse-key-mismatch]] for the identical World bug.
          warehouse: "Transbec",
          // Same Sage source code regular (scraped) Transbec orders use
          // (transbecScraper.js) — credit orders are built manually here, so
          // they'd otherwise go into Sage with no source code at all.
          sage_source: "TRA505",
          source_invoice: memoNum,
          sage_reference: memoNum,
          hasInvoiceNum: true,
          // Credit orders have no separate detail-fetch step, same as
          // World/CBK/BestBuy Gmail orders — the credit total IS the detail.
          detailStored: true,
          ...(Number.isFinite(totalNum) ? { billed_total: totalNum } : {}),
          ...(credit.fileName ? { transbecCreditFile: credit.fileName } : {}),
          // The returned parts (qty/price), read straight off the credit memo
          // — same field shape as any other Transbec order's lineItems, so
          // e.g. archiving this order feeds them through the same
          // addOrderLineItemsToNewStock path as a normal order (negative
          // quantities net the returned units out of New Stock).
          lineItems: toTransbecCreditLineItems(credit.lineItems),
          ...(credit.poNumber ? { transbecCreditPoNumber: credit.poNumber } : {}),
          ...(credit.customerNumber ? { transbecCreditCustomerNumber: credit.customerNumber } : {}),
          // Post under the credit memo's own date, not today. Transbec's parser
          // returns ISO "YYYY-MM-DD".
          ...creditOrderDateFields(credit.creditDate),
          lastUpdatedAt: new Date().toISOString(),
        };
        const nextList = normalizeOrdersForSave(base.concat(newOrder));
        const saveRes = await api.writeOrders(nextList);
        if (!saveRes?.ok) throw new Error(saveRes?.error || "Failed to save the new order.");
        if (ordersInitialized) {
          adoptSavedOrders(nextList);
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
  // the credit list.
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

  // The credit memo prints every money value negative, so the parser reads
  // costPrice negative too. A PRICE in Sage is never negative — only the
  // quantity carries the sign — and it matters more here than it looks: a
  // hand-built credit order has no sage_lineItems, so enterSagePurchases.ahk
  // reads THESE items directly, types costPrice as the purchase price, and runs
  // it through its price ladder to set the selling/preferred price on the item
  // record. A negative cost writes negative prices onto the part itself, which
  // outlives the credit. quantity and extended stay negative as printed:
  // quantity x |cost| still gives the negative extension Sage needs.
  // Same convention as toWorldCreditOrderLines.
  function toTransbecCreditLineItems(rawLineItems) {
    return (Array.isArray(rawLineItems) ? rawLineItems : []).map((li) => {
      const costNum = Number(li?.costPriceValue ?? li?.costPrice);
      if (!Number.isFinite(costNum)) return li;
      const costAbs = Math.abs(costNum);
      return { ...li, costPrice: costAbs, costPriceValue: costAbs };
    });
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

  // World credit memos (World Automotive Warehouse, from Gmail) — same shape
  // as the Transbec credit pipeline above: no pre-existing order, purely a
  // discovery list, turned into an order via a per-row "Create order" button.
  async function handleLoadWorldCredits() {
    if (!api?.getWorldCredits) return;
    try {
      setWorldCreditError("");
      const res = await api.getWorldCredits();
      if (!res?.ok) throw new Error(res?.error || "Failed to load World credits.");
      setWorldCredits(Array.isArray(res.credits) ? res.credits : []);
    } catch (e) {
      console.error("[vendor] load world credits failed", e);
      setWorldCreditError(e?.message || "Failed to load World credits.");
    }
  }

  async function handleFetchWorldCredits(fromDate, toDate) {
    if (!api?.fetchWorldCreditInvoices) return;
    try {
      setWorldCreditScanning(true);
      setWorldCreditError("");
      const res = await api.fetchWorldCreditInvoices({ fromDate, toDate });
      const line = gmailStatusLine("world", res, "credit memo");
      if (!res?.ok) {
        setWorldCreditLog([]);
        throw new Error(res?.error || "Failed to check for World credits.");
      }
      setWorldCreditLog([line]);
      const discoveries = Array.isArray(res.discoveries) ? res.discoveries : [];
      setWorldCredits(discoveries);
      // Handed back for the unattended path, which turns each one into an order
      // (see handleFetchAndCreateCreditOrders). setWorldCredits is async, so the
      // caller cannot read them out of state.
      return discoveries;
    } catch (e) {
      console.error("[vendor] fetch world credits failed", e);
      setWorldCreditError(e?.message || "Failed to check for World credits.");
      return [];
    } finally {
      setWorldCreditScanning(false);
    }
  }

  // Turn a discovered World credit memo into a new order in Order Management
  // — there is no existing order to patch (a credit is a return against a
  // past sale, not a new purchase). Sign convention (see [[epicor-credit-scan]]
  // memory, "World credits, when that pipeline eventually gets built, must do
  // the same"): quantity stays negative as printed, costPrice is forced
  // POSITIVE — enterSagePurchases.ahk derives the selling price straight off
  // costPrice via its price ladder, and a negative cost would write negative
  // selling/preferred prices onto the Sage item record. extended and
  // billed_total stay negative so the reconcile/value-check math (which
  // compares magnitudes) and the AHK's purchase-line entry (negative qty x
  // positive unit cost = negative extension) both work out.
  // Returns BOTH arrays the rest of the app expects, because the environmental
  // handling charge has to be carried in two different shapes — the same split
  // renderer/src/utils/environmentalFee.js documents for the typed path:
  //
  //   lineItems[i]      — the PART's own figures, fee recorded as metadata only.
  //   sage_lineItems[i] — fee-INCLUSIVE figures, because enterSagePurchases.ahk
  //                       types costPrice and extended into Sage verbatim and
  //                       knows nothing about EHC.
  //
  // A credit built only `lineItems`, so the AHK's `sage_lineItems || lineItems`
  // fallback handed Sage the fee-EXCLUSIVE cost and the charge was silently
  // dropped (e.g. GKI TF1146 on credit 02KQ8236, EHC 0.60 — parsed correctly,
  // never entered). The fee must NOT be folded into lineItems instead: Order
  // Management's "+ev" editor recomputes from those base figures, so a
  // fee-inclusive lineItem would let the charge be added a second time.
  //
  // Signs: the memo prints the EHC negative on a credit, and the extended column
  // EXCLUDES it (TOTAL MDSE + TOTAL EHC are separate sums that the parser audits
  // independently), so the fee genuinely has to be added on here. ehcExtended is
  // used as printed rather than recomputed as ehcUnit x quantity — quantity is
  // negative on a credit, so multiplying would flip the fee positive.
  function toWorldCreditOrderLines(rawLineItems) {
    // 30.13 + 0.6 lands on 30.729999999999997 in binary floating point and the
    // AHK types whatever it is given, so round computed money back to cents.
    const cents = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
    const lineItems = [];
    const sage_lineItems = [];

    for (const li of Array.isArray(rawLineItems) ? rawLineItems : []) {
      const costAbs = Math.abs(Number(li.costPrice) || 0);
      const extendedVal = Number(li.extended) || 0;
      const ehcUnit = Number(li.ehcUnit) || 0;
      const ehcExtended = Number(li.ehcExtended) || 0;
      const hasFee = ehcExtended !== 0 || ehcUnit !== 0;
      // Per-unit, positive — this is what the "+ev" editor shows and what
      // applyEnvironmentalFee treats a fee as.
      const feePerUnit = hasFee ? Math.abs(ehcUnit) : 0;

      const shared = {
        partLineCode: li.partLineCode || "",
        partNumber: li.partNumber || "",
        partDescription: li.description || "",
        unit: li.unit || "",
        quantity: li.quantity,
        core: Boolean(li.core),
        ehcUnit,
        ehcExtended,
        hasEnvironmentalFee: hasFee,
        environmentalFeeAmount: hasFee ? feePerUnit.toFixed(2) : "",
        originalInvoice: li.originalInvoice || "",
        addedToOutstanding: false,
      };

      lineItems.push({
        ...shared,
        costPrice: costAbs,
        costPriceValue: costAbs,
        extended: extendedVal,
        extendedValue: extendedVal,
      });

      // Cost is positive (the price ladder reads it); the fee raises it. Extended
      // is negative and the fee — also negative — makes it more so.
      const sageCost = cents(costAbs + feePerUnit);
      const sageExtended = cents(extendedVal + ehcExtended);
      sage_lineItems.push({
        ...shared,
        costPrice: sageCost,
        costPriceValue: sageCost,
        extended: sageExtended,
        extendedValue: sageExtended,
      });
    }

    return { lineItems, sage_lineItems };
  }

  async function handleCreateOrderFromWorldCredit(credit) {
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
          source: "world",
          isCredit: true,
          reference: refValue,
          __row: refValue,
          // Must match the real scraped value so capRules/the AHK's inline
          // rule fallback resolve the World-specific codes (NGK->NTK, TRK
          // dash-strip, etc.) — see [[cap-code-single-source-resolve]].
          warehouse: "World Automotive Warehouse",
          // Same Sage source code regular (scraped) World orders use
          // (worldScraper.js) — credit orders are built manually here, so
          // they'd otherwise go into Sage with no source code at all.
          sage_source: "WOR505",
          source_invoice: memoNum,
          sage_reference: memoNum,
          hasInvoiceNum: true,
          // Credit orders have no separate detail-fetch step, same as
          // Transbec/CBK/BestBuy Gmail orders — the credit total IS the detail.
          detailStored: true,
          ...(Number.isFinite(totalNum) ? { billed_total: -Math.abs(totalNum) } : {}),
          ...(credit.fileName ? { worldCreditFile: credit.fileName } : {}),
          ...(credit.packingSlip ? { worldCreditPackingSlip: credit.packingSlip } : {}),
          // Post under the credit memo's own date, not today. World's parser
          // reads this off the "Credit Memo DATE" column as "MM/DD/YY".
          ...creditOrderDateFields(credit.creditDate),
          // Both halves: the AHK reads sage_lineItems (fee-inclusive), the rest
          // of the app reads lineItems. See toWorldCreditOrderLines.
          ...toWorldCreditOrderLines(credit.lineItems),
          lastUpdatedAt: new Date().toISOString(),
        };
        const nextList = normalizeOrdersForSave(base.concat(newOrder));
        const saveRes = await api.writeOrders(nextList);
        if (!saveRes?.ok) throw new Error(saveRes?.error || "Failed to save the new order.");
        if (ordersInitialized) {
          adoptSavedOrders(nextList);
          setOrdersDirty(false);
        }
      }

      setWorldCredits((prev) =>
        prev.map((c) => (norm(c.creditMemoNumber) === memoKey ? { ...c, known: true, created: true } : c))
      );
      return { ok: true, duplicate: already };
    } catch (e) {
      console.error("[vendor] create order from world credit failed", e);
      return { ok: false, error: e?.message || "Failed to create order." };
    }
  }

  // Ghost mode's credit errand, twice a day: pull World and Transbec credit
  // memos out of Gmail and turn each new one into an order in Order Management.
  // It deliberately stops there — a credit is never queued to Sage unattended
  // (see shouldFetchCredits), and only Transbec's memo is printed.
  //
  // Both halves are the handlers the Credits view's own buttons call, so there
  // is still one implementation of each. The one thing added here is the
  // `known` check. The per-row "Create order" button is pressed by a person
  // looking at that row, whereas this runs twice a day forever — and the create
  // handlers only compare against ACTIVE orders. `known` is computed in the
  // main process from active orders + the orders archive + every month's
  // invoice manifest, so without it a credit that has already been through Sage
  // and been archived would be rebuilt as a fresh order on every single run.
  async function handleFetchAndCreateCreditOrders() {
    const vendors = [
      { name: "World", fetch: handleFetchWorldCredits, create: handleCreateOrderFromWorldCredit },
      {
        name: "Transbec",
        fetch: handleFetchTransbecCredits,
        create: handleCreateOrderFromTransbecCredit,
      },
    ];
    const summary = [];
    for (const vendor of vendors) {
      let created = 0;
      let failed = 0;
      try {
        const discoveries = (await vendor.fetch()) || [];
        for (const credit of discoveries) {
          if (!credit || credit.known === true || credit.created === true) continue;
          if (!String(credit.creditMemoNumber || "").trim()) continue;
          const res = await vendor.create(credit);
          if (res?.ok) {
            if (!res.duplicate) created += 1;
          } else {
            failed += 1;
            console.warn(
              `[ghost] could not create ${vendor.name} credit order`,
              credit.creditMemoNumber,
              res?.error
            );
          }
        }
        summary.push(
          `${vendor.name} ${discoveries.length} memo(s)/${created} new order(s)` +
            (failed ? `/${failed} failed` : "")
        );
      } catch (e) {
        console.error(`[ghost] ${vendor.name} credit check failed`, e);
        summary.push(`${vendor.name} FAILED (${e?.message || "unknown error"})`);
      }
    }
    return summary.join(", ");
  }

  // Remove the order created from a World credit memo, flipping the row back
  // to "not created" so it can be re-created if needed.
  async function handleRemoveWorldCreditOrder(credit) {
    const memoNum = String(credit?.creditMemoNumber || "").trim();
    if (!memoNum) return { ok: false, error: "This credit memo has no number." };
    const res = await handleDeleteOrder(memoNum, "world");
    if (!res.ok) return res;
    const norm = (v) => (v ? String(v).trim().toUpperCase() : "");
    const memoKey = norm(memoNum);
    setWorldCredits((prev) =>
      prev.map((c) => (norm(c.creditMemoNumber) === memoKey ? { ...c, known: false, created: false } : c))
    );
    return { ok: true };
  }

  // Credit memo PDFs share the gmail data dir with regular World invoices, so
  // viewing reuses that same IPC handler by file name.
  async function handleViewWorldCreditImage(fileName) {
    if (!api?.openWorldInvoiceImage || !fileName) return;
    try {
      const res = await api.openWorldInvoiceImage(fileName);
      if (!res?.ok) {
        setWorldCreditError(res?.error || "Failed to open credit memo file.");
      }
    } catch (e) {
      console.error("[vendor] failed to open world credit file", e);
      setWorldCreditError(e?.message || "Failed to open credit memo file.");
    }
  }

  function handleOpenWorldCreditMatch(order) {
    if (!order) return;
    setWorldCreditMatch(order);
    setWorldCreditMatchSlipId(order.returnSlipId || "");
    setWorldCreditMatchError("");
    loadCreditMatchCapCodes(order);
  }

  function handleCloseWorldCreditMatch() {
    setWorldCreditMatch(null);
    setWorldCreditMatchSlipId("");
    setWorldCreditMatchError("");
    setCreditMatchCapCodes([]);
  }

  // Mirrors handleConfirmProforceCreditMatch exactly: the credit is already a
  // real order with real lineItems by the time this runs (parsed positionally
  // off the PDF, arithmetic self-audited) — matching just stamps the chosen
  // slip's identity onto it for traceability, then settles that slip out of
  // Returns Management via the same settleSlipAsCreditReceived every credit
  // flow uses.
  async function handleConfirmWorldCreditMatch() {
    if (!worldCreditMatch || !api?.writeOrders) return;
    const slip = waitingCreditSlips.find((s) => s.id === worldCreditMatchSlipId) || null;
    if (!slip) {
      setWorldCreditMatchError("Pick a requisition to match, or cancel.");
      return;
    }
    setWorldCreditMatchSaving(true);
    setWorldCreditMatchError("");
    try {
      const key = worldCreditMatch.reference;
      const patch = {
        returnSlipId: slip.id,
        returnSlipWarehouse: slip.warehouse || "",
        ...(slip.po ? { returnSlipPo: slip.po } : {}),
        ...(slip.date ? { returnSlipDate: slip.date } : {}),
        lastUpdatedAt: new Date().toISOString(),
      };
      const nextOrders = orders.map((o) =>
        o?.reference === key && o.source === "world" ? { ...o, ...patch } : o
      );
      const normalized = normalizeOrdersForSave(nextOrders);
      const saveRes = await api.writeOrders(normalized);
      if (!saveRes?.ok) throw new Error(saveRes?.error || "Failed to save the matched order.");
      adoptSavedOrders(normalized);
      setOrdersDirty(false);

      const settled = await settleSlipAsCreditReceived(slip.id);
      if (!settled.ok) throw new Error(settled.error || "Failed to settle the requisition slip.");

      handleCloseWorldCreditMatch();
      const slipLabel = slip.po
        ? `PO ${slip.po}`
        : `the requisition (${[slip.warehouse || "Unspecified", slip.date || "no date"].join(" · ")})`;
      alert(`Mark ${slipLabel} as credited, then destroy it — it's settled now.`);
    } catch (e) {
      console.error("[vendor] failed to match world credit to requisition", e);
      setWorldCreditMatchError(e?.message || "Failed to match credit to requisition.");
    } finally {
      setWorldCreditMatchSaving(false);
    }
  }

  function handleOpenTransbecCreditMatch(order) {
    if (!order) return;
    setTransbecCreditMatch(order);
    setTransbecCreditMatchSlipId(order.returnSlipId || "");
    setTransbecCreditMatchError("");
    loadCreditMatchCapCodes(order);
  }

  function handleCloseTransbecCreditMatch() {
    setTransbecCreditMatch(null);
    setTransbecCreditMatchSlipId("");
    setTransbecCreditMatchError("");
    setCreditMatchCapCodes([]);
  }

  // Mirrors handleConfirmWorldCreditMatch. A Transbec credit is likewise already
  // a real order with real lineItems read off the credit memo, so matching only
  // stamps the chosen slip onto it and settles that slip through the same
  // settleSlipAsCreditReceived every credit flow uses.
  async function handleConfirmTransbecCreditMatch() {
    if (!transbecCreditMatch || !api?.writeOrders) return;
    const slip = waitingCreditSlips.find((s) => s.id === transbecCreditMatchSlipId) || null;
    if (!slip) {
      setTransbecCreditMatchError("Pick a requisition to match, or cancel.");
      return;
    }
    setTransbecCreditMatchSaving(true);
    setTransbecCreditMatchError("");
    try {
      const key = transbecCreditMatch.reference;
      const patch = {
        returnSlipId: slip.id,
        returnSlipWarehouse: slip.warehouse || "",
        ...(slip.po ? { returnSlipPo: slip.po } : {}),
        ...(slip.date ? { returnSlipDate: slip.date } : {}),
        lastUpdatedAt: new Date().toISOString(),
      };
      const nextOrders = orders.map((o) =>
        o?.reference === key && o.source === "transbec" ? { ...o, ...patch } : o
      );
      const normalized = normalizeOrdersForSave(nextOrders);
      const saveRes = await api.writeOrders(normalized);
      if (!saveRes?.ok) throw new Error(saveRes?.error || "Failed to save the matched order.");
      adoptSavedOrders(normalized);
      setOrdersDirty(false);

      const settled = await settleSlipAsCreditReceived(slip.id);
      if (!settled.ok) throw new Error(settled.error || "Failed to settle the requisition slip.");

      handleCloseTransbecCreditMatch();
      const slipLabel = slip.po
        ? `PO ${slip.po}`
        : `the requisition (${[slip.warehouse || "Unspecified", slip.date || "no date"].join(" · ")})`;
      alert(`Mark ${slipLabel} as credited, then destroy it — it's settled now.`);
    } catch (e) {
      console.error("[vendor] failed to match transbec credit to requisition", e);
      setTransbecCreditMatchError(e?.message || "Failed to match credit to requisition.");
    } finally {
      setTransbecCreditMatchSaving(false);
    }
  }

  // The Verify modal is shared across every vendor's invoice flow. Each vendor
  // saves its invoice preview in its own folder behind its own IPC channel, so
  // pick the right image field + read/open API from the order.
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
      imageFile: order?.worldInvoiceFile,
      read: api?.readWorldInvoiceImage,
      open: api?.openWorldInvoiceImage,
    };
  }

  async function handleOpenInvoiceReview(order) {
    const { imageFile, read } = invoiceReviewApis(order);
    if (!imageFile) return;
    setInvoiceReviewOrder(order);
    setInvoiceReviewInvoiceDraft(order.source_invoice || "");
    setInvoiceReviewTotalDraft(
      order.billed_total !== null && order.billed_total !== undefined ? String(order.billed_total) : ""
    );
    // Seed editable line items (scan-generated orders). "part" is the code+number
    // shown as one field; on confirm it's stored back into partNumber.
    setInvoiceReviewLinesDraft(
      (Array.isArray(order.lineItems) ? order.lineItems : []).map((li) => ({
        part: `${li.partLineCode || ""} ${li.partNumber || ""}`.trim(),
        quantity: li.quantity ?? "",
        partDescription: li.partDescription || "",
        costPrice: li.costPrice ?? "",
        __orig: li,
      }))
    );
    setInvoiceReviewImageDataUrl("");
    setInvoiceReviewError("");
    setInvoiceReviewLoading(true);
    try {
      const res = await read?.(imageFile);
      if (res?.ok && res.dataUrl) {
        setInvoiceReviewImageDataUrl(res.dataUrl);
      } else {
        setInvoiceReviewError(res?.error || "Failed to load invoice image.");
      }
    } catch (e) {
      setInvoiceReviewError(e?.message || "Failed to load invoice image.");
    } finally {
      setInvoiceReviewLoading(false);
    }
  }

  function handleCloseInvoiceReview() {
    setInvoiceReviewOrder(null);
    setInvoiceReviewImageDataUrl("");
    setInvoiceReviewInvoiceDraft("");
    setInvoiceReviewTotalDraft("");
    setInvoiceReviewLinesDraft([]);
    setInvoiceReviewError("");
  }

  function updateInvoiceReviewLine(idx, field, value) {
    setInvoiceReviewLinesDraft((prev) => prev.map((l, i) => (i === idx ? { ...l, [field]: value } : l)));
  }
  function removeInvoiceReviewLine(idx) {
    setInvoiceReviewLinesDraft((prev) => prev.filter((_, i) => i !== idx));
  }
  function addInvoiceReviewLine() {
    setInvoiceReviewLinesDraft((prev) => prev.concat({ part: "", quantity: "", partDescription: "", costPrice: "" }));
  }

  async function handleConfirmInvoiceReview() {
    if (!invoiceReviewOrder?.reference) return;
    setInvoiceReviewSaving(true);
    setInvoiceReviewError("");
    try {
      const reference = invoiceReviewOrder.reference;
      const nextInvoice = invoiceReviewInvoiceDraft.trim();
      const totalNum = parseFloat(invoiceReviewTotalDraft);
      const nextTotal = Number.isFinite(totalNum) ? Number(totalNum.toFixed(2)) : null;

      // Only scan-generated orders get their line items edited here; other
      // vendors' orders keep whatever line items they already had.
      // `epicorOnly` is a LEGACY data flag: nothing sets it any more (the Epicor
      // portal scrape it came from is gone), but orders created by it may still
      // be sitting in orders.json, so the read stays until they've all aged out.
      const nextLineItems = invoiceReviewOrder.epicorOnly
        ? invoiceReviewLinesDraft
            .map((l) => {
              const part = String(l.part || "").trim();
              // Split "CODE NUMBER" back apart — storing it whole with an empty
              // line code is what made resolveCapCode miss every line-code rule
              // (and emit a leading space). See splitPartCode.
              const { partLineCode, partNumber } = splitPartCode(part);
              // Keep costPrice (raw) and costPriceValue (parsed number) in step:
              // downstream cost math prefers costPriceValue, so writing only the
              // string would let a stale __orig number override an edited price.
              const priceStr = l.costPrice === undefined || l.costPrice === null ? "" : String(l.costPrice).trim();
              const priceNum = parseFloat(priceStr);
              return {
                ...(l.__orig || { addedToOutstanding: false, source: "epicor-ocr" }),
                partLineCode,
                partNumber,
                quantity: l.quantity,
                partDescription: String(l.partDescription || "").trim(),
                ...(priceStr !== ""
                  ? { costPrice: priceStr, costPriceValue: Number.isFinite(priceNum) ? priceNum : null }
                  : {}),
              };
            })
            .filter((li) => String(li.partNumber || "").trim() || String(li.partDescription || "").trim())
        : null;

      // Built synchronously from current orders: the
      // write below has to run against the real patched list, not whatever a
      // deferred setOrders updater may or may not have produced by now.
      const patchedOrders = (ordersRef.current || []).map((o) => {
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
      commitOrders(patchedOrders);
      // Dirty BEFORE attempting the save: if the write fails and the user closes
      // this modal, the corrected values stay protected (Save button live, and
      // external refreshes won't overwrite them) instead of silently vanishing.
      setOrdersDirty(true);

      if (api?.writeOrders) {
        const normalized = normalizeOrdersForSave(patchedOrders);
        const saveRes = await api.writeOrders(normalized);
        if (!saveRes?.ok) throw new Error("Failed to save order. Your corrections are kept on screen — click Save to retry.");
        adoptSavedOrders(normalized);
        setOrdersDirty(false);
      }

      handleCloseInvoiceReview();
    } catch (e) {
      console.error("[vendor] failed to save verified invoice", e);
      setInvoiceReviewError(e?.message || "Failed to save.");
    } finally {
      setInvoiceReviewSaving(false);
    }
  }

  // World now emails machine-readable invoice PDFs (the Epicor portal scrape is
  // gone). Each invoice prints its own order reference, so one run batch-fills
  // every matching World order, not just the one clicked — same shape as the
  // Transbec flow below.
  async function handleFetchWorldInvoices(reference) {
    if (!api?.fetchWorldInvoices) return;
    try {
      setWorldFetching(true);
      setWorldError("");
      setWorldStatus("");
      const res = await api.fetchWorldInvoices({ reference });
      if (!res?.ok) throw new Error(res?.error || "Failed to fetch World invoices.");
      const logMsg = gmailStatusLine("world", res);

      const discoveries = Array.isArray(res.discoveries) ? res.discoveries : [];
      let appliedCount = 0;
      const unmatchedFees = [];

      // Patched list built synchronously from current orders — not inside a
      // setOrders updater, because the save below depends on the result being
      // ready right now.
      const patchedOrders = (ordersRef.current || []).map((o) => {
        if (!o?.reference || (o.source_invoice || "").toString().trim()) return o;
        if (o.source !== "world") return o;
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

        // The invoice prints the environmental handling charge PER LINE ("EHC :
        // 0.21 Ext: 1.26" under the part), so unlike BestBuy — which only gives
        // a whole-invoice EHC and has to prompt for manual entry — we can put the
        // per-unit fee straight onto the matching line. This is the same write
        // the "+ev" box in Order Management performs, via the shared helper, so
        // the Sage cost/extended come out fee-inclusive either way.
        const fees = applyInvoiceEnvironmentalFees(o, found.lineItems);
        if (fees.unmatched.length) {
          unmatchedFees.push(
            `${o.reference}: could not match ${fees.unmatched
              .map((u) => `${u.part} ($${u.feeUnit.toFixed(2)}/ea)`)
              .join(", ")} to a line on the order — add the fee by hand.`
          );
        }

        return {
          ...o,
          source_invoice: found.invoiceNumber,
          sage_reference: found.invoiceNumber,
          hasInvoiceNum: true,
          invoiceNeedsSync,
          ...(Number.isFinite(totalNum) ? { billed_total: totalNum } : {}),
          ...(found.fileName ? { worldInvoiceFile: found.fileName } : {}),
          lineItems: fees.lineItems,
          sage_lineItems: fees.sage_lineItems,
          // Only flag for attention when a charge could NOT be placed; a matched
          // one is already on its line and needs no manual step.
          ...(fees.unmatched.length ? { environmentalFeeAlert: true } : {}),
          lastUpdatedAt: new Date().toISOString(),
          _localDirty: true,
        };
      });

      let saveFailed = false;
      if (appliedCount > 0) {
        // Dirty BEFORE attempting the save — see handleFetchBestbuyInvoices for
        // the full rationale (protects against silent data loss on save failure).
        commitOrders(patchedOrders);
        setOrdersDirty(true);
        if (api?.writeOrders) {
          const normalized = normalizeOrdersForSave(patchedOrders);
          try {
            const saveRes = await api.writeOrders(normalized);
            if (saveRes?.ok) {
              adoptSavedOrders(normalized);
              setOrdersDirty(false);
            } else {
              saveFailed = true;
              console.error("[vendor] failed to auto-save world matches", saveRes);
            }
          } catch (saveErr) {
            saveFailed = true;
            console.error("[vendor] failed to auto-save world matches", saveErr);
          }
        }
      }

      if (saveFailed) {
        setWorldError(
          "Filled invoice data but could not save it to orders.json. It will not survive a page refresh or another fetch until you click Save. Click Save now to retry."
        );
      }
      // Any invoice whose printed figures didn't reconcile is called out in the
      // status log by the scraper, so a bad read is visible rather than silent.
      const appliedMsg =
        appliedCount > 0 ? `Filled invoice/total for ${appliedCount} order(s) in Order Management.` : "";
      setWorldStatus(
        [logMsg, appliedMsg, ...unmatchedFees].filter(Boolean).join("\n") || "Checked Gmail."
      );
    } catch (e) {
      console.error("[vendor] world fetch error", e);
      setWorldError(e?.message || "Failed to fetch World invoices.");
    } finally {
      setWorldFetching(false);
    }
  }

  // ---------------------------------------------------------------------
  // World invoices with NO ORDER BEHIND THEM
  //
  // World sometimes emails an invoice for parts that were never scraped as an
  // order: no conf number on the document, the customer PO in the subject
  // instead ("Invoice for 20605 Cust PO SHADIE"). handleFetchWorldInvoices
  // above can do nothing with one of those — it only fills in orders that
  // already exist — so this check BUILDS the order out of the invoice, which is
  // the only record of the purchase there is. The invoice number becomes the
  // order reference: it is the only identifier such an invoice carries.
  //
  // Runs from the "World PO Inv." button, and unattended three times a day
  // inside ghost mode (see shouldFetchWorldPoInvoices).

  // Line items for an order built from a World invoice. Same two-array split
  // toWorldCreditOrderLines documents — `lineItems` carry the part's own
  // figures with the environmental charge as metadata, `sage_lineItems` carry
  // the fee-INCLUSIVE figures enterSagePurchases.ahk types into Sage — but with
  // a purchase's signs, and with one extra job: cores.
  //
  // Verified against all 73 World invoice PDFs on the share:
  //   * EXT PRICE INCLUDES that line's core charge while TOTAL MDSE excludes it
  //     (02KS1978: a caliper at 72.74 with a 58.50 core prints 131.24). So the
  //     core has to come out of the part's extension and become its own line —
  //     exactly the shape world.actions.js gives a scraped World order,
  //     "CORE <line code>" with a "World Core:" description.
  //   * NET CORE is a UNIT price: sum(core x qty) == TOTAL CORE. The scan
  //     proves that per invoice (auditCoreCharges) before this ever runs, and
  //     refuses to hand over an invoice where it doesn't hold.
  //   * an extension is NOT recomputed as cost x qty. World rounds its per-line
  //     discount its own way (13.87 x 6 prints 83.21, not 83.22, on 02KQ1553),
  //     and the printed figure is the one the invoice's own totals reconcile
  //     against — so the core is SUBTRACTED from it rather than the part
  //     extension being rebuilt from scratch.
  function toWorldInvoiceOrderLines(rawLineItems) {
    // Computed money is rounded back to cents: the AHK types whatever it is
    // given, and 11.88 + 0.21 is 12.090000000000002 in binary floating point.
    const cents = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
    const lineItems = [];
    const sage_lineItems = [];

    for (const li of Array.isArray(rawLineItems) ? rawLineItems : []) {
      const qty = Number(li.quantity) || 0;
      const cost = Number(li.costPrice) || 0;
      const coreUnit = Number(li.core) || 0;
      const printedExtended = Number(li.extended) || 0;
      const partExtended = cents(printedExtended - coreUnit * qty);
      const ehcUnit = Number(li.ehcUnit) || 0;
      const ehcExtended = Number(li.ehcExtended) || 0;
      const hasFee = ehcUnit !== 0 || ehcExtended !== 0;

      const shared = {
        partLineCode: li.partLineCode || "",
        partNumber: li.partNumber || "",
        partDescription: li.description || "",
        unit: li.unit || "",
        quantity: qty,
        core: false,
        ehcUnit,
        ehcExtended,
        hasEnvironmentalFee: hasFee,
        // Per-unit, which is what the "+ev" editor and applyEnvironmentalFee
        // both mean by "fee" — they only coincide with the extension at qty 1.
        environmentalFeeAmount: hasFee ? Math.abs(ehcUnit).toFixed(2) : null,
        addedToOutstanding: false,
      };

      lineItems.push({
        ...shared,
        costPrice: cost,
        costPriceValue: cost,
        extended: partExtended,
        extendedValue: partExtended,
      });

      const sageCost = cents(cost + Math.abs(ehcUnit));
      const sageExtended = cents(partExtended + Math.abs(ehcExtended));
      sage_lineItems.push({
        ...shared,
        costPrice: sageCost,
        costPriceValue: sageCost,
        extended: sageExtended,
        extendedValue: sageExtended,
      });

      if (coreUnit !== 0) {
        const coreExtended = cents(coreUnit * qty);
        const coreLine = {
          partLineCode: `CORE ${li.partLineCode || ""}`.trim(),
          partNumber: li.partNumber || "",
          partDescription: `World Core: ${li.partNumber || ""}`.trim(),
          unit: li.unit || "",
          quantity: qty,
          costPrice: coreUnit,
          costPriceValue: coreUnit,
          extended: coreExtended,
          extendedValue: coreExtended,
          core: true,
          hasEnvironmentalFee: false,
          environmentalFeeAmount: null,
          addedToOutstanding: false,
        };
        lineItems.push(coreLine);
        // A core carries no environmental charge, so both arrays are identical
        // — copied rather than shared so a later edit to one cannot reach into
        // the other.
        sage_lineItems.push({ ...coreLine });
      }
    }

    return { lineItems, sage_lineItems };
  }

  async function handleFetchWorldPoInvoices() {
    if (!api?.fetchWorldPoInvoices) return;
    try {
      setWorldPoFetching(true);
      setWorldPoError("");
      setWorldPoStatus("");
      const res = await api.fetchWorldPoInvoices({});
      if (!res?.ok) throw new Error(res?.error || "Failed to check for World PO invoices.");
      const logMsg = gmailStatusLine("world", res, "PO invoice");
      const discoveries = Array.isArray(res.discoveries) ? res.discoveries : [];

      // Read orders off disk rather than out of this window: the check may have
      // been run as a job for another machine, and a ghost cycle has usually
      // just finished rewriting orders.json.
      const ordersRes = await api?.readOrders?.();
      const currentList = ordersRes?.state || ordersRes || [];
      const base = Array.isArray(currentList) ? currentList : [];
      const norm = (v) => (v ? String(v).trim().toUpperCase() : "");

      const created = [];
      const blocked = [];
      const newOrders = [];

      for (const inv of discoveries) {
        const invNum = String(inv.invoiceNumber || "").trim();
        if (!invNum) continue;

        // Never build an order out of a document that failed its own
        // arithmetic. EVERY figure on this order — including the money typed
        // into Sage — comes from that one parse; there is no scraped order to
        // check it against, so a misread column would go in unnoticed. The scan
        // already says which check failed, and the invoice stays a manual job.
        if (inv.checksOk === false) {
          blocked.push(invNum);
          continue;
        }

        const key = norm(invNum);
        // `known` is computed in the main process and covers active orders, the
        // orders archive and every month's invoice manifest — so an invoice
        // that has already been through Sage and been archived is never rebuilt
        // as a fresh order three times a day. The local checks catch an order
        // this window has but disk-read missed, and one created moments ago in
        // this same run.
        const already =
          inv.known === true ||
          base.some(
            (o) =>
              o &&
              (norm(o.source_invoice) === key ||
                norm(o.invoiceNum) === key ||
                norm(o.reference) === key)
          ) ||
          newOrders.some((o) => norm(o.reference) === key);
        if (already) continue;

        const totalNum = Number(inv.total ?? inv.balanceDue);
        newOrders.push({
          source: "world",
          reference: invNum,
          __row: invNum,
          // Must be the real scraped warehouse string, or capRules never
          // applies World's code rules (NGK->NTK, TRK dash-strip) — see
          // [[cap-code-single-source-resolve]].
          warehouse: WORLD_WAREHOUSE,
          // The Sage source code scraped World orders carry (worldScraper.js).
          // An order built by hand here would otherwise reach Sage with none.
          sage_source: "WOR505",
          source_invoice: invNum,
          sage_reference: invNum,
          hasInvoiceNum: true,
          // There is no detail-fetch step for these: the invoice IS the detail.
          detailStored: true,
          // The invoice is the only figure that exists for this purchase, so it
          // is both the order total and the billed total.
          ...(Number.isFinite(totalNum) ? { total: totalNum, billed_total: totalNum } : {}),
          // Marks the order as one this check built by itself, which is what
          // puts a "Delete Order" button on the card: if the purchase turns out
          // to have been entered into Sage by hand already, it has to be
          // removable, and an order created unattended is the one kind nobody
          // chose to create.
          worldPoCreated: true,
          ...(inv.fileName ? { worldInvoiceFile: inv.fileName } : {}),
          ...(inv.customerPo ? { worldCustomerPo: inv.customerPo } : {}),
          ...(inv.packingSlip ? { worldInvoicePackingSlip: inv.packingSlip } : {}),
          // Post in Sage under the invoice's own date, not the day the scan
          // happened to run — the same trap credits fell into. World prints it
          // as "MM/DD/YY", which creditOrderDateFields (generic despite the
          // name) turns into the ddmmyy the AHK types.
          ...creditOrderDateFields(inv.invoiceDate),
          ...toWorldInvoiceOrderLines(inv.lineItems),
          lastUpdatedAt: new Date().toISOString(),
        });
        created.push(`${invNum}${inv.customerPo ? ` (PO ${inv.customerPo})` : ""}`);
      }

      if (newOrders.length) {
        if (!api?.writeOrders) throw new Error("Saving orders is not available.");
        const nextList = normalizeOrdersForSave(base.concat(newOrders));
        const saveRes = await api.writeOrders(nextList);
        if (!saveRes?.ok) throw new Error(saveRes?.error || "Failed to save the new order(s).");
        if (ordersInitialized) {
          adoptSavedOrders(nextList);
          setOrdersDirty(false);
        }
      }

      const lines = [logMsg];
      lines.push(
        created.length
          ? `Created ${created.length} order(s): ${created.join(", ")}.`
          : "Nothing new to turn into an order."
      );
      if (blocked.length) {
        lines.push(
          `Not created — the invoice did not reconcile with itself, enter it by hand: ${blocked.join(", ")}.`
        );
      }
      // Anything the scan itself refused (a credit that reached this query, an
      // unreadable PDF) belongs in front of the user too.
      (Array.isArray(res.statusLog) ? res.statusLog : [])
        .filter((l) => /Skipped|Could not|did not reconcile/i.test(l))
        .forEach((l) => lines.push(l));
      setWorldPoStatus(lines.filter(Boolean).join("\n"));
    } catch (e) {
      console.error("[vendor] world PO invoice fetch error", e);
      setWorldPoError(e?.message || "Failed to check for World PO invoices.");
    } finally {
      setWorldPoFetching(false);
    }
  }

  async function handleViewWorldInvoiceImage(order) {
    const fileName = typeof order === "string" ? order : order?.worldInvoiceFile;
    if (!api?.openWorldInvoiceImage || !fileName) return;
    try {
      const res = await api.openWorldInvoiceImage(fileName);
      if (!res?.ok) {
        setWorldError(res?.error || "Failed to open invoice PDF.");
      }
    } catch (e) {
      console.error("[vendor] failed to open world invoice PDF", e);
      setWorldError(e?.message || "Failed to open invoice PDF.");
    }
  }

  // Pull invoice data from Gmail and batch-fill every matching Transbec order
  // (not just the one clicked). Reuses the same invoiceNeedsSync / totalVerified
  // logic as manual entry.
  async function handleFetchTransbecInvoices(reference) {
    if (!api?.fetchTransbecInvoices) return;
    try {
      setTransbecFetching(true);
      setTransbecError("");
      setTransbecStatus("");
      const res = await api.fetchTransbecInvoices({ reference });
      if (!res?.ok) throw new Error(res?.error || "Failed to fetch Transbec invoices.");
      const logMsg = gmailStatusLine("transbec", res);

      const discoveries = Array.isArray(res.discoveries) ? res.discoveries : [];
      let appliedCount = 0;

      // Patched list built synchronously from current orders — see
      // handleFetchWorldInvoices for why this must not happen inside a setOrders
      // updater: the save below depends on the result being ready right now.
      const patchedOrders = (ordersRef.current || []).map((o) => {
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

      let saveFailed = false;
      if (appliedCount > 0) {
        // Dirty BEFORE attempting the save — see handleFetchBestbuyInvoices for
        // the full rationale (protects against silent data loss on save failure).
        commitOrders(patchedOrders);
        setOrdersDirty(true);
        if (api?.writeOrders) {
          const normalized = normalizeOrdersForSave(patchedOrders);
          try {
            const saveRes = await api.writeOrders(normalized);
            if (saveRes?.ok) {
              adoptSavedOrders(normalized);
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
      const logMsg = gmailStatusLine("bestbuy", res);
      const discoveries = Array.isArray(res.discoveries) ? res.discoveries : [];

      let creditLogMsg = "";
      let creditDiscoveries = [];
      if (api?.fetchBestbuyCreditInvoices) {
        try {
          const creditRes = await api.fetchBestbuyCreditInvoices({ reference });
          if (creditRes?.ok) {
            creditLogMsg = gmailStatusLine("bestbuy", creditRes, "credit invoice");
            creditDiscoveries = Array.isArray(creditRes.discoveries) ? creditRes.discoveries : [];
          } else {
            console.error("[vendor] bestbuy credit invoice fetch failed", creditRes);
          }
        } catch (creditErr) {
          console.error("[vendor] bestbuy credit invoice fetch error", creditErr);
        }
      }

      let appliedCount = 0;
      let appliedCreditCount = 0;

      // Patched list built synchronously from current orders — see
      // handleFetchWorldInvoices for why this must not happen inside a setOrders
      // updater: the save below depends on the result being ready right now.
      const patchedOrders = (ordersRef.current || []).map((o) => {
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

      let saveFailed = false;
      if (appliedCount > 0 || appliedCreditCount > 0) {
        // Mark dirty the moment the in-memory patch is applied, BEFORE the save
        // below is even attempted. If the save fails (thrown error or {ok:false}
        // — e.g. a transient failure writing orders.json on the network share),
        // this is what keeps the data from being silently lost: it re-enables
        // the Save button for a manual retry, and it stops any later full-orders
        // refresh (the file watcher's push, or another vendor fetch) from
        // overwriting these never-persisted fields with stale disk contents.
        commitOrders(patchedOrders);
        setOrdersDirty(true);
        if (api?.writeOrders) {
          const normalized = normalizeOrdersForSave(patchedOrders);
          try {
            const saveRes = await api.writeOrders(normalized);
            if (saveRes?.ok) {
              adoptSavedOrders(normalized);
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
      const logMsg = gmailStatusLine("cbk", res);

      const discoveries = Array.isArray(res.discoveries) ? res.discoveries : [];
      let appliedCount = 0;

      // Build the patched list synchronously from current state (NOT as a
      // side-effect inside a setState updater) so the disk write below always
      // runs with the real result. This is what makes Gmail-sourced changes
      // persist immediately: the invoice #, total and file are saved to
      // orders.json right away, without waiting for a manual Save.
      const patchedOrders = (ordersRef.current || []).map((o) => {
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
        commitOrders(patchedOrders);
        setOrdersDirty(true);
        if (api?.writeOrders) {
          const normalized = normalizeOrdersForSave(patchedOrders);
          try {
            const saveRes = await api.writeOrders(normalized);
            if (saveRes?.ok) {
              adoptSavedOrders(normalized);
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

  // Proforce: credit memos are the ONLY thing Proforce emails — regular
  // invoices are already fully captured by the portal scrape (proforceScraper.js
  // flags a credit via isCreditFromLineItems at scrape time). So this fetch
  // only attaches the PDF to an order that's already isCredit: true, purely so
  // it can be viewed/printed — mirrors CBK's single-pass fetch/patch/save.
  async function handleFetchProforceCreditInvoices(reference) {
    if (!api?.fetchProforceCreditInvoices) return;
    try {
      setProforceCreditFetching(true);
      setProforceCreditError("");
      setProforceCreditStatus("");
      const res = await api.fetchProforceCreditInvoices({ reference });
      if (!res?.ok) throw new Error(res?.error || "Failed to fetch Proforce credit invoices.");
      const logMsg = gmailStatusLine("proforce", res, "credit invoice");
      const discoveries = Array.isArray(res.discoveries) ? res.discoveries : [];

      let appliedCount = 0;
      const patchedOrders = (ordersRef.current || []).map((o) => {
        if (!o?.reference || o.source !== "proforce" || !o.isCredit) return o;
        // Skip once the credit PDF is already attached (don't overwrite on a re-fetch).
        if (o.proforceCreditFile) return o;
        const keys = [o.reference, o.source_invoice]
          .map((v) => (v ? String(v).trim().toUpperCase() : ""))
          .filter(Boolean);
        const found = discoveries.find(
          (d) => d.invoiceNumber && keys.includes(String(d.invoiceNumber).trim().toUpperCase())
        );
        if (!found || !found.fileName) return o;
        appliedCount += 1;
        return {
          ...o,
          proforceCreditFile: found.fileName,
          lastUpdatedAt: new Date().toISOString(),
          _localDirty: true,
        };
      });

      let saveFailed = false;
      if (appliedCount > 0) {
        commitOrders(patchedOrders);
        setOrdersDirty(true);
        if (api?.writeOrders) {
          const normalized = normalizeOrdersForSave(patchedOrders);
          try {
            const saveRes = await api.writeOrders(normalized);
            if (saveRes?.ok) {
              adoptSavedOrders(normalized);
              setOrdersDirty(false);
            } else {
              saveFailed = true;
              console.error("[vendor] failed to auto-save proforce credit matches", saveRes);
            }
          } catch (saveErr) {
            saveFailed = true;
            console.error("[vendor] failed to auto-save proforce credit matches", saveErr);
          }
        }
      }

      if (saveFailed) {
        setProforceCreditError(
          "Filled invoice data but could not save it to orders.json. It will not survive a page refresh or another fetch until you click Save. Click Save now to retry."
        );
      }
      const appliedMsg = appliedCount > 0 ? `Filled credit invoice for ${appliedCount} order(s).` : "";
      setProforceCreditStatus([logMsg, appliedMsg].filter(Boolean).join("\n") || "Checked Gmail.");
    } catch (e) {
      console.error("[vendor] proforce credit fetch error", e);
      setProforceCreditError(e?.message || "Failed to fetch Proforce credit invoices.");
    } finally {
      setProforceCreditFetching(false);
    }
  }

  async function handleViewProforceCreditInvoiceImage(order) {
    const fileName = typeof order === "string" ? order : order?.proforceCreditFile;
    if (!api?.openProforceInvoiceImage || !fileName) return;
    try {
      const res = await api.openProforceInvoiceImage(fileName);
      if (!res?.ok) {
        setProforceCreditError(res?.error || "Failed to open credit invoice image.");
      }
    } catch (e) {
      console.error("[vendor] failed to open proforce credit invoice image", e);
      setProforceCreditError(e?.message || "Failed to open credit invoice image.");
    }
  }

  function handleOpenProforceCreditMatch(order) {
    if (!order) return;
    setProforceCreditMatch(order);
    setProforceCreditMatchSlipId(order.returnSlipId || "");
    setProforceCreditMatchError("");
    loadCreditMatchCapCodes(order);
  }

  function handleCloseProforceCreditMatch() {
    setProforceCreditMatch(null);
    setProforceCreditMatchSlipId("");
    setProforceCreditMatchError("");
    setCreditMatchCapCodes([]);
  }

  // Unlike a scanned-credit modal (which creates a brand-new order from a
  // scanned OCR "discovery"), a Proforce credit is already a real order with
  // real lineItems by the time this runs — matching just stamps the chosen
  // slip's identity onto it for traceability, then settles that slip out of
  // Returns Management exactly like the scanned-credit flow does (same
  // settleSlipAsCreditReceived — the parts are removed from active stock,
  // recorded as credit_received, no vendor-specific logic needed there).
  async function handleConfirmProforceCreditMatch() {
    if (!proforceCreditMatch || !api?.writeOrders) return;
    const slip = waitingCreditSlips.find((s) => s.id === proforceCreditMatchSlipId) || null;
    if (!slip) {
      setProforceCreditMatchError("Pick a requisition to match, or cancel.");
      return;
    }
    setProforceCreditMatchSaving(true);
    setProforceCreditMatchError("");
    try {
      const key = proforceCreditMatch.reference;
      const patch = {
        returnSlipId: slip.id,
        returnSlipWarehouse: slip.warehouse || "",
        ...(slip.po ? { returnSlipPo: slip.po } : {}),
        ...(slip.date ? { returnSlipDate: slip.date } : {}),
        lastUpdatedAt: new Date().toISOString(),
      };
      const nextOrders = orders.map((o) =>
        o?.reference === key && o.source === "proforce" ? { ...o, ...patch } : o
      );
      const normalized = normalizeOrdersForSave(nextOrders);
      const saveRes = await api.writeOrders(normalized);
      if (!saveRes?.ok) throw new Error(saveRes?.error || "Failed to save the matched order.");
      adoptSavedOrders(normalized);
      setOrdersDirty(false);

      const settled = await settleSlipAsCreditReceived(slip.id);
      if (!settled.ok) throw new Error(settled.error || "Failed to settle the requisition slip.");

      handleCloseProforceCreditMatch();
      // Settling only clears the digital record — there's still a paper copy
      // of the requisition on the board somewhere that this can't touch. Lead
      // with the PO since that's what's actually written on the paper slip.
      const slipLabel = slip.po
        ? `PO ${slip.po}`
        : `the requisition (${[slip.warehouse || "Unspecified", slip.date || "no date"].join(" · ")})`;
      alert(`Mark ${slipLabel} as credited, then destroy it — it's settled now.`);
    } catch (e) {
      console.error("[vendor] failed to match proforce credit to requisition", e);
      setProforceCreditMatchError(e?.message || "Failed to match credit to requisition.");
    } finally {
      setProforceCreditMatchSaving(false);
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
        : vendor === "world"
        ? order?.worldInvoiceFile
        : vendor === "world-credit"
        ? order?.worldCreditFile
        : vendor === "cbk"
        ? order?.cbkInvoiceFile
        : vendor === "bestbuy-credit"
        ? order?.bestbuyCreditFile
        : vendor === "proforce-credit"
        ? order?.proforceCreditFile
        : order?.bestbuyInvoiceFile;
    const setError =
      vendor === "transbec"
        ? setTransbecError
        : vendor === "world" || vendor === "world-credit"
        ? setWorldError
        : vendor === "cbk"
        ? setCbkError
        : vendor === "proforce-credit"
        ? setProforceCreditError
        : setBestbuyError;
    if (!fileName || !api?.printInvoiceSilent || !order?.reference) return;
    const printKey = `${vendor}:${order.reference}`;
    // Transbec/World credit memos print in full — the return stub with the
    // actual "BALANCE DUE" and signature lives on page 2, unlike a regular
    // invoice where page 1 alone is enough. Every other vendor/print stays
    // page-1-only.
    const allPages =
      (vendor === "transbec" && fileName === order?.transbecCreditFile) || vendor === "world-credit";
    const field =
      vendor === "transbec"
        ? "transbecInvoicePrinted"
        : vendor === "world"
        ? "worldInvoicePrinted"
        : vendor === "world-credit"
        ? "worldCreditInvoicePrinted"
        : vendor === "cbk"
        ? "cbkInvoicePrinted"
        : vendor === "bestbuy-credit"
        ? "bestbuyCreditInvoicePrinted"
        : vendor === "proforce-credit"
        ? "proforceCreditInvoicePrinted"
        : "bestbuyInvoicePrinted";
    try {
      setInvoicePrintingRef(printKey);
      setError("");
      // Claimed BEFORE the physical print, not after: this is what a second
      // caller (another ghost cycle once the requester's 10-minute patience
      // for a remote print job runs out and it dispatches a retry, or a
      // person clicking Print Invoice by hand on an order that looks stuck)
      // sees when it decides whether this order still needs printing. Writing
      // the flag only on success left a gap — sometimes close to an hour, see
      // CA4043 — where the order still read as unprinted while a slow/retried
      // print job was in flight, and a second attempt printed it again.
      await updateOrderByKeyAndSave(order.reference, {
        [field]: true,
        [`${field}At`]: new Date().toISOString(),
      });
      const res = await api.printInvoiceSilent(fileName, allPages);
      if (!res?.ok) {
        throw new Error(res?.error || "Failed to print invoice.");
      }
    } catch (e) {
      console.error(`[vendor] failed to print ${vendor} invoice`, e);
      setError(e?.message || "Failed to print invoice.");
      // Release the claim so a failed attempt doesn't leave an invoice that
      // never actually printed permanently marked as printed.
      await updateOrderByKeyAndSave(order.reference, { [field]: false, [`${field}At`]: "" });
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
        if (order.proforceCreditFile && !order.proforceCreditInvoicePrinted) {
          await handlePrintVendorInvoice(order, "proforce-credit");
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

      // The main process just added these parts, so re-read rather than waiting
      // on the push. What comes back is already merged — adopt it as-is.
      adoptPushedItems(await api.readItems());

      if (ordersInitialized) {
        // refresh orders so addedToOutstanding flags are reflected
        const refreshed = await api.readOrders();
        commitOrders(Array.isArray(refreshed) ? refreshed : []);
      }
    } catch (e) {
      console.error("[outstanding] add error", e);
      setOutstandingError(e?.message || "Failed to add outstanding items.");
    } finally {
      setOutstandingRunning(false);
    }
  }

  // Load the item lifecycle log (deletions) whenever the archive search view is
  // opened, so a looked-up part that's no longer in active stock can show what
  // happened to it. Refreshed on each open to catch recent deletions.
  useEffect(() => {
    if (currentView !== "archive-search" || !api?.readItemHistory) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await api.readItemHistory();
        if (!cancelled && res?.ok) setItemHistory(res.history || []);
      } catch (e) {
        console.error("[item-history] load failed", e);
      }
    })();
    return () => { cancelled = true; };
  }, [currentView]);

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

  // Subscribe to orders.json updates pushed from main (the main process owns
  // the file watcher itself) and do one read. This runs on EVERY machine, not
  // only the one with a Sage flow enabled: the machine that sends an order to
  // Sage has to see the result the processing machine writes back, or its copy
  // goes stale and the next save reverts the order to "not entered yet".
  useEffect(() => {
    if (!api?.onOrdersUpdated) return;
    let cancelled = false;
    const offOrdersUpdated = api.onOrdersUpdated((arr) => handleOrdersUpdatedExternally(arr));
    (async () => {
      try {
        const [latest, pathRes] = await Promise.all([api.readOrders?.(), api.getOrdersPath?.()]);
        if (cancelled) return;
        // This push now marks orders as initialized before the view is ever
        // opened, which would skip loadOrders() and leave the path blank.
        if (pathRes?.path) setOrdersSourcePath(pathRes.path);
        handleOrdersUpdatedExternally(latest);
      } catch (e) {
        console.error("[orders] read error", e);
      }
    })();
    return () => {
      cancelled = true;
      offOrdersUpdated?.();
    };
  }, [ordersDirty]);

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

  // ---- Bubble edit locks: removed ----
  //
  // One machine at a time could hold a bubble, via bubble_locks.json, a 3s
  // heartbeat, a 10s staleness window, and a request/grant/deny handshake for
  // taking one off someone. All of it existed to stop two machines editing the
  // same order and losing one of the edits — which cannot happen now: the store
  // merges per field against every machine's op log, and a genuine same-field
  // collision is reported in Conflict Review rather than silently dropped.
  //
  // Note what is NOT being claimed: this never coordinated the PEOPLE, only the
  // data. If "someone else is already picking this order" turns out to be worth
  // showing, it wants presence — who is looking at what, advisory and never
  // blocking — not a lock, and it can be built on the store like anything else.

  useEffect(() => {
    // The credits view needs orders too: matching a credit to an order lists the
    // orders still waiting on an invoice, and that list is derived from `orders`.
    const needsOrders = currentView === "order-management" || currentView === "credits";
    if (needsOrders && !ordersInitialized && !ordersLoading) {
      loadOrders();
    }
  }, [currentView, ordersInitialized, ordersLoading]);

  // Refreshed each time the tab is opened, not just once initially — an
  // archive run on another machine should show up here without this one
  // needing its own archive action to trigger a reload.
  useEffect(() => {
    if (currentView === "order-management") loadRecentArchivedOrders();
  }, [currentView]);

  useEffect(() => {
    // Same test processSageOrdersQueue uses to pick its targets — these are the
    // orders actually on their way into Sage, not the ones still waiting to be
    // released. An already-entered order carrying a stale trigger is not work.
    setSageReadyOrders((orders || []).filter((o) => o && o.sage_trigger && !o.enteredInSage));
  }, [orders]);

  // The waiting room: added to the queue, not yet released by "Send to Sage".
  // An invoice update counts as an ordinary queue entry — it just lives in its
  // own field, since it always applies to an order already entered in Sage and
  // so can never pass the !enteredInSage test the purchase queue uses.
  const sageQueuedCount = useMemo(
    () =>
      (orders || []).filter(
        (o) => o && (o.sage_invoice_queued || (o.sage_queued && !o.enteredInSage))
      ).length,
    [orders]
  );
  // Everything still owed to Sage, whether it is waiting or already running.
  // This is the number on the button, so it climbs as orders are queued and
  // falls one at a time as Sage finishes them.
  const sagePendingCount = useMemo(
    () =>
      (orders || []).filter(
        (o) =>
          o &&
          (o.sage_invoice_queued ||
            o.sage_invoice_trigger ||
            ((o.sage_queued || o.sage_trigger) && !o.enteredInSage))
      ).length,
    [orders]
  );

  // True while THIS machine's own AHK run is actively typing into Sage right
  // now (stage "running") or adjusting totals after ("reconcile") — as opposed
  // to merely holding the Sage PO lock/toggle. "Get All" is allowed to run on
  // the Sage-PO machine, just not while it's mid-keystroke: the vendor
  // scrapers pop Playwright browser windows that can steal OS focus and send
  // World/Transbec/etc. keystrokes into whatever Sage screen AHK is mid-way
  // through typing into.
  const sagePoRunningHere = useMemo(() => {
    const ownId = sageLockInfo?.ownMachineId;
    if (!ownId) return false;
    return (orders || []).some((o) => {
      const lock = o?.sage_lock;
      if (!lock || typeof lock !== "object") return false;
      if (lock.machineId !== ownId) return false;
      if (lock.stage !== "running" && lock.stage !== "reconcile") return false;
      return isOrderSageLocked(o);
    });
  }, [orders, sageLockInfo?.ownMachineId]);

  const anyVendorFetchRunning =
    worldOrdersRunning ||
    cbkOrdersRunning ||
    tigerOrdersRunning ||
    bestBuyOrdersRunning ||
    transbecOrdersRunning ||
    proforceRunning;

  const getAllOrdersDisabledReason = getAllOrdersRunning
    ? ""
    : sagePoRunningHere
      ? "Sage is actively entering a purchase order on this machine right now — wait for it to finish before running every fetcher at once."
      : anyVendorFetchRunning
        ? "A fetch is already in progress."
        : "";

  // Fires every vendor fetch at once rather than one at a time. Safe to run
  // concurrently — each fetch re-reads orders.json right before it writes and
  // merges by order identity (mergeOrdersForWrite), so siblings running at the
  // same time don't stomp each other's results. Blocked only while this
  // machine is itself mid-keystroke in Sage (see sagePoRunningHere above); the
  // Sage-PO machine is otherwise free to use it like any other.
  // `options.skipTiger` is for ghost mode, which pulls Tiger only twice a day
  // (see shouldFetchTigerOrders). The button passes a click event here, which
  // has no such field, so a click always fetches everything.
  async function handleGetAllOrders(options) {
    if (getAllOrdersRunning || anyVendorFetchRunning || sagePoRunningHere) return;
    setGetAllOrdersError("");
    setGetAllOrdersRunning(true);
    try {
      const fetches = [
        handleGetWorldOrders(),
        handleGetTransbecOrders(),
        handleGetBestBuyOrders(),
        handleGetCbkOrders(),
        handleGetProforceOrders(),
      ];
      if (options?.skipTiger !== true) fetches.push(handleGetTigerOrders());
      await Promise.all(fetches);
    } catch (e) {
      setGetAllOrdersError(e?.message || "Failed to fetch all vendor orders.");
    } finally {
      setGetAllOrdersRunning(false);
    }
  }

  // ---- Cross-machine automation -------------------------------------------
  //
  // A machine can be given a role — vendor fetching, printing, Sage entry — and
  // then does that part of the routine for whoever asks. The asking is a job
  // file on the share (main/services/automation.service.js); this side is the
  // half that actually does the work, because the work is these handlers.

  sagePoEnabledRef.current = sagePoEnabled;

  async function refreshAutomationState() {
    try {
      const [rolesRes, machinesRes] = await Promise.all([
        api?.getAutomationRoles?.(),
        api?.listAutomationMachines?.(),
      ]);
      if (rolesRes?.ok) setAutomationRoles(rolesRes.roles || { fetch: "", print: "", sage: "" });
      if (machinesRes?.ok) {
        setAutomationMachines(machinesRes.machines || []);
        if (machinesRes.ownMachineId) setOwnMachineId(machinesRes.ownMachineId);
      }
      return {
        roles: rolesRes?.roles || {},
        machines: machinesRes?.machines || [],
        own: machinesRes?.ownMachineId || rolesRes?.ownMachineId || "",
      };
    } catch (e) {
      console.error("[automation] failed to read roles/machines", e);
      return { roles: {}, machines: [], own: "" };
    }
  }

  useEffect(() => {
    refreshAutomationState();
    const id = setInterval(refreshAutomationState, 20 * 1000);
    return () => clearInterval(id);
  }, []);

  async function setAutomationRole(role, machineId) {
    const res = await api?.setAutomationRoles?.({ [role]: machineId || "" });
    if (res?.ok) setAutomationRoles(res.roles);
    else console.error("[automation] failed to set role", role, res?.error);
    return res;
  }

  // One job, run here. Each branch is the handler its button already calls —
  // that is the whole point of running jobs in the renderer.
  async function executeAutomationJob(kind, payload = {}) {
    if (kind === "fetch-orders") {
      // handleGetAllOrders returns silently when this machine is already busy,
      // which for a job would read as success. Refuse loudly instead so the
      // requester learns nothing was fetched.
      if (getAllOrdersRunning || anyVendorFetchRunning || sagePoRunningHere) {
        throw new Error("This machine is already fetching (or typing into Sage) right now.");
      }
      await handleGetAllOrders({ skipTiger: payload.skipTiger === true });
      return payload.skipTiger === true
        ? "fetched vendor orders (Tiger not due)"
        : "fetched every vendor's orders";
    }
    if (kind === "fetch-invoices") {
      if (payload.world !== false) await handleFetchWorldInvoices();
      // Not part of the every-cycle sweep: this one CREATES orders, so it runs
      // on its own three-a-day schedule (payload.worldPo, set by runGhostCycle).
      if (payload.worldPo === true) await handleFetchWorldPoInvoices();
      if (payload.transbec !== false) await handleFetchTransbecInvoices();
      if (payload.bestbuy === true) await handleFetchBestbuyInvoices();
      // Credit memos are a different errand from invoices — they build their own
      // orders and never reach Sage — so its own summary is reported.
      const credits = payload.credits === true ? await handleFetchAndCreateCreditOrders() : "";
      return (
        `checked Gmail (${[
          "world",
          payload.worldPo === true ? "world PO invoices" : "",
          "transbec",
          payload.bestbuy === true ? "bestbuy" : "",
        ]
          .filter(Boolean)
          .join(", ")})` + (credits ? `; credits: ${credits}` : "")
      );
    }
    if (kind === "print-invoices") {
      // loadOrders() adopts disk wholesale, so any unsaved edit in this window
      // is discarded by it. Flush first: an unsaved "printed" flag thrown away
      // here is a bill that prints again next cycle, and again after that.
      if (!(await flushPendingOrderEdits())) {
        throw new Error(
          "This machine has unsaved order changes it could not save, so nothing was printed (they would have been lost and the bills reprinted next cycle)."
        );
      }
      await loadOrders();
      const targets = ghostPrintTargets(ordersRef.current);
      for (const { order, vendor } of targets) {
        await handlePrintVendorInvoice(order, vendor);
      }
      return targets.length ? `printed ${targets.length} invoice(s)` : "nothing needed printing";
    }
    throw new Error(`Unknown job kind: ${kind}`);
  }
  // Always-current, so the poller below never runs a stale copy of the handlers.
  automationExecRef.current = executeAutomationJob;

  // Work addressed to this machine. A job carries the id of exactly one machine,
  // so there is no claim to race over — only this machine ever picks this up.
  useEffect(() => {
    const id = setInterval(async () => {
      if (automationJobBusyRef.current) return;
      let job = null;
      try {
        const res = await api?.claimableAutomationJobs?.();
        job = res?.ok ? (res.jobs || [])[0] : null;
      } catch (e) {
        return;
      }
      if (!job) return;
      automationJobBusyRef.current = true;
      setAutomationJobBusy(
        `${JOB_LABELS[job.kind] || job.kind} for ${job.requestedBy || "another machine"}...`
      );
      try {
        await api?.updateAutomationJob?.(job.id, { status: "running", startedAt: Date.now() });
        const summary = await automationExecRef.current?.(job.kind, job.payload || {});
        await api?.updateAutomationJob?.(job.id, {
          status: "done",
          finishedAt: Date.now(),
          result: { summary: summary || "done" },
        });
      } catch (e) {
        console.error("[automation] job failed", job.kind, e);
        await api?.updateAutomationJob?.(job.id, {
          status: "failed",
          finishedAt: Date.now(),
          error: (e?.message || "Job failed.").toString().slice(0, 300),
        });
      } finally {
        automationJobBusyRef.current = false;
        setAutomationJobBusy("");
      }
    }, JOB_CLAIM_POLL_MS);
    return () => clearInterval(id);
  }, []);

  // Run one step of the routine wherever its role says it belongs: here, or on
  // another machine via a job. Returns { ok, summary } either way, so the ghost
  // cycle reads the same whether a step ran locally or across the share.
  async function dispatchAutomationStep({ role, kind, payload = {}, label }) {
    const { roles, machines, own } = await refreshAutomationState();
    const target = resolveRoleTarget(roles, role, machines, own);

    if (target.where === "offline") {
      return { ok: false, summary: `skipped ${label} - ${target.machineId} has the job but is offline` };
    }
    if (target.where === "local") {
      try {
        return { ok: true, summary: await executeAutomationJob(kind, payload) };
      } catch (e) {
        return { ok: false, summary: `${label} failed here: ${e?.message || "unknown error"}` };
      }
    }

    const created = await api?.createAutomationJob?.({ kind, payload, assignedTo: target.machineId });
    if (!created?.ok) {
      return { ok: false, summary: `could not hand ${label} to ${target.machineId}: ${created?.error || "unknown error"}` };
    }
    const jobId = created.job.id;
    const deadline = Date.now() + jobTimeoutMs(kind);
    setGhostBusy(`${label} on ${target.machineId}...`);
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, JOB_POLL_MS));
      let job = null;
      try {
        job = (await api?.readAutomationJob?.(jobId))?.job || null;
      } catch (e) {
        job = null;
      }
      if (job && isTerminalJob(job)) {
        api?.deleteAutomationJob?.(jobId);
        return job.status === "done"
          ? { ok: true, summary: `${target.machineId} ${job.result?.summary || "finished"}` }
          : { ok: false, summary: `${target.machineId} failed ${label}: ${job.error || "unknown error"}` };
      }
      if (Date.now() >= deadline) {
        // Mark it failed rather than deleting it: the machine may still be
        // mid-run, and a job that vanishes underneath a worker leaves it
        // writing results into nothing.
        api?.updateAutomationJob?.(jobId, {
          status: "failed",
          finishedAt: Date.now(),
          error: "The machine that asked for this gave up waiting.",
        });
        return { ok: false, summary: `gave up waiting for ${target.machineId} to finish ${label}` };
      }
    }
  }

  // The `sage` role is enforced by the existing PO heartbeat lock rather than by
  // anything new: being given the role makes this machine turn its own "POs On"
  // toggle on, and losing it turns that back off — but only if the role is what
  // switched it on in the first place.
  //
  // It acts once per assignment, tracked by ref, and does NOT re-run when
  // sagePoEnabled changes. That matters: enabling POs can fail (another machine
  // still holds the lock), and its own effect answers a failure by setting
  // sagePoEnabled back to false. Watching that flag here would read the reset as
  // "the role still isn't applied", set it true again, and spin between the two
  // effects for as long as the other machine held the lock.
  useEffect(() => {
    if (!ownMachineId) return;
    const assigned = (automationRoles?.sage || "").trim();
    if (sageRoleAppliedRef.current === assigned) return;
    sageRoleAppliedRef.current = assigned;
    if (assigned === ownMachineId) {
      if (!sagePoEnabledRef.current) {
        sageRoleAutoEnabledRef.current = true;
        setSagePoEnabled(true);
      }
    } else if (assigned && sagePoEnabledRef.current && sageRoleAutoEnabledRef.current) {
      sageRoleAutoEnabledRef.current = false;
      setSagePoEnabled(false);
    }
  }, [automationRoles?.sage, ownMachineId]);

  // ---- Ghost mode ---------------------------------------------------------
  //
  // The current orders straight off the share, without touching React state —
  // for the poll below, which has to see another machine's writes land and must
  // not re-render the whole order list twenty times to do it.
  async function readOrdersFromDisk() {
    const res = await api?.readOrders?.();
    if (Array.isArray(res)) return res;
    return Array.isArray(res?.state) ? res.state : [];
  }

  // One cycle of the routine, in the order a person would click it: Get All,
  // then the World and Transbec "Get Invoice from Gmail" runs (plus BestBuy's,
  // once a day from noon), then the Sage queue — and only once Sage has
  // actually finished entering that queue, the printer. Every step is the
  // handler its button already calls; ghost mode decides WHEN and on WHICH
  // orders, never HOW.
  //
  // It is deliberately not autonomous about Sage: this machine only fills the
  // queue and releases it, and refuses to run at all unless another machine is
  // holding the Sage PO lock to do the typing (see foreignSagePoMachine).
  // `trigger` is "schedule" or "manual" ("Run one now" in Order Management).
  // A manual run is the real cycle, gates and all — a test that skipped the
  // checks would prove nothing about what happens at half past.
  async function runGhostCycle(trigger = "schedule") {
    if (ghostRunningRef.current) return;
    const startedAt = new Date();
    const at =
      startedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) +
      (trigger === "manual" ? " (run now)" : "");

    // Read the lock off disk rather than trusting sageLockInfo: half an hour
    // has passed since the last push, and the Sage machine may have been
    // switched off in between. It may be this machine — with roles, the same
    // computer can hold the Sage role and run ghost mode.
    let sageMachine = "";
    try {
      sageMachine = sagePoMachine(await api?.getSageLock?.());
    } catch (e) {
      console.error("[ghost] failed to read the Sage lock", e);
    }
    if (!sageMachine) {
      setGhostLog(`${at} - skipped: no machine is running Sage purchase orders.`);
      return;
    }
    if (getAllOrdersRunning || anyVendorFetchRunning || printAllRunning || sagePoRunningHere) {
      setGhostLog(`${at} - skipped: this machine was already busy.`);
      return;
    }

    ghostRunningRef.current = true;
    setGhostRunning(true);
    const done = [];
    try {
      // Tiger twice a day (morning + noon), everyone else every cycle. BestBuy
      // emails a day's invoices the following day, so its Gmail check is once a
      // day rather than once every half hour.
      const tigerDue = shouldFetchTigerOrders(startedAt, ghostTigerRunRef.current);
      if (tigerDue) ghostTigerRunRef.current = ghostTigerRunKey(startedAt);
      const bestbuyDue = shouldFetchBestbuyInvoices(startedAt, ghostBestbuyDayRef.current);
      if (bestbuyDue) ghostBestbuyDayRef.current = ghostDayKey(startedAt);
      // World's order-less invoices: morning, noon and mid-afternoon.
      const worldPoDue = shouldFetchWorldPoInvoices(startedAt, ghostWorldPoRunRef.current);
      if (worldPoDue) ghostWorldPoRunRef.current = ghostWorldPoRunKey(startedAt);
      // World + Transbec credit memos: twice a day, same clock as Tiger.
      const creditsDue = shouldFetchCredits(startedAt, ghostCreditsRunRef.current);
      if (creditsDue) ghostCreditsRunRef.current = ghostCreditsRunKey(startedAt);

      // Both of these belong to the `fetch` role — they drive Playwright and
      // Gmail — so they run wherever that role points, here or on another
      // machine. A step that can't run is reported and the cycle carries on:
      // the later steps still have yesterday's orders to work with.
      setGhostBusy("Fetching vendor orders...");
      const fetched = await dispatchAutomationStep({
        role: "fetch",
        kind: "fetch-orders",
        payload: { skipTiger: !tigerDue },
        label: "the vendor fetch",
      });
      done.push(`${fetched.ok ? "Fetch:" : "Fetch FAILED:"} ${fetched.summary}.`);

      setGhostBusy("Checking Gmail for invoices...");
      const invoiced = await dispatchAutomationStep({
        role: "fetch",
        kind: "fetch-invoices",
        payload: {
          world: true,
          worldPo: worldPoDue,
          transbec: true,
          bestbuy: bestbuyDue,
          credits: creditsDue,
        },
        label: "the Gmail invoice check",
      });
      done.push(`${invoiced.ok ? "Gmail:" : "Gmail FAILED:"} ${invoiced.summary}.`);

      // Work from disk, not from whatever this window was holding when the
      // cycle started — the fetches have just rewritten orders.json.
      setGhostBusy("Queueing orders for Sage...");
      await loadOrders();
      const sageTargets = ghostSageQueueTargets(ordersRef.current, {
        taxRate: qtyDiscrepancyTaxRate,
        threshold: qtyDiscrepancyThreshold,
      });
      let queued = 0;
      for (const order of sageTargets) {
        try {
          const res = await api?.triggerOrderSage?.(ghostOrderKey(order), "purchase");
          if (res?.ok) queued += 1;
          else console.warn("[ghost] could not queue", ghostOrderKey(order), res?.error);
        } catch (e) {
          console.error("[ghost] queue failed for", ghostOrderKey(order), e);
        }
      }
      // The invoice-number queue, which is a different queue: these orders are
      // already in Sage and only their reference is being retyped (BestBuy is
      // entered on the order reference before its invoice arrives, so this is
      // how it ends up filed under the real invoice number). Queued here rather
      // than by the loop above because that one refuses anything already
      // entered — see ghostSageInvoiceUpdateTargets.
      const invoiceTargets = ghostSageInvoiceUpdateTargets(ordersRef.current);
      let invoiceQueued = 0;
      for (const order of invoiceTargets) {
        try {
          const res = await api?.triggerOrderSage?.(ghostOrderKey(order), "invoice");
          if (res?.ok) invoiceQueued += 1;
          else console.warn("[ghost] could not queue invoice update", ghostOrderKey(order), res?.error);
        } catch (e) {
          console.error("[ghost] invoice update queue failed for", ghostOrderKey(order), e);
        }
      }

      // Snapshot the waiting room BEFORE releasing it: that is precisely the set
      // "Send to Sage" is about to hand to the Sage machine, and precisely what
      // the printing step below has to wait for. It already counts invoice
      // updates (ghostQueuedKeys reads sage_invoice_queued), so the wait below
      // covers the ones just queued without any change.
      const releasedKeys = ghostQueuedKeys(await readOrdersFromDisk());
      const sentRes = await api?.sendSageQueue?.();
      const sent = Number(sentRes?.sent) || 0;
      done.push(
        `Queued ${queued} order(s)` +
          (invoiceQueued ? ` + ${invoiceQueued} invoice update(s)` : "") +
          `; released ${sent} to ${sageMachine}.` +
          (sentRes?.ok === false ? ` (${sentRes.error || "send failed"})` : "")
      );

      // Nothing prints until Sage is finished. The Sage machine works through
      // the queue one AHK run at a time and reports each order back as entered;
      // this watches orders.json until every released order has come back (or
      // the wait runs out, in which case the bills wait for a later cycle
      // rather than being printed for orders that never reached Sage).
      let sageDrained = true;
      if (releasedKeys.length) {
        const deadline = Date.now() + GHOST_SAGE_WAIT_MS;
        for (;;) {
          const pending = ghostSagePendingCount(await readOrdersFromDisk(), releasedKeys);
          if (!pending) break;
          if (Date.now() >= deadline) {
            sageDrained = false;
            done.push(`Gave up waiting on Sage with ${pending} order(s) still going.`);
            break;
          }
          // The Sage machine being switched off mid-queue is the one case where
          // the remaining orders are never coming back — stop waiting on it now
          // rather than sitting out the deadline.
          if (!sagePoMachine(await api?.getSageLock?.())) {
            sageDrained = false;
            done.push(`${sageMachine} stopped running Sage with ${pending} order(s) left.`);
            break;
          }
          setGhostBusy(`Waiting for Sage to finish ${pending} order(s) on ${sageMachine}...`);
          await new Promise((resolve) => setTimeout(resolve, GHOST_SAGE_POLL_MS));
        }
        if (sageDrained) done.push("Sage finished the queue.");
      }

      if (!sageDrained) {
        done.push("Skipped printing this cycle.");
      } else {
        // Printing goes to whichever machine owns the printer you want the
        // paper to come out of.
        setGhostBusy("Printing invoices...");
        const printed = await dispatchAutomationStep({
          role: "print",
          kind: "print-invoices",
          label: "printing",
        });
        done.push(`${printed.ok ? "Print:" : "Print FAILED:"} ${printed.summary}.`);
      }
    } catch (e) {
      console.error("[ghost] cycle failed", e);
      done.push(`Stopped: ${e?.message || "unknown error"}`);
    } finally {
      ghostRunningRef.current = false;
      setGhostRunning(false);
      setGhostBusy("");
      setGhostLog(`${at} - ${done.join(" ")}`);
    }
  }
  // Always-current, so the once-only interval below never calls a stale copy.
  ghostCycleRef.current = runGhostCycle;

  // The schedule. Ticks every minute and does nothing at all until the wall
  // clock crosses a half hour inside working hours; the enabled flag is re-read
  // from disk at that point rather than polled, so switching ghost mode on in
  // Settings takes effect at the next cycle without a restart.
  useEffect(() => {
    const id = setInterval(async () => {
      const now = new Date();
      const slot = ghostSlotKey(now);
      if (slot === ghostSlotRef.current) return;
      ghostSlotRef.current = slot;
      if (!isWithinGhostHours(now)) return;
      let enabled = false;
      try {
        const res = await api?.getAppConfig?.();
        enabled = res?.ok ? res.config?.ghostMode === true : false;
      } catch (e) {
        console.error("[ghost] failed to read the app config", e);
        return;
      }
      setGhostMode(enabled);
      if (!enabled) return;
      ghostCycleRef.current?.("schedule");
    }, GHOST_TICK_MS);
    return () => clearInterval(id);
  }, []);

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

  const { filteredOrders, filteredOrderSections, orderFilterCounts } = useMemo(() => {
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
      if (looksLikeCredit(order)) return ordersPickupFilter === "credit";
      if (order?._localDirty) return true;
      // Pinned view, so a just-clicked Picked Up / Arrived cannot drop the card
      // out of the filter the user is standing in.
      return matchesOrdersPickupFilter(pinnedOrderView(order, pinnedPickup), ordersPickupFilter);
    });

    const { start: todayStart, end: todayEnd } = todayRangeMs();

    const todayFiltered = ordersTodayOnly
      ? pickupFiltered.filter((order) => isOrderToday(order, todayStart, todayEnd))
      : pickupFiltered;

    // sort by orderDate descending (newest first), fallback to orderDateRaw string
    const byDateDesc = (list) =>
      [...(list || [])].sort((a, b) => {
        const da = new Date(a?.orderDate || a?.orderDateRaw || 0).getTime();
        const db = new Date(b?.orderDate || b?.orderDateRaw || 0).getTime();
        if (Number.isNaN(da) && Number.isNaN(db)) return 0;
        if (Number.isNaN(da)) return 1;
        if (Number.isNaN(db)) return -1;
        return db - da;
      });

    // On the unfiltered "all" view, bucket into sections by arrival progress
    // (see orderPickupSection in OrderManagementView.jsx) so the most urgent
    // orders — nothing done yet — surface at the top, each bucket still
    // newest-first internally. BestBuy orders still waiting on their emailed
    // invoice are pulled out of the pickup-status buckets entirely and shown
    // in their own bucket at the very bottom. Any other pickup filter keeps a
    // single flat sort, since the buckets would collapse to one group anyway.
    // Bucketing reads the pinned view too, so a card clicked to "Arrived" holds
    // its place (and its section header) until the next Refresh.
    let sorted;
    let sections;
    if (ordersPickupFilter === "all") {
      const bucketOf = (order) => {
        if (isWaitingOnInvoice(order)) return "waiting-invoice";
        const view = pinnedOrderView(order, pinnedPickup);
        if (!view.pickedUp) return "not-picked";
        if (!view.inStore) return "not-arrived";
        return "rest";
      };
      const inBucket = (name) => (todayFiltered || []).filter((o) => bucketOf(o) === name);
      sorted = [
        ...byDateDesc(inBucket("not-picked")),
        ...byDateDesc(inBucket("not-arrived")),
        ...byDateDesc(inBucket("rest")),
        ...byDateDesc(inBucket("waiting-invoice")),
      ];
      sections = sorted.map(bucketOf);
    } else {
      sorted = byDateDesc(todayFiltered);
      sections = sorted.map(() => null);
    }

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

    return { filteredOrders: sorted, filteredOrderSections: sections, orderFilterCounts: counts };
  }, [orders, ordersSearch, ordersPickupFilter, ordersTodayOnly, pinnedPickup]);

  // How many cards the pin is currently holding out of place — i.e. their live
  // pickup state no longer matches the position they're sitting in. Drives the
  // "Re-sort list" pill; 0 means the pin is held but nothing has actually moved
  // yet, so there is nothing to tidy and the pill stays hidden.
  const pinnedOutOfPlaceCount = useMemo(() => {
    if (!pinnedPickup) return 0;
    return (orders || []).reduce((n, o) => {
      const pin = pinnedPickup.get(orderPinKey(o));
      if (!pin) return n;
      const moved =
        Boolean(o?.pickedUp) !== pin.pickedUp || Boolean(o?.inStore) !== pin.inStore;
      return moved ? n + 1 : n;
    }, 0);
  }, [orders, pinnedPickup]);

  const hasSearch = ordersSearch.trim().length > 0;

  const viewBadges = {};

  const currentViewMeta = VIEWS.find((v) => v.id === currentView);

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
        ) : currentView === "cash-sale-flow" ? (
          <>
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
                  {/* Whether Send to Sage types the obfuscated grand-total line
                      (e.g. 424-207x80028) into the notes block. Lives here
                      rather than on each sale card because it's a standing
                      preference for how you enter into Sage, not a per-sale
                      decision — and it persists across restarts. Off still tabs
                      past the field, so nothing after it shifts position. */}
                  <label className="flex items-center gap-1.5 text-xs font-medium text-slate-600 whitespace-nowrap">
                    <input
                      type="checkbox"
                      checked={sageGrandTotalLine}
                      onChange={(e) => setSageGrandTotalLine(e.target.checked)}
                    />
                    Grand total line
                  </label>

                  {/* The undo, sat next to the action it reverses. Outlined
                      rather than solid so the forward action stays the obvious
                      one of the two. */}
                  <button
                    onClick={handleReturnAllToCashPad}
                    className="rounded-xl border border-slate-300 bg-white px-4 py-1.5 text-sm font-semibold text-slate-700 shadow-sm hover:bg-slate-50 whitespace-nowrap"
                    title="Empty every cash sale back into CashPad and remove the per-payment bubbles, so the split can be redone"
                  >
                    Send All Back to CashPad
                  </button>
                  {fillCashPadResult && (
                    <span className="text-sm text-emerald-700 font-medium">{fillCashPadResult}</span>
                  )}
              </div>
            </div>
            <CashSalesView
              bubbles={bubblesForView}
              itemsByBubble={itemsByBubbleForView}
              bubbleMeta={bubbleMeta}
              defaultBubbleNames={DEFAULT_BUBBLE_NAMES}
              extraLinesByBubble={printExtraLinesByBubble}
              addBubble={addBubble}
              onUpdateBubbleNotes={updateBubbleNotes}
              onBubbleNotesBlur={handleBubbleNotesBlur}
              onRequestPrint={handleOpenPrint}
              onSetBubbleFlag={handleSetBubbleFlag}
              onUpdateItem={updateItemByKey}
              onArchiveSale={handleArchiveCashSale}
              onSageSalesInvoice={handleSageSalesInvoice}
              onSetInvoiceNumber={handleSetSaleInvoiceNumber}
              payments={payments}
              paymentsLoading={paymentsLoading}
              paymentsError={paymentsError}
              bubblePaymentAssignments={bubblePaymentAssignments}
              onUpdateBubblePayments={handleUpdateBubblePayments}
              onDeletePayment={handleDeletePayment}
              cashPadItems={cashPadItems}
            />
          </>
        ) : currentView === "returns-management" ? (
          <ReturnsManagementView
            unassignedGroups={returnsView.unassignedGroups}
            slips={returnsView.slips}
            warehouses={returnsView.warehouses}
            onCreateSlip={handleCreateReturnSlip}
            onAssignItemToSlip={handleAssignItemToSlip}
            onSetSlipPO={handleSetSlipPO}
            onSetSlipDate={handleSetSlipDate}
            onSetSlipStatus={handleSetSlipStatus}
            onRemoveItemFromSlip={handleRemoveItemFromSlip}
            onCreditReceived={handleCreditReceived}
            onDeleteSlip={handleDeleteReturnSlip}
            onReturnToNewStock={handleReturnItemToNewStock}
          />
        ) : currentView === "order-assignment" ? (
          <OrderAssignmentView />
        ) : currentView === "sales-orders" ? (
          <SalesOrderView
            bubbles={bubblesForView}
            itemsByBubble={itemsByBubbleForView}
            bubbleMeta={bubbleMeta}
            bubbleAccountingPathByName={bubbleAccountingPathByName}
            defaultBubbleNames={DEFAULT_BUBBLE_NAMES}
            extraLinesByBubble={printExtraLinesByBubble}
            onUpdateBubbleNotes={updateBubbleNotes}
            onBubbleNotesBlur={handleBubbleNotesBlur}
            onRequestPrint={handleOpenPrint}
            onSetBubbleFlag={handleSetBubbleFlag}
            onUpdateItem={updateItemByKey}
            // "Send to Cash Pad" folds the order's items into the CashPad
            // staging bubble (allocated_to: "CashPad") that "Auto-fill from
            // CashPad" scans — the order's own bubble identity (name, notes)
            // goes away and its items land in CashPad. This is the ONLY route
            // from an order into the cash-sale side; Cash Sales itself is now
            // strictly for managing payments against what's already there.
            onSendToCashPad={(bubbleId) => handleDeleteBubble(bubbleId, "CashPad")}
            // "Send to Returns" is the same one-way move, pointed at RETURNS —
            // the parts become unassigned returns stock that Returns Management
            // can rake onto a requisition slip, and the order itself is gone.
            onSendToReturns={(bubbleId) => handleDeleteBubble(bubbleId, "RETURNS")}
            // Same ending, reached one part at a time: once the last part has
            // been sent out of an order there is nothing left for the card to
            // describe, so the order goes with it. `destination` is passed as
            // the fallback because the part has already been moved there by the
            // main process — if that write hasn't been pushed back yet, this
            // sends the stale local copy to the same place rather than
            // silently rerouting it to New Stock.
            onRemoveEmptiedOrder={(bubbleId, destination) =>
              handleDeleteBubble(bubbleId, destination)
            }
            // "Delivered and Complete" — the accounting is finished, so the sale
            // takes the same archive route Cash Sales uses (parts filed as sold,
            // bubble removed), just with its own confirm wording.
            onArchiveOrder={handleArchiveCashSale}
            onSageSalesInvoice={handleSageSalesInvoice}
          />
        ) : currentView === "order-management" ? (
          <OrderManagementView
            ordersSourcePath={ordersSourcePath}
            ordersSearch={ordersSearch}
            setOrdersSearch={setOrdersSearch}
            ordersPickupFilter={ordersPickupFilter}
            setOrdersPickupFilter={handleOrdersPickupFilterChange}
            ordersTodayOnly={ordersTodayOnly}
            setOrdersTodayOnly={setOrdersTodayOnly}
            ordersDirty={ordersDirty}
            ordersSaving={ordersSaving}
            ordersLoading={ordersLoading}
            ordersError={ordersError}
            loadOrders={loadOrders}
            handleSaveOrders={handleSaveOrders}
            filteredOrders={filteredOrders}
            filteredOrderSections={filteredOrderSections}
            pinnedOutOfPlaceCount={pinnedOutOfPlaceCount}
            onReleasePickupPin={releasePickupPin}
            orderFilterCounts={orderFilterCounts}
            handleOrderCheckboxChange={handleOrderCheckboxChange}
            handleOrderFieldChange={handleOrderFieldChange}
            onMarkForSage={handleOrderSageTrigger}
            sageQueuedCount={sageQueuedCount}
            sagePendingCount={sagePendingCount}
            onSendSageQueue={handleSendSageQueue}
            sageQueueSending={sageQueueSending}
            onReleaseSageLock={handleReleaseSageLock}
            onMarkComplete={handleMarkComplete}
            onClearValueCheck={handleClearValueCheck}
            onReconcileTotals={handleReconcileTotals}
            onArchiveOrder={handleArchiveOrderWithConfirm}
            recentArchivedOrders={recentArchivedOrders}
            onDeleteOrder={handleDeleteScanOrder}
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
            onGetAllOrders={handleGetAllOrders}
            getAllOrdersRunning={getAllOrdersRunning}
            getAllOrdersError={getAllOrdersError}
            getAllOrdersDisabledReason={getAllOrdersDisabledReason}
            ghostMode={ghostMode}
            ghostBusy={ghostBusy}
            ghostLog={ghostLog}
            ghostRunning={ghostRunning}
            onRunGhostCycleNow={() => runGhostCycle("manual")}
            automationJobBusy={automationJobBusy}
            onClearOrderFetchMessage={clearOrderFetchMessage}
            onClearInvoiceFetchMessage={clearInvoiceFetchMessage}
            onConfirmOrderEdit={(key) => updateOrderByKeyAndSave(key, {})}
            onFetchWorldInvoices={handleFetchWorldInvoices}
            onFetchWorldPoInvoices={handleFetchWorldPoInvoices}
            worldPoFetching={worldPoFetching}
            worldPoStatus={worldPoStatus}
            worldPoError={worldPoError}
            worldFetching={worldFetching}
            worldStatus={worldStatus}
            worldError={worldError}
            onViewWorldInvoiceImage={handleViewWorldInvoiceImage}
            onVerifyWorldInvoice={handleOpenInvoiceReview}
            onPrintWorldInvoice={(order) => handlePrintVendorInvoice(order, "world")}
            onFetchTransbecInvoices={handleFetchTransbecInvoices}
            transbecFetching={transbecFetching}
            transbecStatus={transbecStatus}
            transbecError={transbecError}
            onViewTransbecInvoiceImage={handleViewTransbecInvoiceImage}
            onVerifyTransbecInvoice={handleOpenInvoiceReview}
            onPrintTransbecInvoice={(order) => handlePrintVendorInvoice(order, "transbec")}
            onViewTransbecCreditInvoiceImage={(order) => handleViewTransbecCreditImage(order?.transbecCreditFile)}
            onViewWorldCreditInvoiceImage={(order) => handleViewWorldCreditImage(order?.worldCreditFile)}
            onPrintWorldCreditInvoice={(order) => handlePrintVendorInvoice(order, "world-credit")}
            onMatchWorldCreditToRequisition={handleOpenWorldCreditMatch}
            onMatchTransbecCreditToRequisition={handleOpenTransbecCreditMatch}
            onFetchBestbuyInvoices={handleFetchBestbuyInvoices}
            bestbuyFetching={bestbuyFetching}
            bestbuyStatus={bestbuyStatus}
            bestbuyError={bestbuyError}
            onViewBestbuyInvoiceImage={handleViewBestbuyInvoiceImage}
            onVerifyBestbuyInvoice={handleOpenInvoiceReview}
            onPrintBestbuyInvoice={(order) => handlePrintVendorInvoice(order, "bestbuy")}
            onViewBestbuyCreditInvoiceImage={handleViewBestbuyCreditInvoiceImage}
            onPrintBestbuyCreditInvoice={(order) => handlePrintVendorInvoice(order, "bestbuy-credit")}
            onFetchCbkInvoices={handleFetchCbkInvoices}
            cbkFetching={cbkFetching}
            cbkStatus={cbkStatus}
            cbkError={cbkError}
            onViewCbkInvoiceImage={handleViewCbkInvoiceImage}
            onVerifyCbkInvoice={handleOpenInvoiceReview}
            onPrintCbkInvoice={(order) => handlePrintVendorInvoice(order, "cbk")}
            onFetchProforceCreditInvoices={handleFetchProforceCreditInvoices}
            proforceCreditFetching={proforceCreditFetching}
            proforceCreditStatus={proforceCreditStatus}
            proforceCreditError={proforceCreditError}
            onViewProforceCreditInvoiceImage={handleViewProforceCreditInvoiceImage}
            onPrintProforceCreditInvoice={(order) => handlePrintVendorInvoice(order, "proforce-credit")}
            onMatchProforceCreditToRequisition={handleOpenProforceCreditMatch}
            waitingCreditSlipCount={waitingCreditSlips.length}
            invoicePrintingRef={invoicePrintingRef}
            onPrintAllNotPrinted={handlePrintAllNotPrinted}
            printAllRunning={printAllRunning}
            onArchiveAllNeedsArchive={handleArchiveAllNeedsArchive}
            archiveAllRunning={archiveAllRunning}
            onUpdateInvoiceTrigger={handleUpdateInvoiceTrigger}
            qtyDiscrepancyThreshold={qtyDiscrepancyThreshold}
            qtyDiscrepancyTaxRate={qtyDiscrepancyTaxRate}
            onOpenQtyConfirm={handleOpenQtyConfirm}
          />
        ) : currentView === "credits" ? (
          <CreditsView
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
            worldCredits={worldCredits}
            worldCreditScanning={worldCreditScanning}
            worldCreditError={worldCreditError}
            worldCreditLog={worldCreditLog}
            onFetchWorldCredits={handleFetchWorldCredits}
            onLoadWorldCredits={handleLoadWorldCredits}
            onCreateWorldCreditOrder={handleCreateOrderFromWorldCredit}
            onRemoveWorldCreditOrder={handleRemoveWorldCreditOrder}
            onViewWorldCreditImage={handleViewWorldCreditImage}
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
            itemHistory={itemHistory}
            onMoveItemToBubble={handleMoveArchiveItemToBubble}
            onPurgeOldOrders={() => api.purgeOldOrdersArchive()}
            onAddLineToCashSales={async (order, line, target) => {
              const res = await api.addArchiveLineToCashSales(order, line, target);
              if (res?.ok) {
                try {
                  adoptPushedItems(await api.readItems());
                } catch (e) {
                  console.error("[archive-add] item refresh failed", e);
                }
              }
              return res;
            }}
          />
        ) : currentView === "settings" ? (
          <SettingsView />
        ) : currentView === "sage-runs" ? (
          <SageRunsView currentViewMeta={currentViewMeta} />
        ) : currentView === "rules" ? (
          <RulesView currentViewMeta={currentViewMeta} />
        ) : (
          <PaymentManagementView
            currentViewMeta={currentViewMeta}
            saleNameByPaymentId={saleNameByPaymentId}
          />
        )}
      </div>
      {qtyConfirmModal && (
        <QtyConfirmModal
          order={qtyConfirmModal.order}
          refKey={qtyConfirmModal.refKey}
          taxRate={qtyDiscrepancyTaxRate}
          threshold={qtyDiscrepancyThreshold}
          onSave={handleSaveQtyConfirm}
          onAcknowledge={handleAcknowledgeQtyDiscrepancy}
          onClose={() => setQtyConfirmModal(null)}
        />
      )}
      {printBubble && (
        <div className="fixed inset-0 z-[5000] bg-slate-900/60 flex items-center justify-center px-4">
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-[95vw] p-6 flex flex-col gap-4 max-h-[95vh]">
            <div className="flex items-center justify-between">
              <h2 className="text-xl font-semibold text-slate-800">
                {printMode === "quote" ? "Quotation Preview" : "Sales Order Preview"} -{" "}
                {printBubble.name}
                {printMode !== "quote" && printSalesOrderNumber && (
                  <span className="ml-2 text-base font-bold text-indigo-700">
                    {printSalesOrderNumber}
                  </span>
                )}
              </h2>
              <button
                className="text-slate-500 hover:text-slate-700"
                onClick={handleClosePrint}
              >
                x
              </button>
            </div>
            <p className="text-sm text-slate-500">
              {printMode === "quote"
                ? "Prices are shown taxes in, per part — no Sales Order number is drawn and nothing is marked sold."
                : "Bubble items stay read-only while printing. Use extra lines to add print-only charges or notes."}
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
                onClick={printMode === "quote" ? handleConfirmQuotePrint : handleConfirmPrint}
              >
                {printMode === "quote" ? "Print Quotation" : "Print"}
              </button>
            </div>
            <div className="grid gap-4 lg:grid-cols-[420px,1fr]">
              <div className="max-h-[80vh] overflow-auto space-y-4">
              {printMode === "quote" && (
                <div className="rounded-2xl border border-emerald-200 bg-emerald-50/70 p-4">
                  <div className="text-sm font-semibold text-slate-800">
                    Closing discount (taxes in)
                  </div>
                  <p className="text-xs text-slate-500">
                    For splitting the difference — "$243? make it $240 even." Shown on the quote as
                    Total / Discount / Post-Discount. Applying it takes the money out of each part's
                    margin, never below cost.
                  </p>
                  <div className="mt-3 flex items-center gap-2">
                    <span className="text-sm font-semibold text-slate-600">$</span>
                    <DraftInput
                      type="number"
                      min="0"
                      step="0.01"
                      commitOnEnter
                      value={printQuoteMeta.discount ? String(printQuoteMeta.discount) : ""}
                      onCommit={handleSetQuoteDiscount}
                      placeholder="0.00"
                      disabled={printQuoteMeta.applied}
                      className="w-28 rounded-lg border border-slate-300 px-3 py-2 text-sm text-right disabled:bg-slate-100 disabled:text-slate-400"
                    />
                    <button
                      className="rounded-full border border-emerald-400 bg-white px-3 py-2 text-xs font-semibold text-emerald-700 hover:bg-emerald-50 disabled:opacity-40 disabled:cursor-not-allowed"
                      onClick={handleApplyQuoteDiscount}
                      disabled={printQuoteMeta.applied || !(printQuoteMeta.discount > 0)}
                      title="Drop every priced part in this order proportionally so the Sales Order total matches the discounted quote"
                    >
                      Apply to item prices
                    </button>
                  </div>
                  {printQuoteMeta.applied ? (
                    <p className="mt-2 text-xs font-semibold text-emerald-800">
                      Applied — every priced part dropped by its own share, so the Sales Order lands
                      on the agreed total by itself. This quote still shows the full prices with the
                      discount on its own line; only the Sales Order absorbs it.
                    </p>
                  ) : (
                    <p className="mt-2 text-xs text-slate-500">
                      Printing the quote does not change any prices. Use "Apply to item prices" once
                      the customer accepts — it rewrites the sell price on every part and can only
                      be done once.
                    </p>
                  )}
                </div>
              )}
              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
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
              </div>
              <div
                ref={printPreviewRef}
                className="max-h-[80vh] overflow-auto rounded-2xl border border-slate-200 bg-slate-50 p-4 flex justify-center"
              >
                <InvoicePreview
                  bubbleName={printBubble.name}
                  bubbleNotes={printBubble.notes}
                  items={printMode === "quote" ? printQuoteItems : printItems}
                  extraLines={printExtraLines}
                  generatedDate={printGeneratedAt || new Date()}
                  salesOrderNumber={printSalesOrderNumber}
                  variant={printMode === "quote" ? "quote" : "salesOrder"}
                  discount={printQuoteMeta.discount}
                />
              </div>
            </div>
          </div>
        </div>
      )}
      {proforceCreditMatch && (() => {
        const selectedSlip = waitingCreditSlips.find((s) => s.id === proforceCreditMatchSlipId) || null;
        const slipItems = selectedSlip?.items || [];
        const money = (n) => `$${(Number.isFinite(Number(n)) ? Number(n) : 0).toFixed(2)}`;
        const orderLines = Array.isArray(proforceCreditMatch.lineItems) ? proforceCreditMatch.lineItems : [];
        // Part numbers on each side, so both lists can show whether they line
        // up — same bidirectional check the credit matcher uses.
        const lineKeys = (l, i) => creditLinePartKeys(l, creditMatchCapCodes[i]);
        const orderPartKeys = new Set(orderLines.flatMap(lineKeys));
        const slipKeys = new Set(slipItems.map((it) => normalizePartKey(it.itemcode)).filter(Boolean));
        const lineOnSlip = (l, i) => lineKeys(l, i).some((k) => slipKeys.has(k));
        const unmatchedSlipCount = slipItems.filter(
          (it) => !orderPartKeys.has(normalizePartKey(it.itemcode))
        ).length;
        const unmatchedOrderCount = orderLines.filter((l, i) => !lineOnSlip(l, i)).length;
        return (
          <div className="fixed inset-0 z-[5000] bg-slate-900/60 flex items-center justify-center px-4">
            <div className="bg-white rounded-3xl shadow-2xl w-full max-w-[95vw] p-6 flex flex-col gap-4 max-h-[95vh]">
              <div className="flex items-center justify-between">
                <h2 className="text-xl font-semibold text-slate-800">
                  Match Credit {proforceCreditMatch.reference} to a Return Requisition
                </h2>
                <button className="text-slate-500 hover:text-slate-700" onClick={handleCloseProforceCreditMatch}>
                  x
                </button>
              </div>
              {proforceCreditMatchError && (
                <div className="text-sm text-red-600 whitespace-pre-line">{proforceCreditMatchError}</div>
              )}
              <p className="text-sm text-slate-500">
                This credit is already a real order with its own parts — no scan to correct here.
                Compare it against the requisition on the right before confirming; confirming stamps
                the order with the requisition and closes it out of Returns Management, the same as
                its own "Credit received" button.
              </p>

              <div className="grid gap-4 lg:grid-cols-2 overflow-auto">
                {/* Left: the credit's own parts, read-only. */}
                <div className="flex flex-col gap-2 min-w-0">
                  <div className="flex flex-wrap gap-4 text-sm rounded-2xl border border-indigo-100 bg-indigo-50/40 px-3 py-2">
                    <div>
                      <div className="text-xs uppercase tracking-wide text-slate-400">Credit #</div>
                      <div className="font-bold text-amber-700">{proforceCreditMatch.reference || "—"}</div>
                    </div>
                    {Number.isFinite(Number(proforceCreditMatch.total)) && (
                      <div>
                        <div className="text-xs uppercase tracking-wide text-slate-400">Credit total</div>
                        <div className="font-semibold text-slate-800">{money(proforceCreditMatch.total)}</div>
                      </div>
                    )}
                  </div>
                  <div className="text-sm font-semibold text-slate-700">
                    1 · Credit's parts <span className="font-normal text-slate-400">(read-only, {orderLines.length})</span>
                  </div>
                  {orderLines.length === 0 ? (
                    <p className="text-sm text-slate-500 border rounded-xl px-3 py-2 bg-slate-50">
                      This credit has no line items.
                    </p>
                  ) : (
                    <div className="space-y-1 max-h-[60vh] overflow-auto border rounded-2xl p-2 bg-slate-50/60">
                      {orderLines.map((li, i) => {
                        const onSlip = selectedSlip ? lineOnSlip(li, i) : null;
                        return (
                          <div
                            key={`${li.partNumber || "part"}-${i}`}
                            className={`flex items-center justify-between gap-2 text-xs bg-white border rounded-lg px-2 py-1 ${
                              onSlip === false ? "border-amber-300 bg-amber-50/50" : "border-slate-100"
                            }`}
                          >
                            <span className="font-semibold text-slate-800">
                              {[li.partLineCode, li.partNumber].filter(Boolean).join(" ") || "—"}
                            </span>
                            <span className="text-slate-500 truncate">{li.partDescription || ""}</span>
                            <span className="text-slate-500 whitespace-nowrap">
                              {li.quantity ?? ""} × {money(li.costPriceValue)}
                            </span>
                            {onSlip !== null && (
                              <span
                                className={`px-2 py-0.5 rounded-full border font-semibold whitespace-nowrap ${
                                  onSlip
                                    ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                                    : "bg-amber-100 text-amber-800 border-amber-300"
                                }`}
                                title={
                                  onSlip
                                    ? "This part number is on the requisition"
                                    : "No line on the requisition has this part number"
                                }
                              >
                                {onSlip ? "on requisition" : "not on requisition"}
                              </span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                  {selectedSlip && unmatchedOrderCount > 0 && (
                    <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1">
                      <span className="font-semibold">{unmatchedOrderCount}</span> part(s) on the
                      credit have no matching part number on the requisition.
                    </p>
                  )}
                </div>

                {/* Right: pick a requisition, compare its parts. */}
                <div className="flex flex-col gap-2 min-w-0">
                  <div>
                    <label className="block text-sm font-semibold text-slate-700 mb-1">
                      2 · Match to a return requisition{" "}
                      <span className="font-normal text-slate-400">(waiting on credit, any warehouse)</span>
                    </label>
                    {waitingCreditSlips.length === 0 ? (
                      <p className="text-sm text-slate-500 border rounded-xl px-3 py-2 bg-slate-50">
                        No requisitions are waiting on a credit right now.
                      </p>
                    ) : (
                      <select
                        className="w-full border rounded-xl px-3 py-2 text-sm"
                        value={proforceCreditMatchSlipId}
                        onChange={(e) => setProforceCreditMatchSlipId(e.target.value)}
                      >
                        <option value="">Select a requisition…</option>
                        {waitingCreditSlips.map((s) => (
                          <option key={s.id} value={s.id}>
                            {[
                              s.warehouse || "Unspecified",
                              s.date || "no date",
                              s.po ? `PO ${s.po}` : "no PO",
                              `${s.items.length} part(s)`,
                            ].join(" · ")}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>

                  {selectedSlip ? (
                    <div className="border rounded-2xl p-3 bg-slate-50/60">
                      <div className="text-sm font-semibold text-slate-700 mb-1">
                        Parts on this requisition <span className="font-normal text-slate-400">({slipItems.length})</span>
                      </div>
                      {slipItems.length > 0 && (
                        <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1 mb-2">
                          Confirming marks the requisition as credited:{" "}
                          <span className="font-semibold">{slipItems.length} part(s)</span> will be
                          removed from Returns Management.
                        </p>
                      )}
                      {slipItems.length === 0 && (
                        <p className="text-xs text-slate-500">This requisition has no parts.</p>
                      )}
                      <div className="space-y-1 max-h-[55vh] overflow-auto">
                        {slipItems.map((it) => {
                          const onCredit = orderPartKeys.has(normalizePartKey(it.itemcode));
                          return (
                            <div
                              key={it.uid}
                              className={`flex items-center justify-between gap-2 text-xs bg-white border rounded-lg px-2 py-1 ${
                                onCredit ? "border-slate-100" : "border-amber-300 bg-amber-50/50"
                              }`}
                            >
                              <span className="font-semibold text-slate-800">{it.itemcode || "—"}</span>
                              <span className="text-slate-500 whitespace-nowrap">
                                {Math.max(1, Number(it.quantity) || 1)} × {money(it.cost)}
                              </span>
                              <span
                                className={`px-2 py-0.5 rounded-full border font-semibold whitespace-nowrap ${
                                  onCredit
                                    ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                                    : "bg-amber-100 text-amber-800 border-amber-300"
                                }`}
                                title={
                                  onCredit
                                    ? "This part number is on the credit"
                                    : "No line on the credit has this part number"
                                }
                              >
                                {onCredit ? "on credit" : "not on credit"}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                      {unmatchedSlipCount > 0 && (
                        <p className="text-xs text-amber-700 mt-2">
                          <span className="font-semibold">{unmatchedSlipCount}</span> part(s) on the
                          requisition have no matching part number on the credit — double check this
                          is the right requisition before confirming.
                        </p>
                      )}
                      {unmatchedSlipCount === 0 && unmatchedOrderCount === 0 && slipItems.length > 0 && (
                        <p className="text-xs text-emerald-700 mt-2 font-semibold">
                          Every part number matches both sides.
                        </p>
                      )}
                    </div>
                  ) : (
                    <p className="text-sm text-slate-500 border rounded-xl px-3 py-2 bg-slate-50">
                      Pick a requisition above to compare its parts against the credit.
                    </p>
                  )}
                </div>
              </div>

              <div className="flex justify-end gap-3 border-t pt-4">
                <button
                  className="px-4 py-2 rounded-xl border text-sm"
                  onClick={handleCloseProforceCreditMatch}
                  disabled={proforceCreditMatchSaving}
                >
                  Cancel
                </button>
                <button
                  className="px-4 py-2 rounded-xl bg-emerald-600 text-white text-sm font-semibold disabled:opacity-60"
                  onClick={handleConfirmProforceCreditMatch}
                  disabled={proforceCreditMatchSaving || !selectedSlip}
                  title="Stamp the order with this requisition and close it out of Returns Management"
                >
                  {proforceCreditMatchSaving ? "Matching…" : "Match & close requisition"}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {worldCreditMatch && (() => {
        const selectedSlip = waitingCreditSlips.find((s) => s.id === worldCreditMatchSlipId) || null;
        const slipItems = selectedSlip?.items || [];
        const money = (n) => `$${(Number.isFinite(Number(n)) ? Number(n) : 0).toFixed(2)}`;
        const orderLines = Array.isArray(worldCreditMatch.lineItems) ? worldCreditMatch.lineItems : [];
        const lineKeys = (l, i) => creditLinePartKeys(l, creditMatchCapCodes[i]);
        const orderPartKeys = new Set(orderLines.flatMap(lineKeys));
        const slipKeys = new Set(slipItems.map((it) => normalizePartKey(it.itemcode)).filter(Boolean));
        const lineOnSlip = (l, i) => lineKeys(l, i).some((k) => slipKeys.has(k));
        const unmatchedSlipCount = slipItems.filter(
          (it) => !orderPartKeys.has(normalizePartKey(it.itemcode))
        ).length;
        const unmatchedOrderCount = orderLines.filter((l, i) => !lineOnSlip(l, i)).length;
        return (
          <div className="fixed inset-0 z-[5000] bg-slate-900/60 flex items-center justify-center px-4">
            <div className="bg-white rounded-3xl shadow-2xl w-full max-w-[95vw] p-6 flex flex-col gap-4 max-h-[95vh]">
              <div className="flex items-center justify-between">
                <h2 className="text-xl font-semibold text-slate-800">
                  Match Credit {worldCreditMatch.reference} to a Return Requisition
                </h2>
                <button className="text-slate-500 hover:text-slate-700" onClick={handleCloseWorldCreditMatch}>
                  x
                </button>
              </div>
              {worldCreditMatchError && (
                <div className="text-sm text-red-600 whitespace-pre-line">{worldCreditMatchError}</div>
              )}
              <p className="text-sm text-slate-500">
                This credit is already a real order with its own parts, read straight off the World
                credit memo PDF — no scan to correct here. Compare it against the requisition on the
                right before confirming; confirming stamps the order with the requisition and closes
                it out of Returns Management, the same as its own "Credit received" button.
              </p>

              <div className="grid gap-4 lg:grid-cols-2 overflow-auto">
                {/* Left: the credit's own parts, read-only. */}
                <div className="flex flex-col gap-2 min-w-0">
                  <div className="flex flex-wrap gap-4 text-sm rounded-2xl border border-indigo-100 bg-indigo-50/40 px-3 py-2">
                    <div>
                      <div className="text-xs uppercase tracking-wide text-slate-400">Credit #</div>
                      <div className="font-bold text-amber-700">{worldCreditMatch.reference || "—"}</div>
                    </div>
                    {Number.isFinite(Number(worldCreditMatch.billed_total)) && (
                      <div>
                        <div className="text-xs uppercase tracking-wide text-slate-400">Credit total</div>
                        <div className="font-semibold text-slate-800">{money(worldCreditMatch.billed_total)}</div>
                      </div>
                    )}
                  </div>
                  <div className="text-sm font-semibold text-slate-700">
                    1 · Credit's parts <span className="font-normal text-slate-400">(read-only, {orderLines.length})</span>
                  </div>
                  {orderLines.length === 0 ? (
                    <p className="text-sm text-slate-500 border rounded-xl px-3 py-2 bg-slate-50">
                      This credit has no line items.
                    </p>
                  ) : (
                    <div className="space-y-1 max-h-[60vh] overflow-auto border rounded-2xl p-2 bg-slate-50/60">
                      {orderLines.map((li, i) => {
                        const onSlip = selectedSlip ? lineOnSlip(li, i) : null;
                        return (
                          <div
                            key={`${li.partNumber || "part"}-${i}`}
                            className={`flex items-center justify-between gap-2 text-xs bg-white border rounded-lg px-2 py-1 ${
                              onSlip === false ? "border-amber-300 bg-amber-50/50" : "border-slate-100"
                            }`}
                          >
                            <span className="font-semibold text-slate-800">
                              {[li.partLineCode, li.partNumber].filter(Boolean).join(" ") || "—"}
                            </span>
                            <span className="text-slate-500 truncate">{li.partDescription || ""}</span>
                            <span className="text-slate-500 whitespace-nowrap">
                              {li.quantity ?? ""} × {money(li.costPriceValue)}
                            </span>
                            {onSlip !== null && (
                              <span
                                className={`px-2 py-0.5 rounded-full border font-semibold whitespace-nowrap ${
                                  onSlip
                                    ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                                    : "bg-amber-100 text-amber-800 border-amber-300"
                                }`}
                                title={
                                  onSlip
                                    ? "This part number is on the requisition"
                                    : "No line on the requisition has this part number"
                                }
                              >
                                {onSlip ? "on requisition" : "not on requisition"}
                              </span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                  {selectedSlip && unmatchedOrderCount > 0 && (
                    <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1">
                      <span className="font-semibold">{unmatchedOrderCount}</span> part(s) on the
                      credit have no matching part number on the requisition.
                    </p>
                  )}
                </div>

                {/* Right: pick a requisition, compare its parts. */}
                <div className="flex flex-col gap-2 min-w-0">
                  <div>
                    <label className="block text-sm font-semibold text-slate-700 mb-1">
                      2 · Match to a return requisition{" "}
                      <span className="font-normal text-slate-400">(waiting on credit, any warehouse)</span>
                    </label>
                    {waitingCreditSlips.length === 0 ? (
                      <p className="text-sm text-slate-500 border rounded-xl px-3 py-2 bg-slate-50">
                        No requisitions are waiting on a credit right now.
                      </p>
                    ) : (
                      <select
                        className="w-full border rounded-xl px-3 py-2 text-sm"
                        value={worldCreditMatchSlipId}
                        onChange={(e) => setWorldCreditMatchSlipId(e.target.value)}
                      >
                        <option value="">Select a requisition…</option>
                        {waitingCreditSlips.map((s) => (
                          <option key={s.id} value={s.id}>
                            {[
                              s.warehouse || "Unspecified",
                              s.date || "no date",
                              s.po ? `PO ${s.po}` : "no PO",
                              `${s.items.length} part(s)`,
                            ].join(" · ")}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>

                  {selectedSlip ? (
                    <div className="border rounded-2xl p-3 bg-slate-50/60">
                      <div className="text-sm font-semibold text-slate-700 mb-1">
                        Parts on this requisition <span className="font-normal text-slate-400">({slipItems.length})</span>
                      </div>
                      {slipItems.length > 0 && (
                        <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1 mb-2">
                          Confirming marks the requisition as credited:{" "}
                          <span className="font-semibold">{slipItems.length} part(s)</span> will be
                          removed from Returns Management.
                        </p>
                      )}
                      {slipItems.length === 0 && (
                        <p className="text-xs text-slate-500">This requisition has no parts.</p>
                      )}
                      <div className="space-y-1 max-h-[55vh] overflow-auto">
                        {slipItems.map((it) => {
                          const onCredit = orderPartKeys.has(normalizePartKey(it.itemcode));
                          return (
                            <div
                              key={it.uid}
                              className={`flex items-center justify-between gap-2 text-xs bg-white border rounded-lg px-2 py-1 ${
                                onCredit ? "border-slate-100" : "border-amber-300 bg-amber-50/50"
                              }`}
                            >
                              <span className="font-semibold text-slate-800">{it.itemcode || "—"}</span>
                              <span className="text-slate-500 whitespace-nowrap">
                                {Math.max(1, Number(it.quantity) || 1)} × {money(it.cost)}
                              </span>
                              <span
                                className={`px-2 py-0.5 rounded-full border font-semibold whitespace-nowrap ${
                                  onCredit
                                    ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                                    : "bg-amber-100 text-amber-800 border-amber-300"
                                }`}
                                title={
                                  onCredit
                                    ? "This part number is on the credit"
                                    : "No line on the credit has this part number"
                                }
                              >
                                {onCredit ? "on credit" : "not on credit"}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                      {unmatchedSlipCount > 0 && (
                        <p className="text-xs text-amber-700 mt-2">
                          <span className="font-semibold">{unmatchedSlipCount}</span> part(s) on the
                          requisition have no matching part number on the credit — double check this
                          is the right requisition before confirming.
                        </p>
                      )}
                      {unmatchedSlipCount === 0 && unmatchedOrderCount === 0 && slipItems.length > 0 && (
                        <p className="text-xs text-emerald-700 mt-2 font-semibold">
                          Every part number matches both sides.
                        </p>
                      )}
                    </div>
                  ) : (
                    <p className="text-sm text-slate-500 border rounded-xl px-3 py-2 bg-slate-50">
                      Pick a requisition above to compare its parts against the credit.
                    </p>
                  )}
                </div>
              </div>

              <div className="flex justify-end gap-3 border-t pt-4">
                <button
                  className="px-4 py-2 rounded-xl border text-sm"
                  onClick={handleCloseWorldCreditMatch}
                  disabled={worldCreditMatchSaving}
                >
                  Cancel
                </button>
                <button
                  className="px-4 py-2 rounded-xl bg-emerald-600 text-white text-sm font-semibold disabled:opacity-60"
                  onClick={handleConfirmWorldCreditMatch}
                  disabled={worldCreditMatchSaving || !selectedSlip}
                  title="Stamp the order with this requisition and close it out of Returns Management"
                >
                  {worldCreditMatchSaving ? "Matching…" : "Match & close requisition"}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {transbecCreditMatch && (() => {
        const selectedSlip = waitingCreditSlips.find((s) => s.id === transbecCreditMatchSlipId) || null;
        const slipItems = selectedSlip?.items || [];
        const money = (n) => `$${(Number.isFinite(Number(n)) ? Number(n) : 0).toFixed(2)}`;
        const orderLines = Array.isArray(transbecCreditMatch.lineItems) ? transbecCreditMatch.lineItems : [];
        const lineKeys = (l, i) => creditLinePartKeys(l, creditMatchCapCodes[i]);
        const orderPartKeys = new Set(orderLines.flatMap(lineKeys));
        const slipKeys = new Set(slipItems.map((it) => normalizePartKey(it.itemcode)).filter(Boolean));
        const lineOnSlip = (l, i) => lineKeys(l, i).some((k) => slipKeys.has(k));
        const unmatchedSlipCount = slipItems.filter(
          (it) => !orderPartKeys.has(normalizePartKey(it.itemcode))
        ).length;
        const unmatchedOrderCount = orderLines.filter((l, i) => !lineOnSlip(l, i)).length;
        return (
          <div className="fixed inset-0 z-[5000] bg-slate-900/60 flex items-center justify-center px-4">
            <div className="bg-white rounded-3xl shadow-2xl w-full max-w-[95vw] p-6 flex flex-col gap-4 max-h-[95vh]">
              <div className="flex items-center justify-between">
                <h2 className="text-xl font-semibold text-slate-800">
                  Match Credit {transbecCreditMatch.reference} to a Return Requisition
                </h2>
                <button className="text-slate-500 hover:text-slate-700" onClick={handleCloseTransbecCreditMatch}>
                  x
                </button>
              </div>
              {transbecCreditMatchError && (
                <div className="text-sm text-red-600 whitespace-pre-line">{transbecCreditMatchError}</div>
              )}
              <p className="text-sm text-slate-500">
                This credit is already a real order with its own parts, read straight off the Transbec
                credit memo PDF — no scan to correct here. Compare it against the requisition on the
                right before confirming; confirming stamps the order with the requisition and closes
                it out of Returns Management, the same as its own "Credit received" button.
              </p>

              <div className="grid gap-4 lg:grid-cols-2 overflow-auto">
                {/* Left: the credit's own parts, read-only. */}
                <div className="flex flex-col gap-2 min-w-0">
                  <div className="flex flex-wrap gap-4 text-sm rounded-2xl border border-indigo-100 bg-indigo-50/40 px-3 py-2">
                    <div>
                      <div className="text-xs uppercase tracking-wide text-slate-400">Credit #</div>
                      <div className="font-bold text-amber-700">{transbecCreditMatch.reference || "—"}</div>
                    </div>
                    {Number.isFinite(Number(transbecCreditMatch.billed_total)) && (
                      <div>
                        <div className="text-xs uppercase tracking-wide text-slate-400">Credit total</div>
                        <div className="font-semibold text-slate-800">{money(transbecCreditMatch.billed_total)}</div>
                      </div>
                    )}
                  </div>
                  <div className="text-sm font-semibold text-slate-700">
                    1 · Credit's parts <span className="font-normal text-slate-400">(read-only, {orderLines.length})</span>
                  </div>
                  {orderLines.length === 0 ? (
                    <p className="text-sm text-slate-500 border rounded-xl px-3 py-2 bg-slate-50">
                      This credit has no line items.
                    </p>
                  ) : (
                    <div className="space-y-1 max-h-[60vh] overflow-auto border rounded-2xl p-2 bg-slate-50/60">
                      {orderLines.map((li, i) => {
                        const onSlip = selectedSlip ? lineOnSlip(li, i) : null;
                        return (
                          <div
                            key={`${li.partNumber || "part"}-${i}`}
                            className={`flex items-center justify-between gap-2 text-xs bg-white border rounded-lg px-2 py-1 ${
                              onSlip === false ? "border-amber-300 bg-amber-50/50" : "border-slate-100"
                            }`}
                          >
                            <span className="font-semibold text-slate-800">
                              {[li.partLineCode, li.partNumber].filter(Boolean).join(" ") || "—"}
                            </span>
                            <span className="text-slate-500 truncate">{li.partDescription || ""}</span>
                            <span className="text-slate-500 whitespace-nowrap">
                              {li.quantity ?? ""} × {money(li.costPriceValue)}
                            </span>
                            {onSlip !== null && (
                              <span
                                className={`px-2 py-0.5 rounded-full border font-semibold whitespace-nowrap ${
                                  onSlip
                                    ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                                    : "bg-amber-100 text-amber-800 border-amber-300"
                                }`}
                                title={
                                  onSlip
                                    ? "This part number is on the requisition"
                                    : "No line on the requisition has this part number"
                                }
                              >
                                {onSlip ? "on requisition" : "not on requisition"}
                              </span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                  {selectedSlip && unmatchedOrderCount > 0 && (
                    <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1">
                      <span className="font-semibold">{unmatchedOrderCount}</span> part(s) on the
                      credit have no matching part number on the requisition.
                    </p>
                  )}
                </div>

                {/* Right: pick a requisition, compare its parts. */}
                <div className="flex flex-col gap-2 min-w-0">
                  <div>
                    <label className="block text-sm font-semibold text-slate-700 mb-1">
                      2 · Match to a return requisition{" "}
                      <span className="font-normal text-slate-400">(waiting on credit, any warehouse)</span>
                    </label>
                    {waitingCreditSlips.length === 0 ? (
                      <p className="text-sm text-slate-500 border rounded-xl px-3 py-2 bg-slate-50">
                        No requisitions are waiting on a credit right now.
                      </p>
                    ) : (
                      <select
                        className="w-full border rounded-xl px-3 py-2 text-sm"
                        value={transbecCreditMatchSlipId}
                        onChange={(e) => setTransbecCreditMatchSlipId(e.target.value)}
                      >
                        <option value="">Select a requisition…</option>
                        {waitingCreditSlips.map((s) => (
                          <option key={s.id} value={s.id}>
                            {[
                              s.warehouse || "Unspecified",
                              s.date || "no date",
                              s.po ? `PO ${s.po}` : "no PO",
                              `${s.items.length} part(s)`,
                            ].join(" · ")}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>

                  {selectedSlip ? (
                    <div className="border rounded-2xl p-3 bg-slate-50/60">
                      <div className="text-sm font-semibold text-slate-700 mb-1">
                        Parts on this requisition <span className="font-normal text-slate-400">({slipItems.length})</span>
                      </div>
                      {slipItems.length > 0 && (
                        <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1 mb-2">
                          Confirming marks the requisition as credited:{" "}
                          <span className="font-semibold">{slipItems.length} part(s)</span> will be
                          removed from Returns Management.
                        </p>
                      )}
                      {slipItems.length === 0 && (
                        <p className="text-xs text-slate-500">This requisition has no parts.</p>
                      )}
                      <div className="space-y-1 max-h-[55vh] overflow-auto">
                        {slipItems.map((it) => {
                          const onCredit = orderPartKeys.has(normalizePartKey(it.itemcode));
                          return (
                            <div
                              key={it.uid}
                              className={`flex items-center justify-between gap-2 text-xs bg-white border rounded-lg px-2 py-1 ${
                                onCredit ? "border-slate-100" : "border-amber-300 bg-amber-50/50"
                              }`}
                            >
                              <span className="font-semibold text-slate-800">{it.itemcode || "—"}</span>
                              <span className="text-slate-500 whitespace-nowrap">
                                {Math.max(1, Number(it.quantity) || 1)} × {money(it.cost)}
                              </span>
                              <span
                                className={`px-2 py-0.5 rounded-full border font-semibold whitespace-nowrap ${
                                  onCredit
                                    ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                                    : "bg-amber-100 text-amber-800 border-amber-300"
                                }`}
                                title={
                                  onCredit
                                    ? "This part number is on the credit"
                                    : "No line on the credit has this part number"
                                }
                              >
                                {onCredit ? "on credit" : "not on credit"}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                      {unmatchedSlipCount > 0 && (
                        <p className="text-xs text-amber-700 mt-2">
                          <span className="font-semibold">{unmatchedSlipCount}</span> part(s) on the
                          requisition have no matching part number on the credit — double check this
                          is the right requisition before confirming.
                        </p>
                      )}
                      {unmatchedSlipCount === 0 && unmatchedOrderCount === 0 && slipItems.length > 0 && (
                        <p className="text-xs text-emerald-700 mt-2 font-semibold">
                          Every part number matches both sides.
                        </p>
                      )}
                    </div>
                  ) : (
                    <p className="text-sm text-slate-500 border rounded-xl px-3 py-2 bg-slate-50">
                      Pick a requisition above to compare its parts against the credit.
                    </p>
                  )}
                </div>
              </div>

              <div className="flex justify-end gap-3 border-t pt-4">
                <button
                  className="px-4 py-2 rounded-xl border text-sm"
                  onClick={handleCloseTransbecCreditMatch}
                  disabled={transbecCreditMatchSaving}
                >
                  Cancel
                </button>
                <button
                  className="px-4 py-2 rounded-xl bg-emerald-600 text-white text-sm font-semibold disabled:opacity-60"
                  onClick={handleConfirmTransbecCreditMatch}
                  disabled={transbecCreditMatchSaving || !selectedSlip}
                  title="Stamp the order with this requisition and close it out of Returns Management"
                >
                  {transbecCreditMatchSaving ? "Matching…" : "Match & close requisition"}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {invoiceReviewOrder && (
        <div className="fixed inset-0 z-[5000] bg-slate-900/60 flex items-center justify-center px-4">
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-[95vw] p-6 flex flex-col gap-4 max-h-[95vh]">
            <div className="flex items-center justify-between">
              <h2 className="text-xl font-semibold text-slate-800">
                Verify Invoice — {invoiceReviewOrder.reference}
              </h2>
              <button className="text-slate-500 hover:text-slate-700" onClick={handleCloseInvoiceReview}>
                x
              </button>
            </div>
            <p className="text-sm text-slate-500">
              Compare the invoice against the stored values below. Edit either field if it was read
              wrong, then confirm.
            </p>
            {invoiceReviewError && (
              <div className="rounded-xl bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">
                {invoiceReviewError}
              </div>
            )}
            <div className="grid gap-4 lg:grid-cols-[1fr,320px] overflow-auto">
              <div className="rounded-2xl border border-slate-200 bg-slate-50 flex items-center justify-center overflow-auto min-h-[400px] max-h-[85vh]">
                {invoiceReviewLoading ? (
                  <div className="text-sm text-slate-500 p-6">Loading invoice...</div>
                ) : invoiceReviewImageDataUrl.startsWith("data:application/pdf") ? (
                  // Transbec invoices are shown as the real PDF (Chromium's viewer);
                  // rasterizing them to an image drops most of the page.
                  <iframe
                    src={invoiceReviewImageDataUrl}
                    title="Invoice PDF"
                    className="w-full h-[85vh] border-0"
                  />
                ) : invoiceReviewImageDataUrl ? (
                  <img src={invoiceReviewImageDataUrl} alt="Scanned invoice" className="max-w-full max-h-[85vh] h-auto" />
                ) : (
                  <div className="text-sm text-slate-500 p-6">No invoice available.</div>
                )}
              </div>
              <div className="flex flex-col gap-4">
                <div className="flex flex-col gap-1">
                  <label className="text-sm uppercase tracking-wide text-slate-500">Invoice #</label>
                  <input
                    className="rounded-lg border border-slate-300 px-4 py-3 text-2xl font-semibold"
                    value={invoiceReviewInvoiceDraft}
                    onChange={(e) => setInvoiceReviewInvoiceDraft(e.target.value)}
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-sm uppercase tracking-wide text-slate-500">Billed Total</label>
                  <input
                    className="rounded-lg border border-slate-300 px-4 py-3 text-2xl font-semibold"
                    value={invoiceReviewTotalDraft}
                    onChange={(e) => setInvoiceReviewTotalDraft(e.target.value)}
                  />
                </div>

                {invoiceReviewOrder.epicorOnly && (
                  <div className="flex flex-col gap-2">
                    <div className="flex items-center justify-between">
                      <label className="text-sm uppercase tracking-wide text-slate-500">
                        Line Items ({invoiceReviewLinesDraft.length})
                      </label>
                      <button
                        type="button"
                        className="text-xs font-semibold text-emerald-700 border border-emerald-200 rounded-full px-2 py-1 hover:bg-emerald-50"
                        onClick={addInvoiceReviewLine}
                      >
                        + Add line
                      </button>
                    </div>
                    <p className="text-xs text-slate-400">
                      Read by OCR — check each against the invoice and fix the part #, quantity,
                      description, or price as needed.
                    </p>
                    {invoiceReviewLinesDraft.length === 0 && (
                      <div className="text-xs text-slate-400 border border-dashed border-slate-200 rounded-lg p-3">
                        No line items were read. Use “Add line” to enter them from the invoice.
                      </div>
                    )}
                    <div className="flex flex-col gap-2 max-h-[45vh] overflow-auto pr-1">
                      {invoiceReviewLinesDraft.map((l, idx) => (
                        <div key={idx} className="rounded-xl border border-slate-200 p-2 flex flex-col gap-1.5">
                          <input
                            className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm font-semibold"
                            placeholder="Part #"
                            value={l.part}
                            onChange={(e) => updateInvoiceReviewLine(idx, "part", e.target.value)}
                          />
                          <input
                            className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
                            placeholder="Description"
                            value={l.partDescription}
                            onChange={(e) => updateInvoiceReviewLine(idx, "partDescription", e.target.value)}
                          />
                          <div className="flex items-center gap-2">
                            <input
                              className="w-16 rounded-lg border border-slate-300 px-2 py-1.5 text-sm text-center"
                              placeholder="Qty"
                              value={l.quantity}
                              onChange={(e) => updateInvoiceReviewLine(idx, "quantity", e.target.value)}
                            />
                            <div className="flex items-center gap-1">
                              <span className="text-xs text-slate-400">@ $</span>
                              <input
                                className="w-20 rounded-lg border border-slate-300 px-2 py-1.5 text-sm text-right"
                                placeholder="Price"
                                inputMode="decimal"
                                value={l.costPrice ?? ""}
                                onChange={(e) => updateInvoiceReviewLine(idx, "costPrice", e.target.value)}
                              />
                            </div>
                            <button
                              type="button"
                              className="ml-auto text-xs font-semibold text-red-600 hover:text-red-700"
                              onClick={() => removeInvoiceReviewLine(idx)}
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
                onClick={handleCloseInvoiceReview}
                disabled={invoiceReviewSaving}
              >
                Cancel
              </button>
              <button
                className="px-5 py-2 rounded-full bg-indigo-600 text-white shadow hover:bg-indigo-700 disabled:opacity-60"
                onClick={handleConfirmInvoiceReview}
                disabled={invoiceReviewSaving}
              >
                {invoiceReviewSaving ? "Saving..." : "Confirm"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Renders nothing unless two machines genuinely raced the same field. */}
      <ConflictReview />
    </div>
  );
}
