// src/scrapers/bestbuyCreditInvoice.js
// MAIN ENTRY for BestBuy CREDIT invoices from Gmail — a separate pipeline from
// the daily batch invoice email (bestbuyInvoice.js). These arrive one email
// per credit from bestautosolution.ca, subject "Re: Invoice 21-9074026" (the
// digits after the branch prefix are the invoice number). The same sender also
// sends "Re Order No.: 21-8664280" order-confirmation emails using the exact
// same reference numbering, so we can't just search Gmail for the bare
// reference number — every hit is checked against isOrderConfirmationSubject
// and dropped before it's ever treated as a credit invoice.
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
const { extractReferenceFromSubject, isOrderConfirmationSubject } = require("./bestbuyCreditInvoice.actions");
const { parseBestbuyInvoice, getPageRows, readTotalsFromPageRows } = require("./bestbuyInvoice.actions");

let pdfParse = null;
function getPdfParse() {
  if (!pdfParse) pdfParse = require("pdf-parse");
  return pdfParse;
}

function normalizeKey(s) {
  return String(s || "").trim().toUpperCase();
}

function assetName(id) {
  const safe = String(id || "").trim().replace(/[^A-Za-z0-9_-]/g, "_");
  return `bestbuy_credit_${safe || "unknown"}.pdf`;
}

// Read the Invoice Total off whichever page carries the summary row, reusing
// the same column-position logic as the batch pipeline (same invoice template).
async function extractPositionalTotal(pdfBuffer) {
  try {
    const pageRows = await getPageRows(pdfBuffer);
    for (const rows of pageRows) {
      const totals = readTotalsFromPageRows(rows);
      if (totals) return totals;
    }
  } catch (e) {
    console.log(`[bestbuy-credit-invoice] positional total extraction failed: ${e.message}`);
  }
  return null;
}

async function fetchBestbuyCreditInvoices(options = {}) {
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
  let ignoredOrderEmails = 0;
  const targetRef = normalizeKey(reference);

  try {
    if (dataDir) fs.mkdirSync(dataDir, { recursive: true });
    const gmail = getGmailService(getAuthorizedClient(credentials || {}));

    statusLog.push("Searching Gmail for BestBuy credit invoices…");
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

      if (cached === "order-confirmation") continue;

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

        // The critical filter: same sender/numbering as order-confirmation
        // emails, so this is checked before anything else runs.
        if (isOrderConfirmationSubject(subject)) {
          ignoredOrderEmails += 1;
          cache[messageId] = "order-confirmation";
          saveInvoiceCache(cachePath, cache);
          continue;
        }

        const attachment = findPdfAttachment(payload);
        if (!attachment) {
          statusLog.push(`Skipped credit invoice email with no PDF attachment (subject: "${subject}").`);
          continue;
        }
        const pdfBuffer = await downloadAttachment(gmail, messageId, attachment.attachmentId);
        const parsed = await getPdfParse()(pdfBuffer).catch((e) => {
          console.log(`[bestbuy-credit-invoice] pdf-parse failed: ${e.message}`);
          return { text: "" };
        });
        // parseBestbuyInvoice reads "Invoice No:" / "Packing Slip:" out of flat
        // text; it's written for one block of a batch PDF, but a single-invoice
        // PDF's whole text works the same way.
        const fromPdf = parseBestbuyInvoice(parsed.text || "");
        const positional = await extractPositionalTotal(pdfBuffer);
        // The subject's number is the PACKING SLIP (= the return order's
        // reference) — that's the match key. The real invoice number comes from
        // the PDF body. Fall back to the subject only if the PDF didn't parse.
        const subjectRef = extractReferenceFromSubject(subject);
        const packingSlip = fromPdf.packingSlip || subjectRef;
        const invoiceNumber = fromPdf.invoiceNumber || "";
        const total = positional && positional.total !== null ? positional.total : fromPdf.total;

        let fileName = "";
        if (dataDir) {
          fileName = assetName(invoiceNumber || packingSlip || messageId);
          try {
            fs.writeFileSync(path.join(dataDir, fileName), pdfBuffer);
          } catch (e) {
            console.log(`[bestbuy-credit-invoice] failed to save invoice PDF: ${e.message}`);
            fileName = "";
          }
        }

        invoice = {
          packingSlip,
          invoiceNumber,
          total,
          fileName,
        };

        cache[messageId] = { subject, invoice, checkedAt: new Date().toISOString() };
        saveInvoiceCache(cachePath, cache);
      }

      if (!invoice.packingSlip && !invoice.invoiceNumber) continue;
      // reference = packing slip (the original order's reference), falling
      // back to the credit invoice number for late-scrape cases.
      const discovery = {
        reference: invoice.packingSlip || invoice.invoiceNumber,
        packingSlip: invoice.packingSlip,
        invoiceNumber: invoice.invoiceNumber,
        total: invoice.total ?? null,
        fileName: invoice.fileName || "",
        isCredit: true,
      };
      discoveries.push(discovery);
      if (
        !matchedRow &&
        targetRef &&
        (normalizeKey(invoice.packingSlip) === targetRef || normalizeKey(invoice.invoiceNumber) === targetRef)
      ) {
        matchedRow = { ...discovery };
      }
    }

    if (ignoredOrderEmails > 0) {
      statusLog.push(`Ignored ${ignoredOrderEmails} order-confirmation email(s) (not credit invoices).`);
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
    console.error("[bestbuy-credit-invoice] error:", err);
    return { ok: false, error: err.message || String(err), statusLog, discoveries };
  }
}

module.exports = { fetchBestbuyCreditInvoices };
