import React, { useEffect, useMemo, useState } from "react";
import api from "../api";
import Card from "../components/Card";
import CloverImportModal from "../components/CloverImportModal";

// Every type a payment can be created or corrected to.
const PAYMENT_TYPES = ["Interac", "VISA", "MasterCard", "E-Transfer"];
// The card types that get a per-date subtotal tile and quick-add box at the
// bottom of each day. E-Transfers arrive one at a time and aren't part of a
// terminal batch you reconcile against, so they're added at the top only.
const QUICK_ADD_TYPES = ["Interac", "VISA", "MasterCard"];

// Matched loosely so "E-Transfer", "e transfer" and "etransfer" all count —
// the same rule the Payment summary uses to bucket them.
const isETransfer = (type) => /e[-\s]?transfer/i.test(String(type || ""));

const getTodayDateString = () => new Date().toISOString().slice(0, 10);
// Sum of a set of payments. Non-numeric amounts contribute nothing rather than
// turning the whole total into NaN.
const sumAmounts = (list) =>
  (list || []).reduce((sum, p) => {
    const amt = Number(p?.amount);
    return Number.isFinite(amt) ? sum + amt : sum;
  }, 0);
const toInputMoney = (val) => {
  if (val === null || val === undefined || val === "") return "";
  const num = Number(val);
  if (!Number.isFinite(num)) return "";
  return num.toFixed(2);
};

// Has this payment already been spent on a sale, and if so which one?
//
// Two sources because a cash sale loses its live payment link the moment it's
// archived: `saleNameByPaymentId` covers sales still open, the archive lookup
// covers the ones that are done. Without the second half every payment older
// than today's work would read "Unassigned" and invite a double-assign.
function assignmentOf(payment, liveNames, archivedUsage) {
  const paymentId = payment?.id;
  if (!paymentId) return null;
  // Recorded wins over everything: it's stamped onto the payment itself when
  // the sale is archived, so it survives the bubble going away and doesn't
  // depend on the archive lookup below succeeding.
  if (payment?.recordedInSage) {
    return {
      name: payment.recordedForSale || "a Sage invoice",
      recorded: true,
      invoice: payment.sageInvoiceNumber || "",
      at: payment.recordedAt || "",
    };
  }
  const live = liveNames?.[paymentId];
  if (live) return { name: live, archived: false };
  const past = archivedUsage?.[paymentId];
  if (past) return { name: past.bubbleName || "an archived sale", archived: true };
  return null;
}

function AssignmentBadge({ assignment }) {
  if (assignment?.recorded) {
    return (
      <span
        className="inline-flex w-fit max-w-full items-center gap-1 rounded-full border border-violet-200 bg-violet-50 px-2 py-0.5 text-[11px] font-semibold text-violet-700"
        title={`Recorded in Sage against "${assignment.name}"${
          assignment.invoice ? ` — invoice ${assignment.invoice}` : ""
        }${assignment.at ? ` on ${new Date(assignment.at).toLocaleString()}` : ""}`}
      >
        <span className="shrink-0">In Sage</span>
        <span className="truncate font-normal opacity-80">
          {assignment.invoice || assignment.name}
        </span>
      </span>
    );
  }
  if (!assignment) {
    return (
      <span className="inline-flex w-fit items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-800">
        Unassigned
      </span>
    );
  }
  const cls = assignment.archived
    ? "border-slate-200 bg-slate-100 text-slate-600"
    : "border-emerald-200 bg-emerald-50 text-emerald-700";
  return (
    <span
      className={`inline-flex w-fit max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${cls}`}
      title={
        assignment.archived
          ? `Already used by "${assignment.name}", which has been archived`
          : `Assigned to "${assignment.name}"`
      }
    >
      <span className="shrink-0">{assignment.archived ? "Archived" : "Assigned"}</span>
      <span className="truncate font-normal opacity-80">{assignment.name}</span>
    </span>
  );
}

export default function PaymentManagementView({ currentViewMeta, saleNameByPaymentId = {} }) {
  const [payments, setPayments] = useState([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [paymentsPath, setPaymentsPath] = useState("");
  const [drafts, setDrafts] = useState(() =>
    PAYMENT_TYPES.reduce((acc, t) => {
      acc[t] = { amount: "", date: getTodayDateString(), note: "" };
      return acc;
    }, {})
  );
  const [editingId, setEditingId] = useState(null);
  const [editAmount, setEditAmount] = useState("");
  const [editDate, setEditDate] = useState("");
  const [editType, setEditType] = useState(PAYMENT_TYPES[0]);
  const [editNote, setEditNote] = useState("");
  // Sage state now lives behind Save too, so a stray click can't silently
  // change whether money is booked.
  const [editRecorded, setEditRecorded] = useState(false);
  const [editInvoice, setEditInvoice] = useState("");
  const [quickAddAmounts, setQuickAddAmounts] = useState({});
  const [showCloverImport, setShowCloverImport] = useState(false);
  // paymentId -> { bubbleName, archivedAt } for sales that are already done.
  const [archivedUsage, setArchivedUsage] = useState({});
  const [purgeDays, setPurgeDays] = useState(30);

  useEffect(() => {
    let cancelled = false;
    async function loadPayments() {
      try {
        setLoading(true);
        setError("");
        const res = await api.getPaymentsPath?.();
        if (!cancelled && res?.path) setPaymentsPath(res.path);
        const list = await api.readPayments();
        if (cancelled) return;
        setPayments(Array.isArray(list) ? list : []);
        // Failing to read the archive must not take the whole view down —
        // the badges just fall back to what the live state knows.
        try {
          const usage = await api.getArchivedPaymentUsage?.();
          if (!cancelled && usage?.ok) setArchivedUsage(usage.usage || {});
        } catch (archiveErr) {
          console.warn("[payments] archived usage lookup failed", archiveErr);
        }
      } catch (e) {
        if (cancelled) return;
        setError(e?.message || "Failed to load payments.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    loadPayments();
    return () => {
      cancelled = true;
    };
  }, []);

  const sortedPayments = useMemo(() => {
    const list = Array.isArray(payments) ? payments : [];
    return [...list].sort((a, b) => {
      const da = new Date(a?.date || a?.createdAt || 0).getTime();
      const db = new Date(b?.date || b?.createdAt || 0).getTime();
      if (Number.isNaN(da) && Number.isNaN(db)) return 0;
      if (Number.isNaN(da)) return 1;
      if (Number.isNaN(db)) return -1;
      return db - da;
    });
  }, [payments]);

  const unassignedPayments = useMemo(
    () =>
      sortedPayments.filter((p) => !assignmentOf(p, saleNameByPaymentId, archivedUsage)),
    [sortedPayments, saleNameByPaymentId, archivedUsage]
  );

  // Payments whose sale has been archived into Sage. They stay so the totals
  // still reconcile against a bank deposit; the purge below is how they go.
  const recordedPayments = useMemo(
    () => sortedPayments.filter((p) => p?.recordedInSage),
    [sortedPayments]
  );

  const paymentsByDate = useMemo(() => {
    const map = new Map();
    sortedPayments.forEach((payment) => {
      const key = (payment?.date || "No date").toString();
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(payment);
    });
    return Array.from(map.entries());
  }, [sortedPayments]);

  async function handleAddPayment(paymentType) {
    const draft = drafts[paymentType] || { amount: "", date: "", note: "" };
    const amt = Number(draft.amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      setError("Enter a valid payment amount.");
      return;
    }
    if (!draft.date) {
      setError("Choose a payment date.");
      return;
    }
    setError("");
    const id = `pay_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const payment = {
      id,
      amount: Number(amt.toFixed(2)),
      date: draft.date,
      type: paymentType,
      note: draft.note.trim() || "",
      createdAt: new Date().toISOString(),
    };
    const next = [payment, ...(payments || [])];
    setSaving(true);
    try {
      await api.writePayments(next);
      setPayments(next);
      setDrafts((prev) => ({
        ...prev,
        [paymentType]: {
          amount: "",
          date: getTodayDateString(),
          note: "",
        },
      }));
    } catch (e) {
      setError(e?.message || "Failed to save payment.");
    } finally {
      setSaving(false);
    }
  }

  function startEdit(payment) {
    if (!payment?.id) return;
    setError("");
    setEditingId(payment.id);
    setEditAmount(toInputMoney(payment.amount));
    setEditDate(payment.date || "");
    setEditType(payment.type || PAYMENT_TYPES[0]);
    setEditNote(payment.note || "");
    setEditRecorded(payment.recordedInSage === true);
    setEditInvoice(payment.sageInvoiceNumber || "");
  }

  function cancelEdit() {
    setEditingId(null);
    setEditAmount("");
    setEditDate("");
    setEditType(PAYMENT_TYPES[0]);
    setEditNote("");
    setEditRecorded(false);
    setEditInvoice("");
  }

  async function handleSaveEdit(paymentId) {
    const amt = Number(editAmount);
    if (!Number.isFinite(amt) || amt <= 0) {
      setError("Enter a valid payment amount.");
      return;
    }
    if (!editDate) {
      setError("Choose a payment date.");
      return;
    }
    if (!editType) {
      setError("Missing payment type.");
      return;
    }
    setError("");
    const payment = (payments || []).find((p) => p?.id === paymentId);
    if (!payment) {
      setError("That payment no longer exists.");
      return;
    }

    const amount = Number(amt.toFixed(2));
    const note = editNote.trim() || "";
    const invoice = editInvoice.trim();

    setSaving(true);
    try {
      // Keep the Sage-run row in step with what's being saved.
      //
      // `sageRunId` on a payment ALWAYS means a row this payment created by
      // being marked here — archiving a sale records the payment without one.
      // So this only ever touches its own row and can never disturb the record
      // of a real AHK run.
      let runId = payment.sageRunId || "";
      const snapshotChanged =
        amount !== (Number(payment.amount) || 0) ||
        editDate !== (payment.date || "") ||
        editType !== (payment.type || "") ||
        note !== (payment.note || "");

      if (!editRecorded && runId) {
        const res = await api.deleteSageRun(runId);
        if (res?.ok === false) console.warn("[payments] run row not removed", res.error);
        runId = "";
      } else if (editRecorded) {
        // Rebuilt rather than patched when the money itself changed: the row
        // snapshots the payment, so an edited amount or date has to reach the
        // report or the printed summary would still show the old figure.
        if (runId && snapshotChanged) {
          await api.deleteSageRun(runId).catch(() => {});
          runId = "";
        }
        if (!runId) {
          const logged = await api.appendSageRun({
            manual: true,
            saleName: "",
            sageInvoiceNumber: invoice,
            itemCount: 0,
            saleTotal: 0,
            payments: [
              { id: payment.id, amount, date: editDate, time: payment.time || "", note, type: editType },
            ],
          });
          if (logged?.ok) runId = logged.run?.id || "";
          else setError(logged?.error || "Saved, but it could not be added to the report.");
        } else if (invoice !== (payment.sageInvoiceNumber || "")) {
          const res = await api.setSageRunInvoice({ id: runId, sageInvoiceNumber: invoice });
          if (res?.ok === false) console.warn("[payments] run invoice not updated", res.error);
        }
      }

      const next = (payments || []).map((p) =>
        p?.id === paymentId
          ? {
              ...p,
              amount,
              date: editDate,
              type: editType,
              note,
              recordedInSage: editRecorded,
              recordedAt: editRecorded ? p.recordedAt || new Date().toISOString() : "",
              sageInvoiceNumber: invoice,
              sageRunId: runId,
              updatedAt: new Date().toISOString(),
            }
          : p
      );
      await api.writePayments(next);
      setPayments(next);
      cancelEdit();
    } catch (e) {
      setError(e?.message || "Failed to save payment.");
    } finally {
      setSaving(false);
    }
  }

  async function handleDeletePayment(paymentId) {
    const next = (payments || []).filter((p) => p?.id !== paymentId);
    setSaving(true);
    setError("");
    try {
      await api.writePayments(next);
      setPayments(next);
      if (editingId === paymentId) cancelEdit();
    } catch (e) {
      setError(e?.message || "Failed to delete payment.");
    } finally {
      setSaving(false);
    }
  }

  async function handleQuickAddPayment(dateKey, paymentType) {
    const amountKey = `${dateKey}__${paymentType}`;
    const rawAmount = quickAddAmounts[amountKey] ?? "";
    const amt = Number(rawAmount);
    if (!Number.isFinite(amt) || amt <= 0) {
      setError("Enter a valid payment amount.");
      return;
    }
    if (!dateKey) {
      setError("Missing payment date.");
      return;
    }
    setError("");
    const id = `pay_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const payment = {
      id,
      amount: Number(amt.toFixed(2)),
      date: dateKey,
      type: paymentType,
      note: "",
      createdAt: new Date().toISOString(),
    };
    const next = [payment, ...(payments || [])];
    setSaving(true);
    try {
      await api.writePayments(next);
      setPayments(next);
      setQuickAddAmounts((prev) => ({ ...prev, [amountKey]: "" }));
    } catch (e) {
      setError(e?.message || "Failed to save payment.");
    } finally {
      setSaving(false);
    }
  }

  // Clearing out payments that have already made it into Sage. Deliberately
  // manual and age-gated rather than automatic on archive: once these are gone
  // the only record of the money is the Sage run log, so the moment they go
  // should be a decision, taken after the books for that period are settled.
  async function handlePurgeRecorded() {
    const cutoff = Date.now() - Math.max(0, Number(purgeDays) || 0) * 86400000;
    const doomed = recordedPayments.filter((p) => {
      const t = Date.parse(p?.recordedAt || p?.date || "");
      return Number.isFinite(t) && t < cutoff;
    });
    if (!doomed.length) {
      setError(`No payments recorded in Sage more than ${purgeDays} days ago.`);
      return;
    }
    const ok = window.confirm(
      `Delete ${doomed.length} payment${doomed.length === 1 ? "" : "s"} recorded in Sage more than ${purgeDays} days ago?\n\n` +
        `Total $${sumAmounts(doomed).toFixed(2)}.\n\n` +
        `They're already invoiced — the Sage Runs report keeps the amount, date, type and invoice number. This can't be undone.`
    );
    if (!ok) return;
    const doomedIds = new Set(doomed.map((p) => p.id));
    const next = (payments || []).filter((p) => !doomedIds.has(p?.id));
    setSaving(true);
    setError("");
    try {
      await api.writePayments(next);
      setPayments(next);
    } catch (e) {
      setError(e?.message || "Failed to clear recorded payments.");
    } finally {
      setSaving(false);
    }
  }

  // The CSV import writes payments.json in the main process (it also has to
  // update the import ledger in the same step), so this just re-reads the file
  // rather than merging anything itself.
  async function reloadPayments() {
    try {
      const list = await api.readPayments();
      setPayments(Array.isArray(list) ? list : []);
    } catch (e) {
      setError(e?.message || "Imported, but reloading payments failed. Reopen this view.");
    }
  }

  return (
    <section className="space-y-4">
      <Card>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-xl font-semibold text-slate-700">
              {currentViewMeta?.label || "Payment Management"}
            </p>
            <p className="text-sm text-slate-500">
              Add payments and track them in `payments.json`.
            </p>
          </div>
          <div className="flex flex-col items-start gap-2 sm:items-end">
            <button
              type="button"
              onClick={() => setShowCloverImport(true)}
              className="px-4 py-2 rounded-xl bg-emerald-600 text-white text-xs font-semibold hover:bg-emerald-700"
              title="Reads a Clover payments CSV export you downloaded, and adds anything not imported before."
            >
              Import Clover CSV
            </button>
            {paymentsPath && (
              <div className="text-xs text-slate-400">
                File: <code className="text-indigo-600 break-all">{paymentsPath}</code>
              </div>
            )}
          </div>
        </div>
      </Card>

      {showCloverImport && (
        <CloverImportModal
          onClose={() => setShowCloverImport(false)}
          onImported={reloadPayments}
        />
      )}

      {error && (
        <Card>
          <div className="rounded-xl bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">
            {error}
          </div>
        </Card>
      )}

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {PAYMENT_TYPES.map((paymentType) => {
          const draft = drafts[paymentType] || { amount: "", date: "", note: "" };
          return (
            <div
              key={paymentType}
              className="rounded-2xl border border-slate-200 bg-white/80 p-3 flex flex-col gap-3 max-w-md"
            >
              <div className="text-sm font-semibold text-slate-700">{paymentType}</div>
              <label className="flex flex-col gap-1 text-xs text-slate-600">
                Amount
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={draft.amount}
                  onChange={(e) =>
                    setDrafts((prev) => ({
                      ...prev,
                      [paymentType]: { ...draft, amount: e.target.value },
                    }))
                  }
                  className="w-full border rounded-xl px-3 py-2 text-sm bg-white"
                  placeholder="0.00"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-slate-600">
                Date
                <input
                  type="date"
                  value={draft.date}
                  onChange={(e) =>
                    setDrafts((prev) => ({
                      ...prev,
                      [paymentType]: { ...draft, date: e.target.value },
                    }))
                  }
                  className="w-full border rounded-xl px-3 py-2 text-sm bg-white"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-slate-600">
                Note (optional)
                <input
                  type="text"
                  value={draft.note}
                  onChange={(e) =>
                    setDrafts((prev) => ({
                      ...prev,
                      [paymentType]: { ...draft, note: e.target.value },
                    }))
                  }
                  className="w-full border rounded-xl px-3 py-2 text-sm bg-white"
                  placeholder="e.g., partial payment"
                />
              </label>
              <button
                type="button"
                onClick={() => handleAddPayment(paymentType)}
                disabled={saving}
                className="px-4 py-2 rounded-xl bg-indigo-600 text-white text-xs font-semibold disabled:opacity-50"
              >
                {saving ? "Saving..." : `Add ${paymentType}`}
              </button>
            </div>
          );
        })}
      </div>

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-lg font-semibold text-slate-800">Payments</p>
          <div className="flex flex-wrap items-baseline gap-2">
            {/* What's still waiting to be matched to a sale — the number you
                actually act on, so it leads. */}
            {unassignedPayments.length > 0 && (
              <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-800">
                {unassignedPayments.length} unassigned · $
                {sumAmounts(unassignedPayments).toFixed(2)}
              </span>
            )}
            <span className="text-xs text-slate-500">
              {sortedPayments.length} total
            </span>
            <span className="text-base font-semibold text-slate-800">
              ${sumAmounts(sortedPayments).toFixed(2)}
            </span>
          </div>
        </div>

        {recordedPayments.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3">
            <span className="rounded-full border border-violet-200 bg-violet-50 px-2 py-0.5 text-xs font-semibold text-violet-700">
              {recordedPayments.length} in Sage · ${sumAmounts(recordedPayments).toFixed(2)}
            </span>
            <span className="text-xs text-slate-500">clear the ones recorded more than</span>
            <select
              value={purgeDays}
              onChange={(e) => setPurgeDays(Number(e.target.value))}
              className="rounded-lg border border-slate-200 px-2 py-1 text-xs"
            >
              <option value={7}>7 days</option>
              <option value={30}>30 days</option>
              <option value={60}>60 days</option>
              <option value={90}>90 days</option>
              <option value={180}>180 days</option>
              <option value={365}>1 year</option>
            </select>
            <span className="text-xs text-slate-500">ago</span>
            <button
              type="button"
              onClick={handlePurgeRecorded}
              disabled={saving}
              className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-800 hover:bg-amber-100 disabled:opacity-50"
              title="Delete payments already invoiced into Sage. The Sage Runs report keeps their details."
            >
              Clear recorded
            </button>
          </div>
        )}
      </Card>

      {loading ? (
        <Card>
          <div className="py-8 text-center text-slate-500">Loading payments...</div>
        </Card>
      ) : sortedPayments.length === 0 ? (
        <Card>
          <div className="py-8 text-center text-slate-500">No payments yet.</div>
        </Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {paymentsByDate.map(([dateKey, list]) => (
            // `relative` + a raised z-index while this card holds the row being
            // edited. Grid siblings paint in DOM order, so without it the next
            // payment card draws over the wider edit bar and swallows its
            // right-hand fields. bg-white (not /80) for the same reason — a
            // translucent card lets whatever is behind it show through the form.
            <div
              key={dateKey}
              className={`rounded-2xl border border-slate-200 p-4 h-full ${
                list.some((p) => p?.id === editingId)
                  ? "relative z-30 bg-white shadow-lg"
                  : "bg-white/80"
              }`}
            >
              <div className="flex items-center justify-between">
                <div className="text-base font-semibold text-slate-800">{dateKey}</div>
                <div className="flex items-baseline gap-2 text-xs text-slate-500">
                  <span>
                    {list.length} payment{list.length === 1 ? "" : "s"}
                  </span>
                  {/* E-transfers are split out of the headline figure. Cards
                      settle as a terminal batch you reconcile in one go;
                      e-transfers land in the bank one at a time, so mixing them
                      into a single number makes neither reconcilable. The two
                      shown here still cover EVERY payment on the card — an
                      unknown type falls in with the cards — so they always add
                      up to the day's takings. */}
                  <span
                    className="text-sm font-semibold text-slate-700"
                    title="Card payments (Interac, Visa, MasterCard)"
                  >
                    ${sumAmounts(list.filter((p) => !isETransfer(p?.type))).toFixed(2)}
                  </span>
                  {list.some((p) => isETransfer(p?.type)) && (
                    <span
                      className="rounded-full border border-sky-200 bg-sky-50 px-1.5 py-0.5 text-[11px] font-semibold text-sky-700"
                      title="E-Transfers on this date"
                    >
                      E-T ${sumAmounts(list.filter((p) => isETransfer(p?.type))).toFixed(2)}
                    </span>
                  )}
                </div>
              </div>
              <div className="mt-3 grid gap-2">
                {list.map((payment) => (
                  <div
                    key={payment.id || `${payment.type}-${payment.date}-${payment.amount}`}
                    className="flex flex-col gap-2 rounded-2xl border border-slate-200 bg-white/90 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
                  >
                    {editingId === payment.id ? (
                      <div className="flex min-w-0 flex-1 flex-col gap-3">
                        {/* Wraps rather than running off the edge: five fixed-
                            width fields don't fit one line in a grid column. */}
                        <div className="flex flex-wrap items-end gap-2">
                          <label className="flex flex-col gap-1 text-xs text-slate-600">
                            Amount
                            <input
                              type="number"
                              min="0"
                              step="0.01"
                              value={editAmount}
                              onChange={(e) => setEditAmount(e.target.value)}
                              className="w-full sm:w-32 border rounded-xl px-3 py-2 text-sm bg-white"
                            />
                          </label>
                          <label className="flex flex-col gap-1 text-xs text-slate-600">
                            Date
                            <input
                              type="date"
                              value={editDate}
                              onChange={(e) => setEditDate(e.target.value)}
                              className="w-full sm:w-40 border rounded-xl px-3 py-2 text-sm bg-white"
                            />
                          </label>
                          {/* Editable because a Clover import can land with
                              type "Unknown" when the detail page didn't say
                              whether it was Visa or Mastercard — without this
                              there'd be no way to correct it short of deleting
                              the payment and retyping it. */}
                          <label className="flex flex-col gap-1 text-xs text-slate-600">
                            Type
                            <select
                              value={editType}
                              onChange={(e) => setEditType(e.target.value)}
                              className="w-full sm:w-40 border rounded-xl px-3 py-2 text-sm bg-white"
                            >
                              {!PAYMENT_TYPES.includes(editType) && (
                                <option value={editType}>{editType || "Unknown"}</option>
                              )}
                              {PAYMENT_TYPES.map((t) => (
                                <option key={t} value={t}>
                                  {t}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label className="flex flex-col gap-1 text-xs text-slate-600">
                            Note
                            <input
                              type="text"
                              value={editNote}
                              onChange={(e) => setEditNote(e.target.value)}
                              className="w-full sm:w-56 border rounded-xl px-3 py-2 text-sm bg-white"
                            />
                          </label>
                          {/* Behind Save like everything else here. Ticking
                              this is what keeps Auto-fill from building a cash
                              sale for money already entered, AND what puts the
                              payment on the Payment summary — no send to Sage
                              involved. */}
                          <div className="flex flex-col gap-1 text-xs text-slate-600">
                            <span>In Sage</span>
                            <div className="flex items-center gap-2 sm:h-[38px]">
                              <label className="flex items-center gap-1.5 font-semibold text-slate-700">
                                <input
                                  type="checkbox"
                                  checked={editRecorded}
                                  onChange={(e) => setEditRecorded(e.target.checked)}
                                />
                                Recorded
                              </label>
                              <input
                                type="text"
                                value={editInvoice}
                                onChange={(e) => setEditInvoice(e.target.value)}
                                disabled={!editRecorded}
                                placeholder="invoice #"
                                title="Sage invoice number"
                                className="w-28 border rounded-xl px-2 py-2 text-xs font-mono bg-white disabled:bg-slate-100 disabled:text-slate-400"
                              />
                            </div>
                          </div>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={() => handleSaveEdit(payment.id)}
                            disabled={saving}
                            className="px-3 py-2 rounded-xl bg-emerald-600 text-white text-xs font-semibold disabled:opacity-50"
                          >
                            Save
                          </button>
                          <button
                            type="button"
                            onClick={cancelEdit}
                            className="px-3 py-2 rounded-xl border border-slate-200 text-xs font-semibold text-slate-600"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <div className="flex min-w-0 flex-col gap-1">
                          <span className="text-sm font-semibold text-slate-800">
                            ${Number(payment.amount || 0).toFixed(2)}
                          </span>
                          <AssignmentBadge
                            assignment={assignmentOf(payment, saleNameByPaymentId, archivedUsage)}
                          />

                          {payment.note && (
                            <span className="text-xs text-slate-500">
                              Note: {payment.note}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="inline-flex items-center justify-center rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700">
                            {payment.type || "Unknown"}
                          </span>
                          <button
                            type="button"
                            onClick={() => startEdit(payment)}
                            className="px-3 py-1 rounded-xl border border-slate-200 text-xs font-semibold text-slate-600 hover:bg-slate-50"
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDeletePayment(payment.id)}
                            disabled={saving}
                            className="px-3 py-1 rounded-xl border border-red-200 text-xs font-semibold text-red-600 hover:bg-red-50 disabled:opacity-50"
                          >
                            Delete
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                ))}
              </div>
              {(() => {
                const totals = { Interac: 0, VISA: 0, MasterCard: 0 };
                const counts = { Interac: 0, VISA: 0, MasterCard: 0 };
                list.forEach((p) => {
                  const typeKey = QUICK_ADD_TYPES.includes(p?.type) ? p.type : null;
                  if (!typeKey) return;
                  const amt = Number(p?.amount || 0);
                  if (!Number.isFinite(amt)) return;
                  totals[typeKey] += amt;
                  counts[typeKey] += 1;
                });
                return (
                  <div className="mt-4 border-t border-slate-200 pt-3 grid gap-2 sm:grid-cols-3">
                    {QUICK_ADD_TYPES.map((t) => {
                      const amountKey = `${dateKey}__${t}`;
                      const quickAmount = quickAddAmounts[amountKey] ?? "";
                      return (
                        <div
                          key={`${dateKey}-${t}`}
                          className="rounded-xl bg-slate-50 border border-slate-200 px-3 py-2 flex flex-col gap-2"
                        >
                          <div className="text-xs text-slate-500">{t} total</div>
                          <div className="text-sm font-semibold text-slate-700">
                            ${totals[t].toFixed(2)}
                          </div>
                          <div className="text-xs text-slate-500">
                            {counts[t]} transaction{counts[t] === 1 ? "" : "s"}
                          </div>
                          <input
                            type="number"
                            min="0"
                            step="0.01"
                            value={quickAmount}
                            onChange={(e) =>
                              setQuickAddAmounts((prev) => ({
                                ...prev,
                                [amountKey]: e.target.value,
                              }))
                            }
                            className="w-full border rounded-xl px-3 py-2 text-xs bg-white"
                            placeholder="Amount"
                          />
                          <button
                            type="button"
                            onClick={() => handleQuickAddPayment(dateKey, t)}
                            disabled={saving}
                            className="px-3 py-2 rounded-xl bg-indigo-600 text-white text-xs font-semibold disabled:opacity-50"
                          >
                            Add {t}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                );
              })()}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
