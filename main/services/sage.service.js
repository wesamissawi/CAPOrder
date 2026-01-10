const createSageService = (deps) => {
  const {
    fs,
    path,
    spawn,
    app,
    SAGE_AHK_SCRIPT,
    SAGE_RECONCILE_SCRIPT,
    SAGE_INVOICE_SCRIPT,
    SAGE_TEMP_ORDER,
    getOrdersFile,
    backupFile,
    writeTempOrder,
    getAhkExePath,
    extractJournalLine,
    extractSageTotal,
    extractReconcileApplied,
    getVendorName,
    normalizeOrderRef,
    readOrders,
    applySageResult,
    applyInvoiceResult,
    applyReconcileResult,
    getSageIntegrationActive,
  } = deps;

  let sageProcessing = false;
  let sagePendingRun = false;
  const sageProcessingRefs = new Set();
  let invoiceProcessing = false;
  let invoicePendingRun = false;
  const invoiceProcessingRefs = new Set();

  function runSagePurchase(order) {
    return new Promise((resolve) => {
      if (!fs.existsSync(SAGE_AHK_SCRIPT)) {
        console.error('[sage] AHK script not found', { path: SAGE_AHK_SCRIPT });
        return resolve({
          ok: false,
          error: 'AHK script not found',
          code: 'ahk-script-missing',
          reason: 'ahk-script-missing',
          path: SAGE_AHK_SCRIPT,
        });
      }

      const ordersFilePath = getOrdersFile();
      backupFile(ordersFilePath, '.pre-sage.bak');

      const orderPath = writeTempOrder(order);
      if (!orderPath) {
        return resolve({ ok: false, error: 'Failed to write temp order file', code: 'temp-write-failed' });
      }

      const ahkExecutable = getAhkExePath();
      const resolvedExecutable = ahkExecutable ? path.resolve(ahkExecutable) : '';
      const ahkExists = Boolean(ahkExecutable) && fs.existsSync(ahkExecutable);

      if (!ahkExecutable || !ahkExists) {
        console.error('[sage] AHK executable path missing or invalid', {
          ahkExecutable,
          resolvedExecutable,
        });
        return resolve({
          ok: false,
          code: ahkExecutable ? 'ahk-path-invalid' : 'ahk-path-not-set',
          reason: ahkExecutable ? 'ahk-path-invalid' : 'ahk-path-not-set',
          error: 'AutoHotkey executable path is not configured or not found.',
        });
      }

      const args = [
        SAGE_AHK_SCRIPT,
        orderPath,
        order?.sage_reference || order?.reference || "",
        getVendorName(order) || "",
        ordersFilePath,
      ];

      console.log('[sage] preparing to spawn AHK', {
        timestamp: new Date().toISOString(),
        appIsPackaged: app.isPackaged,
        ordersFilePath,
        tempOrderPath: orderPath,
        ahkScriptPath: path.resolve(SAGE_AHK_SCRIPT),
        ahkExecutable,
        resolvedAhkExecutable: resolvedExecutable,
        spawnArgs: args,
        spawnCommand: [resolvedExecutable, ...args].join(' '),
      });

      let stdout = "";
      let stderr = "";
      let finished = false;

      const complete = (payload) => {
        if (finished) return;
        finished = true;
        resolve(payload);
      };

      const child = spawn(resolvedExecutable, args, { windowsHide: true });
      console.log('[sage] AHK spawn initiated', {
        pid: child?.pid,
        command: resolvedExecutable,
        args,
      });
      child.on('spawn', () => {
        console.log('[sage] AHK process launched successfully', { pid: child.pid });
      });
      child.stdout.on('data', (d) => {
        const chunk = d.toString();
        stdout += chunk;
        console.log('[sage] AHK stdout chunk:', chunk.trim());
      });
      child.stderr.on('data', (d) => {
        const chunk = d.toString();
        stderr += chunk;
        console.error('[sage] AHK stderr chunk:', chunk.trim());
      });
      child.on('error', (err) => {
        console.error('[sage] spawn error', err);
        console.error('[sage] AHK process failed to launch', {
          error: err,
          command: resolvedExecutable,
          args,
          ahkExecutable,
        });
        complete({ ok: false, code: 'spawn-error', error: err, stdout, stderr });
      });
      child.on('close', (code) => {
        const ok = code === 0;
        const parsedJournal = extractJournalLine(stdout);
        const parsedTotal = extractSageTotal(stdout);
        console.log('[sage] AHK finished', {
          code,
          ok,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          parsedJournal,
          parsedTotal,
        });
        console.log(ok ? '[sage] AHK process launch+run completed successfully' : '[sage] AHK process finished with errors', {
          code,
          ok,
        });
        complete({ ok, code, stdout, stderr, journalEntry: parsedJournal, sageTotal: parsedTotal });
      });
    });
  }

  function runSageReconcile(order, delta) {
    return new Promise((resolve) => {
      if (!fs.existsSync(SAGE_RECONCILE_SCRIPT)) {
        console.error('[sage-reconcile] AHK script not found', { path: SAGE_RECONCILE_SCRIPT });
        return resolve({
          ok: false,
          error: 'AHK script not found',
          code: 'ahk-script-missing',
          reason: 'ahk-script-missing',
          path: SAGE_RECONCILE_SCRIPT,
        });
      }

      const ordersFilePath = getOrdersFile();
      const orderPath = writeTempOrder(order);
      if (!orderPath) {
        return resolve({ ok: false, error: 'Failed to write temp order file', code: 'temp-write-failed' });
      }

      const ahkExecutable = getAhkExePath();
      const resolvedExecutable = ahkExecutable ? path.resolve(ahkExecutable) : '';
      const ahkExists = Boolean(ahkExecutable) && fs.existsSync(ahkExecutable);

      if (!ahkExecutable || !ahkExists) {
        console.error('[sage-reconcile] AHK executable path missing or invalid', {
          ahkExecutable,
          resolvedExecutable,
        });
        return resolve({
          ok: false,
          code: ahkExecutable ? 'ahk-path-invalid' : 'ahk-path-not-set',
          reason: ahkExecutable ? 'ahk-path-invalid' : 'ahk-path-not-set',
          error: 'AutoHotkey executable path is not configured or not found.',
        });
      }

      const ref = order?.sage_reference_synced || order?.sage_reference || order?.reference || "";
      const args = [
        SAGE_RECONCILE_SCRIPT,
        orderPath,
        ref,
        typeof delta === 'number' && Number.isFinite(delta) ? delta.toFixed(2) : "",
      ];

      console.log('[sage-reconcile] preparing to spawn AHK', {
        timestamp: new Date().toISOString(),
        ordersFilePath,
        tempOrderPath: orderPath,
        ahkScriptPath: path.resolve(SAGE_RECONCILE_SCRIPT),
        ahkExecutable,
        resolvedAhkExecutable: resolvedExecutable,
        spawnArgs: args,
        spawnCommand: [resolvedExecutable, ...args].join(' '),
      });

      let stdout = "";
      let stderr = "";
      let finished = false;
      const complete = (payload) => {
        if (finished) return;
        finished = true;
        resolve(payload);
      };

      const child = spawn(resolvedExecutable, args, { windowsHide: true });
      console.log('[sage-reconcile] AHK spawn initiated', {
        pid: child?.pid,
        command: resolvedExecutable,
        args,
      });
      child.on('spawn', () => {
        console.log('[sage-reconcile] AHK process launched successfully', { pid: child.pid });
      });
      child.stdout.on('data', (d) => {
        const chunk = d.toString();
        stdout += chunk;
        console.log('[sage-reconcile] AHK stdout chunk:', chunk.trim());
      });
      child.stderr.on('data', (d) => {
        const chunk = d.toString();
        stderr += chunk;
        console.error('[sage-reconcile] AHK stderr chunk:', chunk.trim());
      });
      child.on('error', (err) => {
        console.error('[sage-reconcile] spawn error', err);
        complete({ ok: false, code: 'spawn-error', error: err, stdout, stderr });
      });
      child.on('close', (code) => {
        const ok = code === 0;
        const parsedJournal = extractJournalLine(stdout);
        const parsedTotal = extractSageTotal(stdout);
        console.log('[sage-reconcile] AHK finished', {
          code,
          ok,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          parsedJournal,
          parsedTotal,
        });
        const applied = extractReconcileApplied(stdout);
        complete({ ok, code, stdout, stderr, applied, journalEntry: parsedJournal, sageTotal: parsedTotal });
      });
    });
  }

  function runUpdateInvoice(order) {
    return new Promise((resolve) => {
      if (!fs.existsSync(SAGE_INVOICE_SCRIPT)) {
        console.error('[sage-invoice] AHK script not found', { path: SAGE_INVOICE_SCRIPT });
        return resolve({ ok: false, error: 'ahk-script-missing' });
      }
      const orderPath = writeTempOrder(order);
      if (!orderPath) return resolve({ ok: false, error: 'temp-write-failed' });
      const ahkExecutable = getAhkExePath();
      const resolvedExecutable = ahkExecutable ? path.resolve(ahkExecutable) : '';
      const ahkExists = Boolean(ahkExecutable) && fs.existsSync(ahkExecutable);
      if (!ahkExecutable || !ahkExists) {
        return resolve({ ok: false, error: 'ahk-exe-missing' });
      }
      const args = [SAGE_INVOICE_SCRIPT, orderPath, order?.sage_reference || order?.reference || ""];
      const child = spawn(resolvedExecutable, args, { windowsHide: true });
      let stdout = "";
      let stderr = "";
      child.stdout.on('data', (d) => (stdout += d.toString()));
      child.stderr.on('data', (d) => (stderr += d.toString()));
      child.on('error', (err) => resolve({ ok: false, error: err?.message || 'spawn-error', stderr, stdout }));
      child.on('close', (code) => resolve({ ok: code === 0, code, stdout, stderr }));
    });
  }

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
