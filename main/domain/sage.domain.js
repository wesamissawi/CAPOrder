function extractJournalLine(stdoutRaw) {
  const stdout = (stdoutRaw || "").toString();
  const lines = stdout
    .split(/\r?\n/)
    .map((ln) => (ln || "").trim())
    .filter(Boolean);
  if (!lines.length) return "";
  const lastLine = lines[lines.length - 1];
  return lastLine.replace(/^\[[^\]]*\]\s*/, "");
}

function extractSageTotal(stdoutRaw) {
  const stdout = (stdoutRaw || "").toString();
  const lines = stdout
    .split(/\r?\n/)
    .map((ln) => (ln || "").trim())
    .filter(Boolean);
  let total = null;
  for (const ln of lines) {
    const match = ln.match(/^SAGE_TOTAL\s*:?\s*\$?\s*([0-9]+(?:\.[0-9]+)?)/i);
    if (match) {
      const num = parseFloat(match[1]);
      if (Number.isFinite(num)) {
        total = num;
      }
    }
  }
  return total;
}

// A Sage transaction number: J4015, J-4015, 4015. Must contain a digit, so a
// stray word of AHK debug output can never be mistaken for one. Debug lines are
// "[tag] ..." and are excluded by the leading-character class.
const JOURNAL_TOKEN = /^[A-Za-z]{0,4}\d[A-Za-z0-9-]*$/;

// Did the AHK run actually POST to Sage?
//
// The scripts print the journal entry to stdout only after GetSageTxnNumber
// returns a real transaction number — i.e. only once Sage has committed the
// entry ("J4015    $12.46", or a bare "J4191" from update_invoice.ahk, or a
// "J4015 to J4017" range). That line is therefore proof the order is IN Sage,
// and it is far more trustworthy than the process exit code: the script can
// post successfully and then still exit non-zero, or get killed by our own
// timeout while a dialog lingers. Retrying on exit code alone is exactly how an
// order that WAS entered gets entered a second time.
function extractSagePosted(stdoutRaw) {
  const lines = (stdoutRaw || "")
    .toString()
    .split(/\r?\n/)
    .map((ln) => (ln || "").trim().replace(/^\[[^\]]*\]\s*/, ""))
    .filter(Boolean);

  for (const ln of lines) {
    const withTotal = ln.match(/^(.*?)\s+\$\s*([0-9]+(?:\.[0-9]+)?)$/);
    const head = (withTotal ? withTotal[1] : ln).trim();
    const total = withTotal ? parseFloat(withTotal[2]) : null;
    const parts = head.split(/\s+to\s+/i).map((p) => p.trim()).filter(Boolean);
    if (!parts.length || parts.length > 2) continue;
    if (!parts.every((p) => JOURNAL_TOKEN.test(p))) continue;
    return {
      posted: true,
      journalEntry: ln,
      sageTotal: Number.isFinite(total) ? total : null,
    };
  }
  return { posted: false, journalEntry: "", sageTotal: null };
}

function extractReconcileApplied(stdoutRaw) {
  const stdout = (stdoutRaw || "").toString();
  const lines = stdout
    .split(/\r?\n/)
    .map((ln) => (ln || "").trim())
    .filter(Boolean);
  for (const ln of lines) {
    const match = ln.match(/^DELTA_APPLIED\s*:\s*([0-9.-]+)/i);
    if (match) {
      const num = parseFloat(match[1]);
      return { applied: true, delta: Number.isFinite(num) ? num : null };
    }
  }
  return { applied: false, delta: null };
}

const createSageDomain = (deps) => {
  const { readOrders, writeOrders, orderMatchesKey } = deps;

  function applySageResult(refKey, res = {}, fallbackOrder = null, options = {}) {
    const orders = readOrders();
    const list = Array.isArray(orders) ? orders : [];

    const key = (refKey || "").toString().trim().toUpperCase();
    if (!key) return;

    // An explicitly parsed journal entry wins over the last-stdout-line
    // heuristic: when a run posts and THEN dies, the last line is whatever it
    // choked on, while res.journalEntry holds the line we positively identified
    // as a transaction number. Both are the same on a clean run.
    const journalEntry =
      (res.journalEntry || "").toString().trim() ||
      extractJournalLine(res.stdout || "") ||
      "";
    const runWarning = (options.runWarning || "").toString().trim();
    const sageTotal = res.sageTotal;
    const nowIso = new Date().toISOString();
    const syncedRef = (fallbackOrder?.sage_reference ||
      fallbackOrder?.reference ||
      fallbackOrder?.__row ||
      refKey ||
      "").toString();

    let changed = false;
    let found = false;
    const updated = list.map((o) => {
      if (!o) return o;
      if (!orderMatchesKey(o, key)) return o;

      changed = true;
      found = true;
      const billedNum = Number.isFinite(o?.billed_total) ? o.billed_total : Number.isFinite(o?.billedTotal) ? o.billedTotal : null;
      // Sage hands back a credit's total as a positive magnitude; store it with
      // our own sign so the value check below compares like with like instead of
      // seeing a ~2x discrepancy and flagging every credit. See alignSageTotalSign.
      const nextSageTotal = Number.isFinite(sageTotal)
        ? alignSageTotalSign(sageTotal, billedNum, o.isCredit === true)
        : o.sage_total_synced;
      const diff =
        Number.isFinite(billedNum) && Number.isFinite(nextSageTotal)
          ? Math.abs(billedNum - nextSageTotal)
          : null;
      const verified = diff !== null && diff < 0.001;
      const needsValueCheck = diff !== null && diff > 0.1;
      return {
        ...o,
        journalEntry: journalEntry || o.journalEntry || o.journal_entry || "",
        journal_entry: journalEntry || o.journal_entry || o.journalEntry || "",
        enteredInSage: true,
        invoiceSageUpdate: true,
        invoiceNeedsSync: false,
        // The Sage round trip is over — release the per-order lock so the card
        // un-blurs and edits are accepted again.
        sage_lock: null,
        sage_run_warning: runWarning || "",
        sage_reference_synced: o?.sage_reference || o?.reference || "",
        sage_total_synced: nextSageTotal,
        sage_trigger: false,
        sage_processed_at: nowIso,
        lastUpdatedAt: nowIso,
        totalVerified: verified ? true : o.totalVerified,
        valueCheckAlert: needsValueCheck ? true : verified ? false : o.valueCheckAlert,
      };
    });

    if (!found && fallbackOrder) {
      const fbBilled = Number.isFinite(fallbackOrder?.billed_total)
        ? fallbackOrder.billed_total
        : Number.isFinite(fallbackOrder?.billedTotal)
        ? fallbackOrder.billedTotal
        : null;
      // Same sign alignment as the matched branch above — a credit's total comes
      // back from Sage as a positive magnitude.
      const fbSageTotal = Number.isFinite(sageTotal)
        ? alignSageTotalSign(sageTotal, fbBilled, fallbackOrder.isCredit === true)
        : null;
      const fbDiff =
        Number.isFinite(fbBilled) && Number.isFinite(fbSageTotal)
          ? Math.abs(fbBilled - fbSageTotal)
          : null;
      const patch = {
        journalEntry: journalEntry || fallbackOrder.journalEntry || fallbackOrder.journal_entry || "",
        journal_entry: journalEntry || fallbackOrder.journal_entry || fallbackOrder.journalEntry || "",
        enteredInSage: true,
        invoiceSageUpdate: true,
        invoiceNeedsSync: false,
        sage_lock: null,
        sage_run_warning: runWarning || "",
        sage_reference_synced: syncedRef,
        sage_total_synced: fbSageTotal !== null ? fbSageTotal : fallbackOrder.sage_total_synced,
        sage_trigger: false,
        sage_processed_at: nowIso,
        lastUpdatedAt: nowIso,
        totalVerified: fbDiff !== null && fbDiff < 0.001 ? true : fallbackOrder.totalVerified,
        valueCheckAlert:
          fbDiff !== null && fbDiff > 0.1
            ? true
            : fbDiff !== null && fbDiff < 0.001
            ? false
            : fallbackOrder.valueCheckAlert,
      };
      const merged = { ...fallbackOrder, ...patch };
      updated.push(merged);
      changed = true;
    }

    if (changed) writeOrders(updated);
  }

  // Sage reports a credit's total as a POSITIVE magnitude: helpers.ahk's
  // GetSageTotal extracts it with /\$?\s*([0-9]+(?:\.[0-9]+)?)/, which has no
  // minus sign, so an on-screen -583.53 comes back as 583.53. Our billed_total
  // for a World credit is negative (that's what makes Sage receive a credit —
  // see toSageCreditLineItems), so the two are not comparable as-is.
  //
  // Re-apply our own sign to the reported magnitude. Everything downstream then
  // works unchanged: the reconcile delta comes out correctly signed (so the GST
  // adjustment SUBTRACTS the penny where an invoice would add it), and the
  // billed-vs-sage comparisons here and in isOrderCompleteForArchive compare
  // like with like — i.e. the absolute values must match.
  //
  // Keyed off the sign of billed_total, not merely isCredit, because the older
  // Transbec/BestBuy credit pipelines store billed_total as a POSITIVE amount;
  // those keep the positive magnitude and are unaffected.
  function alignSageTotalSign(sageNum, billedNum, isCredit) {
    if (!isCredit) return sageNum;
    if (!Number.isFinite(sageNum) || !Number.isFinite(billedNum)) return sageNum;
    return billedNum < 0 ? -Math.abs(sageNum) : Math.abs(sageNum);
  }

  function applyReconcileResult(refKey, billedTotal, delta, fallbackOrder = null, sageTotalOverride = null, journalStr = "") {
    const orders = readOrders();
    const list = Array.isArray(orders) ? orders : [];
    const key = (refKey || "").toString().trim().toUpperCase();
    if (!key) return;
    const nowIso = new Date().toISOString();
    const billedNum = Number.isFinite(billedTotal) ? billedTotal : null;
    let found = false;
    const matchesKey = (order, targetKey) => {
      if (!order || !targetKey) return false;
      const candidates = [
        order.sage_reference_synced,
        order.sage_reference,
        order.source_invoice,
        order.reference,
      ];
      return candidates.some((val) => {
        if (val === null || val === undefined) return false;
        return String(val).trim().toUpperCase() === targetKey;
      });
    };
    const updated = list.map((o) => {
      if (!o) return o;
      if (!matchesKey(o, key)) return o;
      found = true;
      const resolvedSageTotal = Number.isFinite(sageTotalOverride)
        ? alignSageTotalSign(sageTotalOverride, billedNum, o.isCredit === true)
        : billedNum !== null
        ? billedNum
        : o.sage_total_synced;
      const resolvedJournal = (journalStr || "").trim() || o.journalEntry || o.journal_entry || "";
      const diff =
        Number.isFinite(billedNum) && Number.isFinite(resolvedSageTotal)
          ? Math.abs(billedNum - resolvedSageTotal)
          : null;
      const verified = diff !== null && diff < 0.001;
      const needsValueCheck = diff !== null && diff > 0.1;
      return {
        ...o,
        billed_total: billedNum !== null ? billedNum : o.billed_total,
        billedTotal: billedNum !== null ? billedNum : o.billedTotal,
        sage_total_synced: resolvedSageTotal,
        sage_processed_at: nowIso,
        invoiceNeedsSync: false,
        sage_invoice_trigger: false,
        sage_lock: null,
        reconciliation_delta: delta,
        journalEntry: resolvedJournal,
        journal_entry: resolvedJournal,
        lastUpdatedAt: nowIso,
        totalVerified: verified ? true : o.totalVerified,
        valueCheckAlert: needsValueCheck ? true : verified ? false : o.valueCheckAlert,
      };
    });
    if (!found && fallbackOrder) {
      const resolvedSageTotal = Number.isFinite(sageTotalOverride)
        ? alignSageTotalSign(sageTotalOverride, billedNum, fallbackOrder.isCredit === true)
        : billedNum !== null
        ? billedNum
        : fallbackOrder.sage_total_synced;
      const resolvedJournal = (journalStr || "").trim() || fallbackOrder.journalEntry || fallbackOrder.journal_entry || "";
      const diff =
        Number.isFinite(billedNum) && Number.isFinite(resolvedSageTotal)
          ? Math.abs(billedNum - resolvedSageTotal)
          : null;
      const verified = diff !== null && diff < 0.001;
      const needsValueCheck = diff !== null && diff > 0.1;
      const merged = {
        ...fallbackOrder,
        billed_total: billedNum !== null ? billedNum : fallbackOrder.billed_total,
        billedTotal: billedNum !== null ? billedNum : fallbackOrder.billedTotal,
        sage_total_synced: resolvedSageTotal,
        sage_processed_at: nowIso,
        invoiceNeedsSync: false,
        sage_invoice_trigger: false,
        sage_lock: null,
        reconciliation_delta: delta,
        journalEntry: resolvedJournal,
        journal_entry: resolvedJournal,
        lastUpdatedAt: nowIso,
        totalVerified: verified ? true : fallbackOrder.totalVerified,
        valueCheckAlert: needsValueCheck ? true : verified ? false : fallbackOrder.valueCheckAlert,
      };
      updated.push(merged);
    }
    writeOrders(updated);
  }

  function applyInvoiceResult(refKey, res = {}, fallbackOrder = null) {
    const orders = readOrders();
    const list = Array.isArray(orders) ? orders : [];
    const key = (refKey || "").toString().trim().toUpperCase();
    if (!key) return;
    const journalOut = (res?.stdout || "").toString().trim();
    const nowIso = new Date().toISOString();
    let changed = false;
    const updated = list.map((o) => {
      if (!o) return o;
      const cand = (o.sage_reference || o.reference || o.__row || "").toString().trim().toUpperCase();
      if (!cand || cand !== key) return o;
      const existingJournal = o.journalEntry || o.journal_entry || "";
      const nextJournal = journalOut
        ? `${journalOut}${existingJournal ? " | " + existingJournal : ""}`
        : existingJournal;
      changed = true;
      return {
        ...o,
        invoiceNeedsSync: false,
        sage_invoice_trigger: false,
        sage_lock: null,
        invoiceSageUpdate: true,
        sage_reference_synced: o?.sage_reference || o?.source_invoice || o?.reference || "",
        sage_processed_at: nowIso,
        journalEntry: nextJournal,
        journal_entry: nextJournal,
        lastUpdatedAt: nowIso,
      };
    });
    if (changed) writeOrders(updated);
  }

  return {
    applySageResult,
    applyReconcileResult,
    applyInvoiceResult,
    alignSageTotalSign,
  };
};

module.exports = {
  extractJournalLine,
  extractSageTotal,
  extractSagePosted,
  extractReconcileApplied,
  createSageDomain,
};
