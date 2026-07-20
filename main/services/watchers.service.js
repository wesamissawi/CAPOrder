const createWatchersService = (deps) => {
  const {
    fs,
    getWin,
    getQueueFile,
    getOrdersFile,
    ensureDataFileAt,
    ensureSharedBubbleFile,
    readItems,
    readOrders,
    readSharedBubbleData,
    scheduleSageProcessing,
    getSageIntegrationActive,
    getSagePoActive,
    getSageLockFile,
    readSageLock,
    sageLockIsLive,
    getMachineId,
    onSageLockForcedOff,
    getBubbleLocksFile,
    readBubbleLocks,
  } = deps;

  const chokidar = (() => {
    if (deps?.chokidar && typeof deps.chokidar.watch === 'function') return deps.chokidar;
    try { return require('chokidar'); } catch { return null; }
  })();
  const useChokidar = Boolean(chokidar && typeof chokidar.watch === 'function');

  let itemsWatchers = [];
  let ordersWatcher = null;
  let bubbleSharedWatcher = null;
  let sageLockWatcher = null;
  let bubbleLockWatcher = null;
  const debounceTimers = new Map();

  function debounce(key, fn, wait = 200) {
    if (debounceTimers.has(key)) clearTimeout(debounceTimers.get(key));
    const id = setTimeout(() => {
      debounceTimers.delete(key);
      fn();
    }, wait);
    debounceTimers.set(key, id);
  }

  function createFileWatcher(file, onChange, label) {
    if (useChokidar) {
      const watcher = chokidar.watch(file, {
        ignoreInitial: true,
        awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 100 },
      });
      const handler = () => debounce(`${label}:${file}`, () => onChange('change'));
      watcher.on('add', handler);
      watcher.on('change', handler);
      watcher.on('unlink', handler);
      return () => {
        try { watcher.close(); } catch {}
      };
    }

    let watcher;
    const start = () => {
      try {
        if (watcher) watcher.close();
      } catch {}
      watcher = fs.watch(file, { persistent: false }, (eventType) => {
        debounce(`${label}:${file}`, () => onChange(eventType));
        if (eventType === 'rename') {
          // file replaced via atomic write; reattach watcher
          setTimeout(start, 100);
        }
      });
    };
    start();
    return () => {
      try { watcher && watcher.close(); } catch {}
    };
  }

  function startWatching() {
    const files = [
      getQueueFile('OUTSTANDING'),
      getQueueFile('SAGE_AR'),
      getQueueFile('CASH_SALE'),
    ];
    itemsWatchers.forEach((w) => {
      try {
        if (typeof w === 'function') w();
        else if (w && typeof w.close === 'function') w.close();
      } catch {}
    });
    itemsWatchers = [];
    files.forEach((file) => {
      ensureDataFileAt(file);
      const w = createFileWatcher(file, () => {
        // A failed/partial read (e.g. another machine mid-write over SMB) must
        // never reach the renderer: it would look like items were deleted and
        // a later save would erase them for real. Skip the push instead.
        let arr;
        try {
          arr = readItems();
        } catch (e) {
          console.error('[main] watch -> items read failed, skipping push', e?.message || e);
          return;
        }
        const win = getWin();
        if (win && !win.isDestroyed()) {
          win.webContents.send('items:updated', arr);
          console.log('[main] watch -> items:updated', arr.length);
        }
      }, 'items');
      itemsWatchers.push(w);
    });
  }

  function startBubbleSharedWatching() {
    try {
      if (typeof bubbleSharedWatcher === 'function') bubbleSharedWatcher();
      else if (bubbleSharedWatcher && typeof bubbleSharedWatcher.close === 'function') bubbleSharedWatcher.close();
    } catch {}
    const target = ensureSharedBubbleFile();
    bubbleSharedWatcher = createFileWatcher(target, () => {
      const data = readSharedBubbleData();
      const win = getWin();
      if (win && !win.isDestroyed()) {
        win.webContents.send('bubble-shared:updated', data);
        console.log('[main] watch -> bubble-shared:updated');
      }
    }, 'bubble-shared');
  }

  function startOrdersWatching() {
    const file = getOrdersFile();
    try {
      if (typeof ordersWatcher === 'function') ordersWatcher();
      else if (ordersWatcher && typeof ordersWatcher.close === 'function') ordersWatcher.close();
    } catch {}
    ensureDataFileAt(file);
    ordersWatcher = createFileWatcher(file, () => {
      let arr;
      try {
        arr = readOrders();
      } catch (e) {
        console.error('[main] watch -> orders read failed, skipping push', e?.message || e);
        return;
      }
      const win = getWin();
      if (win && !win.isDestroyed()) {
        win.webContents.send('orders:updated', arr);
        console.log('[main] watch -> orders:updated', Array.isArray(arr) ? arr.length : 0);
      }
      if (getSageIntegrationActive())
        scheduleSageProcessing();
    }, 'orders');
  }

  function stopOrdersWatching() {
    try {
      if (typeof ordersWatcher === 'function') ordersWatcher();
      else if (ordersWatcher && typeof ordersWatcher.close === 'function') ordersWatcher.close();
    } catch {}
    ordersWatcher = null;
  }

  function startSageLockWatching() {
    if (!getSageLockFile || !readSageLock || !getMachineId) return;
    try {
      if (typeof sageLockWatcher === 'function') sageLockWatcher();
      else if (sageLockWatcher && typeof sageLockWatcher.close === 'function') sageLockWatcher.close();
    } catch {}
    const file = getSageLockFile();
    if (!file) return;
    sageLockWatcher = createFileWatcher(file, () => {
      const lock = readSageLock();
      const ownId = getMachineId();
      const win = getWin();
      const lockedByOther = lock && lock.machineId && lock.machineId !== ownId;
      const poActive = getSagePoActive ? getSagePoActive() : false;
      const forcedOff = Boolean(lockedByOther && poActive);
      if (forcedOff) {
        console.log('[sage-lock] another machine claimed the lock — forcing local PO OFF', lock.machineId);
        onSageLockForcedOff?.();
      }
      if (win && !win.isDestroyed()) {
        win.webContents.send('sage:lock-changed', {
          lock: lock || null,
          lockIsLive: Boolean(lock && sageLockIsLive?.(lock)),
          ownMachineId: ownId,
          lockedByOther: Boolean(lockedByOther),
          forcedOff,
        });
      }
    }, 'sage-lock');
  }

  function startBubbleLockWatching() {
    if (!getBubbleLocksFile || !readBubbleLocks) return;
    try {
      if (typeof bubbleLockWatcher === 'function') bubbleLockWatcher();
      else if (bubbleLockWatcher && typeof bubbleLockWatcher.close === 'function') bubbleLockWatcher.close();
    } catch {}
    const file = getBubbleLocksFile();
    if (!file) return;
    bubbleLockWatcher = createFileWatcher(file, () => {
      const locks = readBubbleLocks();
      const win = getWin();
      if (win && !win.isDestroyed()) {
        win.webContents.send('bubble-lock:updated', {
          locks,
          ownMachineId: getMachineId ? getMachineId() : null,
        });
      }
    }, 'bubble-lock');
  }

  return {
    startWatching,
    startBubbleSharedWatching,
    startOrdersWatching,
    stopOrdersWatching,
    startSageLockWatching,
    startBubbleLockWatching,
  };
};

module.exports = { createWatchersService };
