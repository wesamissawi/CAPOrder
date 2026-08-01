// Sage Runs — the printable record of every "Send to Sage Sales".
//
// This view owns nothing but the filter. Rows come from sage_sales_runs.json,
// written by App.jsx the moment an AHK run finishes, and each one snapshots the
// payment that settled the sale rather than pointing at it. That's deliberate:
// the sale gets archived and its bubble deleted, and the payment itself can be
// purged from Payments once it's in Sage — the report still has to print.
//
// Only two things here write: correcting an invoice number the AHK couldn't
// read, and deleting a row that shouldn't have been logged.
import React, { useEffect, useMemo, useState } from "react";
import Card from "../components/Card";
import DraftInput from "../components/DraftInput";
import api from "../api";
import { printSheet, escapeHtml } from "../utils/printSheet";

const money = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? `$${n.toFixed(2)}` : "$0.00";
};

const dayString = (d) => {
  const t = new Date(d);
  return Number.isNaN(t.getTime()) ? "" : t.toISOString().slice(0, 10);
};

const daysAgo = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return dayString(d);
};

const fmtWhen = (iso) => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? "—" : new Date(t).toLocaleString();
};

// One row per payment on the run, so a sale settled by two payments prints two
// lines rather than hiding the second. A run with no payment still prints —
// that's exactly the case worth seeing on a report.
function runRows(run) {
  const payments = Array.isArray(run?.payments) ? run.payments : [];
  if (!payments.length) return [{ run, payment: null }];
  return payments.map((payment) => ({ run, payment }));
}

// The transaction time, shown as-is. Clover captures it and it now rides on the
// payment as its own clean field ("13:28"); payments imported before that only
// have it inside the note ("Clover 13:28 ••6728"), which is displayed verbatim
// rather than picked apart. Those tidy themselves up on re-import.
const paymentTime = (payment) =>
  String(payment?.time || "").trim() || String(payment?.note || "").trim();

// Minutes past midnight — ORDERING ONLY, never displayed. Sorting by time
// can't work without turning the text into a number somewhere, so this reads
// the first HH:MM it finds anywhere in the string, which covers both the clean
// field and the older note form. Anything it can't read sorts last within its
// date rather than jumping to the top as a zero.
const timeRank = (text) => {
  const m = /(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp])?/.exec(String(text || ""));
  if (!m) return Number.MAX_SAFE_INTEGER;
  const hour = Number(m[1]);
  // 24-hour clock unless an am/pm marker says otherwise.
  const h = m[3] ? (hour % 12) + (/[Pp]/.test(m[3]) ? 12 : 0) : hour;
  return h * 60 + Number(m[2]);
};

// The types the business actually takes, plus a catch-all. "Other" is not
// cosmetic: a Clover import can land as "Unknown", and folding it silently into
// nothing would make the printed totals fail to add up to the grand total.
//
// E-Transfer is matched BEFORE the debit rule — "e-transfer" is a bank
// transfer, not an Interac debit tap, and the two must not merge into one line
// on the summary. First match wins, so order matters here.
const TYPE_BUCKETS = [
  { key: "etransfer", label: "E-Transfer", match: (t) => /e[-\s]?transfer/i.test(t) },
  { key: "debit", label: "Debit (Interac)", match: (t) => /interac|debit/i.test(t) },
  { key: "visa", label: "Visa", match: (t) => /^visa/i.test(t) },
  { key: "mastercard", label: "MasterCard", match: (t) => /master/i.test(t) },
];
const bucketFor = (type) => TYPE_BUCKETS.find((b) => b.match(String(type || "")))?.key || "other";

export default function SageRunsView({ currentViewMeta }) {
  const [runs, setRuns] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [from, setFrom] = useState(() => daysAgo(30));
  const [to, setTo] = useState(() => dayString(new Date()));
  const [search, setSearch] = useState("");
  // Which date the range applies to. "run" = when it was keyed into Sage
  // ("what did I put through on Tuesday"); "payment" = when the money was
  // actually taken ("everything that settled Tuesday's takings").
  const [dateBasis, setDateBasis] = useState("run");

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const res = await api.readSageRuns();
      if (!res?.ok) throw new Error(res?.error || "Failed to load Sage runs.");
      setRuns(Array.isArray(res.runs) ? res.runs : []);
    } catch (e) {
      setError(e?.message || "Failed to load Sage runs.");
      setRuns([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  // Runs in range, each carrying only the payments that belong in the answer.
  //
  // In "payment" mode a run is kept when at least one of its payments falls in
  // the range, and its payment list is NARROWED to those. That narrowing is the
  // whole point: a sale settled by two payments on different days would
  // otherwise drag the out-of-range one onto a single day's sheet and make the
  // total disagree with that day's takings. A run with no payments at all can't
  // match a payment-date question, so it drops out of this mode entirely.
  const shown = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const fromT = from ? Date.parse(`${from}T00:00:00`) : Number.NEGATIVE_INFINITY;
    const toT = to ? Date.parse(`${to}T23:59:59.999`) : Number.POSITIVE_INFINITY;
    // Payment dates are plain YYYY-MM-DD, as are the pickers, so they compare
    // exactly as strings — no parsing, and no timezone to shift a payment onto
    // the wrong day.
    const dayInRange = (d) => Boolean(d) && (!from || d >= from) && (!to || d <= to);

    return runs
      .filter((r) => {
        if (!needle) return true;
        return [r?.saleName, r?.sageInvoiceNumber, r?.customerCode, r?.notes]
          .map((v) => String(v || "").toLowerCase())
          .some((v) => v.includes(needle));
      })
      .map((r) => {
        if (dateBasis !== "payment") {
          const t = Date.parse(r?.at);
          return !Number.isNaN(t) && t >= fromT && t <= toT ? r : null;
        }
        const kept = (Array.isArray(r?.payments) ? r.payments : []).filter((p) =>
          dayInRange(String(p?.date || ""))
        );
        return kept.length ? { ...r, payments: kept } : null;
      })
      .filter(Boolean)
      .sort((a, b) => {
        if (dateBasis !== "payment") return Date.parse(a?.at) - Date.parse(b?.at);
        // Ordered by the money, matching how the sheet itself reads.
        const first = (r) =>
          (r.payments || [])
            .map((p) => `${p?.date || ""} ${String(timeRank(paymentTime(p))).padStart(6, "0")}`)
            .sort()[0] || "";
        const fa = first(a);
        const fb = first(b);
        return fa < fb ? -1 : fa > fb ? 1 : 0;
      });
  }, [runs, from, to, search, dateBasis]);

  // Summed off the NARROWED payment lists rather than the stored paymentTotal,
  // which describes the whole run and would over-count in payment mode.
  const totals = useMemo(
    () =>
      shown.reduce(
        (acc, r) => {
          acc.runs += 1;
          acc.items += Number(r?.itemCount) || 0;
          acc.paid += (Array.isArray(r?.payments) ? r.payments : []).reduce(
            (sum, p) => sum + (Number(p?.amount) || 0),
            0
          );
          acc.sale += Number(r?.saleTotal) || 0;
          if (!String(r?.sageInvoiceNumber || "").trim()) acc.missingInvoice += 1;
          return acc;
        },
        { runs: 0, items: 0, paid: 0, sale: 0, missingInvoice: 0 }
      ),
    [shown]
  );

  const handleSetInvoice = async (id, value) => {
    const res = await api.setSageRunInvoice({ id, sageInvoiceNumber: value });
    if (!res?.ok) {
      setError(res?.error || "Failed to update the invoice number.");
      return;
    }
    setRuns((prev) =>
      prev.map((r) => (r?.id === id ? { ...r, sageInvoiceNumber: String(value || "").trim() } : r))
    );
  };

  // Printed as its own document rather than via window.print(), which would put
  // the app's nav tabs and every other bit of chrome on the page.
  //
  // The sheet is deliberately narrower than the on-screen table: it's a record
  // of money taken, so the sale name, part count and sale total are left on
  // screen where they're useful for working, and off the paper where they're
  // clutter.
  const handlePrint = () => {
    // Flattened to one line per PAYMENT, then ordered by when the transaction
    // actually happened rather than when it was keyed into Sage. A run with no
    // payment has no date to sort by and lands at the end — kept rather than
    // dropped, since a sale invoiced with no payment recorded is exactly the
    // discrepancy this sheet should surface.
    const lines = shown
      .flatMap((run) => runRows(run).map(({ payment }) => ({ run, payment })))
      .sort((a, b) => {
        // ISO dates sort correctly as plain strings. A missing date becomes
        // "￿" so it lands at the END — an empty string would sort before
        // every real date and put the anomalies at the top of the sheet.
        const da = a.payment?.date || "￿";
        const db = b.payment?.date || "￿";
        if (da !== db) return da < db ? -1 : 1;
        return timeRank(paymentTime(a.payment)) - timeRank(paymentTime(b.payment));
      });

    const byType = lines.reduce(
      (acc, { payment }) => {
        const amt = Number(payment?.amount) || 0;
        acc[bucketFor(payment?.type)] += amt;
        acc.grand += amt;
        return acc;
      },
      { etransfer: 0, debit: 0, visa: 0, mastercard: 0, other: 0, grand: 0 }
    );

    // Both kinds are itemised, but in their own blocks, split by a rule: cards
    // settle as one terminal batch and e-transfers arrive individually, so each
    // section reconciles against the thing it actually came from. Same five
    // columns in both so they line up straight down the page.
    const etLines = lines.filter(({ payment }) => bucketFor(payment?.type) === "etransfer");
    const cardLines = lines.filter(({ payment }) => bucketFor(payment?.type) !== "etransfer");
    const cardsTotal = byType.debit + byType.visa + byType.mastercard + byType.other;

    const itemRows = (rows) =>
      rows
        .map(
          ({ run, payment }) => `
            <tr>
              <td>${escapeHtml(payment?.date || "—")}</td>
              <td>${escapeHtml(paymentTime(payment) || "—")}</td>
              <td class="mono">${escapeHtml(run.sageInvoiceNumber || "—")}</td>
              <td>${escapeHtml(payment?.type || "—")}</td>
              <td class="num">${payment ? escapeHtml(money(payment.amount)) : "—"}</td>
            </tr>`
        )
        .join("");

    // The totals sit in their own narrow table rather than in the itemised
    // table's tfoot: a tfoot inherits the parent's column widths, so the
    // figures would be pushed to the far edge of a full-width sheet with a
    // stretch of blank paper between label and number.
    const totalRow = (label, value, cls = "") => `
      <tr${cls ? ` class="${cls}"` : ""}>
        <td>${escapeHtml(label)}</td>
        <td class="num">${escapeHtml(money(value))}</td>
      </tr>`;

    const head = `
          <thead>
            <tr>
              <th>Date</th><th>Time</th><th>Sage invoice</th>
              <th>Type</th><th class="num">Amount</th>
            </tr>
          </thead>`;

    printSheet({
      title: "Payment summary",
      bodyHtml: `
        <h1>Payment summary</h1>

        ${
          cardLines.length
            ? `<h2>Card payments</h2>
        <table>
          ${head}
          <tbody>${itemRows(cardLines)}</tbody>
        </table>
        <table class="totals-table">
          <tbody>
            ${totalRow("Debit (Interac)", byType.debit)}
            ${totalRow("Visa", byType.visa)}
            ${totalRow("MasterCard", byType.mastercard)}
            ${byType.other ? totalRow("Other", byType.other) : ""}
            ${totalRow("Card total", cardsTotal, "card-total")}
          </tbody>
        </table>`
            : ""
        }

        ${
          etLines.length
            ? `<hr />
        <h2>E-Transfers</h2>
        <table>
          ${head}
          <tbody>${itemRows(etLines)}</tbody>
        </table>`
            : ""
        }
      `,
    });
  };

  const handleDelete = async (run) => {
    const ok = window.confirm(
      `Delete the Sage run for "${run?.saleName || "this sale"}"?\n\n` +
        `It disappears from this report. Nothing in Sage, in Payments, or in any part's history changes.`
    );
    if (!ok) return;
    const res = await api.deleteSageRun(run.id);
    if (!res?.ok) {
      setError(res?.error || "Failed to delete the Sage run.");
      return;
    }
    setRuns((prev) => prev.filter((r) => r?.id !== run.id));
  };

  return (
    <section className="space-y-4">
      <Card>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-xl font-semibold text-slate-700">
              {currentViewMeta?.label || "Sage Runs"}
            </p>
            <p className="text-sm text-slate-500">
              Every sale sent to Sage, with the payment that settled it and the invoice number.
              {dateBasis === "payment"
                ? " Showing runs by when the payment was taken."
                : " Showing runs by when they were sent to Sage."}
            </p>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            {/* Which date the range below applies to. Payment date is what you
                want when reconciling a day's takings; run date is what you want
                when checking your own Sage entry work. */}
            <div className="flex flex-col gap-1">
              <span className="text-xs text-slate-600">Filter by</span>
              <div className="flex rounded-xl border border-slate-200 overflow-hidden">
                {[
                  { id: "run", label: "Run date" },
                  { id: "payment", label: "Payment date" },
                ].map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => setDateBasis(opt.id)}
                    className={`px-3 py-1.5 text-sm font-semibold transition ${
                      dateBasis === opt.id
                        ? "bg-indigo-600 text-white"
                        : "bg-white text-slate-600 hover:bg-slate-50"
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
            <label className="flex flex-col gap-1 text-xs text-slate-600">
              From
              <input
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                className="rounded-xl border border-slate-200 px-3 py-1.5 text-sm"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-slate-600">
              To
              <input
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                className="rounded-xl border border-slate-200 px-3 py-1.5 text-sm"
              />
            </label>
            <button
              type="button"
              onClick={() => {
                setFrom(dayString(new Date()));
                setTo(dayString(new Date()));
              }}
              className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-sm font-semibold text-slate-600 hover:bg-slate-50"
            >
              Today
            </button>
            <button
              type="button"
              onClick={load}
              disabled={loading}
              className="rounded-xl bg-indigo-600 px-4 py-1.5 text-sm font-semibold text-white shadow hover:bg-indigo-700 disabled:opacity-50"
            >
              {loading ? "Loading…" : "Refresh"}
            </button>
            <button
              type="button"
              onClick={handlePrint}
              disabled={shown.length === 0}
              className="rounded-xl bg-slate-700 px-4 py-1.5 text-sm font-semibold text-white shadow hover:bg-slate-800 disabled:opacity-50"
            >
              Print
            </button>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter by sale, invoice #, customer code…"
            className="flex-1 min-w-[16rem] rounded-xl border border-slate-200 px-3 py-1.5 text-sm"
          />
          {totals.missingInvoice > 0 && (
            <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-800">
              {totals.missingInvoice} without an invoice number
            </span>
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

      <Card>
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm">
          <span className="font-semibold text-slate-700">{totals.runs} run{totals.runs === 1 ? "" : "s"}</span>
          <span className="text-slate-500">{totals.items} parts</span>
          <span className="text-slate-500">
            Payments <b className="text-slate-800">{money(totals.paid)}</b>
          </span>
          <span className="text-slate-500">
            Sale totals <b className="text-slate-800">{money(totals.sale)}</b>
          </span>
        </div>

        {/* The table is wide; it scrolls in its own box so the page body never
            scrolls sideways. Printing goes through handlePrint, not this DOM. */}
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[52rem] text-sm border-collapse">
            <thead>
              <tr className="border-b border-slate-300 text-left text-xs uppercase tracking-wide text-slate-500">
                <th className="py-1.5 pr-3">Sent</th>
                <th className="py-1.5 pr-3">Sale</th>
                <th className="py-1.5 pr-3">Sage invoice</th>
                <th className="py-1.5 pr-3">Payment date</th>
                <th className="py-1.5 pr-3">Time</th>
                <th className="py-1.5 pr-3">Type</th>
                <th className="py-1.5 pr-3 text-right">Amount</th>
                <th className="py-1.5 pr-3 text-right">Parts</th>
                <th className="py-1.5 pr-3 text-right">Sale total</th>
                <th className="py-1.5" />
              </tr>
            </thead>
            <tbody>
              {shown.length === 0 && (
                <tr>
                  <td colSpan={10} className="py-6 text-center text-slate-500 italic">
                    {loading
                      ? "Loading…"
                      : dateBasis === "payment"
                        ? "No Sage runs with a payment taken in this range."
                        : "No Sage runs sent to Sage in this range."}
                  </td>
                </tr>
              )}
              {shown.flatMap((run) =>
                runRows(run).map(({ payment }, idx) => (
                  <tr
                    key={`${run.id}-${payment?.id || idx}`}
                    className="border-b border-slate-100 align-top"
                  >
                    {/* Only the first row of a multi-payment run repeats the
                        run's own columns, so the sheet reads as one entry with
                        two payments rather than two entries. */}
                    <td className="py-1.5 pr-3 whitespace-nowrap text-slate-600">
                      {idx === 0 ? fmtWhen(run.at) : ""}
                    </td>
                    <td className="py-1.5 pr-3 font-semibold text-slate-800">
                      {/* A row created by ticking "In Sage" on a payment has no
                          sale behind it — say so rather than showing a dash
                          that reads like missing data. */}
                      {idx === 0
                        ? run.manual
                          ? <span className="font-normal italic text-slate-500">Marked in Sage</span>
                          : run.saleName || "—"
                        : ""}
                      {idx === 0 && run.customerCode && (
                        <span className="ml-1 font-normal text-slate-400">({run.customerCode})</span>
                      )}
                    </td>
                    <td className="py-1.5 pr-3">
                      {idx === 0 && (
                        <>
                          <DraftInput
                            value={run.sageInvoiceNumber || ""}
                            onCommit={(next) => handleSetInvoice(run.id, next)}
                            placeholder="not captured"
                            className="w-28 rounded-md border border-slate-200 px-1.5 py-0.5 text-xs font-mono"
                          />
                        </>
                      )}
                    </td>
                    <td className="py-1.5 pr-3 whitespace-nowrap text-slate-600">
                      {payment?.date || "—"}
                    </td>
                    <td className="py-1.5 pr-3 whitespace-nowrap text-slate-600">
                      {paymentTime(payment) || "—"}
                    </td>
                    <td className="py-1.5 pr-3 text-slate-600">{payment?.type || "—"}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums text-slate-800">
                      {payment ? money(payment.amount) : "—"}
                    </td>
                    <td className="py-1.5 pr-3 text-right tabular-nums text-slate-600">
                      {idx === 0 ? run.itemCount ?? 0 : ""}
                    </td>
                    <td className="py-1.5 pr-3 text-right tabular-nums text-slate-600">
                      {idx === 0 ? money(run.saleTotal) : ""}
                    </td>
                    <td className="py-1.5 text-right">
                      {idx === 0 && (
                        <button
                          type="button"
                          onClick={() => handleDelete(run)}
                          className="rounded-lg border border-red-200 px-2 py-0.5 text-xs font-semibold text-red-600 hover:bg-red-50"
                        >
                          Delete
                        </button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </section>
  );
}
