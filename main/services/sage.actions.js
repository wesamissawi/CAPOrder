const createSageActions = (deps) => {
  const {
    fs,
    path,
    spawn,
    app,
    SAGE_AHK_SCRIPT,
    SAGE_RECONCILE_SCRIPT,
    SAGE_INVOICE_SCRIPT,
    getOrdersFile,
    backupFile,
    writeTempOrder,
    getAhkExePath,
    extractJournalLine,
    extractSageTotal,
    extractReconcileApplied,
    getVendorName,
    getSageAhkTimeoutMs,
  } = deps;

  function runAhkScript({
    scriptPath,
    args = [],
    logPrefix = 'sage',
    timeoutMs = 5 * 60 * 1000,
  }) {
    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let finished = false;

      const complete = (payload) => {
        if (finished) return;
        finished = true;
        resolve(payload);
      };

      const child = spawn(scriptPath, args, { windowsHide: true });
      console.log(`[${logPrefix}] AHK spawn initiated`, {
        pid: child?.pid,
        command: scriptPath,
        args,
      });

      const timeoutId = setTimeout(() => {
        console.error(`[${logPrefix}] AHK timeout`, { timeoutMs });
        try {
          child.kill();
        } catch {}
        complete({ ok: false, code: 'timeout', error: 'AHK timed out', stdout, stderr });
      }, timeoutMs);

      child.on('spawn', () => {
        console.log(`[${logPrefix}] AHK process launched successfully`, { pid: child.pid });
      });
      child.stdout.on('data', (d) => {
        const chunk = d.toString();
        stdout += chunk;
        console.log(`[${logPrefix}] AHK stdout chunk:`, chunk.trim());
      });
      child.stderr.on('data', (d) => {
        const chunk = d.toString();
        stderr += chunk;
        console.error(`[${logPrefix}] AHK stderr chunk:`, chunk.trim());
      });
      child.on('error', (err) => {
        clearTimeout(timeoutId);
        console.error(`[${logPrefix}] spawn error`, err);
        complete({ ok: false, code: 'spawn-error', error: err, stdout, stderr });
      });
      child.on('close', (code) => {
        clearTimeout(timeoutId);
        complete({ ok: code === 0, code, stdout, stderr });
      });
    });
  }

  function safeUnlink(filePath) {
    if (!filePath) return;
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (e) {
      console.warn('[sage] failed to remove temp file', { filePath, error: e?.message || e });
    }
  }

  function runSagePurchase(order) {
    const shouldCleanup = deps?.cleanupTempOrder === true;
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

      runAhkScript({
        scriptPath: resolvedExecutable,
        args,
        logPrefix: 'sage',
        timeoutMs: typeof getSageAhkTimeoutMs === 'function' ? getSageAhkTimeoutMs() : 5 * 60 * 1000,
      }).then((res) => {
        const ok = res?.ok;
        const parsedJournal = extractJournalLine(res.stdout || "");
        const parsedTotal = extractSageTotal(res.stdout || "");
        console.log('[sage] AHK finished', {
          code: res.code,
          ok,
          stdout: (res.stdout || "").trim(),
          stderr: (res.stderr || "").trim(),
          parsedJournal,
          parsedTotal,
        });
        console.log(ok ? '[sage] AHK process launch+run completed successfully' : '[sage] AHK process finished with errors', {
          code: res.code,
          ok,
        });
        resolve({ ...res, journalEntry: parsedJournal, sageTotal: parsedTotal });
      }).finally(() => {
        if (shouldCleanup) safeUnlink(orderPath);
      });
    });
  }

  function runSageReconcile(order, delta) {
    const shouldCleanup = deps?.cleanupTempOrder === true;
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
        tempOrderPath: orderPath,
        ahkScriptPath: path.resolve(SAGE_RECONCILE_SCRIPT),
        ahkExecutable,
        resolvedAhkExecutable: resolvedExecutable,
        spawnArgs: args,
        spawnCommand: [resolvedExecutable, ...args].join(' '),
      });

      runAhkScript({
        scriptPath: resolvedExecutable,
        args,
        logPrefix: 'sage-reconcile',
        timeoutMs: typeof getSageAhkTimeoutMs === 'function' ? getSageAhkTimeoutMs() : 5 * 60 * 1000,
      }).then((res) => {
        const ok = res?.ok;
        const parsedJournal = extractJournalLine(res.stdout || "");
        const parsedTotal = extractSageTotal(res.stdout || "");
        console.log('[sage-reconcile] AHK finished', {
          code: res.code,
          ok,
          stdout: (res.stdout || "").trim(),
          stderr: (res.stderr || "").trim(),
          parsedJournal,
          parsedTotal,
        });
        const applied = extractReconcileApplied(res.stdout || "");
        resolve({ ...res, applied, journalEntry: parsedJournal, sageTotal: parsedTotal });
      }).finally(() => {
        if (shouldCleanup) safeUnlink(orderPath);
      });
    });
  }

  function runUpdateInvoice(order) {
    const shouldCleanup = deps?.cleanupTempOrder === true;
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
      runAhkScript({
        scriptPath: resolvedExecutable,
        args,
        logPrefix: 'sage-invoice',
        timeoutMs: typeof getSageAhkTimeoutMs === 'function' ? getSageAhkTimeoutMs() : 5 * 60 * 1000,
      }).then((res) => resolve(res)).finally(() => {
        if (shouldCleanup) safeUnlink(orderPath);
      });
    });
  }

  return {
    runSagePurchase,
    runSageReconcile,
    runUpdateInvoice,
  };
};

module.exports = { createSageActions };
