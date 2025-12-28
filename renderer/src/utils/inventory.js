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

// Merge incoming array into existing items by uid
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
      result.push(incomingItem);
    }
    byUid.delete(incomingItem.uid);
  }
  // Anything left in byUid was deleted on disk → drop it
  return result;
}
