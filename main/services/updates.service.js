const createUpdatesService = (deps) => {
  const { autoUpdater, app, getWin } = deps;
  let autoUpdaterInitialized = false;

  function sendUpdateStatus(payload = {}) {
    try {
      const win = getWin();
      if (win && !win.isDestroyed()) {
        win.webContents.send('updates:status', { ...payload, timestamp: new Date().toISOString() });
      }
    } catch (e) {
      console.error('[updates] failed to send status', e);
    }
  }

  function setupAutoUpdater() {
    if (autoUpdaterInitialized) return;
    autoUpdaterInitialized = true;
    if (!app.isPackaged) return;

    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = false;

    autoUpdater.on('checking-for-update', () => sendUpdateStatus({ status: 'checking' }));
    autoUpdater.on('update-available', (info) =>
      sendUpdateStatus({ status: 'update-available', version: info?.version || info?.releaseName })
    );
    autoUpdater.on('update-not-available', (info) =>
      sendUpdateStatus({ status: 'update-not-available', version: info?.version || info?.releaseName })
    );
    autoUpdater.on('download-progress', (progress) =>
      sendUpdateStatus({ status: 'downloading', percent: Math.round(progress?.percent ?? 0) })
    );
    autoUpdater.on('update-downloaded', (info) =>
      sendUpdateStatus({
        status: 'downloaded',
        version: info?.version || info?.releaseName,
        releaseName: info?.releaseName,
      })
    );
    autoUpdater.on('error', (err) =>
      sendUpdateStatus({ status: 'error', error: err?.message || 'Update error' })
    );
  }

  return { setupAutoUpdater, sendUpdateStatus };
};

module.exports = { createUpdatesService };
