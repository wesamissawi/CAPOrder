const { createSageActions } = require('./sage.actions');
const { extractSagePosted } = require('../domain/sage.domain');

const createSageService = (deps) => {
  const {
    normalizeOrderRef,
    readOrders,
    applySageResult,
    applyInvoiceResult,
    getSagePoActive,
    setSageOrderLock,
    clearSageOrderLock,
    isSageHalted,
    haltSage,
  } = deps;

  const halted = () => {
    try {
      return typeof isSageHalted === 'function' && isSageHalted();
    } catch {
      return false;
    }
  };

  // A run that did NOT post. Two cases:
  //  - code 'aborted': somebody pressed Stop Sage (or Release on this order).
  //    The stop already made every order unsent; just make sure this one's
  //    lock and trigger are gone too.
  //  - anything else (script error, timeout): the order is pulled out of the
  //    queue and flagged failed — it used to go straight back to "queued" and
  //    retry, and a hanging order then hung again every 5 minutes (502
  //    timeouts from 4 orders). The whole queue is halted as well: a half-typed
  //    purchase is likely still open in Sage, and the next order must not be
  //    typed on top of it. A person checks Sage and presses Resume.
  function handleUnpostedRun(refKey, res, extraPatch = {}) {
    const error = (res?.error || res?.stderr || `exit ${res?.code}`).toString().slice(0, 300);
    if (res?.code === 'aborted') {
      clearSageOrderLock?.(refKey, { ...extraPatch });
      return { aborted: true };
    }
    clearSageOrderLock?.(refKey, {
      ...extraPatch,
      sage_failed: true,
      sage_failed_error: error,
      sage_failed_at: new Date().toISOString(),
    });
    haltSage?.({
      kind: 'failure',
      refKey,
      reason: `${refKey} failed in Sage (${res?.code === 'timeout' ? 'timed out' : error}).`,
    });
    return { aborted: false };
  }

  let sageProcessing = false;
  let sagePendingRun = false;
  const sageProcessingRefs = new Set();
  let invoiceProcessing = false;
  let invoicePendingRun = false;
  const invoiceProcessingRefs = new Set();

  const { runSagePurchase, runSageReconcile, runUpdateInvoice, runSageSalesInvoice } = createSageActions(deps);

  // `sage_trigger` means "send this to Sage now" and nothing else — the waiting
  // room is `sage_queued`, which this never looks at (see orders.ipc.js). So
  // this stays fully automatic on purpose: whichever machine holds the PO
  // heartbeat lock picks the work up the moment a trigger lands in its store,
  // no matter which machine pressed the button.
  async function processSageOrdersQueue() {
    if (!getSagePoActive()) return;
    if (halted()) return;
    if (sageProcessing) {
      sagePendingRun = true;
      return;
    }

    sageProcessing = true;
    try {
      const orders = readOrders();
      const targets = [];
      (orders || []).forEach((order) => {
        const refKey = normalizeOrderRef(order);
        if (!refKey) return;
        if (!order?.sage_trigger) return;
        if (order?.enteredInSage) return;
        if (sageProcessingRefs.has(refKey)) return;
        targets.push({ refKey, order });
      });

      // Oldest orders first based on orderDate/orderDateRaw
      const orderToTimestamp = (o) => {
        const d =
          o?.orderDate
            ? new Date(o.orderDate)
            : o?.orderDateRaw
            ? new Date(o.orderDateRaw)
            : null;
        const ts = d && !Number.isNaN(d.getTime()) ? d.getTime() : Number.POSITIVE_INFINITY;
        return ts;
      };
      targets.sort((a, b) => orderToTimestamp(a.order) - orderToTimestamp(b.order));

      for (const { refKey, order } of targets) {
        // Stop Sage pressed (or a previous run in this pass failed): leave the
        // rest exactly as they are.
        if (halted()) break;
        sageProcessingRefs.add(refKey);
        console.log("[sage] starting AHK for", refKey);
        // Mark the order as actively running on this machine. Everyone else sees
        // a live lock and stops writing to it until we report back.
        setSageOrderLock?.(refKey, "running");
        const res = await runSagePurchase(order);
        // The journal entry on stdout — not the exit code — is what says the
        // order reached Sage. A run that posted and then exited badly (or was
        // killed by our timeout while a dialog hung around) must still be
        // recorded and released, never retried, or Sage gets it twice.
        const posted = extractSagePosted(res?.stdout);
        if (!res?.ok && !posted.posted) {
          console.error("[sage] AHK run failed for", refKey, res?.error || res?.stderr || res?.code, {
            stdout: (res?.stdout || "").toString().trim(),
            stderr: (res?.stderr || "").toString().trim(),
          });
          handleUnpostedRun(refKey, res, { sage_trigger: false });
          sageProcessingRefs.delete(refKey);
          break;
        } else {
          const dirtyExit = !res?.ok;
          if (dirtyExit) {
            console.warn(
              "[sage] AHK exited non-zero AFTER posting",
              refKey,
              posted.journalEntry,
              "- recording it as entered instead of retrying"
            );
          } else {
            console.log(
              "[sage] AHK success for",
              refKey,
              "stdout:",
              (res.stdout || "").toString().trim()
            );
          }
          applySageResult(
            refKey,
            posted.posted ? { ...res, journalEntry: posted.journalEntry } : res,
            order,
            {
              runWarning: dirtyExit
                ? `Posted to Sage as ${posted.journalEntry}, but the script exited abnormally (${
                    res?.error || res?.code
                  }). Check Sage for a leftover window or a partial entry.`
                : "",
            }
          );
        }
        sageProcessingRefs.delete(refKey);
      }
    } catch (e) {
      console.error("[sage] queue error", e);
    } finally {
      sageProcessing = false;
      if (sagePendingRun && getSagePoActive()) {
        sagePendingRun = false;
        setTimeout(() => processSageOrdersQueue(), 200);
      } else {
        sagePendingRun = false;
      }
    }
  }

  // Invoice updates ride the SAME machine as purchase orders — the one holding
  // the PO heartbeat lock — and arrive the same way: queued on any machine
  // (sage_invoice_queued), promoted to sage_invoice_trigger by "Send to Sage".
  // They used to be gated on the local invoice toggle, which meant "Update
  // Invoice" typed into Sage on whichever machine pressed the button, and two
  // machines with invoices on could both grab the same update.
  async function processInvoiceUpdateQueue() {
    if (!getSagePoActive()) return;
    if (halted()) return;
    if (invoiceProcessing) {
      invoicePendingRun = true;
      return;
    }
    invoiceProcessing = true;
    try {
      const orders = readOrders();
      const targets = [];
      (orders || []).forEach((order) => {
        const refKey = normalizeOrderRef(order);
        if (!refKey) return;
        if (!order?.sage_invoice_trigger) return;
        if (invoiceProcessingRefs.has(refKey)) return;
        targets.push({ refKey, order });
      });
      for (const { refKey, order } of targets) {
        if (halted()) break;
        invoiceProcessingRefs.add(refKey);
        // kind: "invoice" is what tells the lock when this order is finished —
        // sageOrderWorkFinished checks sage_invoice_trigger for an invoice lock
        // and enteredInSage for a purchase one, and an invoice update always
        // runs on an order that is already entered, so a lock without the kind
        // reads as finished the moment it is stamped and never blurs the card.
        setSageOrderLock?.(refKey, "running", { kind: "invoice" });
        const res = await runUpdateInvoice(order);
        // Same rule as the purchase queue: update_invoice.ahk only prints the
        // journal entry once Sage has committed the update.
        const posted = extractSagePosted(res?.stdout);
        if (!res?.ok && !posted.posted) {
          console.error("[sage-invoice] AHK run failed for", refKey, res?.error || res?.stderr || res?.code);
          handleUnpostedRun(refKey, res, { sage_invoice_trigger: false });
          invoiceProcessingRefs.delete(refKey);
          break;
        } else {
          if (!res?.ok) {
            console.warn(
              "[sage-invoice] AHK exited non-zero AFTER posting",
              refKey,
              posted.journalEntry,
              "- recording it instead of retrying"
            );
          }
          applyInvoiceResult(refKey, res, order);
        }
        invoiceProcessingRefs.delete(refKey);
      }
    } catch (e) {
      console.error("[sage-invoice] queue error", e);
    } finally {
      invoiceProcessing = false;
      if (invoicePendingRun && getSagePoActive()) {
        invoicePendingRun = false;
        setTimeout(() => processInvoiceUpdateQueue(), 200);
      } else {
        invoicePendingRun = false;
      }
    }
  }

  function scheduleSageProcessing() {
    // Both queues now belong to the PO machine; each still self-gates.
    if (getSagePoActive()) {
      processSageOrdersQueue();
      processInvoiceUpdateQueue();
    }
  }

  function resetSageQueue() {
    sageProcessingRefs.clear();
    sagePendingRun = false;
  }

  return {
    runSagePurchase,
    runSageReconcile,
    runUpdateInvoice,
    runSageSalesInvoice,
    processSageOrdersQueue,
    processInvoiceUpdateQueue,
    scheduleSageProcessing,
    resetSageQueue,
  };
};

module.exports = { createSageService };
