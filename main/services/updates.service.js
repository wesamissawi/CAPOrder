// A published release used to sit unnoticed until somebody opened Settings and
// pressed "Check for Updates" — setupAutoUpdater only ever registered handlers.
// On machines that run unattended (the Sage box especially) that meant they
// could drift several versions behind without anyone realising. These two
// timers close that gap; the manual button still works exactly as before.
const STARTUP_CHECK_DELAY_MS = 20 * 1000;      // let the window and network settle first
const RECHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // a machine left running all day

const createUpdatesService = (deps) => {
  const { autoUpdater, app, getWin } = deps;
  let autoUpdaterInitialized = false;
  // True only while an automatic check is in flight. Background checks are
  // best-effort — the machine may be asleep, offline or GitHub unreachable —
  // so their failures are logged, never turned into a red banner the user
  // didn't ask for. A manual check still reports everything.
  let backgroundCheck = false;
  // Once a build is staged there is nothing further to look for until the app
  // restarts, so stop re-checking (and stop re-downloading it).
  let updateStaged = false;
  let startupTimer = null;
  let recheckTimer = null;

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

  // Marks the end of whatever check was running, so the next error is judged on
  // its own terms rather than inheriting this one's background-ness.
  function endCheck() {
    backgroundCheck = false;
  }

  async function runBackgroundCheck(reason) {
    if (!app.isPackaged || updateStaged) return;
    backgroundCheck = true;
    try {
      await autoUpdater.checkForUpdates();
    } catch (e) {
      // The 'error' handler below already swallowed the UI side of this.
      console.warn(`[updates] ${reason} check failed:`, e?.message || e);
      endCheck();
    }
  }

  // Called by the Settings button (via updates.ipc). Explicitly clears the
  // background flag so a user-initiated check always surfaces its errors, even
  // if it lands while a timer-driven one is in flight.
  function beginManualCheck() {
    backgroundCheck = false;
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
    autoUpdater.on('update-not-available', (info) => {
      endCheck();
      sendUpdateStatus({ status: 'update-not-available', version: info?.version || info?.releaseName });
    });
    autoUpdater.on('download-progress', (progress) =>
      sendUpdateStatus({ status: 'downloading', percent: Math.round(progress?.percent ?? 0) })
    );
    autoUpdater.on('update-downloaded', (info) => {
      endCheck();
      updateStaged = true;
      if (recheckTimer) {
        clearInterval(recheckTimer);
        recheckTimer = null;
      }
      sendUpdateStatus({
        status: 'downloaded',
        version: info?.version || info?.releaseName,
        releaseName: info?.releaseName,
      });
    });
    autoUpdater.on('error', (err) => {
      if (backgroundCheck) {
        endCheck();
        console.warn('[updates] background check error:', err?.message || err);
        return;
      }
      sendUpdateStatus({ status: 'error', error: err?.message || 'Update error' });
    });

    startupTimer = setTimeout(() => {
      startupTimer = null;
      runBackgroundCheck('startup');
    }, STARTUP_CHECK_DELAY_MS);
    // unref so a pending timer never keeps the process alive on quit
    if (typeof startupTimer.unref === 'function') startupTimer.unref();

    recheckTimer = setInterval(() => runBackgroundCheck('periodic'), RECHECK_INTERVAL_MS);
    if (typeof recheckTimer.unref === 'function') recheckTimer.unref();
  }

  function stopAutoUpdater() {
    if (startupTimer) {
      clearTimeout(startupTimer);
      startupTimer = null;
    }
    if (recheckTimer) {
      clearInterval(recheckTimer);
      recheckTimer = null;
    }
  }

  return { setupAutoUpdater, stopAutoUpdater, sendUpdateStatus, beginManualCheck };
};

module.exports = { createUpdatesService };
