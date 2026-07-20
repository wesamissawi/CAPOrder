const fs = require("fs");
const path = require("path");
const Tesseract = require("tesseract.js");
const { pdfToPng } = require("pdf-to-png-converter");

const EPICOR_LOGIN_URL = "https://webdocs.epicor.com/site/cgi-bin/3pp.pl/_0/1";

// Helper: ensure we have login credentials
function getCredentials(creds) {
  const user =
    (creds && (creds.user || creds.EPICOR_USER || creds.username)) || process.env.EPICOR_USER;
  const pass =
    (creds && (creds.pass || creds.EPICOR_PASS || creds.password)) || process.env.EPICOR_PASS;
  if (!user || !pass) {
    throw new Error("Missing EPICOR credentials. Set them in Settings.");
  }
  return { user, pass };
}

// Create a browser context, with stored session if available.
// deviceScaleFactor is bumped up so screenshots of scanned documents have
// enough pixel density for OCR to read small print reliably.
async function createContextWithStorage(browser, storageStatePath) {
  const contextOptions = { deviceScaleFactor: 3 };
  if (fs.existsSync(storageStatePath)) {
    return await browser.newContext({ ...contextOptions, storageState: storageStatePath });
  }
  return await browser.newContext(contextOptions);
}

// Login if necessary and save session
async function ensureLoggedIn(page, storageStatePath, credentials) {
  const { user, pass } = getCredentials(credentials);

  await page.goto(EPICOR_LOGIN_URL, { waitUntil: "load" });

  const usernameInput = await page.$("input[name='LOGINID']");
  const passwordInput = await page.$("input[name='PASSWORD']");

  if (!usernameInput || !passwordInput) {
    console.log("[epicor] No login form found; assuming stored session is valid.");
    await page.context().storageState({ path: storageStatePath });
    return { loggedIn: true, usedStoredSession: true, loginPerformed: false };
  }

  await usernameInput.fill(user);
  await passwordInput.fill(pass);

  const loginBtn = await page.$("#idLoginBtn");
  if (loginBtn) {
    await Promise.all([
      loginBtn.click(),
      page.waitForLoadState("domcontentloaded", { timeout: 20000 }).catch(() => null),
    ]);
  } else {
    await Promise.all([
      passwordInput.press("Enter"),
      page.waitForLoadState("domcontentloaded", { timeout: 20000 }).catch(() => null),
    ]);
  }

  await page.context().storageState({ path: storageStatePath });
  return { loggedIn: true, usedStoredSession: false, loginPerformed: true };
}

// Sage stores dates as DDMMYY (e.g. "070726"); Epicor's search page expects MMDDYYYY.
function convertSageDateToEpicorFormat(sageDate) {
  const clean = String(sageDate || "").trim();
  if (!/^\d{6}$/.test(clean)) return "";
  const dd = clean.slice(0, 2);
  const mm = clean.slice(2, 4);
  const yy = clean.slice(4, 6);
  return `${mm}${dd}20${yy}`;
}

// Find the index-value container for a search field by its label text
// (fallback path — the panel's dijit-counter ids are not guaranteed stable).
function getIndexValueContainer(page, labelText) {
  const label = page.locator(".hiidx-search-idx-label", { hasText: labelText }).first();
  return label.locator(
    "xpath=ancestor::div[contains(@class,'hi-sp-searchlabel')]/following-sibling::div[contains(@class,'hi-sp-indexvalue')][1]"
  );
}

// Locate the Date from/to inputs. Tries the observed stable widget ids first
// (poh_hi_HIIndexValueEdit_0/_1 for this search config), then falls back to
// finding them via the "Date" field label.
async function locateDateInputs(page) {
  // This is a Dojo/dijit app: the search panel keeps rendering asynchronously
  // after the page's load event, so wait for it before checking for anything
  // (unlike .fill()/.click(), .count() does not auto-wait for elements to appear).
  try {
    await page.waitForSelector(".hiidx-search-idx-label", { timeout: 20000 });
    console.log("[epicor] search panel labels are present");
  } catch (e) {
    console.log(`[epicor] timed out waiting for search panel to render: ${e.message}`);
  }

  const idFrom = page.locator("#poh_hi_HIIndexValueEdit_0_hiTextBox");
  const idTo = page.locator("#poh_hi_HIIndexValueEdit_1_hiTextBox");
  const idFromCount = await idFrom.count();
  const idToCount = await idTo.count();
  console.log(`[epicor] id-based date inputs -> from count: ${idFromCount}, to count: ${idToCount}`);
  if (idFromCount > 0 && idToCount > 0) {
    console.log("[epicor] using id-based date inputs (poh_hi_HIIndexValueEdit_0/1)");
    return { fromInput: idFrom.first(), toInput: idTo.first() };
  }

  console.log("[epicor] id-based date inputs not found; falling back to label search");
  const dateLabelLocator = page.locator(".hiidx-search-idx-label", { hasText: "Date" });
  const dateLabelCount = await dateLabelLocator.count();
  console.log(`[epicor] ".hiidx-search-idx-label" matching "Date": ${dateLabelCount} found`);
  if (dateLabelCount === 0) {
    const allLabels = await page.locator(".hiidx-search-idx-label").allInnerTexts().catch(() => []);
    console.log(`[epicor] all search-idx labels on page: ${JSON.stringify(allLabels)}`);
    throw new Error('Could not find "Date" search label on the page.');
  }

  const dateContainer = getIndexValueContainer(page, "Date");
  const containerCount = await dateContainer.count();
  console.log(`[epicor] date index-value container count: ${containerCount}`);

  const fromInput = dateContainer.locator(".anchor_from input.dijitInputInner").first();
  const toInput = dateContainer.locator(".anchor_to input.dijitInputInner").first();
  const fromCount = await fromInput.count();
  const toCount = await toInput.count();
  console.log(`[epicor] label-based from-input count: ${fromCount}, to-input count: ${toCount}`);
  if (fromCount === 0 || toCount === 0) {
    const containerHtml = await dateContainer.innerHTML().catch((e) => `(failed to read: ${e.message})`);
    console.log(`[epicor] date container HTML: ${containerHtml}`);
    throw new Error("Could not find Date from/to input fields.");
  }

  return { fromInput, toInput };
}

// Read every row of the results grid into plain objects.
// Scoped to the actual results grid element (dojox/grid CSS classes like
// ".dojoxGridRow"/".dojoxGridCell" are shared by any grid widget on the page,
// so an unscoped selector can pick up rows from an unrelated grid). Column
// labels are read from the grid's own header rather than assumed by position,
// so this stays correct even if the column order ever changes.
async function extractSearchResults(page) {
  const rawRows = await page.evaluate(() => {
    const grid = document.querySelector('[id^="dojox_grid_EnhancedGrid_"]') || document;
    const idxToLabel = {};
    grid.querySelectorAll("th.dojoxGridCell").forEach((th) => {
      const idx = th.getAttribute("idx");
      const label = (th.textContent || "").trim();
      if (idx !== null && label) idxToLabel[idx] = label;
    });

    return Array.from(grid.querySelectorAll(".dojoxGridRow")).map((row) => {
      const byLabel = {};
      row.querySelectorAll("td.dojoxGridCell").forEach((cell) => {
        const idx = cell.getAttribute("idx");
        const label = idxToLabel[idx] || `idx${idx}`;
        byLabel[label] = (cell.textContent || "").trim();
      });
      return byLabel;
    });
  });

  console.log(`[epicor] raw grid rows (by column label): ${JSON.stringify(rawRows)}`);

  return rawRows.map((r) => ({
    pages: r["# Pages"] || "",
    docType: r["Doc Type"] || "",
    invoiceNumber: r["Invoice #"] || "",
    accountNumber: r["Account #"] || "",
    date: r["Date"] || "",
    accountName: r["Account Name"] || "",
    releaseNumber: r["Release #"] || "",
    poNumber: r["PO #"] || "",
  }));
}

// Debug/review images are named after the invoice number (stable across
// searches) rather than the row index (which is only meaningful within one
// search and gets reused/overwritten by the next), so a saved image can be
// looked up again later from the order record.
function getInvoiceImageFileName(invoiceNumber) {
  const safe = String(invoiceNumber || "").trim().replace(/[^A-Za-z0-9_-]/g, "_");
  return `epicor_invoice_${safe || "unknown"}.png`;
}

// Bump when extractLineItemsFromInvoiceText changes: a cached invoice whose
// stored lineItemsVersion is older is re-OCR'd once so its parts refresh with
// the improved parser instead of being served stale (or empty) from cache.
const LINEITEM_PARSE_VERSION = 6;

// Extract line items from an invoice's OCR text. Anchored to the fixed Epicor
// invoice column layout (verified against a real scan):
//   ITEM  DESCRIPTION  BIN  UNIT  ORDERQTY  BACKORD  INVQTY  PRICE  DISC%  NETPRICE  NETCORE  EXTPRICE
// e.g. "CCS 66-9793 K-NEW CV DRIVE AXLES 01010182 EA 1 0 1 143.33 31.1% 98.76 0.00 98.76"
// A real item row is identified structurally (a run of qty integers + a UNIT
// code sitting just before four money amounts), which reliably rejects the
// totals/footer rows without a fragile keyword blocklist. Returns [] if nothing
// matches. Only page 1 is OCR'd upstream, so items on page 2+ won't be seen.
function extractLineItemsFromInvoiceText(text) {
  const intRe = /^\d{1,5}$/;
  const unitRe = /^[A-Za-z]{1,3}$/;
  const pctRe = /^\d{1,3}(?:\.\d{1,2})?%$/; // DISC% column, e.g. "31.1%", "426%", "0%"
  const num = (s) => Number(String(s).replace(/[$,]/g, ""));
  // Recover a money value even when OCR dropped the decimal point (e.g. "1050"
  // for 10.50, "000" for 0.00). Two-decimal money read as pure digits = cents.
  const money = (tok) => {
    const s = String(tok || "").replace(/[$,]/g, "");
    if (/^\d+\.\d{2}$/.test(s)) return s;
    if (/^\d+$/.test(s)) {
      const p = s.padStart(3, "0");
      return `${p.slice(0, -2)}.${p.slice(-2)}`;
    }
    return s;
  };
  const items = [];

  for (const raw of String(text || "").split(/\r?\n/)) {
    const tokens = raw.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
    if (tokens.length < 9) continue;

    // Anchor on the DISC% column — the one token carrying a "%" on an item row.
    // OCR frequently mangles the PRICE / NET / CORE money columns (dropping the
    // decimal point), but the "%" on the discount survives, so counting columns
    // from it is far more reliable than matching money tokens. Full column order:
    //   [BIN?] UNIT ORDERQTY BACKORD INVQTY PRICE DISC% NETPRICE NETCORE EXTPRICE
    const d = tokens.findIndex((t) => pctRe.test(t));
    if (d < 5 || d + 3 >= tokens.length) continue;

    const unitIdx = d - 5;
    const unit = tokens[unitIdx];
    if (!unitRe.test(unit)) continue;
    const orderQty = tokens[d - 4];
    const backOrd = tokens[d - 3];
    const invQty = tokens[d - 2];
    if (!intRe.test(orderQty) || !intRe.test(backOrd) || !intRe.test(invQty)) continue;

    const netPrice = money(tokens[d + 1]); // NET PRICE (after discount)
    const extPrice = money(tokens[d + 3]); // EXT PRICE (line total)

    // "ITEM DESCRIPTION" is everything before UNIT — minus an optional BIN column
    // (a numeric location code) that some invoice layouts insert right before the
    // unit ("SPECIALS" orders have it, "SERVICE PICKUP" orders don't). Detect it
    // rather than assuming it's always present; it's never output either way.
    const beforeUnit = tokens[unitIdx - 1] || "";
    const looksLikeBin = beforeUnit.length >= 4 && /\d/.test(beforeUnit) && !/[A-Za-z]{3,}/.test(beforeUnit);
    const head = tokens.slice(0, looksLikeBin ? unitIdx - 1 : unitIdx);
    if (!head.length) continue;

    // Part number format: exactly three alpha characters (the line code, e.g.
    // "CCS" / "PRO"), then one unspaced alphanumeric token which may contain
    // special chars (e.g. "66-9793"), then the description. OCR sometimes keeps
    // the code and number as separate tokens ("CCS" "66-9793") and sometimes
    // merges them ("PROPF519") — handle both, else fall back to the first token.
    let i;
    let partLineCode = "";
    let partNumber = "";
    let m;
    if (/^[A-Za-z]{2,4}$/.test(head[0]) && head.length > 1) {
      partLineCode = head[0];
      partNumber = head[1];
      i = 2;
    } else if ((m = head[0].match(/^([A-Za-z]{3})([A-Za-z0-9].*)$/))) {
      partLineCode = m[1];
      partNumber = m[2];
      i = 1;
    } else {
      partNumber = head[0];
      i = 1;
    }
    // Drop leading OCR junk (stray ~ | * _ ) from the description, but keep real
    // punctuation like "(" (invoices genuinely print truncated "(GLOSS").
    const partDescription = head.slice(i).join(" ").replace(/^[\s~|*_]+/, "").trim();

    items.push({
      partLineCode,
      partNumber,
      partDescription,
      quantity: invQty,
      costPrice: netPrice,
      costPriceValue: num(netPrice),
      extended: extPrice,
      extendedValue: num(extPrice),
      addedToOutstanding: false,
      source: "epicor-ocr",
    });
    if (items.length >= 100) break; // guard against a pathological OCR dump
  }
  return items;
}

// Order references always follow "LL9999" — 2 letters then 4 digits. Knowing the
// shape lets us correct each character based on what it MUST be at that position
// (letter slot -> letter, digit slot -> digit), far safer than fuzzy matching.
const REFERENCE_REGEX = /^[A-Z]{2}\d{4}$/;
function correctReferenceFormat(raw) {
  const clean = String(raw || "")
    .replace(/[\s\-]/g, "")
    .toUpperCase()
    .slice(0, 6);
  if (clean.length !== 6) return "";
  const digitToLetter = { "0": "O", "1": "I", "5": "S", "8": "B", "2": "Z" };
  const letterToLetter = { Q: "O" }; // Q/O are visually confusable and both valid letters
  const letterToDigit = { O: "0", Q: "0", I: "1", L: "1", S: "5", B: "8", Z: "2" };
  const chars = clean.split("");
  for (let i = 0; i < 2; i++) {
    if (digitToLetter[chars[i]]) chars[i] = digitToLetter[chars[i]];
    else if (letterToLetter[chars[i]]) chars[i] = letterToLetter[chars[i]];
  }
  for (let i = 2; i < 6; i++) {
    if (letterToDigit[chars[i]]) chars[i] = letterToDigit[chars[i]];
  }
  const corrected = chars.join("");
  return REFERENCE_REGEX.test(corrected) ? corrected : "";
}

// Derive every field we care about from an invoice's OCR text: balance due,
// order reference (with LL9999 correction + match against a target), the EHC
// environmental fee, and the parsed line items. Shared by the live scrape and
// the "rescan this one" path that re-OCRs the already-saved image.
function parseInvoiceOcrFields(text, reference = "") {
  const balanceMatch = text.match(/BALANCE\s*DUE\s*[:\-]?\s*\$?\s*([\d,]+\.\d{2})/i);
  const balanceDue = balanceMatch ? balanceMatch[1].replace(/,/g, "") : "";

  // "EHC : x.xx Ext: y.yy" and/or "Total EHC Fee y.yy" — check both independently
  // since OCR might catch one line but not the other.
  const ehcMatch = text.match(/EHC\s*:?\s*[\d.]+\s*Ext\s*:?\s*[\d.]+/i);
  const ehcTotalMatch = text.match(/Total\s*EHC\s*Fee\s*\$?\s*([\d,]+\.\d{2})/i);
  const hasEnvironmentalFee = Boolean(ehcMatch) || Boolean(ehcTotalMatch);
  const environmentalFeeAmount = ehcTotalMatch ? ehcTotalMatch[1].replace(/,/g, "") : "";

  const refMatch = text.match(/reference\s*no\.?\s*[:\-]?\s*([A-Za-z0-9]{4,10})/i);
  const foundReference = correctReferenceFormat(refMatch ? refMatch[1] : "");
  const correctedTarget = correctReferenceFormat(reference);
  const matchesReference =
    Boolean(correctedTarget) && Boolean(foundReference) && foundReference === correctedTarget;

  const lineItems = extractLineItemsFromInvoiceText(text);
  return { balanceDue, foundReference, matchesReference, hasEnvironmentalFee, environmentalFeeAmount, lineItems };
}

// Re-OCR an already-saved invoice image file and re-derive its fields. No
// browser, no Epicor navigation, no date needed — this is what the per-invoice
// "Rescan this one" button uses.
async function ocrInvoiceImageFile(imagePath, reference = "") {
  const {
    data: { text },
  } = await Tesseract.recognize(imagePath, "eng");
  const fields = parseInvoiceOcrFields(text, reference);
  return { text, ...fields, lineItemsVersion: LINEITEM_PARSE_VERSION };
}

// webdocs.epicor.com occasionally drops the connection mid-request ("socket
// hang up") with no HTTP response at all — observed as random flakiness, not
// tied to a specific document. Retry a few times with a short pause before
// giving up.
async function fetchPdfWithRetry(context, pdfUrl, rowIndex, { attempts = 3, retryDelayMs = 2000 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await context.request.get(pdfUrl);
      if (!response.ok()) {
        throw new Error(`status ${response.status()}`);
      }
      return await response.body();
    } catch (e) {
      lastErr = e;
      console.log(`[epicor] row ${rowIndex}: PDF download attempt ${attempt}/${attempts} failed: ${e.message}`);
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
    }
  }
  throw new Error(`Failed to download PDF for row ${rowIndex} after ${attempts} attempts: ${lastErr.message}`);
}

// Open a result row's scanned document just long enough to learn its PDF URL,
// then fetch the PDF directly and rasterize it ourselves (bypassing Chromium's
// built-in PDF viewer entirely — its async rendering has no observable "done"
// signal and proved unreliable to screenshot). OCR the resulting page image.
// If debugDir is provided, the exact PNG fed to OCR is saved there (named by
// invoice number) so it can be reopened later for visual verification.
async function openAndOcrResultRow(context, page, rowIndex, reference, debugDir, invoiceNumber) {
  const viewIcon = page.locator(".dojoxGridRow .sr_grid_icon_view").nth(rowIndex);
  console.log(`[epicor] row ${rowIndex}: clicking view icon, waiting for new tab...`);

  const [docPage] = await Promise.all([
    context.waitForEvent("page", { timeout: 20000 }),
    viewIcon.click(),
  ]);
  await docPage.waitForLoadState("load", { timeout: 20000 }).catch((e) => {
    console.log(`[epicor] row ${rowIndex}: document page load wait failed: ${e.message}`);
  });
  const pdfUrl = docPage.url();
  console.log(`[epicor] row ${rowIndex}: document tab URL: ${pdfUrl}`);
  await docPage.close().catch(() => {});

  console.log(`[epicor] row ${rowIndex}: downloading PDF...`);
  const pdfBuffer = await fetchPdfWithRetry(context, pdfUrl, rowIndex);
  console.log(`[epicor] row ${rowIndex}: downloaded PDF (${pdfBuffer.length} bytes)`);

  console.log(`[epicor] row ${rowIndex}: rasterizing page 1 at 3x scale...`);
  const pngPages = await pdfToPng(pdfBuffer, { viewportScale: 3, pagesToProcess: [1] });
  if (!pngPages.length || !pngPages[0].content) {
    throw new Error(`Failed to rasterize PDF for row ${rowIndex}`);
  }
  const buffer = pngPages[0].content;
  console.log(`[epicor] row ${rowIndex}: rasterized to ${pngPages[0].width}x${pngPages[0].height} PNG`);

  const imageFileName = getInvoiceImageFileName(invoiceNumber || rowIndex);
  if (debugDir) {
    try {
      const debugPath = path.join(debugDir, imageFileName);
      fs.writeFileSync(debugPath, buffer);
      console.log(`[epicor] row ${rowIndex}: saved invoice image to ${debugPath}`);
    } catch (e) {
      console.log(`[epicor] row ${rowIndex}: failed to save invoice image: ${e.message}`);
    }
  }

  console.log(`[epicor] row ${rowIndex}: running OCR...`);
  const {
    data: { text },
  } = await Tesseract.recognize(buffer, "eng");
  console.log(`[epicor] row ${rowIndex}: OCR text (${text.trim().length} chars):\n${text}`);

  // OCR only confirms which document belongs to this order (via the reference
  // line), reads the balance due / EHC fee, and parses the line items. The
  // invoice number itself comes from the grid (authoritative), not OCR.
  const { balanceDue, foundReference, matchesReference, hasEnvironmentalFee, environmentalFeeAmount, lineItems } =
    parseInvoiceOcrFields(text, reference);
  console.log(
    `[epicor] row ${rowIndex}: parsed balanceDue="${balanceDue || "(none)"}" ref="${foundReference || "(none)"}" matches=${matchesReference} EHC=${hasEnvironmentalFee} parts=${lineItems.length}`
  );

  return { text, balanceDue, foundReference, matchesReference, imageFileName, hasEnvironmentalFee, environmentalFeeAmount, lineItems };
}

function loadInvoiceCache(cachePath) {
  try {
    if (fs.existsSync(cachePath)) {
      const parsed = JSON.parse(fs.readFileSync(cachePath, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    }
  } catch (e) {
    console.log(`[epicor] failed to load invoice cache: ${e.message}`);
  }
  return {};
}

function saveInvoiceCache(cachePath, cache) {
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2), "utf8");
  } catch (e) {
    console.log(`[epicor] failed to save invoice cache: ${e.message}`);
  }
}

// Scan every result row's scanned document, OCR'ing each one to learn which
// order reference it belongs to. Does NOT stop at the first match — every
// invoice for this date gets checked (or pulled from cache), so the caller
// can populate every order in Order Management that has a matching invoice
// here, not just the one that was explicitly searched for. Invoices already
// OCR'd in a previous run (for this or any other order) are looked up in a
// persistent cache (keyed by invoice number) instead of being re-scanned.
// opts.force: ignore the cache and re-OCR every invoice in the range.
// opts.onlyInvoiceKeys: a Set of UPPERCASE invoice numbers — when set, ONLY those
// invoices are processed (others are skipped entirely) and they are always
// re-OCR'd fresh. Powers the Epicor view's per-invoice "Rescan this one" button.
async function findInvoiceByOcr(
  context,
  page,
  results,
  reference,
  debugDir,
  cachePath,
  { force = false, onlyInvoiceKeys = null } = {}
) {
  const normalizeKey = (s) => String(s || "").trim().toUpperCase();
  const targetRef = normalizeKey(reference);
  const cache = cachePath ? loadInvoiceCache(cachePath) : {};
  const discoveries = [];
  // Every scanned invoice in the range, whether or not OCR could read an order
  // reference for it — including ones that match no order in Order Management.
  // The renderer uses this to surface orphan invoices as their own bubbles.
  const allInvoices = [];
  let matchedRow = null;
  let matchedOcrText = "";

  // Carry the grid-read columns (authoritative, read straight from the DOM)
  // onto each allInvoices entry alongside the OCR-derived fields.
  const invoiceEntry = (row, extra) => ({
    invoiceNumber: row.invoiceNumber || "",
    date: row.date || "",
    poNumber: row.poNumber || "",
    releaseNumber: row.releaseNumber || "",
    accountName: row.accountName || "",
    accountNumber: row.accountNumber || "",
    docType: row.docType || "",
    ...extra,
  });

  const onlyMode = Boolean(onlyInvoiceKeys && onlyInvoiceKeys.size);

  for (let i = 0; i < results.length; i++) {
    const invoiceKey = normalizeKey(results[i].invoiceNumber);
    // Per-invoice rescan: process only the requested invoice(s), skip the rest.
    if (onlyMode && !onlyInvoiceKeys.has(invoiceKey)) continue;
    // The targeted invoice(s) are always re-read fresh; a global force does the same.
    const doForce = force || (onlyMode && onlyInvoiceKeys.has(invoiceKey));
    const cached = invoiceKey ? cache[invoiceKey] : null;

    if (cached) {
      const imageFileName = cached.imageFileName || getInvoiceImageFileName(results[i].invoiceNumber);
      const imageExists = Boolean(debugDir) && fs.existsSync(path.join(debugDir, imageFileName));
      const partsCurrent = cached.lineItemsVersion === LINEITEM_PARSE_VERSION;
      if (imageExists && partsCurrent && !doForce) {
        console.log(
          `[epicor] row ${i}: invoice ${results[i].invoiceNumber} already OCR'd previously (reference "${cached.reference || "(unknown)"}") — skipping re-scan`
        );
        // Backfill grid-read fields (Date/Account/PO/Release) onto entries that
        // were cached before these were stored. The invoice's OCR content is
        // still current (image + parts present), so we don't re-OCR — we just
        // top up the authoritative grid columns from this live search row and
        // persist them, so the date is durably available (e.g. after a restart,
        // when the view lists straight from the cache with no browser).
        let backfilled = false;
        for (const f of ["date", "accountName", "poNumber", "releaseNumber"]) {
          const gridVal = results[i][f];
          if (gridVal && !cached[f]) {
            cached[f] = gridVal;
            backfilled = true;
          }
        }
        if (backfilled && cachePath) {
          console.log(`[epicor] row ${i}: backfilled grid fields (date="${cached.date || ""}") into cache`);
          saveInvoiceCache(cachePath, cache);
        }
        allInvoices.push(
          invoiceEntry(results[i], {
            reference: cached.reference || "",
            balanceDue: cached.balanceDue || "",
            imageFileName,
            hasEnvironmentalFee: Boolean(cached.hasEnvironmentalFee),
            environmentalFeeAmount: cached.environmentalFeeAmount || "",
            lineItems: Array.isArray(cached.lineItems) ? cached.lineItems : [],
          })
        );
        if (cached.reference) {
          discoveries.push({
            reference: cached.reference,
            invoiceNumber: results[i].invoiceNumber,
            balanceDue: cached.balanceDue || "",
            imageFileName,
            hasEnvironmentalFee: Boolean(cached.hasEnvironmentalFee),
            environmentalFeeAmount: cached.environmentalFeeAmount || "",
          });
          if (!matchedRow && normalizeKey(cached.reference) === targetRef) {
            matchedRow = {
              ...results[i],
              balanceDue: cached.balanceDue || "",
              invoiceImageFile: imageFileName,
              hasEnvironmentalFee: Boolean(cached.hasEnvironmentalFee),
              environmentalFeeAmount: cached.environmentalFeeAmount || "",
            };
            matchedOcrText = cached.ocrText || "";
            console.log(`[epicor] cached match found on row ${i}: invoice ${matchedRow.invoiceNumber}`);
          }
        }
        continue;
      }
      console.log(
        `[epicor] row ${i}: re-scanning invoice ${results[i].invoiceNumber} — ` +
          (doForce
            ? `forced fresh rescan (ignoring cache)`
            : imageExists
            ? `line-item parser is newer than the cached parts (v${cached.lineItemsVersion || "none"} -> v${LINEITEM_PARSE_VERSION})`
            : `its image file is missing (${imageFileName})`)
      );
    }

    console.log(`[epicor] OCR pass: checking row ${i} of ${results.length}`);

    const {
      text,
      balanceDue,
      foundReference,
      matchesReference,
      imageFileName,
      hasEnvironmentalFee,
      environmentalFeeAmount,
      lineItems,
    } = await openAndOcrResultRow(context, page, i, reference, debugDir, results[i].invoiceNumber);

    const discoveredReference = matchesReference ? reference : foundReference;
    allInvoices.push(
      invoiceEntry(results[i], {
        reference: discoveredReference || "",
        balanceDue,
        imageFileName,
        hasEnvironmentalFee,
        environmentalFeeAmount,
        lineItems: Array.isArray(lineItems) ? lineItems : [],
      })
    );
    if (invoiceKey) {
      cache[invoiceKey] = {
        reference: discoveredReference,
        balanceDue,
        imageFileName,
        hasEnvironmentalFee,
        environmentalFeeAmount,
        lineItems: Array.isArray(lineItems) ? lineItems : [],
        lineItemsVersion: LINEITEM_PARSE_VERSION,
        // Grid fields kept so the Epicor view can re-list this invoice from the
        // cache alone (no browser) after an app restart.
        date: results[i].date || "",
        accountName: results[i].accountName || "",
        poNumber: results[i].poNumber || "",
        releaseNumber: results[i].releaseNumber || "",
        checkedAt: new Date().toISOString(),
      };
      if (cachePath) saveInvoiceCache(cachePath, cache);
    }

    if (discoveredReference) {
      discoveries.push({
        reference: discoveredReference,
        invoiceNumber: results[i].invoiceNumber,
        balanceDue,
        imageFileName,
        hasEnvironmentalFee,
        environmentalFeeAmount,
      });
    }

    if (!matchedRow && matchesReference) {
      matchedRow = { ...results[i], balanceDue, invoiceImageFile: imageFileName, hasEnvironmentalFee, environmentalFeeAmount };
      matchedOcrText = text;
      console.log(`[epicor] match found on row ${i}: invoice ${matchedRow.invoiceNumber}, balance due ${balanceDue}`);
    }

    // Space out consecutive document fetches against webdocs.epicor.com —
    // firing them back-to-back is a suspected contributor to the random
    // "socket hang up" drops seen mid-scan.
    if (i < results.length - 1) {
      await page.waitForTimeout(1500);
    }
  }

  console.log(`[epicor] OCR pass complete: ${discoveries.length} reference(s) discovered across ${results.length} result(s)`);
  if (!matchedRow) {
    console.log(`[epicor] no result row's document matched reference "${reference}"`);
  }
  return { matchedRow, ocrText: matchedOcrText, discoveries, allInvoices };
}

// Fill the "Date" from/to fields with a (possibly multi-day) range and click Search.
async function searchInvoicesForDate(page, fromSageDate, toSageDate, reference) {
  const epicorFromDate = convertSageDateToEpicorFormat(fromSageDate);
  const epicorToDate = convertSageDateToEpicorFormat(toSageDate);
  console.log(
    `[epicor] searchInvoicesForDate: fromSageDate="${fromSageDate}" -> epicorFromDate="${epicorFromDate}", toSageDate="${toSageDate}" -> epicorToDate="${epicorToDate}"`
  );
  if (!epicorFromDate) {
    throw new Error(`Invalid sage date: ${fromSageDate}`);
  }
  if (!epicorToDate) {
    throw new Error(`Invalid sage date: ${toSageDate}`);
  }

  console.log(`[epicor] current page URL: ${page.url()}`);
  try {
    const frames = page.frames();
    console.log(`[epicor] page has ${frames.length} frame(s): ${frames.map((f) => f.name() || f.url()).join(", ")}`);
  } catch (e) {
    console.log(`[epicor] could not list frames: ${e.message}`);
  }

  const { fromInput, toInput } = await locateDateInputs(page);

  // .fill() sets the raw DOM value via CDP, but this Dojo dijit/form/TextBox
  // widget only updates its own internal model from real keystroke events —
  // on blur it can resync the *displayed* value from that (still-empty) model,
  // silently wiping what .fill() set. Simulate actual typing instead.
  await fromInput.click();
  await fromInput.pressSequentially(epicorFromDate, { delay: 30 });
  await toInput.click();
  await toInput.pressSequentially(epicorToDate, { delay: 30 });
  console.log("[epicor] typed from/to date inputs (simulated keystrokes)");

  const fromValAfterFill = await fromInput.inputValue().catch((e) => `(error: ${e.message})`);
  const toValAfterFill = await toInput.inputValue().catch((e) => `(error: ${e.message})`);
  console.log(`[epicor] input values right after fill -> from="${fromValAfterFill}" to="${toValAfterFill}"`);

  // Some Dojo widgets only commit the value to their model on blur/change.
  await fromInput.evaluate((el) => el.blur());
  await toInput.evaluate((el) => el.blur());
  await page.waitForTimeout(300);

  const fromValAfterBlur = await fromInput.inputValue().catch((e) => `(error: ${e.message})`);
  const toValAfterBlur = await toInput.inputValue().catch((e) => `(error: ${e.message})`);
  console.log(`[epicor] input values after blur -> from="${fromValAfterBlur}" to="${toValAfterBlur}"`);

  const searchBtn = page
    .locator("#poh_hi_ui_SearchPage_0-searchAndResults-searchPanel-btnSearch")
    .or(page.locator("input[type='button'][value='Search']"));
  const searchBtnCount = await searchBtn.count();
  console.log(`[epicor] search button count: ${searchBtnCount}`);
  if (searchBtnCount === 0) {
    throw new Error("Could not find Search button.");
  }

  await searchBtn.first().click();
  console.log("[epicor] clicked Search button");

  console.log("[epicor] waiting for results grid to render...");
  await page.waitForSelector(".dojoxGridRow, .hiid-noItemsFound, font", { timeout: 60000 }).catch((e) => {
    console.log(`[epicor] timed out waiting for results: ${e.message}`);
  });
  await page.waitForTimeout(500);

  const results = await extractSearchResults(page);
  console.log(`[epicor] extracted ${results.length} result row(s): ${JSON.stringify(results)}`);

  return { epicorFromDate, epicorToDate, results };
}

module.exports = {
  EPICOR_LOGIN_URL,
  createContextWithStorage,
  ensureLoggedIn,
  convertSageDateToEpicorFormat,
  searchInvoicesForDate,
  findInvoiceByOcr,
  ocrInvoiceImageFile,
  parseInvoiceOcrFields,
  getInvoiceImageFileName,
  LINEITEM_PARSE_VERSION,
};
