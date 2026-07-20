// src/scrapers/bestbuyInvoice.js
// MAIN ENTRY for the BestBuy-invoices-from-Gmail pipeline. Like Transbec it reads
// the connected Gmail, but BestBuy sends ONE "BESTBUY INVOICES FOR TODAY" email
// whose single PDF holds many invoices (one per page). We parse the batch, split
// it into per-invoice PDFs (keyed by packing slip), and return discoveries the
// renderer batch-applies to matching orders.
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
const { parseBatchInvoices, attachPositionalTotals } = require("./bestbuyInvoice.actions");

let pdfParse = null;
function getPdfParse() {
  if (!pdfParse) pdfParse = require("pdf-parse");
  return pdfParse;
}

function normalizeKey(s) {
  return String(s || "").trim().toUpperCase();
}

function assetName(kind, id) {
  const safe = String(id || "").trim().replace(/[^A-Za-z0-9_-]/g, "_");
  return `bestbuy_${kind}_${safe || "unknown"}.pdf`;
}

// Split the batch PDF into one single/multi-page PDF per invoice, named by packing
// slip. Returns a map packingSlip -> fileName. On any inconsistency (page counts
// don't add up, pdf-lib fails) returns null so the caller can fall back to
// pointing every invoice at the whole batch PDF.
async function splitBatchPdf(pdfBuffer, invoices, dataDir) {
  try {
    const { PDFDocument } = require("pdf-lib");
    const src = await PDFDocument.load(pdfBuffer);
    const totalPages = src.getPageCount();
    const sumPages = invoices.reduce((n, inv) => n + (inv.pageCount || 1), 0);
    if (sumPages !== totalPages) {
      console.log(
        `[bestbuy-invoice] page-count mismatch (parsed ${sumPages} vs pdf ${totalPages}); not splitting`
      );
      return null;
    }
    const byPackingSlip = {};
    for (const inv of invoices) {
      if (!inv.packingSlip) continue;
      const indices = [];
      for (let p = 0; p < (inv.pageCount || 1); p++) indices.push(inv.startPage + p);
      const out = await PDFDocument.create();
      const pages = await out.copyPages(src, indices);
      pages.forEach((pg) => out.addPage(pg));
      const bytes = await out.save();
      const fileName = assetName("invoice", inv.packingSlip);
      fs.writeFileSync(path.join(dataDir, fileName), Buffer.from(bytes));
      byPackingSlip[inv.packingSlip] = fileName;
    }
    return byPackingSlip;
  } catch (e) {
    console.log(`[bestbuy-invoice] split failed: ${e.message}`);
    return null;
  }
}

async function fetchBestbuyInvoices(options = {}) {
  const {
    credentials, // { clientId, clientSecret, refreshToken }
    sender,
    subjectPattern,
    reference, // the order that triggered this run (for matchedRow); optional
    dataDir,
    cachePath,
    maxResults = 15,
  } = options;

  const statusLog = [];
  const discoveries = [];
  let matchedRow = null;
  const targetRef = normalizeKey(reference);

  try {
    if (dataDir) fs.mkdirSync(dataDir, { recursive: true });
    const gmail = getGmailService(getAuthorizedClient(credentials || {}));

    statusLog.push("Searching Gmail for BestBuy invoice batches…");
    const messages = await searchInvoiceEmails(gmail, {
      sender,
      subjectPattern: subjectPattern || "BESTBUY INVOICES FOR TODAY",
      maxResults,
    });
    statusLog.push(`Found ${messages.length} batch email(s).`);

    const cache = loadInvoiceCache(cachePath);

    for (const msgRef of messages) {
      const messageId = msgRef.id;
      const cached = cache[messageId];

      // Reuse a previous parse only if its per-invoice files are still on disk
      // AND every invoice actually captured a total — a null total means an
      // earlier run's parse failed (e.g. before the positional-extraction fix),
      // so re-processing the email is what self-heals those stale entries.
      let invoices = null;
      if (cached && Array.isArray(cached.invoices)) {
        const allGood = cached.invoices.every(
          (inv) =>
            (!inv.fileName || (dataDir && fs.existsSync(path.join(dataDir, inv.fileName)))) &&
            inv.total !== null &&
            inv.total !== undefined
        );
        if (allGood) invoices = cached.invoices;
      }

      if (!invoices) {
        const full = await gmail.users.messages.get({ userId: "me", id: messageId, format: "full" });
        const payload = full.data.payload || {};
        const subject = getHeader(payload, "Subject");
        const attachment = findPdfAttachment(payload);
        if (!attachment) {
          statusLog.push(`Skipped batch email with no PDF attachment (subject: “${subject}”).`);
          continue;
        }
        const pdfBuffer = await downloadAttachment(gmail, messageId, attachment.attachmentId);
        const parsed = await getPdfParse()(pdfBuffer).catch((e) => {
          console.log(`[bestbuy-invoice] pdf-parse failed: ${e.message}`);
          return { text: "" };
        });
        const parsedInvoices = parseBatchInvoices(parsed.text || "");
        // Totals from flat text are unreliable (see comment in
        // bestbuyInvoice.actions.js) — overwrite with positionally-read values,
        // which are unambiguous regardless of how tightly the PDF's digits print.
        await attachPositionalTotals(parsedInvoices, pdfBuffer);
        console.log(
          `[bestbuy-invoice] ${messageId}: parsed ${parsedInvoices.length} invoice(s) from batch — ` +
            parsedInvoices
              .map((i) => `${i.packingSlip || "?"}/${i.invoiceNumber || "?"}=$${i.total ?? "?"}`)
              .join(", ")
        );

        // Save the whole batch PDF, then split into per-invoice files (falling
        // back to the batch PDF for every invoice if splitting isn't safe).
        let byPackingSlip = null;
        if (dataDir) {
          const batchName = assetName("batch", messageId);
          try {
            fs.writeFileSync(path.join(dataDir, batchName), pdfBuffer);
          } catch (e) {
            console.log(`[bestbuy-invoice] failed to save batch PDF: ${e.message}`);
          }
          byPackingSlip = await splitBatchPdf(pdfBuffer, parsedInvoices, dataDir);
          invoices = parsedInvoices.map((inv) => ({
            packingSlip: inv.packingSlip,
            invoiceNumber: inv.invoiceNumber,
            total: inv.total,
            hasEnvironmentalFee: inv.hasEnvironmentalFee,
            environmentalFeeAmount: inv.environmentalFeeAmount || "",
            fileName: (byPackingSlip && byPackingSlip[inv.packingSlip]) || batchName,
          }));
        } else {
          invoices = parsedInvoices.map((inv) => ({
            packingSlip: inv.packingSlip,
            invoiceNumber: inv.invoiceNumber,
            total: inv.total,
            hasEnvironmentalFee: inv.hasEnvironmentalFee,
            environmentalFeeAmount: inv.environmentalFeeAmount || "",
            fileName: "",
          }));
        }

        if (messageId) {
          cache[messageId] = { subject, invoices, checkedAt: new Date().toISOString() };
          saveInvoiceCache(cachePath, cache);
        }
      }

      for (const inv of invoices) {
        if (!inv.packingSlip && !inv.invoiceNumber) continue;
        // reference = packing slip (the order's reference when scraped early);
        // invoiceNumber travels along as a fallback match key for late scrapes.
        const discovery = {
          reference: inv.packingSlip || inv.invoiceNumber,
          packingSlip: inv.packingSlip,
          invoiceNumber: inv.invoiceNumber,
          total: inv.total ?? null,
          fileName: inv.fileName || "",
          hasEnvironmentalFee: Boolean(inv.hasEnvironmentalFee),
        };
        discoveries.push(discovery);
        if (
          !matchedRow &&
          targetRef &&
          (normalizeKey(inv.packingSlip) === targetRef || normalizeKey(inv.invoiceNumber) === targetRef)
        ) {
          matchedRow = { ...discovery };
        }
      }
    }

    statusLog.push(`Extracted ${discoveries.length} invoice(s) across the batch email(s).`);
    if (reference) {
      statusLog.push(
        matchedRow
          ? `Matched invoice ${matchedRow.invoiceNumber} for order ${reference}.`
          : `No invoice matched order ${reference}.`
      );
    }

    return { ok: true, discoveries, matchedRow, statusLog };
  } catch (err) {
    console.error("[bestbuy-invoice] error:", err);
    return { ok: false, error: err.message || String(err), statusLog, discoveries };
  }
}

module.exports = { fetchBestbuyInvoices };
