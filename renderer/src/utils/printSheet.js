// Print a standalone sheet in its own window.
//
// The same approach the invoice print in App.jsx uses, and for the same reason:
// `window.print()` prints the WHOLE app — nav tabs, headers, every other view's
// chrome — and holding that back means tagging all of it `print:hidden` and
// hoping nothing new escapes. Handing the printer a fresh document with only
// the report in it can't drift.
//
// `bodyHtml` is trusted markup built by the caller, not user input pasted in:
// every value that reaches it must already be escaped (see `escapeHtml`).
export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function printSheet({ title, bodyHtml }) {
  const win = window.open("", "PRINT", "width=900,height=1100");
  if (!win) {
    alert("The print window was blocked. Allow pop-ups for this app and try again.");
    return false;
  }
  win.document.write(`
    <!doctype html>
    <html>
      <head>
        <title>${escapeHtml(title)}</title>
        <style>
          body {
            margin: 0;
            padding: 24px;
            background: #fff;
            font-family: 'Inter', 'Segoe UI', sans-serif;
            color: #0f172a;
          }
          h1 { font-size: 18px; margin: 0 0 2px; }
          h2 { font-size: 13px; margin: 16px 0 4px; text-transform: uppercase; letter-spacing: .04em; color: #334155; }
          h2:first-of-type { margin-top: 10px; }
          /* A quarter of the page, so label and figure stay next to each other
             instead of being flung to opposite margins. min-width keeps it
             readable if the paper is narrow. */
          .totals-table { width: 25%; min-width: 12rem; margin-top: 10px; }
          .totals-table td { border-bottom: none; padding: 2px 8px 2px 0; }
          /* The one figure the sheet exists to report. */
          .totals-table tr.card-total td {
            border-top: 1px solid #0f172a;
            padding-top: 5px;
            font-size: 15px;
            font-weight: 800;
            background: #f1f5f9;
          }
          /* Keep a section and its own totals on one page where possible. */
          tfoot { page-break-inside: avoid; }
          .sub { font-size: 12px; color: #475569; margin-bottom: 14px; }
          table { width: 100%; border-collapse: collapse; font-size: 12px; }
          th {
            text-align: left;
            text-transform: uppercase;
            font-size: 10px;
            letter-spacing: .04em;
            color: #475569;
            border-bottom: 1px solid #94a3b8;
            padding: 4px 8px 4px 0;
          }
          td { padding: 4px 8px 4px 0; border-bottom: 1px solid #e2e8f0; vertical-align: top; }
          .num { text-align: right; font-variant-numeric: tabular-nums; }
          .mono { font-family: ui-monospace, 'Cascadia Mono', Consolas, monospace; }
          .muted { color: #64748b; }
          /* Per-type subtotals read lighter than the section total above the
             rule, which in turn reads lighter than the grand total. */
          tfoot td { border: none; padding-top: 4px; font-weight: 600; }
          tfoot tr:first-child td { border-top: 1px solid #94a3b8; padding-top: 8px; }
          tfoot tr.subtotal td { border-top: 1px solid #cbd5e1; font-weight: 700; }
          tfoot tr.grand td { border-top: none; font-weight: 800; font-size: 14px; padding-top: 2px; }
          /* Separates the card block from the e-transfer block. */
          hr { border: none; border-top: 2px solid #0f172a; margin: 18px 0 0; }
          .totals { margin-top: 14px; font-size: 12px; }
          .totals span { margin-right: 18px; }
          /* Repeat the header on every page of a long list. */
          thead { display: table-header-group; }
          tr { page-break-inside: avoid; }
        </style>
      </head>
      <body>${bodyHtml}</body>
    </html>
  `);
  win.document.close();
  win.focus();
  win.print();
  win.close();
  return true;
}
