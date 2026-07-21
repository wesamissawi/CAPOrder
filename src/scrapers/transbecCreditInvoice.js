// src/scrapers/transbecCreditInvoice.js
// MAIN ENTRY for Transbec CREDIT memos from Gmail. Unlike BestBuy credits
// (which always patch onto a return order already scraped from the vendor
// site), a Transbec credit has NO pre-existing order in orders.json — the
// credit memo email is the only record of it. So a discovery here is just
// listed for the user; turning it into an order happens via a separate
// "Create order" action (the Epicor view's Transbec Credits section), not
// automatically here.
const fs = require("fs");
const path = require("path");
const { getAuthorizedClient, getGmailService } = require("./gmail.auth");
const {
  findPdfAttachment,
  getHeader,
  downloadAttachment,
  searchInvoiceEmails,
  loadInvoiceCache,
  saveInvoiceCache,
} = require("./transbecInvoice.actions");
const {
  extractPoReferenceFromSubject,
  isPickTicketSubject,
  extractCreditMemoFromPdf,
  getCreditMemoAssetName,
  isoToGmailDate,
  addDaysIso,
  todayIso,
} = require("./transbecCreditInvoice.actions");

// Default search window when the caller doesn't specify one: the trailing 5
// days, so a plain "check for credits" click doesn't unboundedly re-list every
// credit memo Transbec has ever sent — see [[transbec-credit-memos]] memory.
const DEFAULT_LOOKBACK_DAYS = 5;

async function fetchTransbecCreditInvoices(options = {}) {
  const {
    credentials, // { clientId, clientSecret, refreshToken }
    sender,
    subjectPattern,
    dataDir,
    cachePath,
    maxResults = 25,
    fromDate, // ISO "YYYY-MM-DD"; defaults to 5 days ago
    toDate, // ISO "YYYY-MM-DD"; defaults to today
  } = options;

  const statusLog = [];
  const discoveries = [];

  try {
    if (dataDir) fs.mkdirSync(dataDir, { recursive: true });
    const gmail = getGmailService(getAuthorizedClient(credentials || {}));

    const effectiveTo = toDate || todayIso();
    const effectiveFrom = fromDate || addDaysIso(effectiveTo, -DEFAULT_LOOKBACK_DAYS);
    // Gmail's "before:" is exclusive of that day, so bump it by one day to make
    // the visible range inclusive of effectiveTo.
    const after = isoToGmailDate(effectiveFrom);
    const before = isoToGmailDate(addDaysIso(effectiveTo, 1));

    statusLog.push(`Searching Gmail for Transbec credit memos (${effectiveFrom} to ${effectiveTo})…`);
    const messages = await searchInvoiceEmails(gmail, {
      sender,
      subjectPattern: subjectPattern || "Credit Memo",
      maxResults,
      after,
      before,
    });
    statusLog.push(`Found ${messages.length} candidate email(s).`);

    const cache = loadInvoiceCache(cachePath);

    for (const msgRef of messages) {
      const messageId = msgRef.id;
      const cached = cache[messageId];

      if (cached === "pick-ticket") continue;

      // Reuse a cached parse only if its saved PDF is still on disk AND it
      // was parsed by a version of this code that captured lineItems — older
      // cache entries (from before line-item extraction existed) would
      // otherwise be trusted forever and never re-parsed, since the PDF file
      // itself never goes away. Same self-healing idea as the BestBuy
      // invoice cache's "total !== null" check.
      let discovery = null;
      if (
        cached &&
        cached.discovery &&
        Array.isArray(cached.discovery.lineItems) &&
        (!cached.discovery.fileName ||
          (dataDir && fs.existsSync(path.join(dataDir, cached.discovery.fileName))))
      ) {
        discovery = { ...cached.discovery, checkedAt: cached.checkedAt };
        console.log(
          `[transbec-credit] ${messageId}: reusing cached parse — memo=${discovery.creditMemoNumber || "(none)"} ` +
            `ref=${discovery.reference || "(none)"} lineItems=${discovery.lineItems.length}`
        );
      } else if (cached && cached.discovery) {
        console.log(`[transbec-credit] ${messageId}: cached entry is stale (no lineItems captured) — re-parsing`);
      }

      if (!discovery) {
        const full = await gmail.users.messages.get({ userId: "me", id: messageId, format: "full" });
        const payload = full.data.payload || {};
        const subject = getHeader(payload, "Subject");

        // "Credit Memo Pick Ticket TRB LAVAL" — a warehouse notification that
        // matches the "Credit Memo" subject search but isn't an actual credit
        // memo (confirmed on a real account: no Cust PO, no parseable
        // fields). Filtered here, same idea as BestBuy's order-confirmation
        // filter, so it's never retried on future scans either.
        if (isPickTicketSubject(subject)) {
          cache[messageId] = "pick-ticket";
          saveInvoiceCache(cachePath, cache);
          statusLog.push(`Skipped a Pick Ticket notification (not a credit memo): "${subject}".`);
          continue;
        }

        const poReference = extractPoReferenceFromSubject(subject);

        const attachment = findPdfAttachment(payload);
        if (!attachment) {
          statusLog.push(`Skipped credit memo email with no PDF attachment (subject: "${subject}").`);
          continue;
        }
        const pdfBuffer = await downloadAttachment(gmail, messageId, attachment.attachmentId);
        const parsed = await extractCreditMemoFromPdf(pdfBuffer);

        console.log(
          `[transbec-credit] ${messageId}: subject="${subject}" subjectRef=${poReference || "(none)"} ` +
            `memo=${parsed.creditMemoNumber || "(none)"} packingSlip=${parsed.packingSlip || "(none)"} ` +
            `poNumber=${parsed.poNumber || "(none)"} customer=${parsed.customerNumber || "(none)"} ` +
            `total=${parsed.total ?? "(none)"} usedOcr=${parsed.usedOcr} textLen=${(parsed.text || "").length} ` +
            `lineItems=${(parsed.lineItems || []).length}`
        );
        if (!parsed.lineItems || parsed.lineItems.length === 0) {
          // No line items matched — dump the raw extracted text so it can be
          // compared against the CREDIT_LINE_ITEM_RE regex by hand. This is
          // the main thing to check if items aren't showing up: pdf-parse's
          // real output for this PDF may not line-break/space exactly like
          // the sample the regex was built against.
          console.log(`[transbec-credit] ${messageId}: RAW TEXT (no line items matched) —\n${parsed.text || "(empty)"}`);
        }

        let fileName = "";
        if (dataDir) {
          fileName = getCreditMemoAssetName(parsed.creditMemoNumber || poReference || messageId);
          try {
            fs.writeFileSync(path.join(dataDir, fileName), pdfBuffer);
          } catch (e) {
            console.log(`[transbec-credit] failed to save PDF: ${e.message}`);
            fileName = "";
          }
        }

        const checkedAt = new Date().toISOString();
        discovery = {
          // Packing slip (unique per credit) is the real reference; the
          // subject's customer number is the same across every credit for
          // this customer, so it's only a last-resort fallback — see the
          // file header comment in transbecCreditInvoice.actions.js.
          reference: parsed.packingSlip || poReference || parsed.creditMemoNumber || "",
          creditMemoNumber: parsed.creditMemoNumber || "",
          packingSlip: parsed.packingSlip || "",
          poNumber: parsed.poNumber || "",
          customerNumber: parsed.customerNumber || poReference || "",
          total: parsed.total,
          lineItems: Array.isArray(parsed.lineItems) ? parsed.lineItems : [],
          fileName,
          subject,
          checkedAt,
        };

        cache[messageId] = { subject, discovery, checkedAt };
        saveInvoiceCache(cachePath, cache);
      }

      if (!discovery.reference && !discovery.creditMemoNumber) {
        statusLog.push("Skipped a credit memo with no readable PO reference or credit number.");
        continue;
      }
      discoveries.push(discovery);
    }

    statusLog.push(`Extracted ${discoveries.length} credit memo(s).`);
    return { ok: true, discoveries, statusLog };
  } catch (err) {
    console.error("[transbec-credit] error:", err);
    return { ok: false, error: err.message || String(err), statusLog, discoveries };
  }
}

module.exports = { fetchTransbecCreditInvoices };
