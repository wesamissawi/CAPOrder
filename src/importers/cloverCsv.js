// Reads Clover's "Payments" CSV export (Reporting -> Payments -> Export) into
// the same payment candidates the Payment Management view used to get by
// scraping the dashboard. The export is authoritative: every field we used to
// squint at rendered HTML for (card brand, last 4, payment id, approved or
// declined) is its own column here, so there is no detail-page second pass and
// no guessing at what a row means.
//
// Nothing in here touches disk or Electron — it takes CSV text and gives back
// rows, so the IPC layer owns the file dialog and the scrape ledger.

// RFC4180 enough for Clover: quoted fields, doubled quotes inside them, CRLF or
// LF line ends. Written by hand rather than pulled in as a dependency because
// this is the only CSV the app will ever read.
function parseCsvRows(text) {
  const s = String(text || '').replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let started = false;

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      started = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
      started = true;
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      started = false;
    } else if (c === '\r') {
      // swallowed; the \n that follows is what ends the row
    } else {
      field += c;
      started = true;
    }
  }
  if (started || field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  // A trailing blank line from the export shouldn't look like an empty payment.
  return rows.filter((r) => r.some((cell) => String(cell).trim() !== ''));
}

// "# Refunds" -> "refunds", "Payment Date" -> "paymentdate". Loose on purpose:
// Clover has renamed and reordered these columns before, and a header that
// drifts by a space or a symbol shouldn't break the import.
const normalizeHeader = (h) =>
  String(h || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');

const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

function toDateKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// The export writes "19-Aug-2026 12:57 PM EDT". ISO and M/D/YYYY are accepted
// too, since Clover's date format follows the merchant's locale setting.
// Returns a local YYYY-MM-DD, or "" when the cell holds nothing date-like — an
// undated row is imported and flagged rather than silently dated today.
function parseCsvDate(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';

  const dayFirst = s.match(
    /\b(\d{1,2})[-/\s](jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[-/\s](\d{2,4})\b/i
  );
  if (dayFirst) {
    const day = Number(dayFirst[1]);
    const month = MONTHS[dayFirst[2].toLowerCase()];
    let year = Number(dayFirst[3]);
    if (year < 100) year += 2000;
    return toDateKey(new Date(year, month, day));
  }

  const iso = s.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  const slash = s.match(/\b(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})\b/);
  if (slash) {
    const month = Number(slash[1]);
    const day = Number(slash[2]);
    let year = Number(slash[3]);
    if (year < 100) year += 2000;
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return toDateKey(new Date(year, month - 1, day));
    }
  }

  const named = s.match(
    /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?[-/\s]\s*(\d{1,2})(?:,?\s*(\d{4}))?/i
  );
  if (named) {
    const month = MONTHS[named[1].toLowerCase()];
    const day = Number(named[2]);
    const year = named[3] ? Number(named[3]) : new Date().getFullYear();
    return toDateKey(new Date(year, month, day));
  }

  return '';
}

function parseCsvTime(raw) {
  const m = String(raw || '').match(/\b(\d{1,2}:\d{2}(?::\d{2})?\s*(?:am|pm)?)\b/i);
  return m ? m[1].toUpperCase().replace(/\s+/g, ' ') : '';
}

function parseMoney(raw) {
  const s = String(raw || '').replace(/[^0-9.-]/g, '');
  if (!s || s === '-' || s === '.') return NaN;
  return Number(s);
}

// Brand before tender: a "Debit Card" tender carrying an MC brand is a
// Mastercard debit card, which settles as Mastercard, not as Interac.
const BRAND_TO_TYPE = [
  [/^interac$/i, 'Interac'],
  [/visa/i, 'VISA'],
  [/^mc$/i, 'MasterCard'],
  [/master\s*-?\s*card|mastercard/i, 'MasterCard'],
];

// Tenders that aren't terminal card money. They're read and reported, but they
// don't belong in payments.json: cash is handled by the sale itself, and a gift
// card isn't a payment type this app tracks.
const NON_CARD_TENDER = /cash|gift|check|cheque|external/i;

function typeFromRow(brand, tender) {
  const b = String(brand || '').trim();
  for (const [re, type] of BRAND_TO_TYPE) {
    if (re.test(b)) return type;
  }
  // No usable brand: a debit tender is Interac in every Canadian Clover export
  // we've seen. Anything else is left visible as Unknown to be corrected from
  // the payment's Edit form rather than guessed at.
  if (/debit/i.test(String(tender || '')) && !b) return 'Interac';
  return 'Unknown';
}

const detectLast4 = (raw) => {
  const digits = String(raw || '').replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(-4) : '';
};

// text -> { ok, rows, skippedNoId }. Every row of the export comes back,
// including the ones that shouldn't be imported: the caller decides what to do
// with declined and non-card rows, and has to see them to ledger them.
function parseCloverCsv(text) {
  const table = parseCsvRows(text);
  if (!table.length) return { ok: false, error: 'That file is empty.' };

  const headers = table[0].map(normalizeHeader);
  const idx = (...names) => {
    for (const n of names) {
      const i = headers.indexOf(n);
      if (i !== -1) return i;
    }
    return -1;
  };

  const cols = {
    paymentId: idx('paymentid'),
    date: idx('paymentdate', 'orderdate', 'date'),
    amount: idx('amount'),
    tender: idx('tender'),
    brand: idx('cardbrand'),
    cardNumber: idx('cardnumber'),
    result: idx('result'),
    refunds: idx('refunds'),
    refundAmount: idx('refundamount'),
    invoice: idx('invoicenumber'),
    transaction: idx('transaction', 'transactionnumber'),
    customer: idx('customername'),
    orderId: idx('orderid'),
  };

  if (cols.paymentId === -1 || cols.amount === -1) {
    return {
      ok: false,
      error:
        'That doesn\'t look like a Clover payments export — it has no "Payment ID" and "Amount" columns.',
    };
  }

  const at = (row, key) => (cols[key] === -1 ? '' : String(row[cols[key]] ?? '').trim());
  const rows = [];
  const skippedNoId = [];

  for (let r = 1; r < table.length; r++) {
    const row = table[r];
    const externalId = at(row, 'paymentId');
    const amount = parseMoney(at(row, 'amount'));

    // A row with no payment id can't be ledgered, and a row we can't ledger
    // would come back on every later import of an overlapping export.
    if (!externalId || !Number.isFinite(amount)) {
      if (row.join('').trim()) skippedNoId.push(r + 1);
      continue;
    }

    const when = at(row, 'date');
    const tender = at(row, 'tender');
    const brand = at(row, 'brand');
    const result = at(row, 'result');
    const refundAmount = parseMoney(at(row, 'refundAmount'));
    const refundCount = Number(at(row, 'refunds')) || 0;

    rows.push({
      externalId,
      amount: Number(amount.toFixed(2)),
      date: parseCsvDate(when),
      time: parseCsvTime(when),
      type: typeFromRow(brand, tender),
      last4: detectLast4(at(row, 'cardNumber')),
      tender,
      brand,
      result,
      // Clover records anything that didn't settle in Result; only SUCCESS is
      // money that actually arrived. A blank Result is treated as success so a
      // column rename can't silently swallow a day's takings.
      isDeclined: !/^success$/i.test(result || 'SUCCESS'),
      isNonCard: NON_CARD_TENDER.test(tender),
      refundCount,
      refundAmount: Number.isFinite(refundAmount) ? Number(refundAmount.toFixed(2)) : 0,
      invoiceNumber: at(row, 'invoice'),
      transactionNumber: at(row, 'transaction'),
      customer: at(row, 'customer'),
      orderId: at(row, 'orderId'),
      line: r + 1,
    });
  }

  return { ok: true, rows, skippedNoId };
}

module.exports = {
  parseCloverCsv,
  parseCsvRows,
  parseCsvDate,
  parseCsvTime,
  typeFromRow,
};
