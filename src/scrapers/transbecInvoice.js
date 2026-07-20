// src/scrapers/transbecInvoice.js
// MAIN ENTRY for the Transbec-invoice-from-Gmail pipeline. Called from Electron
// main via IPC. Mirrors epicorScraper.openEpicorSite: it discovers invoice data
// for EVERY candidate email (not just the order that was clicked) so the caller
// can batch-fill every matching order in Order Management.
const fs = require("fs");
const path = require("path");
const { getAuthorizedClient, getGmailService } = require("./gmail.auth");
const {
  extractReferenceFromSubject,
  findPdfAttachment,
  getHeader,
  extractInvoiceFromPdf,
  getInvoiceAssetName,
  downloadAttachment,
  searchInvoiceEmails,
  loadInvoiceCache,
  saveInvoiceCache,
} = require("./transbecInvoice.actions");

function normalizeKey(s) {
  return String(s || "").trim().toUpperCase();
}

async function fetchTransbecInvoices(options = {}) {
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

  try {
    if (dataDir) fs.mkdirSync(dataDir, { recursive: true });
    const authClient = getAuthorizedClient(credentials || {});
    const gmail = getGmailService(authClient);

    statusLog.push("Searching Gmail for Transbec invoice emails…");
    const messages = await searchInvoiceEmails(gmail, { sender, subjectPattern, maxResults });
    statusLog.push(`Found ${messages.length} candidate email(s).`);

    const cache = loadInvoiceCache(cachePath);
    const targetRef = normalizeKey(reference);

    for (const msgRef of messages) {
      const messageId = msgRef.id;
      const cached = cache[messageId];

      // Reuse a previous parse if we still have its saved PDF on disk.
      if (cached) {
        const fileName = cached.fileName || "";
        const fileExists = Boolean(dataDir) && fileName && fs.existsSync(path.join(dataDir, fileName));
        if (fileExists && cached.reference) {
          const discovery = {
            reference: cached.reference,
            invoiceNumber: cached.invoiceNumber || "",
            total: cached.total ?? cached.balanceDue ?? null,
            balanceDue: cached.balanceDue ?? null,
            fileName,
          };
          discoveries.push(discovery);
          if (!matchedRow && targetRef && normalizeKey(cached.reference) === targetRef) {
            matchedRow = { ...discovery };
          }
          continue;
        }
      }

      // Fetch the full message: subject (reference) + attachment tree.
      const full = await gmail.users.messages.get({ userId: "me", id: messageId, format: "full" });
      const payload = full.data.payload || {};
      const subject = getHeader(payload, "Subject");
      const subjectRef = extractReferenceFromSubject(subject);

      const attachment = findPdfAttachment(payload);
      if (!attachment) {
        statusLog.push(`Skipped an email with no PDF attachment (subject: “${subject}”).`);
        continue;
      }

      const pdfBuffer = await downloadAttachment(gmail, messageId, attachment.attachmentId);
      const parsed = await extractInvoiceFromPdf(pdfBuffer);
      console.log(
        `[transbec-invoice] ${messageId}: subject="${subject}" subjectRef=${subjectRef || "(none)"} ` +
          `inv=${parsed.invoiceNumber || "(none)"} total=${parsed.invoiceTotal ?? "(none)"} ` +
          `bal=${parsed.balanceDue ?? "(none)"} pdfRef=${parsed.pdfReference || "(none)"} ` +
          `usedOcr=${parsed.usedOcr} textLen=${(parsed.text || "").length}`
      );

      // Subject reference is the authoritative match key; fall back to the one
      // printed on the invoice if the subject didn't contain one.
      const discoveredReference = subjectRef || parsed.pdfReference || "";
      const invoiceNumber = parsed.invoiceNumber || "";

      // Persist the raw PDF (named by invoice number, so it survives future
      // searches) — it's both the archive artifact and what the Verify modal
      // displays. We show the real PDF rather than a rasterized preview: pdfjs
      // (pdf-to-png-converter) silently drops most of these invoices' content
      // when rendering to an image, but Chromium's PDF viewer shows them fully.
      let fileName = "";
      if (dataDir && invoiceNumber) {
        fileName = getInvoiceAssetName(invoiceNumber, "pdf");
        try {
          fs.writeFileSync(path.join(dataDir, fileName), pdfBuffer);
        } catch (e) {
          console.log(`[transbec-invoice] failed to save PDF: ${e.message}`);
          fileName = "";
        }
      }

      if (messageId) {
        cache[messageId] = {
          reference: discoveredReference,
          invoiceNumber,
          total: parsed.invoiceTotal,
          balanceDue: parsed.balanceDue,
          fileName,
          subject,
          usedOcr: parsed.usedOcr,
          checkedAt: new Date().toISOString(),
        };
        saveInvoiceCache(cachePath, cache);
      }

      if (discoveredReference) {
        const discovery = {
          reference: discoveredReference,
          invoiceNumber,
          total: parsed.invoiceTotal ?? parsed.balanceDue ?? null,
          balanceDue: parsed.balanceDue ?? null,
          fileName,
        };
        discoveries.push(discovery);
        if (!matchedRow && targetRef && normalizeKey(discoveredReference) === targetRef) {
          matchedRow = { ...discovery };
        }
      } else {
        statusLog.push(`Could not read a reference for email (subject: “${subject}”).`);
      }
    }

    statusLog.push(`Extracted invoice data for ${discoveries.length} email(s).`);
    if (reference) {
      statusLog.push(
        matchedRow
          ? `Matched invoice ${matchedRow.invoiceNumber} for order ${reference}.`
          : `No invoice matched order ${reference}.`
      );
    }

    return { ok: true, discoveries, matchedRow, statusLog };
  } catch (err) {
    console.error("[transbec-invoice] error:", err);
    return { ok: false, error: err.message || String(err), statusLog, discoveries };
  }
}

module.exports = { fetchTransbecInvoices };
