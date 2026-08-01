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
    locatePart,
    readItems,
    readHistory,
    readOrders,
    readOrdersArchive,
    readOrderAssignments,
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

  // "Find this part anywhere" — sweeps every store at once: the live queues,
  // the sales archive, the purchase orders (active and archived) and the
  // lifecycle log. Search Purchases and Search Sales each only see their own
  // corner, so a part that's alive in CashPad reads as "not found" in both.
  //
  // Every source is read defensively: one unreadable or malformed file must
  // degrade that section only, not fail the whole lookup, and the sources it
  // couldn't read come back so the UI can say so rather than quietly implying
  // the part isn't there.
  ipcMain.handle('items:locate', (_evt, term) => {
    try {
      const failed = [];
      const safely = (label, fn) => {
        try {
          return fn() || [];
        } catch (e) {
          console.error(`[items:locate] ${label} read failed`, e);
          failed.push(label);
          return [];
        }
      };
      const result = locatePart(term, {
        items: safely('live items', readItems),
        archivedEntries: safely('sales archive', readArchivedEntries),
        orders: safely('purchase orders', readOrders),
        ordersArchive: safely('archived purchases', readOrdersArchive),
        history: safely('item history', readHistory),
        assignments: safely('order assignments', readOrderAssignments),
      });
      return { ok: true, ...result, unreadable: failed };
    } catch (e) {
      console.error('[items:locate]', e);
      return { ok: false, error: e?.message || 'Failed to locate part.' };
    }
  });

  // Which payments are already spoken for by an ARCHIVED cash sale.
  //
  // Archiving a sale clears its live payment assignment and deletes the bubble,
  // so the live state only ever knows about sales still open. Without this,
  // every payment older than what's currently on screen would read as free on
  // the Payments view — the exact opposite of the truth, and the reading that
  // gets a payment double-assigned.
  ipcMain.handle('archive:payment-usage', () => {
    try {
      const usage = {};
      (readArchivedEntries() || []).forEach((entry) => {
        const ids = entry?.meta?.paymentIds;
        if (!Array.isArray(ids)) return;
        ids.filter(Boolean).forEach((id) => {
          // A payment settles one sale, so the first archive claiming it wins;
          // a duplicate would be a data problem, not something to merge here.
          if (usage[id]) return;
          usage[id] = {
            bubbleName: entry?.bubble?.name || entry?.id || '',
            archivedAt: entry?.archivedAt || '',
          };
        });
      });
      return { ok: true, usage };
    } catch (e) {
      console.error('[archive:payment-usage]', e);
      return { ok: false, error: e?.message || 'Failed to read archived payment usage.', usage: {} };
    }
  });

  ipcMain.handle('archive:get-path', () => ({ ok: true, path: getArchiveFile() }));
};

module.exports = { registerStockFlowIpc };
