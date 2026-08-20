const { parseCloverCsv } = require('../../src/importers/cloverCsv');

const registerCloverIpc = (ipcMain, deps) => {
  const {
    dialog,
    fs,
    readPayments,
    writePayments,
    readCloverLedger,
    writeCloverLedger,
    getCloverLedgerFile,
  } = deps;

  // Imports a Clover "Payments" CSV export the user downloaded themselves. This
  // replaced a browser scrape: the export carries the same fields with none of
  // the ambiguity, so there is nothing to log into and no page to read.
  //
  // Rows go straight into payments.json — there is no review step by design.
  // The scrape ledger (clover_scraped.json) is what makes that safe to repeat:
  // it records every Clover payment id we've ever seen, so re-importing a CSV
  // whose date range overlaps an earlier one adds nothing twice, and a payment
  // the user has since edited or deleted is never resurrected. Rows that are
  // deliberately not imported (declined, cash, gift card) are ledgered too, so
  // they stop coming back without ever landing in payments.json.
  ipcMain.handle('clover:import-csv', async (_evt, payload) => {
    try {
      let filePath = payload && payload.filePath;

      if (!filePath) {
        const picked = await dialog.showOpenDialog({
          title: 'Choose the Clover payments export',
          properties: ['openFile'],
          filters: [
            { name: 'Clover payments export', extensions: ['csv'] },
            { name: 'All files', extensions: ['*'] },
          ],
        });
        if (picked.canceled || !picked.filePaths?.[0]) return { ok: false, canceled: true };
        filePath = picked.filePaths[0];
      }

      if (!fs.existsSync(filePath)) {
        return { ok: false, error: `That file is gone: ${filePath}` };
      }

      const parsed = parseCloverCsv(fs.readFileSync(filePath, 'utf8'));
      if (!parsed.ok) return { ok: false, error: parsed.error, file: filePath };

      const rows = parsed.rows || [];
      const statusLog = [`Read ${rows.length} row(s) from ${filePath}.`];
      if (parsed.skippedNoId?.length) {
        statusLog.push(
          `${parsed.skippedNoId.length} row(s) had no payment id or amount and were ignored (line ${parsed.skippedNoId
            .slice(0, 5)
            .join(', ')}${parsed.skippedNoId.length > 5 ? '…' : ''}).`
        );
      }

      const ledger = readCloverLedger();
      const known = new Set(ledger.map((e) => e && String(e.cloverId)).filter(Boolean));

      const importedAt = new Date().toISOString();
      const newPayments = [];
      const newLedger = [];
      // A CSV can list the same payment twice if the export is stitched from
      // overlapping ranges; the ledger only catches earlier imports, so
      // duplicates inside this one file are caught here.
      const seenThisFile = new Set();
      let skippedKnown = 0;
      let declined = 0;
      let nonCard = 0;

      rows.forEach((tx, i) => {
        const cloverId = String(tx.externalId);
        if (known.has(cloverId) || seenThisFile.has(cloverId)) {
          skippedKnown += 1;
          return;
        }
        seenThisFile.add(cloverId);

        // Money that never settled has no business in a payments ledger, and
        // neither does cash or a gift card — both are recorded here so a later
        // import doesn't re-offer them.
        const reason = tx.isDeclined ? 'declined' : tx.isNonCard ? 'non-card tender' : '';
        if (reason) {
          if (tx.isDeclined) declined += 1;
          else nonCard += 1;
          newLedger.push({
            cloverId,
            imported: false,
            reason,
            amount: tx.amount,
            date: tx.date || '',
            scrapedAt: importedAt,
          });
          return;
        }

        const noteBits = [];
        if (tx.time) noteBits.push(tx.time);
        if (tx.last4) noteBits.push(`••${tx.last4}`);
        if (tx.transactionNumber) noteBits.push(`#${tx.transactionNumber}`);
        // The gross amount is what the terminal took; a later refund is its own
        // movement, so it's flagged in the note instead of being netted off
        // behind the user's back.
        if (tx.refundCount) noteBits.push(`refunded $${tx.refundAmount.toFixed(2)}`);
        if (tx.type === 'Unknown') noteBits.push(`card type unread (${tx.brand || tx.tender})`);

        const payment = {
          id: `pay_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 6)}`,
          amount: Number(Number(tx.amount).toFixed(2)),
          date: tx.date || '',
          // Time of the transaction, as Clover recorded it. Its own field (as
          // well as inside the note) so the payment summary can show and sort
          // by it instead of parsing prose.
          time: tx.time || '',
          // An unresolved card type is left visible rather than guessed at, so
          // it can be corrected from the payment's Edit form.
          type: tx.type || 'Unknown',
          note: noteBits.length ? `Clover ${noteBits.join(' ')}` : 'Clover',
          createdAt: importedAt,
          source: 'clover',
          cloverId,
        };
        newPayments.push(payment);
        newLedger.push({
          cloverId,
          imported: true,
          paymentId: payment.id,
          amount: payment.amount,
          date: payment.date,
          type: payment.type,
          scrapedAt: importedAt,
        });
      });

      if (declined) statusLog.push(`${declined} declined/failed row(s) recorded but not imported.`);
      if (nonCard) statusLog.push(`${nonCard} cash/gift-card row(s) recorded but not imported.`);
      if (skippedKnown) statusLog.push(`${skippedKnown} row(s) were already imported before.`);

      if (newPayments.length || newLedger.length) {
        // payments.json first: if that write fails the ledger stays untouched,
        // so the next import retries. The reverse order would lose the rows.
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
        nonCard,
        skippedKnown,
        rowsRead: rows.length,
        file: filePath,
        statusLog,
      };
    } catch (e) {
      return { ok: false, error: e?.message || 'Failed to read that CSV file.' };
    }
  });

  // Repair path for imports that landed with a bad card type. Deleting those
  // payments isn't enough on its own — their ids are in the ledger, so they'd
  // never be offered again. This drops both, which puts them back in line for
  // the next import of a CSV that covers them.
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
  // "nothing new" result means already-imported, not broken.
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
      return { ok: false, error: e?.message || 'Failed to read the Clover import ledger.' };
    }
  });
};

module.exports = { registerCloverIpc };
