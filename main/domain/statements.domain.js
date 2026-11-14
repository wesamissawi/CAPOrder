// main/domain/statements.domain.js
// Reconcile a supplier statement against the orders we have on file for that
// supplier. Pure: callers hand in plain data, so it is testable without Gmail,
// Electron or the CRDT store.
//
// Statement line statuses
//   matched      a Sage-entered record carries this document number and amount
//   amount       found + entered, but the money disagrees
//   type         found + entered, but one side is a credit and the other isn't
//   not-entered  we hold the order but it is not in Sage yet
//   number       probably ours, but the invoice number was keyed differently
//   missing      NOTHING on file carries this document number   <- the headline
//   payment      a payment line; informational, never reconciled
//
// Plus a reverse pass: Sage-entered records in the statement's date window that
// the statement does not list ("not-on-statement").
const { supplierIdForOrder } = require("../../src/statements/statementSuppliers");
// The project-wide "is this a credit" rule (shape: negative total / quantities), so
// the Statements view agrees with Order Management about what a credit is.
const { orderLooksLikeCredit } = require("../../src/scrapers/creditShape");

const CENT = 0.015;

// "00123-A" / "inv 123a" / "123A" all compare equal: alphanumerics only, no
// leading zeros. Statements and Sage disagree on punctuation and padding far
// more often than on the number itself.
function normDoc(v) {
  return String(v ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/^0+(?=\d)/, "");
}

const num = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(/[$,]/g, ""));
  return Number.isFinite(n) ? n : null;
};

const isEntered = (order) =>
  order.enteredInSage === true || Boolean(order.journalEntry || order.journal_entry);

// Every field an order can carry a vendor document number in. `reference` is
// deliberately excluded for most vendors: it is OUR order key (LL9999), not the
// supplier's invoice number, and matching on it would hide a genuinely missing
// invoice — the same rule collectKnownInvoiceNumbers follows.
// Legacy orders carry a stand-in instead of a real supplier number.
const PLACEHOLDER_DOCS = new Set(["MANUAL", "NA", "NONE", "TBD"]);

const DOC_FIELDS = ["source_invoice", "sage_reference_synced", "sage_reference", "invoiceNum", "creditMemoNumber", "worldCreditMemoNumber"];

// The date the SUPPLIER issued the document. Deliberately not archivedAt /
// sage_processed_at: those are when WE finished with it, weeks later, and using
// them put June invoices inside July's statement window. And not `orderDate`
// first either — older Transbec records have it a month late for French "juin"
// (read as juillet), while the raw source text beside it is right. So the raw
// text wins and orderDate is the last resort.
const MONTH_PREFIX = [
  ["ja", 1], ["fe", 2], ["mar", 3], ["av", 4], ["ap", 4], ["mai", 5], ["may", 5],
  ["juin", 6], ["jun", 6], ["juil", 7], ["jul", 7], ["ao", 8], ["au", 8],
  ["se", 9], ["oc", 10], ["no", 11], ["de", 12],
];
function rawDateToIso(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s); // MM/DD/YYYY — how the scrapers standardise it
  if (m) return `${m[3]}-${String(m[1]).padStart(2, "0")}-${String(m[2]).padStart(2, "0")}`;
  m = /^([A-Za-z\u00c0-\u017f]{3,})\.?\s*(\d{1,2}),\s*(\d{2,4})/.exec(s);
  if (m) {
    const name = m[1].normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    const hit = MONTH_PREFIX.find(([p]) => name.startsWith(p));
    if (hit) return `${m[3].length === 2 ? 2000 + Number(m[3]) : m[3]}-${String(hit[1]).padStart(2, "0")}-${String(m[2]).padStart(2, "0")}`;
  }
  return "";
}

function orderDate(o) {
  for (const c of [o.creditDate, o.invoiceDate, o.dateTimestamp, o.orderDateRaw]) {
    const iso = rawDateToIso(c);
    if (iso) return iso;
  }
  const t = Date.parse(o.orderDate || o.date || "");
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : "";
}

// Normalise active + archived orders and manifest rows into one record shape.
function toRecord(o, origin, matchReference = false) {
  const billed = num(o.billed_total ?? o.billedTotal);
  const sageTotal = num(o.sage_total_synced ?? o.sageTotalSynced);
  const credit = orderLooksLikeCredit(o) || (billed !== null && billed < 0);
  // Tiger quotes our order reference on its statement, so for it `reference` IS the document number.
  const fields = matchReference ? [...DOC_FIELDS, "reference"] : DOC_FIELDS;
  const docs = [...new Set(fields.map((f) => normDoc(o[f])).filter((d) => d && !PLACEHOLDER_DOCS.has(d)))];
  // Archived orders and manifest rows were only archivable once Sage held them.
  const entered = origin === "active" ? isEntered(o) : true;
  return {
    origin,
    reference: o.reference || "",
    docs,
    invoice: o.source_invoice || o.sage_reference_synced || o.invoiceNum || "",
    // Compare on magnitude: Sage returns credits without a minus sign and the
    // older credit pipelines stored billed_total positive, so sign lives in `credit`.
    billed: billed === null ? null : Math.abs(billed),
    sage: sageTotal === null ? null : Math.abs(sageTotal),
    credit,
    entered,
    date: orderDate(o),
    // Legacy orders keep a stand-in ("manual") where the supplier's number belongs:
    // they can't be expected on a statement by number, so the reverse check skips them.
    placeholder: PLACEHOLDER_DOCS.has(normDoc(o.source_invoice)),
  };
}

// `links`: [{ reference, invoiceNumber }] read from the invoice emails we already
// fetched. An order is often entered in Sage BEFORE its invoice email arrives, so its
// invoice field holds junk or nothing - but the email names the order (packing slip =
// our reference) and the supplier's invoice number, which is the statement's number.
function buildRecords({ supplierId, orders = [], archive = [], manifests = [], matchReference = false, links = [] }) {
  const out = [];
  const push = (list, origin) =>
    (list || []).forEach((o) => {
      if (o && supplierIdForOrder(o) === supplierId) out.push(toRecord(o, origin, matchReference));
    });
  push(orders, "active");
  push(archive, "archive");
  const byRef = new Map();
  out.forEach((r) => r.reference && byRef.set(String(r.reference).toUpperCase(), [...(byRef.get(String(r.reference).toUpperCase()) || []), r]));
  (links || []).forEach((l) => {
    const doc = normDoc(l.invoiceNumber);
    if (!doc) return;
    (byRef.get(String(l.reference || "").toUpperCase()) || []).forEach((r) => {
      if (!r.docs.includes(doc)) r.docs.push(doc);
    });
  });
  // Manifest rows have no vendor text of their own — the caller tags them with
  // the supplier of the folder they came from.
  (manifests || []).forEach((m) => {
    if (!m || m.supplierId !== supplierId) return;
    const billed = num(m.billed_total);
    out.push({
      origin: "manifest",
      reference: m.reference || "",
      docs: [normDoc(m.invoice_number)].filter(Boolean),
      invoice: m.invoice_number || "",
      billed: billed === null ? null : Math.abs(billed),
      sage: null,
      credit: billed !== null && billed < 0,
      entered: true,
      date: "", // archived_at is when we filed it, not when it was issued
    });
  });
  return out;
}

// Edit distance, capped — only ever used on short document numbers.
function editDistance(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

const better = (a, b) => (a.entered !== b.entered ? (a.entered ? a : b) : a.origin === "active" ? b : a);

const dayDiff = (a, b) => Math.abs(Date.parse(a) - Date.parse(b)) / 86400000;

function reconcileStatement(statement, records) {
  const byDoc = new Map();
  (records || []).forEach((r) =>
    r.docs.forEach((d) => {
      if (!byDoc.has(d)) byDoc.set(d, []);
      byDoc.get(d).push(r);
    })
  );

  const used = new Set();
  const rows = (statement?.lines || []).map((line) => {
    const base = { ...line, key: normDoc(line.docNumber) };
    if (line.type === "payment") return { ...base, status: "payment", note: "Payment — not reconciled" };
    // Finance charges and the like: nothing in our order store to match them to.
    if (line.type === "fee") return { ...base, status: "fee", note: "Fee — not reconciled" };

    const found = byDoc.get(base.key) || [];
    found.forEach((r) => used.add(r));
    if (!found.length) {
      // A settled pair (debited and credited on the statement itself) owes nothing -
      // worth showing, not worth alarming over.
      if (line.settled) return { ...base, status: "settled", note: "Already settled on the statement; no record of it here." };
      return { ...base, status: "missing", note: "On the statement, but we have no record of this document." };
    }
    const entered = found.filter((r) => r.entered);
    if (!entered.length) {
      const r = found[0];
      return { ...base, status: "not-entered", ourReference: r.reference, ourTotal: r.billed, note: "We have the order, but it is not in Sage yet." };
    }
    const rec = entered.reduce(better);
    const stmtCredit = line.type === "credit";
    const ours = rec.sage ?? rec.billed;
    const result = { ...base, ourReference: rec.reference, ourTotal: ours, ourOrigin: rec.origin };
    if (stmtCredit !== rec.credit) {
      return { ...result, status: "type", note: `Statement shows a ${stmtCredit ? "credit" : "charge"}; we have it as a ${rec.credit ? "credit" : "charge"}.` };
    }
    if (ours === null) return { ...result, status: "matched", note: "In Sage (no total on file to compare)." };
    const diff = Math.abs(Math.abs(line.amount) - ours);
    if (diff <= CENT) return { ...result, status: "matched", note: "" };
    // A second record at the right amount (billed vs Sage) clears it.
    if (rec.billed !== null && Math.abs(Math.abs(line.amount) - rec.billed) <= CENT) {
      return { ...result, status: "matched", note: "Matches the invoice total; Sage differs." };
    }
    return { ...result, status: "amount", diff: Math.round((Math.abs(line.amount) - ours) * 100) / 100, note: `Statement ${Math.abs(line.amount).toFixed(2)} vs Sage ${ours.toFixed(2)}.` };
  });

  // Near-miss pass. A "missing" line is very often an invoice we DO have, keyed
  // into Sage with a typo (I for L, a dropped digit). If an entered record we
  // have not otherwise matched has a document number within 2 edits and about
  // the same money, say so instead of calling the invoice absent.
  rows.forEach((row) => {
    if (row.status !== "missing") return;
    const wantCredit = row.type === "credit";
    const cand = (records || [])
      .filter((r) => !used.has(r) && r.entered && r.docs.length && r.credit === wantCredit)
      .map((r) => ({ r, d: Math.min(...r.docs.map((d) => editDistance(d, row.key))), m: r.sage ?? r.billed }))
      .filter((c) => c.d <= 2 && c.m !== null && Math.abs(Math.abs(row.amount) - c.m) <= 0.05)
      .sort((a, b) => a.d - b.d)[0];
    // No similar number at all? An order entered under the wrong KIND of number
    // (CBK: our order number used as the invoice number) shares nothing with the
    // real one, but still has the same money to the cent within a few days (orders
    // are dated when placed, statements when invoiced). Only
    // trusted when exactly one such record exists, so two same-day same-price
    // invoices can't be cross-matched.
    let found = cand;
    if (!found && row.date) {
      const same = (records || []).filter((r) =>
        !used.has(r) && r.entered && r.docs.length && r.credit === wantCredit && r.date && dayDiff(r.date, row.date) <= 5 &&
        (r.sage ?? r.billed) !== null && Math.abs(Math.abs(row.amount) - (r.sage ?? r.billed)) <= CENT);
      const refs = new Set(same.map((r) => r.reference));
      if (refs.size === 1) found = { r: same[0], d: 99, m: same[0].sage ?? same[0].billed, byAmount: true };
    }
    if (!found) return;
    // Both the live and the archived copy of the same order are one document.
    (records || []).forEach((r) => { if (r.reference && r.reference === found.r.reference) used.add(r); });
    used.add(found.r);
    const diff = Math.round((Math.abs(row.amount) - found.m) * 100) / 100;
    row.status = "number";
    row.ourReference = found.r.reference;
    row.ourTotal = found.m;
    row.ourInvoice = found.r.invoice;
    row.note =
      (found.byAmount
        ? `Probably order ${found.r.reference || "?"} (same amount, within days), but its invoice number is “${found.r.invoice}”, not “${row.docNumber}”.`
        : `Probably order ${found.r.reference || "?"}: we have invoice “${found.r.invoice}”, the supplier says “${row.docNumber}”.`) +
      (Math.abs(diff) > CENT ? ` Amount also differs by ${diff.toFixed(2)}.` : "");
  });

  // Reverse pass — only records we can place inside the statement's window.
  // The statement's own month. An open-item statement drops invoices once they are
  // paid, so anything older than the month can legitimately be absent.
  const dates = rows.map((r) => r.date).filter(Boolean).sort();
  const to = statement?.statementDate || dates[dates.length - 1] || "";
  const from = to ? `${to.slice(0, 7)}-01` : dates[0] || "";
  const notOnStatement = [];
  const seen = new Set();
  let undated = 0;
  (records || []).forEach((r) => {
    if (used.has(r) || !r.entered || !r.docs.length || r.placeholder) return;
    // The same order can sit in both the live list and the archive.
    const dupKey = `${r.reference}|${r.docs[0]}`;
    if (seen.has(dupKey)) return;
    seen.add(dupKey);
    if (!r.date) { undated += 1; return; }
    if (from && r.date >= from && (!to || r.date <= to)) notOnStatement.push(r);
  });

  const count = (s) => rows.filter((r) => r.status === s).length;
  return {
    rows,
    notOnStatement: notOnStatement.map((r) => ({
      docNumber: r.invoice, reference: r.reference, date: r.date, total: r.billed ?? r.sage, credit: r.credit, origin: r.origin,
    })),
    undatedSkipped: undated,
    summary: {
      lines: rows.length,
      matched: count("matched"),
      missing: count("missing"),
      amount: count("amount"),
      type: count("type"),
      number: count("number"),
      notEntered: count("not-entered"),
      payments: count("payment"),
      fees: count("fee"),
      settled: count("settled"),
      notOnStatement: notOnStatement.length,
      problems: count("missing") + count("amount") + count("type") + count("number") + count("not-entered") + notOnStatement.length,
    },
  };
}

module.exports = { reconcileStatement, buildRecords, normDoc };
