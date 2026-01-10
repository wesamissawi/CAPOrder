const registerUpdatesIpc = (ipcMain, deps) => {
  const { app, autoUpdater, sendUpdateStatus } = deps;

  ipcMain.handle('updates:check', async () => {
    if (!app.isPackaged) {
      const msg = 'Update checks are only available in packaged builds.';
      sendUpdateStatus({ status: 'error', error: msg });
      return { ok: false, error: msg };
    }
    try {
      sendUpdateStatus({ status: 'checking' });
      await autoUpdater.checkForUpdates();
      return { ok: true };
    } catch (e) {
      const msg = e?.message || 'Failed to check for updates.';
      console.error('[updates:check]', e);
      sendUpdateStatus({ status: 'error', error: msg });
      return { ok: false, error: msg };
    }
  });

  ipcMain.handle('updates:restart', () => {
    try {
      if (!app.isPackaged) return { ok: false, error: 'Updates are only available in packaged builds.' };
      autoUpdater.quitAndInstall(false, true);
      return { ok: true };
    } catch (e) {
      const msg = e?.message || 'Failed to restart for update.';
      console.error('[updates:restart]', e);
      sendUpdateStatus({ status: 'error', error: msg });
      return { ok: false, error: msg };
    }
  });
};

module.exports = { registerUpdatesIpc };
