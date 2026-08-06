const { writeFileAtomic } = require('../utils/atomicWrite');

const createItemsService = (deps) => {
  // Item storage now lives in the replicated CRDT store (main/crdt/). This
  // service keeps what is genuinely its own job — deriving and appending the
  // lifecycle history — and delegates persistence.
  const { getQueueFile, readAllQueueItems, writeItemRecords, randomUUID, fs, path } = deps;

  // Append-only lifecycle log so a part's whole journey can be traced — when it
  // was created, moved between bubbles, sent to Sage / CashPad, and deleted.
  // Stored as JSONL (one event per line) rather than a JSON array so appends
  // are cheap and, over the shared drive, a torn concurrent write costs at most
  // one line instead of clobbering the entire log. Lives next to the queue
  // files but is NOT one of the watched queues, so touching it never triggers
  // an items:updated push.
  const HISTORY_MAX_BYTES = 6 * 1024 * 1024; // ~6 MB before we trim the tail
  const HISTORY_KEEP_LINES = 20000;

  function getHistoryFile() {
    return path.join(path.dirname(getQueueFile('OUTSTANDING')), 'item_history.jsonl');
  }

  function readHistory() {
    try {
      const file = getHistoryFile();
      if (!fs.existsSync(file)) return [];
      const raw = fs.readFileSync(file, 'utf-8');
      const out = [];
      for (const line of raw.split(/\r?\n/)) {
        const s = line.trim();
        if (!s) continue;
        try { out.push(JSON.parse(s)); } catch { /* skip a torn/garbled line */ }
      }
      return out;
    } catch (e) {
      console.warn('[items] history read failed', e?.message || e);
      return [];
    }
  }

  // Best-effort tail-trim once the log grows past HISTORY_MAX_BYTES. Only reads
  // + rewrites when the cheap size check trips, so ordinary appends stay O(1).
  // This is a whole-file rewrite, unlike the lock-free appendFileSync above, so
  // it's written through the temp+rename atomic helper: a plain writeFileSync
  // here would let another machine's readHistory() see a truncated/half-written
  // file mid-write. A single appendFileSync landing in the brief window between
  // this read and the rename can still be lost — acceptable for a best-effort
  // audit trail, same tradeoff the class comment above already accepts for two
  // appends racing each other.
  function trimHistoryIfLarge(file) {
    try {
      if (!fs.existsSync(file)) return;
      const { size } = fs.statSync(file);
      if (size <= HISTORY_MAX_BYTES) return;
      const lines = fs.readFileSync(file, 'utf-8').split(/\r?\n/).filter((l) => l.trim());
      const kept = lines.slice(Math.max(0, lines.length - HISTORY_KEEP_LINES));
      writeFileAtomic(file, kept.join('\n') + '\n');
    } catch (e) {
      console.warn('[items] history trim failed', e?.message || e);
    }
  }

  // Non-fatal: a history-write failure must never abort/undo the item write it
  // is describing.
  function appendHistory(records) {
    if (!records || !records.length) return;
    try {
      const file = getHistoryFile();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const payload = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
      fs.appendFileSync(file, payload, 'utf-8');
      trimHistoryIfLarge(file);
    } catch (e) {
      console.warn('[items] history append failed', e?.message || e);
    }
  }

  // Labels for the accountingPath (queue) an item lands in. A move that changes
  // the queue is the "headline" event; a plain bubble change within the same
  // queue is a "moved" event.
  function pathEvent(toPath) {
    if (toPath === 'SAGE_AR') return 'sent_to_sage';
    if (toPath === 'CASH_SALE') return 'sent_to_cashpad';
    return 'returned_to_stock';
  }

  function mkHistoryRecord(it, event, at, extra = {}) {
    return {
      uid: it.uid,
      itemcode: it.itemcode || '',
      reference_num: it.reference_num || '',
      allocated_to: it.allocated_to || '',
      accountingPath: it.accountingPath || '',
      cost: it.cost ?? '',
      warehouse: it.warehouse || '',
      source_inv: it.source_inv || '',
      invoice_num: it.invoice_num || '',
      quantity: it.quantity ?? '',
      date: it.date || '',
      event,
      at,
      ...extra,
    };
  }

  // Writes are upserts by uid, and only the FIELDS that changed are published
  // (see main/crdt/merge.js). Items absent from `items` are KEPT — another
  // machine may have added them while this caller's state was stale, and
  // "absent = delete" is how whole files used to get erased. Deletions happen
  // only for uids explicitly listed in `deletedUids`.
  //
  // The old per-item `rev` gate that used to live here is gone. It was a
  // one-dimensional approximation of causality: it could tell that a writer was
  // behind, but not WHAT it was behind on, so it had to reject the entire item
  // — losing the parts of the write that were perfectly valid — and it fell
  // back to last-writer-wins whenever two machines happened to be on the same
  // rev. Field-level merge with a hybrid logical clock subsumes it: a stale
  // writer's untouched fields now emit no ops at all, and a genuine collision
  // is resolved deterministically and reported rather than silently dropped.
  // The `rev` FIELD is still carried on items for the renderer's benefit; it is
  // simply no longer load-bearing for concurrency.
  function writeItems(items, options = {}) {
    // historyEvent: { event, extra } — an event the CALLER knows about that the
    // diff below can't infer. Sending a sale to Sage stamps an invoice number
    // on each part without moving it between bubbles or queues, so nothing in
    // the derived events fires; this is how that still reaches the lifecycle
    // log. When set it replaces the derived event for the incoming items, so a
    // move that also carries one traces as the caller's event, not two.
    // fromClient: this array came back from the renderer, so it must be diffed
    // against what the renderer was shown rather than against a fresh read.
    const {
      deletedUids = [],
      deleteReason = 'deleted',
      historyEvent = null,
      clearFields = null,
      fromClient = false,
    } = options;
    // Removal isn't always a delete: archiving a sold bubble ('archived') or a
    // return slip whose credit came back ('credit_received') also remove items
    // from the active queues, but should trace as themselves, not 'deleted'.
    const REMOVAL_EVENTS = { archived: 'archived', credit_received: 'credit_received' };
    const removalEvent = REMOVAL_EVENTS[deleteReason] || 'deleted';
    const queues = ['OUTSTANDING', 'SAGE_AR', 'CASH_SALE'];

    // 1) Current state, straight from the replicated store. Still read BEFORE
    //    the write, because the history events below are a diff against it.
    const currentByQueue = readAllQueueItems();

    // 2) Build uid -> item map from current items
    const map = new Map();
    queues.forEach((queue) => {
      (currentByQueue[queue] || []).forEach((it) => {
        if (!it) return;
        const uid = it.uid || randomUUID();
        map.set(uid, { ...it, uid });
      });
    });

    // 3) Derive the lifecycle events this write implies. This is now the ONLY
    //    thing the loop does — merging is the store's job.
    const historyAt = new Date().toISOString();
    const historyEvents = [];
    const normPath = (p) => p || 'OUTSTANDING';

    const incomingUids = new Set();
    (items || []).forEach((it) => {
      if (!it) return;
      const uid = it.uid || randomUUID();
      incomingUids.add(uid);
      const existing = map.get(uid);
      // Trace the item's journey: first appearance, a queue change (Sage /
      // CashPad / back to stock), or a plain bubble move within the same queue.
      if (historyEvent && historyEvent.event) {
        historyEvents.push(
          mkHistoryRecord(it, historyEvent.event, historyAt, historyEvent.extra || {})
        );
      } else if (!existing) {
        historyEvents.push(mkHistoryRecord(it, 'created', historyAt));
      } else {
        const fromPath = normPath(existing.accountingPath);
        const toPath = normPath(it.accountingPath);
        const fromBubble = existing.allocated_to || '';
        const toBubble = it.allocated_to || '';
        if (fromPath !== toPath) {
          historyEvents.push(
            mkHistoryRecord(it, pathEvent(toPath), historyAt, {
              from_bubble: fromBubble,
              to_bubble: toBubble,
              from_path: fromPath,
              to_path: toPath,
            })
          );
        } else if (fromBubble !== toBubble) {
          historyEvents.push(
            mkHistoryRecord(it, 'moved', historyAt, {
              from_bubble: fromBubble,
              to_bubble: toBubble,
            })
          );
        }
      }
      map.set(uid, { ...it, uid });
    });

    // 3b) Trace deletions. Snapshot each removed item first so its removal is
    //     described by what it WAS, not by an empty record.
    let removedCount = 0;
    (deletedUids || []).forEach((uid) => {
      if (uid && map.has(uid)) {
        historyEvents.push(mkHistoryRecord(map.get(uid), removalEvent, historyAt));
        removedCount += 1;
      }
    });
    if (removedCount > 0) {
      console.warn(`[items] write removes ${removedCount} item(s) (incoming ${incomingUids.size})`);
    }

    // 4) Publish. One call: the store diffs each item against what this process
    //    was last served, appends only the changed fields to our own op log,
    //    and rewrites whichever of the three queue projections changed.
    const result = writeItemRecords(items || [], { deletedUids, clearFields, fromClient });

    // 5) Flush the lifecycle events (after the ops are durable; failures here
    //    are swallowed inside appendHistory).
    if (historyEvents.length) {
      appendHistory(historyEvents);
    }
    return result;
  }

  return { readAllQueueItems, writeItems, readHistory };
};

module.exports = { createItemsService };
