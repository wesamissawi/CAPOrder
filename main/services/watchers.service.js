const createWatchersService = (deps) => {
  // Two watchers left: the op-log directory (everything replicated) and
  // sage_lock.json (the one exclusion that isn't about data). The queue-file,
  // orders, bubble-shared and bubble-lock watchers are gone, and so are the
  // readers they needed.
  const {
    fs,
    getWin,
    getCrdtOpsDir,
    refreshCrdt,
    getSagePoActive,
    getSageLockFile,
    readSageLock,
    sageLockIsLive,
    getMachineId,
    onSageLockForcedOff,
  } = deps;

  const chokidar = (() => {
    if (deps?.chokidar && typeof deps.chokidar.watch === 'function') return deps.chokidar;
    try { return require('chokidar'); } catch { return null; }
  })();
  const useChokidar = Boolean(chokidar && typeof chokidar.watch === 'function');

  let itemsWatchers = [];
  let sageLockWatcher = null;
  const debounceTimers = new Map();

  function debounce(key, fn, wait = 200) {
    if (debounceTimers.has(key)) clearTimeout(debounceTimers.get(key));
    const id = setTimeout(() => {
      debounceTimers.delete(key);
      fn();
    }, wait);
    debounceTimers.set(key, id);
  }

  function createFileWatcher(file, onChange, label) {
    if (useChokidar) {
      const watcher = chokidar.watch(file, {
        ignoreInitial: true,
        awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 100 },
      });
      const handler = () => debounce(`${label}:${file}`, () => onChange('change'));
      watcher.on('add', handler);
      watcher.on('change', handler);
      watcher.on('unlink', handler);
      // An FSWatcher is an EventEmitter, so an 'error' with no listener is
      // THROWN — and chokidar routes every fs error it can't classify (it only
      // swallows ENOENT/ENOTDIR) through emit('error'). Over SMB that turns a
      // momentary stat failure into a fatal main-process dialog. Log it and
      // leave the watcher up; the next write to the file re-fires it anyway.
      watcher.on('error', (e) => console.error(`[watch] ${label} watcher error`, e?.code || '', e?.message || e));
      return () => {
        try { watcher.close(); } catch {}
      };
    }

    let watcher;
    const start = () => {
      try {
        if (watcher) watcher.close();
      } catch {}
      watcher = fs.watch(file, { persistent: false }, (eventType) => {
        debounce(`${label}:${file}`, () => onChange(eventType));
        if (eventType === 'rename') {
          // file replaced via atomic write; reattach watcher
          setTimeout(start, 100);
        }
      });
    };
    start();
    return () => {
      try { watcher && watcher.close(); } catch {}
    };
  }

  // ---- replicated store ----
  //
  // One watcher on <share>/crdt/ops replaces the per-file watchers that used to
  // sit on each queue file, orders.json and bubble_shared.json.
  //
  // Watching the op logs instead of the data files is a strictly better signal:
  //
  //   * Op logs are append-only, so a change event means "there is more to
  //     read", never "someone is halfway through replacing this file". The
  //     awaitWriteFinish debounce and the skip-the-push-on-a-failed-read guards
  //     existed only to survive that second case.
  //   * A refresh reads just the bytes appended since last time, rather than
  //     re-parsing every file from the top.
  //   * The store works out which entities actually changed, so the renderer is
  //     only told about what moved.
  //
  // The projection files are still written, but nothing watches them any more —
  // they are output, not a channel.
  function startWatching() {
    itemsWatchers.forEach((w) => {
      try {
        if (typeof w === 'function') w();
        else if (w && typeof w.close === 'function') w.close();
      } catch {}
    });
    itemsWatchers = [];

    if (typeof getCrdtOpsDir !== 'function' || typeof refreshCrdt !== 'function') {
      console.warn('[watch] CRDT ops dir not configured — remote changes will not stream in');
      return;
    }

    const dir = getCrdtOpsDir();
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (e) {
      console.error('[watch] could not create ops dir', dir, e);
    }

    // Watch the DIRECTORY, not individual logs: a machine that joins the share
    // later shows up as a new file, and a per-file watcher list would never see
    // it. Pulling in that case is exactly when it matters most.
    const onOps = () => {
      try {
        refreshCrdt();
      } catch (e) {
        console.error('[watch] crdt refresh failed', e?.message || e);
      }
    };

    if (useChokidar) {
      const watcher = chokidar.watch(dir, { ignoreInitial: true, depth: 0 });
      const handler = () => debounce('crdt-ops', onOps, 150);
      watcher.on('add', handler);
      watcher.on('change', handler);
      watcher.on('unlink', handler);
      // See createFileWatcher: an unlistened 'error' would be thrown, and this
      // watcher sits on a network share where transient stat failures happen.
      watcher.on('error', (e) => console.error('[watch] ops watcher error', e?.code || '', e?.message || e));
      itemsWatchers.push(() => {
        try { watcher.close(); } catch {}
      });
    } else {
      try {
        const watcher = fs.watch(dir, { persistent: false }, () => debounce('crdt-ops', onOps, 150));
        itemsWatchers.push(() => {
          try { watcher.close(); } catch {}
        });
      } catch (e) {
        console.error('[watch] fs.watch on ops dir failed', e);
      }
    }

    // A directory watch over SMB can miss events — the change notification is
    // best-effort on a network share, and a missed one would leave this machine
    // quietly stale. A slow poll is the backstop; it costs a stat per log.
    const poll = setInterval(onOps, 5000);
    itemsWatchers.push(() => clearInterval(poll));

    console.log('[watch] watching op logs at', dir);
  }

  // startOrdersWatching / stopOrdersWatching / startBubbleSharedWatching lived
  // here. Orders and shared bubbles ride the op-log watcher above like
  // everything else, so the three were already empty stubs kept to spare their
  // call sites; the call sites are gone too now. Sage processing is triggered
  // from the store's change callback in main.js, which knows whether orders
  // were among the entities that actually changed.

  function startSageLockWatching() {
    if (!getSageLockFile || !readSageLock || !getMachineId) return;
    try {
      if (typeof sageLockWatcher === 'function') sageLockWatcher();
      else if (sageLockWatcher && typeof sageLockWatcher.close === 'function') sageLockWatcher.close();
    } catch {}
    const file = getSageLockFile();
    if (!file) return;
    sageLockWatcher = createFileWatcher(file, () => {
      const lock = readSageLock();
      const ownId = getMachineId();
      const win = getWin();
      const lockedByOther = lock && lock.machineId && lock.machineId !== ownId;
      const poActive = getSagePoActive ? getSagePoActive() : false;
      const forcedOff = Boolean(lockedByOther && poActive);
      if (forcedOff) {
        console.log('[sage-lock] another machine claimed the lock — forcing local PO OFF', lock.machineId);
        onSageLockForcedOff?.();
      }
      if (win && !win.isDestroyed()) {
        win.webContents.send('sage:lock-changed', {
          lock: lock || null,
          lockIsLive: Boolean(lock && sageLockIsLive?.(lock)),
          ownMachineId: ownId,
          lockedByOther: Boolean(lockedByOther),
          forcedOff,
        });
      }
    }, 'sage-lock');
  }

  // startBubbleLockWatching lived here. The bubble lock is gone — see main.js.
  // The sage lock keeps its watcher: that one coordinates a single Sage UI
  // being driven by AHK, which is a real-world exclusion the store can't merge.

  return {
    startWatching,
    startSageLockWatching,
  };
};

module.exports = { createWatchersService };
