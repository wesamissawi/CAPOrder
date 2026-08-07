// Renderer half of cross-machine automation. The main process owns the files
// (main/services/automation.service.js); this owns the vocabulary — what the
// roles mean, how long a job may take, and where a given step should run.
//
// Jobs execute in the RENDERER, not in main, because the work they name already
// lives here: "fetch orders" is the Get All handler with all its order-patching
// and merging, "print" is the same silent-print pass the Print All button runs.
// Moving that into main would mean a second implementation of each, which is
// the one thing ghost mode exists to avoid. The cost is that a machine only
// does work for others while its app is open — the same condition ghost mode
// already has.

export const AUTOMATION_ROLES = ["fetch", "print", "sage"];

export const ROLE_LABELS = {
  fetch: "Vendor fetching (Playwright)",
  print: "Invoice printing",
  sage: "Sage entry (AutoHotkey)",
};

export const ROLE_HELP = {
  fetch: "Opens the vendor sites and pulls orders. Wants a machine nobody is sitting at — the browser windows steal focus while they run.",
  print: "Sends invoice PDFs to its own configured printer, so this should be the machine beside the printer you want them on.",
  sage: "Types purchase orders into Sage. Turning this on here switches that machine's “POs On” for it, and only one machine can hold it at a time.",
};

// How long the requester waits before deciding a job is never coming back. Per
// kind, because a six-vendor Playwright sweep and a print pass are not remotely
// the same length of wait.
export const JOB_TIMEOUT_MS = {
  "fetch-orders": 20 * 60 * 1000,
  "fetch-invoices": 15 * 60 * 1000,
  "print-invoices": 10 * 60 * 1000,
};

export const JOB_POLL_MS = 4 * 1000;
// How often a machine looks for work addressed to it. Slow on purpose: this
// polls a network share forever on every machine, and nothing here is urgent to
// the second.
export const JOB_CLAIM_POLL_MS = 6 * 1000;

export const JOB_LABELS = {
  "fetch-orders": "Fetching vendor orders",
  "fetch-invoices": "Checking Gmail for invoices",
  "print-invoices": "Printing invoices",
};

export function jobTimeoutMs(kind) {
  return JOB_TIMEOUT_MS[kind] || 10 * 60 * 1000;
}

// Where a step should run, given the current assignments and roster:
//
//   local   nobody is assigned (so the machine asking does it, which is how
//           ghost mode behaved before roles existed), or we are the assignee
//   remote  somebody else has the role and is online
//   offline somebody else has the role and is not here — the step is skipped
//           rather than quietly run somewhere it wasn't wanted, because "the
//           printer machine is off" must not mean "print on whatever machine
//           happened to notice".
export function resolveRoleTarget(roles, role, machines, ownMachineId) {
  const assigned = (roles?.[role] || "").toString().trim();
  if (!assigned || assigned === ownMachineId) {
    return { where: "local", machineId: ownMachineId || "" };
  }
  const entry = (machines || []).find((m) => m.machineId === assigned);
  if (!entry?.online) return { where: "offline", machineId: assigned };
  return { where: "remote", machineId: assigned };
}

export function isTerminalJob(job) {
  return job?.status === "done" || job?.status === "failed";
}

export function describeMachine(machine) {
  if (!machine) return "";
  const bits = [machine.machineId];
  if (machine.isSelf) bits.push("(this machine)");
  if (!machine.online) bits.push("- offline");
  return bits.join(" ");
}
