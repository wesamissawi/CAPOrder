const registerOrdersIpc = (ipcMain, deps) => {
  const {
    readOrders,
    writeOrders,
    getOrdersFile,
    getSagePoActive,
    setSagePoActive,
    getSageInvoiceActive,
    setSageInvoiceActive,
    resetSageQueue,
    stopOrdersWatching,
    startOrdersWatching,
    scheduleSageProcessing,
    syncOutstandingInvoices,
    readItems,
    writeItems,
    makeOutstandingFromLine,
    fetchWorldOrders,
    fetchTransbecOrders,
    fetchProforceOrders,
    fetchCbkOrders,
    fetchTigerOrders,
    fetchBestBuyOrders,
    orderMatchesKey,
    runSageReconcile,
    applyReconcileResult,
    archiveCompletedOrders,
    archiveOrderByKey,
    deleteOrderByKey,
    searchOrdersArchive,
    purgeOldOrdersArchive,
    readOrdersArchive,
    writeOrdersArchive,
    readSageLock,
    writeSageLock,
    clearSageLock,
    sageLockIsLive,
    startSageHeartbeat,
    stopSageHeartbeat,
    getMachineId,
  } = deps;

  // Keep the orders.json watcher running while either Sage flow is active.
  function refreshOrdersWatch() {
    if (getSagePoActive?.() || getSageInvoiceActive?.()) {
      startOrdersWatching(deps.getWin());
    } else {
      stopOrdersWatching();
    }
  }

  ipcMain.handle('sage:get-lock', () => {
    try {
      const lock = readSageLock?.() || null;
      return {
        ok: true,
        lock,
        lockIsLive: Boolean(lock && sageLockIsLive?.(lock)),
        ownMachineId: getMachineId?.() || null,
      };
    } catch (e) {
      return { ok: false, lock: null, lockIsLive: false, ownMachineId: null };
    }
  });

  ipcMain.handle('orders:read', () => readOrders());
  ipcMain.handle('orders:get-path', () => ({ path: getOrdersFile() }));

  // Purchase-order processing: cross-machine exclusive via the heartbeat lock.
  ipcMain.handle('sage:set-po-active', (_evt, enable = true) => {
    try {
      if (enable === false) {
        setSagePoActive(false);
        resetSageQueue();
        stopSageHeartbeat?.();
        clearSageLock?.();
        refreshOrdersWatch();
        return { ok: true, active: false };
      }

      // Block if another machine currently holds a live (still heartbeating) lock.
      // A stale lock (owner crashed/closed) is fair game to take over.
      const lock = readSageLock?.();
      const ownId = getMachineId?.();
      if (lock && lock.machineId && lock.machineId !== ownId && sageLockIsLive?.(lock)) {
        console.warn('[sage] PO lock held by live machine', lock.machineId);
        return { ok: false, error: 'sage-locked', lockedBy: lock.machineId, running: lock.running === true };
      }

      const now = Date.now();
      writeSageLock?.({ machineId: ownId, lockedAt: now, heartbeatAt: now, running: false });
      startSageHeartbeat?.();
      setSagePoActive(true);
      startOrdersWatching(deps.getWin());
      scheduleSageProcessing();
      return { ok: true, active: true, path: getOrdersFile() };
    } catch (e) {
      console.error('[sage:set-po-active]', e);
      return { ok: false, error: e?.message || 'Failed to enable Sage purchase orders.' };
    }
  });

  // Invoice processing: local to this machine, never gated by the lock.
  ipcMain.handle('sage:set-invoice-active', (_evt, enable = true) => {
    try {
      if (enable === false) {
        setSageInvoiceActive(false);
        refreshOrdersWatch();
        return { ok: true, active: false };
      }
      setSageInvoiceActive(true);
      startOrdersWatching(deps.getWin());
      scheduleSageProcessing();
      return { ok: true, active: true, path: getOrdersFile() };
    } catch (e) {
      console.error('[sage:set-invoice-active]', e);
      return { ok: false, error: e?.message || 'Failed to enable Sage invoices.' };
    }
  });
  ipcMain.handle('orders:write', (_evt, orders) => {
    const current = readOrders();                  // existing array
    const a = JSON.stringify(current);
    const b = JSON.stringify(orders ?? []);
    if (a !== b) writeOrders(orders);              // only write if actually different
    try {
      syncOutstandingInvoices(orders ?? []);
    } catch (e) {
      console.error('[orders:write] sync outstanding failed', e);
    }
    if (getSagePoActive?.() || getSageInvoiceActive?.())
      scheduleSageProcessing();
    return { ok: true };
  });
  ipcMain.handle('orders:add-to-outstanding', () => {
    try {
      const orders = readOrders();
      const items = readItems();
      const newItems = [];
      let lineUpdates = 0;

      const updatedOrders = orders.map((order) => {
        if (!order || !Array.isArray(order.lineItems)) return order;
        const updatedLineItems = order.lineItems.map((line) => {
          if (!line || line.addedToOutstanding === true) return line;
          const outItem = makeOutstandingFromLine(order, line);
          newItems.push(outItem);
          lineUpdates += 1;
          return { ...line, addedToOutstanding: true };
        });
        return { ...order, lineItems: updatedLineItems };
      });

      if (newItems.length > 0) {
        const mergedItems = items.concat(newItems);
        writeItems(mergedItems);
        writeOrders(updatedOrders);
      }

      return { ok: true, added: newItems.length, linesUpdated: lineUpdates };
    } catch (e) {
      console.error('[orders:add-to-outstanding]', e);
      return { ok: false, error: e?.message || 'Failed to add outstanding items.' };
    }
  });

  ipcMain.handle('orders:bubblify-order', (_evt, refKey, bubbleName) => {
    try {
      const orders = readOrders();
      const items = readItems();
      const newItems = [];

      const updatedOrders = orders.map((order) => {
        if (!orderMatchesKey(order, refKey)) return order;
        if (!Array.isArray(order.lineItems)) return order;
        const updatedLineItems = order.lineItems.map((line) => {
          if (!line || line.addedToOutstanding === true) return line;
          const outItem = { ...makeOutstandingFromLine(order, line), allocated_to: bubbleName };
          newItems.push(outItem);
          return { ...line, addedToOutstanding: true };
        });
        return { ...order, lineItems: updatedLineItems };
      });

      if (newItems.length > 0) {
        writeItems(items.concat(newItems));
        writeOrders(updatedOrders);
      }

      return { ok: true, added: newItems.length };
    } catch (e) {
      console.error('[orders:bubblify-order]', e);
      return { ok: false, error: e?.message || 'Failed to bubblify order.' };
    }
  });

  ipcMain.handle('orders:fetch-world', async () => {
    return fetchWorldOrders();
  });

  ipcMain.handle('orders:fetch-transbec', async () => {
    return fetchTransbecOrders();
  });

  ipcMain.handle('orders:fetch-proforce', async () => {
    return fetchProforceOrders();
  });

  ipcMain.handle('orders:fetch-cbk', async () => {
    return fetchCbkOrders();
  });

  ipcMain.handle('orders:fetch-tiger', async () => {
    return fetchTigerOrders();
  });

  ipcMain.handle('orders:fetch-bestbuy', async () => {
    return fetchBestBuyOrders();
  });

  ipcMain.handle('orders:archive-completed', async (_evt, payload) => {
    try {
      return archiveCompletedOrders(payload);
    } catch (e) {
      console.error('[orders:archive-completed]', e);
      return { ok: false, error: e?.message || 'Failed to archive completed orders.' };
    }
  });

  ipcMain.handle('orders:archive-one', async (_evt, refKey, source) => {
    try {
      return archiveOrderByKey(refKey, source);
    } catch (e) {
      console.error('[orders:archive-one]', e);
      return { ok: false, error: e?.message || 'Failed to archive order.' };
    }
  });

  ipcMain.handle('orders:delete-one', async (_evt, refKey, source) => {
    try {
      return deleteOrderByKey(refKey, source);
    } catch (e) {
      console.error('[orders:delete-one]', e);
      return { ok: false, error: e?.message || 'Failed to delete order.' };
    }
  });

  ipcMain.handle('orders-archive:add-to-cash-sales', (_evt, order, line) => {
    try {
      const items = readItems();
      const syntheticOrder = {
        reference: order?.reference || '',
        source: order?.source || '',
        source_invoice: order?.invoice || '',
        orderDate: order?.date || '',
        warehouse: order?.warehouse || '',
        seller: order?.warehouse || '',
      };
      const newItem = {
        ...makeOutstandingFromLine(syntheticOrder, line),
        allocated_to: 'CASHPAD',
        accountingPath: 'CASH_SALE',
      };
      writeItems(items.concat(newItem));

      // Mark the line as added in the archive so the UI reflects it on next search
      const archive = readOrdersArchive();
      const updatedArchive = (archive || []).map((o) => {
        if ((o?.reference || '') !== order?.reference) return o;
        return {
          ...o,
          lineItems: (o.lineItems || []).map((l) => {
            if (l?.partNumber !== line?.partNumber || l?.partLineCode !== line?.partLineCode) return l;
            return { ...l, addedToOutstanding: true };
          }),
        };
      });
      writeOrdersArchive(updatedArchive);

      return { ok: true, item: newItem };
    } catch (e) {
      console.error('[orders-archive:add-to-cash-sales]', e);
      return { ok: false, error: e?.message || 'Failed to add item.' };
    }
  });

  ipcMain.handle('orders-archive:search', async (_evt, term) => {
    try {
      return searchOrdersArchive(term);
    } catch (e) {
      console.error('[orders-archive:search]', e);
      return { ok: false, error: e?.message || 'Failed to search orders archive.' };
    }
  });

  ipcMain.handle('orders-archive:purge-old', async () => {
    try {
      return purgeOldOrdersArchive(90);
    } catch (e) {
      console.error('[orders-archive:purge-old]', e);
      return { ok: false, error: e?.message || 'Failed to purge old orders.' };
    }
  });


  ipcMain.handle('orders:reconcile-totals', async (_event, refKeyRaw, providedOrder) => {
    try {
      const orders = readOrders();
      const key = (refKeyRaw || "").toString().trim().toUpperCase();
      if (!key) return { ok: false, error: 'Missing reference key.' };
      const target = (orders || []).find((o) => orderMatchesKey(o, key));
      const providedMatches = orderMatchesKey(providedOrder, key);
      const mergedTarget = target
        ? { ...target, ...(providedMatches ? providedOrder : {}) }
        : providedMatches
        ? providedOrder
        : null;
      if (!mergedTarget) return { ok: false, error: 'Order not found.' };

      const billedRaw =
        (providedMatches ? providedOrder?.billed_total ?? providedOrder?.billedTotal : undefined) ??
        mergedTarget.billed_total ??
        mergedTarget.billedTotal;
      const sageRaw =
        (providedMatches ? providedOrder?.sage_total_synced ?? providedOrder?.sageTotalSynced : undefined) ??
        mergedTarget.sage_total_synced ??
        mergedTarget.sageTotalSynced;
      const billedNum = billedRaw === undefined || billedRaw === null ? NaN : Number(billedRaw);
      const sageNum = sageRaw === undefined || sageRaw === null ? NaN : Number(sageRaw);
      if (!Number.isFinite(billedNum) || !Number.isFinite(sageNum)) {
        return { ok: false, error: 'Missing billed_total or sage_total_synced.' };
      }
      const delta = Number((billedNum - sageNum).toFixed(2));
      if (Math.abs(delta) < 0.001) {
        return { ok: false, error: 'Totals already match.' };
      }

      const res = await runSageReconcile(mergedTarget, delta);
      if (!res?.ok) {
        return { ok: false, error: res?.error || 'Reconcile failed', stderr: res?.stderr, stdout: res?.stdout };
      }
      if (!res?.applied?.applied) {
        return { ok: false, error: 'Reconcile did not complete in AHK.', stdout: res?.stdout, stderr: res?.stderr };
      }
      applyReconcileResult(key, billedNum, delta, mergedTarget, res.sageTotal, res.journalEntry);
      return { ok: true, delta, sageTotal: res.sageTotal, journalEntry: res.journalEntry };
    } catch (e) {
      console.error('[orders:reconcile-totals]', e);
      return { ok: false, error: e?.message || 'Failed to reconcile totals.' };
    }
  });
};

module.exports = { registerOrdersIpc };
