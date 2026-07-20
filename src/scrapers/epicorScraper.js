// src/scrapers/epicorScraper.js
const path = require("path");
const fs = require("fs");
const { chromium } = require("playwright");
const {
  createContextWithStorage,
  ensureLoggedIn,
  searchInvoicesForDate,
  findInvoiceByOcr,
} = require("./epicor.actions");
require("dotenv").config();

function resolvePaths(options = {}) {
  const baseDir = options.storageDir || path.join(__dirname, "..");
  const storageStatePath =
    options.storageStatePath || path.join(baseDir, "epicor_storage_state.json");
  fs.mkdirSync(path.dirname(storageStatePath), { recursive: true });
  fs.mkdirSync(baseDir, { recursive: true });
  // dataDir (options.storageDir) and storageStatePath's folder are allowed to
  // differ: the caller may point storageStatePath at a machine-local folder
  // (Playwright session cookies shouldn't live on a shared network drive)
  // while dataDir is where OCR'd invoice images/cache get written, which DOES
  // need to be shared so every machine sees the same invoices.
  return { storageStatePath, dataDir: baseDir };
}

// MAIN ENTRY: call this from Electron main via IPC.
// Opens a visible browser, logs into the Epicor vendor portal, and leaves it
// open so the user (or a later automation step) can keep navigating it.
async function openEpicorSite(options = {}) {
  const { storageStatePath, dataDir } = resolvePaths(options);
  const statusLog = [];
  const browser = await chromium.launch({
    headless: false,
    slowMo: options.slowMo ?? 200,
  });

  let page;
  try {
    const context = await createContextWithStorage(browser, storageStatePath);
    page = await context.newPage();

    statusLog.push("Opening login page…");
    const loginInfo = await ensureLoggedIn(page, storageStatePath, options.credentials);
    statusLog.push(
      loginInfo?.usedStoredSession
        ? "Using stored session (no login form)."
        : "Logged in with credentials."
    );

    if (options.fromSageDate && options.toSageDate) {
      const refLabel = options.reference ? ` for order ${options.reference}` : "";
      try {
        const { epicorFromDate, epicorToDate, results } = await searchInvoicesForDate(
          page,
          options.fromSageDate,
          options.toSageDate,
          options.reference
        );
        const rangeLabel =
          epicorFromDate === epicorToDate ? epicorFromDate : `${epicorFromDate} to ${epicorToDate}`;
        statusLog.push(`Searched invoices dated ${rangeLabel}${refLabel}. Found ${results.length} result(s).`);

        let matchedRow = null;
        let ocrText = "";
        let discoveries = [];
        let allInvoices = [];
        // OCR every scanned document in the range. When a reference is given
        // (per-order lookup from Order Management) we also flag the matching row;
        // when it's blank (a bulk range scan from the Epicor view) we still read
        // and cache every invoice so the caller can reconcile the whole range.
        if (results.length > 0) {
          statusLog.push(
            options.reference
              ? `Opening each result's scanned document and running OCR to find a match…`
              : `Opening each result's scanned document and running OCR to read every invoice…`
          );
          const debugDir = dataDir;
          const cachePath = path.join(debugDir, "epicor_invoice_cache.json");
          const onlyInvoiceKeys = options.onlyInvoice
            ? new Set(
                (Array.isArray(options.onlyInvoice) ? options.onlyInvoice : [options.onlyInvoice])
                  .map((v) => String(v || "").trim().toUpperCase())
                  .filter(Boolean)
              )
            : null;
          const ocrResult = await findInvoiceByOcr(context, page, results, options.reference || "", debugDir, cachePath, {
            force: Boolean(options.force),
            onlyInvoiceKeys,
          });
          matchedRow = ocrResult.matchedRow;
          ocrText = ocrResult.ocrText;
          discoveries = ocrResult.discoveries || [];
          allInvoices = ocrResult.allInvoices || [];
          if (options.reference) {
            statusLog.push(
              matchedRow
                ? `Matched invoice ${matchedRow.invoiceNumber} (balance due ${matchedRow.balanceDue || "unknown"}) for order ${options.reference}.`
                : `OCR checked ${results.length} document(s); none matched order ${options.reference}.`
            );
            if (matchedRow?.hasEnvironmentalFee) {
              statusLog.push(
                `Environmental fee (EHC) detected on this invoice${matchedRow.environmentalFeeAmount ? ` ($${matchedRow.environmentalFeeAmount})` : ""} — needs to be entered.`
              );
            }
          } else {
            statusLog.push(`OCR read ${allInvoices.length} invoice(s) in this range.`);
          }
          statusLog.push(`Discovered references for ${discoveries.length} of ${results.length} document(s) in this range.`);
        }
        // The per-order flow leaves the browser open so the user can keep
        // navigating/verifying; a bulk range scan has nothing more to do there,
        // so close it (otherwise the window just lingers and looks hung).
        if (options.closeWhenDone) {
          await browser.close().catch(() => {});
        }
        return { ok: true, loginInfo, statusLog, results, matchedRow, ocrText, discoveries, allInvoices };
      } catch (searchErr) {
        console.error("[epicor] search step failed:", searchErr);
        statusLog.push(`Search failed${refLabel}: ${searchErr.message}`);
        try {
          const screenshotPath = path.join(path.dirname(storageStatePath), "epicor_search_error.png");
          await page.screenshot({ path: screenshotPath, fullPage: true });
          console.error("[epicor] saved search-error screenshot to", screenshotPath);
        } catch (s) {
          console.error("[epicor] could not save search-error screenshot", s);
        }
        if (options.closeWhenDone) {
          await browser.close().catch(() => {});
        }
        return { ok: false, error: searchErr.message, loginInfo, statusLog };
      }
    }

    return { ok: true, loginInfo, statusLog };
  } catch (err) {
    console.error("Epicor scraper error:", err);
    try {
      const screenshotPath = path.join(path.dirname(storageStatePath), "epicor_error.png");
      if (page) {
        await page.screenshot({ path: screenshotPath, fullPage: true });
        console.error("Saved error screenshot to", screenshotPath);
      }
    } catch (s) {
      console.error("Could not save error screenshot", s);
    }
    await browser.close().catch(() => {});
    return { ok: false, error: err.message };
  }
}

module.exports = {
  openEpicorSite,
};
