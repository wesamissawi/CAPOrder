import React, { useEffect, useMemo, useState } from "react";
import api from "../api";
import Card from "../components/Card";

const PAYMENT_TYPES = ["Interac", "VISA", "MasterCard"];

const getTodayDateString = () => new Date().toISOString().slice(0, 10);
const toInputMoney = (val) => {
  if (val === null || val === undefined || val === "") return "";
  const num = Number(val);
  if (!Number.isFinite(num)) return "";
  return num.toFixed(2);
};

export default function PaymentManagementView({ currentViewMeta }) {
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
  const [quickAddAmounts, setQuickAddAmounts] = useState({});

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
  }

  function cancelEdit() {
    setEditingId(null);
    setEditAmount("");
    setEditDate("");
    setEditType(PAYMENT_TYPES[0]);
    setEditNote("");
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
    const next = (payments || []).map((p) =>
      p?.id === paymentId
        ? {
            ...p,
            amount: Number(amt.toFixed(2)),
            date: editDate,
            type: editType,
            note: editNote.trim() || "",
            updatedAt: new Date().toISOString(),
          }
        : p
    );
    setSaving(true);
    try {
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
          {paymentsPath && (
            <div className="text-xs text-slate-400">
              File: <code className="text-indigo-600 break-all">{paymentsPath}</code>
            </div>
          )}
        </div>
      </Card>

      {error && (
        <Card>
          <div className="rounded-xl bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">
            {error}
          </div>
        </Card>
      )}

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
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
        <div className="flex items-center justify-between">
          <p className="text-lg font-semibold text-slate-800">Payments</p>
          <span className="text-xs text-slate-500">
            {sortedPayments.length} total
          </span>
        </div>
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
            <div
              key={dateKey}
              className="rounded-2xl border border-slate-200 bg-white/80 p-4 h-full"
            >
              <div className="flex items-center justify-between">
                <div className="text-base font-semibold text-slate-800">{dateKey}</div>
                <div className="text-xs text-slate-500">
                  {list.length} payment{list.length === 1 ? "" : "s"}
                </div>
              </div>
              <div className="mt-3 grid gap-2">
                {list.map((payment) => (
                  <div
                    key={payment.id || `${payment.type}-${payment.date}-${payment.amount}`}
                    className="flex flex-col gap-2 rounded-2xl border border-slate-200 bg-white/90 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
                  >
                    {editingId === payment.id ? (
                      <div className="flex flex-1 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
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
                          <div className="flex flex-col gap-1 text-xs text-slate-600">
                            Type
                            <div className="w-full sm:w-40 border rounded-xl px-3 py-2 text-sm bg-slate-50 text-slate-700">
                              {editType || "Unknown"}
                            </div>
                          </div>
                          <label className="flex flex-col gap-1 text-xs text-slate-600">
                            Note
                            <input
                              type="text"
                              value={editNote}
                              onChange={(e) => setEditNote(e.target.value)}
                              className="w-full sm:w-56 border rounded-xl px-3 py-2 text-sm bg-white"
                            />
                          </label>
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
                        <div className="flex flex-col">
                          <span className="text-sm font-semibold text-slate-800">
                            ${Number(payment.amount || 0).toFixed(2)}
                          </span>
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
                  const typeKey = PAYMENT_TYPES.includes(p?.type) ? p.type : null;
                  if (!typeKey) return;
                  const amt = Number(p?.amount || 0);
                  if (!Number.isFinite(amt)) return;
                  totals[typeKey] += amt;
                  counts[typeKey] += 1;
                });
                return (
                  <div className="mt-4 border-t border-slate-200 pt-3 grid gap-2 sm:grid-cols-3">
                    {PAYMENT_TYPES.map((t) => {
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
