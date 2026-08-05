# Replicated store (CRDT)

Shared business data — items, orders, bubbles, assignments, payments — is
replicated between machines as a CRDT instead of being read and rewritten as
shared JSON files.

Run `node main/crdt/selftest.js` after touching anything in here.

## The problem this replaces

Every machine read the same JSON files off the share and wrote them back whole.
That is a read-modify-write with no coordination, so:

- **Lost updates.** A save wrote the array the caller was holding. Anything
  another machine changed in between was overwritten. The workarounds — upsert
  by uid, explicit `deletedUids`, the per-item `rev` gate, `mergeOrdersForWrite`,
  `removeOrdersFromDisk`'s counted removals — each closed one instance of this.
  `writeSharedBubbleData` never got one, and silently dropped a whole bubble
  whenever two machines edited different bubbles at once.
- **Rename races.** Atomic replace needs delete access on the destination, so
  concurrent writers hit `EPERM`/`EBUSY` and needed retries. A stranded
  `bubble_locks.json.tmp.*` on the share is one that lost.
- **Torn reads.** Reading a 150KB file mid-write yields garbage, which reads as
  "no items", and the next save makes that real. Hence the throw-don't-return-[]
  rule in `readItemsAt` and the skip-the-push guard in the watchers.

None of these are bugs in the fixes. They are all the same missing property:
**concurrent writes had no defined merge.**

## The design

```
<share>/crdt/
  ops/<machineId>.jsonl    append-only, ONE writer per file — the truth
  snapshot.json            compacted state, derived, an optimisation
  seeded.json              migration marker
<share>/outstanding_items.json   projection (derived)
<share>/orders.json              projection (derived)
...
```

**A machine only ever appends to its own log.** Nothing rewrites a file another
machine writes. Lost updates and rename races are gone structurally, not by
retry. A torn append costs one line; every other op in the log survives.

**Each op carries only the fields that changed**, plus a hybrid logical clock
stamp and the version of the record its writer was looking at:

```json
{"h":"000001785432163769.00003.GIRLSBOYS","e":"item","k":"<uid>",
 "o":"s","f":{"allocated_to":"Bubble 7"},"p":"<parent stamp>"}
```

**Merge is per-field last-writer-wins over a total order** (`hlc.js`,
`merge.js`). Every rule is a `max()` over that order, which is what makes the
merge commutative, associative and idempotent — machines can read each other's
logs in any order, twice, and land on identical state.

**Projections** (`projections.js`) write the merged state back out as the same
JSON files as before, so `ahk/sage_purchaser.ahk`, the backup workflow, and
anyone eyeballing the share all keep working. They are output, not a channel —
nothing reads them back.

## Why hand-rolled and not Automerge/Yjs

Automerge would work, but it stores opaque binary docs. This data has been
recovered by hand from readable JSON before, and that ability was worth more
than the code saved. Yjs is built around a network provider that doesn't exist
here. The merge rule needed is a few hundred lines and is fully tested.

## The rules that are easy to get wrong

**Absence is never deletion.** A commit describes the records it names.
Removing a record requires `deletes`; removing a *field* requires
`clearFields`. Dropping a key from an object does nothing — that is deliberate,
because callers legitimately commit partial records (an IPC handler stamping an
invoice number sends `{uid, invoice_num}`), and treating absence as intent
would wipe the rest of the part.

**Two baselines, and using the wrong one reintroduces the original bug.**
`read()` refreshes `served` and is right for main-process read-modify-write.
`checkout()` captures what the *renderer* was shown and is the baseline a
whole-array save from the UI must be judged against — diffing a minutes-old UI
array against a fresh read makes every remote change look like a deliberate
edit. Use `checkout()` on the paths that send data to the renderer
(`items:read`, the `items:updated` push) and `fromClient: true` on the writes
that come back.

**Load, seed, then project.** Projecting before the migration has seeded writes
the empty in-memory tables over every business file — i.e. it erases the share,
and the migration then reads what it just blanked. `start()` enforces the
order, and `writeProjections` additionally refuses to blank a populated file
while the store holds no records.

## What a CRDT does not fix

Convergence is agreement, not correctness.

- **Two people selling the same part** converges to one bubble and discards the
  other sale. That is why `conflicts.js` exists and why the review panel is in
  the UI — the machines agree, but a human still has to be told.
- **Unique sales-order numbers** cannot come from a CRDT. `sales_order_seq`
  keeps its exclusive-create lock file.
- **One-machine-at-a-time Sage PO processing** is mutual exclusion, not merge.
  The heartbeat lock stays.

## Conflict detection

A conflict is recorded only when two machines wrote the same field of the same
record *without having seen each other's value* — determined from the parent
stamp on each op, not from wall-clock proximity. Sequential edits never flag,
however fast; genuine forks always do. The check is symmetric, so every machine
computes the same conflict list regardless of the order ops arrived in.
Dismissals are themselves replicated (`conflictAck`), so clearing one clears it
everywhere.

## Measured against the real share (1085 archived orders, 182 items)

| | |
|---|---|
| cold start (snapshot + logs) | ~780ms |
| refresh, nothing new | ~1ms |
| refresh, one remote change | ~44ms |
| one item move on the wire | 191 bytes (was: rewrite a 150KB file) |
| snapshot | 5.9MB (per-field stamps; the 3.6MB order archive dominates) |

The snapshot is larger than the raw data because every field carries a stamp.
If that becomes a problem, the archive is the place to look — those records are
frozen after creation, so their per-field stamps are pure overhead and could
collapse to one stamp per record.
