// Bubble identity: the NAME is the primary key, and the record id is derived
// from it.
//
// Why this exists. Bubbles began as draggable boxes on a canvas, where the
// `bubbles` array was pure local React state rebuilt on each machine from
// `items.allocated_to`. The id was a React key and a drag handle — it never
// left the machine, so minting it with makeUid() per machine was correct, and
// the only per-bubble data (layout) lived in ui_state.json, which is still
// per-machine. When bubble notes and print extras became SHARED, that same
// machine-local id silently became a cross-machine primary key, but the
// minting was never revisited. Two machines seeing the same order name each
// minted their own uuid, so one order became two or three records on the
// share. Deleting an order removed only the id the closing machine happened to
// hold; the survivor kept the name alive and the order came back as an empty
// card.
//
// Nothing else ever used the id as identity: items reference a bubble by
// `allocated_to`, a plain name string, and the renderer already matched,
// grouped and de-duplicated bubbles by name everywhere. So deriving the id
// from the name doesn't invent a new rule — it makes the storage key agree
// with the identity the app has always actually used. Two machines now compute
// the same key without talking to each other, which is what makes a duplicate
// impossible rather than merely cleaned up afterwards.
//
// Bubbles cannot be renamed (there is no rename path anywhere in the renderer)
// and `uniqueName` already enforces case-insensitive name uniqueness, so the
// two things that would break a name-derived key can't happen.
//
// This file is the main-process copy. renderer/src/utils/inventory.js holds a
// byte-identical implementation — both sides have to compute the same key, and
// the renderer can't require() out of main.

const BUBBLE_ID_PREFIX = 'b:';

function bubbleIdForName(name) {
  const norm = String(name || '').trim().toLowerCase();
  return norm ? `${BUBBLE_ID_PREFIX}${norm}` : '';
}

// Fields that don't describe the order, only where the record lives.
const IDENTITY_FIELDS = new Set(['id', 'name']);

// "" and [] are what an auto-minted shell carries — a record created only
// because some machine saw a part pointing at a name it had never heard of.
// They are not opinions about the order, so they must never overwrite a real
// value. `false` and `0` ARE opinions (delivered: false, quoteDiscount: 0) and
// count as present.
function isMeaningful(value) {
  if (value === undefined || value === null) return false;
  if (value === '') return false;
  if (Array.isArray(value) && value.length === 0) return false;
  return true;
}

function contentScore(record) {
  let score = 0;
  for (const field of Object.keys(record || {})) {
    if (IDENTITY_FIELDS.has(field)) continue;
    if (isMeaningful(record[field])) score += 1;
  }
  return score;
}

// Collapse every record describing one order into a single record.
//
// The rule has to be a pure function of the records themselves, because each
// machine runs this independently and they have to land on byte-identical
// output or they will overwrite each other forever. So: rank by how much the
// record actually says about the order, break ties on id (never on arrival
// order, machine, or wall clock), and take each field from the highest-ranked
// record that has a real value for it.
//
// In practice the ranking rarely has to decide anything. The duplicates this
// was written for are always one record holding the whole order — notes, the
// Counter/Paid flags, the print signature, the Sales Order number — plus one or
// two empty shells minted by machines that only ever saw the name go past on a
// part. The shells score 0 and contribute nothing.
function mergeBubbleRecords(records) {
  const ranked = [...records].sort((a, b) => {
    const diff = contentScore(b) - contentScore(a);
    if (diff !== 0) return diff;
    return String(a?.id || '').localeCompare(String(b?.id || ''));
  });
  const winner = ranked[0] || {};
  const merged = { ...winner };
  for (const record of ranked) {
    for (const field of Object.keys(record || {})) {
      if (IDENTITY_FIELDS.has(field)) continue;
      // First writer wins because `ranked` runs best-first, and only a real
      // value can claim a field. A field no record has an opinion on keeps
      // whatever the winner had, including "" or [].
      if (isMeaningful(merged[field])) continue;
      if (isMeaningful(record[field])) merged[field] = record[field];
    }
  }
  merged.name = winner.name || '';
  merged.id = bubbleIdForName(merged.name);
  return merged;
}

// Rewrite every bubble record under its name-derived key, folding duplicates.
//
// Deliberately NOT guarded by a run-once marker like seedIfNeeded. This has to
// run on every startup, because the duplicates it fixes keep arriving for as
// long as any machine on the share is still on a build that mints uuids — a
// marker would declare victory after the first machine updated and leave every
// record the others published stranded. Running it repeatedly is free: once
// every record is already keyed by its name, there is nothing to move and it
// emits no ops at all.
function collapseBubbleIds(store) {
  const records = store.read('bubble');
  const groups = new Map();
  for (const record of records) {
    if (!record) continue;
    const target = bubbleIdForName(record.name);
    // A record with no name can't be resolved to an order. Leaving it alone is
    // the only safe move — it is also unreachable, since the renderer only ever
    // finds bubbles by name.
    if (!target) continue;
    if (!groups.has(target)) groups.set(target, []);
    groups.get(target).push(record);
  }

  let moved = 0;
  let merged = 0;
  for (const [target, group] of groups) {
    const legacy = group.filter((r) => r.id !== target).map((r) => r.id);
    if (!legacy.length) continue;
    const next = mergeBubbleRecords(group);
    // One commit: the record lands under its new key and the old keys are
    // tombstoned together, so no reader can ever see both or neither.
    store.commit('bubble', [next], { deletes: legacy, skipRefresh: true });
    moved += legacy.length;
    if (group.length > 1) merged += 1;
  }

  if (moved) {
    console.log(
      `[crdt/bubble-ids] rekeyed ${moved} bubble record(s) to name-derived ids` +
        (merged ? `, merging ${merged} duplicate group(s)` : '')
    );
  }
  return { moved, merged };
}

module.exports = { bubbleIdForName, mergeBubbleRecords, collapseBubbleIds, BUBBLE_ID_PREFIX };
