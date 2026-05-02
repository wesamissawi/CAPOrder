const { createSageActions } = require('./sage.actions');

const createSageService = (deps) => {
  const {
    normalizeOrderRef,
    readOrders,
    applySageResult,
    applyInvoiceResult,
    getSageIntegrationActive,
  } = deps;

  let sageProcessing = false;
  let sagePendingRun = false;
  const sageProcessingRefs = new Set();
  let invoiceProcessing = false;
  let invoicePendingRun = false;
  const invoiceProcessingRefs = new Set();

  const { runSagePurchase, runSageReconcile, runUpdateInvoice } = createSageActions(deps);

  async function processSageOrdersQueue() {
    if (!getSageIntegrationActive()) return;
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
        const res = await runSagePurchase(order);
        if (!res?.ok) {
          console.error("[sage] AHK run failed for", refKey, res?.error || res?.stderr || res?.code, {
            stdout: (res?.stdout || "").toString().trim(),
            stderr: (res?.stderr || "").toString().trim(),
          });
        } else {
          console.log(
            "[sage] AHK success for",
            refKey,
            "stdout:",
            (res.stdout || "").toString().trim()
          );
          applySageResult(refKey, res, order);
        }
        sageProcessingRefs.delete(refKey);
      }
    } catch (e) {
      console.error("[sage] queue error", e);
    } finally {
      sageProcessing = false;
      if (sagePendingRun && getSageIntegrationActive()) {
        sagePendingRun = false;
        setTimeout(() => processSageOrdersQueue(), 200);
      } else {
        sagePendingRun = false;
      }
    }
  }

  async function processInvoiceUpdateQueue() {
    if (!getSageIntegrationActive()) return;
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
        const res = await runUpdateInvoice(order);
        if (!res?.ok) {
          console.error("[sage-invoice] AHK run failed for", refKey, res?.error || res?.stderr || res?.code);
        } else {
          applyInvoiceResult(refKey, res, order);
        }
        invoiceProcessingRefs.delete(refKey);
      }
    } catch (e) {
      console.error("[sage-invoice] queue error", e);
    } finally {
      invoiceProcessing = false;
      if (invoicePendingRun && getSageIntegrationActive()) {
        invoicePendingRun = false;
        setTimeout(() => processInvoiceUpdateQueue(), 200);
      } else {
        invoicePendingRun = false;
      }
    }
  }

  function scheduleSageProcessing() {
    if (!getSageIntegrationActive()) return;
    if (sageProcessing) {
      sagePendingRun = true;
      return;
    }
    processSageOrdersQueue();
    processInvoiceUpdateQueue();
  }

  function resetSageQueue() {
    sageProcessingRefs.clear();
    sagePendingRun = false;
  }

  return {
    runSagePurchase,
    runSageReconcile,
    runUpdateInvoice,
    processSageOrdersQueue,
    processInvoiceUpdateQueue,
    scheduleSageProcessing,
    resetSageQueue,
  };
};

module.exports = { createSageService };
