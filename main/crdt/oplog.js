// Per-machine append-only op logs.
//
// The layout is the whole point:
//
//     <share>/crdt/ops/<machineId>.jsonl     one file per machine
//
// A machine only ever APPENDS to its OWN file. Nothing in the system ever
// rewrites a file another machine writes. That single rule removes the entire
// class of failure this refactor exists to fix:
//
//   * No lost updates. There is no read-modify-write of shared state, so there
//     is no window in which one machine's save can overwrite another's.
//   * No rename races. writeJsonAtomic's tmp+rename needs delete access on the
//     destination, which is what produced the EPERM retries and the stranded
//     bubble_locks.json.tmp.* file sitting on the share. Appends need none of
//     that.
//   * A torn write costs one line, not a file. Same reasoning already proven by
//     item_history.jsonl — an unparseable line is skipped, and every other op
//     in the log survives. A torn 150KB JSON array, by contrast, is a total
//     loss and reads back as "no items".
//
// Reads are incremental: each log is tailed from the byte offset we last
// stopped at, so steady-state cost is proportional to what CHANGED, not to the
// size of the dataset. That is what keeps a shared folder over SMB usable.

const fs = require('fs');
const path = require('path');

const OPS_DIRNAME = 'ops';
const LOG_EXT = '.jsonl';

// Windows filenames can't contain these, and a hostname theoretically can.
function safeMachineFilename(machineId) {
  return String(machineId || 'unknown').replace(/[^A-Za-z0-9._-]/g, '_');
}

function opsDir(crdtDir) {
  return path.join(crdtDir, OPS_DIRNAME);
}

function logPathFor(crdtDir, machineId) {
  return path.join(opsDir(crdtDir), `${safeMachineFilename(machineId)}${LOG_EXT}`);
}

function listLogs(crdtDir) {
  const dir = opsDir(crdtDir);
  try {
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(LOG_EXT))
      .map((f) => ({ machineId: f.slice(0, -LOG_EXT.length), file: path.join(dir, f) }));
  } catch (e) {
    console.warn('[crdt/oplog] listLogs failed', e?.message || e);
    return [];
  }
}

function ensureOpsDir(crdtDir) {
  const dir = opsDir(crdtDir);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Serialize one op to a single line. Ops must never contain a raw newline or
// the line framing breaks — JSON.stringify escapes them, so this holds for any
// string value, but the assertion below catches a caller passing pre-encoded
// text with a literal newline in it.
function encodeOp(op) {
  const line = JSON.stringify(op);
  if (line.includes('\n')) throw new Error('[crdt/oplog] op encoded to a multi-line string');
  return line;
}

// Append ops to this machine's log.
//
// Written as ONE appendFileSync call, not one per op: a single append of a
// small buffer is the closest thing to an atomic operation SMB offers, and it
// keeps a multi-item save from interleaving with another process mid-batch.
function appendOps(crdtDir, machineId, ops) {
  if (!ops || !ops.length) return 0;
  ensureOpsDir(crdtDir);
  const file = logPathFor(crdtDir, machineId);
  const payload = `${ops.map(encodeOp).join('\n')}\n`;
  fs.appendFileSync(file, payload, 'utf-8');
  return Buffer.byteLength(payload, 'utf-8');
}

// Read new lines from `file` starting at `fromOffset`.
//
// Returns the ops parsed plus the offset to resume from next time. A trailing
// partial line (another machine's append caught mid-flight) is NOT consumed:
// the offset stops before it so the complete line is picked up on the next
// pass. Without that, a half-written op would be permanently skipped.
function readLogFrom(file, fromOffset) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return { ops: [], offset: fromOffset, missing: true };
  }

  // A log that shrank was truncated by its owner during compaction. Offsets no
  // longer mean anything, so re-read it whole.
  let start = fromOffset;
  if (stat.size < fromOffset) start = 0;
  if (stat.size === start) return { ops: [], offset: start, missing: false };

  let buffer;
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const length = stat.size - start;
    buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, start);
  } catch (e) {
    console.warn('[crdt/oplog] read failed', file, e?.message || e);
    return { ops: [], offset: fromOffset, missing: false, error: e };
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
  }

  const text = buffer.toString('utf-8');
  const lastNewline = text.lastIndexOf('\n');
  if (lastNewline < 0) {
    // Nothing complete yet — leave the offset where it was.
    return { ops: [], offset: start, missing: false };
  }

  const complete = text.slice(0, lastNewline);
  const consumed = Buffer.byteLength(complete, 'utf-8') + 1; // +1 for the \n
  const ops = [];
  let skipped = 0;
  for (const line of complete.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const op = JSON.parse(trimmed);
      if (op && op.h && op.e && op.k) ops.push(op);
      else skipped += 1;
    } catch {
      // A torn or garbled line. One op is lost; the rest of the log is intact.
      // This is the failure mode the whole append-only layout is chosen for.
      skipped += 1;
    }
  }
  if (skipped) console.warn('[crdt/oplog] skipped', skipped, 'unreadable op line(s) in', path.basename(file));

  return { ops, offset: start + consumed, missing: false, skipped };
}

// Rewrite this machine's OWN log, dropping ops already folded into the shared
// snapshot. Only ever called for the local machine — compacting someone else's
// log would reintroduce the concurrent-write problem this design removes.
//
// Uses tmp+rename because it IS a replace, not an append. That's acceptable
// here and nowhere else: the file has exactly one writer, so the rename can
// only ever race a reader, and a reader that misses it simply re-reads from
// offset 0 next pass (see the shrink check in readLogFrom).
function compactOwnLog(crdtDir, machineId, keepOps) {
  ensureOpsDir(crdtDir);
  const file = logPathFor(crdtDir, machineId);
  const dir = path.dirname(file);
  const tmp = path.join(dir, `${path.basename(file)}.tmp.${process.pid}.${Date.now()}`);
  const payload = keepOps.length ? `${keepOps.map(encodeOp).join('\n')}\n` : '';
  fs.writeFileSync(tmp, payload, 'utf-8');
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  }
  return Buffer.byteLength(payload, 'utf-8');
}

module.exports = {
  OPS_DIRNAME,
  opsDir,
  ensureOpsDir,
  logPathFor,
  listLogs,
  appendOps,
  readLogFrom,
  compactOwnLog,
  safeMachineFilename,
};
