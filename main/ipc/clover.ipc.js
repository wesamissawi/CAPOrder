const registerCloverIpc = (ipcMain, deps) => {
  const {
    openCloverSession,
    scrapeCloverPayments,
    closeCloverSession,
    getCloverStatus,
    getCloverDebugDir,
    readPayments,
    writePayments,
    readCloverLedger,
    writeCloverLedger,
    getCloverLedgerFile,
  } = deps;

  // Opens a plain browser window at Clover and leaves it there. No credentials
  // are sent and no session is persisted — the user signs in themselves and the
  // window is the only place that login lives.
  ipcMain.handle('clover:open', async (_evt, payload) => {
    try {
      return await openCloverSession(payload || {});
    } catch (e) {
      return { ok: false, error: e?.message || 'Failed to open the Clover browser.' };
    }
  });

  // Reads the payment rows off whatever page the user navigated to and writes
  // them straight into payments.json — there is no review step by design.
  //
  // The scrape ledger (clover_scraped.json) is what makes that safe to repeat:
  // it records every Clover payment id we've ever seen, so a payment the user
  // has since edited or deleted is never re-imported. Declined rows are
  // ledgered too, marked as not imported, so they also stop coming back
  // without ever landing in payments.json.
  ipcMain.handle('clover:scrape-import', async () => {
    try {
      const ledger = readCloverLedger();
      const knownIds = ledger.map((e) => e && e.cloverId).filter(Boolean);

      const res = await scrapeCloverPayments({
        knownIds,
        debugDir: getCloverDebugDir && getCloverDebugDir(),
      });
      if (!res.ok) return res;

      const statusLog = Array.isArray(res.statusLog) ? [...res.statusLog] : [];
      const scrapedAt = res.scrapedAt || new Date().toISOString();
      const rows = Array.isArray(res.transactions) ? res.transactions : [];

      const newPayments = [];
      const newLedger = [];
      let declined = 0;

      rows.forEach((tx, i) => {
        // Money that never settled has no business in a payments ledger, but it
        // still gets recorded here so the next scrape doesn't re-offer it.
        if (tx.isDeclined) {
          declined += 1;
          newLedger.push({
            cloverId: String(tx.externalId),
            imported: false,
            reason: 'declined',
            amount: tx.amount,
            date: tx.date || '',
            scrapedAt,
          });
          return;
        }

        const noteBits = [];
        if (tx.time) noteBits.push(tx.time);
        if (tx.last4) noteBits.push(`••${tx.last4}`);
        if (tx.isRefund) noteBits.push('refund');
        if (!tx.type) noteBits.push('card type unread');

        const payment = {
          id: `pay_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 6)}`,
          amount: Number(Number(tx.amount).toFixed(2)),
          date: tx.date || '',
          // Time of the transaction, as Clover displays it. Kept as its own
          // field (as well as inside the note below, which is what it used to
          // be buried in) so the payment summary can show and sort by it
          // instead of parsing prose.
          time: tx.time || '',
          // An unresolved card type is left visible rather than guessed at, so
          // it can be corrected from the payment's Edit form.
          type: tx.type || 'Unknown',
          note: noteBits.length ? `Clover ${noteBits.join(' ')}` : 'Clover',
          createdAt: scrapedAt,
          source: 'clover',
          cloverId: String(tx.externalId),
        };
        newPayments.push(payment);
        newLedger.push({
          cloverId: payment.cloverId,
          imported: true,
          paymentId: payment.id,
          amount: payment.amount,
          date: payment.date,
          type: payment.type,
          scrapedAt,
        });
      });

      if (declined) statusLog.push(`${declined} declined/failed row(s) recorded but not imported.`);

      if (newPayments.length || newLedger.length) {
        // payments.json first: if that write fails the ledger stays untouched,
        // so the next scrape retries. The reverse order would lose the rows.
        if (newPayments.length) {
          writePayments([...newPayments, ...(readPayments() || [])]);
        }
        writeCloverLedger([...newLedger, ...ledger]);
      }

      statusLog.push(
        newPayments.length
          ? `Imported ${newPayments.length} payment(s) into payments.json.`
          : 'Nothing new to import.'
      );

      return {
        ok: true,
        imported: newPayments.length,
        payments: newPayments,
        declined,
        skippedKnown: res.skippedKnown || 0,
        skippedUnidentified: res.skippedUnidentified || 0,
        url: res.url || '',
        title: res.title || '',
        statusLog,
      };
    } catch (e) {
      return { ok: false, error: e?.message || 'Failed to scrape the Clover page.' };
    }
  });

  // Repair path for imports that landed with a bad card type (the detail-page
  // match once accepted "Cash", which is not a possible answer for a card
  // payment). Deleting those payments isn't enough on its own — their ids are
  // in the ledger, so they'd never be offered again. This drops both, which
  // puts them back in line for the next scrape.
  ipcMain.handle('clover:forget-mistyped', async () => {
    try {
      const KNOWN = ['Interac', 'VISA', 'MasterCard'];
      const payments = readPayments() || [];
      const doomed = payments.filter(
        (p) => p && p.source === 'clover' && p.cloverId && !KNOWN.includes(p.type)
      );
      if (!doomed.length) return { ok: true, removed: 0 };

      const doomedIds = new Set(doomed.map((p) => String(p.cloverId)));
      writePayments(payments.filter((p) => !(p && p.cloverId && doomedIds.has(String(p.cloverId)) && p.source === 'clover')));

      const ledger = readCloverLedger();
      writeCloverLedger(ledger.filter((e) => !(e && doomedIds.has(String(e.cloverId)))));

      return {
        ok: true,
        removed: doomed.length,
        types: [...new Set(doomed.map((p) => p.type || 'Unknown'))],
      };
    } catch (e) {
      return { ok: false, error: e?.message || 'Failed to clear mistyped Clover payments.' };
    }
  });

  // How many payments the ledger has seen — shown so it's obvious that a
  // "nothing new" result means already-scraped, not broken.
  ipcMain.handle('clover:ledger-summary', async () => {
    try {
      const ledger = readCloverLedger();
      return {
        ok: true,
        total: ledger.length,
        imported: ledger.filter((e) => e && e.imported).length,
        path: getCloverLedgerFile ? getCloverLedgerFile() : '',
      };
    } catch (e) {
      return { ok: false, error: e?.message || 'Failed to read the Clover scrape ledger.' };
    }
  });

  ipcMain.handle('clover:close', async () => {
    try {
      return await closeCloverSession();
    } catch (e) {
      return { ok: false, error: e?.message || 'Failed to close the Clover browser.' };
    }
  });

  ipcMain.handle('clover:status', async () => {
    try {
      return await getCloverStatus();
    } catch (e) {
      return { ok: false, open: false, error: e?.message || 'Failed to read Clover status.' };
    }
  });
};

module.exports = { registerCloverIpc };
