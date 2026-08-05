// Hybrid logical clock.
//
// Every CRDT op carries a timestamp, and the merge rule is "highest timestamp
// wins". That makes the clock the thing the whole system's correctness rests
// on, which is exactly why plain Date.now() is not good enough here: the
// machines on this share are ordinary Windows boxes whose clocks drift by
// seconds, and a machine running 30s fast would win every conflict forever —
// silently reverting the other counter's work. (This is the same reason the
// item `rev` counter was introduced instead of a last_moved_at comparison.)
//
// An HLC fixes that by carrying BOTH a physical component and a logical
// counter, and — critically — advancing the local clock whenever it observes a
// remote timestamp from the future. So a fast machine drags everyone forward
// once, rather than winning repeatedly, and causally-later events always sort
// after the events they saw. Ties are broken by machineId so the order is
// total and identical on every machine.
//
// Wire format is a fixed-width string so a plain `<` comparison is the clock
// comparison — no parsing on the hot merge path:
//
//     000001785432163769.00003.GIRLSBOYS
//     |----- ms -------| |cnt| |-machine-|
//
// Fixed width matters: '9' > '10' lexicographically, but '09' < '10'. Widths
// below hold until the year 33658 and 100k ops inside a single millisecond.

const MS_WIDTH = 18;
const COUNTER_WIDTH = 5;
const MAX_COUNTER = 99999;

// How far ahead of our own clock we accept a remote timestamp before treating
// it as a broken clock rather than legitimate drift. A machine whose clock is
// wrong by days would otherwise pin the shared logical time into the future
// permanently, and every subsequent local edit would have to count up from
// there. 24h is far beyond real NTP drift but well short of a typo'd year.
const MAX_DRIFT_MS = 24 * 60 * 60 * 1000;

function pad(value, width) {
  return String(value).padStart(width, '0');
}

function formatHlc(ms, counter, machineId) {
  return `${pad(ms, MS_WIDTH)}.${pad(counter, COUNTER_WIDTH)}.${machineId}`;
}

// Parse is only needed for diagnostics and drift checks — never for ordering.
function parseHlc(stamp) {
  if (typeof stamp !== 'string') return null;
  const first = stamp.indexOf('.');
  const second = stamp.indexOf('.', first + 1);
  if (first < 0 || second < 0) return null;
  const ms = Number(stamp.slice(0, first));
  const counter = Number(stamp.slice(first + 1, second));
  if (!Number.isFinite(ms) || !Number.isFinite(counter)) return null;
  return { ms, counter, machineId: stamp.slice(second + 1) };
}

// The total order every merge decision uses. Returns <0, 0, >0 like a
// comparator. Because the encoding is fixed-width and ends in the machineId,
// string order IS (physical time, logical counter, machine) order.
function compareHlc(a, b) {
  const left = typeof a === 'string' ? a : '';
  const right = typeof b === 'string' ? b : '';
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function hlcMachine(stamp) {
  const parsed = parseHlc(stamp);
  return parsed ? parsed.machineId : '';
}

function hlcMillis(stamp) {
  const parsed = parseHlc(stamp);
  return parsed ? parsed.ms : 0;
}

// `persist`/`load` let the clock survive an app restart. Without it, a machine
// that restarts after its system clock was corrected backwards would issue
// timestamps below ones it already published, and its own recent writes would
// start losing to its own older ones.
//
// Persisting is COALESCED, not synchronous per stamp. It used to write on every
// tick and every advancing observe, which measured at 8ms a call inside Electron
// (a synchronous write to the user-data directory, scanned on close). One order
// archive mints ~1,300 stamps, so stamping cost 10.6 seconds against 19ms of
// actual merge work, and a startup that replays the op log paid it once per op.
//
// Coalescing is safe because this file is not the clock's source of truth. On
// startup every op read from every log is passed through observe(), so the real
// high-water mark is recovered from the logs themselves. What's left for this
// file to cover is the narrow case where the system clock moves BACKWARDS across
// a restart — and against the drift that guards against, a second of staleness
// is nothing.
const PERSIST_DEBOUNCE_MS = 1000;

function createClock({ machineId, now = Date.now, load = () => null, persist = () => {} }) {
  if (!machineId) throw new Error('createClock requires a machineId');

  const restored = load() || {};
  let lastMs = Number.isFinite(Number(restored.ms)) ? Number(restored.ms) : 0;
  let counter = Number.isFinite(Number(restored.counter)) ? Number(restored.counter) : 0;

  // What we have actually written, so a flush with nothing new to say is free.
  let savedMs = lastMs;
  let savedCounter = counter;
  let pending = null;

  // Write now. Called at commit boundaries (where the op log is already being
  // made durable) and on shutdown.
  function flush() {
    if (pending) {
      clearTimeout(pending);
      pending = null;
    }
    if (savedMs === lastMs && savedCounter === counter) return;
    try {
      persist({ ms: lastMs, counter });
      savedMs = lastMs;
      savedCounter = counter;
    } catch {
      // A clock that can't persist is still correct for this run; the restart
      // hazard above is rare enough that it must not block a save.
    }
  }

  function save() {
    if (pending) return; // already scheduled — this is the coalescing
    pending = setTimeout(() => {
      pending = null;
      flush();
    }, PERSIST_DEBOUNCE_MS);
    // Never hold the process open just to write a clock file.
    if (typeof pending.unref === 'function') pending.unref();
  }

  // Issue a new timestamp for a local event.
  function tick() {
    const physical = now();
    if (physical > lastMs) {
      lastMs = physical;
      counter = 0;
    } else {
      // Clock stalled or went backwards — keep moving via the logical counter
      // so timestamps stay strictly increasing.
      counter += 1;
      if (counter > MAX_COUNTER) {
        lastMs += 1;
        counter = 0;
      }
    }
    save();
    return formatHlc(lastMs, counter, machineId);
  }

  // Absorb a timestamp seen from another machine. This is what keeps the
  // cluster's logical time monotonic across clock skew: after observing a
  // remote stamp, every timestamp we issue sorts above it.
  function observe(stamp) {
    const parsed = parseHlc(stamp);
    if (!parsed) return;
    const physical = now();
    // Ignore stamps implausibly far in the future — a machine with a badly
    // wrong clock must not drag the shared logical time along with it.
    if (parsed.ms > physical + MAX_DRIFT_MS) {
      console.warn('[crdt/hlc] ignoring far-future timestamp', stamp);
      return;
    }
    if (parsed.ms > lastMs) {
      lastMs = parsed.ms;
      counter = parsed.counter;
      save();
    } else if (parsed.ms === lastMs && parsed.counter > counter) {
      counter = parsed.counter;
      save();
    }
  }

  function peek() {
    return formatHlc(lastMs, counter, machineId);
  }

  return { tick, observe, peek, flush, machineId };
}

module.exports = {
  createClock,
  compareHlc,
  parseHlc,
  formatHlc,
  hlcMachine,
  hlcMillis,
  MAX_DRIFT_MS,
};
