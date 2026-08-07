// Ghost mode: the Order Management routine somebody would otherwise click
// through every half hour — fetch every vendor, pull the World/Transbec
// invoices out of Gmail, push whatever is now complete into Sage, print the
// bills that have not been printed yet — run unattended on a wall-clock
// schedule.
//
// This file holds only the decisions (when to run, and what each step is
// allowed to touch). The steps themselves are the very same handlers the
// buttons call, so there is exactly one implementation of each.
import { isOrderSageLocked } from "./sageLock";
import { getOrderQtyDiscrepancy, looksLikeCredit } from "./qtyDiscrepancy";

export const GHOST_START_HOUR = 8; // first cycle at 08:00
export const GHOST_END_HOUR = 17; // last cycle at 16:30 — nothing starts at/after 17:00
export const GHOST_TICK_MS = 60 * 1000;
// BestBuy emails the day's invoices the NEXT day, so checking every half hour
// is 17 wasted Gmail runs. Once a day, from noon, is enough.
export const GHOST_BESTBUY_HOUR = 12;
// How long a cycle will wait for the Sage machine to work through the queue it
// just released before giving up on printing (printing is what waits — see
// runGhostCycle). Long enough for a full queue of AHK runs, short enough that a
// wedged Sage machine doesn't hold a cycle open all afternoon.
export const GHOST_SAGE_WAIT_MS = 15 * 60 * 1000;
export const GHOST_SAGE_POLL_MS = 20 * 1000;

// The half-hour the given moment falls in, as a value that changes exactly when
// a cycle is due. The schedule is driven by comparing this against the last one
// seen rather than by a 30-minute timer, so it stays pinned to :00/:30 no matter
// how long a cycle runs, when the machine sleeps, or how far setInterval drifts.
export function ghostSlotKey(date = new Date()) {
  const half = date.getMinutes() < 30 ? "00" : "30";
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}T${date.getHours()}:${half}`;
}

export function isWithinGhostHours(date = new Date()) {
  const hour = date.getHours();
  return hour >= GHOST_START_HOUR && hour < GHOST_END_HOUR;
}

export function ghostDayKey(date = new Date()) {
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

// The BestBuy invoice check runs once a day, on the first cycle that actually
// gets going at or after noon — not strictly the 12:00 slot, so a noon cycle
// skipped because Sage was off (or this machine was busy) doesn't cost the day's
// check. `lastDayKey` is the day the last one ran on.
export function shouldFetchBestbuyInvoices(date = new Date(), lastDayKey = "") {
  if (date.getHours() < GHOST_BESTBUY_HOUR) return false;
  return ghostDayKey(date) !== lastDayKey;
}

// The machine currently holding the Sage purchase-order lock, if it is somebody
// else. Ghost mode never types into Sage itself — it fills the queue and
// releases it — so with no other machine running Sage the orders it sends would
// just sit there triggered, and the printing step would be working against
// orders nobody is entering. Takes the result of api.getSageLock().
export function foreignSagePoMachine(lockRes) {
  if (!lockRes?.ok || !lockRes.lockIsLive) return "";
  const owner = (lockRes.lock?.machineId || "").toString().trim();
  const own = (lockRes.ownMachineId || "").toString().trim();
  if (!owner || owner === own) return "";
  return owner;
}

// The key sage:trigger-order resolves an order by — the same one the card's
// own "Add to Sage Queue" button passes.
export function ghostOrderKey(order) {
  return (order?.reference || order?.__row || "").toString().trim();
}

const normalizeKey = (key) => (key || "").toString().trim().toUpperCase();

// Everything sitting in either Sage waiting room right now. Read just before
// "Send to Sage" is pressed, this is exactly the set that press releases — which
// is what the printing step then waits on. It deliberately includes orders
// somebody queued by hand and never sent: releasing the queue releases those
// too, so the cycle has to wait for them as well.
export function ghostQueuedKeys(orders) {
  return (orders || [])
    .filter((o) => o && (o.sage_queued === true || o.sage_invoice_queued === true))
    .map((o) => normalizeKey(ghostOrderKey(o)))
    .filter(Boolean);
}

// How many of those orders Sage still owes an answer on. An order is done when
// it comes back entered; one whose AHK run failed keeps its trigger and is
// retried by the Sage machine, so it stays counted here until it succeeds or
// the wait times out — the cycle must not print a bill for an order that never
// made it into Sage.
export function ghostSagePendingCount(orders, keys) {
  const wanted = new Set((keys || []).map(normalizeKey).filter(Boolean));
  if (!wanted.size) return 0;
  return (orders || []).filter((o) => {
    if (!o || !wanted.has(normalizeKey(ghostOrderKey(o)))) return false;
    if (o.sage_invoice_trigger === true) return true;
    return o.sage_trigger === true && o.enteredInSage !== true;
  }).length;
}

// Orders ghost mode may put in the Sage queue. Deliberately narrower than the
// card's "Add to Sage Queue" button, because nobody is looking at the screen:
//
//  - an invoice number is required. The button allows an order without one (a
//    person can see that they are entering it deliberately); unattended, an
//    order scraped minutes ago whose invoice has not arrived yet would be typed
//    into Sage with a blank reference.
//  - credits are left alone. They carry their own sign conventions and are
//    matched to a return requisition by hand in the Credits view first.
//  - a quantity discrepancy still blocks, exactly as it does on the card: that
//    gap is a question for a person, and the answer is usually to lower a
//    quantity, not to send it.
export function ghostSageQueueTargets(orders, { taxRate, threshold } = {}) {
  return (orders || []).filter((order) => {
    if (!order || !ghostOrderKey(order)) return false;
    if (order.enteredInSage === true) return false;
    if (!(order.source_invoice || "").toString().trim()) return false;
    if (looksLikeCredit(order)) return false;
    // Already on its way, in either waiting room — queueing it again is a no-op
    // at best and a double entry at worst.
    if (order.sage_queued || order.sage_trigger) return false;
    if (order.sage_invoice_queued || order.sage_invoice_trigger) return false;
    if (isOrderSageLocked(order)) return false;
    const qty = getOrderQtyDiscrepancy(order, taxRate, threshold);
    if (qty?.overThreshold) return false;
    return true;
  });
}

// Transbec and BestBuy bills that exist on disk and have never been printed.
// World invoices are never printed — they don't have to be printed before
// archiving — and neither are the credit PDFs, which belong to the credit flow
// rather than the purchase one.
//
// The cycle has already waited for Sage to drain the queue by the time this
// runs, so the exclusion below normally catches nothing. It stays as a backstop
// for an order still in flight anyway (a failed AHK run being retried, or work
// released from another machine mid-cycle): while an order is locked by a Sage
// run every write to it is refused, so recording "printed" would silently fail
// and the same paper would come out again next cycle.
export function ghostPrintTargets(orders) {
  const targets = [];
  (orders || []).forEach((order) => {
    if (!order || !ghostOrderKey(order)) return;
    if (order.sage_trigger || order.sage_invoice_trigger || isOrderSageLocked(order)) return;
    if ((order.transbecInvoiceFile || order.transbecInvoiceImage) && !order.transbecInvoicePrinted) {
      targets.push({ order, vendor: "transbec" });
    }
    if (order.bestbuyInvoiceFile && !order.bestbuyInvoicePrinted) {
      targets.push({ order, vendor: "bestbuy" });
    }
  });
  return targets;
}
