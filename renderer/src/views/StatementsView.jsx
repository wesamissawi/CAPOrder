// Statements Management — one tab per supplier.
//
// Self-contained like Sage Runs: it talks to the main process directly and owns
// no App-level state. The flow per supplier is
//   1. "Find latest statement in Gmail"  → reads + caches the statement PDF(s)
//   2. "Reconcile with Sage"             → compares each statement line with the
//                                          orders we have on file
// and the result highlights what the supplier is charging that we can't find.
import React, { useCallback, useEffect, useMemo, useState } from "react";
import Card from "../components/Card";
import api from "../api";

const money = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  const s = Math.abs(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return n < 0 ? `-$${s}` : `$${s}`;
};

const isoDaysAgo = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

// status → label, row tint, badge. `problem` ones are what the user came for.
const STATUS = {
  missing: { label: "Not in our records", problem: true, row: "bg-red-50", badge: "bg-red-600 text-white" },
  number: { label: "Invoice # differs", problem: true, row: "bg-amber-50", badge: "bg-amber-500 text-white" },
  amount: { label: "Amount differs", problem: true, row: "bg-amber-50", badge: "bg-amber-500 text-white" },
  type: { label: "Credit/charge differs", problem: true, row: "bg-amber-50", badge: "bg-amber-500 text-white" },
  "not-entered": { label: "Not entered in Sage", problem: true, row: "bg-orange-50", badge: "bg-orange-500 text-white" },
  matched: { label: "Matched", problem: false, row: "", badge: "bg-emerald-100 text-emerald-800" },
  payment: { label: "Payment", problem: false, row: "", badge: "bg-slate-100 text-slate-600" },
  settled: { label: "Settled", problem: false, row: "", badge: "bg-slate-100 text-slate-600" },
  fee: { label: "Fee", problem: false, row: "", badge: "bg-slate-100 text-slate-600" },
};

const FILTERS = [
  { id: "problems", label: "Problems" },
  { id: "all", label: "All lines" },
  { id: "matched", label: "Matched" },
];

function SupplierSettings({ supplier, onSaved }) {
  const [sender, setSender] = useState(supplier.sender || "");
  const [subject, setSubject] = useState(supplier.subject || "");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setSender(supplier.sender || "");
    setSubject(supplier.subject || "");
  }, [supplier.id, supplier.sender, supplier.subject]);

  const dirty = sender !== (supplier.sender || "") || subject !== (supplier.subject || "");
  const save = async () => {
    setSaving(true);
    try {
      const res = await api.setStatementSupplierConfig({ supplierId: supplier.id, sender, subject });
      if (res?.ok) onSaved?.();
    } finally {
      setSaving(false);
    }
  };
  const input = "w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm";
  return (
    <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] items-end">
      <label className="text-xs font-semibold text-slate-500">
        Gmail sender (comma-separated for several)
        <input className={input} value={sender} onChange={(e) => setSender(e.target.value)} placeholder="statements@supplier.com" />
      </label>
      <label className="text-xs font-semibold text-slate-500">
        Subject contains
        <input className={input} value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Statement" />
      </label>
      <button
        onClick={save}
        disabled={!dirty || saving}
        className="h-9 px-4 rounded-full bg-slate-800 text-white text-sm font-semibold disabled:opacity-40"
      >
        {saving ? "Saving…" : "Save"}
      </button>
    </div>
  );
}

export default function StatementsView() {
  const [suppliers, setSuppliers] = useState([]);
  const [activeId, setActiveId] = useState("");
  const [statements, setStatements] = useState([]); // cached, newest first
  const [selectedId, setSelectedId] = useState(""); // messageId; "" = latest
  const [result, setResult] = useState(null); // reconcile output
  const [busy, setBusy] = useState(""); // "" | "fetch" | "reconcile"
  const [error, setError] = useState("");
  const [log, setLog] = useState([]);
  const [filter, setFilter] = useState("problems");
  const [fromDate, setFromDate] = useState(() => isoDaysAgo(75));
  const [toDate, setToDate] = useState(() => isoDaysAgo(0));
  const [showSettings, setShowSettings] = useState(false);

  const loadSuppliers = useCallback(async () => {
    const res = await api.listStatementSuppliers();
    if (res?.ok) {
      setSuppliers(res.suppliers || []);
      setActiveId((cur) => cur || res.suppliers?.[0]?.id || "");
    }
  }, []);
  useEffect(() => { loadSuppliers(); }, [loadSuppliers]);

  const supplier = useMemo(() => suppliers.find((s) => s.id === activeId) || null, [suppliers, activeId]);

  const runReconcile = useCallback(async (supplierId, messageId) => {
    setBusy("reconcile");
    setError("");
    try {
      const res = await api.reconcileStatement({ supplierId, messageId });
      if (res?.ok) setResult(res);
      else { setResult(null); setError(res?.error || "Reconcile failed."); }
    } finally {
      setBusy("");
    }
  }, []);

  // Switching supplier: show what's already cached, and reconcile the latest
  // straight away — no Gmail call, so it's free to do on every tab change.
  useEffect(() => {
    if (!activeId) return undefined;
    let live = true;
    setResult(null);
    setError("");
    setLog([]);
    setSelectedId("");
    setStatements([]);
    (async () => {
      const res = await api.listStatements({ supplierId: activeId });
      if (!live || !res?.ok) return;
      setStatements(res.statements || []);
      if (res.statements?.length) runReconcile(activeId, "");
    })();
    return () => { live = false; };
  }, [activeId, runReconcile]);

  const findInGmail = async () => {
    setBusy("fetch");
    setError("");
    setLog([]);
    try {
      const res = await api.fetchStatements({ supplierId: activeId, fromDate, toDate });
      setLog(res?.statusLog || []);
      if (!res?.ok) { setError(res?.error || "Gmail lookup failed."); return; }
      setStatements(res.statements || []);
      if (res.statements?.length) {
        setSelectedId("");
        await runReconcile(activeId, "");
      } else {
        setError("No statement emails found in that date range. Check the sender/subject under Gmail settings.");
      }
    } finally {
      setBusy((b) => (b === "fetch" ? "" : b));
    }
  };

  const pick = (messageId) => {
    setSelectedId(messageId);
    runReconcile(activeId, messageId);
  };

  const current = result?.statement || null;
  const summary = result?.summary || null;

  const visibleRows = useMemo(() => {
    const rows = result?.rows || [];
    if (filter === "all") return rows;
    if (filter === "matched") return rows.filter((r) => r.status === "matched");
    return rows.filter((r) => STATUS[r.status]?.problem);
  }, [result, filter]);

  const th = "px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-500";
  const td = "px-3 py-2 text-sm text-slate-700 align-top";

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <div className="flex flex-wrap gap-2">
          {suppliers.map((s) => (
            <button
              key={s.id}
              onClick={() => setActiveId(s.id)}
              className={`h-10 px-5 rounded-full border text-sm font-semibold transition ${
                s.id === activeId
                  ? "bg-indigo-600 text-white border-indigo-600 shadow"
                  : "bg-white border-slate-200 text-slate-600 hover:text-indigo-600"
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
      </Card>

      {supplier && (
        <Card>
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-end gap-3">
              <div className="mr-auto">
                <h2 className="text-xl font-semibold text-slate-800">{supplier.label} statements</h2>
                <p className="text-sm text-slate-500">
                  Look up the statement in Gmail, then check every line against what we’ve entered in Sage.
                </p>
              </div>
              <label className="text-xs font-semibold text-slate-500">
                From
                <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className="block rounded-lg border border-slate-300 px-2 py-1.5 text-sm" />
              </label>
              <label className="text-xs font-semibold text-slate-500">
                To
                <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} className="block rounded-lg border border-slate-300 px-2 py-1.5 text-sm" />
              </label>
              <button
                onClick={findInGmail}
                disabled={Boolean(busy)}
                className="h-10 px-5 rounded-full bg-indigo-600 text-white text-sm font-semibold shadow disabled:opacity-50"
              >
                {busy === "fetch" ? "Searching Gmail…" : "Find statement in Gmail"}
              </button>
              <button
                onClick={() => runReconcile(activeId, selectedId)}
                disabled={Boolean(busy) || !statements.length}
                className="h-10 px-5 rounded-full bg-emerald-600 text-white text-sm font-semibold shadow disabled:opacity-50"
              >
                {busy === "reconcile" ? "Reconciling…" : "Reconcile with Sage"}
              </button>
            </div>

            <button onClick={() => setShowSettings((v) => !v)} className="self-start text-xs font-semibold text-indigo-600 hover:underline">
              {showSettings ? "Hide Gmail settings" : "Gmail settings for this supplier"}
            </button>
            {showSettings && <SupplierSettings supplier={supplier} onSaved={loadSuppliers} />}

            {error && <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
            {log.length > 0 && (
              <details className="text-xs text-slate-500">
                <summary className="cursor-pointer font-semibold">Lookup log</summary>
                <ul className="mt-1 list-disc pl-5">{log.map((l, i) => <li key={i}>{l}</li>)}</ul>
              </details>
            )}
          </div>
        </Card>
      )}

      {supplier && !statements.length && !busy && !error && (
        <Card>
          <p className="text-sm text-slate-500">No {supplier.label} statement on file yet. Click “Find statement in Gmail”.</p>
        </Card>
      )}

      {statements.length > 0 && (
        <Card>
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-3">
              <label className="text-xs font-semibold text-slate-500">
                Statement
                <select
                  value={selectedId || statements[0].messageId}
                  onChange={(e) => pick(e.target.value)}
                  className="block rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
                >
                  {statements.map((s, i) => (
                    <option key={s.messageId} value={s.messageId}>
                      {s.statement?.statementDate || s.emailDate || "undated"}{i === 0 ? " (latest)" : ""}
                    </option>
                  ))}
                </select>
              </label>
              {current && (
                <>
                  <div className="text-sm text-slate-600">
                    Balance on statement: <span className="font-semibold">{money(current.statement?.balance)}</span>
                  </div>
                  {current.fileName && (
                    <button onClick={() => api.openStatementPdf(current.fileName)} className="text-sm font-semibold text-indigo-600 hover:underline">
                      {/\.html$/i.test(current.fileName) ? "View statement email" : "View statement PDF"}
                    </button>
                  )}
                </>
              )}
            </div>

            {current?.statement?.opening > 0 && (
              <div className="text-xs text-slate-500">
                Includes {money(current.statement.opening)} brought forward from before this statement — not itemised, so it can’t be reconciled line by line.
              </div>
            )}

            {result?.recordCount === 0 && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                We have no {supplier?.label} orders on file at all, so every line below shows as not in our records. The statement itself was read correctly.
              </div>
            )}

            {current?.statement?.warnings?.length > 0 && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                {current.statement.warnings.map((w, i) => <div key={i}>{w}</div>)}
              </div>
            )}

            {summary && (
              <div className="flex flex-wrap gap-2 text-sm">
                <span className={`rounded-full px-3 py-1 font-semibold ${summary.problems ? "bg-red-100 text-red-700" : "bg-emerald-100 text-emerald-800"}`}>
                  {summary.problems ? `${summary.problems} to look at` : "Everything reconciles"}
                </span>
                <span className="rounded-full bg-slate-100 px-3 py-1 text-slate-600">{summary.lines} lines</span>
                <span className="rounded-full bg-emerald-50 px-3 py-1 text-emerald-700">{summary.matched} matched</span>
                {summary.missing > 0 && <span className="rounded-full bg-red-50 px-3 py-1 text-red-700">{summary.missing} not in our records</span>}
                {summary.number > 0 && <span className="rounded-full bg-amber-50 px-3 py-1 text-amber-700">{summary.number} invoice # differs</span>}
                {summary.amount > 0 && <span className="rounded-full bg-amber-50 px-3 py-1 text-amber-700">{summary.amount} amount differs</span>}
                {summary.type > 0 && <span className="rounded-full bg-amber-50 px-3 py-1 text-amber-700">{summary.type} credit/charge differs</span>}
                {summary.notEntered > 0 && <span className="rounded-full bg-orange-50 px-3 py-1 text-orange-700">{summary.notEntered} not entered in Sage</span>}
                {summary.notOnStatement > 0 && <span className="rounded-full bg-violet-50 px-3 py-1 text-violet-700">{summary.notOnStatement} in Sage, not on statement</span>}
                <span className="rounded-full bg-slate-100 px-3 py-1 text-slate-600">{summary.payments} payments</span>
              </div>
            )}

            {result && (
              <>
                <div className="flex gap-2">
                  {FILTERS.map((f) => (
                    <button
                      key={f.id}
                      onClick={() => setFilter(f.id)}
                      className={`h-8 px-3 rounded-full border text-xs font-semibold ${filter === f.id ? "bg-slate-800 text-white border-slate-800" : "bg-white border-slate-200 text-slate-600"}`}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>

                <div className="overflow-x-auto rounded-lg border border-slate-200">
                  <table className="min-w-full divide-y divide-slate-200">
                    <thead className="bg-slate-50">
                      <tr>
                        <th className={th}>Date</th>
                        <th className={th}>Document #</th>
                        <th className={th}>Type</th>
                        <th className={`${th} text-right`}>Statement</th>
                        <th className={`${th} text-right`}>Ours</th>
                        <th className={th}>Our order</th>
                        <th className={th}>Result</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {visibleRows.length === 0 && (
                        <tr><td className={td} colSpan={7}>{filter === "problems" ? "No problems on this statement." : "Nothing to show."}</td></tr>
                      )}
                      {visibleRows.map((r, i) => {
                        const st = STATUS[r.status] || STATUS.payment;
                        return (
                          <tr key={`${r.docNumber}-${i}`} className={st.row}>
                            <td className={td}>{r.date || "—"}</td>
                            <td className={`${td} font-mono`}>{r.docNumber}</td>
                            <td className={td}>{r.type}</td>
                            <td className={`${td} text-right tabular-nums`}>{money(r.amount)}</td>
                            <td className={`${td} text-right tabular-nums`}>{r.ourTotal == null ? "—" : money(r.ourTotal)}</td>
                            <td className={td}>{r.ourReference || "—"}</td>
                            <td className={td}>
                              <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${st.badge}`}>{st.label}</span>
                              {r.note && <div className="mt-1 text-xs text-slate-500">{r.note}</div>}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                {result.notOnStatement?.length > 0 && filter !== "matched" && (
                  <div>
                    <h3 className="mb-1 text-sm font-semibold text-slate-700">In Sage, but not on this statement</h3>
                    <div className="overflow-x-auto rounded-lg border border-violet-200">
                      <table className="min-w-full divide-y divide-violet-100">
                        <thead className="bg-violet-50">
                          <tr><th className={th}>Date</th><th className={th}>Invoice #</th><th className={th}>Our order</th><th className={`${th} text-right`}>Total</th><th className={th}>Where</th></tr>
                        </thead>
                        <tbody className="divide-y divide-violet-50">
                          {result.notOnStatement.map((r, i) => (
                            <tr key={i} className="bg-violet-50/40">
                              <td className={td}>{r.date}</td>
                              <td className={`${td} font-mono`}>{r.docNumber}</td>
                              <td className={td}>{r.reference || "—"}</td>
                              <td className={`${td} text-right tabular-nums`}>{money(r.credit ? -(r.total ?? 0) : r.total)}</td>
                              <td className={td}>{r.origin}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {result.undatedSkipped > 0 && (
                      <p className="mt-1 text-xs text-slate-400">{result.undatedSkipped} Sage record(s) had no date and weren’t checked.</p>
                    )}
                  </div>
                )}
                <p className="text-xs text-slate-400">Checked against {result.recordCount} {supplier?.label} record(s): active orders, the archive and archive manifests.</p>
              </>
            )}
          </div>
        </Card>
      )}
    </div>
  );
}
