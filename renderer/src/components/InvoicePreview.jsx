import React from "react";

const currencyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

const toNumber = (value) => {
  const num = parseFloat(value);
  return Number.isFinite(num) ? num : 0;
};

// Supplier application text runs long (200+ chars is common) — untruncated it
// wraps the part-number column onto several lines and pushes rows apart, so
// the printed invoice truncates the same way Order Assignment / Sales Orders
// already do on screen.
const DESC_LIMIT = 30;
const truncate = (s, n = DESC_LIMIT) => {
  const v = String(s || "").trim();
  return v.length > n ? `${v.slice(0, n)}…` : v;
};

const RULE = "1px solid #94a3b8";

const styles = {
  page: {
    width: "8.5in",
    minHeight: "11in",
    boxSizing: "border-box",
    flexShrink: 0,
    display: "flex",
    flexDirection: "column",
    backgroundColor: "#ffffff",
    borderRadius: "24px",
    boxShadow: "0 30px 60px rgba(15, 23, 42, 0.15)",
    padding: "0.6in",
    color: "#0f172a",
    fontFamily: "'Inter', 'Segoe UI', sans-serif",
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: "2rem",
    borderBottom: "2px solid #0f172a",
    paddingBottom: "1rem",
    marginBottom: "1rem",
  },
  companyName: {
    fontSize: "1.9rem",
    fontWeight: 700,
    color: "#4338ca",
    textTransform: "uppercase",
    letterSpacing: "0.06em",
  },
  address: {
    marginTop: "0.4rem",
    whiteSpace: "pre-line",
    fontSize: "0.85rem",
    color: "#475569",
    lineHeight: 1.45,
  },
  docTitle: {
    fontSize: "1.6rem",
    fontWeight: 700,
    letterSpacing: "0.18em",
    textTransform: "uppercase",
    color: "#0f172a",
    textAlign: "right",
  },
  docMeta: {
    marginTop: "0.6rem",
    border: RULE,
    borderCollapse: "collapse",
    fontSize: "0.8rem",
    minWidth: "2.6in",
  },
  docMetaLabel: {
    border: RULE,
    backgroundColor: "#cbd5e1",
    padding: "0.3rem 0.6rem",
    textTransform: "uppercase",
    letterSpacing: "0.1em",
    fontSize: "0.65rem",
    fontWeight: 700,
    color: "#1e293b",
    whiteSpace: "nowrap",
  },
  docMetaValue: {
    border: RULE,
    padding: "0.3rem 0.6rem",
    fontWeight: 700,
    textAlign: "right",
    whiteSpace: "nowrap",
  },
  label: {
    fontSize: "0.65rem",
    color: "#64748b",
    textTransform: "uppercase",
    letterSpacing: "0.2em",
    fontWeight: 700,
  },
  soldTo: {
    marginBottom: "0.75rem",
  },
  bubbleName: {
    fontSize: "1.2rem",
    fontWeight: 700,
    color: "#1d4ed8",
  },
  notesSection: {
    marginTop: "0.5rem",
    border: "1px solid #c7d2fe",
    backgroundColor: "#eef2ff",
    padding: "0.5rem 0.75rem",
  },
  notesText: {
    marginTop: "0.2rem",
    marginBottom: 0,
    fontSize: "0.85rem",
    color: "#312e81",
    whiteSpace: "pre-line",
  },
  // The table owns whatever vertical space is left on the sheet, so the grid
  // runs down to the totals at the bottom of the page instead of stopping
  // wherever the last part happens to land.
  tableWrap: {
    flex: "1 1 auto",
    minHeight: 0,
  },
  table: {
    width: "100%",
    height: "100%",
    borderCollapse: "collapse",
    fontSize: "0.85rem",
    border: RULE,
  },
  th: {
    textAlign: "left",
    padding: "0.5rem 0.6rem",
    fontSize: "0.65rem",
    color: "#1e293b",
    backgroundColor: "#cbd5e1",
    textTransform: "uppercase",
    letterSpacing: "0.12em",
    fontWeight: 700,
    border: RULE,
  },
  td: {
    padding: "0.4rem 0.6rem",
    border: RULE,
    verticalAlign: "top",
    color: "#0f172a",
  },
  fillerTd: {
    border: RULE,
    padding: 0,
  },
  partNumber: {
    fontWeight: 600,
  },
  partDescription: {
    fontSize: "0.72rem",
    color: "#64748b",
    marginTop: "0.15rem",
  },
  badge: {
    display: "inline-block",
    marginTop: "0.25rem",
    padding: "0.1rem 0.5rem",
    backgroundColor: "#fef3c7",
    color: "#92400e",
    fontSize: "0.65rem",
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.08em",
    border: "1px solid #fcd34d",
  },
  totalsLabel: {
    border: RULE,
    padding: "0.4rem 0.6rem",
    textAlign: "right",
    textTransform: "uppercase",
    letterSpacing: "0.12em",
    fontSize: "0.7rem",
    fontWeight: 700,
    color: "#1e293b",
    backgroundColor: "#e2e8f0",
  },
  totalsValue: {
    border: RULE,
    padding: "0.4rem 0.6rem",
    textAlign: "right",
    fontWeight: 700,
    backgroundColor: "#f8fafc",
  },
  grandLabel: {
    border: RULE,
    padding: "0.55rem 0.6rem",
    textAlign: "right",
    textTransform: "uppercase",
    letterSpacing: "0.14em",
    fontSize: "0.8rem",
    fontWeight: 700,
    color: "#0f172a",
    backgroundColor: "#ffffff",
  },
  grandValue: {
    border: RULE,
    padding: "0.55rem 0.6rem",
    textAlign: "right",
    fontSize: "1.05rem",
    fontWeight: 700,
    color: "#0f172a",
    backgroundColor: "#ffffff",
  },
};

// The letterhead and tax rate this document prints with. Exported because a
// printed Sales Order is snapshotted at print time, and the snapshot has to
// freeze these values — otherwise a future address or HST change would silently
// rewrite what every past printed copy appears to have said.
export const INVOICE_DOCUMENT_DEFAULTS = {
  documentTitle: "Sales Order",
  companyName: "Consumer Auto Parts",
  companyAddress: "2562 St Clair Ave West\nToronto, Ontario M6N 1L7",
  companyContact: "Canada\nconsumerautoparts@gmail.com\nTEL: 416-763-5696",
  taxLabel: "HST",
  taxRate: 0.13,
};

export default function InvoicePreview({
  bubbleName,
  bubbleNotes = "",
  items = [],
  extraLines = [],
  generatedDate = new Date(),
  salesOrderNumber = "",
  documentTitle = INVOICE_DOCUMENT_DEFAULTS.documentTitle,
  companyName = INVOICE_DOCUMENT_DEFAULTS.companyName,
  companyAddress = INVOICE_DOCUMENT_DEFAULTS.companyAddress,
  companyContact = INVOICE_DOCUMENT_DEFAULTS.companyContact,
  taxLabel = INVOICE_DOCUMENT_DEFAULTS.taxLabel,
  taxRate = INVOICE_DOCUMENT_DEFAULTS.taxRate,
}) {
  const itemRows = (items || []).map((it) => {
    const qty = toNumber(it.quantity);
    const price = toNumber(it.allocated_for);
    const extension = qty * price;
    return {
      key: it.uid,
      type: "item",
      partNumber: it.itemcode || "—",
      description: truncate(it.notes1),
      qty,
      price,
      extension,
      taxable: true,
    };
  });

  const normalizedExtraLines = (extraLines || []).map((line, index) => {
    const qty = toNumber(line.quantity);
    const price = toNumber(line.unitPrice);
    const extension = qty * price;
    return {
      key: line.id || `extra-${index}`,
      type: "extra",
      partNumber: line.partLineCode || "Extra Line",
      description: truncate(line.description) || "—",
      qty,
      price,
      extension,
      taxable: line.taxable !== false,
    };
  });

  const rows = [...itemRows, ...normalizedExtraLines];

  const subtotal = rows.reduce((sum, row) => sum + row.extension, 0);
  const taxableBase = rows.reduce(
    (sum, row) => (row.taxable ? sum + row.extension : sum),
    0
  );
  const tax = taxableBase * taxRate;
  const total = subtotal + tax;

  const formattedDate = new Date(generatedDate).toLocaleDateString("en-CA", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  return (
    <div className="invoice-sheet" style={styles.page}>
      <header style={styles.header}>
        <div>
          <div style={styles.companyName}>{companyName}</div>
          <div style={styles.address}>{companyAddress}</div>
          <div style={{ ...styles.address, marginTop: 0 }}>{companyContact}</div>
        </div>
        <div>
          <div style={styles.docTitle}>{documentTitle}</div>
          <table style={styles.docMeta}>
            <tbody>
              <tr>
                <td style={styles.docMetaLabel}>{documentTitle} #</td>
                <td style={styles.docMetaValue}>
                  {salesOrderNumber || "assigned on print"}
                </td>
              </tr>
              <tr>
                <td style={styles.docMetaLabel}>Date</td>
                <td style={styles.docMetaValue}>{formattedDate}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </header>

      <div style={styles.soldTo}>
        <div style={styles.label}>Sold to</div>
        <div style={styles.bubbleName}>{bubbleName}</div>
        {bubbleNotes && (
          <div style={styles.notesSection}>
            <div style={styles.label}>Notes</div>
            <p style={styles.notesText}>{bubbleNotes}</p>
          </div>
        )}
      </div>

      <div style={styles.tableWrap}>
        <table style={styles.table}>
          <colgroup>
            <col />
            <col style={{ width: "0.8in" }} />
            <col style={{ width: "1.2in" }} />
            <col style={{ width: "1.3in" }} />
          </colgroup>
          <thead>
            <tr>
              <th style={styles.th}>Part Number</th>
              <th style={{ ...styles.th, textAlign: "center" }}>Qty</th>
              <th style={{ ...styles.th, textAlign: "right" }}>Unit Price</th>
              <th style={{ ...styles.th, textAlign: "right" }}>Extension</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td style={styles.td} colSpan={4}>
                  No items or extra lines to display.
                </td>
              </tr>
            )}
            {rows.map((row, index) => {
              const tint = index % 2 === 1 ? "#f1f5f9" : "#ffffff";
              return (
                <tr key={row.key}>
                  <td style={{ ...styles.td, backgroundColor: tint }}>
                    <div style={styles.partNumber}>{row.partNumber || "—"}</div>
                    {row.description && (
                      <div style={styles.partDescription}>{row.description}</div>
                    )}
                    {row.type === "extra" && row.taxable === false && (
                      <div style={styles.badge}>Non-taxable</div>
                    )}
                  </td>
                  <td
                    style={{
                      ...styles.td,
                      textAlign: "center",
                      backgroundColor: tint,
                    }}
                  >
                    {row.qty}
                  </td>
                  <td
                    style={{
                      ...styles.td,
                      textAlign: "right",
                      backgroundColor: tint,
                    }}
                  >
                    {currencyFormatter.format(row.price)}
                  </td>
                  <td
                    style={{
                      ...styles.td,
                      textAlign: "right",
                      fontWeight: 600,
                      backgroundColor: tint,
                    }}
                  >
                    {currencyFormatter.format(row.extension)}
                  </td>
                </tr>
              );
            })}
            {/* Soaks up the leftover height so the column rules reach the
                totals block at the foot of the sheet. */}
            <tr style={{ height: "100%" }}>
              <td style={styles.fillerTd} />
              <td style={styles.fillerTd} />
              <td style={styles.fillerTd} />
              <td style={styles.fillerTd} />
            </tr>
          </tbody>
          <tfoot>
            <tr>
              <td style={styles.totalsLabel} colSpan={3}>
                Subtotal
              </td>
              <td style={styles.totalsValue}>
                {currencyFormatter.format(subtotal)}
              </td>
            </tr>
            <tr>
              <td style={styles.totalsLabel} colSpan={3}>
                {taxLabel} ({Math.round(taxRate * 100)}%)
              </td>
              <td style={styles.totalsValue}>
                {currencyFormatter.format(tax)}
              </td>
            </tr>
            <tr>
              <td style={styles.grandLabel} colSpan={3}>
                Total
              </td>
              <td style={styles.grandValue}>
                {currencyFormatter.format(total)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
