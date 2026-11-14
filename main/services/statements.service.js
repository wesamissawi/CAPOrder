// main/services/statements.service.js
// Statements Management: per-supplier Gmail lookup + reconcile against Sage.
// Orchestration only — parsing lives in src/statements, matching in
// main/domain/statements.domain.js.
const fs = require("fs");
const path = require("path");
const {
  STATEMENT_SUPPLIERS,
  getSupplier,
  configKey,
} = require("../../src/statements/statementSuppliers");
const { fetchStatements, listCachedStatements } = require("../../src/statements/statementFetch");
const { reconcileStatement, buildRecords } = require("../domain/statements.domain");

// Minimal CSV line reader for the archive manifests (reference,invoice_number,
// billed_total,archived_at) — values may be quoted by csvEscape.
function splitCsvLine(line) {
  const out = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

const createStatementsService = (deps) => {
  const { loadConfig, saveConfig, readOrders, readOrdersArchive, getGmailAssetsDir, getSharedDataDir, ensureDir } = deps;

  const cachePathFor = (supplierId) => path.join(getGmailAssetsDir(), `statement_cache_${supplierId}.json`);

  function supplierConfig(s) {
    const cfg = loadConfig() || {};
    const own = (kind) => (typeof cfg[configKey(s.id, kind)] === "string" ? cfg[configKey(s.id, kind)] : null);
    return {
      id: s.id,
      label: s.label,
      sender: own("SENDER") ?? s.sender,
      subject: own("SUBJECT") ?? s.subject,
    };
  }

  function listSuppliers() {
    return { ok: true, suppliers: STATEMENT_SUPPLIERS.map(supplierConfig) };
  }

  function setSupplierConfig({ supplierId, sender, subject } = {}) {
    const s = getSupplier(supplierId);
    if (!s) return { ok: false, error: "Unknown supplier." };
    saveConfig({
      [configKey(s.id, "SENDER")]: String(sender ?? "").trim(),
      [configKey(s.id, "SUBJECT")]: String(subject ?? "").trim(),
    });
    return { ok: true, supplier: supplierConfig(s) };
  }

  function listStatements({ supplierId } = {}) {
    if (!getSupplier(supplierId)) return { ok: false, error: "Unknown supplier." };
    try {
      return { ok: true, statements: listCachedStatements(cachePathFor(supplierId), supplierId, supplierConfig(getSupplier(supplierId)).subject) };
    } catch (e) {
      return { ok: false, error: e?.message || "Failed to read cached statements." };
    }
  }

  async function fetchSupplierStatements({ supplierId, fromDate, toDate } = {}) {
    const s = getSupplier(supplierId);
    if (!s) return { ok: false, error: "Unknown supplier." };
    const cfg = loadConfig() || {};
    if (!cfg.GMAIL_CLIENT_ID || !cfg.GMAIL_CLIENT_SECRET) {
      return { ok: false, error: "Missing Gmail OAuth client id/secret. Set them in Settings." };
    }
    if (!cfg.GMAIL_REFRESH_TOKEN) {
      return { ok: false, error: "Gmail is not connected. Click “Connect Gmail” in Settings." };
    }
    const sc = supplierConfig(s);
    // A sender is mandatory. With only a subject word like "Statement" the search
    // matches anything in the whole mailbox that has an attachment — it once
    // collected other suppliers' statements under BestBuy and Proforce.
    if (!sc.sender) {
      return { ok: false, error: `Set the Gmail sender for ${s.label} statements first (Gmail settings for this supplier).` };
    }
    const dataDir = getGmailAssetsDir();
    ensureDir(dataDir);
    return fetchStatements({
      credentials: {
        clientId: cfg.GMAIL_CLIENT_ID,
        clientSecret: cfg.GMAIL_CLIENT_SECRET,
        refreshToken: cfg.GMAIL_REFRESH_TOKEN,
      },
      supplierId: s.id,
      sender: sc.sender,
      subjectPattern: sc.subject,
      dataDir,
      cachePath: cachePathFor(s.id),
      fromDate: typeof fromDate === "string" ? fromDate : "",
      toDate: typeof toDate === "string" ? toDate : "",
    });
  }

  // Archive manifests: <vendor>_YYYYMM/invoices.csv. They outlive the orders
  // archive's own retention, so they are what lets a statement from months back
  // still find an invoice we archived long ago.
  function readManifests() {
    const rows = [];
    try {
      const sharedDir = getSharedDataDir();
      fs.readdirSync(sharedDir, { withFileTypes: true }).forEach((ent) => {
        const m = ent.isDirectory() && /^([a-z]+)_\d{6}$/.exec(ent.name);
        if (!m || !getSupplier(m[1])) return;
        const file = path.join(sharedDir, ent.name, "invoices.csv");
        if (!fs.existsSync(file)) return;
        fs.readFileSync(file, "utf-8").split(/\r?\n/).forEach((line) => {
          if (!line.trim() || line.startsWith("reference,")) return;
          const [reference, invoice_number, billed_total, archived_at] = splitCsvLine(line);
          rows.push({ supplierId: m[1], reference, invoice_number, billed_total, archived_at });
        });
      });
    } catch (e) {
      console.error("[statements] manifest scan failed", e);
    }
    return rows;
  }

  // invoice number <-> our order reference, from the invoice-email caches.
  function readInvoiceLinks(supplierId) {
    const out = [];
    for (const name of [`${supplierId}_invoice_cache.json`, `${supplierId}_credit_invoice_cache.json`]) {
      try {
        const file = path.join(getGmailAssetsDir(), name);
        if (!fs.existsSync(file)) continue;
        const cache = JSON.parse(fs.readFileSync(file, "utf-8"));
        Object.values(cache || {}).forEach((e) => {
          if (!e) return;
          [...(e.invoices || []), e.invoice, e.discovery, e].forEach((x) => {
            const reference = x && (x.packingSlip || x.reference);
            const invoiceNumber = x && (x.invoiceNumber || x.creditMemoNumber);
            if (reference && invoiceNumber) out.push({ reference, invoiceNumber });
          });
        });
      } catch (e) {
        console.error("[statements] invoice link scan failed", name, e);
      }
    }
    return out;
  }

  function reconcile({ supplierId, messageId } = {}) {
    try {
      if (!getSupplier(supplierId)) return { ok: false, error: "Unknown supplier." };
      const all = listCachedStatements(cachePathFor(supplierId), supplierId, supplierConfig(getSupplier(supplierId)).subject);
      const entry = messageId ? all.find((s) => s.messageId === messageId) : all[0];
      if (!entry) return { ok: false, error: "No statement on file yet — look one up in Gmail first." };
      const records = buildRecords({
        supplierId,
        orders: readOrders(),
        archive: readOrdersArchive(),
        manifests: readManifests(),
        links: readInvoiceLinks(supplierId),
        matchReference: Boolean(getSupplier(supplierId)?.matchReference),
      });
      const result = reconcileStatement(entry.statement, records);
      return { ok: true, statement: { messageId: entry.messageId, ...entry }, recordCount: records.length, ...result };
    } catch (e) {
      console.error("[statements:reconcile]", e);
      return { ok: false, error: e?.message || "Reconcile failed." };
    }
  }

  return { listSuppliers, setSupplierConfig, listStatements, fetchSupplierStatements, reconcile };
};

module.exports = { createStatementsService };
