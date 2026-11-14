// src/statements/statementSuppliers.js
// One entry per supplier that sends us account statements. The Statements view
// renders one tab per entry, so adding a supplier is adding a row here.
//
//   id        stable key — used in config keys, cache file names, IPC payloads
//   label     tab title
//   match     lowercase fragments; an order belongs to this supplier when its
//             `source` / `warehouse` / `vendor` text contains any of them
//   sender    default Gmail from: address(es) (comma list); overridable in the
//             view and stored as STATEMENT_<ID>_SENDER
//   subject   default Gmail subject words; stored as STATEMENT_<ID>_SUBJECT
//   dateOrder "dmy" (default) or "mdy" — how an all-numeric date on the statement reads
//   matchReference  true when the statement quotes OUR order reference, not an invoice no.
//   website   true once a supplier is known to offer statements on its portal
//             (reserved — the portal pull is a later phase)
//
// Senders are best guesses taken from the invoice pipelines; they are only the
// starting point and are editable per machine-wide config in the view.
const STATEMENT_SUPPLIERS = [
  // World and Altrom send no statement emails (checked 150 days of mail) - their
  // statements, if any, live on the supplier's website. Left without a sender so a
  // lookup refuses rather than guessing; the portal pull is a later phase.
  { id: "world", label: "World", match: ["world"], sender: "", subject: "Statement", dateOrder: "mdy" },
  { id: "transbec", label: "Transbec", match: ["transbec"], sender: "donotreply@transbec.ca", subject: "Statement", dateOrder: "mdy" },
  { id: "bestbuy", label: "BestBuy", match: ["bestbuy", "best buy", "bestauto"], sender: "do_not_reply@bestautosolution.ca", subject: "Customer Statement", dateOrder: "mdy" },
  { id: "cbk", label: "CBK", match: ["cbk"], sender: "CBKOPR@cappcon.com", subject: "CBK Monthly Statement COS100", dateOrder: "mdy" },
  { id: "proforce", label: "Proforce", match: ["proforce"], sender: "noreply@epartconnection.com", subject: "e-Statement", dateOrder: "mdy" },
  // Tiger's statement lists OUR order reference in its "Ref #" column, not their
  // invoice number, so orders are matched on `reference` here.
  { id: "tiger", label: "Tiger", match: ["tiger"], sender: "noreply@tigeronlineorder.com", subject: "Monthly Account Statement", dateOrder: "mdy", matchReference: true },
  { id: "altrom", label: "Altrom", match: ["altrom"], sender: "", subject: "Statement", dateOrder: "mdy" },
  // No Interstate orders exist in the order store, so a reconcile has nothing to
  // match against yet - the statement itself still reads and balances.
  { id: "ibsa", label: "Interstate", match: ["interstate", "ibsa"], sender: "do.not.reply@ibsa.com", subject: "Statement", dateOrder: "mdy" },
];

function getSupplier(id) {
  return STATEMENT_SUPPLIERS.find((s) => s.id === id) || null;
}

const configKey = (id, kind) => `STATEMENT_${String(id).toUpperCase()}_${kind}`;

// Which supplier does an order (active, archived or a manifest row) belong to?
function supplierIdForOrder(order) {
  const text = [order?.source, order?.warehouse, order?.vendor, order?.supplier]
    .map((v) => String(v || "").toLowerCase())
    .join(" ");
  if (!text.trim()) return "";
  const hit = STATEMENT_SUPPLIERS.find((s) => s.match.some((m) => text.includes(m)));
  return hit ? hit.id : "";
}

module.exports = { STATEMENT_SUPPLIERS, getSupplier, configKey, supplierIdForOrder };
