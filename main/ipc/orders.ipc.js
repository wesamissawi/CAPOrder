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
    alignSageTotalSign,
    archiveCompletedOrders,
    archiveOrderByKey,
    deleteOrderByKey,
    searchOrdersArchive,
    purgeOldOrdersArchive,
    readOrdersArchive,
    writeOrdersArchive,
    readSageLock,
    clearSageLock,
    sageLockIsLive,
    tryAcquireSagePoLock,
    startSageHeartbeat,
    stopSageHeartbeat,
    getMachineId,
    mergeOrdersForWrite,
    getArchivedOrderKeys,
    sageOrderLockIsLive,
    isOrderSageLocked,
    setSageOrderLock,
    clearSageOrderLock,
    patchOrderOnDisk,
  } = deps;

  // orders.json is watched unconditionally, on every machine. It used to be
  // watched only while a Sage flow was active locally, which meant the machine
  // that merely *triggers* Sage never saw the results the processing machine
  // wrote — it kept an ever-staler copy of the array, un-blurred a locked card,
  // and offered "Send to Sage" again on an order that was already in Sage.
  function refreshOrdersWatch() {
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

  // For the Sales Order view's per-item "Arrived" badge: a stock item only
  // carries its ORIGINATING purchase order's reference, not whether that
  // purchase has physically shown up — that's the order's own `inStore` flag.
  // Scans both active and archived orders once and returns a lookup keyed by
  // every reference an item might carry (order_key, reference, __row), so the
  // renderer can check `map[item.order_key] ?? map[item.reference_num]`
  // without re-deriving order-matching logic on the client.
  ipcMain.handle('orders:get-arrival-map', () => {
    try {
      const map = {};
      const record = (o) => {
        if (!o) return;
        const inStore = o.inStore === true;
        [o.sage_reference, o.reference, o.__row]
          .map((v) => String(v ?? '').trim().toUpperCase())
          .filter(Boolean)
          .forEach((key) => {
            // Prefer a true — an order with multiple candidate keys colliding
            // across different rows should read "arrived" if ANY of them are.
            map[key] = map[key] === true ? true : inStore;
          });
      };
      (readOrders() || []).forEach(record);
      (readOrdersArchive() || []).forEach(record);
      return { ok: true, map };
    } catch (e) {
      console.error('[orders:get-arrival-map]', e);
      return { ok: false, error: e?.message || 'Failed to build arrival map.', map: {} };
    }
  });

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
      // A stale lock (owner crashed/closed) is fair game to take over. The
      // read + liveness-check + write all happen atomically inside
      // tryAcquireSagePoLock (guarded by an exclusive-create gate file), so two
      // machines racing this call can never both believe they won.
      // A missing helper must NOT be reported as a foreign lock: an optional
      // call returning undefined reads as "somebody else has it" and then every
      // machine refuses to turn POs on while naming no owner — which is exactly
      // what happened when this dep was left out of ipc.registry.js. Fail loudly
      // instead, so the real cause shows up on the card.
      if (typeof tryAcquireSagePoLock !== 'function') {
        console.error('[sage] tryAcquireSagePoLock was not wired into the orders IPC deps');
        return { ok: false, error: 'Sage lock helper is unavailable in this build.' };
      }
      const claim = tryAcquireSagePoLock();
      if (!claim?.ok) {
        console.warn('[sage] PO lock held by live machine', claim?.lockedBy);
        return { ok: false, error: 'sage-locked', lockedBy: claim?.lockedBy, running: claim?.running === true };
      }

      startSageHeartbeat?.();
      setSagePoActive(true);
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
      scheduleSageProcessing();
      return { ok: true, active: true, path: getOrdersFile() };
    } catch (e) {
      console.error('[sage:set-invoice-active]', e);
      return { ok: false, error: e?.message || 'Failed to enable Sage invoices.' };
    }
  });
  // A renderer save is a FULL array built from whatever that window last read,
  // which over a shared file is routinely minutes old. Never take it verbatim:
  // reconcile it against disk first (see mergeOrdersForWrite) so orders locked
  // by a Sage run are untouchable and the Sage-owned fields always come from
  // disk. `blocked` lets the caller know which orders it was not allowed to
  // change, so the UI can refresh them instead of silently keeping its version.
  ipcMain.handle('orders:write', (_evt, orders) => {
    const current = readOrders();                  // existing array
    const { orders: merged, blocked, restored, resurrected } = mergeOrdersForWrite(
      current,
      orders ?? [],
      { archivedKeys: getArchivedOrderKeys?.() }
    );
    if (resurrected?.length) {
      console.warn('[orders:write] refused to re-add already-archived order(s):', resurrected.join(', '));
    }
    if (blocked.length) {
      console.warn('[orders:write] ignored stale copy of Sage-locked order(s):', blocked.join(', '));
    }
    if (restored) {
      console.warn('[orders:write] kept', restored, 'order(s) missing from the incoming save');
    }
    const a = JSON.stringify(current);
    const b = JSON.stringify(merged);
    if (a !== b) writeOrders(merged);              // only write if actually different
    try {
      syncOutstandingInvoices(merged);
    } catch (e) {
      console.error('[orders:write] sync outstanding failed', e);
    }
    if (getSagePoActive?.() || getSageInvoiceActive?.())
      scheduleSageProcessing();
    return { ok: true, blocked, orders: merged };
  });

  // Claim an order for Sage. Done here rather than as a field in the renderer's
  // bulk save so the trigger cannot arrive carrying a stale snapshot of every
  // other order — that is precisely how an already-entered order used to get
  // its sage_trigger resurrected and be entered into Sage twice.
  ipcMain.handle('sage:trigger-order', (_evt, refKey, kind = 'purchase') => {
    try {
      const key = (refKey || '').toString().trim().toUpperCase();
      if (!key) return { ok: false, error: 'Missing order reference.' };
      const list = readOrders() || [];
      const target = list.find((o) => orderMatchesKey(o, key));
      if (!target) return { ok: false, error: 'Order not found on disk. Reload orders and try again.' };
      if (isOrderSageLocked?.(target)) {
        return { ok: false, error: 'This order is already being sent to Sage.', order: target };
      }
      if (kind === 'purchase' && target.enteredInSage === true) {
        // Someone else already finished it; refuse rather than double-enter.
        return { ok: false, error: 'This order is already entered in Sage.', order: target };
      }
      // A purchase order goes into the WAITING ROOM (`sage_queued`), which the
      // processor does not look at — only `sage_trigger` means "run this", and
      // that is set later by sage:send-queue. Two fields rather than one gated
      // processor because the queue has to be visible to every machine: it is
      // ordinary replicated order data, so any machine can add to it and any
      // machine can release it, while the machine holding the PO heartbeat
      // lock does the actual typing.
      //
      // No sage_lock either: the lock blurs the card behind a spinner and
      // refuses every edit, which is right for an order being entered right now
      // and wrong for one that may sit in the queue for an hour. The processor
      // stamps the real 'running' lock when it picks the order up.
      //
      // Invoice updates ("Invoice differs from last Sage update / Update
      // Invoice") work exactly the same way, in their own waiting room:
      // sage_invoice_queued rather than sage_queued, because an invoice update
      // only ever applies to an order that IS already entered in Sage and the
      // purchase queue filters those out everywhere. They used to fire
      // immediately, which typed them into Sage on whichever machine happened to
      // press the button; now they ride the same release + PO-lock machine.
      const updated = patchOrderOnDisk(
        key,
        kind === 'invoice'
          ? { sage_invoice_queued: true, sage_lock: null }
          : { sage_queued: true, sage_lock: null }
      );
      if (!updated) return { ok: false, error: 'Failed to queue the order.' };
      return { ok: true, order: updated };
    } catch (e) {
      console.error('[sage:trigger-order]', e);
      return { ok: false, error: e?.message || 'Failed to send the order to Sage.' };
    }
  });

  // "Send to Sage": release the whole waiting room by promoting sage_queued to
  // sage_trigger. Callable from ANY machine — the trigger is replicated order
  // data, so whichever machine holds the PO lock sees it arrive and starts
  // typing. scheduleSageProcessing() below only matters when this machine
  // happens to be that machine; everywhere else the CRDT push does the work.
  ipcMain.handle('sage:send-queue', () => {
    try {
      const list = readOrders() || [];
      // Two waiting rooms, one release. An invoice update is judged on
      // sage_invoice_queued alone — unlike a purchase it is EXPECTED to be
      // entered in Sage already, so the enteredInSage filter must not touch it.
      const targets = list.filter((o) => {
        if (!o || isOrderSageLocked?.(o)) return false;
        if (o.sage_invoice_queued === true) return true;
        return o.sage_queued === true && o.enteredInSage !== true;
      });
      if (!targets.length) return { ok: true, sent: 0 };
      let sent = 0;
      targets.forEach((order) => {
        // Same key normalizeOrderRef builds, and the one orderMatchesKey (via
        // patchOrderOnDisk) resolves against.
        const key = String(order?.sage_reference || order?.reference || order?.__row || '')
          .trim()
          .toUpperCase();
        if (!key) return;
        const patch =
          order.sage_invoice_queued === true
            ? { sage_invoice_trigger: true, sage_invoice_queued: false }
            : { sage_trigger: true, sage_queued: false };
        if (patchOrderOnDisk(key, patch)) sent += 1;
      });
      scheduleSageProcessing();
      return { ok: true, sent };
    } catch (e) {
      console.error('[sage:send-queue]', e);
      return { ok: false, error: e?.message || 'Failed to send the Sage queue.' };
    }
  });

  // Manual escape hatch: the Sage machine died mid-run, or the user changed
  // their mind before it was picked up. Drops the lock AND the pending trigger
  // so the order does not quietly get entered later.
  ipcMain.handle('sage:release-order-lock', (_evt, refKey) => {
    try {
      const key = (refKey || '').toString().trim().toUpperCase();
      if (!key) return { ok: false, error: 'Missing order reference.' };
      const updated = clearSageOrderLock(key, {
        sage_trigger: false,
        sage_queued: false,
        sage_invoice_queued: false,
        sage_invoice_trigger: false,
      });
      if (!updated) return { ok: false, error: 'Order not found.' };
      return { ok: true, order: updated };
    } catch (e) {
      console.error('[sage:release-order-lock]', e);
      return { ok: false, error: e?.message || 'Failed to release the order.' };
    }
  });
  ipcMain.handle('orders:add-to-outstanding', () => {
    try {
      const orders = readOrders();
      const items = readItems();
      const newItems = [];
      let lineUpdates = 0;

      const updatedOrders = orders.map((order) => {
        if (!order || !Array.isArray(order.lineItems)) return order;
        const updatedLineItems = order.lineItems.map((line, idx) => {
          if (!line || line.addedToOutstanding === true) return line;
          const outItem = makeOutstandingFromLine(order, line, idx);
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

  ipcMain.handle('orders-archive:add-to-cash-sales', (_evt, order, line, target) => {
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
      // Where the part lands. Defaults to CashPad (the original behaviour) so
      // older callers keep working; the archive search now passes RETURNS too.
      const allocated_to = (target?.allocated_to || 'CASHPAD').toString().toUpperCase();
      const accountingPath = target?.accountingPath || (allocated_to === 'CASHPAD' ? 'CASH_SALE' : 'OUTSTANDING');
      const newItem = {
        ...makeOutstandingFromLine(syntheticOrder, line),
        allocated_to,
        accountingPath,
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
      const rawSageNum = sageRaw === undefined || sageRaw === null ? NaN : Number(sageRaw);
      if (!Number.isFinite(billedNum) || !Number.isFinite(rawSageNum)) {
        return { ok: false, error: 'Missing billed_total or sage_total_synced.' };
      }
      // Sage reports a credit's total as a positive magnitude, while our
      // billed_total for a World credit is negative — compare like with like, so
      // the match test is really "do the absolute values agree" and the delta
      // handed to the GST adjustment carries the right sign (subtracting the
      // penny on a credit where an invoice would add it). See alignSageTotalSign.
      const sageNum = alignSageTotalSign(rawSageNum, billedNum, mergedTarget.isCredit === true);
      const delta = Number((billedNum - sageNum).toFixed(2));
      if (Math.abs(delta) < 0.001) {
        return { ok: false, error: 'Totals already match.' };
      }

      if (isOrderSageLocked?.(target)) {
        return { ok: false, error: 'This order is busy with Sage right now.' };
      }
      // Proforce credits post to Sage as a "Credit Note" document (positive
      // billed_total, positive on-screen total — see alignSageTotalSign),
      // where raising the tax field LOWERS the total instead of raising it,
      // the opposite of a regular invoice. Confirmed against a live reconcile
      // on order 652522: intended +$0.01 (78.19 -> 78.20) actually landed at
      // 78.18. Flip the sign of only what we hand the AHK tax adjustment so
      // the on-screen total moves the direction we mean; `delta` itself stays
      // correctly signed for applyReconcileResult's bookkeeping/the caller.
      const isProforceCredit = mergedTarget.source === 'proforce' && mergedTarget.isCredit === true;
      const ahkDelta = isProforceCredit ? -delta : delta;
      // Reconciling drives Sage for this order just like a purchase run does —
      // hold the same lock so no machine can save over it mid-adjustment.
      setSageOrderLock?.(key, 'reconcile');
      let res;
      try {
        res = await runSageReconcile(mergedTarget, ahkDelta);
      } finally {
        // applyReconcileResult clears the lock on the applied path; anything
        // else has to release it here or the card stays blurred.
        if (!res?.applied?.applied) clearSageOrderLock?.(key);
      }
      // DELTA_APPLIED on stdout means Sage took the adjustment. Like the purchase
      // queue, trust that over the exit code — recording it is what keeps our
      // totals matching Sage's.
      if (!res?.applied?.applied) {
        if (!res?.ok) {
          return { ok: false, error: res?.error || 'Reconcile failed', stderr: res?.stderr, stdout: res?.stdout };
        }
        return { ok: false, error: 'Reconcile did not complete in AHK.', stdout: res?.stdout, stderr: res?.stderr };
      }
      if (!res?.ok) {
        console.warn('[sage-reconcile] AHK exited non-zero AFTER applying the delta', key, res?.code);
      }
      applyReconcileResult(key, billedNum, delta, mergedTarget, res.sageTotal, res.journalEntry);
      return { ok: true, delta, sageTotal: res.sageTotal, journalEntry: res.journalEntry, dirtyExit: !res.ok };
    } catch (e) {
      console.error('[orders:reconcile-totals]', e);
      return { ok: false, error: e?.message || 'Failed to reconcile totals.' };
    }
  });
};

module.exports = { registerOrdersIpc };
