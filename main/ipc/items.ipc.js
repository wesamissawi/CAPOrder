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
  } = deps;

  ipcMain.handle('items:read', () => readItems());
  // ipcMain.handle('items:write', (_evt, items) => { writeItems(items); return { ok: true }; });
  ipcMain.handle('items:write', (_evt, items) => {
    const current = readItems();                // existing array
    const a = JSON.stringify(current);
    const b = JSON.stringify(items ?? []);
    if (a !== b) writeItems(items);             // only write if actually different
    return { ok: true };
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
    if (win && !win.isDestroyed()) win.webContents.send('items:updated', readItems());
    return { ok: true, path: res.filePaths[0] };
  });
  ipcMain.handle('items:use-default', () => {
    setDataFileOverride(null);
    const cfg = readConfig(); delete cfg.dataFile; writeConfig(cfg);
    startWatching(getWin());
    const win = getWin();
    if (win && !win.isDestroyed()) win.webContents.send('items:updated', readItems());
    return { ok: true, path: getDataFile() };
  });

  // Acquire a 20s lock on a specific item
  ipcMain.handle('items:lock-item', (_evt, uid) => {
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
  });

  // Apply an edit to a locked item and remove the lock
  ipcMain.handle('items:apply-edit', (_evt, uid, patch) => {
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
  });

  // Optional: manual lock release (e.g., user cancels)
  ipcMain.handle('items:release-lock', (_evt, uid) => {
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
  });
};

module.exports = { registerItemsIpc };
