// Statements Management IPC. Thin: every handler delegates to the service.
const fs = require('fs');
const path = require('path');

const registerStatementsIpc = (ipcMain, deps) => {
  const { statements, shell, getGmailAssetsDir } = deps;

  ipcMain.handle('statements:suppliers', () => statements.listSuppliers());
  ipcMain.handle('statements:set-config', (_e, p) => statements.setSupplierConfig(p));
  ipcMain.handle('statements:list', (_e, p) => statements.listStatements(p));
  ipcMain.handle('statements:fetch', (_e, p) => statements.fetchSupplierStatements(p));
  ipcMain.handle('statements:reconcile', (_e, p) => statements.reconcile(p));

  // Statements sit in the shared gmail dir with the invoices. Only a bare
  // statement_*.pdf / .html name is accepted, so the renderer can't ask for any other file.
  ipcMain.handle('statements:open-pdf', async (_e, fileName) => {
    try {
      const name = String(fileName || '');
      if (name !== path.basename(name) || !/^statement_[A-Za-z0-9_-]+\.(pdf|html)$/.test(name)) {
        return { ok: false, error: 'Invalid statement file name.' };
      }
      const filePath = path.join(getGmailAssetsDir(), name);
      if (!fs.existsSync(filePath)) return { ok: false, error: `Statement PDF not found: ${name}` };
      const err = await shell.openPath(filePath);
      return err ? { ok: false, error: err } : { ok: true };
    } catch (e) {
      return { ok: false, error: e?.message || 'Failed to open statement PDF.' };
    }
  });
};

module.exports = { registerStatementsIpc };
