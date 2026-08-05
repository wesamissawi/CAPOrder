// Conflict review + replicated-store diagnostics.
//
// A CRDT converges no matter what, so nothing here is needed to keep the data
// consistent. It exists because convergence is not the same as being right:
// when two counters genuinely raced the same part, one person's change was
// discarded to reach agreement, and only a human can judge whether that
// mattered. These handlers are how that gets in front of one.

function registerCrdtIpc(ipcMain, deps) {
  const { listCrdtConflicts, ackCrdtConflict, ackAllCrdtConflicts, getCrdtStats } = deps;

  ipcMain.handle('crdt:conflicts', () => {
    try {
      return { ok: true, conflicts: listCrdtConflicts() };
    } catch (e) {
      console.error('[crdt:conflicts] failed', e?.message || e);
      return { ok: false, error: e?.message || 'Failed to read conflicts', conflicts: [] };
    }
  });

  // Dismissing is itself a replicated write, so clearing a conflict on the
  // front counter clears it on every machine rather than leaving the next
  // person to re-examine something already dealt with.
  ipcMain.handle('crdt:ack-conflict', (_evt, id) => {
    try {
      ackCrdtConflict(id);
      return { ok: true, conflicts: listCrdtConflicts() };
    } catch (e) {
      console.error('[crdt:ack-conflict] failed', e?.message || e);
      return { ok: false, error: e?.message || 'Failed to dismiss conflict' };
    }
  });

  ipcMain.handle('crdt:ack-all-conflicts', () => {
    try {
      ackAllCrdtConflicts();
      return { ok: true, conflicts: listCrdtConflicts() };
    } catch (e) {
      console.error('[crdt:ack-all-conflicts] failed', e?.message || e);
      return { ok: false, error: e?.message || 'Failed to dismiss conflicts' };
    }
  });

  // Record counts, this machine's logical clock, and how far it has read each
  // machine's log. Mostly useful when someone reports "my screen doesn't match
  // theirs" — an offset stuck behind another machine's log is the tell.
  ipcMain.handle('crdt:stats', () => {
    try {
      return { ok: true, stats: getCrdtStats() };
    } catch (e) {
      return { ok: false, error: e?.message || 'Failed to read store stats' };
    }
  });
}

module.exports = { registerCrdtIpc };
