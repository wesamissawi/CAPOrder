const createItemsService = (deps) => {
  const { getQueueFile, readItemsAt, writeItemsAt, splitItemsByQueue, randomUUID, fs, path } = deps;

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
  function trimHistoryIfLarge(file) {
    try {
      if (!fs.existsSync(file)) return;
      const { size } = fs.statSync(file);
      if (size <= HISTORY_MAX_BYTES) return;
      const lines = fs.readFileSync(file, 'utf-8').split(/\r?\n/).filter((l) => l.trim());
      const kept = lines.slice(Math.max(0, lines.length - HISTORY_KEEP_LINES));
      fs.writeFileSync(file, kept.join('\n') + '\n', 'utf-8');
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

  function readAllQueueItems() {
    // readItemsAt throws on read/parse failure (ITEMS_READ_FAILED). Let it
    // propagate: a write based on a failed read is how data gets erased.
    const queues = ['OUTSTANDING', 'SAGE_AR', 'CASH_SALE'];
    const byQueue = {};
    queues.forEach((queue) => {
      const file = getQueueFile(queue);
      byQueue[queue] = readItemsAt(file);
    });
    return byQueue;
  }

  // Before a write that REMOVES items, keep a timestamped copy of the current
  // file in <dir>/backups so an accidental wipe is recoverable. Keep the
  // newest 40 backups per file.
  function backupBeforeDeletion(file) {
    try {
      if (!fs || !path) return;
      if (!fs.existsSync(file)) return;
      const dir = path.join(path.dirname(file), 'backups');
      fs.mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const base = path.basename(file, '.json');
      fs.copyFileSync(file, path.join(dir, `${base}.${stamp}.json`));
      const siblings = fs.readdirSync(dir)
        .filter((f) => f.startsWith(`${base}.`) && f.endsWith('.json'))
        .sort();
      while (siblings.length > 40) {
        const oldest = siblings.shift();
        try { fs.unlinkSync(path.join(dir, oldest)); } catch {}
      }
    } catch (e) {
      console.warn('[items] backup before deletion failed', file, e);
    }
  }

  // Writes are upserts by uid. Items on disk that are absent from `items` are
  // KEPT — another machine may have added them while this caller's state was
  // stale, and "absent = delete" is how whole files used to get erased.
  // Deletions happen only for uids explicitly listed in `deletedUids`
  // (or, legacy, when replaceAll: true is passed — no caller does anymore).
  function writeItems(items, options = {}) {
    const { replaceAll = false, deletedUids = [], deleteReason = 'deleted' } = options;
    // Removal isn't always a delete: archiving a sold bubble ('archived') or a
    // return slip whose credit came back ('credit_received') also remove items
    // from the active queues, but should trace as themselves, not 'deleted'.
    const REMOVAL_EVENTS = { archived: 'archived', credit_received: 'credit_received' };
    const removalEvent = REMOVAL_EVENTS[deleteReason] || 'deleted';
    const queues = ['OUTSTANDING', 'SAGE_AR', 'CASH_SALE'];

    // 1) Read current state of all queues (throws — and aborts the write —
    //    if any queue file is unreadable)
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

    // 3) Apply incoming items (upsert by uid, version-gated).
    //    An incoming item overwrites the on-disk copy only when it is NOT
    //    strictly older by rev. i.e. we reject a write whose rev is lower than
    //    what's already on disk — that's a stale writer (e.g. another machine
    //    saving its older in-memory copy, or a file-watch push that fired
    //    before a local move was persisted) trying to revert a newer change.
    //    Equal rev is accepted so writers that don't bump rev (e.g. lock
    //    metadata, legacy paths) still save rather than being silently dropped;
    //    the trade-off is that a true concurrent same-rev edit is last-writer-
    //    wins, which would need a machineId tiebreak to resolve deterministically.
    const revNum = (it) => {
      const r = Number(it && it.rev);
      return Number.isFinite(r) ? r : 0;
    };
    // Lifecycle events accumulated across this write (create / move / queue
    // change / delete), flushed once to the JSONL log at the end.
    const historyAt = new Date().toISOString();
    const historyEvents = [];
    const normPath = (p) => p || 'OUTSTANDING';

    const incomingUids = new Set();
    let rejectedStale = 0;
    (items || []).forEach((it) => {
      if (!it) return;
      const uid = it.uid || randomUUID();
      incomingUids.add(uid);
      const existing = map.get(uid);
      if (existing && revNum(it) < revNum(existing)) {
        rejectedStale += 1;
        return; // keep the newer on-disk copy
      }
      // Trace the item's journey: first appearance, a queue change (Sage /
      // CashPad / back to stock), or a plain bubble move within the same queue.
      if (!existing) {
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
    if (rejectedStale > 0) {
      console.warn(`[items] write rejected ${rejectedStale} stale item(s) (older rev than disk)`);
    }

    // 3b) Apply deletions. Snapshot each removed item first so its deletion can
    //     be traced (see appendHistory below).
    let removedCount = 0;
    (deletedUids || []).forEach((uid) => {
      if (uid && map.has(uid)) {
        historyEvents.push(mkHistoryRecord(map.get(uid), removalEvent, historyAt));
        map.delete(uid);
        removedCount += 1;
      }
    });
    if (replaceAll) {
      Array.from(map.keys()).forEach((uid) => {
        if (!incomingUids.has(uid)) {
          historyEvents.push(mkHistoryRecord(map.get(uid), removalEvent, historyAt));
          map.delete(uid);
          removedCount += 1;
        }
      });
    }
    if (removedCount > 0) {
      console.warn(`[items] write removes ${removedCount} item(s) (incoming ${incomingUids.size})`);
    }

    // 4) Split merged list back into queues
    const mergedList = Array.from(map.values());
    const buckets = splitItemsByQueue(mergedList);

    // 5) Atomically write each queue file if changed
    queues.forEach((queue) => {
      const file = getQueueFile(queue);
      const current = currentByQueue[queue] || [];
      const next = buckets[queue];
      const a = JSON.stringify(current ?? []);
      const b = JSON.stringify(next ?? []);
      if (a !== b) {
        if ((next?.length ?? 0) < current.length) backupBeforeDeletion(file);
        writeItemsAt(file, next);
      }
    });

    // 6) Flush the lifecycle events for this write (after the queues are safely
    //    written; failures here are swallowed inside appendHistory).
    if (historyEvents.length) {
      appendHistory(historyEvents);
    }
  }

  return { readAllQueueItems, writeItems, readHistory };
};

module.exports = { createItemsService };
