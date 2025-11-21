import React from "react";

const currencyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

const toNumber = (value) => {
  const num = parseFloat(value);
  return Number.isFinite(num) ? num : 0;
};

const styles = {
  page: {
    width: "8.5in",
    minHeight: "11in",
    backgroundColor: "#ffffff",
    borderRadius: "24px",
    boxShadow: "0 30px 60px rgba(15, 23, 42, 0.15)",
    padding: "2.5rem",
    color: "#0f172a",
    fontFamily: "'Inter', 'Segoe UI', sans-serif",
  },
  header: {
    display: "flex",
    flexDirection: "column",
    gap: "1.5rem",
    borderBottom: "1px solid #e2e8f0",
    paddingBottom: "1.5rem",
    marginBottom: "2rem",
  },
  headerRow: {
    display: "flex",
    flexDirection: "column",
    gap: "1.5rem",
  },
  headerRowDesktop: {
    display: "flex",
    justifyContent: "space-between",
    gap: "2rem",
    flexWrap: "wrap",
  },
  companyName: {
    fontSize: "2.25rem",
    fontWeight: 700,
    color: "#4338ca",
    textTransform: "uppercase",
    letterSpacing: "0.08em",
  },
  address: {
    marginTop: "0.5rem",
    whiteSpace: "pre-line",
    fontSize: "0.95rem",
    color: "#475569",
    lineHeight: 1.5,
  },
  label: {
    fontSize: "0.75rem",
    color: "#94a3b8",
    textTransform: "uppercase",
    letterSpacing: "0.2em",
  },
  value: {
    fontSize: "1.1rem",
    fontWeight: 600,
    color: "#0f172a",
  },
  bubbleName: {
    fontSize: "1.35rem",
    fontWeight: 700,
    color: "#1d4ed8",
  },
  notesSection: {
    marginTop: "1rem",
    borderRadius: "16px",
    backgroundColor: "#eef2ff",
    padding: "1rem",
    border: "1px solid #c7d2fe",
  },
  notesText: {
    marginTop: "0.35rem",
    fontSize: "0.95rem",
    color: "#312e81",
    whiteSpace: "pre-line",
  },
  table: {
    width: "100%",
    borderCollapse: "collapse",
    fontSize: "0.95rem",
  },
  th: {
    textAlign: "left",
    padding: "0.75rem 0.5rem",
    fontSize: "0.7rem",
    color: "#94a3b8",
    textTransform: "uppercase",
    letterSpacing: "0.15em",
    borderBottom: "1px solid #e2e8f0",
  },
  td: {
    padding: "1rem 0.5rem",
    borderBottom: "1px solid #f1f5f9",
    verticalAlign: "top",
    color: "#0f172a",
  },
  partNumber: {
    fontWeight: 600,
  },
  soldDate: {
    fontSize: "0.75rem",
    color: "#94a3b8",
    marginTop: "0.25rem",
  },
  totalsRow: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-end",
    gap: "0.5rem",
    marginTop: "2rem",
    fontSize: "0.95rem",
  },
  totalsLine: {
    display: "flex",
    gap: "4rem",
    alignItems: "baseline",
  },
  totalsLabel: {
    color: "#94a3b8",
    textTransform: "uppercase",
    letterSpacing: "0.2em",
  },
  totalsValue: {
    fontWeight: 600,
  },
  totalsTotal: {
    fontSize: "1.5rem",
    fontWeight: 700,
    color: "#4338ca",
  },
};

export default function InvoicePreview({
  bubbleName,
  bubbleNotes = "",
  items = [],
  generatedDate = new Date(),
  companyName = "Consumer Auto Parts",
  companyAddress = "2562 St Clair Ave West\nToronto, Ontario M6N 1L7",
  taxLabel = "HST",
  taxRate = 0.13,
}) {
  const subtotal = items.reduce((sum, it) => {
    const qty = toNumber(it.quantity);
    const price = toNumber(it.allocated_for);
    return sum + qty * price;
  }, 0);
  const tax = subtotal * taxRate;
  const total = subtotal + tax;

  const formattedDate = new Date(generatedDate).toLocaleDateString("en-CA", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  return (
    <div style={styles.page}>
      <header style={styles.header}>
        <div style={styles.headerRowDesktop}>
          <div>
            <div style={styles.companyName}>{companyName}</div>
            <div style={styles.address}>{companyAddress}</div>
          </div>
          <div>
            <div style={styles.label}>Date</div>
            <div style={styles.value}>{formattedDate}</div>
            <div style={{ marginTop: "1rem", ...styles.label }}>Bubble</div>
            <div style={styles.bubbleName}>{bubbleName}</div>
            {bubbleNotes && (
              <div style={styles.notesSection}>
                <div style={styles.label}>Notes</div>
                <p style={styles.notesText}>{bubbleNotes}</p>
              </div>
            )}
          </div>
        </div>
      </header>

      <table style={styles.table}>
        <thead>
          <tr>
            <th style={{ ...styles.th, paddingLeft: 0 }}>Part Number</th>
            <th style={styles.th}>Qty</th>
            <th style={styles.th}>Price</th>
            <th style={{ ...styles.th, textAlign: "right", paddingRight: 0 }}>
              Extension
            </th>
          </tr>
        </thead>
        <tbody>
          {items.length === 0 && (
            <tr>
              <td style={styles.td} colSpan={4}>
                No items to display.
              </td>
            </tr>
          )}
          {items.map((it) => {
            const qty = toNumber(it.quantity);
            const price = toNumber(it.allocated_for);
            const extension = qty * price;
            return (
              <tr key={it.uid}>
                <td style={{ ...styles.td, paddingLeft: 0 }}>
                  <div style={styles.partNumber}>{it.itemcode || "—"}</div>
                  <div style={styles.soldDate}>
                    Sold Date: {it.sold_date || "—"}
                  </div>
                </td>
                <td style={{ ...styles.td, textAlign: "center" }}>{qty}</td>
                <td style={{ ...styles.td, textAlign: "right" }}>
                  {currencyFormatter.format(price)}
                </td>
                <td style={{ ...styles.td, textAlign: "right", paddingRight: 0 }}>
                  <span style={{ fontWeight: 600 }}>
                    {currencyFormatter.format(extension)}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div style={styles.totalsRow}>
        <div style={styles.totalsLine}>
          <span style={styles.totalsLabel}>Subtotal</span>
          <span style={styles.totalsValue}>
            {currencyFormatter.format(subtotal)}
          </span>
        </div>
        <div style={styles.totalsLine}>
          <span style={styles.totalsLabel}>
            {taxLabel} ({Math.round(taxRate * 100)}%)
          </span>
          <span style={styles.totalsValue}>{currencyFormatter.format(tax)}</span>
        </div>
        <div style={{ ...styles.totalsLine, marginTop: "0.75rem" }}>
          <span style={styles.totalsLabel}>Total</span>
          <span style={styles.totalsTotal}>
            {currencyFormatter.format(total)}
          </span>
        </div>
      </div>
    </div>
  );
}
