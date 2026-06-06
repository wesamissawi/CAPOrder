const registerOrdersIpc = (ipcMain, deps) => {
  const {
    readOrders,
    writeOrders,
    getOrdersFile,
    getSageIntegrationActive,
    setSageIntegrationActive,
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
    fetchBestBuyOrders,
    orderMatchesKey,
    runSageReconcile,
    applyReconcileResult,
    archiveCompletedOrders,
    archiveOrderByKey,
    readSageLock,
    writeSageLock,
    clearSageLock,
    getMachineId,
  } = deps;

  ipcMain.handle('sage:get-lock', () => {
    try {
      const lock = readSageLock?.() || null;
      return { ok: true, lock, ownMachineId: getMachineId?.() || null };
    } catch (e) {
      return { ok: false, lock: null, ownMachineId: null };
    }
  });

  ipcMain.handle('orders:read', () => readOrders());
  ipcMain.handle('orders:get-path', () => ({ path: getOrdersFile() }));
  ipcMain.handle('orders:watch', (_evt, enable = true) => {
    try {
      if (enable === false) {
        setSageIntegrationActive(false);
        resetSageQueue();
        stopOrdersWatching();
        clearSageLock?.();
        return { ok: true, watching: false };
      }

      // Check if another machine holds the lock and is actively running scripts
      const lock = readSageLock?.();
      const ownId = getMachineId?.();
      if (lock && lock.machineId && lock.machineId !== ownId && lock.running === true) {
        console.warn('[orders:watch] sage lock held by running machine', lock.machineId);
        return { ok: false, error: 'sage-locked', lockedBy: lock.machineId };
      }

      // Claim the lock (overwrites a stale/non-running lock from another machine)
      writeSageLock?.({ machineId: ownId, lockedAt: Date.now(), running: false });
      setSageIntegrationActive(true);
      startOrdersWatching(deps.getWin());
      scheduleSageProcessing();
      return { ok: true, watching: true, path: getOrdersFile() };
    } catch (e) {
      console.error('[orders:watch]', e);
      return { ok: false, error: e?.message || 'Failed to watch orders file.' };
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
    if (getSageIntegrationActive())
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

  ipcMain.handle('orders:archive-one', async (_evt, refKey) => {
    try {
      return archiveOrderByKey(refKey);
    } catch (e) {
      console.error('[orders:archive-one]', e);
      return { ok: false, error: e?.message || 'Failed to archive order.' };
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
