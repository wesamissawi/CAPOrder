const registerItemsIpc = (ipcMain, deps) => {
  const {
    readItems,
    writeItems,
    getDataFile,
    dialog,
    fs,
    shell,
    readConfig,
    writeConfig,
    startWatching,
    getWin,
    setDataFileOverride,
    LOCK_DURATION_MS,
    cleanExpiredLocks,
    runSageSalesInvoice,
  } = deps;

  // items:read intentionally lets read failures reject the invoke — the
  // renderer must treat that as "unknown state", never as an empty list.
  ipcMain.handle('items:read', () => readItems());
  // Upsert-by-uid save. Items absent from `items` are preserved on disk;
  // deletions happen only for the uids the renderer explicitly lists in
  // `deletedUids`. This stops a stale/partial renderer state from erasing
  // items it never saw.
  ipcMain.handle('items:write', (_evt, items, deletedUids) => {
    try {
      const deletions = Array.isArray(deletedUids) ? deletedUids.filter(Boolean) : [];
      const current = readItems();              // throws if any queue file is unreadable
      const a = JSON.stringify(current);
      const b = JSON.stringify(items ?? []);
      if (a !== b || deletions.length > 0) {
        writeItems(items, { replaceAll: false, deletedUids: deletions });
      }
      return { ok: true };
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

  // Acquire a 20s lock on a specific item
  ipcMain.handle('items:lock-item', (_evt, uid) => {
    try {
    let items = readItems();
    const { items: cleaned, changed } = cleanExpiredLocks(items);
    if (changed) {
      items = cleaned;
      writeItems(items);
    }

    const idx = items.findIndex((it) => it.uid === uid);
    if (idx === -1) {
      return { ok: false, reason: 'not-found' };
    }

    const it = items[idx];
    const now = Date.now();

    if (it.lock_expires_at && it.lock_expires_at > now) {
      // Someone else holds a valid lock
      return { ok: false, reason: 'locked' };
    }

    const lock_expires_at = now + LOCK_DURATION_MS;
    items[idx] = { ...it, lock_expires_at };
    writeItems(items);

    return { ok: true, item: items[idx], lock_expires_at };
    } catch (e) {
      console.error('[items:lock-item] aborted', e?.message || e);
      return { ok: false, reason: 'read-failed', error: e?.message };
    }
  });

  // Apply an edit to a locked item and remove the lock
  ipcMain.handle('items:apply-edit', (_evt, uid, patch) => {
    try {
    let items = readItems();
    const { items: cleaned, changed } = cleanExpiredLocks(items);
    if (changed) {
      items = cleaned;
      writeItems(items);
    }

    const idx = items.findIndex((it) => it.uid === uid);
    if (idx === -1) {
      return { ok: false, reason: 'not-found' };
    }

    const it = items[idx];
    const now = Date.now();

    if (!it.lock_expires_at || it.lock_expires_at < now) {
      // Lock expired or never existed
      return { ok: false, reason: 'lock-expired' };
    }

    // Don't keep the lock field in the final saved item
    const { lock_expires_at, ...rest } = it;
    const updated = { ...rest, ...(patch || {}) };
    items[idx] = updated;

    writeItems(items);
    return { ok: true, item: updated };
    } catch (e) {
      console.error('[items:apply-edit] aborted', e?.message || e);
      return { ok: false, reason: 'read-failed', error: e?.message };
    }
  });

  ipcMain.handle('items:sage-sales-invoice', async (_evt, bubbleName, customerCode, notes, paymentType) => {
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
    return runSageSalesInvoice(items, customerCode || '', notes || '', paymentType || '');
  });

  // Optional: manual lock release (e.g., user cancels)
  ipcMain.handle('items:release-lock', (_evt, uid) => {
    try {
      let items = readItems();
      const idx = items.findIndex((it) => it.uid === uid);
      if (idx === -1) return { ok: false, reason: 'not-found' };

      const it = items[idx];
      if (!it.lock_expires_at) {
        return { ok: true, released: false }; // nothing to do
      }

      const { lock_expires_at, ...rest } = it;
      items[idx] = rest;
      writeItems(items);
      return { ok: true, released: true };
    } catch (e) {
      console.error('[items:release-lock] aborted', e?.message || e);
      return { ok: false, reason: 'read-failed', error: e?.message };
    }
  });
};

module.exports = { registerItemsIpc };
