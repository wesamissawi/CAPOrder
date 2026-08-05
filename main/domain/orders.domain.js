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
  // The waiting room in front of sage_trigger. Owned here for the same reason
  // the trigger is: it is only ever written by the dedicated Sage IPCs, so a
  // renderer holding a copy from before the order was queued must not be able
  // to un-queue it by saving an unrelated edit.
  "sage_queued",
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

// The two flags a completed Sage run also sets (helpers.ahk's UpdateOrderJournal
// writes enteredInSage alongside the journal entry). They can't join
// SAGE_OWNED_FIELDS — the user ticks these same checkboxes by hand in Order
// Management, and disk-always-wins would make the checkbox impossible to clear.
// Instead they're sticky in the TRUE direction only, and only against a renderer
// copy that predates the run: see mergeOrdersForWrite.
const SAGE_RESULT_FLAGS = ["enteredInSage", "totalVerified"];

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
// Renderer-only bookkeeping that must never be written to orders.json.
const RENDERER_EDIT_MARKS = ["_dirtyFields", "_localDirty"];

// Every value an order can be recognised by. Archiving fills sage_reference /
// source_invoice with the invoice number, so a sender holding the pre-archive
// copy may only know it by its original `reference` — checking one field alone
// would miss it.
function orderLookupKeys(order) {
  return [
    order?.sage_reference_synced,
    order?.sage_reference,
    order?.source_invoice,
    order?.reference,
    order?.__row,
  ]
    .map((v) => (v === null || v === undefined ? "" : String(v).trim().toUpperCase()))
    .filter(Boolean);
}

function isArchivedOrder(order, archivedKeys) {
  if (!archivedKeys || !archivedKeys.size) return false;
  return orderLookupKeys(order).some((k) => archivedKeys.has(k));
}

// Build the key set from an orders index (orders_index.json). Only entries the
// index marks archived are included; an order that is BOTH active and archived
// is indexed as active, so it will not be dropped.
function buildArchivedKeySet(indexEntries) {
  const keys = new Set();
  (Array.isArray(indexEntries) ? indexEntries : []).forEach((e) => {
    if (!e || !e.archived) return;
    [e.key, e.reference].forEach((v) => {
      const k = v === null || v === undefined ? "" : String(v).trim().toUpperCase();
      if (k) keys.add(k);
    });
  });
  return keys;
}

function stripEditMarks(order) {
  if (!order) return order;
  let out = order;
  RENDERER_EDIT_MARKS.forEach((f) => {
    if (Object.prototype.hasOwnProperty.call(out, f)) {
      if (out === order) out = { ...order };
      delete out[f];
    }
  });
  return out;
}

// Reconcile a full array coming from a renderer against what is on disk right
// now. Per order: a live Sage lock means the disk copy wins outright; otherwise
// the renderer's edits are kept but the Sage-owned fields are taken from disk.
// Orders present on disk but missing from the incoming array are preserved —
// a renderer never deletes through a bulk write (archive/delete have their own
// IPC), so a missing order just means the sender loaded before it existed.
//
// A renderer save carries the WHOLE array even when one checkbox changed, so
// most of what arrives is simply whatever that window last read. When the
// sender tags an order with `_dirtyFields` we therefore rebuild it from disk
// and re-apply only those fields, which is what stops one machine's save from
// reverting another's unrelated edit to the same order. Callers that send no
// tags (vendor scrapes, older builds) keep the previous whole-order behaviour.
//
// `options.archivedKeys` is a Set of keys already in the orders archive. An
// order the sender still holds but that is NOT on disk is normally a new one to
// add — that is how scrapes introduce orders — but it is also exactly what an
// already-archived order looks like to a window that loaded before it was
// archived. Without this the next save from that window silently resurrects it,
// which then double-counts its parts into stock if it is archived a second time
// (observed on OJ0168: archived 20:36:13, back in orders.json by 20:39:56).
function mergeOrdersForWrite(diskList, incomingList, options = {}) {
  const archivedKeys = options.archivedKeys instanceof Set ? options.archivedKeys : null;
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
  const resurrected = [];
  const merged = incoming.map((inc) => {
    const key = orderIdentityKey(inc);
    const queue = key ? byKey.get(key) : null;
    const current = queue && queue.length ? queue.shift() : null;
    if (!current) {
      // Not on disk. Either genuinely new, or archived out from under a sender
      // that still has it — every key this order can be known by is checked,
      // since archiving stamps the invoice number onto sage_reference.
      if (archivedKeys && isArchivedOrder(inc, archivedKeys)) {
        if (key) resurrected.push(key);
        return null;
      }
      return stripEditMarks(inc);
    }
    consumed.add(current);

    if (isOrderSageLocked(current)) {
      blocked.push(key);
      return current;
    }

    // Field-level when the sender said what it touched, whole-order otherwise.
    const dirtyFields = Array.isArray(inc._dirtyFields) ? inc._dirtyFields : null;
    let next;
    if (dirtyFields) {
      next = { ...current };
      dirtyFields.forEach((field) => {
        if (RENDERER_EDIT_MARKS.includes(field)) return;
        next[field] = inc[field];
      });
      // Carry the edit's own timestamp; everything else already came from disk.
      if (inc.lastUpdatedAt) next.lastUpdatedAt = inc.lastUpdatedAt;
    } else {
      next = { ...inc };
    }
    SAGE_OWNED_FIELDS.forEach((field) => {
      if (Object.prototype.hasOwnProperty.call(current, field)) next[field] = current[field];
      else delete next[field];
    });

    // AHK writes enteredInSage/totalVerified straight into orders.json at the
    // end of a run, next to sage_processed_at. A renderer window that loaded
    // BEFORE that run still holds the old `false` for both, and its next save
    // would quietly revert them — leaving an order that really is in Sage
    // looking un-entered, and unarchivable forever (canArchiveOrder needs both
    // true). Observed on OI9489/OI9989/652663: every SAGE_OWNED field survived
    // the save and precisely these two came back false.
    //
    // sage_processed_at is the tell. It is SAGE_OWNED, so disk's value is
    // authoritative; if the incoming copy carries a different one it was read
    // before this run finished and has nothing to say about the outcome. When
    // the two agree the window HAS seen the result, so a false there is a
    // deliberate un-tick and is honoured. Only true is ever restored — a Sage
    // run never clears these.
    const sawThisSageRun =
      String(inc.sage_processed_at || "") === String(current.sage_processed_at || "");
    if (!sawThisSageRun) {
      SAGE_RESULT_FLAGS.forEach((field) => {
        if (current[field] === true) next[field] = true;
      });
    }
    // Sweep away a lock whose work is done (or that timed out) instead of
    // leaving a dead field on the order forever.
    if (next.sage_lock) next.sage_lock = null;
    RENDERER_EDIT_MARKS.forEach((f) => delete next[f]);
    return next;
  });

  const kept = merged.filter(Boolean);
  const leftovers = disk.filter((o) => !consumed.has(o));
  return { orders: kept.concat(leftovers), blocked, restored: leftovers.length, resurrected };
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
  buildArchivedKeySet,
  isArchivedOrder,
  SAGE_ORDER_LOCK_MAX_MS,
  SAGE_OWNED_FIELDS,
  SAGE_RESULT_FLAGS,
};
