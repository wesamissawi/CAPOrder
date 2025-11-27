// src/utils/inventory.js

export function makeUid() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return "u_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}

export const itemKey = (it) => it.uid;

export const DEFAULT_BUBBLES = [
  { id: "new", name: "New Stock", notes: "" },
  { id: "cash", name: "Cash Sales", notes: "" },
  { id: "shelf", name: "Shelf", notes: "" },
  { id: "returns", name: "Returns", notes: "" },
];

export function uniqueName(baseName, existingNames) {
  if (!existingNames.has(baseName)) return baseName;
  let i = 2;
  while (existingNames.has(`${baseName}${i}`)) i++;
  return `${baseName}${i}`;
}

export function normalizeItems(arr) {
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
    const known = new Set(prev.map((b) => b.name));
    const extra = [];

    for (const it of items) {
      const name = it.allocated_to && it.allocated_to.trim();
      if (name && !known.has(name)) {
        known.add(name);
        extra.push({ id: makeUid(), name, notes: "" });
      }
    }

    if (extra.length === 0) return prev;
    return [...prev, ...extra];
  });
}

export function groupItemsByBubble(items, bubbles) {
  const map = new Map();
  bubbles.forEach((b) => map.set(b.name, []));
  for (const it of items) {
    const target = map.has(it.allocated_to) ? it.allocated_to : "New Stock";
    if (!map.has(target)) map.set(target, []);
    map.get(target).push(it);
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
