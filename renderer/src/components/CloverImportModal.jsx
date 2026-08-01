import React, { useCallback, useEffect, useState } from "react";
import api from "../api";

const money = (n) => {
  const v = Number(n);
  return Number.isFinite(v) ? `$${v.toFixed(2)}` : "—";
};

// Drives the credential-free Clover scrape: open a browser the user signs into
// themselves, let them navigate to Transactions → Payments, then read the page
// and write straight into payments.json. There is no confirm step on purpose —
// the scrape ledger (clover_scraped.json) is what keeps a repeat scrape from
// re-importing anything, so nothing here needs approving twice.
export default function CloverImportModal({ onClose, onImported }) {
  const [phase, setPhase] = useState("idle"); // idle | opening | ready | scraping | done
  const [browserOpen, setBrowserOpen] = useState(false);
  const [pageInfo, setPageInfo] = useState({ url: "", title: "" });
  const [error, setError] = useState("");
  const [statusLog, setStatusLog] = useState([]);
  const [result, setResult] = useState(null);
  const [ledger, setLedger] = useState(null);
  const [fixing, setFixing] = useState(false);
  const [fixed, setFixed] = useState(null);

  const refreshStatus = useCallback(async () => {
    try {
      const res = await api.getCloverStatus?.();
      setBrowserOpen(Boolean(res?.open));
      if (res?.open) setPageInfo({ url: res.url || "", title: res.title || "" });
      return Boolean(res?.open);
    } catch {
      return false;
    }
  }, []);

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
    refreshStatus().then((open) => {
      if (open) setPhase((p) => (p === "idle" ? "ready" : p));
    });
  }, [refreshStatus, refreshLedger]);

  // The browser is a separate window the user is working in, so poll for it
  // being closed (by them or by a crash) rather than assuming it's still there.
  useEffect(() => {
    const id = setInterval(refreshStatus, 4000);
    return () => clearInterval(id);
  }, [refreshStatus]);

  async function handleOpen() {
    setError("");
    setPhase("opening");
    try {
      const res = await api.openClover();
      if (res?.ok === false) {
        setError(res.error || "Failed to open the Clover browser.");
        setPhase("idle");
        return;
      }
      setBrowserOpen(true);
      setPageInfo({ url: res?.url || "", title: "" });
      setPhase("ready");
    } catch (e) {
      setError(e?.message || "Failed to open the Clover browser.");
      setPhase("idle");
    }
  }

  async function handleScrape() {
    setError("");
    setStatusLog([]);
    setResult(null);
    setPhase("scraping");
    try {
      const res = await api.scrapeCloverPayments();
      setStatusLog(Array.isArray(res?.statusLog) ? res.statusLog : []);
      if (res?.url || res?.title) setPageInfo({ url: res.url || "", title: res.title || "" });
      if (!res?.ok) {
        setError(res?.error || "Nothing could be read from that page.");
        setPhase(res?.open === false ? "idle" : "ready");
        setBrowserOpen(res?.open !== false);
        return;
      }
      setResult(res);
      setPhase("done");
      await refreshLedger();
      if (res.imported > 0) await onImported?.();
    } catch (e) {
      setError(e?.message || "Failed to scrape the Clover page.");
      setPhase("ready");
    }
  }

  // Undo for imports that landed with a bad card type: removes them and their
  // ledger entries so the next scrape picks them up again, correctly typed.
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

  async function handleCloseBrowser() {
    try {
      await api.closeClover();
    } catch {
      /* nothing useful to say — the window is going away either way */
    }
    setBrowserOpen(false);
  }

  const busy = phase === "opening" || phase === "scraping";

  return (
    <div className="fixed inset-0 z-[5000] bg-slate-900/60 flex items-center justify-center px-4">
      <div className="bg-white rounded-3xl shadow-2xl w-full max-w-3xl p-6 flex flex-col gap-4 max-h-[92vh]">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold text-slate-800">Import Payments from Clover</h2>
            <p className="text-sm text-slate-500 max-w-2xl">
              Open Clover, sign in yourself, and go to <strong>Transactions → Payments</strong>. The
              app never sees your login — it only reads the page you land on. Scroll until every row
              you want is loaded, then scrape: payments go straight into `payments.json`, and
              anything already scraped before is skipped.
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
            onClick={handleOpen}
            disabled={busy || browserOpen}
            className="px-4 py-2 rounded-full text-sm font-semibold bg-slate-800 text-white disabled:opacity-40"
          >
            {phase === "opening" ? "Opening…" : browserOpen ? "Clover is open" : "1. Open Clover"}
          </button>
          <button
            type="button"
            onClick={handleScrape}
            disabled={busy || !browserOpen}
            className="px-4 py-2 rounded-full text-sm font-semibold bg-emerald-600 text-white disabled:opacity-40"
          >
            {phase === "scraping" ? "Scraping…" : "2. Scrape & Import"}
          </button>
          {browserOpen && (
            <button
              type="button"
              onClick={handleCloseBrowser}
              disabled={busy}
              className="px-4 py-2 rounded-full text-sm font-semibold border border-slate-300 text-slate-600 hover:bg-slate-50"
              title="Closes the Clover window and ends the session. Nothing is saved to disk."
            >
              Close Clover
            </button>
          )}
          <span
            className={`ml-auto inline-flex items-center gap-1 text-xs font-semibold ${
              browserOpen ? "text-emerald-600" : "text-slate-400"
            }`}
          >
            <span
              className={`h-2 w-2 rounded-full ${browserOpen ? "bg-emerald-500" : "bg-slate-300"}`}
            />
            {browserOpen ? "Browser open" : "Browser closed"}
          </span>
        </div>

        {phase === "scraping" && (
          <div className="rounded-xl bg-indigo-50 border border-indigo-200 px-3 py-2 text-sm text-indigo-800">
            Reading the payment list, then opening each card payment's details in a second tab to
            find out whether it's Visa or Mastercard. Interac payments are read straight off the
            list. Don't touch the Clover window while this runs.
          </div>
        )}

        {pageInfo.url && (
          <div className="text-xs text-slate-400 truncate">
            Reading: <code className="text-indigo-600">{pageInfo.title || pageInfo.url}</code>
          </div>
        )}

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
                <div className="text-[11px] text-slate-500">already scraped</div>
              </div>
              <div className="rounded-xl bg-slate-50 border border-slate-200 px-3 py-2">
                <div className="text-lg font-semibold text-slate-700">
                  {(result.declined || 0) + (result.skippedUnidentified || 0)}
                </div>
                <div className="text-[11px] text-slate-500">declined / unreadable</div>
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
                They won't be scraped again.
              </div>
            )}
          </>
        )}

        {fixed !== null && (
          <div className="rounded-xl bg-emerald-50 border border-emerald-200 px-3 py-2 text-sm text-emerald-800">
            {fixed === 0
              ? "No mistyped Clover payments found — nothing to redo."
              : `Removed ${fixed} mistyped payment${fixed === 1 ? "" : "s"} and cleared them from the ledger. Click "Scrape & Import" to pull them again with the right card type.`}
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-3">
          <div className="flex flex-col gap-1">
            <div className="text-xs text-slate-400">
              {ledger
                ? `Scrape ledger: ${ledger.total} Clover payment${
                    ledger.total === 1 ? "" : "s"
                  } seen so far — those are never re-imported.`
                : ""}
            </div>
            <button
              type="button"
              onClick={handleForgetMistyped}
              disabled={busy || fixing}
              className="self-start text-xs font-semibold text-indigo-600 hover:underline disabled:opacity-40"
              title="Deletes Clover payments whose type isn't Interac, VISA or MasterCard and clears them from the ledger, so the next scrape re-imports them correctly."
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
