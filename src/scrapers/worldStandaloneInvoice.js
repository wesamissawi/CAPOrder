// src/scrapers/worldStandaloneInvoice.js
// MAIN ENTRY for World invoices that arrive with NO ORDER BEHIND THEM.
//
// The regular World pipeline (worldInvoice.js) matches an emailed invoice to an
// order the portal scrape already produced, using the "*** ACX Reference No:
// OK9784 ***" line the invoice prints — its subject carries the same conf
// number ("Invoice for 20605 EPN conf OK9784"). Some World invoices have no
// conf number at all: they are emailed with the customer PO in the subject
// instead ("Invoice for 20605 Cust PO SHADIE"), and nothing was ever scraped
// for them, so there is no order to attach them to.
//
// Those are what this file finds. Like the World CREDIT pipeline
// (worldCreditInvoice.js) — and unlike worldInvoice.js — it is purely a
// discovery list; App.jsx builds a brand-new order from each discovery. The
// invoice number becomes the order reference, because it is the only
// identifier such an invoice carries (user's instruction: "this one doesn't
// have a conf number... we will make the reference # the invoice number").
//
// The PDF is the SAME document template as a matched World invoice, so the
// whole positional parser is reused from worldInvoice.actions.js unchanged.
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
// Date-range helpers live in the Transbec CREDIT actions file (not
// transbecInvoice.actions.js, which exports similarly-named things) — the same
// import worldCreditInvoice.js makes.
const { isoToGmailDate, addDaysIso, todayIso } = require("./transbecCreditInvoice.actions");
const { extractInvoiceFromPdf, getInvoiceAssetName } = require("./worldInvoice.actions");

// Runs three times a day (see ghostMode.js), so a week's window comfortably
// covers a machine that was switched off for a few days. Re-finding an invoice
// is harmless: the cache skips the re-parse, and order creation keys on the
// invoice number.
const DEFAULT_LOOKBACK_DAYS = 7;

// Read off the 75 World emails actually sitting in world_invoice_cache.json: an
// order-matched invoice always says "conf", and the ones with no order behind
// them come in two forms, "Invoice for 20605 Cust PO SHADIE" (the usual) and a
// bare "Invoice for 20605" (02KR2676, 02KR0869). Both are orphans and both are
// accepted here; what actually PROVES it is the PDF carrying no ACX reference,
// checked below.
//
// Gmail's subject search is token-based, so a query can drag in the neighbouring
// email shapes from the SAME sender — a matched invoice ("Invoice for 20605 EPN
// conf OK9784") or a credit memo ("Credit Memo for 20605 Cust ..."). Every
// candidate is re-checked against the real subject shape here before it is
// parsed, so a loosened subject setting cannot silently make this pipeline
// swallow another one's mail.
function subjectIsStandaloneInvoice(subject) {
  const text = String(subject || "");
  if (!/invoice\s+for\s+\d+/i.test(text)) return false;
  if (/\bconf\b/i.test(text)) return false;
  if (/credit/i.test(text)) return false;
  return true;
}

// "Invoice for 20605 Cust PO SHADIE" -> "SHADIE". Informational only (it names
// who the parts were ordered for), but it is the only human-readable handle on
// an invoice with no conf number, so it is carried onto the order.
function extractCustomerPoFromSubject(subject) {
  // Gmail hands these subjects back WITH their surrounding double quotes
  // (the header really is `"Invoice for 20605 Cust PO SHADIE"`), so the PO
  // read off the end carries a trailing quote unless it is trimmed here.
  const text = String(subject || "").trim().replace(/^"|"$/g, "");
  const match = text.match(/cust\.?\s*po\s+(.+?)\s*$/i);
  return match ? match[1].trim() : "";
}

// The invoice prints a per-line NET CORE and a TOTAL CORE column. TOTAL MDSE
// (which the parser already audits line extensions against) EXCLUDES the core,
// so a core charge has to become its own line or it never reaches Sage. The
// core cell is a UNIT price — assert that reading against the printed TOTAL
// CORE rather than assuming it, because a wrong guess here would type invented
// money into Sage. Returns null when the invoice has no core charge at all.
function auditCoreCharges(lineItems, totalCore) {
  const printed = Number(totalCore) || 0;
  const summed = (lineItems || []).reduce(
    (acc, li) => acc + (Number(li.core) || 0) * (Number(li.quantity) || 0),
    0
  );
  if (printed === 0 && Math.abs(summed) < 0.005) return null;
  return { printed, summed, ok: Math.abs(printed - summed) < 0.01 };
}

function toDiscovery(entry) {
  return {
    reference: entry.reference || "",
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

async function fetchWorldStandaloneInvoices(options = {}) {
  const {
    credentials, // { clientId, clientSecret, refreshToken }
    sender,
    subjectPattern,
    dataDir,
    cachePath,
    maxResults = 25,
    fromDate, // ISO "YYYY-MM-DD"; defaults to a week ago
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

    statusLog.push(`Searching Gmail for World PO invoices (${effectiveFrom} to ${effectiveTo})…`);
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
      // Another pipeline's email, already identified as such on an earlier run.
      if (cached && cached.skipped) continue;

      // Reuse a previous parse only if it produced a usable result AND its PDF
      // is still on disk. Deliberately NOT trusted: an entry whose arithmetic
      // self-audit failed. Those never become orders, so re-reading them every
      // run is what keeps the failure visible instead of pinning it in the
      // cache forever (the trap the BestBuy pipeline once fell into with
      // `total: null`).
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

        // Belongs to the matched-invoice or credit-memo pipeline, not to this
        // one. The verdict is remembered so the next run skips the message
        // without re-fetching it: the sender's conf invoices outnumber these
        // roughly ten to one and would otherwise be downloaded again three
        // times a day.
        if (!subjectIsStandaloneInvoice(subject)) {
          console.log(`[world-po-invoice] ${messageId}: not a standalone invoice subject: ${subject}`);
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
          console.log(`[world-po-invoice] ${messageId}: parse failed: ${e.message}`);
          continue;
        }

        console.log(
          `[world-po-invoice] ${messageId}: subject="${subject}" inv=${parsed.invoiceNumber || "(none)"} ` +
            `acxRef=${parsed.reference || "(none)"} po=${extractCustomerPoFromSubject(subject) || "(none)"} ` +
            `total=${parsed.invoiceTotal ?? "(none)"} items=${parsed.lineItems.length} ` +
            `checks=${JSON.stringify(parsed.checks)}`
        );

        // An invoice that DOES print a conf number has an order waiting for it;
        // creating a second, invoice-shaped order for it would double it up in
        // Sage. Hand it back to worldInvoice.js by ignoring it here.
        if (parsed.reference) {
          statusLog.push(
            `Invoice ${parsed.invoiceNumber || "(unknown)"} carries order reference ${parsed.reference} — left to the regular World invoice check.`
          );
          continue;
        }
        // A credit memo reaching this query would be built as a purchase with
        // its signs intact. Credits have their own pipeline and their own sign
        // convention; never let one through here.
        const totalNum = Number(parsed.invoiceTotal ?? parsed.balanceDue);
        if (Number.isFinite(totalNum) && totalNum < 0) {
          statusLog.push(
            `Skipped ${parsed.invoiceNumber || "(unknown)"}: it is a credit, not an invoice — use Check World Credits.`
          );
          continue;
        }
        if (!parsed.invoiceNumber) {
          statusLog.push(`Could not read an invoice number on "${subject}" — skipped.`);
          continue;
        }

        const checkFailures = Object.entries(parsed.checks)
          .filter(([k, v]) => k !== "ok" && !v)
          .map(([k]) => k);
        // The core column's unit-vs-extended reading is proved, not assumed —
        // see auditCoreCharges. A failure joins the arithmetic failures, so the
        // order simply isn't created.
        const core = auditCoreCharges(parsed.lineItems, parsed.totals["TOTAL CORE"]);
        if (core && !core.ok) {
          checkFailures.push("core");
          console.log(
            `[world-po-invoice] ${parsed.invoiceNumber}: core lines sum to ${core.summed} but TOTAL CORE is ${core.printed}`
          );
        }
        if (checkFailures.length) {
          statusLog.push(
            `Invoice ${parsed.invoiceNumber} did not reconcile (${checkFailures.join(", ")}) — no order was created; enter it by hand.`
          );
        }

        // Same asset name and folder regular World invoices use, so viewing,
        // printing and archiveWorldGmailAssets all work with no new plumbing.
        let fileName = "";
        if (dataDir) {
          fileName = getInvoiceAssetName(parsed.invoiceNumber, "pdf");
          try {
            fs.writeFileSync(path.join(dataDir, fileName), pdfBuffer);
          } catch (e) {
            console.log(`[world-po-invoice] failed to save PDF: ${e.message}`);
            fileName = "";
          }
        }

        const checkedAt = new Date().toISOString();
        discovery = {
          // The invoice number IS the reference for these — there is nothing
          // else on the document to key an order by.
          reference: parsed.invoiceNumber,
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

        cache[messageId] = { subject, discovery, checkedAt };
        saveInvoiceCache(cachePath, cache);
      }

      discoveries.push(toDiscovery(discovery));
    }

    statusLog.push(`Extracted ${discoveries.length} PO invoice(s).`);
    return { ok: true, discoveries, statusLog };
  } catch (err) {
    console.error("[world-po-invoice] error:", err);
    return { ok: false, error: err.message || String(err), statusLog, discoveries };
  }
}

module.exports = {
  fetchWorldStandaloneInvoices,
  extractCustomerPoFromSubject,
  auditCoreCharges,
  subjectIsStandaloneInvoice,
};
