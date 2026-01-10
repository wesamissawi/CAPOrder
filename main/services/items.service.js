const createItemsService = (deps) => {
  const { getQueueFile, readItemsAt, writeItemsAt, splitItemsByQueue, randomUUID } = deps;

  function readAllQueueItems() {
    const queues = ['OUTSTANDING', 'SAGE_AR', 'CASH_SALE'];
    const byQueue = {};
    queues.forEach((queue) => {
      const file = getQueueFile(queue);
      byQueue[queue] = readItemsAt(file);
    });
    return byQueue;
  }

  function writeItems(items) {
    const queues = ['OUTSTANDING', 'SAGE_AR', 'CASH_SALE'];

    // 1) Read current state of all queues
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

    // 3b) Remove items that are no longer present (honor deletions)
    Array.from(map.keys()).forEach((uid) => {
      if (!incomingUids.has(uid)) {
        map.delete(uid);
      }
    });

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
      if (a !== b) writeItemsAt(file, next);
    });
  }

  return { readAllQueueItems, writeItems };
};

module.exports = { createItemsService };
