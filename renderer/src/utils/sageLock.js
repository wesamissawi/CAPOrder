// Per-order Sage lock, renderer side. Mirrors main/domain/orders.domain.js —
// keep SAGE_ORDER_LOCK_MAX_MS in step with it.
//
// An order is locked from the moment it is sent to Sage until the AHK run on
// whichever machine is driving Sage reports back. While locked the card is
// blurred and every edit is refused, so this window's copy of the order can
// never be written back over the result.
export const SAGE_ORDER_LOCK_MAX_MS = 30 * 60 * 1000;

// The lock is released by the order's own state, not only by something
// remembering to clear the `sage_lock` field. Any machine that finishes the work
// clears the trigger and marks the order entered — including a machine running
// an older build that has never heard of sage_lock — so that is what un-blurs
// the card. No Release click, no waiting for a timeout.
function sageWorkFinished(order) {
  const lock = order?.sage_lock;
  if (!lock || typeof lock !== "object") return true;
  if (lock.kind === "invoice") return order.sage_invoice_trigger !== true;
  if (lock.stage === "reconcile") {
    const processed = Date.parse(order.sage_processed_at || "");
    return Number.isFinite(processed) && processed >= Number(lock.startedAt || 0) - 5 * 60 * 1000;
  }
  return order.sage_trigger !== true && order.enteredInSage === true;
}

export function isOrderSageLocked(order) {
  const lock = order?.sage_lock;
  if (!lock || typeof lock !== "object") return false;
  if (sageWorkFinished(order)) return false;
  const stamp = Number(lock.heartbeatAt || lock.startedAt || 0);
  if (!Number.isFinite(stamp) || stamp <= 0) return false;
  return Date.now() - stamp < SAGE_ORDER_LOCK_MAX_MS;
}

// What the card shows while it is blurred.
export function sageLockLabel(order) {
  const lock = order?.sage_lock || {};
  const kind = lock.kind === "invoice" ? "invoice update" : "order";
  switch (lock.stage) {
    case "running":
      return `Entering ${kind} in Sage on ${lock.machineId || "another machine"}...`;
    case "reconcile":
      return "Adjusting totals in Sage...";
    default:
      return lock.lastError
        ? `Waiting to retry in Sage - last attempt failed`
        : `Queued for Sage${lock.machineId ? ` (from ${lock.machineId})` : ""}...`;
  }
}

// The renderer's order identity, matching main's orderIdentityKey/refKey.
export function orderKeyMatches(order, key) {
  if (!order || !key) return false;
  const target = String(key).trim().toUpperCase();
  const ref = order.reference ? String(order.reference).trim().toUpperCase() : "";
  const row = order.__row ? String(order.__row).trim().toUpperCase() : "";
  return (Boolean(ref) && ref === target) || (Boolean(row) && row === target);
}
