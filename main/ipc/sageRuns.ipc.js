// The Sage sales run log — one row per "Send to Sage Sales", written the
// moment the AHK finishes.
//
// This is the record that outlives the sale itself: the sale card gets archived
// and its bubble deleted, but the run row keeps what was actually needed for
// the books — the payment that settled it (amount, date, type) and the Sage
// invoice number the script read off the form. The Sage Runs report prints
// straight off this file.
//
// Append-only in spirit: rows are added by a run, and only ever touched again
// to correct the invoice number (the AHK's read can miss) or to delete a row
// that shouldn't have been logged. Nothing here mutates items or payments.
const registerSageRunsIpc = (ipcMain, deps) => {
  const { readSageSalesRuns, writeSageSalesRuns, getSageSalesRunsFile, randomUUID } = deps;

  const asList = (v) => (Array.isArray(v) ? v : []);

  ipcMain.handle('sage-runs:read', () => {
    try {
      return { ok: true, runs: asList(readSageSalesRuns()), path: getSageSalesRunsFile() };
    } catch (e) {
      console.error('[sage-runs:read]', e);
      return { ok: false, error: e?.message || 'Failed to read Sage runs.', runs: [] };
    }
  });

  ipcMain.handle('sage-runs:append', (_evt, run = {}) => {
    try {
      const entry = {
        id: randomUUID(),
        at: new Date().toISOString(),
        saleName: String(run?.saleName || ''),
        customerCode: String(run?.customerCode || ''),
        sageInvoiceNumber: String(run?.sageInvoiceNumber || ''),
        notes: String(run?.notes || ''),
        itemCount: Number(run?.itemCount) || 0,
        // A row created by ticking "In Sage" on a payment rather than by an AHK
        // run — the money was entered into Sage by hand, but it still belongs
        // on the payment summary.
        manual: run?.manual === true,
        // Snapshotted, not referenced: the payment can be purged from
        // payments.json later and the report still has to print.
        payments: asList(run?.payments).map((p) => ({
          id: String(p?.id || ''),
          amount: Number(p?.amount) || 0,
          date: String(p?.date || ''),
          time: String(p?.time || ''),
          // Carried so the report's time fallback still works for payments
          // imported before `time` was its own field (it lives in the note).
          note: String(p?.note || ''),
          type: String(p?.type || ''),
        })),
        paymentTotal: asList(run?.payments).reduce((sum, p) => sum + (Number(p?.amount) || 0), 0),
        saleTotal: Number(run?.saleTotal) || 0,
      };
      const runs = asList(readSageSalesRuns());
      runs.push(entry);
      writeSageSalesRuns(runs);
      return { ok: true, run: entry };
    } catch (e) {
      console.error('[sage-runs:append]', e);
      return { ok: false, error: e?.message || 'Failed to record the Sage run.' };
    }
  });

  // Correcting the invoice number after the fact. Scoped to that one field
  // rather than a general patch: everything else in a row describes what
  // actually happened at run time and shouldn't be rewritten.
  ipcMain.handle('sage-runs:set-invoice', (_evt, payload = {}) => {
    try {
      const id = String(payload?.id || '');
      if (!id) return { ok: false, error: 'Missing run id.' };
      const next = String(payload?.sageInvoiceNumber ?? '').trim();
      const runs = asList(readSageSalesRuns());
      let found = false;
      const updated = runs.map((r) => {
        if (r?.id !== id) return r;
        found = true;
        return { ...r, sageInvoiceNumber: next, invoiceEditedAt: new Date().toISOString() };
      });
      if (!found) return { ok: false, error: 'That Sage run no longer exists.' };
      writeSageSalesRuns(updated);
      return { ok: true };
    } catch (e) {
      console.error('[sage-runs:set-invoice]', e);
      return { ok: false, error: e?.message || 'Failed to update the invoice number.' };
    }
  });

  ipcMain.handle('sage-runs:delete', (_evt, id) => {
    try {
      const target = String(id || '');
      if (!target) return { ok: false, error: 'Missing run id.' };
      const runs = asList(readSageSalesRuns());
      const kept = runs.filter((r) => r?.id !== target);
      if (kept.length === runs.length) return { ok: false, error: 'That Sage run no longer exists.' };
      writeSageSalesRuns(kept);
      return { ok: true, removed: runs.length - kept.length };
    } catch (e) {
      console.error('[sage-runs:delete]', e);
      return { ok: false, error: e?.message || 'Failed to delete the Sage run.' };
    }
  });
};

module.exports = { registerSageRunsIpc };
