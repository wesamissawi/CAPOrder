// Thin pass-throughs to automation.service.js. Every decision — what a valid
// job kind is, who may write which file, when a job is dead — lives in the
// service; this only shuttles it to the renderer, which is where the actual
// fetch/print handlers live.
const registerAutomationIpc = (ipcMain, deps) => {
  const { automation, getMachineId } = deps;

  const guard = (label, fn) => (...args) => {
    try {
      return fn(...args);
    } catch (e) {
      console.error(`[automation:${label}]`, e);
      return { ok: false, error: e?.message || 'Automation call failed.' };
    }
  };

  ipcMain.handle(
    'automation:machines',
    guard('machines', () => ({
      ok: true,
      machines: automation.listMachines(),
      ownMachineId: getMachineId(),
    }))
  );

  ipcMain.handle(
    'automation:get-roles',
    guard('get-roles', () => ({
      ok: true,
      roles: automation.readRoles(),
      ownMachineId: getMachineId(),
    }))
  );

  ipcMain.handle(
    'automation:set-roles',
    guard('set-roles', (_evt, partial) => {
      if (!partial || typeof partial !== 'object' || Array.isArray(partial)) {
        return { ok: false, error: 'Invalid roles payload.' };
      }
      return { ok: true, roles: automation.writeRoles(partial) };
    })
  );

  ipcMain.handle(
    'automation:create-job',
    guard('create-job', (_evt, payload = {}) =>
      automation.createJob({
        kind: payload.kind,
        payload: payload.payload,
        assignedTo: payload.assignedTo,
      })
    )
  );

  // What this machine has been asked to do. Polled by the renderer's job
  // runner; also purges dead jobs while it's here, so housekeeping happens
  // wherever the app is open rather than needing a nominated janitor.
  ipcMain.handle(
    'automation:claimable-jobs',
    guard('claimable-jobs', () => {
      automation.purgeJobs();
      return { ok: true, jobs: automation.claimableJobs() };
    })
  );

  ipcMain.handle('automation:read-job', guard('read-job', (_evt, id) => ({
    ok: true,
    job: automation.readJob(id),
  })));

  ipcMain.handle(
    'automation:update-job',
    guard('update-job', (_evt, id, patch) => automation.updateJob(id, patch))
  );

  ipcMain.handle('automation:delete-job', guard('delete-job', (_evt, id) => automation.deleteJob(id)));
};

module.exports = { registerAutomationIpc };
