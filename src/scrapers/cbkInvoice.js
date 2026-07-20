// src/scrapers/cbkInvoice.js
// MAIN ENTRY for the CBK-invoices-from-Gmail pipeline. Mirrors the BestBuy flow
// (search Gmail, parse each invoice, return discoveries the renderer batch-
// applies to matching orders) but CBK sends one email per order rather than a
// single batch: each email's subject carries the order number (the order's
// `reference`) and its single PDF attachment is one invoice named by invoice
// number. The Gmail search / attachment download / caching helpers are shared
// with the Transbec pipeline; CBK-specific parsing lives in cbkInvoice.actions.
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
const { extractCbkInvoice } = require("./cbkInvoice.actions");

function normalizeKey(s) {
  return String(s || "").trim().toUpperCase();
}

function assetName(id) {
  const safe = String(id || "").trim().replace(/[^A-Za-z0-9_-]/g, "_");
  return `cbk_invoice_${safe || "unknown"}.pdf`;
}

async function fetchCbkInvoices(options = {}) {
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

    statusLog.push("Searching Gmail for CBK invoices…");
    const messages = await searchInvoiceEmails(gmail, {
      sender,
      subjectPattern: subjectPattern || "Invoice",
      maxResults,
    });
    statusLog.push(`Found ${messages.length} CBK invoice email(s).`);

    const cache = loadInvoiceCache(cachePath);

    for (const msgRef of messages) {
      const messageId = msgRef.id;
      const cached = cache[messageId];

      // Reuse a cached parse only if its saved PDF is still on disk AND it
      // captured a total — a null total means an earlier parse failed, so
      // re-processing the email is what self-heals those stale entries.
      let invoice = null;
      if (
        cached &&
        cached.invoice &&
        (!cached.invoice.fileName || (dataDir && fs.existsSync(path.join(dataDir, cached.invoice.fileName)))) &&
        cached.invoice.total !== null &&
        cached.invoice.total !== undefined
      ) {
        invoice = cached.invoice;
      }

      if (!invoice) {
        const full = await gmail.users.messages.get({ userId: "me", id: messageId, format: "full" });
        const payload = full.data.payload || {};
        const subject = getHeader(payload, "Subject");
        const attachment = findPdfAttachment(payload);
        if (!attachment) {
          statusLog.push(`Skipped email with no PDF attachment (subject: “${subject}”).`);
          continue;
        }
        const pdfBuffer = await downloadAttachment(gmail, messageId, attachment.attachmentId);
        const parsed = await extractCbkInvoice(pdfBuffer, {
          filename: attachment.filename,
          subject,
        });
        console.log(
          `[cbk-invoice] ${messageId}: order=${parsed.orderNumber || "?"} invoice=${parsed.invoiceNumber || "?"} ` +
            `total=$${parsed.total ?? "?"} orderConfirmedInPdf=${parsed.orderNumberConfirmed}`
        );

        // Save the invoice PDF named by its invoice number (stable across future
        // searches), falling back to the message id if the number is unknown.
        let fileName = "";
        if (dataDir) {
          fileName = assetName(parsed.invoiceNumber || messageId);
          try {
            fs.writeFileSync(path.join(dataDir, fileName), pdfBuffer);
          } catch (e) {
            console.log(`[cbk-invoice] failed to save invoice PDF: ${e.message}`);
            fileName = "";
          }
        }

        invoice = {
          reference: parsed.orderNumber,
          invoiceNumber: parsed.invoiceNumber,
          total: parsed.total,
          fileName,
        };

        if (messageId) {
          cache[messageId] = { subject, invoice, checkedAt: new Date().toISOString() };
          saveInvoiceCache(cachePath, cache);
        }
      }

      if (!invoice.reference && !invoice.invoiceNumber) continue;
      // reference = CBK order number (the order's `reference`); invoiceNumber
      // travels along as a fallback match key.
      const discovery = {
        reference: invoice.reference || invoice.invoiceNumber,
        invoiceNumber: invoice.invoiceNumber,
        total: invoice.total ?? null,
        fileName: invoice.fileName || "",
        hasEnvironmentalFee: false,
      };
      discoveries.push(discovery);
      if (
        !matchedRow &&
        targetRef &&
        (normalizeKey(invoice.reference) === targetRef || normalizeKey(invoice.invoiceNumber) === targetRef)
      ) {
        matchedRow = { ...discovery };
      }
    }

    statusLog.push(`Extracted ${discoveries.length} CBK invoice(s).`);
    if (reference) {
      statusLog.push(
        matchedRow
          ? `Matched invoice ${matchedRow.invoiceNumber} for order ${reference}.`
          : `No invoice matched order ${reference}.`
      );
    }

    return { ok: true, discoveries, matchedRow, statusLog };
  } catch (err) {
    console.error("[cbk-invoice] error:", err);
    return { ok: false, error: err.message || String(err), statusLog, discoveries };
  }
}

module.exports = { fetchCbkInvoices };
