function normalizeOrderRef(order) {
  if (!order) return "";
  const ref = order.sage_reference || order.reference || order.__row || "";
  return String(ref || "").trim().toUpperCase();
}

function orderMatchesKey(order, targetKey) {
  if (!order || !targetKey) return false;
  const candidates = [
    order.sage_reference_synced,
    order.sage_reference,
    order.source_invoice,
    order.reference,
    order.__row,
  ];
  return candidates.some((val) => {
    if (val === null || val === undefined) return false;
    return String(val).trim().toUpperCase() === targetKey;
  });
}

// ---------------------------------------------------------------------------
// Per-order Sage lock
//
// orders.json is shared over the network and every machine holds its own copy of
// the whole array in memory. A bulk "Save Changes" therefore used to write back
// a full snapshot that could be minutes old — including the Sage state of an
// order another machine had meanwhile finished processing. That resurrected
// `sage_trigger: true` / `enteredInSage: false`, and the Sage queue entered the
// same order into Sage a second time.
//
// An order is now *owned* by the Sage pipeline from the moment it is triggered
// until the AHK run reports back. While that lock is live no bulk write may
// touch the order at all, and the UI blurs the card so nothing new can be typed
// into it. The lock carries a timestamp so a machine that dies mid-run cannot
// freeze an order forever.
const SAGE_ORDER_LOCK_MAX_MS = 30 * 60 * 1000;

function sageOrderLockIsLive(lock) {
  if (!lock || typeof lock !== "object") return false;
  const stamp = Number(lock.heartbeatAt || lock.startedAt || 0);
  if (!Number.isFinite(stamp) || stamp <= 0) return false;
  return Date.now() - stamp < SAGE_ORDER_LOCK_MAX_MS;
}

// The lock must never be the ONLY thing that says an order is still busy.
// Clearing `sage_lock` explicitly is one code path among several — and it is not
// even reachable on a machine still running an older build, which will happily
// enter the order in Sage and write the result back while leaving the lock field
// exactly as it found it. So the release is DERIVED from the order's own state:
// whatever wrote the result, an order that is no longer triggered and is marked
// entered is finished, and the card un-blurs on its own.
function sageOrderWorkFinished(order) {
  const lock = order?.sage_lock;
  if (!lock || typeof lock !== "object") return true;

  if (lock.kind === "invoice") {
    // The invoice queue clears the trigger as its last act.
    return order.sage_invoice_trigger !== true;
  }

  if (lock.stage === "reconcile") {
    // Reconciling has no trigger flag of its own, so use the completion stamp
    // every result path writes. Generous slack for clock skew between machines.
    const processed = Date.parse(order.sage_processed_at || "");
    const started = Number(lock.startedAt || 0);
    return Number.isFinite(processed) && processed >= started - 5 * 60 * 1000;
  }

  // Purchase: entered in Sage and no longer queued.
  return order.sage_trigger !== true && order.enteredInSage === true;
}

// THE test for "is this order busy with Sage" — use this, not the raw lock.
function isOrderSageLocked(order) {
  if (!order?.sage_lock) return false;
  if (sageOrderWorkFinished(order)) return false;
  return sageOrderLockIsLive(order.sage_lock);
}

// Fields only the main process may author: the Sage triggers, the lock itself,
// and everything the AHK run reports back. A renderer save carries whatever it
// last read for these, which is exactly the stale data we must not honour, so
// the on-disk values always win. Deliberately NOT listed: enteredInSage,
// totalVerified, valueCheckAlert, billed_total, invoiceNeedsSync — the user
// edits those by hand on the card, so they stay renderer-owned.
const SAGE_OWNED_FIELDS = [
  "sage_trigger",
  "sage_invoice_trigger",
  "sage_lock",
  "journalEntry",
  "journal_entry",
  "sage_reference_synced",
  "sage_total_synced",
  "sage_processed_at",
  "reconciliation_delta",
  "invoiceSageUpdate",
];

// Stable identity for matching a renderer's copy of an order to the one on
// disk. `reference` never changes once an order exists (filling in an invoice
// number sets source_invoice/sage_reference instead), so it survives the whole
// Sage round trip; __row covers orders that never had one.
function orderIdentityKey(order) {
  if (!order) return "";
  const val = order.reference || order.__row || "";
  return String(val || "").trim().toUpperCase();
}

// Reconcile a full array coming from a renderer against what is on disk right
// now. Per order: a live Sage lock means the disk copy wins outright; otherwise
// the renderer's edits are kept but the Sage-owned fields are taken from disk.
// Orders present on disk but missing from the incoming array are preserved —
// a renderer never deletes through a bulk write (archive/delete have their own
// IPC), so a missing order just means the sender loaded before it existed.
function mergeOrdersForWrite(diskList, incomingList) {
  const disk = (Array.isArray(diskList) ? diskList : []).filter(Boolean);
  const incoming = (Array.isArray(incomingList) ? incomingList : []).filter(Boolean);

  const byKey = new Map();
  disk.forEach((o) => {
    const key = orderIdentityKey(o);
    if (!key) return;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(o);
  });

  const consumed = new Set();
  const blocked = [];
  const merged = incoming.map((inc) => {
    const key = orderIdentityKey(inc);
    const queue = key ? byKey.get(key) : null;
    const current = queue && queue.length ? queue.shift() : null;
    if (!current) return inc;
    consumed.add(current);

    if (isOrderSageLocked(current)) {
      blocked.push(key);
      return current;
    }

    const next = { ...inc };
    SAGE_OWNED_FIELDS.forEach((field) => {
      if (Object.prototype.hasOwnProperty.call(current, field)) next[field] = current[field];
      else delete next[field];
    });
    // Sweep away a lock whose work is done (or that timed out) instead of
    // leaving a dead field on the order forever.
    if (next.sage_lock) next.sage_lock = null;
    return next;
  });

  const leftovers = disk.filter((o) => !consumed.has(o));
  return { orders: merged.concat(leftovers), blocked, restored: leftovers.length };
}

function getVendorName(order) {
  if (!order) return "";
  return (
    (order.sage_source || "").trim() ||
    (order.warehouse || "").trim() ||
    (order.seller || "").trim()
  );
}

module.exports = {
  normalizeOrderRef,
  orderMatchesKey,
  getVendorName,
  orderIdentityKey,
  sageOrderLockIsLive,
  sageOrderWorkFinished,
  isOrderSageLocked,
  mergeOrdersForWrite,
  SAGE_ORDER_LOCK_MAX_MS,
  SAGE_OWNED_FIELDS,
};
