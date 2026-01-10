const createAppConfigService = (deps) => {
  const {
    fs,
    dialog,
    path,
    INSTANCE_DIR,
    BUSINESS_FILE_LIST,
    getSharedDirInfo,
    ensureDir,
    writeAppConfig,
  } = deps;

  function findInstanceBusinessFiles() {
    return BUSINESS_FILE_LIST
      .map((name) => {
        const filePath = path.join(INSTANCE_DIR, name);
        return fs.existsSync(filePath) ? { name, path: filePath } : null;
      })
      .filter(Boolean);
  }

  async function promptForSharedFolderIfMissing() {
    const { sharedConfigured } = getSharedDirInfo();
    if (sharedConfigured) return null;
    const res = await dialog.showMessageBox({
      type: 'question',
      buttons: ['Choose folder', 'Skip for now'],
      defaultId: 0,
      cancelId: 1,
      message: 'Select shared folder for business data',
      detail: 'orders.json and all queue files must live in a shared/network folder so every workstation stays in sync.',
    });
    if (res.response !== 0) return { prompted: true, chosen: false };
    const pick = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
    if (!pick.canceled && pick.filePaths?.[0]) {
      const chosen = pick.filePaths[0];
      writeAppConfig({ sharedDataDir: chosen });
      return { prompted: true, chosen: true, path: chosen };
    }
    return { prompted: true, chosen: false, canceled: true };
  }

  function migrateBusinessFilesToShared(mode = 'copy') {
    const { sharedDir, sharedConfigured } = getSharedDirInfo();
    if (!sharedConfigured || !sharedDir || sharedDir === INSTANCE_DIR) {
      return { ok: false, error: 'Shared folder not configured.' };
    }
    ensureDir(sharedDir);

    const results = [];
    BUSINESS_FILE_LIST.forEach((name) => {
      const src = path.join(INSTANCE_DIR, name);
      const dest = path.join(sharedDir, name);
      if (!fs.existsSync(src)) {
        results.push({ name, action: 'skip', reason: 'missing source' });
        return;
      }
      if (src === dest) {
        results.push({ name, action: 'skip', reason: 'already in shared' });
        return;
      }
      if (fs.existsSync(dest)) {
        results.push({ name, action: 'skip', reason: 'dest exists' });
        return;
      }
      try {
        ensureDir(path.dirname(dest));
        if (mode === 'move') {
          fs.renameSync(src, dest);
          results.push({ name, action: 'moved', from: src, to: dest });
        } else {
          fs.copyFileSync(src, dest);
          results.push({ name, action: 'copied', from: src, to: dest });
        }
      } catch (e) {
        results.push({ name, action: 'error', error: e?.message || 'failed' });
      }
    });
    return { ok: true, sharedDir, results };
  }

  async function maybeOfferMigrationToShared() {
    const { sharedDir, sharedConfigured } = getSharedDirInfo();
    if (!sharedConfigured || !sharedDir || sharedDir === INSTANCE_DIR) {
      return { skipped: true, reason: 'not-configured' };
    }
    const candidates = findInstanceBusinessFiles().filter((entry) => entry.path !== path.join(sharedDir, entry.name));
    if (!candidates.length) return { skipped: true, reason: 'no-instance-files' };

    const res = await dialog.showMessageBox({
      type: 'question',
      buttons: ['Copy to shared', 'Move to shared', 'Skip'],
      defaultId: 0,
      cancelId: 2,
      message: 'Move business data to shared folder?',
      detail: `Found business files in the instance folder (${INSTANCE_DIR}). Copy or move them to the shared folder so all machines share orders and queue data.\nShared folder: ${sharedDir}`,
    });
    if (res.response === 0 || res.response === 1) {
      const mode = res.response === 1 ? 'move' : 'copy';
      return migrateBusinessFilesToShared(mode);
    }
    return { skipped: true, reason: 'user-skip' };
  }

  return {
    promptForSharedFolderIfMissing,
    maybeOfferMigrationToShared,
    migrateBusinessFilesToShared,
  };
};

module.exports = { createAppConfigService };
