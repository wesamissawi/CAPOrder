// src/scrapers/worldConfGapInvoice.js
//
// ============================================================================
// TEMPORARY — TEMP-WORLD-SITE-GAP
// Delete this whole file when b2b.groupe-monaco.ca lists every order again.
// Full removal steps: WORLD_SITE_GAP_TEMP_FIX.md at the repo root.
// ============================================================================
//
// WHY THIS EXISTS (2026-11-21): World's new B2B site (b2b.groupe-monaco.ca)
// leaves some orders out of its order history (PO2057 and PO2074 were
// delivered and invoiced by email but never appeared there), so the order
// scrape never creates them. The regular World invoice check can only fill in
// an order that already exists, and the World PO check (worldStandaloneInvoice.js)
// deliberately ignores any invoice that prints a conf number. Net effect before
// this file: an invoice for an order the site hid went nowhere.
//
// WHAT IT DOES: finds World invoice emails that DO carry a conf number, parses
// the PDF with the existing World parser, and hands each one back as a
// "discovery". The renderer (handleFetchWorldConfGapInvoices in App.jsx) builds
// an order from a discovery ONLY when no order with that reference exists yet.
// The order's reference is the conf number (PO2057), exactly what the scraper
// would have given it, so if the site later lists the order the scraper sees the
// reference is taken and skips it — no duplicate.
//
// Nothing existing is modified for this: it reuses (imports) the parser and
// Gmail helpers, and keeps its OWN cache file so it cannot disturb the verdicts
// the regular and PO scans have cached for the same emails.
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
const { isoToGmailDate, addDaysIso, todayIso } = require("./transbecCreditInvoice.actions");
const { extractInvoiceFromPdf, getInvoiceAssetName } = require("./worldInvoice.actions");
const { extractCustomerPoFromSubject, auditCoreCharges } = require("./worldStandaloneInvoice");

// Runs every ghost cycle (~30 min). Parsed results are cached, so the only
// recurring cost is one Gmail search; a few days of lookback covers a machine
// that was switched off over a weekend.
const DEFAULT_LOOKBACK_DAYS = 4;

// The mirror image of worldStandaloneInvoice.subjectIsStandaloneInvoice: that
// one wants invoices WITHOUT "conf", this one wants the ones WITH it.
function subjectIsConfInvoice(subject) {
  const text = String(subject || "");
  if (!/invoice\s+for\s+\d+/i.test(text)) return false;
  if (!/\bconf\b/i.test(text)) return false;
  if (/credit/i.test(text)) return false;
  return true;
}

function toDiscovery(entry) {
  return {
    reference: entry.reference || "", // the CONF number (PO2057)
    invoiceNumber: entry.invoiceNumber || "",
    customerPo: entry.customerPo || "",
    packingSlip: entry.packingSlip || "",
    invoiceDate: entry.invoiceDate || "",
    total: entry.total ?? entry.balanceDue ?? null,
    balanceDue: entry.balanceDue ?? null,
    totalCore: entry.totalCore ?? 0,
    lineItems: Array.isArray(entry.lineItems) ? entry.lineItems : [],
    hasEnvironmentalFee: Boolean(entry.hasEnvironmentalFee),
    environmentalFeeAmount: entry.environmentalFeeAmount || "",
    fileName: entry.fileName || "",
    checksOk: entry.checksOk !== false,
    checkFailures: Array.isArray(entry.checkFailures) ? entry.checkFailures : [],
    subject: entry.subject || "",
    checkedAt: entry.checkedAt || "",
  };
}

async function fetchWorldConfGapInvoices(options = {}) {
  const {
    credentials, // { clientId, clientSecret, refreshToken }
    sender,
    subjectPattern,
    dataDir,
    cachePath,
    maxResults = 100,
    fromDate, // ISO "YYYY-MM-DD"
    toDate, // ISO "YYYY-MM-DD"
  } = options;

  const statusLog = [];
  const discoveries = [];

  try {
    if (dataDir) fs.mkdirSync(dataDir, { recursive: true });
    const gmail = getGmailService(getAuthorizedClient(credentials || {}));

    const effectiveTo = toDate || todayIso();
    const effectiveFrom = fromDate || addDaysIso(effectiveTo, -DEFAULT_LOOKBACK_DAYS);
    statusLog.push(`Searching Gmail for World conf invoices (${effectiveFrom} to ${effectiveTo})…`);
    const messages = await searchInvoiceEmails(gmail, {
      sender,
      subjectPattern,
      maxResults,
      after: isoToGmailDate(effectiveFrom),
      before: isoToGmailDate(addDaysIso(effectiveTo, 1)),
    });
    statusLog.push(`Found ${messages.length} candidate email(s).`);

    const cache = loadInvoiceCache(cachePath);

    for (const msgRef of messages) {
      const messageId = msgRef.id;
      const cached = cache[messageId];
      if (cached && cached.skipped) continue; // another pipeline's mail, already identified

      // Reuse a parse only if it is usable and its PDF is still on disk. A
      // failed arithmetic audit is deliberately NOT trusted, so the failure is
      // re-reported every run instead of being pinned in the cache.
      let discovery = null;
      if (
        cached &&
        cached.discovery &&
        cached.discovery.invoiceNumber &&
        cached.discovery.total != null &&
        cached.discovery.checksOk !== false &&
        (!cached.discovery.fileName ||
          (dataDir && fs.existsSync(path.join(dataDir, cached.discovery.fileName))))
      ) {
        discovery = { ...cached.discovery, checkedAt: cached.checkedAt };
      }

      if (!discovery) {
        const full = await gmail.users.messages.get({ userId: "me", id: messageId, format: "full" });
        const payload = full.data.payload || {};
        const subject = getHeader(payload, "Subject");

        if (!subjectIsConfInvoice(subject)) {
          cache[messageId] = { subject, skipped: "subject", checkedAt: new Date().toISOString() };
          saveInvoiceCache(cachePath, cache);
          continue;
        }

        const attachment = findPdfAttachment(payload);
        if (!attachment) {
          statusLog.push(`Skipped an email with no PDF attachment (subject: "${subject}").`);
          continue;
        }
        const pdfBuffer = await downloadAttachment(gmail, messageId, attachment.attachmentId);

        let parsed;
        try {
          parsed = await extractInvoiceFromPdf(pdfBuffer);
        } catch (e) {
          statusLog.push(`Could not read the PDF on "${subject}": ${e.message}`);
          continue;
        }

        // Must carry a conf number: it becomes the order's reference. (An
        // invoice without one belongs to worldStandaloneInvoice.js.)
        if (!parsed.reference) {
          cache[messageId] = { subject, skipped: "no-reference", checkedAt: new Date().toISOString() };
          saveInvoiceCache(cachePath, cache);
          continue;
        }
        const totalNum = Number(parsed.invoiceTotal ?? parsed.balanceDue);
        if (Number.isFinite(totalNum) && totalNum < 0) {
          statusLog.push(`Skipped ${parsed.invoiceNumber || "(unknown)"}: it is a credit, not an invoice.`);
          continue;
        }
        if (!parsed.invoiceNumber) {
          statusLog.push(`Could not read an invoice number on "${subject}" — skipped.`);
          continue;
        }

        const checkFailures = Object.entries(parsed.checks)
          .filter(([k, v]) => k !== "ok" && !v)
          .map(([k]) => k);
        const core = auditCoreCharges(parsed.lineItems, parsed.totals["TOTAL CORE"]);
        if (core && !core.ok) checkFailures.push("core");
        if (checkFailures.length) {
          statusLog.push(
            `Invoice ${parsed.invoiceNumber} (${parsed.reference}) did not reconcile (${checkFailures.join(", ")}) — no order was created; enter it by hand.`
          );
        }

        // Same asset name regular World invoices use, so viewing/printing and
        // archiveWorldGmailAssets work unchanged (and a later regular match of
        // the same invoice just rewrites the identical file).
        let fileName = "";
        if (dataDir) {
          fileName = getInvoiceAssetName(parsed.invoiceNumber, "pdf");
          try {
            fs.writeFileSync(path.join(dataDir, fileName), pdfBuffer);
          } catch (e) {
            console.log(`[world-conf-gap] failed to save PDF: ${e.message}`);
            fileName = "";
          }
        }

        const checkedAt = new Date().toISOString();
        discovery = {
          reference: parsed.reference,
          invoiceNumber: parsed.invoiceNumber,
          customerPo: extractCustomerPoFromSubject(subject),
          packingSlip: parsed.packingSlip || "",
          invoiceDate: parsed.invoiceDate || "",
          total: parsed.invoiceTotal,
          balanceDue: parsed.balanceDue,
          totalCore: parsed.totals["TOTAL CORE"] || 0,
          lineItems: parsed.lineItems,
          hasEnvironmentalFee: parsed.hasEnvironmentalFee,
          environmentalFeeAmount: parsed.environmentalFeeAmount,
          fileName,
          checksOk: checkFailures.length === 0,
          checkFailures,
          subject,
          checkedAt,
        };
        console.log(
          `[world-conf-gap] ${messageId}: ref=${discovery.reference} inv=${discovery.invoiceNumber} ` +
            `total=${discovery.total} items=${discovery.lineItems.length} ok=${discovery.checksOk}`
        );
        cache[messageId] = { subject, discovery, checkedAt };
        saveInvoiceCache(cachePath, cache);
      }

      discoveries.push(toDiscovery(discovery));
    }

    statusLog.push(`Extracted ${discoveries.length} conf invoice(s).`);
    return { ok: true, discoveries, statusLog };
  } catch (err) {
    console.error("[world-conf-gap] error:", err);
    return { ok: false, error: err.message || String(err), statusLog, discoveries };
  }
}

module.exports = { fetchWorldConfGapInvoices, subjectIsConfInvoice };
