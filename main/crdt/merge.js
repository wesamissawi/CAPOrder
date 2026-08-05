// The CRDT itself: an observed-remove map of records, where each record is a
// map of per-field last-writer-wins registers.
//
// Why per FIELD and not per record: two counters touching the same part at the
// same moment usually touch different things — one sets `allocated_to`, the
// other stamps `invoice_num`. A record-level LWW would throw one of those away
// wholesale. Per-field registers keep both, and only a genuine same-field
// collision has to pick a winner.
//
// The three CRDT properties this has to satisfy, because they are what let
// machines merge in any order and still land on identical state:
//   commutative  — apply(a, b) === apply(b, a)          (order doesn't matter)
//   associative  — grouping of applications doesn't matter
//   idempotent   — applying the same op twice changes nothing
// Every rule below is a max() over a total order, which gives all three for
// free. If you add a rule here, it must also be a max() over something totally
// ordered, or the guarantee is gone.

const { compareHlc, hlcMachine, hlcMillis } = require('./hlc');

const OP_SET = 's';
const OP_DEL = 'd';

// Record shape held in memory:
//   { f: { <field>: { v: <value>, h: <hlc> } }, d: <delete hlc|null> }
//
// Deletion is a tombstone rather than a removal because "absent" and "deleted"
// have to be distinguishable. A machine that has not yet seen a record must not
// conclude it was deleted — that mistake is precisely how whole item files used
// to get erased (see the upsert-only note in main/services/items.service.js).

function emptyRecord() {
  return { f: Object.create(null), d: null };
}

// A record is alive when at least one field was written AFTER the tombstone.
// That makes delete-vs-edit resolve by the clock rather than by arrival order:
// archiving a bubble while another machine edits a part in it converges to
// whichever genuinely happened later, on every machine.
function isAlive(record) {
  if (!record) return false;
  const fields = Object.keys(record.f);
  if (!fields.length) return false;
  if (!record.d) return true;
  for (const field of fields) {
    if (compareHlc(record.f[field].h, record.d) > 0) return true;
  }
  return false;
}

// A cell is either a value ({ v, h }) or a CLEARED marker ({ x: 1, h }).
//
// "Cleared" needs its own representation and cannot just be `v: undefined`,
// because JSON.stringify silently drops undefined — a cleared field would
// serialize to nothing, the op would reach other machines with the clear
// missing, and they would keep a value this machine no longer has. It also
// cannot be `v: null`: null is a legitimate stored value here (order_line_idx
// is null on purpose), so conflating the two would make a real null unreadable.
function isCleared(cell) {
  return Boolean(cell && cell.x);
}

// Flatten a record back to the plain object the rest of the app expects.
// Fields older than the tombstone are dropped: if a delete is followed by a
// partial re-set, only the re-set fields come back, not the pre-delete ghosts.
function materializeRecord(record) {
  if (!isAlive(record)) return null;
  const out = {};
  const tomb = record.d;
  for (const field of Object.keys(record.f)) {
    const cell = record.f[field];
    if (tomb && compareHlc(cell.h, tomb) <= 0) continue;
    if (isCleared(cell)) continue;
    out[field] = cell.v;
  }
  return out;
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function sameValue(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a !== 'object') return false;
  return stableStringify(a) === stableStringify(b);
}

// The record's current logical version — the newest stamp anywhere in it.
// Writers send this back as an op's parent (`p`), which is what turns "these
// two writes disagree" into "these two writers never saw each other".
function recordVersion(record) {
  if (!record) return '';
  let max = record.d || '';
  for (const field of Object.keys(record.f)) {
    const h = record.f[field].h;
    if (compareHlc(h, max) > 0) max = h;
  }
  return max;
}

// The record's birth stamp — the OLDEST write anywhere in it.
//
// This is how projections keep a stable, identical row order on every machine
// without stamping a sequence number onto the records themselves. Sorting by
// birth stamp reproduces insertion order, and because the seeder issues its
// timestamps in existing-file order, the very first projection comes out in the
// exact order the files are in today. No view has to change to accommodate the
// refactor.
function recordCreatedAt(record) {
  if (!record) return '';
  let min = '';
  for (const field of Object.keys(record.f)) {
    const h = record.f[field].h;
    if (!min || compareHlc(h, min) < 0) min = h;
  }
  return min;
}

// True concurrency test, and the reason ops carry a parent stamp.
//
// A write is CONCURRENT with the value it is overwriting when the writer had
// not yet observed that value — i.e. the field's current stamp is newer than
// the state the writer based its edit on. That is a real fork in the causal
// graph. A write whose parent already covers the current value is just a normal
// sequential update and is never flagged, however close together the two
// happened.
//
// Compare with a wall-clock proximity window (`these landed 2s apart, probably
// a conflict`): that both misses slow conflicts and cries wolf over fast
// sequential edits. Parent stamps get it exactly right, and cost one string.
function isConcurrent(op, cell) {
  if (!cell) return false;
  if (!op.p) return false; // legacy/seed op with no causal info — don't guess
  return compareHlc(cell.h, op.p) > 0;
}

// Apply one op to one record, in place.
//
// `onConflict` fires when two machines genuinely raced the same field with
// different values. It fires on the LOSING write regardless of which side that
// is — the op we just rejected, or the value it displaced — so the report is
// the same on every machine no matter what order the ops arrived in. That
// symmetry is what makes the conflict list itself convergent; a list that
// depended on arrival order would differ per machine and be useless for review.
function applyOp(record, op, onConflict) {
  if (!op || !op.h) return false;
  let changed = false;

  if (op.o === OP_DEL) {
    if (compareHlc(op.h, record.d || '') > 0) {
      record.d = op.h;
      changed = true;
    }
    return changed;
  }

  // Set fields and cleared fields travel in the same op and merge by the same
  // rule; only the cell they produce differs.
  const fields = op.f || {};
  const cleared = op.c || [];
  const incomingFor = (field) =>
    cleared.includes(field) ? { x: 1, h: op.h, p: op.p } : { v: fields[field], h: op.h, p: op.p };

  for (const field of [...Object.keys(fields), ...cleared]) {
    const isClear = cleared.includes(field);
    const incoming = isClear ? undefined : fields[field];
    const cell = record.f[field];

    if (!cell) {
      record.f[field] = incomingFor(field);
      changed = true;
      continue;
    }

    const cmp = compareHlc(op.h, cell.h);
    if (cmp === 0) {
      // Identical stamp AND field means the same op replayed (log re-read,
      // snapshot overlap). Idempotence: nothing to do.
      continue;
    }

    // One test for both outcomes: did the incoming writer see the value it is
    // landing on top of? If not, the two writes forked, and that is true
    // whichever of them the clock ends up preferring. Using the same test on
    // both sides is what makes every machine report the identical conflict no
    // matter which op it happened to read first.
    const differs = isClear !== isCleared(cell) || !sameValue(incoming, cell.v);
    const conflicting =
      Boolean(onConflict) &&
      differs &&
      hlcMachine(op.h) !== hlcMachine(cell.h) &&
      isConcurrent(op, cell);

    if (cmp > 0) {
      if (conflicting) {
        onConflict({
          field,
          winner: { value: incoming, hlc: op.h, machine: hlcMachine(op.h) },
          loser: { value: cell.v, hlc: cell.h, machine: hlcMachine(cell.h) },
        });
      }
      record.f[field] = incomingFor(field);
      changed = true;
    } else if (conflicting) {
      // The incoming op lost, but the collision is still real and still has to
      // be reported — the machine that wrote it needs to learn its change was
      // discarded.
      onConflict({
        field,
        winner: { value: cell.v, hlc: cell.h, machine: hlcMachine(cell.h) },
        loser: { value: incoming, hlc: op.h, machine: hlcMachine(op.h) },
      });
    }
  }

  return changed;
}

// An entity table: all records of one kind (all items, all orders, ...).
function createTable() {
  return new Map();
}

function applyOpToTable(table, op, onConflict) {
  let record = table.get(op.k);
  if (!record) {
    record = emptyRecord();
    table.set(op.k, record);
  }
  return applyOp(record, op, onConflict ? (detail) => onConflict({ ...detail, key: op.k }) : null);
}

// Materialize a whole table into plain objects, newest state only.
function materializeTable(table) {
  const out = [];
  for (const [key, record] of table) {
    const obj = materializeRecord(record);
    if (obj) out.push({ key, value: obj });
  }
  return out;
}

// Build the op set for a change, by diffing the new value against the BASELINE
// the writer was looking at — not against current state.
//
// This is the single most important function in the refactor. The old bug was
// that the renderer sent its entire in-memory array and the main process wrote
// it back wholesale, so a stale array silently reverted every field another
// machine had touched in the meantime. Diffing against the baseline means an
// untouched field emits no op at all, and therefore cannot revert anything. A
// stale save now writes only what the user actually changed.
//
// Returns null when nothing changed, so a no-op save costs zero bytes on the
// share.
// `parentVersion` is the record version the writer was looking at, captured
// when the state was handed out — NOT the record's version now. Those differ
// exactly when someone else edited in between, which is the case the conflict
// detector exists to catch, so reading it from current state would defeat it.
// Fields the caller DID NOT mention are left alone. Only fields present in
// `nextValue` can produce an op, and removal has to be asked for explicitly via
// `clearFields`.
//
// Merge semantics, not replace semantics, because callers here legitimately
// commit partial records — an IPC handler that stamps an invoice number sends
// { uid, invoice_num }, not the whole part. Under replace semantics that write
// would wipe the item's cost, bubble and quantity, and the wipe would look like
// a deliberate edit to every other machine. Absence means "no opinion"; that is
// the same rule the item queues already followed when they made deletion
// explicit rather than inferring it from a missing uid.
// `mintHlc` is a FUNCTION, not a stamp, and it is called only once this has
// decided there is something to publish. Stamping is not free — see the note on
// persistence in hlc.js — and callers legitimately hand the whole collection
// back to change one record in it: archiving an order commits all ~1,100
// archived orders. Taking a stamp per record meant minting and discarding 1,099
// of them, which cost 10.6 seconds against 19ms of diffing. A plain string is
// still accepted, for callers that already hold a stamp.
function diffToOp(entity, key, nextValue, baselineValue, parentVersion, mintHlc, clearFields) {
  const fields = {};
  const cleared = [];
  const next = nextValue || {};
  const base = baselineValue || {};

  for (const field of Object.keys(next)) {
    const to = next[field];
    if (to === undefined) continue; // absent, not a clear — see clearFields
    if (sameValue(to, base[field]) && field in base) continue;
    fields[field] = to;
  }

  for (const field of clearFields || []) {
    if (!(field in base)) continue; // already gone; nothing to say
    cleared.push(field);
    delete fields[field];
  }

  if (!Object.keys(fields).length && !cleared.length) return null;

  return {
    h: typeof mintHlc === 'function' ? mintHlc() : mintHlc,
    e: entity,
    k: key,
    o: OP_SET,
    f: fields,
    c: cleared.length ? cleared : undefined,
    p: parentVersion || undefined,
  };
}

function deleteOp(entity, key, parentVersion, hlc) {
  return {
    h: hlc,
    e: entity,
    k: key,
    o: OP_DEL,
    p: parentVersion || undefined,
  };
}

module.exports = {
  OP_SET,
  OP_DEL,
  emptyRecord,
  isAlive,
  isCleared,
  materializeRecord,
  materializeTable,
  recordVersion,
  recordCreatedAt,
  applyOp,
  applyOpToTable,
  createTable,
  diffToOp,
  deleteOp,
  sameValue,
  stableStringify,
  hlcMillis,
};
