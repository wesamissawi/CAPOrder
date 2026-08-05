const { createSageActions } = require('./sage.actions');
const { extractSagePosted } = require('../domain/sage.domain');

const createSageService = (deps) => {
  const {
    normalizeOrderRef,
    readOrders,
    applySageResult,
    applyInvoiceResult,
    getSagePoActive,
    getSageInvoiceActive,
    setSageOrderLock,
    clearSageOrderLock,
  } = deps;

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
        sageProcessingRefs.add(refKey);
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
          // Back to "queued": sage_trigger is still set, so this order is retried
          // on the next pass, and the card stays blurred with the failure shown.
          setSageOrderLock?.(refKey, "queued", {
            lastError: (res?.error || res?.stderr || `exit ${res?.code}`).toString().slice(0, 300),
          });
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

  async function processInvoiceUpdateQueue() {
    if (!getSageInvoiceActive()) return;
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
        invoiceProcessingRefs.add(refKey);
        targets.push({ refKey, order });
      });
      for (const { refKey, order } of targets) {
        setSageOrderLock?.(refKey, "running");
        const res = await runUpdateInvoice(order);
        // Same rule as the purchase queue: update_invoice.ahk only prints the
        // journal entry once Sage has committed the update.
        const posted = extractSagePosted(res?.stdout);
        if (!res?.ok && !posted.posted) {
          console.error("[sage-invoice] AHK run failed for", refKey, res?.error || res?.stderr || res?.code);
          setSageOrderLock?.(refKey, "queued", {
            lastError: (res?.error || res?.stderr || `exit ${res?.code}`).toString().slice(0, 300),
          });
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
      if (invoicePendingRun && getSageInvoiceActive()) {
        invoicePendingRun = false;
        setTimeout(() => processInvoiceUpdateQueue(), 200);
      } else {
        invoicePendingRun = false;
      }
    }
  }

  function scheduleSageProcessing() {
    // Each queue self-gates on its own active flag, so just kick both.
    if (getSagePoActive()) processSageOrdersQueue();
    if (getSageInvoiceActive()) processInvoiceUpdateQueue();
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
