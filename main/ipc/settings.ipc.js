const registerSettingsIpc = (ipcMain, deps) => {
  const {
    readUIState,
    writeUIState,
    loadConfig,
    saveConfig,
    getUserConfigRaw,
    getUserConfigEffective,
    getEnvOverrides,
    readConfig,
    writeConfig,
    ensureConfigFile,
    readAppConfig,
    ensureBusinessFiles,
    getSharedDirInfo,
    writeAppConfig,
    startWatching,
    startOrdersWatching,
    startBubbleSharedWatching,
    validateWritable,
    migrateBusinessFilesToShared,
    getResolvedPathsSummary,
    getAhkExePath,
    validateAhkExePath,
    INSTANCE_PATHS,
    INSTANCE_DIR,
    fs,
    dialog,
    app,
  } = deps;

  ipcMain.handle('ui-state:read', () => ({ ok: true, state: readUIState() }));
  ipcMain.handle('ui-state:write', (_evt, state) => {
    writeUIState(state && typeof state === 'object' ? state : {});
    return { ok: true };
  });

  ipcMain.handle('app-config:get', () => {
    try {
      const cfg = readAppConfig();
      ensureBusinessFiles();
      const { sharedDir, sharedConfigured } = getSharedDirInfo();
      return { ok: true, config: { ...cfg, sharedDataDir: cfg.sharedDataDir || '', instanceDataDir: INSTANCE_DIR }, path: INSTANCE_PATHS.appConfig, sharedConfigured };
    } catch (e) {
      console.error('[app-config:get]', e);
      return { ok: false, error: e?.message || 'Failed to read app config.' };
    }
  });

  ipcMain.handle('app-config:set', (_evt, partial) => {
    try {
      if (!partial || typeof partial !== 'object' || Array.isArray(partial)) {
        return { ok: false, error: 'Invalid config payload' };
      }
      const next = writeAppConfig(partial);
      ensureBusinessFiles();
      // restart watchers to pick up new shared dir
      startWatching(deps.getWin());
      startOrdersWatching(deps.getWin());
      startBubbleSharedWatching(deps.getWin());
      const { sharedDir, sharedConfigured } = getSharedDirInfo();
      return { ok: true, config: { ...next, sharedDataDir: sharedDir, instanceDataDir: INSTANCE_DIR }, sharedConfigured, path: INSTANCE_PATHS.appConfig };
    } catch (e) {
      console.error('[app-config:set]', e);
      return { ok: false, error: e?.message || 'Failed to write app config.' };
    }
  });

  ipcMain.handle('app-config:choose-shared', async () => {
    const res = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
    if (res.canceled || !res.filePaths?.[0]) return { ok: false, canceled: true };
    const chosen = res.filePaths[0];
    return { ok: true, path: chosen };
  });

  ipcMain.handle('app-config:paths-summary', () => {
    try {
      ensureBusinessFiles();
      return { ok: true, summary: getResolvedPathsSummary() };
    } catch (e) {
      return { ok: false, error: e?.message || 'Failed to summarize paths.' };
    }
  });
  ipcMain.handle('app-config:resolved-paths', () => {
    try {
      ensureBusinessFiles();
      return { ok: true, summary: getResolvedPathsSummary() };
    } catch (e) {
      return { ok: false, error: e?.message || 'Failed to resolve paths.' };
    }
  });

  ipcMain.handle('app-config:validate-shared', (_evt, dirPath) => {
    const target = (dirPath || '').trim();
    if (!target) return { ok: false, error: 'Path required' };
    const res = validateWritable(target);
    return res.ok ? { ok: true } : res;
  });

  ipcMain.handle('app-config:migrate-business', (_evt, payload) => {
    try {
      const mode = payload?.mode === 'move' ? 'move' : 'copy';
      const res = migrateBusinessFilesToShared(mode);
      ensureBusinessFiles();
      startWatching(deps.getWin());
      startOrdersWatching(deps.getWin());
      return res;
    } catch (e) {
      console.error('[app-config:migrate-business]', e);
      return { ok: false, error: e?.message || 'Failed to migrate files.' };
    }
  });

  ipcMain.handle('ahk:get-path', () => {
    try {
      const pathStr = getAhkExePath();
      return { ok: true, path: pathStr, exists: Boolean(pathStr) && fs.existsSync(pathStr) };
    } catch (e) {
      console.error('[ahk:get-path]', e);
      return { ok: false, error: e?.message || 'Failed to read AHK path.' };
    }
  });
  ipcMain.handle('ahk:set-path', (_evt, pathStr) => {
    try {
      const next = writeAppConfig({ ahkExePath: typeof pathStr === 'string' ? pathStr.trim() : '' });
      const exists = Boolean(next.ahkExePath) && fs.existsSync(next.ahkExePath);
      return { ok: true, path: next.ahkExePath, exists };
    } catch (e) {
      console.error('[ahk:set-path]', e);
      return { ok: false, error: e?.message || 'Failed to save AHK path.' };
    }
  });
  ipcMain.handle('ahk:choose-path', async () => {
    try {
      const res = await dialog.showOpenDialog({
        properties: ['openFile'],
        filters: [{ name: 'Executable', extensions: ['exe'] }],
      });
      if (res.canceled || !res.filePaths?.[0]) return { ok: false, canceled: true };
      const chosen = res.filePaths[0];
      return { ok: true, path: chosen };
    } catch (e) {
      console.error('[ahk:choose-path]', e);
      return { ok: false, error: e?.message || 'Failed to choose AHK path.' };
    }
  });
  ipcMain.handle('ahk:validate-path', (_evt, pathStr) => {
    try {
      const res = validateAhkExePath(pathStr);
      return { ok: true, exists: res.exists, path: res.path };
    } catch (e) {
      console.error('[ahk:validate-path]', e);
      return { ok: false, error: e?.message || 'Failed to validate AHK path.' };
    }
  });

  ipcMain.handle('app:get-version', () => {
    try {
      return {
        ok: true,
        version: app.getVersion(),
        name: app.getName ? app.getName() : 'CAPOrder',
        isPackaged: app.isPackaged,
      };
    } catch (e) {
      return { ok: false, error: e?.message || 'Failed to read app version.' };
    }
  });

  ipcMain.handle('config:get', () => {
    try {
      const config = loadConfig();
      return { ok: true, config, path: INSTANCE_PATHS.windowConfig };
    } catch (e) {
      return { ok: false, error: e?.message || 'Failed to read config.' };
    }
  });
  ipcMain.handle('config:set', (_evt, partial) => {
    try {
      if (!partial || typeof partial !== 'object' || Array.isArray(partial)) {
        return { ok: false, error: 'Invalid config payload' };
      }
      const config = saveConfig(partial);
      return { ok: true, config, path: INSTANCE_PATHS.windowConfig };
    } catch (e) {
      return { ok: false, error: e?.message || 'Failed to save config.' };
    }
  });

  ipcMain.handle('config:read', () => {
    try {
      ensureConfigFile();
      const raw = getUserConfigRaw();
      const effective = getUserConfigEffective();
      const overrides = getEnvOverrides(raw);
      return { ok: true, config: effective, raw, overrides, path: INSTANCE_PATHS.windowConfig };
    } catch (e) {
      console.error('[config:read]', e);
      return { ok: false, error: e?.message || 'Failed to read config.' };
    }
  });
  ipcMain.handle('config:write', (_evt, nextConfig) => {
    try {
      ensureConfigFile();
      if (!nextConfig || typeof nextConfig !== 'object' || Array.isArray(nextConfig)) {
        return { ok: false, error: 'Config must be an object.' };
      }
      const cfg = readConfig();
      cfg.userConfig = nextConfig;
      writeConfig(cfg);
      return { ok: true };
    } catch (e) {
      console.error('[config:write]', e);
      return { ok: false, error: e?.message || 'Failed to write config.' };
    }
  });
};

module.exports = { registerSettingsIpc };
