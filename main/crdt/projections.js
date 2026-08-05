// Projections: the merged CRDT state written back out as the same JSON files
// the app has always had.
//
// The CRDT is now the source of truth. These files are a DERIVED VIEW of it —
// kept because a lot depends on them and none of it should have to change:
//
//   * ahk/sage_purchaser.ahk reads orders.json directly.
//   * The backup, .bak and manual-restore workflow on the share is built around
//     readable JSON, and has saved this data before.
//   * Being able to open outstanding_items.json and see what the app sees is
//     worth keeping; a binary CRDT format would have taken that away.
//
// Because they are derived, a projection write that loses a race is harmless.
// Whoever writes next writes the same converged content. That is why failures
// here are logged and swallowed rather than thrown — unlike a write to the op
// log, which is real data and must surface.

const { materializeRecord, recordCreatedAt, isAlive } = require('./merge');
const { splitKey } = require('./entities');

// Materialize a table into an array in a stable, machine-independent order.
// See recordCreatedAt: sorting by birth stamp reproduces insertion order
// identically everywhere, so all machines emit byte-identical files and the
// "did this change?" check below stays meaningful.
function tableToArray(table) {
  const rows = [];
  for (const [key, record] of table) {
    if (!isAlive(record)) continue;
    const value = materializeRecord(record);
    if (!value) continue;
    rows.push({ key, value, born: recordCreatedAt(record) });
  }
  rows.sort((a, b) => (a.born < b.born ? -1 : a.born > b.born ? 1 : a.key < b.key ? -1 : 1));
  return rows;
}

function valuesOf(table) {
  return tableToArray(table).map((r) => r.value);
}

// Build every projection file's content from the merged state. Pure — returns
// { absolutePath: contentString } and touches no disk. Keeping it pure is what
// makes the whole layer testable without a share.
function buildProjections(tables, deps) {
  const { paths, buildOrdersIndex } = deps;
  const out = {};

  const json = (value) => JSON.stringify(value ?? [], null, 2);

  // ---- items: one collection, three files ---------------------------------
  // accountingPath is a field, so the split happens here rather than being
  // baked into identity. A part moving to CashPad keeps its uid and its
  // history; only which file it lands in changes.
  const items = valuesOf(tables.item || new Map());
  const buckets = { OUTSTANDING: [], SAGE_AR: [], CASH_SALE: [] };
  for (const item of items) {
    const queue = item.accountingPath || 'OUTSTANDING';
    (buckets[queue] || buckets.OUTSTANDING).push(item);
  }
  out[paths.outstanding] = json(buckets.OUTSTANDING);
  out[paths.sageAr] = json(buckets.SAGE_AR);
  out[paths.cashSales] = json(buckets.CASH_SALE);

  // ---- orders -------------------------------------------------------------
  const orders = valuesOf(tables.order || new Map());
  const archivedOrders = valuesOf(tables.orderArchive || new Map());
  out[paths.orders] = json(orders);
  out[paths.ordersArchive] = json(archivedOrders);
  // orders_index is derived from the two lists above and has no CRDT records
  // of its own — it never had independent state, so replicating it would only
  // create a way for it to disagree with them.
  if (typeof buildOrdersIndex === 'function') {
    try {
      out[paths.ordersIndex] = json(buildOrdersIndex(orders, archivedOrders));
    } catch (e) {
      console.warn('[crdt/projections] orders index build failed', e?.message || e);
    }
  }

  // ---- bubbles ------------------------------------------------------------
  const bubbles = {};
  for (const bubble of valuesOf(tables.bubble || new Map())) {
    if (bubble && bubble.id) bubbles[bubble.id] = bubble;
  }
  out[paths.sharedBubble] = JSON.stringify({ bubbles }, null, 2);

  // ---- assignment ledger --------------------------------------------------
  // Reassembles the nested { orderKey: { resolved, lines: { idx: { resolved,
  // assignments: [] } } } } shape from the three flat entities.
  const ledger = {};
  const entryFor = (orderKey) => {
    if (!ledger[orderKey]) ledger[orderKey] = { resolved: false, lines: {} };
    return ledger[orderKey];
  };
  const lineFor = (orderKey, idx) => {
    const entry = entryFor(orderKey);
    if (!entry.lines[idx]) entry.lines[idx] = { resolved: false, assignments: [] };
    if (!Array.isArray(entry.lines[idx].assignments)) entry.lines[idx].assignments = [];
    return entry.lines[idx];
  };

  for (const row of tableToArray(tables.assignOrder || new Map())) {
    entryFor(row.key).resolved = row.value.resolved === true;
  }
  for (const row of tableToArray(tables.assignLine || new Map())) {
    const [orderKey, idx] = splitKey(row.key);
    lineFor(orderKey, idx).resolved = row.value.resolved === true;
  }
  for (const row of tableToArray(tables.assignRecord || new Map())) {
    const [orderKey, idx] = splitKey(row.key);
    // The flattening fields are bookkeeping for the CRDT, not part of the
    // record the views read — strip them back off on the way out so the file
    // keeps exactly the shape orderAssignment.domain.js expects.
    const { orderKey: _ok, lineIdx: _li, ...assignment } = row.value;
    lineFor(orderKey, idx).assignments.push(assignment);
  }
  out[paths.orderAssignments] = JSON.stringify(ledger, null, 2);

  // ---- money + archives ---------------------------------------------------
  out[paths.payments] = json(valuesOf(tables.payment || new Map()));
  out[paths.sageSalesRuns] = json(valuesOf(tables.sageRun || new Map()));
  out[paths.archived] = json(valuesOf(tables.archivedBubble || new Map()));
  out[paths.cloverLedger] = json(valuesOf(tables.cloverEntry || new Map()));

  return out;
}

// Write the projections that actually changed.
//
// `lastWritten` is a per-process cache of what we last put on disk, so a save
// that touches one item doesn't rewrite the 3.6MB order archive. Without it,
// every keystroke-sized change would push megabytes over SMB.
// "This projection has no records in it." Cheap structural test rather than a
// parse — the strings here are produced by JSON.stringify two lines above.
function looksEmpty(text) {
  const t = String(text || '').replace(/\s+/g, '');
  return t === '' || t === '[]' || t === '{}' || t === '{"bubbles":{}}';
}

function writeProjections(contents, { fs, path, writeJsonAtomic, lastWritten, allowEmptyOverwrite = true }) {
  const written = [];
  const failed = [];

  for (const file of Object.keys(contents)) {
    const next = contents[file];
    if (lastWritten.get(file) === next) continue;

    // Refuse to blank a populated file while the store itself is empty. That
    // combination only arises when something has gone wrong upstream — the
    // store failed to load, or projections ran before the migration seeded —
    // and the cost of being wrong is the entire share.
    if (!allowEmptyOverwrite && looksEmpty(next)) {
      try {
        if (fs.existsSync(file) && fs.statSync(file).size > 2) {
          console.warn(
            '[crdt/projections] refusing to overwrite populated',
            path.basename(file),
            'with an empty projection — store holds no records'
          );
          continue;
        }
      } catch {
        // Can't tell what's there; the refusal is the safe default.
        continue;
      }
    }

    // First write of the process: compare against what is already on disk
    // before deciding, so a restart doesn't rewrite every file for nothing.
    if (!lastWritten.has(file)) {
      try {
        if (fs.existsSync(file) && fs.readFileSync(file, 'utf-8') === next) {
          lastWritten.set(file, next);
          continue;
        }
      } catch {
        // Unreadable — fall through and write it.
      }
    }

    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      writeJsonAtomic(file, next);
      lastWritten.set(file, next);
      written.push(path.basename(file));
    } catch (e) {
      // Derived data: losing this write costs nothing, because the next apply
      // on this or any other machine regenerates identical content. Do not
      // throw — an unwritable projection must never fail the op it describes,
      // which is already durably in the log.
      failed.push(path.basename(file));
      console.warn('[crdt/projections] write failed (will retry next apply)', path.basename(file), e?.message || e);
      lastWritten.delete(file);
    }
  }

  return { written, failed };
}

module.exports = { buildProjections, writeProjections, tableToArray, valuesOf };
