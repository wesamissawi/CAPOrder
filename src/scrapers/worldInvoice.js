// src/scrapers/worldInvoice.js
// MAIN ENTRY for the World-invoice-from-Gmail pipeline, called from Electron main
// via IPC. This REPLACES the old Epicor portal scrape: World now emails
// machine-readable PDFs that carry their own order reference, so there is no
// portal login, no OCR, and no reconciliation of "which invoices haven't I seen
// yet" — an invoice is simply matched to its order by the reference printed on it.
//
// Like the Transbec pipeline it discovers EVERY candidate email rather than only
// the order that was clicked, so one run batch-fills every matching order.
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
  extractInvoiceFromPdf,
  extractReferenceFromSubject,
  getInvoiceAssetName,
} = require("./worldInvoice.actions");

function normalizeKey(s) {
  return String(s || "").trim().toUpperCase();
}

function toDiscovery(entry) {
  return {
    reference: entry.reference || "",
    invoiceNumber: entry.invoiceNumber || "",
    total: entry.total ?? entry.balanceDue ?? null,
    balanceDue: entry.balanceDue ?? null,
    packingSlip: entry.packingSlip || "",
    invoiceDate: entry.invoiceDate || "",
    lineItems: Array.isArray(entry.lineItems) ? entry.lineItems : [],
    hasEnvironmentalFee: Boolean(entry.hasEnvironmentalFee),
    environmentalFeeAmount: entry.environmentalFeeAmount || "",
    fileName: entry.fileName || "",
    checksOk: entry.checksOk !== false,
  };
}

async function fetchWorldInvoices(options = {}) {
  const {
    credentials, // { clientId, clientSecret, refreshToken }
    sender,
    subjectPattern,
    reference, // the order that triggered this run (for matchedRow); optional
    references, // conf numbers of orders still waiting on an invoice; searched by name
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

    statusLog.push("Searching Gmail for World invoice emails…");
    const messages = await searchInvoiceEmails(gmail, { sender, subjectPattern, maxResults });

    // The sweep above only sees the newest `maxResults` emails — World bills
    // several times a day, so that is two or three days. An order still waiting
    // on an older invoice (PL2755's came 11 days before its order was scraped)
    // would never be reached, and the per-order button used to run the very
    // same sweep. So also ask Gmail for the waiting orders' conf numbers by
    // name: the subject carries it ("... EPN conf PL2755"). Only conf-shaped
    // refs (two letters + digits) go into the query.
    const wanted = [...new Set([reference, ...(Array.isArray(references) ? references : [])]
      .map((r) => normalizeKey(r))
      .filter((r) => /^[A-Z]{2}\d{3,6}$/.test(r)))];
    if (wanted.length) {
      const seen = new Set(messages.map((m) => m.id));
      let added = 0;
      for (let i = 0; i < wanted.length; i += 15) {
        const chunk = wanted.slice(i, i + 15);
        const hits = await searchInvoiceEmails(gmail, {
          sender,
          subjectPattern: chunk.join(" OR "),
          maxResults: chunk.length * 3,
        });
        for (const m of hits) {
          if (seen.has(m.id)) continue;
          seen.add(m.id);
          messages.push(m);
          added += 1;
        }
      }
      statusLog.push(`Looked up ${wanted.length} waiting order(s) by conf number; ${added} older email(s) found.`);
    }
    statusLog.push(`Found ${messages.length} candidate email(s).`);

    const cache = loadInvoiceCache(cachePath);
    const targetRef = normalizeKey(reference);

    for (const msgRef of messages) {
      const messageId = msgRef.id;
      const cached = cache[messageId];

      // Reuse a previous parse only if its saved PDF is still on disk AND it
      // carries a total. An entry cached without one would otherwise be trusted
      // forever, which is exactly how the BestBuy pipeline once pinned stale
      // `total: null` rows in place.
      if (cached) {
        const fileName = cached.fileName || "";
        const fileExists = Boolean(dataDir) && fileName && fs.existsSync(path.join(dataDir, fileName));
        if (fileExists && cached.reference && cached.total != null) {
          const discovery = toDiscovery(cached);
          discoveries.push(discovery);
          if (!matchedRow && targetRef && normalizeKey(cached.reference) === targetRef) {
            matchedRow = { ...discovery };
          }
          continue;
        }
      }

      const full = await gmail.users.messages.get({ userId: "me", id: messageId, format: "full" });
      const payload = full.data.payload || {};
      const subject = getHeader(payload, "Subject");

      const attachment = findPdfAttachment(payload);
      if (!attachment) {
        statusLog.push(`Skipped an email with no PDF attachment (subject: “${subject}”).`);
        continue;
      }

      const pdfBuffer = await downloadAttachment(gmail, messageId, attachment.attachmentId);

      let parsed;
      try {
        parsed = await extractInvoiceFromPdf(pdfBuffer);
      } catch (e) {
        statusLog.push(`Could not read the PDF on “${subject}”: ${e.message}`);
        console.log(`[world-invoice] ${messageId}: parse failed: ${e.message}`);
        continue;
      }

      // The reference printed on the invoice is authoritative; the subject line
      // carries it too and covers a PDF whose reference line failed to read.
      const subjectRef = extractReferenceFromSubject(subject);
      const discoveredReference = parsed.reference || subjectRef || "";

      console.log(
        `[world-invoice] ${messageId}: subject="${subject}" ref=${discoveredReference || "(none)"} ` +
          `inv=${parsed.invoiceNumber || "(none)"} total=${parsed.invoiceTotal ?? "(none)"} ` +
          `ehc=${parsed.totalEhc} items=${parsed.lineItems.length} checks=${JSON.stringify(parsed.checks)}`
      );

      // The arithmetic self-audit failing means a column was misread — surface it
      // rather than quietly writing wrong money onto an order.
      if (!parsed.checks.ok) {
        const failed = Object.entries(parsed.checks)
          .filter(([k, v]) => k !== "ok" && !v)
          .map(([k]) => k)
          .join(", ");
        statusLog.push(
          `Invoice ${parsed.invoiceNumber || "(unknown)"} did not reconcile (${failed}) — please verify it manually.`
        );
      }
      if (parsed.reference && subjectRef && parsed.reference !== subjectRef) {
        statusLog.push(
          `Invoice ${parsed.invoiceNumber}: reference on the PDF (${parsed.reference}) differs from the subject (${subjectRef}); using the PDF.`
        );
      }

      // Persist the raw PDF — it is both the archive artifact and what the Verify
      // modal displays. We show the real PDF rather than a rasterized preview
      // because pdfjs drops much of these documents' content when rendering.
      let fileName = "";
      if (dataDir && parsed.invoiceNumber) {
        fileName = getInvoiceAssetName(parsed.invoiceNumber, "pdf");
        try {
          fs.writeFileSync(path.join(dataDir, fileName), pdfBuffer);
        } catch (e) {
          console.log(`[world-invoice] failed to save PDF: ${e.message}`);
          fileName = "";
        }
      }

      const entry = {
        reference: discoveredReference,
        invoiceNumber: parsed.invoiceNumber || "",
        total: parsed.invoiceTotal,
        balanceDue: parsed.balanceDue,
        packingSlip: parsed.packingSlip,
        invoiceDate: parsed.invoiceDate,
        lineItems: parsed.lineItems,
        hasEnvironmentalFee: parsed.hasEnvironmentalFee,
        environmentalFeeAmount: parsed.environmentalFeeAmount,
        fileName,
        checksOk: parsed.checks.ok,
        subject,
        checkedAt: new Date().toISOString(),
      };

      if (messageId) {
        // Saved after every message so a crash mid-run doesn't lose the work.
        cache[messageId] = entry;
        saveInvoiceCache(cachePath, cache);
      }

      if (discoveredReference) {
        const discovery = toDiscovery(entry);
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
    console.error("[world-invoice] error:", err);
    return { ok: false, error: err.message || String(err), statusLog, discoveries };
  }
}

module.exports = { fetchWorldInvoices };
