const registerItemsIpc = (ipcMain, deps) => {
  const {
    readItems,
    checkoutItems,
    writeItems,
    readHistory,
    getDataFile,
    dialog,
    fs,
    shell,
    readConfig,
    writeConfig,
    startWatching,
    getWin,
    setDataFileOverride,
    runSageSalesInvoice,
  } = deps;

  // items:read intentionally lets read failures reject the invoke — the
  // renderer must treat that as "unknown state", never as an empty list.
  //
  // checkoutItems, not readItems: this snapshots what the UI is being shown so
  // that when it saves the whole array back — possibly minutes later — the
  // store can tell which fields the USER changed from the ones other machines
  // changed underneath. See main/crdt/store.js.
  ipcMain.handle('items:read', () => checkoutItems());
  // Upsert-by-uid save. Items absent from `items` are preserved on disk;
  // deletions happen only for the uids the renderer explicitly lists in
  // `deletedUids`. This stops a stale/partial renderer state from erasing
  // items it never saw.
  ipcMain.handle('items:write', (_evt, items, deletedUids, options) => {
    try {
      const deletions = Array.isArray(deletedUids) ? deletedUids.filter(Boolean) : [];
      const allowedReasons = ['archived', 'credit_received'];
      const deleteReason = allowedReasons.includes(options?.deleteReason) ? options.deleteReason : 'deleted';
      // Allowlisted so the renderer can't write arbitrary event names into the
      // lifecycle log — the timeline's labels are a fixed vocabulary.
      const allowedEvents = ['sent_to_sage'];
      const historyEvent = allowedEvents.includes(options?.historyEvent?.event)
        ? { event: options.historyEvent.event, extra: options.historyEvent.extra || {} }
        : null;
      // No pre-flight comparison against a fresh read any more: it was there to
      // avoid pointless whole-file rewrites, and it would now do harm — reading
      // here would move the diff baseline off what the renderer was shown. The
      // store already emits nothing when nothing changed.
      const res = writeItems(items, {
        deletedUids: deletions,
        deleteReason,
        historyEvent,
        fromClient: true,
      });
      return { ok: true, ops: res?.ops ?? 0 };
    } catch (e) {
      console.error('[items:write] aborted', e?.message || e);
      return { ok: false, error: e?.message || 'Failed to save items.' };
    }
  });
  ipcMain.handle('items:export', async (_evt, items) => {
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: 'Export updated items',
      defaultPath: 'outstanding_items.updated.json',
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (canceled || !filePath) return { ok: false, canceled: true };
    fs.writeFileSync(filePath, JSON.stringify(items ?? [], null, 2), 'utf-8');
    return { ok: true, filePath };
  });
  // Read the append-only item lifecycle log (deletions). Never throws to the
  // renderer — a missing/unreadable log just reads as an empty history.
  ipcMain.handle('items:read-history', () => {
    try {
      return { ok: true, history: typeof readHistory === 'function' ? readHistory() : [] };
    } catch (e) {
      console.error('[items:read-history] failed', e?.message || e);
      return { ok: false, error: e?.message || 'Failed to read history.', history: [] };
    }
  });
  ipcMain.handle('items:get-path', () => ({ path: getDataFile() }));
  ipcMain.handle('items:reveal', () => { const f = getDataFile(); if (fs.existsSync(f)) shell.showItemInFolder(f); return { ok: true }; });
  ipcMain.handle('items:choose-file', async () => {
    const res = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (res.canceled || !res.filePaths?.[0]) return { ok: false, canceled: true };
    setDataFileOverride(res.filePaths[0]);
    const cfg = readConfig(); cfg.dataFile = res.filePaths[0]; writeConfig(cfg);
    startWatching(getWin());
    const win = getWin();
    if (win && !win.isDestroyed()) {
      try { win.webContents.send('items:updated', readItems()); }
      catch (e) { console.error('[items:choose-file] read failed, not pushing', e?.message || e); }
    }
    return { ok: true, path: res.filePaths[0] };
  });
  ipcMain.handle('items:use-default', () => {
    setDataFileOverride(null);
    const cfg = readConfig(); delete cfg.dataFile; writeConfig(cfg);
    startWatching(getWin());
    const win = getWin();
    if (win && !win.isDestroyed()) {
      try { win.webContents.send('items:updated', readItems()); }
      catch (e) { console.error('[items:use-default] read failed, not pushing', e?.message || e); }
    }
    return { ok: true, path: getDataFile() };
  });

  // items:lock-item / items:apply-edit / items:release-lock lived here.
  //
  // A 20-second exclusive lock on one item, taken before an edit and dropped
  // after, with an expiry sweep so a machine that died mid-edit didn't leave a
  // part unopenable forever. It made one edit at a time possible on a shared
  // file where a save rewrote the whole thing.
  //
  // Two machines editing the same part is no longer a race to be prevented:
  // different fields both survive, and the same field resolves the same way on
  // every machine and is reported in Conflict Review. Locking would now cost
  // availability — a part stuck behind a dead machine's lock — to prevent
  // something that can't happen.
  //
  // `clearFields` on the store stays. It is how the CRDT expresses "this field
  // is gone" (a clear has to replicate, or other machines keep a value this one
  // dropped), not lock machinery — these handlers were just its only caller.

  ipcMain.handle('items:sage-sales-invoice', async (_evt, bubbleName, customerCode, notes, paymentType, options) => {
    if (typeof runSageSalesInvoice !== 'function') {
      return { ok: false, code: 'not-configured', error: 'Sage sales invoice action not available.' };
    }
    let all;
    try {
      all = readItems();
    } catch (e) {
      return { ok: false, code: 'read-failed', error: e?.message || 'Failed to read items.' };
    }
    const items = (all || []).filter((i) => i.allocated_to === bubbleName);
    if (!items.length) {
      return { ok: false, code: 'no-items', error: `No items found in bubble "${bubbleName}".` };
    }
    return runSageSalesInvoice(items, customerCode || '', notes || '', paymentType || '', {
      // Default ON, so an older caller that sends nothing keeps the existing
      // behaviour rather than silently dropping the line.
      includeGrandTotal: options?.includeGrandTotal !== false,
    });
  });

};

module.exports = { registerItemsIpc };
