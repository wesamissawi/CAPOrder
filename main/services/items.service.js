const createItemsService = (deps) => {
  const { getQueueFile, readItemsAt, writeItemsAt, splitItemsByQueue, randomUUID, fs, path } = deps;

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
    const { replaceAll = false, deletedUids = [] } = options;
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

    // 3) Apply incoming items (overwrite by uid)
    const incomingUids = new Set();
    (items || []).forEach((it) => {
      if (!it) return;
      const uid = it.uid || randomUUID();
      incomingUids.add(uid);
      map.set(uid, { ...it, uid });
    });

    // 3b) Apply deletions
    let removedCount = 0;
    (deletedUids || []).forEach((uid) => {
      if (uid && map.has(uid)) {
        map.delete(uid);
        removedCount += 1;
      }
    });
    if (replaceAll) {
      Array.from(map.keys()).forEach((uid) => {
        if (!incomingUids.has(uid)) {
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
  }

  return { readAllQueueItems, writeItems };
};

module.exports = { createItemsService };
