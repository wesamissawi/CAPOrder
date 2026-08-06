// src/scrapers/worldInvoice.actions.js
// Parsing helpers for World Automotive invoices arriving by email (Gmail) as
// machine-readable PDFs — the replacement for the old Epicor portal scrape+OCR.
//
// These PDFs have a real text layer, but their flattened text is NOT safely
// parseable: adjacent table cells are glued together with no separator, and a
// genuinely-empty cell emits no text item at all. A real totals row reads as
//
//     13.870.000.0013.871.8015.6715.67
//
// for nine columns of which only seven are printed. Splitting that by counting
// digits is ambiguous and silently produces wrong money — the same trap already
// documented in bestbuyInvoice.actions.js. So every number we care about is read
// POSITIONALLY via pdfjs (real x/y per text item), never by regex over flat text.
const {
  getPageRows,
} = require("./bestbuyInvoice.actions");

// --- Column assignment ---------------------------------------------------
//
// World RIGHT-aligns its money columns while printing headers left-ish, so a
// value can sit slightly LEFT of its own header's x (e.g. TOTAL MDSE header at
// x=78.8, its value "159.30" at x=75.6). That means the [thisHeaderX, nextHeaderX)
// containment used by bestbuyInvoice.actions.readLabelledRow mis-assigns every
// column here (FREIGHT would read the subtotal). We instead match each value to
// the header whose CENTRE is nearest, which is stable under either alignment.
function centre(item) {
  return item.x + (item.w || 0) / 2;
}

function assignByNearestColumn(headerItems, valueItems) {
  const out = {};
  for (const value of valueItems) {
    let best = null;
    let bestDistance = Infinity;
    for (const header of headerItems) {
      const distance = Math.abs(centre(header) - centre(value));
      if (distance < bestDistance) {
        bestDistance = distance;
        best = header;
      }
    }
    if (best) out[best.str] = value.str;
  }
  return out;
}

// Find a row containing every one of `labels` as distinct items, and read the
// row immediately beneath it. Columns with no printed value are simply absent
// from the result (World omits $0.00 cells rather than printing them).
function readColumnsUnderHeader(rows, labels) {
  const wanted = labels.map((l) => l.toLowerCase());
  for (let i = 0; i < rows.length; i++) {
    const present = rows[i].items.map((it) => it.str.trim().toLowerCase());
    if (!wanted.every((w) => present.includes(w))) continue;
    const valueRow = rows[i + 1];
    if (!valueRow) return null;
    const headerItems = labels
      .map((label) =>
        rows[i].items.find((it) => it.str.trim().toLowerCase() === label.toLowerCase())
      )
      .filter(Boolean)
      .map((it) => ({ ...it, str: it.str.trim() }));
    return assignByNearestColumn(headerItems, valueRow.items);
  }
  return null;
}

function money(raw) {
  if (raw == null) return null;
  const match = String(raw).replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  return match ? parseFloat(match[0]) : null;
}

// --- Document fields -----------------------------------------------------

const ID_ROW_LABELS = [
  "CUSTOMER NUMBER",
  "Invoice NUMBER",
  "Invoice DATE",
  "PACKING SLIP",
  "TERMS",
  "WHSE",
];

const TOTALS_ROW_LABELS = [
  "TOTAL MDSE",
  "TOTAL EHC",
  "TOTAL CORE",
  "FREIGHT",
  "SUBTOTAL",
  "TAX AMT",
  "INVOICE TOTAL",
  "PAYMENTS",
  "BALANCE DUE",
];

// The order reference is printed as "*** ACX Reference No: OK9784 ***". It is
// the SAME LL9999 shape the rest of the app matches on, and — unlike the old
// Epicor flow — it is present on the document itself, so no fuzzy plumbing is
// needed to tie an invoice back to its order.
const REFERENCE_REGEX = /ACX\s*Reference\s*No\.?\s*[:#]?\s*([A-Za-z]{2}\d{4})/i;

// A line-item row, e.g.
//   LUA 20047 | SYNTHETIC SAE 75W90 TRANS | EA | 6 | 0 | 6 | 22.24 | 13.9% | 19.15 | 0.00 | 114.89
// Anchored on the DISC% cell — the single "%" on the row — because it is the one
// column that is always printed and never blank. Everything else is addressed as
// a fixed offset from it. Vehicle-fitment lines ("2019 TOYOTA CAMRY HYBRID") carry
// no "%" and are therefore skipped for free.
const DISCOUNT_CELL = /^\d+(?:\.\d+)?%$/;
const UNIT_CELL = /^[A-Z]{2,3}$/;

// Per-item environmental handling charge, printed on its own line beneath the
// item as "EHC : 0.21 Ext: 1.26" (unit charge, then charge x qty).
const EHC_LINE = /^EHC\s*:?\s*([\d.]+)\s*Ext:?\s*([\d.]+)/i;

// A part is printed as "<2-4 letter line code> <part number>". The number is kept
// VERBATIM including any dashes — capRules.resolveCapCode branches on the line
// code and applies its own normalization (e.g. TRK dash-stripping), so splitting
// or "cleaning" it here would break Sage code resolution.
function splitPartField(raw) {
  const text = String(raw || "").trim();
  const match = text.match(/^([A-Z]{2,4})\s+(.+)$/);
  if (match) return { partLineCode: match[1], partNumber: match[2].trim() };
  return { partLineCode: "", partNumber: text };
}

function extractLineItems(rows) {
  const items = [];
  let previous = null;
  for (const row of rows) {
    const cells = row.items;
    const d = cells.findIndex((c) => DISCOUNT_CELL.test(c.str.trim()));
    // Need the item/description cells to the left and the three money cells to
    // the right; a "%" appearing anywhere else is not an item row.
    if (d >= 6 && cells.length >= d + 4 && UNIT_CELL.test(cells[d - 5].str.trim())) {
      const { partLineCode, partNumber } = splitPartField(cells[0].str);
      previous = {
        partLineCode,
        partNumber,
        description: cells
          .slice(1, d - 5)
          .map((c) => c.str.trim())
          .join(" ")
          .trim(),
        unit: cells[d - 5].str.trim(),
        orderQty: money(cells[d - 4].str),
        backOrdered: money(cells[d - 3].str),
        quantity: money(cells[d - 2].str),
        listPrice: money(cells[d - 1].str),
        discountPct: money(cells[d].str),
        // NET PRICE — the discounted unit price, which is what Sage receives.
        costPrice: money(cells[d + 1].str),
        core: money(cells[d + 2].str),
        extended: money(cells[d + 3].str),
        ehcUnit: 0,
        ehcExtended: 0,
      };
      items.push(previous);
      continue;
    }
    const ehc = row.items
      .map((c) => c.str.trim())
      .join(" ")
      .match(EHC_LINE);
    if (ehc && previous) {
      previous.ehcUnit = money(ehc[1]) ?? 0;
      previous.ehcExtended = money(ehc[2]) ?? 0;
    }
  }
  return items;
}

// The return stub at the foot of the last page prints "BALANCE DUE: 181.43" with
// a real colon. That is an independent, unambiguous reading of the amount owing,
// so we use it to CROSS-CHECK the positionally-read totals row rather than
// trusting either one alone.
function extractStubBalanceDue(rows) {
  for (const row of rows) {
    const cells = row.items;
    const idx = cells.findIndex((c) => /^BALANCE\s*DUE:?$/i.test(c.str.trim()));
    if (idx >= 0) {
      const after = cells.slice(idx + 1).find((c) => money(c.str) !== null);
      if (after) return money(after.str);
    }
    const inline = cells
      .map((c) => c.str.trim())
      .join(" ")
      .match(/BALANCE\s*DUE\s*:\s*\$?\s*([\d,]+\.\d{2})/i);
    if (inline) return money(inline[1]);
  }
  return null;
}

// Parse one World invoice PDF. Returns the invoice fields plus `checks`, an
// arithmetic self-audit: because every figure is read independently, the printed
// document has to reconcile with itself, and any column mis-read shows up as a
// failed check instead of silently wrong money.
async function extractInvoiceFromPdf(pdfBuffer) {
  const pageRows = await getPageRows(pdfBuffer);
  const rows = pageRows.flat();

  let invoiceNumber = "";
  let reference = "";
  for (const row of rows) {
    const text = row.items.map((c) => c.str.trim()).join(" ");
    const inv = text.match(/^No\.\s*([0-9A-Z]{4,12})$/i);
    if (inv && !invoiceNumber) invoiceNumber = inv[1].toUpperCase();
    const ref = text.match(REFERENCE_REGEX);
    if (ref && !reference) reference = ref[1].toUpperCase();
  }

  const idRow = readColumnsUnderHeader(rows, ID_ROW_LABELS) || {};
  if (!invoiceNumber && idRow["Invoice NUMBER"]) {
    invoiceNumber = String(idRow["Invoice NUMBER"]).trim().toUpperCase();
  }

  const totalsRaw = readColumnsUnderHeader(rows, TOTALS_ROW_LABELS) || {};
  const totals = {};
  for (const label of TOTALS_ROW_LABELS) totals[label] = money(totalsRaw[label]) ?? 0;

  const lineItems = extractLineItems(rows);
  const stubBalanceDue = extractStubBalanceDue(rows);

  const invoiceTotal = totals["INVOICE TOTAL"] || null;
  const balanceDue = stubBalanceDue ?? totals["BALANCE DUE"] ?? null;

  const near = (a, b) => a != null && b != null && Math.abs(a - b) < 0.01;
  const sum = (fn) => lineItems.reduce((acc, li) => acc + (fn(li) || 0), 0);
  const checks = {
    // MDSE + EHC + CORE + FREIGHT = SUBTOTAL
    subtotal: near(
      totals["TOTAL MDSE"] + totals["TOTAL EHC"] + totals["TOTAL CORE"] + totals["FREIGHT"],
      totals["SUBTOTAL"]
    ),
    // SUBTOTAL + TAX = INVOICE TOTAL
    invoiceTotal: near(totals["SUBTOTAL"] + totals["TAX AMT"], totals["INVOICE TOTAL"]),
    // the two independent readings of the amount owing agree
    balanceDue: stubBalanceDue == null || near(stubBalanceDue, totals["BALANCE DUE"]),
    // the line items we parsed account for the merchandise total
    lineItems: lineItems.length > 0 && near(sum((li) => li.extended), totals["TOTAL MDSE"]),
    // and for the environmental charges
    ehc: near(sum((li) => li.ehcExtended), totals["TOTAL EHC"]),
  };
  checks.ok = Object.values(checks).every(Boolean);

  return {
    invoiceNumber,
    reference,
    packingSlip: String(idRow["PACKING SLIP"] || "").trim(),
    invoiceDate: String(idRow["Invoice DATE"] || "").trim(),
    invoiceTotal,
    balanceDue,
    totalEhc: totals["TOTAL EHC"] || 0,
    hasEnvironmentalFee: (totals["TOTAL EHC"] || 0) > 0,
    environmentalFeeAmount: totals["TOTAL EHC"] > 0 ? totals["TOTAL EHC"].toFixed(2) : "",
    totals,
    lineItems,
    checks,
  };
}

// Stable, filesystem-safe asset name keyed by invoice number, mirroring the
// Transbec/BestBuy convention.
function getInvoiceAssetName(invoiceNumber, ext) {
  const safe = String(invoiceNumber || "")
    .trim()
    .replace(/[^A-Za-z0-9_-]/g, "_");
  return `world_invoice_${safe || "unknown"}.${ext}`;
}

// The subject carries the reference too ("Invoice for 20605 EPN conf OK9784").
// The PDF's own ACX reference is authoritative, but this covers a PDF that fails
// to parse.
function extractReferenceFromSubject(subject) {
  const text = String(subject || "");
  const labelled = text.match(/conf\s*([A-Za-z]{2}\d{4})/i);
  if (labelled) return labelled[1].toUpperCase();
  const bare = text.match(/\b([A-Za-z]{2}\d{4})\b/);
  return bare ? bare[1].toUpperCase() : "";
}

module.exports = {
  assignByNearestColumn,
  readColumnsUnderHeader,
  splitPartField,
  extractLineItems,
  extractInvoiceFromPdf,
  extractReferenceFromSubject,
  getInvoiceAssetName,
};
