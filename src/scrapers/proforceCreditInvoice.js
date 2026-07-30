// src/scrapers/proforceCreditInvoice.js
// MAIN ENTRY for Proforce CREDIT invoices from Gmail. Proforce never emails
// regular invoices — those are already fully captured by the portal scrape
// (proforceScraper.js) — but credit memos arrive one email per credit from
// noreply@epartconnection.com, subject "Invoice #652522", attachment
// "652522.pdf". The order for a credit already exists by the time this runs
// (proforceScraper.js flags it via isCreditFromLineItems); this pipeline only
// fetches the PDF itself so it can be viewed/printed, exactly like the
// BestBuy/Transbec credit pipelines do for their own vendors.
const fs = require("fs");
const path = require("path");
const { getAuthorizedClient, getGmailService } = require("./gmail.auth");
const {
  searchInvoiceEmails,
  findPdfAttachment,
  downloadAttachment,
  getHeader,
  loadInvoiceCache,
  saveInvoiceCache,
} = require("./transbecInvoice.actions");
const { extractReferenceFromSubject, getProforceCreditAssetName } = require("./proforceCreditInvoice.actions");

function normalizeKey(s) {
  return String(s || "").trim().toUpperCase();
}

async function fetchProforceCreditInvoices(options = {}) {
  const {
    credentials, // { clientId, clientSecret, refreshToken }
    sender,
    subjectPattern,
    reference, // the order that triggered this run (for matchedRow); optional
    dataDir,
    cachePath,
    maxResults = 25,
  } = options;

  const statusLog = [];
  const discoveries = [];
  let matchedRow = null;
  const targetRef = normalizeKey(reference);

  try {
    if (dataDir) fs.mkdirSync(dataDir, { recursive: true });
    const gmail = getGmailService(getAuthorizedClient(credentials || {}));

    statusLog.push("Searching Gmail for Proforce credit invoices…");
    const messages = await searchInvoiceEmails(gmail, {
      sender,
      subjectPattern: subjectPattern || "invoice",
      maxResults,
    });
    statusLog.push(`Found ${messages.length} candidate email(s).`);

    const cache = loadInvoiceCache(cachePath);

    for (const msgRef of messages) {
      const messageId = msgRef.id;
      const cached = cache[messageId];

      // Reuse a cached parse only if its saved PDF is still on disk — a
      // missing file (e.g. dataDir was cleared) is what self-heals a stale entry.
      let invoice = null;
      if (
        cached &&
        cached.invoice &&
        (!cached.invoice.fileName || (dataDir && fs.existsSync(path.join(dataDir, cached.invoice.fileName))))
      ) {
        invoice = cached.invoice;
      }

      if (!invoice) {
        const full = await gmail.users.messages.get({ userId: "me", id: messageId, format: "full" });
        const payload = full.data.payload || {};
        const subject = getHeader(payload, "Subject");

        const attachment = findPdfAttachment(payload);
        if (!attachment) {
          statusLog.push(`Skipped credit invoice email with no PDF attachment (subject: "${subject}").`);
          continue;
        }

        // The subject carries the invoice number ("Invoice #652522"); the
        // attachment is literally named "<number>.pdf" - used as a fallback
        // if the subject ever doesn't match.
        const attachmentRef = (attachment.filename || "").replace(/\.pdf$/i, "");
        const invoiceNumber = extractReferenceFromSubject(subject) || attachmentRef;
        if (!invoiceNumber) {
          statusLog.push(`Skipped credit invoice email with no invoice number found (subject: "${subject}").`);
          continue;
        }

        const pdfBuffer = await downloadAttachment(gmail, messageId, attachment.attachmentId);

        let fileName = "";
        if (dataDir) {
          fileName = getProforceCreditAssetName(invoiceNumber);
          try {
            fs.writeFileSync(path.join(dataDir, fileName), pdfBuffer);
          } catch (e) {
            console.log(`[proforce-credit-invoice] failed to save invoice PDF: ${e.message}`);
            fileName = "";
          }
        }

        invoice = { invoiceNumber, fileName };
        cache[messageId] = { subject, invoice, checkedAt: new Date().toISOString() };
        saveInvoiceCache(cachePath, cache);
      }

      if (!invoice.invoiceNumber) continue;
      const discovery = {
        reference: invoice.invoiceNumber,
        invoiceNumber: invoice.invoiceNumber,
        fileName: invoice.fileName || "",
        isCredit: true,
      };
      discoveries.push(discovery);
      if (!matchedRow && targetRef && normalizeKey(invoice.invoiceNumber) === targetRef) {
        matchedRow = { ...discovery };
      }
    }

    statusLog.push(`Extracted ${discoveries.length} credit invoice(s).`);
    if (reference) {
      statusLog.push(
        matchedRow
          ? `Matched credit invoice ${matchedRow.invoiceNumber} for order ${reference}.`
          : `No credit invoice matched order ${reference}.`
      );
    }

    return { ok: true, discoveries, matchedRow, statusLog };
  } catch (err) {
    console.error("[proforce-credit-invoice] error:", err);
    return { ok: false, error: err.message || String(err), statusLog, discoveries };
  }
}

module.exports = { fetchProforceCreditInvoices };
