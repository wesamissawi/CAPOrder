// src/statements/statementParse.js
// Turns a supplier statement (PDF, or an HTML table in the email body) into rows:
// { date, docNumber, type, amount }.
//
// Statements are laid out differently by every supplier, so this is a
// LAYOUT-AGNOSTIC reader, not a per-supplier template. It works on printed rows
// (real x/y positions from pdfjs, same source the invoice parsers use, so glued
// cells can't confuse it) and is driven by the statement's own COLUMN HEADERS:
//   - a page is only read below a header row (a row naming a date column and an
//     invoice/reference column) - Interstate attaches 20 pages of ticket copies
//     behind the ledger and those must not become lines;
//   - money is assigned to the header it sits under (debit / credit / balance),
//     so a DISCOUNT column, a running balance or the remittance stub's repeated
//     amounts can't be mistaken for the line amount;
//   - a row is a transaction when it carries a document number and an amount.
// Validated on Transbec, CBK, Proforce, BestBuy, Interstate (PDF) and Tiger (HTML).
const { getPageRows } = require("../scrapers/bestbuyInvoice.actions");

const MONEY_RE = /^\(?-?\$?\d{1,3}(?:,\d{3})*\.\d{2}\)?-?(?:\s?CR)?$|^\(?-?\$?\d+\.\d{2}\)?-?(?:\s?CR)?$/i;
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

// Parse one money cell. Negative = leading "-", trailing "-", parentheses or CR.
function parseMoney(raw) {
  const s = String(raw || "").trim();
  if (!MONEY_RE.test(s)) return null;
  const neg = /^\(.*\)$/.test(s) || s.startsWith("-") || /-$/.test(s) || /CR$/i.test(s);
  const n = Number(s.replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(n)) return null;
  return neg ? -n : n;
}

const pad = (n) => String(n).padStart(2, "0");
function fullYear(y) {
  const n = Number(y);
  return n < 100 ? 2000 + n : n;
}

// Returns ISO "YYYY-MM-DD" or "". `order` says how an all-numeric date reads:
// "dmy" (default) or "mdy" — Transbec prints 10/01/26 for 1 Oct. It is a
// per-supplier setting because 03/04/26 is otherwise unknowable.
function parseDate(raw, order = "dmy") {
  const s = String(raw || "").trim();
  let m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(s);
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  m = /^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})$/.exec(s);
  if (m) {
    let d = Number(m[1]);
    let mo = Number(m[2]);
    if (order === "mdy") [d, mo] = [mo, d];
    if (mo > 12 && d <= 12) [d, mo] = [mo, d];
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return "";
    return `${fullYear(m[3])}-${pad(mo)}-${pad(d)}`;
  }
  m = /^(\d{1,2})[-\s]([A-Za-z]{3})[A-Za-z]*[-\s,]*(\d{2,4})$/.exec(s);
  if (m && MONTHS[m[2].toLowerCase()]) return `${fullYear(m[3])}-${pad(MONTHS[m[2].toLowerCase()])}-${pad(m[1])}`;
  m = /^([A-Za-z]{3})[A-Za-z]*\.?\s*(\d{1,2})[,\s]\s*(\d{2,4})$/.exec(s);
  if (m && MONTHS[m[1].toLowerCase()]) return `${fullYear(m[3])}-${pad(MONTHS[m[1].toLowerCase()])}-${pad(m[2])}`;
  return "";
}

const TYPE_WORDS = [
  { type: "credit", re: /\b(credit(?:\s*memo)?|cr\s*memo|c\/m|cm|crd|return|rtn)\b/i },
  { type: "payment", re: /\b(payment|pmt|paid|cheque|check|eft|received|rcvd|thank you)\b/i },
  { type: "invoice", re: /\b(invoice|inv)\b/i },
];

const STATEMENT_DATE_RE = /statement\s*(?:date|as\s*of)?\s*[:#]?/i;
const BALANCE_LABEL_RE =
  /please\s*pay\s*this\s*amount|total\s*balance|(?:total|balance|amount)\s*(?:due|owing|owed)|ending\s*balance|closing\s*balance|statement\s*balance|total\s*outstanding|net\s*balance/i;
const SKIP_ROW_RE = /balance\s*forward|previous\s*balance|opening\s*balance|brought\s*forward/i;

// A document number is an alphanumeric token with at least one digit and at
// least 4 characters that is not a date or an amount. Letter-only words
// ("INVOICE", "PAYMENT") and short column fragments are not doc numbers.
function looksLikeDocNumber(tok, order) {
  const t = String(tok || "").trim();
  if (t.length < 4 || t.length > 20) return false;
  if (!/\d/.test(t)) return false;
  if (/^\d{1,2}(st|nd|rd|th)$/i.test(t)) return false; // "10th OF MONTH" in a footer
  if (!/^[A-Za-z0-9][A-Za-z0-9\-_/.]*$/.test(t)) return false;
  if (parseMoney(t) !== null) return false;
  if (/\.\d{2}/.test(t)) return false; // glued money cells ("1153.011153.01")
  if (parseDate(t, order)) return false;
  return true;
}

// Join text items that sit next to each other so "Credit" "Memo" or a date split
// across cells ("14 Nov 2026") is read as one token. Items closer than ~1.5 char
// widths are one cell; anything wider is a column gap.
function rowToCells(items) {
  const cells = [];
  let cur = null;
  let prev = null;
  for (const it of items) {
    const str = it.str.trim();
    if (!str) continue;
    // Bold text is often drawn twice at the same spot; read it once, or "1848.95"
    // comes out as "1848.951848.95".
    if (prev && prev.str === str && Math.abs(prev.x - it.x) < 2) continue;
    prev = { str, x: it.x };
    const prevEnd = cur ? cur.x + cur.w : 0;
    const charW = it.w && it.str.length ? it.w / it.str.length : 4;
    if (cur && it.x - prevEnd <= charW * 1.5) {
      cur.str += (it.x - prevEnd > charW * 0.4 ? " " : "") + str;
      cur.w = it.x + it.w - cur.x;
    } else {
      cur = { str, x: it.x, w: it.w || 0 };
      cells.push(cur);
    }
  }
  return cells;
}

// Split a cell that holds several whitespace-separated tokens ("INV 10443211")
// back into tokens — doc number and type words often share a cell.
const tokens = (cells) => cells.flatMap((c) => c.str.split(/\s+/)).filter(Boolean);

// One-letter ledger codes. CBK: I invoice, B charge, D debit note, A adjustment,
// C credit note, U unapplied cash. Interstate: T ticket, P payment, F finance
// charge. (A follows the amount's sign.)
const CODE_TYPES = { I: "invoice", B: "invoice", D: "invoice", T: "invoice", C: "credit", U: "payment", P: "payment", F: "fee" };

function classifyType(text, amount) {
  const code = (String(text).match(/(?:^|\s)([ICDABUTPF])(?=\s|$)/) || [])[1];
  if (code && CODE_TYPES[code]) return CODE_TYPES[code];
  for (const { type, re } of TYPE_WORDS) if (re.test(text)) return type;
  if (amount !== null && amount < 0) return "credit";
  return "invoice";
}


// Money cell -> number, tolerant of "$1,179.66" and "( $569.52 )" spacing.
const cellMoney = (c) => parseMoney(c.str.replace(/\s+/g, ""));

// A column-header row names a date column AND an invoice/reference column and has
// several titles. Returns the columns we care about plus EVERY other header
// position (so a value sitting under GST or DISCOUNT competes for its own column
// instead of being swept into the nearest column we happen to know). Only the
// first occurrence of a role is kept: the remittance stub repeats the headers.
function readHeaderColumns(row) {
  const items = row.items.filter((it) => it.str && it.str.trim());
  if (items.length < 4) return null;
  const texts = items.map((it) => it.str.trim());
  if (!texts.some((t) => /date/i.test(t)) || !texts.some((t) => /inv|ref/i.test(t))) return null;
  const cols = {};
  items.forEach((it, idx) => {
    const t = it.str.trim();
    const edge = { x: it.x, r: it.x + (it.w || 0) };
    const role = /^(debits?|charges?|purchases?|amount|montant|inv\.?\s*amount)$/i.test(t)
      ? "debit"
      : /^credits?$/i.test(t)
        ? "credit"
        : /^bal(\.|ance)?\$?$/i.test(t)
          ? "balance"
          : null;
    if (role && !cols[role]) cols[role] = edge;
    else cols[`other${idx}`] = edge;
  });
  return cols;
}

// Assign each money cell to the nearest header (left edges for left-aligned
// numbers, right edges for right-aligned ones) and keep debit/credit/balance.
function assignMoney(cells, cols) {
  const out = {};
  for (const c of cells) {
    const v = cellMoney(c);
    if (v === null) continue;
    let best = null;
    let bd = Infinity;
    for (const [role, e] of Object.entries(cols)) {
      const d = Math.min(Math.abs(c.x - e.x), Math.abs(c.x + c.w - e.r));
      if (d < bd) { bd = d; best = role; }
    }
    if (best && bd <= 45 && ["debit", "credit", "balance"].includes(best) && !(best in out)) out[best] = v;
  }
  return out;
}

// `opts.dateOrder` - "dmy" | "mdy" (see parseDate).
// `opts.cols`      - header columns from readHeaderColumns, when known.
function parseRow(row, pageNo, opts = {}) {
  const order = opts.dateOrder || "dmy";
  const cells = rowToCells(row.items);
  const toks = tokens(cells);
  const text = toks.join(" ");
  const isOpeningRow = SKIP_ROW_RE.test(text);

  const amounts = [];
  let date = "";
  const words = [];
  for (let i = 0; i < toks.length; i++) {
    const tok = toks[i];
    // Re-join date pieces split on spaces ("14 Nov 2026", "Nov 14, 2026", "OCT 02,26").
    let joined = false;
    for (const n of [3, 2]) {
      const piece = toks.slice(i, i + n).join(" ");
      const d = parseDate(piece, order);
      if (!date && d && /[A-Za-z]/.test(piece)) {
        date = d;
        i += n - 1;
        joined = true;
        break;
      }
    }
    if (joined) continue;
    const d1 = parseDate(tok, order);
    if (d1) {
      if (!date) date = d1;
      continue;
    }
    const m = parseMoney(tok);
    if (m !== null) {
      amounts.push(m);
      continue;
    }
    // "CR" printed as its own cell right after an amount flips that amount.
    if (/^CR$/i.test(tok) && amounts.length) {
      amounts[amounts.length - 1] = -Math.abs(amounts[amounts.length - 1]);
      continue;
    }
    words.push(tok);
  }
  if (!amounts.length) return null;

  // "Balance forward" (or a bare "Balance" row): the opening figure, not a document.
  if (isOpeningRow || (words.length === 1 && /^balance$/i.test(words[0]))) {
    return { opening: amounts[0] };
  }

  const docNumber = words.find((w) => looksLikeDocNumber(w, order)) || "";
  if (!docNumber) return null; // no document to reconcile on - header/total rows

  const m = opts.cols ? assignMoney(cells, opts.cols) : {};
  const hasD = m.debit !== undefined;
  const hasC = m.credit !== undefined;
  let amount;
  let paid = 0;
  if (hasD && hasC && m.debit !== 0) {
    // Debit AND credit on one row: an invoice already paid off by a matching credit
    // (Proforce keeps settled items on the statement until month end).
    amount = m.debit;
    paid = Math.abs(m.credit);
  } else if (hasD) {
    amount = m.debit;
  } else if (hasC) {
    amount = -Math.abs(m.credit);
  } else {
    amount = amounts[0];
  }

  const type = classifyType(words.filter((w) => w !== docNumber).join(" "), amount);
  // Credits and payments are printed without a sign on some statements.
  const signed = type === "credit" || type === "payment" ? -Math.abs(amount) : amount;
  return {
    date, docNumber, type, amount: signed, amounts, text, page: pageNo,
    ...(paid ? { paid, settled: Math.abs(paid - Math.abs(signed)) <= 0.015 } : {}),
    ...(m.balance !== undefined ? { balance: m.balance } : {}),
  };
}

function readStatementMeta(pageRows, order) {
  let statementDate = "";
  let balance = null;
  const flat = pageRows.flat();
  const dateAt = (t, k) =>
    parseDate(t.slice(k, k + 3).join(" "), order) ||
    parseDate(t.slice(k, k + 2).join(" "), order) ||
    parseDate(t[k], order);
  for (let i = 0; i < flat.length; i++) {
    const toks = tokens(rowToCells(flat[i].items));
    const text = toks.join(" ");
    if (!statementDate) {
      // "Date: 10/31/26" / "Statement Date: OCT 31,2026" / "AS OF: 10-31-26" - a
      // labelled date. Matched on the joined text: the extractor may glue label to value.
      const lab = /\b(?:date|as\s*of)\s*:\s*(\S+(?:\s+\S+){0,2})/i.exec(text);
      if (lab) {
        const t = lab[1].split(/\s+/);
        for (let k = 0; k < t.length && !statementDate; k++) statementDate = dateAt(t, k);
      }
      if (!statementDate && STATEMENT_DATE_RE.test(text)) {
        // Or the date is on this row or the next one down.
        for (const r of [flat[i], flat[i + 1]].filter(Boolean)) {
          const t = tokens(rowToCells(r.items));
          for (let k = 0; k < t.length && !statementDate; k++) statementDate = dateAt(t, k);
          if (statementDate) break;
        }
      }
    }
    // "MON DAY YEAR CUSTOMER#" header, with the date in numbers on the next row.
    if (!statementDate && /\bMON\b.*\bDAY\b.*\bYEAR\b/.test(text) && flat[i + 1]) {
      const n = tokens(rowToCells(flat[i + 1].items));
      const [mo, d, y] = [n[0], n[1], n[2]];
      if (/^\d{1,2}$/.test(mo) && /^\d{1,2}$/.test(d) && /^\d{4}$/.test(y)) statementDate = parseDate(`${mo}/${d}/${y}`, "mdy");
    }
    if (BALANCE_LABEL_RE.test(text)) {
      const here = toks.map(parseMoney).filter((n) => n !== null);
      const next = tokens(rowToCells((flat[i + 1] || { items: [] }).items)).map(parseMoney).filter((n) => n !== null);
      const found = here.length ? here[here.length - 1] : next.length ? next[next.length - 1] : null;
      if (found !== null) balance = found; // last label wins: the closing figure is printed last
    }
  }
  return { statementDate, balance };
}

const round2 = (n) => Math.round(n * 100) / 100;

// Shared by the PDF and HTML readers: `pageRows` is pages -> rows -> {items}.
function parseLedger(pageRows, opts = {}) {
  const order = opts.dateOrder || "dmy";
  const lines = [];
  let opening = 0;
  let lastBalance = null;
  pageRows.forEach((rows, p) => {
    let cols = null; // each page repeats its own header; no header, no ledger
    rows.forEach((row) => {
      const hc = readHeaderColumns(row);
      if (hc) { cols = hc; return; }
      if (!cols) return;
      const parsed = parseRow(row, p + 1, { dateOrder: order, cols });
      if (!parsed) return;
      if (parsed.opening !== undefined) { opening += parsed.opening; return; }
      lines.push(parsed);
      if (parsed.balance !== undefined) lastBalance = parsed.balance;
    });
  });
  const meta = readStatementMeta(pageRows, order);
  // Some statements (Interstate) print no "balance due" label - the last running
  // balance in the ledger is the closing figure.
  const balance = meta.balance !== null ? meta.balance : lastBalance;
  const warnings = [];
  if (!lines.length) warnings.push("No invoice/credit rows could be recognised on this statement.");
  if (!meta.statementDate) warnings.push("Statement date not found - using the email date.");
  // The ledger should add up to the balance the supplier asks for (a settled
  // debit+credit pair nets to zero). When it doesn't, a row was missed or misread
  // - say so rather than reconcile on it.
  const net = round2(lines.reduce((a, l) => a + l.amount - (l.paid || 0), 0));
  if (balance !== null && lines.length && Math.abs(round2(opening + net) - balance) > 0.015) {
    warnings.push(
      `Lines add up to ${round2(opening + net).toFixed(2)}` +
        (opening ? ` (including ${opening.toFixed(2)} brought forward)` : "") +
        ` but the statement balance is ${balance.toFixed(2)} - some rows may have been missed or misread.`
    );
  }
  return { lines, statementDate: meta.statementDate, balance, opening, lineTotal: net, warnings };
}

async function parseStatementPdf(pdfBuffer, opts = {}) {
  const pageRows = await getPageRows(pdfBuffer);
  const textItems = pageRows.reduce((n, rows) => n + rows.length, 0);
  if (!textItems) {
    return { lines: [], statementDate: "", balance: null, warnings: ["This PDF has no text layer (scanned image) - it can't be read."] };
  }
  return parseLedger(pageRows, opts);
}

const HTML_ENTITIES = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decodeEntities = (s) =>
  s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (all, e) => {
    if (e[0] === "#") {
      const n = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : all;
    }
    return HTML_ENTITIES[e.toLowerCase()] ?? all;
  });

// An HTML statement (Tiger puts it in the email body) becomes the same row shape
// the PDF reader produces: one row per <tr>, one item per non-empty cell. Cells
// are spaced 1000 apart so they never merge, and every cell carries its column
// index as its x - a value therefore sits exactly under its own header.
function htmlToPageRows(html) {
  const clean = String(html || "").replace(/<(style|script)[\s\S]*?<\/\1>/gi, "");
  // Innermost rows only: layout emails nest tables, and an outer <tr> would swallow the inner ones.
  const trs = clean.match(/<tr(?:(?!<tr)[\s\S])*?<\/tr>/gi) || [];
  const rows = trs
    .map((tr) => {
      const cells = tr.match(/<t[dh][\s\S]*?<\/t[dh]>/gi) || [];
      const items = [];
      cells.forEach((c, idx) => {
        const str = decodeEntities(c.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
        if (str) items.push({ str, x: idx * 1000, y: 0, w: str.length * 5 });
      });
      return { items };
    })
    .filter((r) => r.items.length);
  return [rows];
}

async function parseStatementHtml(html, opts = {}) {
  const pageRows = htmlToPageRows(html);
  if (!pageRows[0].length) return { lines: [], statementDate: "", balance: null, warnings: ["The email body has no table to read."] };
  return parseLedger(pageRows, opts);
}

module.exports = { parseStatementPdf, parseStatementHtml, parseRow, parseMoney, parseDate, looksLikeDocNumber };
