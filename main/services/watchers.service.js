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
  } = deps;

  let itemsWatchers = [];
  let ordersWatcher = null;
  let bubbleSharedWatcher = null;

  function startWatching() {
    const files = [
      getQueueFile('OUTSTANDING'),
      getQueueFile('SAGE_AR'),
      getQueueFile('CASH_SALE'),
    ];
    itemsWatchers.forEach((w) => {
      try { w.close(); } catch {}
    });
    itemsWatchers = [];
    files.forEach((file) => {
      ensureDataFileAt(file);
      const w = fs.watch(file, { persistent: false }, () => {
        const arr = readItems();
        const win = getWin();
        if (win && !win.isDestroyed()) {
          win.webContents.send('items:updated', arr);
          console.log('[main] watch -> items:updated', arr.length);
        }
      });
      itemsWatchers.push(w);
    });
  }

  function startBubbleSharedWatching() {
    try { if (bubbleSharedWatcher) bubbleSharedWatcher.close(); } catch {}
    const target = ensureSharedBubbleFile();
    bubbleSharedWatcher = fs.watch(target, { persistent: false }, () => {
      const data = readSharedBubbleData();
      const win = getWin();
      if (win && !win.isDestroyed()) {
        win.webContents.send('bubble-shared:updated', data);
        console.log('[main] watch -> bubble-shared:updated');
      }
    });
  }

  function startOrdersWatching() {
    const file = getOrdersFile();
    try { if (ordersWatcher) ordersWatcher.close(); } catch {}
    ensureDataFileAt(file);
    ordersWatcher = fs.watch(file, { persistent: false }, () => {
      const arr = readOrders();
      const win = getWin();
      if (win && !win.isDestroyed()) {
        win.webContents.send('orders:updated', arr);
        console.log('[main] watch -> orders:updated', Array.isArray(arr) ? arr.length : 0);
      }
      if (getSageIntegrationActive())
        scheduleSageProcessing();
    });
  }

  function stopOrdersWatching() {
    try { if (ordersWatcher) ordersWatcher.close(); } catch {}
    ordersWatcher = null;
  }

  return {
    startWatching,
    startBubbleSharedWatching,
    startOrdersWatching,
    stopOrdersWatching,
  };
};

module.exports = { createWatchersService };
