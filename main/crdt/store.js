// The replicated store. Everything in the app reads and writes through here.
//
// Shape of the shared folder after this refactor:
//
//   <share>/
//     crdt/
//       ops/<machineId>.jsonl     append-only, single-writer, the truth
//       snapshot.json             compacted merge, derived, an optimisation
//     outstanding_items.json      projection
//     orders.json                 projection
//     ...                         projection
//
// Only the ops are authoritative. Delete snapshot.json and every projection and
// the exact same state rebuilds from the logs — which is a property worth
// having on a machine that has lost data to a bad write before.
//
// The read/write cycle:
//   read()    materializes the merged state AND records what it handed out
//   commit()  diffs the caller's new value against what it was handed,
//             turning a whole-array save into only the fields that changed
//   apply()   folds ops (local or remote) into memory, flags conflicts,
//             rewrites the projections that changed, notifies listeners

const { createClock, compareHlc, hlcMillis } = require('./hlc');
const {
  applyOpToTable,
  createTable,
  materializeRecord,
  recordVersion,
  diffToOp,
  deleteOp,
  isAlive,
} = require('./merge');
const { ENTITY_NAMES, entityDef, describeRecord } = require('./entities');
const { appendOps, readLogFrom, listLogs, ensureOpsDir, logPathFor, compactOwnLog } = require('./oplog');
const { buildProjections, writeProjections, valuesOf } = require('./projections');
const { createConflictLog } = require('./conflicts');

const SNAPSHOT_VERSION = 1;
const SNAPSHOT_FILENAME = 'snapshot.json';
const CRDT_DIRNAME = 'crdt';

// Rewrite the shared snapshot once this many ops have been folded in since the
// last one. Purely an optimisation: the snapshot only saves startup time.
const SNAPSHOT_EVERY_OPS = 400;
// Trim our own log once it passes this size and the snapshot already covers it.
const COMPACT_LOG_BYTES = 2 * 1024 * 1024;
// Compaction keeps this much recent history rather than truncating to nothing.
//
// A machine that is RUNNING only ever tails logs from its last byte offset; it
// re-reads the snapshot at startup and never again. So if we trimmed our log to
// empty, ops we appended in the seconds before the trim would be dropped by any
// peer that hadn't tailed them yet — it would see the file shrink, restart at
// offset 0, and find nothing there. Retaining a window far longer than the
// 5-second poll closes that hole; the trim is about unbounded growth, and
// keeping a few minutes costs nothing against a 2MB threshold.
const COMPACT_RETAIN_MS = 30 * 60 * 1000;

function createStore(deps) {
  const {
    fs,
    path,
    machineId,
    getCrdtDir,        // () => <share>/crdt
    getProjectionPaths, // () => { outstanding, orders, ... }
    writeJsonAtomic,
    buildOrdersIndex,
    clockStatePath,     // instance-local file holding the HLC across restarts
    onChange,           // (summary) => void
  } = deps;

  // ---- clock -------------------------------------------------------------
  const clock = createClock({
    machineId,
    load: () => {
      try {
        if (!fs.existsSync(clockStatePath)) return null;
        return JSON.parse(fs.readFileSync(clockStatePath, 'utf-8'));
      } catch {
        return null;
      }
    },
    persist: (state) => {
      fs.mkdirSync(path.dirname(clockStatePath), { recursive: true });
      fs.writeFileSync(clockStatePath, JSON.stringify(state), 'utf-8');
    },
  });

  // ---- in-memory state ---------------------------------------------------
  const tables = {};
  ENTITY_NAMES.forEach((name) => { tables[name] = createTable(); });

  // Byte offset we have consumed up to in each machine's log.
  const offsets = new Map();
  const conflicts = createConflictLog();
  const lastWrittenProjection = new Map();

  // Two baselines, because there are two kinds of writer and they need
  // different answers to "what did you think the state was?".
  //
  // `served` — refreshed by every read(). Right for main-process code that
  //   reads, modifies and writes back in one go: it is up to date by
  //   construction, so only the fields it deliberately touched differ.
  //
  // `checkedOut` — captured only when state is handed to the RENDERER, and NOT
  //   disturbed by main-process reads in between. Right for a whole-array save
  //   coming back from the UI, which may be minutes old. Diffing that against a
  //   fresh read would treat every field another machine changed meanwhile as a
  //   deliberate edit and revert it — which is the original bug wearing a new
  //   hat. Diffing against what the renderer was actually shown does not.
  const served = {};
  const checkedOut = {};
  ENTITY_NAMES.forEach((name) => {
    served[name] = new Map();
    checkedOut[name] = new Map();
  });

  let opsSinceSnapshot = 0;
  let loaded = false;

  function snapshotPath() {
    return path.join(getCrdtDir(), SNAPSHOT_FILENAME);
  }

  // ---- applying ops ------------------------------------------------------

  function applyOps(ops) {
    if (!ops || !ops.length) return { applied: 0, touched: new Set(), newConflicts: [] };
    const touched = new Set();
    const newConflicts = [];
    let applied = 0;

    for (const op of ops) {
      if (!tables[op.e]) continue; // an entity this build doesn't know about
      // Advance our clock past anything we observe. This is what keeps logical
      // time monotonic across machines whose wall clocks disagree.
      clock.observe(op.h);
      const changed = applyOpToTable(tables[op.e], op, (detail) => {
        const conflict = conflicts.record(op.e, detail.key, detail);
        if (conflict) newConflicts.push(conflict);
      });
      if (changed) {
        touched.add(op.e);
        applied += 1;
      }
    }

    // Attach a human description to any conflict raised above, now that the
    // records involved are fully merged.
    for (const conflict of newConflicts) {
      const record = tables[conflict.entity]?.get(conflict.key);
      if (record) conflicts.describe(conflict.entity, conflict.key, materializeRecord(record));
    }

    opsSinceSnapshot += applied;
    return { applied, touched, newConflicts };
  }

  // Record how far our own log we have consumed.
  //
  // Our appends are applied straight to memory by commit(), so nothing ever
  // tails them back in and this offset would otherwise never move. That is not
  // cosmetic: writeSnapshot() publishes these offsets as its claim about what
  // the snapshot covers, and maybeCompactOwnLog() refuses to trim while the
  // snapshot claims less than the log holds. Left unadvanced during the initial
  // seed — one commit of thousands of ops, with no prior pull because the log
  // did not exist yet — the snapshot went out saying it covered nothing, and
  // from then on every launch replayed the whole log and compaction could never
  // run at all. Stat the file rather than adding the appended byte count, so a
  // wrong offset can never accumulate.
  function advanceOwnOffset() {
    try {
      offsets.set(machineId, fs.statSync(logPathFor(getCrdtDir(), machineId)).size);
    } catch (e) {
      console.warn('[crdt/store] could not advance own log offset', e?.message || e);
    }
  }

  // Pull everything new from every machine's log, including our own (which
  // costs nothing — we are already past our own writes).
  function pullRemote() {
    ensureOpsDir(getCrdtDir());
    const all = [];
    for (const { machineId: id, file } of listLogs(getCrdtDir())) {
      const from = offsets.get(id) || 0;
      const { ops, offset } = readLogFrom(file, from);
      offsets.set(id, offset);
      if (ops.length) all.push(...ops);
    }
    // Sort by stamp before applying. Not required for correctness — the merge
    // is order-independent by construction — but it makes conflict detection
    // deterministic in the same pass and keeps debug logs readable.
    all.sort((a, b) => compareHlc(a.h, b.h));
    return applyOps(all);
  }

  // ---- projections -------------------------------------------------------

  function refreshProjections() {
    let contents;
    try {
      contents = buildProjections(tables, { paths: getProjectionPaths(), buildOrdersIndex });
    } catch (e) {
      console.error('[crdt/store] projection build failed', e);
      return { written: [], failed: [] };
    }
    return writeProjections(contents, {
      fs,
      path,
      writeJsonAtomic,
      lastWritten: lastWrittenProjection,
      // Belt and braces for the hazard above: until this store holds records,
      // an empty projection is far more likely to be a bug than the truth, so
      // it is never allowed to overwrite a file that still has data in it.
      allowEmptyOverwrite: hasAnyRecords(),
    });
  }

  function hasAnyRecords() {
    return ENTITY_NAMES.some((name) => tables[name].size > 0);
  }

  // ---- snapshot ----------------------------------------------------------

  function serializeTables() {
    const out = {};
    for (const name of ENTITY_NAMES) {
      const table = {};
      for (const [key, record] of tables[name]) {
        table[key] = { f: record.f, d: record.d };
      }
      out[name] = table;
    }
    return out;
  }

  function writeSnapshot() {
    try {
      const payload = {
        v: SNAPSHOT_VERSION,
        at: new Date().toISOString(),
        by: machineId,
        offsets: Object.fromEntries(offsets),
        tables: serializeTables(),
        conflicts: conflicts.all(),
      };
      writeJsonAtomic(snapshotPath(), JSON.stringify(payload));
      opsSinceSnapshot = 0;
      return true;
    } catch (e) {
      // A snapshot is an optimisation. Failing to write one costs startup time
      // on the next launch and nothing else, so it must never fail a save.
      console.warn('[crdt/store] snapshot write failed', e?.message || e);
      return false;
    }
  }

  function loadSnapshot() {
    const file = snapshotPath();
    try {
      if (!fs.existsSync(file)) return false;
      const raw = fs.readFileSync(file, 'utf-8');
      if (!raw.trim()) return false;
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.v !== SNAPSHOT_VERSION) return false;

      for (const name of ENTITY_NAMES) {
        const table = createTable();
        const src = parsed.tables?.[name] || {};
        for (const key of Object.keys(src)) {
          const rec = src[key];
          table.set(key, { f: rec.f || Object.create(null), d: rec.d || null });
        }
        tables[name] = table;
      }
      for (const [id, offset] of Object.entries(parsed.offsets || {})) {
        offsets.set(id, Number(offset) || 0);
      }
      const restored = createConflictLog(parsed.conflicts || []);
      // createConflictLog returns a fresh closure; copy its entries into ours.
      for (const c of restored.all()) conflicts.record(c.entity, c.key, {
        field: c.field,
        winner: c.winner,
        loser: c.loser,
      }, { subject: c.subject });

      return true;
    } catch (e) {
      // A corrupt snapshot must not be fatal — it is derived. Fall back to a
      // full replay of the logs, which reproduces the identical state.
      console.warn('[crdt/store] snapshot unreadable, replaying logs from scratch', e?.message || e);
      ENTITY_NAMES.forEach((name) => { tables[name] = createTable(); });
      offsets.clear();
      return false;
    }
  }

  // Trim our own log of ops the shared snapshot already covers. Only ever our
  // own file — see the single-writer rule in oplog.js.
  function maybeCompactOwnLog() {
    try {
      const file = logPathFor(getCrdtDir(), machineId);
      if (!fs.existsSync(file)) return;
      if (fs.statSync(file).size < COMPACT_LOG_BYTES) return;
      // Only safe once a snapshot exists that has consumed our whole log:
      // otherwise a machine that has not read those ops yet would never see
      // them. Re-reading the snapshot rather than trusting our in-memory copy
      // because another machine may have written a newer one.
      const snap = JSON.parse(fs.readFileSync(snapshotPath(), 'utf-8'));
      const covered = Number(snap?.offsets?.[machineId]) || 0;
      const size = fs.statSync(file).size;
      if (covered < size) return;
      // Keep the recent tail — see COMPACT_RETAIN_MS for why an empty log is
      // not safe while peers are running.
      const cutoff = Date.now() - COMPACT_RETAIN_MS;
      const { ops } = readLogFrom(file, 0);
      const keep = ops.filter((op) => hlcMillis(op.h) >= cutoff);
      if (keep.length === ops.length) return; // nothing old enough to drop
      compactOwnLog(getCrdtDir(), machineId, keep);
      advanceOwnOffset();
      console.log(
        '[crdt/store] compacted own op log',
        `${size} bytes ->`, fs.statSync(file).size,
        `(dropped ${ops.length - keep.length} ops already in the snapshot)`
      );
    } catch (e) {
      console.warn('[crdt/store] compaction skipped', e?.message || e);
    }
  }

  // ---- the after-change pipeline ----------------------------------------

  function settle(result, { local }) {
    if (!result.applied && !local) return result;
    const projection = refreshProjections();
    if (opsSinceSnapshot >= SNAPSHOT_EVERY_OPS) {
      if (writeSnapshot()) maybeCompactOwnLog();
    }
    if (typeof onChange === 'function') {
      try {
        onChange({
          entities: Array.from(result.touched || []),
          conflicts: result.newConflicts || [],
          projection,
          local,
        });
      } catch (e) {
        console.error('[crdt/store] onChange listener threw', e);
      }
    }
    return result;
  }

  // ---- public API --------------------------------------------------------

  // `project: false` is REQUIRED on the very first load of a share that has not
  // been seeded yet.
  //
  // Projections are written from the merged tables. Before the migration runs
  // those tables are empty, so projecting at that moment writes `[]` over every
  // business file — i.e. it erases the share, and then the migration reads the
  // files it just blanked and seeds nothing. Load, seed, THEN project.
  function load(options = {}) {
    const { project = true } = options;
    ensureOpsDir(getCrdtDir());
    loadSnapshot();
    const result = pullRemote();
    loaded = true;
    if (project) refreshProjections();
    console.log(
      '[crdt/store] loaded',
      ENTITY_NAMES.map((n) => `${n}=${countAlive(n)}`).join(' '),
      `conflicts=${conflicts.size()}`
    );
    return result;
  }

  function countAlive(entity) {
    let n = 0;
    for (const record of tables[entity].values()) if (isAlive(record)) n += 1;
    return n;
  }

  // Fold in anything new on the share. Called by the file watcher and before
  // any commit, so a save is always computed against current knowledge.
  function refresh() {
    if (!loaded) return load();
    return settle(pullRemote(), { local: false });
  }

  // Materialize an entity, and remember what we handed out as the baseline for
  // the caller's eventual write-back.
  function read(entity) {
    entityDef(entity);
    const baseline = new Map();
    for (const [key, record] of tables[entity]) {
      if (!isAlive(record)) continue;
      const value = materializeRecord(record);
      if (!value) continue;
      baseline.set(key, { value, version: recordVersion(record) });
    }
    served[entity] = baseline;
    // valuesOf applies the stable birth-stamp ordering, so callers see rows in
    // the same order on every machine.
    return valuesOf(tables[entity]);
  }

  // Read, and remember this as what the RENDERER has been shown. Call it on the
  // paths that actually send data to the UI — the read IPC handlers and the
  // push in onCrdtChange — and nowhere else. Every commit marked
  // `fromClient` is diffed against the snapshot this captured.
  function checkout(entity) {
    const values = read(entity);
    checkedOut[entity] = new Map(served[entity]);
    return values;
  }

  function readOne(entity, key) {
    const record = tables[entity]?.get(key);
    if (!record || !isAlive(record)) return null;
    const value = materializeRecord(record);
    served[entity].set(key, { value, version: recordVersion(record) });
    return value;
  }

  // Commit a set of records.
  //
  // Only the FIELDS that differ from the baseline become ops, and a field the
  // caller omitted is left alone rather than cleared — partial records are
  // normal here (see diffToOp). Two things therefore have to be explicit:
  //   deletes     — removing a whole record. "Not in my copy" means "I might be
  //                 stale", never "remove it"; that inference is what used to
  //                 erase whole item files.
  //   clearFields — removing a field from the records in this commit, e.g.
  //                 dropping lock_expires_at when a lock expires.
  function commit(entity, values, options = {}) {
    const def = entityDef(entity);
    const { deletes = [], skipRefresh = false, clearFields = null, fromClient = false } = options;

    if (!skipRefresh) pullRemote();

    // See the note on `served` vs `checkedOut` above.
    const baselineFor = fromClient ? checkedOut[entity] : served[entity];
    const ops = [];

    // Passed as a function so a stamp is minted only for records that actually
    // changed. Most callers hand back a whole collection to change one row in
    // it, so this is the difference between 1 stamp and 1,100. See diffToOp.
    const mintHlc = () => clock.tick();

    for (const raw of values || []) {
      if (!raw) continue;
      const record = def.ensureKey(raw);
      const key = def.keyOf(record);
      if (!key) {
        console.warn(`[crdt/store] ${entity} record without a key, skipped`);
        continue;
      }
      const base = baselineFor.get(key);
      const op = diffToOp(
        entity,
        key,
        record,
        base ? base.value : null,
        base ? base.version : recordVersion(tables[entity].get(key)),
        mintHlc,
        clearFields
      );
      if (op) ops.push(op);
    }

    for (const key of deletes || []) {
      if (!key) continue;
      const existing = tables[entity].get(key);
      if (!existing || !isAlive(existing)) continue;
      const base = baselineFor.get(key);
      ops.push(deleteOp(entity, key, base ? base.version : recordVersion(existing), clock.tick()));
    }

    if (!ops.length) return { ok: true, ops: 0 };

    // Durability order matters: the log is written FIRST and everything else
    // is derived from it. If the process dies after this line, the change is
    // safe and every machine (including this one, on restart) picks it up.
    appendOps(getCrdtDir(), machineId, ops);
    advanceOwnOffset();
    // Persist the clock at the same boundary the log becomes durable — once per
    // commit rather than once per stamp. Anything the debounce is still holding
    // goes out here too.
    clock.flush();

    const result = applyOps(ops);
    // Our own writes become the new baseline immediately, so a follow-up save
    // from the same caller doesn't re-emit them.
    // Our own writes become the new baseline in BOTH views: the renderer is
    // about to be told about them anyway, and leaving them out would make the
    // next save re-emit ops it already published.
    for (const op of ops) {
      const record = tables[entity].get(op.k);
      if (record && isAlive(record)) {
        const entry = { value: materializeRecord(record), version: recordVersion(record) };
        served[entity].set(op.k, entry);
        checkedOut[entity].set(op.k, entry);
      } else {
        served[entity].delete(op.k);
        checkedOut[entity].delete(op.k);
      }
    }
    settle(result, { local: true });
    return { ok: true, ops: ops.length, conflicts: result.newConflicts };
  }

  function remove(entity, keys) {
    return commit(entity, [], { deletes: keys });
  }

  // Commit a whole list, where absence DOES mean removal — the semantics most
  // of the app's existing write functions were built on (writeOrders(keep),
  // writePayments(filtered), and so on).
  //
  // The safety comes from what absence is measured against: the records this
  // caller was actually SERVED, not everything on the share. A record another
  // machine added after the caller's read is not in that baseline, so it cannot
  // be inferred as deleted. That is precisely the bug removeOrdersFromDisk had
  // to work around by hand — archiving did real work in between, and writing
  // back the pre-work array erased whatever had arrived meanwhile. Here it
  // falls out of the model.
  function commitList(entity, values, options = {}) {
    entityDef(entity);
    if (!skipRefreshOf(options)) pullRemote();

    const def = entityDef(entity);
    const present = new Set();
    for (const raw of values || []) {
      if (!raw) continue;
      const key = def.keyOf(def.ensureKey(raw));
      if (key) present.add(key);
    }

    const baseline = options.fromClient ? checkedOut[entity] : served[entity];
    let deletes = [];
    if (baseline.size === 0 && tables[entity].size > 0) {
      // The caller is writing a list it never read. We cannot tell an intended
      // removal from an empty starting point, and guessing wrong erases live
      // data — so treat it as an upsert-only write and say so.
      console.warn(
        `[crdt/store] commitList("${entity}") without a prior read — treating as upsert-only, no removals inferred`
      );
    } else {
      deletes = Array.from(baseline.keys()).filter((key) => !present.has(key));
    }

    return commit(entity, values, { ...options, deletes, skipRefresh: true });
  }

  function skipRefreshOf(options) {
    return Boolean(options && options.skipRefresh);
  }

  // ---- conflicts ---------------------------------------------------------

  function ackedIds() {
    const acked = new Set();
    for (const [key, record] of tables.conflictAck) {
      if (isAlive(record)) acked.add(key);
    }
    return acked;
  }

  function listConflicts() {
    return conflicts.list(ackedIds());
  }

  function ackConflict(id) {
    if (!id) return { ok: false, error: 'id required' };
    return commit('conflictAck', [{ id, at: new Date().toISOString(), by: machineId }]);
  }

  function ackAllConflicts() {
    const open = listConflicts();
    if (!open.length) return { ok: true, ops: 0 };
    const at = new Date().toISOString();
    return commit('conflictAck', open.map((c) => ({ id: c.id, at, by: machineId })));
  }

  function stats() {
    return {
      machineId,
      loaded,
      hlc: clock.peek(),
      counts: Object.fromEntries(ENTITY_NAMES.map((n) => [n, countAlive(n)])),
      offsets: Object.fromEntries(offsets),
      openConflicts: listConflicts().length,
      opsSinceSnapshot,
    };
  }

  return {
    load,
    refresh,
    project: refreshProjections,
    read,
    checkout,
    readOne,
    commit,
    commitList,
    remove,
    listConflicts,
    ackConflict,
    ackAllConflicts,
    writeSnapshot,
    stats,
    describeRecord,
    // Exposed for the migration seeder and tests, not for app code.
    _internal: { tables, clock, conflicts, served, checkedOut, offsets },
  };
}

module.exports = { createStore, CRDT_DIRNAME, SNAPSHOT_FILENAME };
