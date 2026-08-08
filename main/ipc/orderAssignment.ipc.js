// IPC for the Order Assignment view.
//
// Read-only for now (phase 2): it computes, for every order line, where that
// line's parts currently sit. The linkage and CAP-code resolution both live in
// the main process on purpose — see main/domain/orderAssignment.domain.js.
//
// Filtering happens BEFORE the assignment state is built. The archive holds
// ~1000 orders and building state resolves CAP rules for every line, so
// narrowing first is what keeps this responsive.
const {
  buildOrderAssignment,
  indexItemsByReference,
  candidateItemsFor,
  linkOrderItems,
  classifyDestination,
  isStagingDestination,
  orderKeyOf,
  ledgerKeyCandidates,
  resolveLedgerEntry,
  normalizeLedgerKeys,
} = require('../domain/orderAssignment.domain');
const { orderLooksLikeCredit } = require('../../src/scrapers/creditShape');

const upper = (v) => String(v ?? '').trim().toUpperCase();

function orderTimeMs(order) {
  const candidates = [order?.orderDate, order?.archivedAt, order?.lastUpdatedAt];
  for (const c of candidates) {
    const t = Date.parse(c);
    if (!Number.isNaN(t)) return t;
  }
  return 0;
}

// Cheap text match over the order header and its raw line codes. Deliberately
// works off the raw order (not the built assignment) so it can run before the
// expensive step.
function orderMatchesSearch(order, needle) {
  if (!needle) return true;
  const hay = [
    order?.reference,
    order?.sage_reference,
    order?.source_invoice,
    order?.poNumber,
    order?.warehouse,
    order?.seller,
    order?.source,
    order?.orderedBy,
  ]
    .map(upper)
    .join(' ');
  if (hay.includes(needle)) return true;
  return (Array.isArray(order?.lineItems) ? order.lineItems : []).some((l) =>
    `${upper(l?.partLineCode)} ${upper(l?.partNumber)} ${upper(l?.partDescription)}`.includes(needle)
  );
}

function registerOrderAssignmentIpc(ipcMain, deps) {
  const {
    readOrders,
    readOrdersArchive,
    readItems,
    writeItems,
    readOrderAssignments,
    writeOrderAssignments,
    getOrderAssignmentsFile,
    makeOutstandingFromLine,
    patchOrderOnDisk,
    writeOrdersArchive,
    randomUUID,
    readSharedBubbleData,
  } = deps;

  // Bubble names that have at least one payment assigned to them, upper-cased
  // to match how destinations are keyed. Optional dep: an older wiring that
  // doesn't pass it just means nothing gets excluded on this basis, never a
  // crash in the middle of building the view.
  function paidBubbleNames() {
    const names = new Set();
    try {
      const shared = readSharedBubbleData ? readSharedBubbleData() : null;
      const bubbles = shared?.bubbles;
      if (!bubbles || typeof bubbles !== 'object') return names;
      Object.values(bubbles).forEach((b) => {
        if (!Array.isArray(b?.paymentIds) || !b.paymentIds.filter(Boolean).length) return;
        const name = upper(b?.name);
        if (name) names.add(name);
      });
    } catch (e) {
      console.error('[order-assignment] failed reading shared bubble data', e);
    }
    return names;
  }

  // Bubble names whose "No New Parts" checkbox is checked on the Sales Order
  // card — a deliberate signal that the order is done taking on newly arrived
  // parts, so it shouldn't keep showing up as an arm-bar quick-pick here. It
  // has no effect on parts already assigned to it.
  function noNewPartsBubbleNames() {
    const names = new Set();
    try {
      const shared = readSharedBubbleData ? readSharedBubbleData() : null;
      const bubbles = shared?.bubbles;
      if (!bubbles || typeof bubbles !== 'object') return names;
      Object.values(bubbles).forEach((b) => {
        if (b?.noNewParts !== true) return;
        const name = upper(b?.name);
        if (name) names.add(name);
      });
    } catch (e) {
      console.error('[order-assignment] failed reading shared bubble data', e);
    }
    return names;
  }

  // Locate an order by key across both the active list and the archive, and
  // report which one it came from — assignment has to write the line's
  // addedToOutstanding flag back to whichever file actually holds it.
  //
  // Matches on ANY reference the order answers to, not just its current key:
  // items stamped with order_key before the order picked up its invoice number
  // still carry the old one (see ledgerKeyCandidates).
  function findOrder(orderKey) {
    const matches = (o) => ledgerKeyCandidates(o).includes(orderKey);
    const active = (readOrders() || []).find(matches);
    if (active) return { order: active, archived: false };
    const archived = (readOrdersArchive() || []).find(matches);
    if (archived) return { order: archived, archived: true };
    return { order: null, archived: false };
  }

  // Read the ledger with one order's stray keys already folded onto its
  // canonical key, so every lookup and write below can just use that key.
  // `moved` is returned so a handler that changes nothing else still persists
  // the fold.
  function readLedgerFor(orders) {
    const { ledger, moved } = normalizeLedgerKeys(readOrderAssignments(), orders);
    return { ledger, moved };
  }

  // Mark a line as materialised so archiving never adds it to NEW STOCK a
  // second time.
  //
  // This matters: addOrderLineItemsToNewStock() skips lines already flagged
  // addedToOutstanding, and it is the ONLY thing standing between an assigned
  // part and a duplicate stock row appearing when the order is later archived.
  // Per the agreed model, an unassigned remainder deliberately stays on the
  // order line rather than piling into a bubble, so flagging the whole line the
  // first time any of it is assigned is correct.
  function markLineMaterialised(orderKey, lineIdx, archived) {
    const stamp = (order) => {
      const lines = Array.isArray(order?.lineItems) ? order.lineItems : [];
      if (!lines[lineIdx]) return null;
      const next = lines.map((l, i) => (i === lineIdx ? { ...l, addedToOutstanding: true } : l));
      return { lineItems: next };
    };

    if (!archived) {
      patchOrderOnDisk(orderKey, stamp);
      return;
    }
    const archive = readOrdersArchive() || [];
    let touched = false;
    const next = archive.map((o) => {
      if (touched || orderKeyOf(o) !== orderKey) return o;
      const patch = stamp(o);
      if (!patch) return o;
      touched = true;
      return { ...o, ...patch };
    });
    if (touched) writeOrdersArchive(next);
  }

  function ledgerLineFor(ledger, orderKey, lineIdx) {
    const entry = ledger[orderKey] || { resolved: false, lines: {} };
    entry.lines = entry.lines || {};
    const key = String(lineIdx);
    entry.lines[key] = entry.lines[key] || { resolved: false, assignments: [] };
    entry.lines[key].assignments = entry.lines[key].assignments || [];
    ledger[orderKey] = entry;
    return entry.lines[key];
  }

  ipcMain.handle('order-assignment:read', (_evt, opts = {}) => {
    try {
      const scope = ['active', 'archived', 'all'].includes(opts?.scope) ? opts.scope : 'all';
      const needle = upper(opts?.search);
      const days = Number.isFinite(Number(opts?.days)) ? Number(opts.days) : 30;
      const limit = Number.isFinite(Number(opts?.limit)) ? Math.max(1, Number(opts.limit)) : 200;
      const includeResolved = opts?.includeResolved === true;
      // Credits (Transbec credit memos etc.) aren't purchases with parts to
      // hand out — they're money coming back — so they don't belong in a view
      // about where parts went. Hidden by default; the checkbox opts back in.
      const includeCredits = opts?.includeCredits === true;

      const items = readItems();
      const itemsByRef = indexItemsByReference(items);

      const allActive = readOrders() || [];
      const allArchived = readOrdersArchive() || [];

      // Repair key drift here rather than in a one-shot migration script: the
      // drift happens continuously (every order that later gains an invoice
      // number), so it has to be healed continuously. The scan is over both
      // order lists we already read, and the write only happens when something
      // actually moved.
      const { ledger, moved } = readLedgerFor([...allActive, ...allArchived]);
      if (moved) writeOrderAssignments(ledger);

      const active = scope === 'archived' ? [] : allActive;
      const archived = scope === 'active' ? [] : allArchived;

      const cutoff = days > 0 ? Date.now() - days * 86400000 : 0;

      const tagged = [
        ...active.map((o) => ({ order: o, archived: false })),
        // The active window is small and always fully shown; only the archive
        // gets the date cutoff, since that's the list that grows without bound.
        ...archived
          .filter((o) => !cutoff || orderTimeMs(o) >= cutoff)
          .map((o) => ({ order: o, archived: true })),
      ].filter(
        ({ order }) =>
          order && orderMatchesSearch(order, needle) && (includeCredits || !orderLooksLikeCredit(order))
      );

      tagged.sort((a, b) => orderTimeMs(b.order) - orderTimeMs(a.order));

      const totalMatched = tagged.length;
      const page = tagged.slice(0, limit);

      const built = page.map(({ order, archived: isArchived }) =>
        buildOrderAssignment(order, itemsByRef, resolveLedgerEntry(ledger, order), { archived: isArchived })
      );

      const visible = includeResolved ? built : built.filter((o) => !o.resolved);

      // Roll the per-order matcher diagnostics up into one number the view can
      // show plainly. This is the whole point of shipping read-only first: if
      // fallback links dominate or orphans are high, the linkage can't be
      // trusted yet and the write path shouldn't be built on it.
      const diagnostics = visible.reduce(
        (acc, o) => {
          acc.stampedLinks += o.diagnostics.stampedLinks;
          acc.fallbackLinks += o.diagnostics.fallbackLinks;
          acc.orphanCount += o.diagnostics.orphanCount;
          return acc;
        },
        { stampedLinks: 0, fallbackLinks: 0, orphanCount: 0 }
      );

      const totals = visible.reduce(
        (acc, o) => {
          acc.orders += 1;
          o.lines.forEach((l) => {
            if (l.resolved) {
              acc.resolvedLines += 1;
              return;
            }
            acc.lines += 1;
            if (l.state === 'assigned') acc.assignedLines += 1;
            else if (l.state === 'partial') acc.partialLines += 1;
            else if (l.state === 'staged') acc.stagedLines += 1;
            else acc.unassignedLines += 1;
          });
          return acc;
        },
        {
          orders: 0,
          lines: 0,
          assignedLines: 0,
          partialLines: 0,
          stagedLines: 0,
          unassignedLines: 0,
          resolvedLines: 0,
        }
      );

      // Every destination parts are currently sitting in, so the arm bar can
      // offer real bubbles instead of making the user retype names (and risk
      // creating "VIELLI " as a second destination alongside "VIELLI").
      //
      // Cash sales are left out. Auto-fill from CashPad mints one bubble per
      // payment ("INTERAC $40.00"), so within days they outnumber the real
      // customer destinations here — and they're the wrong thing to assign to
      // anyway: a payment that already happened can't take on new parts.
      // CASHPAD itself stays, since it IS the staging pool you send parts to
      // before Auto-fill splits them into those bubbles.
      //
      // A bubble with a payment assigned to it is excluded on the same grounds
      // and catches the rest: the accounting path lives on the ITEMS, so a
      // VISA/MASTERCARD bubble whose parts arrived by a route that left them on
      // OUTSTANDING reads as a plain customer destination — but money has
      // already been collected against it either way.
      const paidNames = paidBubbleNames();
      const noNewPartsNames = noNewPartsBubbleNames();
      const destCounts = new Map();
      items.forEach((it) => {
        const name = upper(it?.allocated_to);
        if (!name || isStagingDestination(name)) return;
        if (name === 'CASHPAD') {
          const prev = destCounts.get(name) || { name, items: 0, kind: 'cash' };
          prev.items += 1;
          destCounts.set(name, prev);
          return;
        }
        if (paidNames.has(name)) return;
        if (noNewPartsNames.has(name)) return;
        const kind = classifyDestination(it);
        if (kind === 'cash') return;
        const prev = destCounts.get(name) || { name, items: 0, kind };
        prev.items += 1;
        destCounts.set(name, prev);
      });
      const destinations = Array.from(destCounts.values()).sort((a, b) =>
        a.name.localeCompare(b.name)
      );

      return {
        ok: true,
        orders: visible,
        destinations,
        totals,
        diagnostics,
        truncated: totalMatched > page.length,
        totalMatched,
        itemCount: items.length,
        path: getOrderAssignmentsFile(),
      };
    } catch (e) {
      console.error('[order-assignment:read]', e);
      return { ok: false, error: e?.message || 'Failed to build order assignments.', orders: [] };
    }
  });

  // Hide a line (or a whole order) that's been dealt with. Purely a display
  // flag — it never touches stock.
  ipcMain.handle('order-assignment:set-resolved', (_evt, payload = {}) => {
    try {
      const requestedKey = upper(payload?.orderKey);
      if (!requestedKey) return { ok: false, error: 'Missing order key.' };
      const resolved = payload?.resolved !== false;
      const lineIdx = payload?.lineIdx;
      // Fold any stray keys first, then file the flag under the canonical one,
      // so resolving a line can't leave the flag on a key the view stops
      // reading the moment the order picks up its invoice number.
      const { order } = findOrder(requestedKey);
      const orderKey = order ? orderKeyOf(order) : requestedKey;
      const { ledger } = readLedgerFor(order ? [order] : []);
      const entry = ledger[orderKey] || { resolved: false, lines: {} };
      entry.lines = entry.lines || {};

      if (lineIdx === null || lineIdx === undefined) {
        entry.resolved = resolved;
      } else {
        const idx = String(Number(lineIdx));
        entry.lines[idx] = { ...(entry.lines[idx] || {}), resolved };
      }

      ledger[orderKey] = entry;
      writeOrderAssignments(ledger);
      return { ok: true };
    } catch (e) {
      console.error('[order-assignment:set-resolved]', e);
      return { ok: false, error: e?.message || 'Failed to update resolved flag.' };
    }
  });

  // Assign some quantity of one order line to a destination.
  //
  // Two sources, in this order:
  //   1. Rows already sitting in NEW STOCK for this line — moved (or split) out
  //      of staging. Always preferred: the part is physically here already, and
  //      leaving it staged while creating a second row would double the stock.
  //   2. Whatever's left is materialised straight from the order line, skipping
  //      the NEW STOCK hop entirely (the agreed model).
  ipcMain.handle('order-assignment:assign', (_evt, payload = {}) => {
    try {
      const requestedKey = upper(payload?.orderKey);
      const lineIdx = Number(payload?.lineIdx);
      const destination = upper(payload?.destination);
      const wanted = Math.floor(Number(payload?.qty));

      if (!requestedKey) return { ok: false, error: 'Missing order key.' };
      if (!Number.isInteger(lineIdx) || lineIdx < 0) return { ok: false, error: 'Missing line index.' };
      if (!destination) return { ok: false, error: 'Pick a destination first.' };
      if (isStagingDestination(destination)) {
        return { ok: false, error: `"${destination}" is where unassigned parts already sit — pick a real destination.` };
      }
      if (!Number.isInteger(wanted) || wanted <= 0) return { ok: false, error: 'Quantity must be a whole number above zero.' };

      const { order, archived } = findOrder(requestedKey);
      if (!order) return { ok: false, error: `Order ${requestedKey} not found.` };
      const orderKey = orderKeyOf(order);
      const line = (Array.isArray(order.lineItems) ? order.lineItems : [])[lineIdx];
      if (!line) return { ok: false, error: `Line ${lineIdx} not found on ${orderKey}.` };

      const items = readItems();
      const { ledger } = readLedgerFor([order]);
      const itemsByRef = indexItemsByReference(items);

      // Same matcher the view uses, so "2 of 4 assigned" and what this moves
      // can never disagree.
      const state = buildOrderAssignment(order, itemsByRef, ledger[orderKey], { archived });
      const lineState = state.lines[lineIdx];
      const remaining = lineState ? lineState.remainingQty : 0;
      if (remaining <= 0) {
        return { ok: false, error: 'This line is already fully assigned.' };
      }
      const qty = Math.min(wanted, remaining);

      const { perLine } = linkOrderItems(order, candidateItemsFor(order, itemsByRef));
      const matched = perLine[lineIdx] || [];
      const nowIso = new Date().toISOString();
      const upserts = [];
      const touchedUids = [];
      let need = qty;

      // 1. Drain staged rows first.
      for (const it of matched) {
        if (need <= 0) break;
        if (classifyDestination(it) !== 'staging') continue;
        const have = Number(it.quantity) || 0;
        if (have <= 0) continue;

        if (have <= need) {
          upserts.push({
            ...it,
            allocated_to: destination,
            last_moved_at: nowIso,
          });
          touchedUids.push(it.uid);
          need -= have;
        } else {
          // Partial: shrink the staged row and spin off a new one for the move,
          // mirroring how Stock Flow's own split works.
          upserts.push({
            ...it,
            quantity: have - need,
            last_moved_at: nowIso,
          });
          const spawn = {
            ...it,
            uid: randomUUID(),
            quantity: need,
            allocated_to: destination,
            last_moved_at: nowIso,
          };
          upserts.push(spawn);
          touchedUids.push(spawn.uid);
          need = 0;
        }
      }

      // 2. Materialise the rest straight from the line.
      let materialised = false;
      if (need > 0) {
        const fresh = {
          ...makeOutstandingFromLine(order, line, lineIdx),
          quantity: need,
          allocated_to: destination,
        };
        upserts.push(fresh);
        touchedUids.push(fresh.uid);
        materialised = true;
        need = 0;
      }

      if (!upserts.length) return { ok: false, error: 'Nothing to assign.' };

      writeItems(upserts);

      // Only stamp the order once a row was created from it; a pure staged move
      // means the line had already been added.
      if (materialised) markLineMaterialised(orderKey, lineIdx, archived);

      const ledgerLine = ledgerLineFor(ledger, orderKey, lineIdx);
      ledgerLine.assignments.push({
        id: randomUUID(),
        qty,
        dest: destination,
        kind: classifyDestination({ allocated_to: destination, accountingPath: 'OUTSTANDING' }),
        itemUids: touchedUids,
        // Stored as a drift guard: reconcileTotals can rewrite lineItems and
        // shift indices, and a mismatch here means the ledger entry no longer
        // describes the line it's filed under.
        partNumber: line.partNumber || '',
        at: nowIso,
      });
      writeOrderAssignments(ledger);

      // itemUids lets the renderer track "parts touched this session" for the
      // Stop review modal, without needing its own copy of the matcher.
      return { ok: true, assigned: qty, requested: wanted, destination, materialised, itemUids: touchedUids };
    } catch (e) {
      console.error('[order-assignment:assign]', e);
      return { ok: false, error: e?.message || 'Failed to assign.' };
    }
  });

  // Send a line's parts back from a destination to NEW STOCK.
  //
  // Deliberately NOT a delete: the parts were really bought and are really
  // here, so undoing an assignment returns them to staging rather than
  // destroying stock.
  ipcMain.handle('order-assignment:unassign', (_evt, payload = {}) => {
    try {
      const requestedKey = upper(payload?.orderKey);
      const lineIdx = Number(payload?.lineIdx);
      const destination = upper(payload?.destination);
      if (!requestedKey || !Number.isInteger(lineIdx) || !destination) {
        return { ok: false, error: 'Missing order, line or destination.' };
      }

      const { order } = findOrder(requestedKey);
      if (!order) return { ok: false, error: `Order ${requestedKey} not found.` };
      const orderKey = orderKeyOf(order);

      const items = readItems();
      const { ledger, moved } = readLedgerFor([order]);
      let ledgerDirty = moved > 0;
      const itemsByRef = indexItemsByReference(items);
      const { perLine } = linkOrderItems(order, candidateItemsFor(order, itemsByRef));
      const matched = (perLine[lineIdx] || []).filter((it) => upper(it.allocated_to) === destination);

      const nowIso = new Date().toISOString();
      const upserts = matched.map((it) => ({
        ...it,
        allocated_to: 'NEW STOCK',
        // Back to the plain stock queue: a part that's no longer promised to
        // anyone must not stay in the Sage AR or CashPad queue.
        accountingPath: 'OUTSTANDING',
        last_moved_at: nowIso,
      }));

      let returned = upserts.reduce((sum, it) => sum + (Number(it.quantity) || 0), 0);
      if (upserts.length) writeItems(upserts);

      // Drop the ledger entries for this destination too, otherwise they'd be
      // treated as archived-out history and keep counting toward "assigned".
      const entry = ledger[orderKey];
      const ledgerLine = entry?.lines?.[String(lineIdx)];
      if (ledgerLine?.assignments?.length) {
        const kept = ledgerLine.assignments.filter((a) => upper(a?.dest) !== destination);
        if (kept.length !== ledgerLine.assignments.length) {
          if (!returned) {
            returned = ledgerLine.assignments
              .filter((a) => upper(a?.dest) === destination)
              .reduce((sum, a) => sum + (Number(a.qty) || 0), 0);
          }
          ledgerLine.assignments = kept;
          ledgerDirty = true;
        }
      }
      if (ledgerDirty) writeOrderAssignments(ledger);

      if (!returned) return { ok: false, error: `Nothing assigned to ${destination} on this line.` };
      // So the renderer can drop these uids from its "touched this session" set
      // — a part just sent back to New Stock is no longer part of what's new.
      return { ok: true, returned, destination, itemUids: upserts.map((it) => it.uid) };
    } catch (e) {
      console.error('[order-assignment:unassign]', e);
      return { ok: false, error: e?.message || 'Failed to unassign.' };
    }
  });

  // Unassign a SINGLE stock item, by uid — the Sales Order view's per-line
  // "Remove" button. `order-assignment:unassign` above works at the ORDER
  // LINE + destination level (it's driven from Order Assignment, which only
  // knows "this line, this destination"); here the caller already has a
  // specific stock row in hand, so this is scoped to exactly that row and
  // never touches a sibling row that happens to share the same line and
  // destination (e.g. after a partial assign left two rows behind).
  ipcMain.handle('order-assignment:unassign-item', (_evt, payload = {}) => {
    try {
      const uid = payload?.uid;
      if (!uid) return { ok: false, error: 'Missing item uid.' };

      // Where the part is headed. Defaults to NEW STOCK so an older caller that
      // doesn't send one behaves exactly as before. RETURNS is for a part going
      // back to the warehouse; CASHPAD puts it on the cash-sale path, which is
      // what makes this usable from the New Stock pool as well as from an order.
      const DESTINATIONS = new Set(['NEW STOCK', 'RETURNS', 'CASHPAD']);
      const destination = upper(payload?.destination) || 'NEW STOCK';
      if (!DESTINATIONS.has(destination)) {
        return { ok: false, error: `Unsupported destination "${destination}".` };
      }

      const items = readItems();
      const item = items.find((it) => it.uid === uid);
      if (!item) return { ok: false, error: 'Item not found.' };
      // The old guard was "already unassigned", which also blocked the moves
      // this now has to allow (New Stock -> CashPad/Returns). The thing actually
      // worth refusing is a move that wouldn't change anything.
      if (upper(item.allocated_to) === destination) {
        return { ok: false, error: `This part is already in ${destination}.` };
      }
      // Whether the part is leaving a real customer order, as opposed to being
      // pushed out of a staging pool. Only the former is an unassignment, and
      // only the former should touch the assignment ledger below.
      const wasAllocated = !isStagingDestination(item.allocated_to);

      const nowIso = new Date().toISOString();
      const moved = {
        ...item,
        allocated_to: destination,
        accountingPath: destination === 'CASHPAD' ? 'CASH_SALE' : 'OUTSTANDING',
        // A requisition slip belongs to the part only while it's in RETURNS —
        // carrying a stale slip link out of Returns would put it back on a slip
        // it's no longer part of.
        ...(destination === 'RETURNS'
          ? {}
          : { return_slip_id: '', return_slip_date: '', return_slip_po: '', return_slip_status: '' }),
        last_moved_at: nowIso,
      };
      writeItems([moved]);

      // If this item was created via an Order Assignment click, its stamp
      // lets us trim the EXACT ledger record(s) crediting it — otherwise
      // Order Assignment would still show it as assigned (via the same
      // durability fallback that keeps a line "assigned" after its bubble is
      // archived) even though the part just left the destination. A legacy
      // item with no stamp was only ever matched by the read-side fallback
      // (reference + code), which recomputes straight from allocated_to on
      // every read — moving it is enough, there's no ledger entry to trim.
      // The stamp holds whatever key the order had when the row was created,
      // which is the OLD one for anything assigned before the invoice number
      // landed — so resolve it back to an order before touching the ledger.
      const stampedKey = upper(item.order_key);
      const lineIdx = Number(item.order_line_idx);
      if (wasAllocated && stampedKey && Number.isInteger(lineIdx)) {
        const { order } = findOrder(stampedKey);
        const orderKey = order ? orderKeyOf(order) : stampedKey;
        const { ledger, moved: movedKeys } = readLedgerFor(order ? [order] : []);
        let touched = movedKeys > 0;
        const ledgerLine = ledger[orderKey]?.lines?.[String(lineIdx)];
        if (ledgerLine?.assignments?.length) {
          let trimmed = false;
          const nextAssignments = ledgerLine.assignments
            .map((a) => {
              const uids = Array.isArray(a?.itemUids) ? a.itemUids : a?.itemUid ? [a.itemUid] : [];
              if (!uids.includes(uid)) return a;
              trimmed = true;
              const remaining = uids.filter((u) => u !== uid);
              if (!remaining.length) return null; // the whole record was this row
              // One assign call can span several rows (shrink-staged + spawn-new);
              // this uid's own quantity is what's leaving, so subtract just that
              // much rather than dropping the record's whole qty, which still
              // describes the surviving row(s).
              return {
                ...a,
                itemUids: remaining,
                qty: Math.max(0, (Number(a.qty) || 0) - (Number(item.quantity) || 0)),
              };
            })
            .filter(Boolean);
          if (trimmed) {
            ledgerLine.assignments = nextAssignments;
            touched = true;
          }
        }
        if (touched) writeOrderAssignments(ledger);
      }

      return {
        ok: true,
        returned: Number(item.quantity) || 0,
        destination,
        from: upper(item.allocated_to),
      };
    } catch (e) {
      console.error('[order-assignment:unassign-item]', e);
      return { ok: false, error: e?.message || 'Failed to unassign item.' };
    }
  });

  // Bulk-resolve everything ordered before a cutoff.
  //
  // Needed because assignment tracking starts now: every order predating it has
  // long since had its bubbles archived out of the live item store, so its lines
  // read as "unassigned" when really they're just untracked. Without a way to
  // clear that backlog in one action the view opens onto ~1800 lines of noise
  // and nobody will use it.
  ipcMain.handle('order-assignment:resolve-before', (_evt, payload = {}) => {
    try {
      const cutoff = Date.parse(payload?.before);
      if (Number.isNaN(cutoff)) return { ok: false, error: 'Invalid cutoff date.' };

      const allOrders = [...(readOrders() || []), ...(readOrdersArchive() || [])];
      const { ledger, moved } = readLedgerFor(allOrders);
      let resolvedCount = 0;
      allOrders.forEach((order) => {
        if (!order) return;
        const t = orderTimeMs(order);
        // An order with no usable date is left alone rather than swept up —
        // resolving something by accident hides it from the person who needs it.
        if (!t || t >= cutoff) return;
        const key = orderKeyOf(order);
        if (!key) return;
        const entry = ledger[key] || { resolved: false, lines: {} };
        if (entry.resolved === true) return;
        entry.resolved = true;
        entry.resolvedReason = 'bulk-before-cutoff';
        entry.resolvedAt = new Date().toISOString();
        ledger[key] = entry;
        resolvedCount += 1;
      });

      if (resolvedCount || moved) writeOrderAssignments(ledger);
      return { ok: true, resolved: resolvedCount };
    } catch (e) {
      console.error('[order-assignment:resolve-before]', e);
      return { ok: false, error: e?.message || 'Failed to bulk-resolve orders.' };
    }
  });
}

module.exports = { registerOrderAssignmentIpc };
