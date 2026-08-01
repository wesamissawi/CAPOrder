// src/scrapers/clover.actions.js
//
// Parsing helpers for the Clover payment scrape. Unlike every other scraper in
// this folder, nothing here logs in or navigates to the list: the user drives
// the browser themselves and we only read the transaction page already on
// screen (see cloverScraper.js for why).
//
// Clover's dashboard renders the transaction list inside an iframe
// (#ember-outlet > .iframe-container > iframe), so every read has to run
// per-frame, not just on the top document.

// ---------------------------------------------------------------------------
// In-page harvester. Serialized and run inside the Clover frame by
// frame.evaluate(), so it must be fully self-contained — no closures over
// anything in this module, no require().
// ---------------------------------------------------------------------------
function harvestTransactionRows() {
  const MONEY_RE = /(?:-|\()?\s*(?:CA)?\$\s*\d{1,3}(?:,\d{3})*(?:\.\d{2})?/;
  const HINT_RE =
    /visa|master\s*-?card|interac|debit|amex|american express|discover|gift\s*card|\bcash\b|refund|approved|payment/i;
  const DATEISH_RE =
    /\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b|\b\d{4}-\d{2}-\d{2}\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2}\b|\b\d{1,2}:\d{2}\s*(am|pm)?\b|\btoday\b|\byesterday\b/i;

  const clean = (node) => {
    const raw = node && (node.innerText || node.textContent) ? node.innerText || node.textContent : '';
    return String(raw).replace(/\s+/g, ' ').trim();
  };
  const isHeaderCell = (cell) =>
    cell.tagName === 'TH' || cell.getAttribute('role') === 'columnheader';
  // Positions must survive verbatim — an empty cell that gets dropped shifts
  // every later column out from under the header index, which is how the
  // "Amount" slot ends up reading the Tip column.
  const cellsOf = (row) => {
    const tds = row.querySelectorAll('td, th, [role="cell"], [role="gridcell"]');
    if (tds.length) return Array.prototype.slice.call(tds).map(clean);
    return Array.prototype.slice.call(row.children).map(clean);
  };

  // Header labels are what let us tell Amount from Tax or Fee and Tip Amount,
  // so look harder than <thead>: tables with a sticky header keep it in a
  // separate table above the body rows, where table.querySelector('thead')
  // finds nothing at all.
  const headersFor = (table, link) => {
    const grab = (nodes) => Array.prototype.slice.call(nodes).map(clean);
    if (table) {
      let hc = table.querySelectorAll('thead th, thead td');
      if (!hc.length) hc = table.querySelectorAll('[role="columnheader"]');
      if (!hc.length) {
        const firstRow = table.querySelector('tr');
        if (firstRow && firstRow.querySelectorAll('th').length) hc = firstRow.querySelectorAll('th');
      }
      if (hc.length) return grab(hc);
    }
    let node = table || link;
    for (let up = 0; up < 6 && node && node.parentElement; up++) {
      node = node.parentElement;
      const hc = node.querySelectorAll('thead th, thead td, [role="columnheader"]');
      if (hc.length) return grab(hc);
    }
    return [];
  };

  const groups = [];

  // --- Strategy 1 (preferred): anchor on the per-row "Details" link ---------
  // Clover marks it with test-id="tr-link-viewDetails" and its href carries the
  // payment id (/transactions/m/<MID>/payments/PMGKPG3HGTVZM). That id is the
  // only stable identity a row has, and it's what the scrape ledger keys on, so
  // a row without one is worth nothing to us.
  const detailLinks = Array.prototype.slice.call(
    document.querySelectorAll(
      'a[test-id="tr-link-viewDetails"], a[data-test-id="tr-link-viewDetails"], a[data-testid="tr-link-viewDetails"]'
    )
  );
  if (detailLinks.length) {
    const rows = [];
    const seenRows = [];
    for (let i = 0; i < detailLinks.length; i++) {
      const link = detailLinks[i];
      const href = link.getAttribute('href') || '';

      // The row is normally a <tr>; fall back to climbing until an ancestor
      // holds an amount, which is what makes it a row rather than a cell.
      let rowEl = link.closest ? link.closest('tr, [role="row"]') : null;
      if (!rowEl) {
        let node = link;
        for (let up = 0; up < 12 && node.parentElement; up++) {
          node = node.parentElement;
          const text = clean(node);
          if (text.length > 600) break;
          if (MONEY_RE.test(text)) {
            rowEl = node;
            break;
          }
        }
      }
      if (!rowEl || seenRows.indexOf(rowEl) !== -1) continue;
      seenRows.push(rowEl);

      let detailUrl = '';
      try {
        detailUrl = new URL(href, location.href).href;
      } catch {
        detailUrl = '';
      }

      rows.push({
        cells: cellsOf(rowEl),
        text: clean(rowEl),
        href,
        detailUrl,
        rowId: rowEl.getAttribute('data-id') || rowEl.getAttribute('id') || '',
      });
    }

    const table = detailLinks[0].closest
      ? detailLinks[0].closest('table, [role="table"], [role="grid"]')
      : null;
    const headers = headersFor(table, detailLinks[0]);
    if (rows.length) groups.push({ kind: 'details-link', headers, rows });
  }

  // --- Strategy 2: real <table>s and ARIA grids ----------------------------
  const tables = Array.prototype.slice.call(
    document.querySelectorAll('table, [role="table"], [role="grid"], [role="treegrid"]')
  );
  for (let t = 0; t < tables.length; t++) {
    const table = tables[t];
    let headers = [];
    const rows = [];

    const explicitHeaders = table.querySelectorAll('thead th, thead td, [role="columnheader"]');
    if (explicitHeaders.length) {
      headers = Array.prototype.slice.call(explicitHeaders).map(clean);
    }

    const rowNodes = Array.prototype.slice.call(table.querySelectorAll('tr, [role="row"]'));
    for (let r = 0; r < rowNodes.length; r++) {
      const tr = rowNodes[r];
      const cellNodes = Array.prototype.slice.call(
        tr.querySelectorAll('td, th, [role="cell"], [role="gridcell"], [role="columnheader"]')
      );
      if (!cellNodes.length) continue;
      const cells = cellNodes.map(clean);
      if (cellNodes.every(isHeaderCell)) {
        if (!headers.length) headers = cells;
        continue;
      }
      const text = clean(tr);
      if (!MONEY_RE.test(text)) continue;
      const link = tr.querySelector('a[href]');
      let detailUrl = '';
      if (link) {
        try {
          detailUrl = new URL(link.getAttribute('href'), location.href).href;
        } catch {
          detailUrl = '';
        }
      }
      rows.push({
        cells,
        text,
        href: link ? link.getAttribute('href') || '' : '',
        detailUrl,
        rowId: tr.getAttribute('data-id') || tr.getAttribute('id') || '',
      });
    }
    if (rows.length) groups.push({ kind: 'table', headers, rows });
  }

  // --- Strategy 3: card/list layouts (no table markup) ---------------------
  if (!groups.length) {
    const seen = [];
    const rows = [];
    const leaves = Array.prototype.slice.call(document.querySelectorAll('body *'));
    for (let i = 0; i < leaves.length; i++) {
      const el = leaves[i];
      if (el.children.length) continue;
      const own = clean(el);
      if (!own || own.length > 24 || !MONEY_RE.test(own)) continue;

      let node = el;
      let rowEl = null;
      for (let up = 0; up < 6 && node.parentElement; up++) {
        node = node.parentElement;
        const text = clean(node);
        if (text.length > 400) break;
        if (HINT_RE.test(text) || DATEISH_RE.test(text)) {
          rowEl = node;
          break;
        }
      }
      if (!rowEl || seen.indexOf(rowEl) !== -1) continue;
      seen.push(rowEl);

      const link = rowEl.querySelector('a[href]') || (rowEl.closest ? rowEl.closest('a[href]') : null);
      let detailUrl = '';
      if (link) {
        try {
          detailUrl = new URL(link.getAttribute('href'), location.href).href;
        } catch {
          detailUrl = '';
        }
      }
      const cells = cellsOf(rowEl);
      rows.push({
        cells: cells.length ? cells : [clean(rowEl)],
        text: clean(rowEl),
        href: link ? link.getAttribute('href') || '' : '',
        detailUrl,
        rowId: rowEl.getAttribute('data-id') || rowEl.getAttribute('id') || '',
      });
    }
    if (rows.length) groups.push({ kind: 'list', headers: [], rows });
  }

  // Counts of what the DOM actually offered, so a scrape that comes back empty
  // can say WHERE it went wrong (no links? no rows? rows but nothing parsable?)
  // instead of just "found nothing".
  const diag = {
    detailLinks: detailLinks.length,
    tables: tables.length,
    trs: document.querySelectorAll('tr').length,
    moneyCells: 0,
  };
  const allText = document.body ? String(document.body.innerText || '') : '';
  const moneyMatches = allText.match(/\$\s*\d/g);
  diag.moneyCells = moneyMatches ? moneyMatches.length : 0;

  return { url: location.href, title: document.title, groups, diag };
}

// Runs on a payment's own detail page. The card brand is NOT on this page at
// all — it lives on the printable receipt, which this page links to. Kept as a
// last-resort text scan only.
function harvestDetailText() {
  const body = document.body;
  const text = body ? String(body.innerText || body.textContent || '') : '';
  return { url: location.href, text: text.replace(/\s+/g, ' ').trim() };
}

// The "View Payment Receipt" link (/tx/p/<paymentId>?merchantUuid=<mid>), used
// when the receipt URL we built ourselves didn't pan out.
function findReceiptHref() {
  const a = document.querySelector('a[href*="/tx/p/"]');
  if (!a) return '';
  const href = a.getAttribute('href') || '';
  try {
    return new URL(href, location.href).href;
  } catch {
    return href;
  }
}

// Runs on the printable receipt — the one page that actually names the card.
// Note the markup: the "Card: MASTERCARD 7463" block lives inside
// #txDetails, which ships with style="display:none", so innerText will NEVER
// contain it. Everything here reads textContent for that reason, and the
// visible `.tender-types .label` is tried first.
function harvestReceiptInfo() {
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const out = { url: location.href, brandText: '', last4: '', paymentId: '', text: '' };

  const label = document.querySelector('.tender-types .label');
  if (label) out.brandText = clean(label.textContent);

  // The tender logo carries the brand in its alt text.
  if (!out.brandText) {
    const img = document.querySelector('.tender-img img[alt], .tender-types img[alt]');
    if (img) out.brandText = clean(img.getAttribute('alt'));
  }

  // Hidden details block: "Card: MASTERCARD 7463".
  if (!out.brandText) {
    const title = document.querySelector('#txDetails .order-details-title');
    if (title) out.brandText = clean(title.textContent).replace(/^card:\s*/i, '');
  }

  // "Authorizing Network: MASTERCARD".
  if (!out.brandText) {
    const lis = document.querySelectorAll('#txDetails li, .order-detail');
    for (let i = 0; i < lis.length; i++) {
      const m = clean(lis[i].textContent).match(/authorizing\s+network:?\s*(.+)$/i);
      if (m) {
        out.brandText = m[1];
        break;
      }
    }
  }

  const cardNumber = document.querySelector('.card-number');
  if (cardNumber) {
    const digits = clean(cardNumber.textContent).replace(/\D/g, '');
    if (digits.length >= 4) out.last4 = digits.slice(-4);
  }
  if (!out.last4) {
    const title = document.querySelector('#txDetails .order-details-title');
    if (title) {
      const m = clean(title.textContent).match(/(\d{4})\s*$/);
      if (m) out.last4 = m[1];
    }
  }

  // "Payment ID: TFKFWVE3HHZGC" — lets the caller confirm it landed on the
  // right receipt rather than trusting a URL it assembled itself.
  const pid = document.querySelector('.payment-id');
  if (pid) {
    const m = clean(pid.textContent).match(/([A-Z0-9]{8,})/);
    if (m) out.paymentId = m[1];
  }

  // #receipt-container deliberately, not body: the page's <script> block sits
  // outside it, and its textContent would otherwise land in the brand scan.
  const container = document.getElementById('receipt-container') || document.body;
  out.text = container ? clean(container.textContent) : '';
  return out;
}

// ---------------------------------------------------------------------------
// Node-side parsing
// ---------------------------------------------------------------------------

// "$1,234.56", "-$12.00", "($12.00)" → 1234.56 / -12 / -12. Returns null when
// the text holds no number at all.
function parseMoney(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).replace(/\s|,/g, '');
  if (!/\d/.test(s)) return null;
  const negative = /^\(.*\)$/.test(s) || /-/.test(s.slice(0, s.search(/\d/)));
  const m = s.match(/\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

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

// Clover renders dates several ways depending on locale, column width and how
// recent the transaction is ("Today 2:14 PM", "Jul 30, 2026", "07/30/2026").
// Returns a local YYYY-MM-DD, or "" when nothing date-like is present — the
// caller decides what to do with an undated row rather than guessing here.
function parseCloverDate(raw, now = new Date()) {
  const s = String(raw || '').trim();
  if (!s) return '';

  if (/\btoday\b/i.test(s)) return toDateKey(now);
  if (/\byesterday\b/i.test(s)) {
    const d = new Date(now.getTime());
    d.setDate(d.getDate() - 1);
    return toDateKey(d);
  }

  const iso = s.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  // Clover's US-format dashboard writes M/D/YYYY.
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

  // Clover's transaction list writes DD-Mon-YYYY ("31-Jul-2026 12:02"), which
  // no numeric pattern above can match — and without this it fell through to
  // the bare-time branch and silently dated every row today.
  const dayFirst = s.match(/\b(\d{1,2})[-/\s](jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[-/\s](\d{2,4})\b/i);
  if (dayFirst) {
    const day = Number(dayFirst[1]);
    const month = MONTHS[dayFirst[2].toLowerCase()];
    let year = Number(dayFirst[3]);
    if (year < 100) year += 2000;
    return toDateKey(new Date(year, month, day));
  }

  const named = s.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?[-/\s]\s*(\d{1,2})(?:,?\s*(\d{4}))?/i);
  if (named) {
    const month = MONTHS[named[1].toLowerCase()];
    const day = Number(named[2]);
    // A bare "Jul 30" is Clover shortening the current year away.
    const year = named[3] ? Number(named[3]) : now.getFullYear();
    return toDateKey(new Date(year, month, day));
  }

  // Time with no date at all ("2:14 PM") — that's today's list.
  if (/\b\d{1,2}:\d{2}\s*(am|pm)?\b/i.test(s)) return toDateKey(now);

  return '';
}

// Order matters: "Visa Debit" is a Visa, so the brand tests run before the
// generic debit/Interac test.
const BRAND_PATTERNS = [
  [/\bvisa\b/i, 'VISA'],
  [/\bmaster\s*-?\s*card\b|\bmastercard\b/i, 'MasterCard'],
  [/\bamex\b|american\s+express/i, 'Amex'],
  [/\bdiscover\b/i, 'Discover'],
  [/\binterac\b|\bdebit\b/i, 'Interac'],
  [/\bcash\b/i, 'Cash'],
  [/gift\s*card/i, 'Gift Card'],
];

// The three types Payment Management tracks.
const KNOWN_PAYMENT_TYPES = ['Interac', 'VISA', 'MasterCard'];

function detectPaymentType(text) {
  const s = String(text || '');
  for (const [re, label] of BRAND_PATTERNS) {
    if (re.test(s)) return label;
  }
  return '';
}

// Interac rows are settled from the list alone — that's the whole reason the
// detail page is only opened for the others.
function isInteracText(text) {
  return /\binterac\b|\bdebit\b/i.test(String(text || '')) && !/\bvisa\b|\bmaster\s*-?\s*card\b|\bmastercard\b/i.test(String(text || ''));
}

// A detail page is only ever opened for a row whose tender already reads
// "Credit Card", so the answer can only be a card brand. Scanning that page
// with the full tender list is what let an unrelated "Cash" somewhere in the
// page text win and file Mastercards as cash — Cash and Gift Card are simply
// not possible answers here, so they aren't candidates.
const CARD_BRAND_PATTERNS = [
  [/\bvisa\b/i, 'VISA'],
  [/\bmaster\s*-?\s*card\b|\bmastercard\b/i, 'MasterCard'],
  [/\bamex\b|american\s+express/i, 'Amex'],
  [/\bdiscover\b/i, 'Discover'],
  [/\binterac\b/i, 'Interac'],
];

// Pull the brand off a detail page's text. A labelled hit ("Card type: Visa")
// beats a bare keyword, because the page chrome mentions brands in places that
// have nothing to do with this payment. When nothing card-like is found the
// answer is "" — the payment imports as Unknown rather than as a guess.
function detectCardBrand(text) {
  const s = String(text || '');
  const labelled = s.match(
    /(?:card\s*type|card\s*brand|payment\s*method|tender\s*type|tender|card|type)\s*[:\-–]?\s*(visa|master\s*-?\s*card|mastercard|\bmc\b|amex|american\s+express|discover|interac|debit)\b/i
  );
  if (labelled) {
    const hit = labelled[1];
    if (/^mc$/i.test(hit.trim())) return 'MasterCard';
    for (const [re, label] of CARD_BRAND_PATTERNS) {
      if (re.test(hit)) return label;
    }
    if (/debit/i.test(hit)) return 'Interac';
  }
  for (const [re, label] of CARD_BRAND_PATTERNS) {
    if (re.test(s)) return label;
  }
  return '';
}

function detectLast4(text) {
  const s = String(text || '');
  const masked = s.match(/(?:[•*x×#]{1,6}\s*|ending\s+in\s+)(\d{4})\b/i);
  if (masked) return masked[1];
  return '';
}

function detectTime(text) {
  const m = String(text || '').match(/\b(\d{1,2}:\d{2}(?::\d{2})?\s*(?:am|pm)?)\b/i);
  return m ? m[1].toUpperCase().replace(/\s+/g, ' ') : '';
}

// The payment id out of a Details href: /transactions/m/<MID>/payments/PMGKPG3HGTVZM.
// Trailing query/slash tolerated; the merchant id segment is deliberately not
// matched, since it sits behind /m/.
// Clover also prints the payment id under the timestamp ("ID: KWAQZSD3DKT86"),
// which is a useful backstop when a row's Details href can't be read.
function parseIdFromText(text) {
  const m = String(text || '').match(/\bID:\s*([A-Z0-9]{8,})\b/i);
  return m ? m[1] : '';
}

function parsePaymentId(href) {
  const s = String(href || '').split('?')[0].split('#')[0];
  const segments = s.split('/').filter(Boolean);
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i];
    if (/^[A-Z0-9]{8,}$/.test(seg) && segments[i - 1] !== 'm') return seg;
  }
  return '';
}

// Merchant uuid out of /transactions/m/<MID>/payments/... — the receipt URL
// needs it as a query param.
function parseMerchantId(href) {
  const m = String(href || '').match(/\/m\/([A-Z0-9]{6,})/i);
  return m ? m[1] : '';
}

// The printable receipt for a payment: the only page that names the card brand.
function buildReceiptUrl(paymentId, merchantId, baseUrl) {
  if (!paymentId || !merchantId) return '';
  const rel = `/tx/p/${paymentId}?merchantUuid=${merchantId}`;
  try {
    return new URL(rel, baseUrl || 'https://www.clover.com').href;
  } catch {
    return `https://www.clover.com${rel}`;
  }
}

// Map header labels onto the fields we need. Tip/tax/fee columns are excluded
// explicitly — they also hold dollar amounts and would otherwise win the
// "amount" slot on a wide table.
const HEADER_MATCHERS = {
  amount: (h) => /amount|total|paid|net/.test(h) && !/tip|tax|fee|refund/.test(h),
  // Clover labels its date column "Created", not "Date".
  date: (h) => /date|time|when|created|posted/.test(h),
  tender: (h) => /payment|tender|card|method|type|brand/.test(h) && !/state|status/.test(h),
  id: (h) => /transaction|payment\s*id|\bid\b|trans\s*#|order|invoice|receipt|reference/.test(h),
  status: (h) => /state|status|result/.test(h),
  employee: (h) => /employee|staff|user|server/.test(h),
};

function mapHeaders(headers) {
  const index = {};
  const norm = (headers || []).map((h) => String(h || '').toLowerCase().trim());
  for (const field of Object.keys(HEADER_MATCHERS)) {
    const match = HEADER_MATCHERS[field];
    for (let i = 0; i < norm.length; i++) {
      if (norm[i] && match(norm[i])) {
        index[field] = i;
        break;
      }
    }
  }
  return index;
}

// Turn one harvested row into a payment candidate, or null when it clearly
// isn't one (no amount, or a totals/footer row).
function parseRow(row, headerIndex, now) {
  const cells = Array.isArray(row.cells) ? row.cells : [];
  // Join the cells rather than trusting the row's own innerText: adjacent
  // inline elements run together there ("5:12 PMInterac ••3333"), and that lost
  // word boundary is enough to make the brand test miss.
  const text = cells.length ? cells.join(' ') : String(row.text || '');
  const at = (field) =>
    headerIndex[field] !== undefined && cells[headerIndex[field]] !== undefined
      ? cells[headerIndex[field]]
      : '';

  // Amount: the mapped column when headers gave us one. Failing that, take the
  // first NON-ZERO money cell. Clover's real column order is
  //   Created | Trans # | Tender | Amount | Tax or Fee | Tip Amount | …
  // so the charged total comes first and the two $0.00 columns follow it.
  // Reading from the right instead lands on Tip Amount, which is $0.00 on
  // essentially every row — and a zero amount makes the row look bogus and get
  // dropped, silently emptying the whole scrape.
  let amountRaw = at('amount');
  if (!amountRaw || parseMoney(amountRaw) === null) {
    const moneyCells = cells.filter((c) => /\$/.test(c) && parseMoney(c) !== null);
    const nonZero = moneyCells.filter((c) => parseMoney(c) !== 0);
    amountRaw = nonZero[0] || moneyCells[0] || '';
  }
  const amount = parseMoney(amountRaw);
  if (amount === null || amount === 0) return null;

  // Footer/summary rows ("Total 12 payments $1,234.00") aren't transactions.
  if (/^\s*(total|subtotal|grand total|net sales|summary)\b/i.test(text)) return null;

  const dateSource = at('date') || cells.find((c) => parseCloverDate(c, now)) || text;
  const date = parseCloverDate(dateSource, now);

  const tenderSource = at('tender') || text;
  const listType = detectPaymentType(tenderSource) || detectPaymentType(text);
  const last4 = detectLast4(tenderSource) || detectLast4(text);
  const time = detectTime(at('date') || text);
  const status = at('status');

  const isRefund = amount < 0 || /\brefund(ed)?\b|\bvoid(ed)?\b|\breturn(ed)?\b/i.test(text);
  const isDeclined = /\bdeclin|\bfail|\bvoid(ed)?\b|\berror\b/i.test(status || '');

  const externalId =
    parsePaymentId(row.href) ||
    parsePaymentId(row.detailUrl) ||
    parseIdFromText(text) ||
    String(at('id') || '').trim() ||
    String(row.rowId || '');

  // What the LIST alone can settle. Clover shows Interac by name, but card
  // payments show only a generic "Credit Card" — that's the case the detail
  // page exists to resolve. If a list ever does name the brand outright, take
  // it and skip the extra page load.
  const listSaysInterac = isInteracText(tenderSource) || isInteracText(text);
  const type = listSaysInterac ? 'Interac' : listType;

  return {
    amount: Math.abs(Number(amount.toFixed(2))) * (isRefund ? -1 : 1),
    date,
    listType,
    type,
    needsDetail: !KNOWN_PAYMENT_TYPES.includes(type),
    last4,
    time,
    status,
    isRefund,
    isDeclined,
    externalId,
    detailUrl: row.detailUrl || '',
    // Kept so the caller can re-resolve a relative href itself: an iframe
    // whose location can't act as a base (srcdoc, about:blank mid-load) leaves
    // detailUrl empty, and the outer page's URL is a perfectly good base.
    href: row.href || '',
    rawText: text,
  };
}

// Absolute URL for a payment's detail page, given the outer page's URL as a
// fallback base.
function resolveDetailUrl(detailUrl, href, baseUrl) {
  if (detailUrl) return detailUrl;
  if (!href) return '';
  try {
    return new URL(href, baseUrl).href;
  } catch {
    return '';
  }
}

// Pick the harvested group that actually looks like the transaction list. The
// details-link group always wins when present: those rows carry the payment id
// the ledger dedupes on, which no other strategy can produce.
function parseHarvest(harvest, now = new Date()) {
  const groups = (harvest && Array.isArray(harvest.groups) ? harvest.groups : []).map((group) => {
    const headerIndex = mapHeaders(group.headers);
    const parsed = (group.rows || [])
      .map((row) => parseRow(row, headerIndex, now))
      .filter(Boolean);
    return { group, headerIndex, parsed };
  });

  const detailsFirst = groups.filter((g) => g.group.kind === 'details-link' && g.parsed.length);
  const others = groups.filter((g) => g.group.kind !== 'details-link');
  others.sort((a, b) => b.parsed.length - a.parsed.length);
  const best = detailsFirst[0] || others[0];
  if (!best || !best.parsed.length) {
    return { transactions: [], headers: [], usedHeaders: {}, kind: '' };
  }

  // The same payment can appear twice if a page nests a grid inside a table.
  const seen = new Set();
  const transactions = [];
  for (const tx of best.parsed) {
    const key = tx.externalId ? `id:${tx.externalId}` : `raw:${tx.rawText}`;
    if (seen.has(key)) continue;
    seen.add(key);
    transactions.push(tx);
  }

  return {
    transactions,
    headers: best.group.headers || [],
    usedHeaders: best.headerIndex,
    kind: best.group.kind,
  };
}

module.exports = {
  harvestTransactionRows,
  harvestDetailText,
  harvestReceiptInfo,
  findReceiptHref,
  parseMerchantId,
  buildReceiptUrl,
  parseHarvest,
  parseRow,
  resolveDetailUrl,
  parseMoney,
  parseCloverDate,
  detectPaymentType,
  detectCardBrand,
  isInteracText,
  detectLast4,
  parsePaymentId,
  parseIdFromText,
  mapHeaders,
  KNOWN_PAYMENT_TYPES,
};
