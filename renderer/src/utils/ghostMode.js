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
// Tiger's order pull is slow and its orders don't move much through the day, so
// it runs twice: once in the morning and once from noon, rather than on all 18
// cycles. Every other vendor still goes every cycle.
export const GHOST_TIGER_NOON_HOUR = 12;
// World sometimes emails an invoice for parts that were never scraped as an
// order (no conf number, a customer PO in the subject instead). Those become
// orders in their own right, so the check runs three times a day - morning,
// noon and mid-afternoon - which is what the user asked for and is plenty for
// mail that trickles in a few times a week.
export const GHOST_WORLD_PO_HOURS = [GHOST_START_HOUR, 12, 15];
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

// When the next cycle is due — the next :00/:30 inside working hours, rolling
// over to tomorrow morning after the last one of the day. Settings shows this so
// switching the toggle on answers "and then what?" by itself.
export function nextGhostCycleAt(date = new Date()) {
  const next = new Date(date.getTime());
  next.setSeconds(0, 0);
  // setMinutes(60) rolls the hour over for us.
  next.setMinutes(date.getMinutes() < 30 ? 30 : 60);
  if (next.getHours() < GHOST_START_HOUR) {
    next.setHours(GHOST_START_HOUR, 0, 0, 0);
  } else if (next.getHours() >= GHOST_END_HOUR) {
    next.setDate(next.getDate() + 1);
    next.setHours(GHOST_START_HOUR, 0, 0, 0);
  }
  return next;
}

// The BestBuy invoice check runs once a day, on the first cycle that actually
// gets going at or after noon — not strictly the 12:00 slot, so a noon cycle
// skipped because Sage was off (or this machine was busy) doesn't cost the day's
// check. `lastDayKey` is the day the last one ran on.
export function shouldFetchBestbuyInvoices(date = new Date(), lastDayKey = "") {
  if (date.getHours() < GHOST_BESTBUY_HOUR) return false;
  return ghostDayKey(date) !== lastDayKey;
}

// Which of the day's two Tiger slots a moment falls in: the morning one opens
// with ghost hours at 8:00 and the noon one at 12:00. Tiger runs on the first
// cycle inside each — same reasoning as BestBuy's daily check, so an 8:00 cycle
// skipped because nothing was ready doesn't cost the morning's pull.
export function ghostTigerSlot(date = new Date()) {
  const hour = date.getHours();
  if (hour >= GHOST_TIGER_NOON_HOUR) return "noon";
  if (hour >= GHOST_START_HOUR) return "morning";
  return "";
}

// The value to remember once a Tiger pull has run, and to compare against next
// time — day plus slot, so it runs again at noon but not twice in one slot.
export function ghostTigerRunKey(date = new Date()) {
  const slot = ghostTigerSlot(date);
  return slot ? `${ghostDayKey(date)}:${slot}` : "";
}

export function shouldFetchTigerOrders(date = new Date(), lastRunKey = "") {
  const key = ghostTigerRunKey(date);
  return Boolean(key) && key !== lastRunKey;
}

// Which of the day's three World-PO-invoice slots a moment falls in. Same
// first-cycle-in-the-slot rule as Tiger and BestBuy: a cycle skipped because
// Sage was off must not cost the day's check, so the slot stays open until a
// cycle actually runs inside it.
export function ghostWorldPoSlot(date = new Date()) {
  const hour = date.getHours();
  const open = GHOST_WORLD_PO_HOURS.filter((h) => hour >= h);
  return open.length ? String(open[open.length - 1]) : "";
}

export function ghostWorldPoRunKey(date = new Date()) {
  const slot = ghostWorldPoSlot(date);
  return slot ? `${ghostDayKey(date)}:${slot}` : "";
}

export function shouldFetchWorldPoInvoices(date = new Date(), lastRunKey = "") {
  const key = ghostWorldPoRunKey(date);
  return Boolean(key) && key !== lastRunKey;
}

// Whichever machine currently holds the live Sage purchase-order lock — this
// one or another. Ghost mode never types into Sage itself: it fills the queue
// and releases it, and the Sage machine (assigned by the `sage` automation
// role, enforced by the lock) does the typing. With nobody holding the lock the
// orders it sends would sit there triggered and the printing step would be
// working against orders nobody is entering, so a cycle with no Sage machine is
// no cycle at all. Takes the result of api.getSageLock().
export function sagePoMachine(lockRes) {
  if (!lockRes?.ok || !lockRes.lockIsLive) return "";
  return (lockRes.lock?.machineId || "").toString().trim();
}

// True when the Sage machine is somebody else — the Settings panel words itself
// differently for "GIRLSBOYS is doing the typing" vs "this machine is".
export function isForeignSageMachine(lockRes) {
  const owner = sagePoMachine(lockRes);
  const own = (lockRes?.ownMachineId || "").toString().trim();
  return Boolean(owner) && owner !== own;
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
//  - BestBuy is the exception to that rule: its invoices routinely land in
//    Gmail a day behind the order (see GHOST_BESTBUY_HOUR), so waiting on
//    source_invoice would strand every BestBuy order for a full cycle. It
//    sends on its order reference instead (sageStandardize's fallback), the
//    same "sent without the final invoice number" path the invoiceSageUpdate/
//    invoiceNeedsSync machinery already exists to correct once the real
//    invoice shows up.
//  - credits are left alone. They carry their own sign conventions and are
//    matched to a return requisition by hand in the Credits view first.
//  - a quantity discrepancy still blocks, exactly as it does on the card: that
//    gap is a question for a person, and the answer is usually to lower a
//    quantity, not to send it. But that check only has something to compare
//    against once billed_total is known, and for World/Transbec that arrives
//    from a separate Gmail step (fetch-invoices) that can land in a later
//    cycle than source_invoice did — so those two additionally wait for
//    billed_total itself before queueing, rather than being entered on the
//    original scraped total and only shown to be short after the fact, when
//    enteredInSage has already turned the discrepancy check off for good.
export function ghostSageQueueTargets(orders, { taxRate, threshold } = {}) {
  return (orders || []).filter((order) => {
    if (!order || !ghostOrderKey(order)) return false;
    if (order.enteredInSage === true) return false;
    const source = (order.source || "").toString().trim().toLowerCase();
    const isBestbuy = source === "bestbuy";
    if (!isBestbuy && !(order.source_invoice || "").toString().trim()) return false;
    if (source === "world" || source === "transbec") {
      const billedRaw = order.billed_total ?? order.billedTotal;
      const billedNum =
        billedRaw === null || billedRaw === undefined || billedRaw === "" ? NaN : Number(billedRaw);
      if (!Number.isFinite(billedNum)) return false;
    }
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
