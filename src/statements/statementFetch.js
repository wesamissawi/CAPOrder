// src/statements/statementFetch.js
// Find a supplier's statement emails in Gmail, parse the PDF on each and cache
// the result. Same shape as the invoice pipelines (transbecInvoice.js): the
// generic Gmail helpers are imported from transbecInvoice.actions.js and the
// PDF lands in the shared gmail asset dir so every machine can open it.
const fs = require("fs");
const path = require("path");
const { getAuthorizedClient, getGmailService } = require("../scrapers/gmail.auth");
const {
  findPdfAttachment,
  getHeader,
  downloadAttachment,
  searchInvoiceEmails,
  loadInvoiceCache,
  saveInvoiceCache,
} = require("../scrapers/transbecInvoice.actions");
const { isoToGmailDate, addDaysIso, todayIso } = require("../scrapers/transbecCreditInvoice.actions");
const { parseStatementPdf, parseStatementHtml } = require("./statementParse");
const { getSupplier } = require("./statementSuppliers");

// Bump when the parser changes so cached parses of the same PDFs are redone —
// the PDFs never change, so without this an old (wrong) parse lives forever.
const PARSER_VERSION = 3;
const DEFAULT_LOOKBACK_DAYS = 75;

// First text/html part of the message (decoded), or "".
function findHtmlBody(payload) {
  const stack = [payload].filter(Boolean);
  while (stack.length) {
    const part = stack.shift();
    if (part.mimeType === "text/html" && part.body && part.body.data && !part.filename) {
      return Buffer.from(part.body.data, "base64").toString("utf8");
    }
    if (Array.isArray(part.parts)) stack.push(...part.parts);
  }
  return "";
}

const safe = (s) => String(s || "").replace(/[^A-Za-z0-9_-]/g, "_");
const statementFileName = (supplierId, messageId, ext = "pdf") => `statement_${safe(supplierId)}_${safe(messageId)}.${ext}`;

const emailDateIso = (raw) => {
  const t = Date.parse(raw || "");
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : "";
};

async function fetchStatements(options = {}) {
  const { credentials, supplierId, sender, subjectPattern, dataDir, cachePath, maxResults = 10, fromDate, toDate } = options;
  const statusLog = [];
  try {
    if (!supplierId) throw new Error("No supplier given.");
    if (dataDir) fs.mkdirSync(dataDir, { recursive: true });
    const gmail = getGmailService(getAuthorizedClient(credentials || {}));

    const to = toDate || todayIso();
    const from = fromDate || addDaysIso(to, -DEFAULT_LOOKBACK_DAYS);
    statusLog.push(`Searching Gmail for ${supplierId} statements (${from} to ${to})…`);
    const messages = await searchInvoiceEmails(gmail, {
      sender,
      subjectPattern,
      maxResults,
      anyAttachment: true,
      after: isoToGmailDate(from),
      before: isoToGmailDate(addDaysIso(to, 1)),
    });
    statusLog.push(`Found ${messages.length} candidate email(s).`);

    const cache = loadInvoiceCache(cachePath);
    const found = [];
    for (const { id: messageId } of messages) {
      const cached = cache[messageId];
      if (
        cached && cached.parserVersion === PARSER_VERSION && cached.statement &&
        (!cached.fileName || (dataDir && fs.existsSync(path.join(dataDir, cached.fileName))))
      ) {
        found.push({ messageId, ...cached });
        continue;
      }
      const full = await gmail.users.messages.get({ userId: "me", id: messageId, format: "full" });
      const payload = full.data.payload || {};
      const subject = getHeader(payload, "Subject");
      // Most suppliers attach a PDF; Tiger puts an HTML table in the email body.
      const attachment = findPdfAttachment(payload);
      const html = attachment ? "" : findHtmlBody(payload);
      if (!attachment && !html) {
        statusLog.push(`Skipped an email with no PDF attachment and no readable body (subject: “${subject}”).`);
        continue;
      }
      const dateOrder = getSupplier(supplierId)?.dateOrder;
      let statement;
      let raw; // what we keep on disk so the statement can be opened later
      let ext;
      try {
        if (attachment) {
          raw = await downloadAttachment(gmail, messageId, attachment.attachmentId);
          ext = "pdf";
          statement = await parseStatementPdf(raw, { dateOrder });
        } else {
          raw = Buffer.from(html, "utf8");
          ext = "html";
          statement = await parseStatementHtml(html, { dateOrder });
        }
      } catch (e) {
        statusLog.push(`Could not read the statement on “${subject}”: ${e.message}`);
        continue;
      }
      const emailDate = emailDateIso(getHeader(payload, "Date"));
      let fileName = statementFileName(supplierId, messageId, ext);
      try {
        fs.writeFileSync(path.join(dataDir, fileName), raw);
      } catch (e) {
        statusLog.push(`Could not save the statement file: ${e.message}`);
        fileName = "";
      }
      const entry = {
        supplierId, subject, emailDate, fileName,
        statement: { ...statement, statementDate: statement.statementDate || emailDate },
        parserVersion: PARSER_VERSION,
        checkedAt: new Date().toISOString(),
      };
      cache[messageId] = entry;
      saveInvoiceCache(cachePath, cache);
      found.push({ messageId, ...entry });
      statusLog.push(`Read “${subject}”: ${statement.lines.length} line(s).`);
    }
    found.sort((a, b) => String(b.statement.statementDate || b.emailDate).localeCompare(String(a.statement.statementDate || a.emailDate)));
    return { ok: true, statements: found, statusLog };
  } catch (err) {
    console.error("[statements] error:", err);
    return { ok: false, error: err.message || String(err), statusLog };
  }
}

// Cached statements for a supplier, no Gmail call — what the view shows on open.
// Entries from an older parser are hidden (a lookup re-reads them), and so are emails whose
// subject isn't this supplier's - a lookup run with a blank sender once cached other
// suppliers' statements under this one.
function listCachedStatements(cachePath, supplierId, subjectPattern = "") {
  const cache = loadInvoiceCache(cachePath);
  const norm = (s) => String(s || "").replace(/\s+/g, " ").trim().toLowerCase();
  const want = norm(subjectPattern);
  return Object.entries(cache)
    .filter(([, v]) => v && v.statement && v.supplierId === supplierId && v.parserVersion === PARSER_VERSION)
    .filter(([, v]) => !want || norm(v.subject).includes(want))
    .map(([messageId, v]) => ({ messageId, ...v }))
    .sort((a, b) => String(b.statement.statementDate || b.emailDate).localeCompare(String(a.statement.statementDate || a.emailDate)));
}

module.exports = { fetchStatements, listCachedStatements, DEFAULT_LOOKBACK_DAYS };
