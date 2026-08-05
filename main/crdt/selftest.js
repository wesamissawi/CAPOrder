// Convergence self-test.  Run:  node main/crdt/selftest.js
//
// Two stores pointed at one temp folder stand in for two machines on the share.
// Because they only ever talk through the op logs, this exercises the real
// replication path — no mocks of the thing under test.
//
// These are the properties the whole refactor rests on. If one of them breaks,
// machines silently disagree about stock, which is worse than the bug this
// replaced. Worth running before shipping a change to anything under main/crdt.

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const { createStore } = require('./store');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crdt-selftest-'));

function writeJsonAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
  fs.writeFileSync(tmp, text, 'utf-8');
  fs.renameSync(tmp, file);
}

function makeStore(machineId, shareDir) {
  const projections = path.join(shareDir, 'proj');
  const p = (name) => path.join(projections, name);
  return createStore({
    fs,
    path,
    machineId,
    getCrdtDir: () => path.join(shareDir, 'crdt'),
    getProjectionPaths: () => ({
      outstanding: p('outstanding_items.json'),
      sageAr: p('sage_ar_items.json'),
      cashSales: p('cash_sales_items.json'),
      orders: p('orders.json'),
      ordersIndex: p('orders_index.json'),
      ordersArchive: p('orders_archive.json'),
      orderAssignments: p('order_assignments.json'),
      payments: p('payments.json'),
      sageSalesRuns: p('sage_sales_runs.json'),
      archived: p('archived_bubbles.json'),
      cloverLedger: p('clover_scraped.json'),
      sharedBubble: p('bubble_shared.json'),
    }),
    writeJsonAtomic,
    buildOrdersIndex: () => [],
    clockStatePath: path.join(shareDir, `clock-${machineId}.json`),
    onChange: () => {},
  });
}

let caseNum = 0;
const failures = [];

function scenario(name, fn) {
  caseNum += 1;
  const dir = path.join(root, `case${caseNum}`);
  fs.mkdirSync(dir, { recursive: true });
  try {
    fn(dir);
    console.log(`  ok   ${name}`);
  } catch (e) {
    failures.push({ name, error: e });
    console.log(`  FAIL ${name}`);
    console.log(`       ${e.message}`);
  }
}

// Materialize an entity as a key->value object for easy assertions.
function snapshotOf(store, entity) {
  const out = {};
  for (const row of store.read(entity)) out[row.uid || row.id || row.orderKey] = row;
  return out;
}

console.log('CRDT convergence self-test\n');

// ---------------------------------------------------------------------------
scenario('different fields, concurrent → both survive, no conflict', (dir) => {
  const a = makeStore('ALPHA', dir);
  const b = makeStore('BRAVO', dir);
  a.load();

  a.commit('item', [{ uid: 'p1', itemcode: 'PN-1', allocated_to: 'New Stock', cost: '10.00' }]);
  b.load(); // BRAVO now sees the part

  // Both read, then both edit different fields without seeing each other.
  a.read('item');
  b.read('item');
  a.commit('item', [{ uid: 'p1', itemcode: 'PN-1', allocated_to: 'Bubble 7', cost: '10.00' }], { skipRefresh: true });
  b.commit('item', [{ uid: 'p1', itemcode: 'PN-1', allocated_to: 'New Stock', cost: '12.50' }], { skipRefresh: true });

  a.refresh();
  b.refresh();

  const av = snapshotOf(a, 'item').p1;
  const bv = snapshotOf(b, 'item').p1;
  assert.deepStrictEqual(av, bv, 'machines diverged');
  assert.strictEqual(av.allocated_to, 'Bubble 7', "ALPHA's bubble move was lost");
  assert.strictEqual(av.cost, '12.50', "BRAVO's cost edit was lost");
  assert.strictEqual(a.listConflicts().length, 0, 'different fields must not raise a conflict');
});

// ---------------------------------------------------------------------------
scenario('same field, concurrent → converge + flag on BOTH machines', (dir) => {
  const a = makeStore('ALPHA', dir);
  const b = makeStore('BRAVO', dir);
  a.load();
  a.commit('item', [{ uid: 'p1', itemcode: 'PN-1', allocated_to: 'New Stock' }]);
  b.load();

  a.read('item');
  b.read('item');
  a.commit('item', [{ uid: 'p1', itemcode: 'PN-1', allocated_to: 'Bubble A' }], { skipRefresh: true });
  b.commit('item', [{ uid: 'p1', itemcode: 'PN-1', allocated_to: 'Bubble B' }], { skipRefresh: true });

  a.refresh();
  b.refresh();

  const av = snapshotOf(a, 'item').p1;
  const bv = snapshotOf(b, 'item').p1;
  assert.strictEqual(av.allocated_to, bv.allocated_to, 'machines disagree on the winner');

  const ac = a.listConflicts();
  const bc = b.listConflicts();
  assert.strictEqual(ac.length, 1, `ALPHA should see 1 conflict, saw ${ac.length}`);
  assert.strictEqual(bc.length, 1, `BRAVO should see 1 conflict, saw ${bc.length}`);
  assert.strictEqual(ac[0].id, bc[0].id, 'conflict ids must match across machines');
  assert.strictEqual(ac[0].fieldLabel, 'bubble');
  const values = [ac[0].winner.value, ac[0].loser.value].sort();
  assert.deepStrictEqual(values, ['Bubble A', 'Bubble B']);
});

// ---------------------------------------------------------------------------
scenario('sequential edits to the same field → no false conflict', (dir) => {
  const a = makeStore('ALPHA', dir);
  const b = makeStore('BRAVO', dir);
  a.load();
  a.commit('item', [{ uid: 'p1', allocated_to: 'New Stock' }]);

  b.load();
  a.read('item');
  a.commit('item', [{ uid: 'p1', allocated_to: 'Bubble A' }]);

  b.refresh();
  b.read('item');           // BRAVO sees ALPHA's change first
  b.commit('item', [{ uid: 'p1', allocated_to: 'Bubble B' }]);

  a.refresh();
  assert.strictEqual(snapshotOf(a, 'item').p1.allocated_to, 'Bubble B');
  assert.strictEqual(a.listConflicts().length, 0, 'taking turns must never flag a conflict');
});

// ---------------------------------------------------------------------------
scenario('THE BUG: stale whole-array save cannot revert another machine', (dir) => {
  const a = makeStore('ALPHA', dir);
  const b = makeStore('BRAVO', dir);
  a.load();
  a.commit('item', [
    { uid: 'p1', itemcode: 'PN-1', allocated_to: 'New Stock' },
    { uid: 'p2', itemcode: 'PN-2', allocated_to: 'New Stock' },
  ]);
  b.load();

  // BRAVO loads the whole list into its "renderer" and sits on it.
  const bravosStaleCopy = b.read('item').map((it) => ({ ...it }));

  // Meanwhile ALPHA moves p1 into a bubble.
  a.read('item');
  a.commit('item', [{ uid: 'p1', itemcode: 'PN-1', allocated_to: 'Bubble 7' }]);

  // BRAVO now saves its entire stale array — the exact shape of the old bug.
  // It edits p2 only; p1 in its copy still says "New Stock".
  bravosStaleCopy.find((it) => it.uid === 'p2').allocated_to = 'CASHPAD';
  b.commit('item', bravosStaleCopy);

  a.refresh();
  const av = snapshotOf(a, 'item');
  assert.strictEqual(av.p1.allocated_to, 'Bubble 7', 'stale save reverted the other machine — the original bug');
  assert.strictEqual(av.p2.allocated_to, 'CASHPAD', "BRAVO's own edit was lost");
  assert.strictEqual(a.listConflicts().length, 0, 'an untouched field must not register as a conflict');
});

// ---------------------------------------------------------------------------
scenario('THE REAL PATH: checkout → remote edit → stale UI save', (dir) => {
  // Exactly what items:read / items:write do in production. The difference from
  // the previous scenario is that main-process code reads the store several
  // times between the UI's read and its save (lock cleanup, history diffing),
  // and every one of those reads must NOT become the diff baseline — otherwise
  // the stale save looks authoritative again.
  const a = makeStore('ALPHA', dir);
  const b = makeStore('BRAVO', dir);
  a.load();
  a.commit('item', [
    { uid: 'p1', itemcode: 'PN-1', allocated_to: 'New Stock' },
    { uid: 'p2', itemcode: 'PN-2', allocated_to: 'New Stock' },
  ]);
  b.load();

  // BRAVO's renderer loads the list (items:read -> checkout).
  const uiCopy = b.checkout ? b.checkout('item').map((it) => ({ ...it })) : null;
  assert.ok(uiCopy, 'store must expose checkout');

  // ALPHA moves p1 while BRAVO's UI sits on its copy.
  a.read('item');
  a.commit('item', [{ uid: 'p1', allocated_to: 'Bubble 7' }]);
  b.refresh();

  // Main-process reads happen on BRAVO in between — these must not move the
  // baseline the UI's save is judged against.
  b.read('item');
  b.read('item');

  // Now the stale UI saves its whole array, having changed only p2.
  uiCopy.find((it) => it.uid === 'p2').allocated_to = 'CASHPAD';
  b.commit('item', uiCopy, { fromClient: true });

  a.refresh();
  const av = snapshotOf(a, 'item');
  assert.strictEqual(av.p1.allocated_to, 'Bubble 7', 'a fresh main-process read leaked into the UI baseline');
  assert.strictEqual(av.p2.allocated_to, 'CASHPAD', "the UI's own edit was lost");
});

// ---------------------------------------------------------------------------
scenario('a partial commit leaves unmentioned fields alone', (dir) => {
  const a = makeStore('ALPHA', dir);
  a.load();
  a.commit('item', [{ uid: 'p1', itemcode: 'PN-1', cost: '10.00', allocated_to: 'New Stock', quantity: 3 }]);

  // The shape an IPC handler stamping an invoice number actually sends.
  a.read('item');
  a.commit('item', [{ uid: 'p1', invoice_num: 'INV-900' }]);

  const v = snapshotOf(a, 'item').p1;
  assert.strictEqual(v.invoice_num, 'INV-900');
  assert.strictEqual(v.cost, '10.00', 'a partial commit wiped an unmentioned field');
  assert.strictEqual(v.allocated_to, 'New Stock', 'a partial commit wiped an unmentioned field');
  assert.strictEqual(v.quantity, 3, 'a partial commit wiped an unmentioned field');

  // And the same must hold after a replay from the log, not just in memory.
  const reader = makeStore('READER', dir);
  reader.load();
  assert.deepStrictEqual(snapshotOf(reader, 'item').p1, v, 'replay disagrees with memory');
});

// ---------------------------------------------------------------------------
scenario('an explicit field clear replicates to other machines', (dir) => {
  const a = makeStore('ALPHA', dir);
  const b = makeStore('BRAVO', dir);
  a.load();
  a.commit('item', [{ uid: 'p1', itemcode: 'PN-1', lock_expires_at: 12345 }]);
  b.load();
  assert.strictEqual(snapshotOf(b, 'item').p1.lock_expires_at, 12345);

  a.read('item');
  a.commit('item', [{ uid: 'p1' }], { clearFields: ['lock_expires_at'] });

  b.refresh();
  assert.ok(!('lock_expires_at' in snapshotOf(b, 'item').p1), 'the clear did not replicate');
  assert.strictEqual(snapshotOf(b, 'item').p1.itemcode, 'PN-1', 'the clear took other fields with it');
});

// ---------------------------------------------------------------------------
scenario('delete vs edit → converges identically on both machines', (dir) => {
  const a = makeStore('ALPHA', dir);
  const b = makeStore('BRAVO', dir);
  a.load();
  a.commit('item', [{ uid: 'p1', allocated_to: 'New Stock' }]);
  b.load();

  a.read('item');
  b.read('item');
  a.remove('item', ['p1']);                                    // archived here
  b.commit('item', [{ uid: 'p1', allocated_to: 'Bubble 9' }], { skipRefresh: true }); // edited there

  a.refresh();
  b.refresh();

  const alive = (s) => Boolean(snapshotOf(s, 'item').p1);
  assert.strictEqual(alive(a), alive(b), 'machines disagree on whether the part exists');
});

// ---------------------------------------------------------------------------
scenario('op arrival order does not affect final state', (dir) => {
  // Three machines write, then two fresh readers consume the logs. Because a
  // reader tails logs in directory order, building the same state from a
  // different starting point is the real test of order-independence.
  const a = makeStore('ALPHA', dir);
  const b = makeStore('BRAVO', dir);
  const c = makeStore('CHARLIE', dir);
  a.load(); b.load(); c.load();

  a.commit('item', [{ uid: 'p1', allocated_to: 'A1', cost: '1.00' }]);
  b.refresh(); b.read('item');
  b.commit('item', [{ uid: 'p1', allocated_to: 'B1' }]);
  c.refresh(); c.read('item');
  c.commit('item', [{ uid: 'p1', cost: '3.00', quantity: 4 }]);
  a.refresh(); a.read('item');
  a.commit('item', [{ uid: 'p1', allocated_to: 'A2', quantity: 9 }]);

  const reader1 = makeStore('READER1', dir); reader1.load();
  const reader2 = makeStore('READER2', dir); reader2.load();
  const r1 = snapshotOf(reader1, 'item').p1;
  const r2 = snapshotOf(reader2, 'item').p1;
  a.refresh(); b.refresh(); c.refresh();

  assert.deepStrictEqual(r1, r2, 'two fresh replays disagree');
  assert.deepStrictEqual(snapshotOf(a, 'item').p1, r1, 'live machine disagrees with a fresh replay');
  assert.deepStrictEqual(snapshotOf(b, 'item').p1, r1, 'live machine disagrees with a fresh replay');
});

// ---------------------------------------------------------------------------
scenario('replaying the same log twice changes nothing (idempotence)', (dir) => {
  const a = makeStore('ALPHA', dir);
  a.load();
  a.commit('item', [{ uid: 'p1', allocated_to: 'New Stock', cost: '5.00' }]);
  a.read('item');
  a.commit('item', [{ uid: 'p1', allocated_to: 'Bubble 3' }]);

  const once = makeStore('READER', dir);
  once.load();
  const first = snapshotOf(once, 'item');
  // Force a full re-read of every log from offset 0.
  once._internal.offsets.clear();
  once.refresh();
  const second = snapshotOf(once, 'item');
  assert.deepStrictEqual(first, second, 'replaying ops changed the state');
});

// ---------------------------------------------------------------------------
scenario('concurrent assignments to one order line both survive', (dir) => {
  const a = makeStore('ALPHA', dir);
  const b = makeStore('BRAVO', dir);
  a.load();
  b.load();

  // The array-append case that last-writer-wins would have destroyed.
  a.commit('assignRecord', [{ id: 'r1', orderKey: 'PO-1', lineIdx: '0', qty: 2, dest: 'BUBBLE A' }]);
  b.commit('assignRecord', [{ id: 'r2', orderKey: 'PO-1', lineIdx: '0', qty: 3, dest: 'BUBBLE B' }]);

  a.refresh();
  b.refresh();
  const ids = a.read('assignRecord').map((r) => r.id).sort();
  assert.deepStrictEqual(ids, ['r1', 'r2'], 'a concurrent assignment was lost');
  assert.deepStrictEqual(b.read('assignRecord').map((r) => r.id).sort(), ids, 'machines diverged');
});

// ---------------------------------------------------------------------------
scenario('concurrent edits to DIFFERENT bubbles both survive', (dir) => {
  const a = makeStore('ALPHA', dir);
  const b = makeStore('BRAVO', dir);
  a.load();
  a.commit('bubble', [{ id: 'b1', name: 'Counter 1' }, { id: 'b2', name: 'Counter 2' }]);
  b.load();

  a.read('bubble'); b.read('bubble');
  a.commit('bubble', [{ id: 'b1', name: 'Counter 1', notes: 'from ALPHA' }], { skipRefresh: true });
  b.commit('bubble', [{ id: 'b2', name: 'Counter 2', notes: 'from BRAVO' }], { skipRefresh: true });

  a.refresh(); b.refresh();
  const av = snapshotOf(a, 'bubble');
  assert.strictEqual(av.b1.notes, 'from ALPHA', 'lost a bubble edit — the old whole-map write bug');
  assert.strictEqual(av.b2.notes, 'from BRAVO', 'lost a bubble edit — the old whole-map write bug');
  assert.strictEqual(a.listConflicts().length, 0);
});

// ---------------------------------------------------------------------------
scenario('a conflict dismissed on one machine clears on the other', (dir) => {
  const a = makeStore('ALPHA', dir);
  const b = makeStore('BRAVO', dir);
  a.load();
  a.commit('item', [{ uid: 'p1', allocated_to: 'New Stock' }]);
  b.load();
  a.read('item'); b.read('item');
  a.commit('item', [{ uid: 'p1', allocated_to: 'X' }], { skipRefresh: true });
  b.commit('item', [{ uid: 'p1', allocated_to: 'Y' }], { skipRefresh: true });
  a.refresh(); b.refresh();

  assert.strictEqual(a.listConflicts().length, 1);
  a.ackConflict(a.listConflicts()[0].id);
  assert.strictEqual(a.listConflicts().length, 0, 'ack did not clear locally');
  b.refresh();
  assert.strictEqual(b.listConflicts().length, 0, 'ack did not replicate to the other machine');
});

// ---------------------------------------------------------------------------
scenario('a torn log line loses one op, not the file', (dir) => {
  const a = makeStore('ALPHA', dir);
  a.load();
  a.commit('item', [{ uid: 'p1', itemcode: 'PN-1' }]);
  a.commit('item', [{ uid: 'p2', itemcode: 'PN-2' }]);
  a.commit('item', [{ uid: 'p3', itemcode: 'PN-3' }]);

  // Corrupt the middle line, as a half-flushed SMB write would.
  const log = path.join(dir, 'crdt', 'ops', 'ALPHA.jsonl');
  const lines = fs.readFileSync(log, 'utf-8').split('\n').filter(Boolean);
  lines[1] = lines[1].slice(0, Math.floor(lines[1].length / 2));
  fs.writeFileSync(log, `${lines.join('\n')}\n`, 'utf-8');
  // Drop any snapshot so the reader is forced to rebuild from the damaged log.
  const snap = path.join(dir, 'crdt', 'snapshot.json');
  if (fs.existsSync(snap)) fs.unlinkSync(snap);

  const reader = makeStore('READER', dir);
  reader.load();
  const seen = Object.keys(snapshotOf(reader, 'item')).sort();
  assert.deepStrictEqual(seen, ['p1', 'p3'], `expected p1+p3 to survive, got ${seen.join(',')}`);
});

// ---------------------------------------------------------------------------
scenario('a machine with a fast clock does not win forever', (dir) => {
  const a = makeStore('ALPHA', dir);
  const b = makeStore('BRAVO', dir);
  a.load(); b.load();

  // BRAVO's clock is an hour fast: it writes with a far-future stamp.
  const realNow = Date.now;
  Date.now = () => realNow() + 60 * 60 * 1000;
  b.commit('item', [{ uid: 'p1', allocated_to: 'FROM-FAST-MACHINE' }]);
  Date.now = realNow;

  // ALPHA observes that stamp and must still be able to make a later change.
  a.refresh();
  a.read('item');
  a.commit('item', [{ uid: 'p1', allocated_to: 'FROM-NORMAL-MACHINE' }]);
  b.refresh();

  assert.strictEqual(
    snapshotOf(b, 'item').p1.allocated_to,
    'FROM-NORMAL-MACHINE',
    'a fast clock kept winning — HLC failed to absorb the drift'
  );
});

// ---------------------------------------------------------------------------
scenario('projections match merged state and stay byte-identical across machines', (dir) => {
  const a = makeStore('ALPHA', dir);
  const b = makeStore('BRAVO', dir);
  a.load();
  a.commit('item', [
    { uid: 'p1', itemcode: 'PN-1', allocated_to: 'New Stock', accountingPath: 'OUTSTANDING' },
    { uid: 'p2', itemcode: 'PN-2', allocated_to: 'CASHPAD', accountingPath: 'CASH_SALE' },
  ]);
  b.load();
  b.refresh();

  const file = path.join(dir, 'proj', 'outstanding_items.json');
  const written = JSON.parse(fs.readFileSync(file, 'utf-8'));
  assert.strictEqual(written.length, 1, 'OUTSTANDING projection should hold exactly p1');
  assert.strictEqual(written[0].uid, 'p1');

  const cash = JSON.parse(fs.readFileSync(path.join(dir, 'proj', 'cash_sales_items.json'), 'utf-8'));
  assert.strictEqual(cash.length, 1);
  assert.strictEqual(cash[0].uid, 'p2');

  // Both machines must produce identical bytes, or they would fight over the
  // projection files forever.
  const projA = require('./projections').buildProjections(a._internal.tables, {
    paths: { outstanding: 'x' }, buildOrdersIndex: () => [],
  });
  const projB = require('./projections').buildProjections(b._internal.tables, {
    paths: { outstanding: 'x' }, buildOrdersIndex: () => [],
  });
  assert.strictEqual(projA.x, projB.x, 'machines render different projection bytes');
});

// The seed is one commit of thousands of ops against an ops dir that does not
// exist yet, so no pull has ever run and `offsets` is empty when the size-based
// snapshot trigger fires mid-commit. A snapshot that then claims to cover none
// of our log is not wrong about the DATA — it holds every record — but it makes
// every later launch replay the whole log, and it makes compaction refuse to
// run forever, so the log grows without bound. The offset has to be advanced by
// the append itself, not only by a pull.
scenario('a snapshot records how much of our own log it covers', (dir) => {
  const a = makeStore('ALPHA', dir);
  a.load({ project: false });

  // First write of the process, exactly as the seeder does it: no prior pull,
  // because until this line there is nothing to pull from.
  a.commit('item', [
    { uid: 'p1', itemcode: 'PN-1', allocated_for: '10' },
    { uid: 'p2', itemcode: 'PN-2', allocated_for: '20' },
  ]);
  a.writeSnapshot();

  const logSize = fs.statSync(path.join(dir, 'crdt', 'ops', 'ALPHA.jsonl')).size;
  const snap = JSON.parse(fs.readFileSync(path.join(dir, 'crdt', 'snapshot.json'), 'utf-8'));
  assert.strictEqual(
    Number(snap.offsets.ALPHA || 0),
    logSize,
    'snapshot under-reports the log it covers — replay-every-launch and compaction never runs'
  );

  // And a restart from that snapshot must have nothing left to replay.
  const b = makeStore('ALPHA', dir);
  const replay = b.load({ project: false });
  assert.strictEqual(replay.applied, 0, 'restart re-applied ops the snapshot already held');
  assert.strictEqual(snapshotOf(b, 'item').p2.allocated_for, '20');
});

// Callers hand back whole collections to change one row — writeOrdersArchive
// commits all ~1,100 archived orders to add one. A stamp per record meant
// minting 1,099 that were thrown away, and because each one synchronously wrote
// the clock file (8ms inside Electron), archiving an order took 11 seconds with
// 19ms of it spent merging. Stamps are minted lazily now; this is the guard.
scenario('a whole-list commit mints one stamp per CHANGE, not per record', (dir) => {
  const a = makeStore('ALPHA', dir);
  a.load({ project: false });

  const many = [];
  for (let i = 0; i < 500; i += 1) many.push({ uid: `p${i}`, itemcode: `PN-${i}`, allocated_for: '1' });
  a.commit('item', many);

  // Baseline is now all 500. Change exactly one and write the whole list back.
  const readBack = a.read('item');
  const before = a._internal.clock.peek();
  const one = readBack.map((it) => (it.uid === 'p250' ? { ...it, allocated_for: '99' } : it));
  const res = a.commit('item', one);

  assert.strictEqual(res.ops, 1, 'a one-record change emitted more than one op');
  assert.strictEqual(a.read('item').find((i) => i.uid === 'p250').allocated_for, '99');

  // The clock must have advanced by exactly the one stamp that was used. If it
  // jumped 500, stamps are being minted for untouched records again.
  const advanced = Number(a._internal.clock.peek().split('.')[1]) - Number(before.split('.')[1]);
  const sameMs = a._internal.clock.peek().split('.')[0] === before.split('.')[0];
  if (sameMs) {
    assert.ok(advanced <= 1, `clock counter advanced ${advanced} for a single-record change`);
  }

  // And stamps must still be DISTINCT within one commit — recordCreatedAt uses
  // the oldest stamp in a record as its birth order, and projections sort by it,
  // so collapsing a commit to one shared stamp would reshuffle every file.
  const stamps = new Set();
  const logFile = path.join(dir, 'crdt', 'ops', 'ALPHA.jsonl');
  for (const line of fs.readFileSync(logFile, 'utf-8').split('\n')) {
    if (line.trim()) stamps.add(JSON.parse(line).h);
  }
  const opCount = fs.readFileSync(logFile, 'utf-8').split('\n').filter((l) => l.trim()).length;
  assert.strictEqual(stamps.size, opCount, 'two ops share a stamp — birth ordering would be ambiguous');
});

// A projection path that comes through undefined used to become the literal
// string "undefined" as an object key, and writing that is RELATIVE — so a
// business file appeared in the process working directory instead of on the
// share. It cost nothing here (a stray file in the repo, from this very test
// file passing a partial path set) but the same slip against a real config
// would put live data somewhere nobody would look for it.
scenario('a missing projection path is refused, not written to the CWD', (dir) => {
  const cwdBefore = fs.readdirSync(process.cwd());
  const a = createStore({
    fs,
    path,
    machineId: 'ALPHA',
    getCrdtDir: () => path.join(dir, 'crdt'),
    // Deliberately incomplete — every other projection path is undefined.
    getProjectionPaths: () => ({ outstanding: path.join(dir, 'proj', 'o.json') }),
    writeJsonAtomic,
    buildOrdersIndex: () => [],
    clockStatePath: path.join(dir, 'clock.json'),
    onChange: () => {},
  });
  a.load({ project: false });
  a.commit('item', [{ uid: 'p1', itemcode: 'PN-1' }]);

  assert.ok(!fs.existsSync('undefined'), 'wrote a file literally named "undefined" into the CWD');
  const cwdAfter = fs.readdirSync(process.cwd());
  assert.deepStrictEqual(cwdAfter, cwdBefore, 'a projection escaped into the working directory');
  // The one path that WAS supplied still has to be written.
  assert.ok(fs.existsSync(path.join(dir, 'proj', 'o.json')), 'the valid projection was skipped too');
});

console.log('');
if (failures.length) {
  console.log(`${failures.length} of ${caseNum} scenarios FAILED`);
  for (const f of failures) console.log(`\n--- ${f.name}\n${f.error.stack}`);
  process.exitCode = 1;
} else {
  console.log(`all ${caseNum} scenarios passed`);
}
try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
