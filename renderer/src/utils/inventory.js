// src/utils/inventory.js

export function makeUid() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return "u_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}

export const itemKey = (it) => it.uid;

const normalizeName = (name) => (name || "").trim().toLowerCase();

// A bubble's id is DERIVED FROM ITS NAME, never minted.
//
// The name is what actually identifies an order: items point at a bubble
// through `allocated_to`, a plain name string, and every lookup here — grouping
// parts onto cards, de-duplicating the shared set, enforcing uniqueness — has
// always matched on the name. The id was a leftover from the draggable-bubble
// workspace, where `bubbles` was local state and the id was just a React key.
// Once bubble notes and print extras became shared, that machine-local id was
// doing the job of a cross-machine primary key, so two machines that both saw
// the same order name each minted a uuid for it and the share ended up holding
// one order as two or three records.
//
// Deriving it means both machines compute the same key with no coordination, so
// there is only ever one record to begin with. Safe because bubbles can't be
// renamed and `uniqueName` below already keeps names unique case-insensitively.
//
// main/crdt/bubbleIds.js holds the identical implementation for the store side;
// the two must agree exactly.
export function bubbleIdForName(name) {
  const norm = normalizeName(name);
  return norm ? `b:${norm}` : "";
}

export const DEFAULT_BUBBLES = [
  { id: bubbleIdForName("NEW STOCK"), name: "NEW STOCK", notes: "" },
  { id: bubbleIdForName("CASH SALES"), name: "CASH SALES", notes: "" },
  { id: bubbleIdForName("SHELF"), name: "SHELF", notes: "" },
  { id: bubbleIdForName("RETURNS"), name: "RETURNS", notes: "" },
];

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
      // Inert. This was a monotonic per-item version, bumped on every change so
      // a higher rev could beat a stale copy — first in the main process's
      // write gate, then in mergeItems. Both are gone; concurrency is settled
      // per field by the replicated store, which needs nothing from the record
      // itself. Carried through untouched rather than dropped so the value on
      // the share stays put; it can be cleared for good with a one-time
      // clearFields sweep once every machine is on this build.
      rev: Number.isFinite(Number(it.rev)) ? Number(it.rev) : 0,
      quantity:
        typeof it.quantity === "number"
          ? it.quantity
          : parseInt(it.quantity || 0, 10) || 0,
      reference_num: String(it.reference_num ?? ""),
      sold_date: String(it.sold_date ?? ""),
      sold_status: String(it.sold_status ?? ""),
      // The price this part was quoted at WITH tax on it — what the customer
      // was actually told, kept verbatim rather than re-derived, because
      // grossing the sell price back up is a calculation and this is a promise.
      // Empty means it was never quoted that way, which is what decides whether
      // the order can print a Quotation at all. Part of the whitelist for the
      // same reason as the fields above: everything round-trips through here, so
      // an unlisted field is silently erased the first time anyone saves.
      tax_in_price: String(it.tax_in_price ?? ""),
      // Back-link to the order line this part came from (Order Assignment).
      // This object is a whitelist — every save round-trips through it, so
      // dropping these would strip the stamp off every item the first time
      // anyone touched a bubble, permanently downgrading the link to a guess.
      order_key: String(it.order_key ?? ""),
      order_line_idx: Number.isInteger(it.order_line_idx) ? it.order_line_idx : null,
      // Returns requisition association. Empty = unassigned (sits in the
      // warehouse's Unassigned Returns group); set = belongs to that slip.
      return_slip_id: String(it.return_slip_id ?? ""),
      return_slip_date: String(it.return_slip_date ?? ""),
      return_slip_po: String(it.return_slip_po ?? ""),
      // "" / "open" = active requisition; "waiting" = set aside, awaiting return.
      return_slip_status: String(it.return_slip_status ?? ""),
    };
  });
}

// revOf/nextRev used to live here. Nothing bumps `rev` any more — see the note
// on the field in normalizeItems above.

export function ensureBubblesForItems(items, setBubblesFn) {
  setBubblesFn((prev) => {
    const knownLower = new Set(prev.map((b) => normalizeName(b.name)));
    const extra = [];

    for (const it of items) {
      const name = it.allocated_to && it.allocated_to.trim();
      const lower = normalizeName(name);
      if (name && !knownLower.has(lower)) {
        knownLower.add(lower);
        extra.push({ id: bubbleIdForName(name), name: name.toUpperCase(), notes: "" });
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

// mergeItems used to live here: a client-side last-writer-wins that kept
// whichever copy of an item carried the higher `rev`, so a stale push couldn't
// revert a local move. It is gone, and deliberately not replaced.
//
// Merging is the replicated store's job now, and it does it per FIELD against
// every machine's op log (main/crdt/merge.js). Re-deciding the winner here
// could only make that worse: `rev` is per-item, so preferring the local copy
// threw away fields another machine had legitimately changed, and it made this
// side believe unsent edits were already saved. See adoptPushedItems in
// App.jsx for what replaced it.

// A cheap fingerprint of everything that actually shows up on a printed
// invoice: which items, at what quantity/price, plus notes and print-only
// extra lines. Used both to STAMP what was printed (App.jsx's print-confirm
// handler) and to CHECK whether the bubble has drifted since (Sales Order
// view's "printed" vs "changed since print" badge) — one function so the two
// can never disagree about what counts as a change. Not a real hash: string
// equality is all that's needed, and a plain sorted string is easier to eyeball
// in devtools than a hash would be.
export function computeBubblePrintSignature(notes, items, extraLines) {
  const itemPart = (items || [])
    .map((it) => `${it.uid}:${it.quantity}:${it.allocated_for ?? ""}:${it.cost ?? ""}`)
    .sort()
    .join("|");
  const extraPart = (extraLines || [])
    .map((l) => `${l.description ?? ""}:${l.quantity ?? ""}:${l.unitPrice ?? ""}:${l.taxable ?? ""}:${l.partLineCode ?? ""}`)
    .join("|");
  return `${notes || ""}::${itemPart}::${extraPart}`;
}
