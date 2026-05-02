const registerPaymentsIpc = (ipcMain, deps) => {
  const { readPayments, writePayments, getPaymentsFile } = deps;

  ipcMain.handle('payments:read', () => readPayments());
  ipcMain.handle('payments:get-path', () => ({ path: getPaymentsFile() }));
  ipcMain.handle('payments:write', (_evt, payments) => {
    const current = readPayments();
    const a = JSON.stringify(current ?? []);
    const b = JSON.stringify(payments ?? []);
    if (a !== b) writePayments(payments);
    return { ok: true };
  });
};

module.exports = { registerPaymentsIpc };
