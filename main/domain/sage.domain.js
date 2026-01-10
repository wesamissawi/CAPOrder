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

  function applySageResult(refKey, res = {}, fallbackOrder = null) {
    const orders = readOrders();
    const list = Array.isArray(orders) ? orders : [];

    const key = (refKey || "").toString().trim().toUpperCase();
    if (!key) return;

    const journalEntry =
      extractJournalLine(res.stdout || "") ||
      (res.journalEntry || "").toString().trim() ||
      "";
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
      const nextSageTotal = Number.isFinite(sageTotal) ? sageTotal : o.sage_total_synced;
      const billedNum = Number.isFinite(o?.billed_total) ? o.billed_total : Number.isFinite(o?.billedTotal) ? o.billedTotal : null;
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
        sage_reference_synced: o?.sage_reference || o?.reference || "",
        sage_total_synced: nextSageTotal,
        sage_trigger: false,
        sage_processed_at: nowIso,
        totalVerified: verified ? true : o.totalVerified,
        valueCheckAlert: needsValueCheck ? true : verified ? false : o.valueCheckAlert,
      };
    });

    if (!found && fallbackOrder) {
      const patch = {
        journalEntry: journalEntry || fallbackOrder.journalEntry || fallbackOrder.journal_entry || "",
        journal_entry: journalEntry || fallbackOrder.journal_entry || fallbackOrder.journalEntry || "",
        enteredInSage: true,
        invoiceSageUpdate: true,
        invoiceNeedsSync: false,
        sage_reference_synced: syncedRef,
        sage_total_synced: Number.isFinite(sageTotal) ? sageTotal : fallbackOrder.sage_total_synced,
        sage_trigger: false,
        sage_processed_at: nowIso,
        totalVerified: (() => {
          const billedNum = Number.isFinite(fallbackOrder?.billed_total)
            ? fallbackOrder.billed_total
            : Number.isFinite(fallbackOrder?.billedTotal)
            ? fallbackOrder.billedTotal
            : null;
          const diff =
            Number.isFinite(billedNum) && Number.isFinite(sageTotal)
              ? Math.abs(billedNum - sageTotal)
              : null;
          return diff !== null && diff < 0.001 ? true : fallbackOrder.totalVerified;
        })(),
        valueCheckAlert: (() => {
          const billedNum = Number.isFinite(fallbackOrder?.billed_total)
            ? fallbackOrder.billed_total
            : Number.isFinite(fallbackOrder?.billedTotal)
            ? fallbackOrder.billedTotal
            : null;
          const diff =
            Number.isFinite(billedNum) && Number.isFinite(sageTotal)
              ? Math.abs(billedNum - sageTotal)
              : null;
          if (diff !== null && diff > 0.1) return true;
          if (diff !== null && diff < 0.001) return false;
          return fallbackOrder.valueCheckAlert;
        })(),
      };
      const merged = { ...fallbackOrder, ...patch };
      updated.push(merged);
      changed = true;
    }

    if (changed) writeOrders(updated);
  }

  function applyReconcileResult(refKey, billedTotal, delta, fallbackOrder = null, sageTotalOverride = null, journalStr = "") {
    const orders = readOrders();
    const list = Array.isArray(orders) ? orders : [];
    const key = (refKey || "").toString().trim().toUpperCase();
    if (!key) return;
    const nowIso = new Date().toISOString();
    const billedNum = Number.isFinite(billedTotal) ? billedTotal : null;
    let found = false;
    const updated = list.map((o) => {
      if (!o) return o;
      const cand = (o.sage_reference || o.reference || o.__row || "").toString().trim().toUpperCase();
      if (!cand || cand !== key) return o;
      found = true;
      const resolvedSageTotal = Number.isFinite(sageTotalOverride)
        ? sageTotalOverride
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
        reconciliation_delta: delta,
        journalEntry: resolvedJournal,
        journal_entry: resolvedJournal,
        totalVerified: verified ? true : o.totalVerified,
        valueCheckAlert: needsValueCheck ? true : verified ? false : o.valueCheckAlert,
      };
    });
    if (!found && fallbackOrder) {
      const resolvedSageTotal = Number.isFinite(sageTotalOverride)
        ? sageTotalOverride
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
        reconciliation_delta: delta,
        journalEntry: resolvedJournal,
        journal_entry: resolvedJournal,
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
        invoiceSageUpdate: true,
        sage_reference_synced: o?.sage_reference || o?.source_invoice || o?.reference || "",
        sage_processed_at: nowIso,
        journalEntry: nextJournal,
        journal_entry: nextJournal,
      };
    });
    if (changed) writeOrders(updated);
  }

  return {
    applySageResult,
    applyReconcileResult,
    applyInvoiceResult,
  };
};

module.exports = {
  extractJournalLine,
  extractSageTotal,
  extractReconcileApplied,
  createSageDomain,
};
