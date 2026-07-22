// src/utils/inventory.js

export function makeUid() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return "u_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}

export const itemKey = (it) => it.uid;

export const DEFAULT_BUBBLES = [
  { id: "new", name: "NEW STOCK", notes: "" },
  { id: "cash", name: "CASH SALES", notes: "" },
  { id: "shelf", name: "SHELF", notes: "" },
  { id: "returns", name: "RETURNS", notes: "" },
];

const normalizeName = (name) => (name || "").trim().toLowerCase();

export function uniqueName(baseName, existingNames) {
  const lowerExisting = new Set(Array.from(existingNames || []).map((n) => normalizeName(n)));
  const baseLower = normalizeName(baseName);
  if (!lowerExisting.has(baseLower)) return baseName;
  let i = 2;
  let candidate = `${baseName}${i}`;
  while (lowerExisting.has(normalizeName(candidate))) {
    i++;
    candidate = `${baseName}${i}`;
  }
  return candidate;
}

export function normalizeItems(arr) {
  return (arr || []).map((raw) => {
    const it = { ...raw };
    it.uid = it.uid || it.id || makeUid();
    const pathUpper = String(it.accountingPath || "OUTSTANDING").trim().toUpperCase();
    const allocatedToRaw =
      it.allocated_to && it.allocated_to !== ""
        ? it.allocated_to
        : pathUpper === "OUTSTANDING"
          ? "NEW STOCK"
          : "UNALLOCATED";
    const normalizedAlloc =
      allocatedToRaw === "Stock" ? "SHELF" : String(allocatedToRaw || "").trim().toUpperCase() || "UNALLOCATED";
    const allocatedTo = normalizedAlloc || (pathUpper === "OUTSTANDING" ? "NEW STOCK" : "UNALLOCATED");
    return {
      uid: it.uid,
      accountingPath: it.accountingPath || "OUTSTANDING",
      allocated_for: it.allocated_for ?? "",
      discounted_price: it.discounted_price ?? it.discountedPrice ?? "",
      allocated_to: allocatedTo,
      cost: String(it.cost ?? ""),
      date: String(it.date ?? ""),
      invoice_num: String(it.invoice_num ?? ""),
      ["invoiced date"]: String(it["invoiced date"] ?? ""),
      ["invoiced status"]: String(it["invoiced status"] ?? ""),
      itemcode: String(it.itemcode ?? ""),
      notes1: it.notes1 ?? "",
      notes2: it.notes2 ?? "",
      source_inv: String(it.source_inv ?? ""),
      warehouse: String(it.warehouse ?? ""),
      last_moved_at: it.last_moved_at || new Date().toISOString(),
      // Monotonic per-item version. Bumped on every semantic change (see
      // nextRev). Legacy/AHK items written without a rev read as 0, so any
      // in-app edit (rev >= 1) supersedes them.
      rev: Number.isFinite(Number(it.rev)) ? Number(it.rev) : 0,
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

// Current rev of an item (missing/invalid -> 0).
export function revOf(it) {
  const r = Number(it && it.rev);
  return Number.isFinite(r) ? r : 0;
}

// Next rev to stamp when mutating an item. Call this wherever an item's
// content changes so newer versions can win over stale copies without relying
// on wall-clock timestamps.
export function nextRev(it) {
  return revOf(it) + 1;
}

export function ensureBubblesForItems(items, setBubblesFn) {
  setBubblesFn((prev) => {
    const knownLower = new Set(prev.map((b) => normalizeName(b.name)));
    const extra = [];

    for (const it of items) {
      const name = it.allocated_to && it.allocated_to.trim();
      const lower = normalizeName(name);
      if (name && !knownLower.has(lower)) {
        knownLower.add(lower);
        extra.push({ id: makeUid(), name: name.toUpperCase(), notes: "" });
      }
    }

    if (extra.length === 0) return prev;
    return [...prev, ...extra];
  });
}

export function groupItemsByBubble(items, bubbles) {
  const map = new Map();
  const byUpper = new Map();
  bubbles.forEach((b) => {
    const upper = (b.name || "").toUpperCase();
    byUpper.set(upper, b.name);
    map.set(b.name, []);
  });
  for (const it of items) {
    const targetUpper = (it.allocated_to || "").toUpperCase();
    const resolvedName = byUpper.get(targetUpper) || "NEW STOCK";
    if (!map.has(resolvedName)) map.set(resolvedName, []);
    map.get(resolvedName).push(it);
  }
  return map;
}

// Parse an ISO last_moved_at into a comparable number; invalid/missing -> 0.
function movedAtMs(it) {
  const t = Date.parse(it && it.last_moved_at);
  return Number.isNaN(t) ? 0 : t;
}

// Merge incoming array into existing items by uid.
//
// When the same uid differs between the local copy and the incoming (on-disk)
// copy, keep whichever has the higher rev. This prevents a stale push — e.g. a
// file-watch event that fires before a local move is persisted, or another
// machine writing its older in-memory copy — from reverting a change we just
// made, without depending on synced clocks. When revs are equal we fall back
// to last_moved_at (helps legacy items that predate rev), and if that ties too
// we prefer the incoming disk copy so machines still converge.
export function mergeItems(prev, incoming) {
  const byUid = new Map(prev.map((it) => [it.uid, it]));
  const result = [];

  for (const incomingItem of incoming) {
    const existing = byUid.get(incomingItem.uid);
    if (!existing) {
      result.push(incomingItem);
      continue;
    }

    const same = JSON.stringify(existing) === JSON.stringify(incomingItem);
    if (same) {
      result.push(existing); // keep same object to avoid remounts
    } else {
      const er = revOf(existing);
      const ir = revOf(incomingItem);
      let keepLocal;
      if (er !== ir) keepLocal = er > ir;
      else keepLocal = movedAtMs(existing) > movedAtMs(incomingItem);
      result.push(keepLocal ? existing : incomingItem);
    }
    byUid.delete(incomingItem.uid);
  }
  // Anything left in byUid was deleted on disk → drop it
  return result;
}
