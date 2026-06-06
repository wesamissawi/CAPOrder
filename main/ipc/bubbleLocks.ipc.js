const STALE_MS = 10000; // heartbeat older than 10s = stale, can be stolen without asking

const registerBubbleLocksIpc = (ipcMain, deps) => {
  const { readBubbleLocks, writeBubbleLock, releaseBubbleLock, getMachineId } = deps;

  ipcMain.handle('bubble-lock:get-all', () => {
    return { locks: readBubbleLocks(), ownMachineId: getMachineId() };
  });

  // Attempt to claim edit ownership of a bubble.
  // Returns { ok: true, claimed: true }               — you own it
  // Returns { ok: false, requested: true, owner }     — request sent, waiting for owner
  ipcMain.handle('bubble-lock:claim', (_evt, bubbleId, bubbleName, opts) => {
    const force = Boolean(opts?.force);
    const ownId = getMachineId();
    const locks = readBubbleLocks();
    const existing = locks[bubbleId];
    const now = Date.now();

    const isStale = existing?.owner && (now - (existing.lastActive || 0)) > STALE_MS;
    const ownedByMe = existing?.owner === ownId;
    const ownedByOther = existing?.owner && existing.owner !== ownId && !isStale;

    if (ownedByMe) {
      writeBubbleLock(bubbleId, { ...existing, lastActive: now });
      return { ok: true, claimed: true, alreadyOwned: true };
    }

    if (ownedByOther && !force) {
      // Write a pending request into the lock entry so the owner's watcher fires
      writeBubbleLock(bubbleId, {
        ...existing,
        request: { from: ownId, requestedAt: now, status: 'pending' },
      });
      return { ok: false, claimed: false, requested: true, owner: existing.owner };
    }

    // Free, stale, or force-claim — take it
    writeBubbleLock(bubbleId, {
      owner: ownId,
      bubbleName: bubbleName || bubbleId,
      lastActive: now,
      request: null,
    });
    return { ok: true, claimed: true };
  });

  ipcMain.handle('bubble-lock:release', (_evt, bubbleId, opts) => {
    const force = Boolean(opts?.force);
    const ownId = getMachineId();
    const locks = readBubbleLocks();
    if (force || locks[bubbleId]?.owner === ownId) releaseBubbleLock(bubbleId);
    return { ok: true };
  });

  // Called every 3s by the owning machine to keep the lock fresh
  ipcMain.handle('bubble-lock:heartbeat', (_evt, bubbleId) => {
    const ownId = getMachineId();
    const locks = readBubbleLocks();
    const existing = locks[bubbleId];
    if (existing?.owner === ownId) {
      writeBubbleLock(bubbleId, { ...existing, lastActive: Date.now() });
    }
    return { ok: true };
  });

  // Called by the bubble owner to allow or deny a pending request
  ipcMain.handle('bubble-lock:respond', (_evt, bubbleId, allow) => {
    const ownId = getMachineId();
    const locks = readBubbleLocks();
    const existing = locks[bubbleId];
    if (!existing || existing.owner !== ownId) return { ok: false, error: 'not-owner' };
    const requester = existing.request?.from;
    if (!requester) return { ok: false, error: 'no-request' };

    if (allow) {
      // Transfer ownership to the requester
      writeBubbleLock(bubbleId, {
        owner: requester,
        bubbleName: existing.bubbleName,
        lastActive: Date.now(),
        request: null,
      });
    } else {
      // Mark as denied so the requester's watcher can react
      writeBubbleLock(bubbleId, {
        ...existing,
        request: { ...existing.request, status: 'denied' },
      });
    }
    return { ok: true };
  });
};

module.exports = { registerBubbleLocksIpc };
