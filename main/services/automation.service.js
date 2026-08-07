// Cross-machine automation: who is here, who does what, and the jobs they run
// for each other.
//
// Three separate concerns, one module because they share a folder and a notion
// of "machine":
//
//   presence/  one small file per machine, rewritten on a heartbeat. A machine
//              is online while its file is fresh. One file per writer means no
//              machine ever read-modify-writes a file another machine owns,
//              which over SMB is how entries get silently dropped.
//   roles.json who currently does the Playwright fetching, the printing, and
//              the Sage typing. Written by whoever is acting as ghost admin.
//   jobs/      one file per job, addressed to exactly one machine. The
//              requester writes it once; from then on only the assignee writes
//              it, so there is no claim race to arbitrate — the addressing IS
//              the claim.
//
// Deliberately NOT a request/response channel. A job is a fact on the share
// that a machine notices and acts on, exactly like `sage_trigger` on an order:
// nothing is lost if a machine is closed when the job appears, and nothing has
// to stay connected while it runs.

const AUTOMATION_DIR = 'automation';
const PRESENCE_DIR = 'presence';
const JOBS_DIR = 'jobs';
const ROLES_FILE = 'roles.json';

// A machine that hasn't written its presence file in this long is treated as
// gone. Three missed heartbeats — long enough to ride out an SMB hiccup, short
// enough that the roster isn't fiction.
const PRESENCE_HEARTBEAT_MS = 10 * 1000;
const PRESENCE_STALE_MS = 35 * 1000;

// Roles a machine can be given. `sage` is not implemented here — it is the
// existing PO heartbeat lock — but it is assigned here so all three are set in
// one place; the machine given the role turns its own PO toggle on (see the
// renderer's role-follower effect).
const ROLES = ['fetch', 'print', 'sage'];

// What a job may ask a machine to do. A job kind that isn't in this list is
// refused on both write and read, so a corrupt or hand-edited file on the share
// can never make a machine run something unexpected.
const JOB_KINDS = ['fetch-orders', 'fetch-invoices', 'print-invoices'];

// A job nobody has finished by now is dead — the machine was closed mid-run, or
// crashed. The requester stops waiting long before this; this is only so the
// folder doesn't fill up with corpses.
const JOB_STALE_MS = 30 * 60 * 1000;
const JOB_KEEP_FINISHED_MS = 5 * 60 * 1000;

const createAutomationService = (deps) => {
  const { fs, path, getSharedDataDir, getMachineId, ensureDir, getAppVersion, randomUUID } = deps;

  const automationDir = () => path.join(getSharedDataDir(), AUTOMATION_DIR);
  const presenceDir = () => path.join(automationDir(), PRESENCE_DIR);
  const jobsDir = () => path.join(automationDir(), JOBS_DIR);
  const rolesFile = () => path.join(automationDir(), ROLES_FILE);

  // A machine id is used as a file name, so it must not be able to escape the
  // folder it belongs in.
  const safeName = (value) => (value || '').toString().replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);

  function readJsonFile(file) {
    try {
      if (!fs.existsSync(file)) return null;
      return JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch (e) {
      console.error('[automation] unreadable', file, e?.message);
      return null;
    }
  }

  function writeJsonFile(file, data) {
    ensureDir(path.dirname(file));
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
  }

  // ---- presence -----------------------------------------------------------

  let presenceTimer = null;

  function publishPresence() {
    try {
      const id = getMachineId();
      writeJsonFile(path.join(presenceDir(), `${safeName(id)}.json`), {
        machineId: id,
        appVersion: getAppVersion?.() || '',
        heartbeatAt: Date.now(),
      });
      return { ok: true };
    } catch (e) {
      // A machine that can't reach the share is a machine nobody can give work
      // to, which is exactly what a missing presence file already says.
      console.error('[automation] presence write failed', e?.message);
      return { ok: false, error: e?.message || 'Failed to publish presence.' };
    }
  }

  function startPresenceHeartbeat() {
    stopPresenceHeartbeat();
    publishPresence();
    presenceTimer = setInterval(publishPresence, PRESENCE_HEARTBEAT_MS);
    if (presenceTimer.unref) presenceTimer.unref();
  }

  function stopPresenceHeartbeat() {
    if (presenceTimer) {
      clearInterval(presenceTimer);
      presenceTimer = null;
    }
  }

  function clearPresence() {
    try {
      const file = path.join(presenceDir(), `${safeName(getMachineId())}.json`);
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch (e) {
      console.error('[automation] presence clear failed', e?.message);
    }
  }

  function listMachines() {
    const dir = presenceDir();
    let names = [];
    try {
      ensureDir(dir);
      names = fs.readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.json'));
    } catch (e) {
      console.error('[automation] presence list failed', e?.message);
      return [];
    }
    const now = Date.now();
    const ownId = getMachineId();
    return names
      .map((name) => readJsonFile(path.join(dir, name)))
      .filter((entry) => entry && entry.machineId)
      .map((entry) => ({
        machineId: entry.machineId,
        appVersion: entry.appVersion || '',
        heartbeatAt: entry.heartbeatAt || 0,
        online: now - (entry.heartbeatAt || 0) < PRESENCE_STALE_MS,
        isSelf: entry.machineId === ownId,
      }))
      .sort((a, b) => a.machineId.localeCompare(b.machineId));
  }

  // Drop presence files for machines that have been gone a long time, so a
  // decommissioned computer doesn't sit in the roster forever. Anything still
  // running rewrites its file within one heartbeat.
  function purgePresence(maxAgeMs = 7 * 24 * 60 * 60 * 1000) {
    try {
      const dir = presenceDir();
      if (!fs.existsSync(dir)) return;
      const cutoff = Date.now() - maxAgeMs;
      fs.readdirSync(dir).forEach((name) => {
        const file = path.join(dir, name);
        const entry = readJsonFile(file);
        if (entry && (entry.heartbeatAt || 0) < cutoff) {
          try { fs.unlinkSync(file); } catch {}
        }
      });
    } catch (e) {
      console.error('[automation] presence purge failed', e?.message);
    }
  }

  // ---- roles --------------------------------------------------------------

  function normalizeRoles(raw = {}) {
    const out = { updatedAt: raw.updatedAt || '', updatedBy: raw.updatedBy || '' };
    ROLES.forEach((role) => {
      out[role] = typeof raw[role] === 'string' ? raw[role].trim() : '';
    });
    return out;
  }

  function readRoles() {
    return normalizeRoles(readJsonFile(rolesFile()) || {});
  }

  // Merged rather than replaced: the admin screen sets one dropdown at a time,
  // and two admins on two machines shouldn't be able to blank each other's
  // unrelated choices by saving a stale full copy.
  function writeRoles(partial) {
    const current = readRoles();
    const next = normalizeRoles({ ...current, ...(partial || {}) });
    next.updatedAt = new Date().toISOString();
    next.updatedBy = getMachineId();
    writeJsonFile(rolesFile(), next);
    return next;
  }

  // ---- jobs ---------------------------------------------------------------

  const jobFile = (id) => path.join(jobsDir(), `${safeName(id)}.json`);

  function readJob(id) {
    const job = readJsonFile(jobFile(id));
    return job && JOB_KINDS.includes(job.kind) ? job : null;
  }

  function createJob({ kind, payload, assignedTo }) {
    if (!JOB_KINDS.includes(kind)) {
      return { ok: false, error: `Unknown job kind: ${kind}` };
    }
    const target = (assignedTo || '').toString().trim();
    if (!target) return { ok: false, error: 'A job needs a machine to run it.' };
    const job = {
      id: randomUUID(),
      kind,
      payload: payload && typeof payload === 'object' ? payload : {},
      assignedTo: target,
      requestedBy: getMachineId(),
      requestedAt: Date.now(),
      status: 'queued',
      startedAt: 0,
      finishedAt: 0,
      result: null,
      error: '',
    };
    try {
      writeJsonFile(jobFile(job.id), job);
      return { ok: true, job };
    } catch (e) {
      console.error('[automation] job create failed', e?.message);
      return { ok: false, error: e?.message || 'Failed to write the job.' };
    }
  }

  function listJobs() {
    const dir = jobsDir();
    try {
      ensureDir(dir);
      return fs
        .readdirSync(dir)
        .filter((n) => n.toLowerCase().endsWith('.json'))
        .map((n) => readJsonFile(path.join(dir, n)))
        .filter((job) => job && job.id && JOB_KINDS.includes(job.kind));
    } catch (e) {
      console.error('[automation] job list failed', e?.message);
      return [];
    }
  }

  // The work this machine has been handed and hasn't started. Queued only —
  // a job already marked running belongs to a run in progress (or a dead one,
  // which purgeJobs fails rather than handing back out to be repeated).
  function claimableJobs() {
    const ownId = getMachineId();
    return listJobs()
      .filter((job) => job.assignedTo === ownId && job.status === 'queued')
      .sort((a, b) => (a.requestedAt || 0) - (b.requestedAt || 0));
  }

  function updateJob(id, patch) {
    const job = readJob(id);
    if (!job) return { ok: false, error: 'Job not found.' };
    const next = { ...job, ...(patch || {}), id: job.id, kind: job.kind };
    try {
      writeJsonFile(jobFile(id), next);
      return { ok: true, job: next };
    } catch (e) {
      console.error('[automation] job update failed', e?.message);
      return { ok: false, error: e?.message || 'Failed to update the job.' };
    }
  }

  function deleteJob(id) {
    try {
      const file = jobFile(id);
      if (fs.existsSync(file)) fs.unlinkSync(file);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e?.message || 'Failed to delete the job.' };
    }
  }

  // Housekeeping, run on a timer by whoever is around: finished jobs are
  // removed once the requester has had time to read the result, and a job left
  // running by a machine that died is marked failed so the requester stops
  // waiting on it and a later cycle can try again.
  function purgeJobs() {
    const now = Date.now();
    listJobs().forEach((job) => {
      const terminal = job.status === 'done' || job.status === 'failed';
      if (terminal && now - (job.finishedAt || job.requestedAt || 0) > JOB_KEEP_FINISHED_MS) {
        deleteJob(job.id);
        return;
      }
      if (!terminal && now - (job.startedAt || job.requestedAt || 0) > JOB_STALE_MS) {
        updateJob(job.id, {
          status: 'failed',
          finishedAt: now,
          error: 'The machine running this job stopped responding.',
        });
      }
    });
  }

  return {
    ROLES,
    JOB_KINDS,
    PRESENCE_HEARTBEAT_MS,
    PRESENCE_STALE_MS,
    publishPresence,
    startPresenceHeartbeat,
    stopPresenceHeartbeat,
    clearPresence,
    listMachines,
    purgePresence,
    readRoles,
    writeRoles,
    createJob,
    readJob,
    listJobs,
    claimableJobs,
    updateJob,
    deleteJob,
    purgeJobs,
  };
};

module.exports = { createAutomationService };
