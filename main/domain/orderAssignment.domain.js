// Order Assignment domain — the "what happened to this part?" lens.
//
// Order Management answers "did this purchase get into Sage?". This answers the
// next question: for every line we bought, where did the physical parts GO —
// a customer, the shelf, a return, or nowhere yet.
//
// The hard part is identity. Order line items have NO stable id: they're a bare
// array on the order with partLineCode/partNumber and nothing else, and stock
// items only ever back-linked to the ORDER (reference_num), never to the line.
// So linkage is done in two tiers:
//
//   1. Stamped  — items created from a line now carry order_key + order_line_idx
//                 (see items.domain.makeOutstandingFromLine). Exact, no guessing.
//   2. Fallback — everything created before that stamp existed is matched by
//                 reference_num + itemcode. Because itemcode holds the RESOLVED
//                 CAP/Sage code (not the raw vendor code), this must run in the
//                 main process where capRules lives — see [[cap-code-single-source-resolve]].
//
// Tier 2 is a guess and is reported as such: every result carries counts of how
// many links came from each tier plus any items that matched the order but no
// line. That's the signal for whether this view can be trusted on old data.
const { resolveCapCode } = require('../../src/scrapers/capRules');
const { normalizeOrderRef } = require('./orders.domain');

// Bubbles that mean "not allocated yet". A part sitting here has arrived but
// nobody has said what it's for — exactly what this view exists to surface.
const STAGING_DESTINATIONS = new Set(['', 'NEW STOCK', 'NEWSTOCK', 'UNALLOCATED']);

const upper = (v) => String(v ?? '').trim().toUpperCase();
// Collapse runs of whitespace so "DOR  42044" and "DOR 42044" are one code.
const codeKey = (v) => upper(v).replace(/\s+/g, ' ');
// Spaceless variant: catches "DOR42044" vs "DOR 42044" spacing drift between
// what a scraper wrote and what the rules resolve to today.
const tightKey = (v) => upper(v).replace(/[\s-]+/g, '');

function orderKeyOf(order) {
  return normalizeOrderRef(order);
}

function lineKeyOf(orderKey, idx) {
  return `${orderKey}#${idx}`;
}

// Every reference an item's reference_num could plausibly carry for this order.
// Scrapers stamp reference at creation, but an order later picks up a
// sage_reference / source_invoice, so old and new items can disagree.
function orderRefCandidates(order) {
  return new Set(
    [order?.reference, order?.sage_reference, order?.sage_reference_synced, order?.source_invoice, order?.__row]
      .map(upper)
      .filter(Boolean)
  );
}

// The codes an item's `itemcode` might hold for this line: the resolved CAP code
// (what makeOutstandingFromLine writes today) and the raw vendor code (what
// older items and AHK-written rows hold).
function lineCodeCandidates(order, line) {
  const raw = `${line?.partLineCode || ''} ${line?.partNumber || ''}`.trim();
  const warehouse = order?.warehouse || order?.seller || order?.source || '';
  let resolved = '';
  let description = '';
  try {
    const out = resolveCapCode(warehouse, line?.partLineCode, line?.partNumber, line?.partDescription);
    resolved = (out?.code || '').trim();
    description = out?.description || '';
  } catch {
    // A rules failure must not blank the whole view — fall back to the raw code.
  }
  const codes = new Set();
  [resolved, raw, line?.partNumber].forEach((c) => {
    const k = codeKey(c);
    if (k) codes.add(k);
  });
  return { codes, resolvedCode: resolved || raw, description: description || line?.partDescription || '' };
}

function classifyDestination(item) {
  const dest = upper(item?.allocated_to);
  if (STAGING_DESTINATIONS.has(dest)) return 'staging';
  if (dest === 'RETURNS') return 'returns';
  if (dest === 'SHELF') return 'shelf';
  if (dest === 'CASH SALES') return 'cash';
  if (upper(item?.accountingPath) === 'SAGE_AR') return 'sage';
  if (upper(item?.accountingPath) === 'CASH_SALE') return 'cash';
  return 'customer';
}

const qtyOf = (it) => Number(it?.quantity) || 0;

// Link one order's lines to live stock items.
//
// Runs the two tiers described at the top of the file, consuming each item at
// most once so a part can never be counted against two different lines. Items
// that match the order but no line are returned in `orphans` rather than being
// force-fitted somewhere — a wrong link is worse than a reported gap.
function linkOrderItems(order, candidateItems) {
  const lines = Array.isArray(order?.lineItems) ? order.lineItems : [];
  const key = orderKeyOf(order);
  const consumed = new Set();
  const perLine = lines.map(() => []);
  let stampedLinks = 0;
  let fallbackLinks = 0;

  // Tier 1: exact stamp.
  candidateItems.forEach((it) => {
    const idx = Number(it?.order_line_idx);
    if (!Number.isInteger(idx) || idx < 0 || idx >= lines.length) return;
    if (upper(it?.order_key) !== key) return;
    perLine[idx].push(it);
    consumed.add(it.uid);
    stampedLinks += 1;
  });

  // Tier 2: reference + itemcode, in line order, capped at the ordered quantity
  // so a 4-qty line can't swallow items that belong to a later identical line.
  const lineMeta = lines.map((line) => lineCodeCandidates(order, line));
  lines.forEach((line, idx) => {
    const orderedQty = Math.abs(Number(line?.quantity) || 0) || 1;
    let taken = perLine[idx].reduce((sum, it) => sum + qtyOf(it), 0);
    if (taken >= orderedQty) return;
    const { codes } = lineMeta[idx];
    if (!codes.size) return;
    const tight = new Set(Array.from(codes).map(tightKey));
    // Allocated items are considered BEFORE ones still sitting in NEW STOCK.
    // The quantity cap means a line can only absorb so many rows, and when the
    // store holds more rows than were ordered (duplicate adds happen) taking
    // the staged one first would report "not assigned yet" for a part someone
    // had already allocated to a customer — the exact error this view exists to
    // prevent. An allocated row is a deliberate act and is the better evidence;
    // the surplus staged row falls through to `orphans` where it's visible.
    const ordered = candidateItems
      .filter((it) => !consumed.has(it.uid))
      .sort(
        (a, b) =>
          (classifyDestination(a) === 'staging' ? 1 : 0) - (classifyDestination(b) === 'staging' ? 1 : 0)
      );
    for (const it of ordered) {
      if (taken >= orderedQty) break;
      if (consumed.has(it.uid)) continue;
      const ic = codeKey(it?.itemcode);
      if (!ic) continue;
      if (!codes.has(ic) && !tight.has(tightKey(ic))) continue;
      perLine[idx].push(it);
      consumed.add(it.uid);
      fallbackLinks += 1;
      taken += qtyOf(it);
    }
  });

  const orphans = candidateItems.filter((it) => !consumed.has(it.uid));
  return { perLine, lineMeta, orphans, stampedLinks, fallbackLinks };
}

// Build the display state for one order: per-line assigned/staged quantities,
// where the parts went, and the resolved flags from the ledger.
function buildOrderAssignment(order, itemsByRef, ledgerEntry, opts = {}) {
  const { archived = false } = opts;
  const key = orderKeyOf(order);
  const candidateItems = candidateItemsFor(order, itemsByRef);

  const { perLine, lineMeta, orphans, stampedLinks, fallbackLinks } = linkOrderItems(order, candidateItems);
  const lines = Array.isArray(order?.lineItems) ? order.lineItems : [];
  const ledgerLines = ledgerEntry?.lines || {};

  const outLines = lines.map((line, idx) => {
    const matched = perLine[idx];
    const orderedQty = Math.abs(Number(line?.quantity) || 0);
    const ledgerLine = ledgerLines[String(idx)] || {};

    let assignedQty = 0;
    let stagedQty = 0;
    const destMap = new Map();
    matched.forEach((it) => {
      const q = qtyOf(it);
      const kind = classifyDestination(it);
      if (kind === 'staging') {
        stagedQty += q;
        return;
      }
      assignedQty += q;
      const name = upper(it.allocated_to) || 'UNKNOWN';
      const prev = destMap.get(name) || { name, qty: 0, kind };
      prev.qty += q;
      destMap.set(name, prev);
    });

    // Assignments recorded in the ledger whose item no longer exists — the
    // bubble was archived out of the live store. Without this an old, fully
    // handled line would read as untouched again.
    const liveUids = new Set(matched.map((it) => it.uid));
    // Destinations that still hold at least one live item for this line.
    // Consolidating a bubble (Stock Flow's "merge same-itemcode rows") folds
    // one row's quantity into a still-live sibling AT THE SAME DESTINATION and
    // deletes the old uid — that uid going non-live is not the same thing as
    // the destination being archived away, and crediting the old ledger record
    // on top of the now-larger live row double-counts it (this is exactly what
    // produced a real "3 of 2 assigned" on BY6821). A destination that's
    // genuinely archived has no live items left at all, so this only
    // suppresses the redundant, same-destination case.
    const liveDestinations = new Set(matched.map((it) => upper(it.allocated_to)));
    (ledgerLine.assignments || []).forEach((a) => {
      // One assign action can span several stock rows (a split plus a freshly
      // materialised row), so an entry only counts as historical once NONE of
      // its rows are live — otherwise the live ones would be double-counted.
      const uids = Array.isArray(a?.itemUids) ? a.itemUids : a?.itemUid ? [a.itemUid] : [];
      if (uids.length && uids.some((u) => liveUids.has(u))) return;
      if (liveDestinations.has(upper(a?.dest))) return;
      const q = Number(a?.qty) || 0;
      if (q <= 0) return;
      assignedQty += q;
      const name = upper(a.dest) || 'UNKNOWN';
      const prev = destMap.get(name) || { name, qty: 0, kind: a.kind || 'customer', historical: true };
      prev.qty += q;
      prev.historical = true;
      destMap.set(name, prev);
    });

    let state = 'unassigned';
    if (assignedQty <= 0) state = matched.length ? 'staged' : 'unassigned';
    else if (orderedQty && assignedQty >= orderedQty) state = 'assigned';
    else state = 'partial';
    if (orderedQty && assignedQty > orderedQty) state = 'over';

    return {
      idx,
      lineKey: lineKeyOf(key, idx),
      partLineCode: line?.partLineCode || '',
      partNumber: line?.partNumber || '',
      itemcode: lineMeta[idx]?.resolvedCode || '',
      description: lineMeta[idx]?.description || line?.partDescription || '',
      cost: line?.costPrice ?? line?.costPriceValue ?? '',
      extended: line?.extended ?? line?.extendedValue ?? '',
      orderedQty,
      assignedQty,
      stagedQty,
      remainingQty: Math.max(0, orderedQty - assignedQty),
      destinations: Array.from(destMap.values()).sort((a, b) => b.qty - a.qty),
      matchedUids: matched.map((it) => it.uid),
      state,
      resolved: ledgerLine.resolved === true,
    };
  });

  const activeLines = outLines.filter((l) => !l.resolved);
  const assignedLines = activeLines.filter((l) => l.state === 'assigned').length;
  const orderState = !activeLines.length
    ? 'resolved'
    : assignedLines === activeLines.length
      ? 'assigned'
      : activeLines.some((l) => l.assignedQty > 0)
        ? 'partial'
        : 'unassigned';

  return {
    orderKey: key,
    reference: order?.reference || '',
    sageReference: order?.sage_reference || '',
    sourceInvoice: order?.source_invoice || '',
    poNumber: order?.poNumber || '',
    source: order?.source || '',
    warehouse: order?.warehouse || order?.seller || '',
    orderDate: order?.orderDate || '',
    orderDateRaw: order?.orderDateRaw || '',
    total: order?.total ?? null,
    isCredit: order?.isCredit === true,
    enteredInSage: order?.enteredInSage === true,
    archived,
    archivedAt: order?.archivedAt || null,
    resolved: ledgerEntry?.resolved === true,
    state: orderState,
    lines: outLines,
    lineCount: outLines.length,
    assignedLineCount: assignedLines,
    // Matcher diagnostics — how much of this order's linkage was guessed.
    diagnostics: {
      stampedLinks,
      fallbackLinks,
      orphanCount: orphans.length,
      orphans: orphans.slice(0, 12).map((it) => ({
        uid: it.uid,
        itemcode: it.itemcode,
        quantity: qtyOf(it),
        allocated_to: it.allocated_to,
      })),
    },
  };
}

// Index every live item by the reference it claims, so each order only scans
// its own candidates instead of the whole store.
function indexItemsByReference(items) {
  const byRef = new Map();
  (items || []).forEach((it) => {
    const ref = upper(it?.reference_num);
    if (!ref) return;
    if (!byRef.has(ref)) byRef.set(ref, []);
    byRef.get(ref).push(it);
  });
  return byRef;
}

// Candidate items for one order, de-duplicated across all the references that
// order answers to.
function candidateItemsFor(order, itemsByRef) {
  const seen = new Set();
  const out = [];
  orderRefCandidates(order).forEach((ref) => {
    (itemsByRef.get(ref) || []).forEach((it) => {
      if (seen.has(it.uid)) return;
      seen.add(it.uid);
      out.push(it);
    });
  });
  return out;
}

const createOrderAssignmentDomain = () => ({
  orderKeyOf,
  lineKeyOf,
  buildOrderAssignment,
  indexItemsByReference,
  classifyDestination,
  STAGING_DESTINATIONS,
});

module.exports = {
  createOrderAssignmentDomain,
  orderKeyOf,
  lineKeyOf,
  buildOrderAssignment,
  indexItemsByReference,
  candidateItemsFor,
  // Exported so the ASSIGN path links lines to items with the exact same rules
  // the display uses. If the two ever diverged, a click would move a different
  // part than the one the row claimed to be about.
  linkOrderItems,
  classifyDestination,
  isStagingDestination: (name) => STAGING_DESTINATIONS.has(upper(name)),
  STAGING_DESTINATIONS,
};
