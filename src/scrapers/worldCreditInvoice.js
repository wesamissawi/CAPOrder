// src/scrapers/worldCreditInvoice.js
// MAIN ENTRY for World Automotive Warehouse CREDIT MEMOS from Gmail. Like
// Transbec credit memos (transbecCreditInvoice.js) and unlike the regular
// World invoice pipeline (worldInvoice.js), a credit memo has NO pre-existing
// order to patch — it's a return against a past sale, so it's purely a
// discovery list. The Credits view's "Create order" button turns a discovery
// into a new order.
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
// Date-range helpers were built for the Transbec credit pipeline but are
// generic — reused here rather than duplicated.
const { isoToGmailDate, addDaysIso, todayIso } = require("./transbecCreditInvoice.actions");
const { extractCreditMemoFromPdf, getCreditMemoAssetName } = require("./worldCreditInvoice.actions");

// Default search window when the caller doesn't specify one — mirrors the
// Transbec credit pipeline's trailing 5-day default, see
// [[transbec-credit-memos]].
const DEFAULT_LOOKBACK_DAYS = 5;

function normalizeKey(s) {
  return String(s || "").trim().toUpperCase();
}

function toDiscovery(entry) {
  return {
    reference: entry.reference || "",
    creditMemoNumber: entry.creditMemoNumber || "",
    packingSlip: entry.packingSlip || "",
    creditDate: entry.creditDate || "",
    total: entry.total ?? null,
    balanceDue: entry.balanceDue ?? null,
    lineItems: Array.isArray(entry.lineItems) ? entry.lineItems : [],
    hasEnvironmentalFee: Boolean(entry.hasEnvironmentalFee),
    environmentalFeeAmount: entry.environmentalFeeAmount || "",
    fileName: entry.fileName || "",
    checksOk: entry.checksOk !== false,
  };
}

async function fetchWorldCreditInvoices(options = {}) {
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
    const after = isoToGmailDate(effectiveFrom);
    const before = isoToGmailDate(addDaysIso(effectiveTo, 1));

    statusLog.push(`Searching Gmail for World credit memos (${effectiveFrom} to ${effectiveTo})…`);
    const messages = await searchInvoiceEmails(gmail, {
      sender,
      subjectPattern,
      maxResults,
      after,
      before,
    });
    statusLog.push(`Found ${messages.length} candidate email(s).`);

    const cache = loadInvoiceCache(cachePath);

    for (const msgRef of messages) {
      const messageId = msgRef.id;
      const cached = cache[messageId];

      // Reuse a cached parse only if its saved PDF is still on disk AND it
      // carries a reference AND a creditDate — same self-healing rule as the
      // World invoice cache (an older/failed parse is never trusted forever).
      // creditDate joined the condition when the credit's Sage posting date
      // started coming from it; without it an old entry would keep feeding
      // dateless orders that post under today.
      let discovery = null;
      if (
        cached &&
        cached.discovery &&
        cached.discovery.reference &&
        cached.discovery.creditDate &&
        (!cached.discovery.fileName ||
          (dataDir && fs.existsSync(path.join(dataDir, cached.discovery.fileName))))
      ) {
        discovery = { ...cached.discovery, checkedAt: cached.checkedAt };
      }

      if (!discovery) {
        const full = await gmail.users.messages.get({ userId: "me", id: messageId, format: "full" });
        const payload = full.data.payload || {};
        const subject = getHeader(payload, "Subject");

        const attachment = findPdfAttachment(payload);
        if (!attachment) {
          statusLog.push(`Skipped a credit memo email with no PDF attachment (subject: "${subject}").`);
          continue;
        }
        const pdfBuffer = await downloadAttachment(gmail, messageId, attachment.attachmentId);

        let parsed;
        try {
          parsed = await extractCreditMemoFromPdf(pdfBuffer);
        } catch (e) {
          statusLog.push(`Could not read the PDF on "${subject}": ${e.message}`);
          console.log(`[world-credit] ${messageId}: parse failed: ${e.message}`);
          continue;
        }

        console.log(
          `[world-credit] ${messageId}: subject="${subject}" memo=${parsed.creditMemoNumber || "(none)"} ` +
            `packingSlip=${parsed.packingSlip || "(none)"} total=${parsed.total ?? "(none)"} ` +
            `items=${parsed.lineItems.length} checks=${JSON.stringify(parsed.checks)}`
        );

        if (!parsed.checks.ok) {
          const failed = Object.entries(parsed.checks)
            .filter(([k, v]) => k !== "ok" && !v)
            .map(([k]) => k)
            .join(", ");
          statusLog.push(
            `Credit memo ${parsed.creditMemoNumber || "(unknown)"} did not reconcile (${failed}) — please verify it manually.`
          );
        }

        let fileName = "";
        if (dataDir && (parsed.creditMemoNumber || parsed.packingSlip)) {
          fileName = getCreditMemoAssetName(parsed.creditMemoNumber || parsed.packingSlip);
          try {
            fs.writeFileSync(path.join(dataDir, fileName), pdfBuffer);
          } catch (e) {
            console.log(`[world-credit] failed to save PDF: ${e.message}`);
            fileName = "";
          }
        }

        const checkedAt = new Date().toISOString();
        discovery = {
          // The packing slip is the only per-credit identifier on the
          // document (no ACX order reference on a credit) — same convention
          // as Transbec credit memos.
          reference: parsed.packingSlip || parsed.creditMemoNumber || "",
          creditMemoNumber: parsed.creditMemoNumber || "",
          packingSlip: parsed.packingSlip || "",
          creditDate: parsed.creditDate || "",
          total: parsed.total,
          balanceDue: parsed.balanceDue,
          lineItems: parsed.lineItems,
          hasEnvironmentalFee: parsed.hasEnvironmentalFee,
          environmentalFeeAmount: parsed.environmentalFeeAmount,
          fileName,
          checksOk: parsed.checks.ok,
          subject,
          checkedAt,
        };

        cache[messageId] = { subject, discovery, checkedAt };
        saveInvoiceCache(cachePath, cache);
      }

      if (!discovery.reference) {
        statusLog.push("Skipped a credit memo with no readable packing slip or credit number.");
        continue;
      }
      discoveries.push(toDiscovery(discovery));
    }

    statusLog.push(`Extracted ${discoveries.length} credit memo(s).`);
    return { ok: true, discoveries, statusLog };
  } catch (err) {
    console.error("[world-credit] error:", err);
    return { ok: false, error: err.message || String(err), statusLog, discoveries };
  }
}

module.exports = { fetchWorldCreditInvoices };
