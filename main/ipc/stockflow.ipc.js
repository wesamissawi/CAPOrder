const registerStockFlowIpc = (ipcMain, deps) => {
  const {
    readSharedBubbleData,
    getSharedBubbleDataPath,
    writeSharedBubbleData,
    deleteSharedBubbleData,
    readArchivedEntries,
    writeArchivedEntries,
    getArchiveFile,
    fs,
    searchArchiveEntries,
    normalizeSharedBubblePayload,
  } = deps;

  ipcMain.handle('bubble-shared:read', () => {
    try {
      const data = readSharedBubbleData();
      const pathStr = getSharedBubbleDataPath();
      return { ok: true, data, path: pathStr, exists: fs.existsSync(pathStr) };
    } catch (e) {
      console.error('[bubble-shared:read]', e);
      return { ok: false, error: e?.message || 'Failed to read shared bubble data.' };
    }
  });
  ipcMain.handle('bubble-shared:write', (_evt, payload) => {
    try {
      const normalized = normalizeSharedBubblePayload(payload);
      return writeSharedBubbleData(normalized.bubbleId, normalized.data);
    } catch (e) {
      console.error('[bubble-shared:write]', e);
      return { ok: false, error: e?.message || 'Failed to write shared bubble data.' };
    }
  });
  ipcMain.handle('bubble-shared:delete', (_evt, bubbleId) => {
    try {
      return deleteSharedBubbleData(bubbleId);
    } catch (e) {
      console.error('[bubble-shared:delete]', e);
      return { ok: false, error: e?.message || 'Failed to delete shared bubble data.' };
    }
  });

  ipcMain.handle('archive:save-bubble', (_evt, payload) => {
    try {
      const { bubble, meta, items } = payload || {};
      if (!bubble || !bubble.id) return { ok: false, error: 'Missing bubble info' };
      const archivedAt = new Date().toISOString();
      const entry = {
        id: bubble.id,
        bubble: { ...bubble },
        meta: { ...(meta || {}), accountingPath: 'ARCHIVED', archivedAt },
        accountingPath: 'ARCHIVED',
        archivedAt,
        items: Array.isArray(items) ? items : [],
      };
      const existing = readArchivedEntries();
      existing.push(entry);
      writeArchivedEntries(existing);
      return { ok: true, archivedAt, path: getArchiveFile() };
    } catch (e) {
      console.error('[archive:save-bubble]', e);
      return { ok: false, error: e?.message || 'Failed to archive bubble' };
    }
  });

  ipcMain.handle('archive:search', (_evt, query) => {
    try {
      const entries = readArchivedEntries();
      const { results, empty } = searchArchiveEntries(entries, query || {});
      if (empty) return { ok: true, results: [], empty: true };
      return { ok: true, results };
    } catch (e) {
      console.error('[archive:search]', e);
      return { ok: false, error: e?.message || 'Failed to search archive' };
    }
  });

  ipcMain.handle('archive:get-path', () => ({ ok: true, path: getArchiveFile() }));
};

module.exports = { registerStockFlowIpc };
