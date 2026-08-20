import React, { useCallback, useEffect, useState } from "react";
import api from "../api";

const money = (n) => {
  const v = Number(n);
  return Number.isFinite(v) ? `$${v.toFixed(2)}` : "—";
};

// Imports Clover's Payments CSV export. The user downloads the export from
// Clover themselves and points the app at the file — there is no browser, no
// login and no page to read. There is no confirm step on purpose: the import
// ledger (clover_scraped.json) is what keeps a re-import of an overlapping
// export from adding anything twice, so nothing here needs approving.
export default function CloverImportModal({ onClose, onImported }) {
  const [phase, setPhase] = useState("idle"); // idle | importing | done
  const [error, setError] = useState("");
  const [statusLog, setStatusLog] = useState([]);
  const [result, setResult] = useState(null);
  const [ledger, setLedger] = useState(null);
  const [fixing, setFixing] = useState(false);
  const [fixed, setFixed] = useState(null);

  const refreshLedger = useCallback(async () => {
    try {
      const res = await api.getCloverLedgerSummary?.();
      if (res?.ok) setLedger(res);
    } catch {
      /* the count is informational only */
    }
  }, []);

  useEffect(() => {
    refreshLedger();
  }, [refreshLedger]);

  async function handleChooseFile() {
    setError("");
    setStatusLog([]);
    setResult(null);
    setFixed(null);
    setPhase("importing");
    try {
      const res = await api.importCloverCsv();
      // Cancelling the file picker isn't a failure — just go back to idle.
      if (res?.canceled) {
        setPhase("idle");
        return;
      }
      setStatusLog(Array.isArray(res?.statusLog) ? res.statusLog : []);
      if (!res?.ok) {
        setError(res?.error || "Nothing could be read from that file.");
        setPhase("idle");
        return;
      }
      setResult(res);
      setPhase("done");
      await refreshLedger();
      if (res.imported > 0) await onImported?.();
    } catch (e) {
      setError(e?.message || "Failed to read that CSV file.");
      setPhase("idle");
    }
  }

  // Undo for imports that landed with a bad card type: removes them and their
  // ledger entries so the next import picks them up again, correctly typed.
  async function handleForgetMistyped() {
    setError("");
    setFixing(true);
    try {
      const res = await api.forgetMistypedClover();
      if (!res?.ok) {
        setError(res?.error || "Failed to clear mistyped payments.");
        return;
      }
      setFixed(res.removed);
      await refreshLedger();
      if (res.removed > 0) await onImported?.();
    } catch (e) {
      setError(e?.message || "Failed to clear mistyped payments.");
    } finally {
      setFixing(false);
    }
  }

  const busy = phase === "importing";

  return (
    <div className="fixed inset-0 z-[5000] bg-slate-900/60 flex items-center justify-center px-4">
      <div className="bg-white rounded-3xl shadow-2xl w-full max-w-3xl p-6 flex flex-col gap-4 max-h-[92vh]">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold text-slate-800">Import Payments from a Clover CSV</h2>
            <p className="text-sm text-slate-500 max-w-2xl">
              In Clover, go to <strong>Reporting → Payments</strong>, pick the date range and
              <strong> Export</strong> it. Then choose that .csv below: payments go straight into
              `payments.json`, and anything imported before is skipped, so overlapping exports are
              safe.
            </p>
          </div>
          <button
            className="text-slate-500 hover:text-slate-700 text-lg leading-none"
            onClick={onClose}
            disabled={busy}
          >
            x
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-y border-slate-100 py-3">
          <button
            type="button"
            onClick={handleChooseFile}
            disabled={busy}
            className="px-4 py-2 rounded-full text-sm font-semibold bg-emerald-600 text-white disabled:opacity-40"
          >
            {busy ? "Reading…" : phase === "done" ? "Choose another CSV file…" : "Choose CSV file…"}
          </button>
          {result?.file && (
            <span className="text-xs text-slate-400 truncate max-w-[24rem]" title={result.file}>
              {result.file}
            </span>
          )}
        </div>

        {error && (
          <div className="rounded-xl bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">
            {error}
          </div>
        )}

        {statusLog.length > 0 && (
          <ul className="text-xs text-slate-500 space-y-0.5">
            {statusLog.map((line, i) => (
              <li key={i}>• {line}</li>
            ))}
          </ul>
        )}

        {phase === "done" && result && (
          <>
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="rounded-xl bg-emerald-50 border border-emerald-200 px-3 py-2">
                <div className="text-lg font-semibold text-emerald-700">{result.imported}</div>
                <div className="text-[11px] text-emerald-700">imported</div>
              </div>
              <div className="rounded-xl bg-slate-50 border border-slate-200 px-3 py-2">
                <div className="text-lg font-semibold text-slate-700">{result.skippedKnown || 0}</div>
                <div className="text-[11px] text-slate-500">already imported</div>
              </div>
              <div className="rounded-xl bg-slate-50 border border-slate-200 px-3 py-2">
                <div className="text-lg font-semibold text-slate-700">
                  {(result.declined || 0) + (result.nonCard || 0)}
                </div>
                <div className="text-[11px] text-slate-500">declined / not a card</div>
              </div>
            </div>

            {result.payments?.length > 0 && (
              <div className="border rounded-2xl bg-slate-50 overflow-auto max-h-[35vh]">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-[10px] uppercase tracking-wide text-slate-400 border-b border-slate-200">
                      <th className="px-3 py-2">Date</th>
                      <th className="px-3 py-2 text-right">Amount</th>
                      <th className="px-3 py-2">Type</th>
                      <th className="px-3 py-2">Note</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.payments.map((p) => (
                      <tr
                        key={p.id}
                        className={`border-b border-slate-100 ${
                          p.type === "Unknown" || !p.date ? "bg-amber-50" : "bg-white"
                        }`}
                      >
                        <td className="px-3 py-2 text-slate-700">{p.date || "— no date —"}</td>
                        <td className="px-3 py-2 text-right font-semibold text-slate-800">
                          {money(p.amount)}
                        </td>
                        <td className="px-3 py-2 text-slate-700">{p.type}</td>
                        <td className="px-3 py-2 text-xs text-slate-500">{p.note}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {result.payments?.some((p) => p.type === "Unknown" || !p.date) && (
              <div className="rounded-xl bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-800">
                Rows highlighted above imported without a card type or a date. They're in
                `payments.json` already — fix them with the payment's <strong>Edit</strong> button.
                They won't be imported again.
              </div>
            )}

            {result.payments?.some((p) => /refunded/.test(p.note || "")) && (
              <div className="rounded-xl bg-slate-50 border border-slate-200 px-3 py-2 text-xs text-slate-600">
                Partly refunded payments import at the amount the terminal took, with the refund
                noted. Adjust the amount by hand if the refund belongs against the same sale.
              </div>
            )}
          </>
        )}

        {fixed !== null && (
          <div className="rounded-xl bg-emerald-50 border border-emerald-200 px-3 py-2 text-sm text-emerald-800">
            {fixed === 0
              ? "No mistyped Clover payments found — nothing to redo."
              : `Removed ${fixed} mistyped payment${fixed === 1 ? "" : "s"} and cleared them from the ledger. Import the CSV again to pull them back with the right card type.`}
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-3">
          <div className="flex flex-col gap-1">
            <div className="text-xs text-slate-400">
              {ledger
                ? `Import ledger: ${ledger.total} Clover payment${
                    ledger.total === 1 ? "" : "s"
                  } seen so far — those are never re-imported.`
                : ""}
            </div>
            <button
              type="button"
              onClick={handleForgetMistyped}
              disabled={busy || fixing}
              className="self-start text-xs font-semibold text-indigo-600 hover:underline disabled:opacity-40"
              title="Deletes Clover payments whose type isn't Interac, VISA or MasterCard and clears them from the ledger, so the next import brings them back."
            >
              {fixing ? "Clearing…" : "Redo payments with a wrong card type"}
            </button>
          </div>
          <button
            className="px-5 py-2 rounded-full text-sm font-semibold border border-slate-300 text-slate-700 hover:bg-slate-50"
            onClick={onClose}
            disabled={busy}
          >
            {phase === "done" ? "Done" : "Cancel"}
          </button>
        </div>
      </div>
    </div>
  );
}
