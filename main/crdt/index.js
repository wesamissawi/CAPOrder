// The seam between the CRDT store and the rest of the app.
//
// Every read/write function the app already had keeps its exact name and
// signature — readOrders(), writeOrders(orders), writePayments(list) — and is
// re-implemented on top of the replicated store. That is deliberate: there are
// well over a hundred call sites across main.js, the IPC handlers and the
// renderer, and rewriting all of them would have made the change impossible to
// review and impossible to roll back. The concurrency fix lives entirely
// underneath the existing API.
//
// The one semantic that changes, and the reason this is safe:
//
//   BEFORE  writeOrders(list) replaced orders.json with `list`. Anything
//           another machine had added since the caller's read was erased.
//   AFTER   writeOrders(list) commits `list` against what the caller was
//           served. Fields it did not touch are untouched, and records it
//           never saw are never removed.
//
// Callers that legitimately mean "remove these" (removeOrdersFromDisk, the
// archive handlers, the Clover pruner) still work, because absence is measured
// against what they read — which is exactly what they were expressing.

const path = require('path');
const fs = require('fs');

const { createStore, CRDT_DIRNAME } = require('./store');
const { seedIfNeeded } = require('./migrate');
const { collapseBubbleIds } = require('./bubbleIds');
const { assignLineKey, assignRecordKey } = require('./entities');

function createCrdtLayer(deps) {
  const {
    machineId,
    getSharedDataDir,
    resolveBusinessPaths,
    getSharedBubbleFile,
    writeJsonAtomic,
    buildOrdersIndex,
    instanceDir,
    onChange,
  } = deps;

  function getCrdtDir() {
    return path.join(getSharedDataDir(), CRDT_DIRNAME);
  }

  // Where the merged state gets written back out. Keys here must match the
  // ones main/crdt/projections.js builds.
  function getProjectionPaths() {
    const r = resolveBusinessPaths();
    return {
      outstanding: r.outstanding,
      sageAr: r.sageAr,
      cashSales: r.cashSales,
      orders: r.orders,
      ordersIndex: r.ordersIndex,
      ordersArchive: r.ordersArchive,
      orderAssignments: r.orderAssignments,
      payments: r.payments,
      sageSalesRuns: r.sageSalesRuns,
      archived: r.archived,
      cloverLedger: r.cloverLedger,
      sharedBubble: getSharedBubbleFile(),
    };
  }

  const store = createStore({
    fs,
    path,
    machineId,
    getCrdtDir,
    getProjectionPaths,
    writeJsonAtomic,
    buildOrdersIndex,
    clockStatePath: path.join(instanceDir, 'crdt_clock.json'),
    onChange,
  });

  // ---- startup -----------------------------------------------------------

  // Order matters and is not cosmetic: load, THEN seed, THEN project.
  //
  // Projecting before the migration has run would write the empty in-memory
  // tables over every business file on the share, and the migration would then
  // read those blanked files and seed nothing. Hence `project: false` on the
  // first load — the projections are written once there is something to write.
  function start() {
    store.load({ project: false });
    const seeded = seedIfNeeded({
      fs,
      path,
      crdtDir: getCrdtDir(),
      machineId,
      paths: getProjectionPaths(),
      store,
    });
    store.refresh();
    // After the refresh, so it sees what every machine has published, and
    // before the projection, so bubble_shared.json is written already collapsed
    // rather than showing duplicates for one write cycle.
    collapseBubbleIds(store);
    store.project();
    return seeded;
  }

  // ---- items -------------------------------------------------------------
  // accountingPath is stored on the record, so the three-queue split is a
  // projection concern only. readItems() returns the same flat, path-stamped
  // list readQueueItems() used to build by reading three files.

  function readItems() {
    return store.read('item');
  }

  // Use these — not readItems/readOrders — on the paths that hand state to the
  // renderer. They snapshot what the UI was shown, which is the baseline a
  // later whole-array save from that UI has to be judged against.
  function checkoutItems() {
    return store.checkout('item');
  }
  function checkoutOrders() {
    return store.checkout('order');
  }
  function checkoutPayments() {
    return store.checkout('payment');
  }

  function readAllQueueItems() {
    const byQueue = { OUTSTANDING: [], SAGE_AR: [], CASH_SALE: [] };
    for (const item of readItems()) {
      const queue = item.accountingPath || 'OUTSTANDING';
      (byQueue[queue] || byQueue.OUTSTANDING).push(item);
    }
    return byQueue;
  }

  // Upsert-only, exactly as before: deletions must be named. `clearFields`
  // covers the one caller that genuinely removes a field (an expired lock).
  function writeItemRecords(items, { deletedUids = [], clearFields = null, fromClient = false } = {}) {
    return store.commit('item', items || [], { deletes: deletedUids, clearFields, fromClient });
  }

  // ---- orders ------------------------------------------------------------

  function readOrders() {
    return store.read('order');
  }
  function writeOrders(orders) {
    return store.commitList('order', orders);
  }
  function readOrdersArchive() {
    return store.read('orderArchive');
  }
  function writeOrdersArchive(orders) {
    return store.commitList('orderArchive', orders);
  }

  // Remove specific orders without touching anything else. Replaces the
  // read-filter-write-back dance in removeOrdersFromDisk, whose whole purpose
  // was to avoid clobbering concurrent additions — now structural.
  function removeOrders(keys) {
    return store.remove('order', keys);
  }

  // ---- shared bubbles ----------------------------------------------------
  // Previously one whole-map read-modify-write per edit. Now one record.

  function readSharedBubbleData() {
    const bubbles = {};
    for (const bubble of store.read('bubble')) {
      if (bubble && bubble.id) bubbles[bubble.id] = bubble;
    }
    return { bubbles };
  }

  function writeSharedBubbleData(bubbleId, payload) {
    if (!bubbleId) return { ok: false, error: 'bubbleId required' };
    try {
      store.read('bubble'); // establish the baseline for this record
      store.commit('bubble', [{ ...(payload || {}), id: bubbleId }]);
      return { ok: true, data: readSharedBubbleData() };
    } catch (e) {
      console.error('[crdt] shared bubble write failed', e);
      return { ok: false, error: e?.message || 'Failed to write shared bubble data' };
    }
  }

  // Deletes by id OR by name, and takes out EVERY record that matches.
  //
  // A bubble record is keyed by whatever id the machine that first saw the
  // bubble happened to mint, and every machine mints its own — the renderer's
  // "ensure a bubble exists for each allocated_to" effect calls makeUid()
  // locally, so one order name routinely exists here as two or three records
  // with different ids. Removing only the id the calling machine holds left the
  // other machines' records alive, and the renderer keeps any bubble whose name
  // is still in the shared set — which is how an order that was sent to CashPad
  // or Returns came straight back as an empty card. The renderer has always
  // passed the name as a second delete for exactly this reason; keyed by id, it
  // silently matched nothing.
  //
  // Safe to be this broad because every caller is a user-initiated "this order
  // stops existing" — and they all exclude the default bubbles (NEW STOCK,
  // SHELF, RETURNS, CASH SALES) before they get here.
  function deleteSharedBubbleData(bubbleId) {
    if (!bubbleId) return { ok: false, error: 'bubbleId required' };
    try {
      const records = store.read('bubble');
      const nameOf = (b) => String(b?.name || '').trim().toLowerCase();
      // The key may be an id or a name — callers send both. Either way, resolve
      // it to the NAME being closed, then take out every record carrying it, so
      // one call is enough and this doesn't depend on the caller also thinking
      // to pass the name separately.
      const wanted = new Set([String(bubbleId).trim().toLowerCase()]);
      records.forEach((b) => {
        if (b && b.id === bubbleId && nameOf(b)) wanted.add(nameOf(b));
      });
      const keys = records
        .filter((b) => b && (b.id === bubbleId || wanted.has(nameOf(b))))
        .map((b) => b.id)
        .filter(Boolean);
      if (!keys.length) return { ok: true, removed: 0 };
      store.remove('bubble', keys);
      return { ok: true, removed: keys.length };
    } catch (e) {
      console.error('[crdt] shared bubble delete failed', e);
      return { ok: false, error: e?.message || 'Failed to delete shared bubble data' };
    }
  }

  // ---- assignment ledger -------------------------------------------------
  // The app passes the whole nested ledger around. Read rebuilds it from the
  // three flat entities; write flattens it back and diffs. Individual lines and
  // individual assignment records therefore merge independently, which is what
  // stops two people working the same order from overwriting each other.

  function readOrderAssignments() {
    const ledger = {};
    const entryFor = (orderKey) => {
      if (!ledger[orderKey]) ledger[orderKey] = { resolved: false, lines: {} };
      return ledger[orderKey];
    };
    const lineFor = (orderKey, idx) => {
      const entry = entryFor(orderKey);
      if (!entry.lines[idx]) entry.lines[idx] = { resolved: false, assignments: [] };
      return entry.lines[idx];
    };

    for (const row of store.read('assignOrder')) entryFor(row.orderKey).resolved = row.resolved === true;
    for (const row of store.read('assignLine')) lineFor(row.orderKey, row.lineIdx).resolved = row.resolved === true;
    for (const row of store.read('assignRecord')) {
      const { orderKey, lineIdx, ...assignment } = row;
      lineFor(orderKey, lineIdx).assignments.push(assignment);
    }
    return ledger;
  }

  function writeOrderAssignments(ledger) {
    const orders = [];
    const lines = [];
    const records = [];
    for (const orderKey of Object.keys(ledger || {})) {
      const entry = ledger[orderKey] || {};
      orders.push({ orderKey, resolved: entry.resolved === true });
      for (const idx of Object.keys(entry.lines || {})) {
        const line = entry.lines[idx] || {};
        lines.push({ orderKey, lineIdx: idx, resolved: line.resolved === true });
        for (const assignment of Array.isArray(line.assignments) ? line.assignments : []) {
          if (assignment) records.push({ ...assignment, orderKey, lineIdx: idx });
        }
      }
    }
    // commitList on records so that removing an assignment (the "return to
    // stock" path filters them out of the array) still deletes it.
    store.commitList('assignOrder', orders);
    store.commitList('assignLine', lines);
    store.commitList('assignRecord', records);
    return { ok: true };
  }

  // ---- money + archives --------------------------------------------------

  const readPayments = () => store.read('payment');
  const writePayments = (payments, { fromClient = false } = {}) => {
    store.commitList('payment', payments, { fromClient });
    return { ok: true };
  };

  const readSageSalesRuns = () => store.read('sageRun');
  const writeSageSalesRuns = (runs) => {
    store.commitList('sageRun', runs);
    return { ok: true };
  };

  const readArchivedEntries = () => store.read('archivedBubble');
  const writeArchivedEntries = (entries) => {
    store.commitList('archivedBubble', entries);
    return { ok: true };
  };

  const readCloverLedger = () => store.read('cloverEntry');
  const writeCloverLedger = (entries) => {
    store.commitList('cloverEntry', entries);
    return { ok: true };
  };

  return {
    store,
    start,
    getCrdtDir,
    getProjectionPaths,
    // items
    readItems,
    checkoutItems,
    checkoutOrders,
    checkoutPayments,
    readAllQueueItems,
    writeItemRecords,
    // orders
    readOrders,
    writeOrders,
    readOrdersArchive,
    writeOrdersArchive,
    removeOrders,
    // bubbles
    readSharedBubbleData,
    writeSharedBubbleData,
    deleteSharedBubbleData,
    // assignments
    readOrderAssignments,
    writeOrderAssignments,
    // money + archives
    readPayments,
    writePayments,
    readSageSalesRuns,
    writeSageSalesRuns,
    readArchivedEntries,
    writeArchivedEntries,
    readCloverLedger,
    writeCloverLedger,
    // conflicts
    listConflicts: store.listConflicts,
    ackConflict: store.ackConflict,
    ackAllConflicts: store.ackAllConflicts,
    refresh: store.refresh,
    stats: store.stats,
  };
}

module.exports = { createCrdtLayer, assignLineKey, assignRecordKey };
