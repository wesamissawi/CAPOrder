const fs = require("fs");
const path = require("path");
const Tesseract = require("tesseract.js");
const { pdfToPng } = require("pdf-to-png-converter");
const { writeJsonAtomic } = require("../../main/utils/atomicWrite");

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
// This is a Dojo/dijit app: the search panel keeps rendering asynchronously
// after the page's load event, so wait for it before touching any field
// (unlike .fill()/.click(), .count() does not auto-wait for elements to appear).
async function waitForSearchPanel(page) {
  try {
    await page.waitForSelector(".hiidx-search-idx-label", { timeout: 20000 });
    console.log("[epicor] search panel labels are present");
  } catch (e) {
    console.log(`[epicor] timed out waiting for search panel to render: ${e.message}`);
  }
}

async function locateDateInputs(page) {
  await waitForSearchPanel(page);

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
    // A credit-doctype search returns rows whose number sits in the "Credit #"
    // column with "Invoice #" blank; fall back to it so credits get an
    // identity. An invoice row always fills "Invoice #", so this is a no-op there.
    invoiceNumber: r["Invoice #"] || r["Credit #"] || "",
    creditNumber: r["Credit #"] || "",
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
// looked up again later from the order record. Credit memos live in the same
// folder as invoices but get their own prefix: Epicor numbers credits from a
// separate sequence, so a credit # could collide with an invoice # and silently
// overwrite its image.
// Page 1 keeps the bare name it has always had (existing saved images and every
// order's stored epicorInvoiceImage still resolve); later pages of a multi-page
// credit get a _p2/_p3 suffix alongside it.
function getInvoiceImageFileName(invoiceNumber, isCredit = false, pageNumber = 1) {
  const safe = String(invoiceNumber || "").trim().replace(/[^A-Za-z0-9_-]/g, "_");
  const suffix = pageNumber > 1 ? `_p${pageNumber}` : "";
  return `epicor_${isCredit ? "credit" : "invoice"}_${safe || "unknown"}${suffix}.png`;
}

// Credit memos routinely run onto a second page, and the parts continue there —
// so every page gets rasterized and OCR'd, and the concatenated text is what the
// parsers see. Invoices stay page-1-only (unchanged behaviour). Capped so a
// pathologically long document can't tie up OCR indefinitely.
const MAX_CREDIT_OCR_PAGES = 10;

// Credits share epicor_invoice_cache.json with invoices (one place for every
// scanned Epicor document, as asked) but are keyed under a prefix for the same
// collision reason as the image files.
const CREDIT_CACHE_PREFIX = "CREDIT:";
function invoiceCacheKey(number, isCredit = false) {
  const key = String(number || "").trim().toUpperCase();
  if (!key) return "";
  return isCredit ? CREDIT_CACHE_PREFIX + key : key;
}
// Recover the document number from a cache key (credits carry the prefix).
function cacheKeyToNumber(cacheKey) {
  const key = String(cacheKey || "");
  return key.startsWith(CREDIT_CACHE_PREFIX) ? key.slice(CREDIT_CACHE_PREFIX.length) : key;
}

// Bump when extractLineItemsFromInvoiceText changes: a cached invoice whose
// stored lineItemsVersion is older is re-OCR'd once so its parts refresh with
// the improved parser instead of being served stale (or empty) from cache.
const LINEITEM_PARSE_VERSION = 6;
// The same idea for credits, which have their own parser (see
// extractCreditLineItemsFromOcrText) and so their own version counter. The two
// live in separate cache-key namespaces and are each compared against their own
// constant, so bumping one never forces a re-OCR of the other.
const CREDIT_LINEITEM_PARSE_VERSION = 1;
function lineItemParseVersion(isCredit) {
  return isCredit ? CREDIT_LINEITEM_PARSE_VERSION : LINEITEM_PARSE_VERSION;
}

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

// ---------------------------------------------------------------------------
// Credit memo parsing. A credit memo is NOT an invoice with a different total
// label — its item rows carry NEGATIVE quantities and prices, it has no BIN
// column, and its totals row is unlabeled. Verified against the real scan of
// credit 02KN9936 (World Auto Part), whose item block reads:
//
//   ITEM DESCRIPTION            UNIT ORD BACK INV  PRICE  DISC%  NET    CORE EXT
//   DOR 626-304 HEATER HOSE ASSEMBLY - EA -1 0 -1 -86.17 38.2% -53.27 0.00 -53.27
//   ** Warranty Return **
//   Original Inv# 02KN1946
//
// so the invoice parser rejected every row on the `^\d{1,5}$` quantity test.
// ---------------------------------------------------------------------------

const CREDIT_UNIT_RE = /^[A-Za-z]{1,3}$/;
const CREDIT_SIGNED_INT_RE = /^-?\d{1,5}$/;
const CREDIT_PCT_RE = /^-?\d{1,3}(?:\.\d{1,2})?%$/;
const CREDIT_MONEY_RE = /^-?\$?-?[\d,]+\.\d{2}$/;

// Money on a credit is printed negative; every amount we store is the POSITIVE
// magnitude, matching how credit totals are stored (and how the returns
// reconciliation reads quantities, via Math.abs). Also recovers an OCR-dropped
// decimal point the same way the invoice parser does. Returns null if the token
// isn't money at all, which is what the row's structural test keys off.
function creditMoney(tok) {
  const raw = String(tok || "").replace(/[$,\s]/g, "").replace(/^-+/, "");
  if (/^\d+\.\d{2}$/.test(raw)) return raw;
  if (/^\d+$/.test(raw)) {
    const p = raw.padStart(3, "0");
    return `${p.slice(0, -2)}.${p.slice(-2)}`;
  }
  return null;
}

// Split "DOR 626-304 HEATER HOSE ASSEMBLY" into line code / part number /
// description. Same shapes the invoice parser handles: OCR either keeps the
// 3-letter line code separate ("DOR" "626-304") or merges it into the part
// ("TRKFD-8148" -> "TRK" + "FD-8148").
function splitCreditPartTokens(head) {
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
  const partDescription = head
    .slice(i)
    .join(" ")
    .replace(/^[\s~|*_]+/, "")
    .replace(/[\s~|*_-]+$/, "")
    .trim();
  return { partLineCode, partNumber, partDescription };
}

// Returned parts read off a credit memo. Anchored on the DISC% token exactly
// like the invoice parser (OCR mangles money columns but the "%" survives):
//   [BIN?] UNIT ORDERQTY BACKORD INVQTY PRICE DISC% NETPRICE NETCORE EXTPRICE
// Every column is validated structurally, so the header row, the "Warranty
// Return" notes and the unlabeled totals row are all rejected without a keyword
// blocklist. Each item also picks up the "Original Inv# …" that follows it —
// that's the invoice the part was originally bought on, which is what ties a
// credit back to the return it pays out.
function extractCreditLineItemsFromOcrText(text) {
  const lines = String(text || "").split(/\r?\n/);
  const rows = lines.map((raw) => raw.replace(/\s+/g, " ").trim().split(" ").filter(Boolean));
  const items = [];

  for (let ln = 0; ln < rows.length; ln++) {
    const tokens = rows[ln];
    if (tokens.length < 9) continue;

    const d = tokens.findIndex((t) => CREDIT_PCT_RE.test(t));
    if (d < 5 || d + 3 >= tokens.length) continue;

    const unitIdx = d - 5;
    if (!CREDIT_UNIT_RE.test(tokens[unitIdx])) continue;
    // ORDERED / BACK ORDER / INVOICED quantities — signed on a credit.
    if (![d - 4, d - 3, d - 2].every((i) => CREDIT_SIGNED_INT_RE.test(tokens[i]))) continue;

    const price = creditMoney(tokens[d - 1]);
    const netPrice = creditMoney(tokens[d + 1]);
    const netCore = creditMoney(tokens[d + 2]);
    const extPrice = creditMoney(tokens[d + 3]);
    if (price === null || netPrice === null || netCore === null || extPrice === null) continue;

    // Everything before UNIT is the item + description, minus an optional BIN
    // column and minus the stray "-" OCR reads where a credit leaves the BIN
    // blank ("HEATER HOSE ASSEMBLY - EA").
    let head = tokens.slice(0, unitIdx);
    while (head.length && /^[-~|*_]+$/.test(head[head.length - 1])) head.pop();
    const last = head[head.length - 1] || "";
    if (head.length > 1 && last.length >= 4 && /\d/.test(last) && !/[A-Za-z]{3,}/.test(last)) {
      head = head.slice(0, -1); // BIN location code, never output
    }
    if (!head.length || !/[A-Za-z]/.test(head[0])) continue;

    const { partLineCode, partNumber, partDescription } = splitCreditPartTokens(head);

    // The "Original Inv# …" note sits on one of the next few lines, before the
    // following item row. Bounded so a missing note can't run into the next part.
    let originalInvoice = "";
    for (let look = ln + 1; look < Math.min(ln + 4, rows.length); look++) {
      const noteLine = rows[look].join(" ");
      if (rows[look].some((t) => CREDIT_PCT_RE.test(t))) break; // hit the next item
      const m = noteLine.match(/Original\s*Inv\s*#?\s*[:\-]?\s*([A-Za-z0-9]{4,20})/i);
      if (m) {
        originalInvoice = m[1];
        break;
      }
    }

    items.push({
      partLineCode,
      partNumber,
      partDescription,
      // Units returned, as a positive count (OCR drops minus signs unevenly —
      // one row of 02KN9936 read "-1 0 1" — and every consumer takes the
      // magnitude anyway).
      quantity: String(Math.abs(Number(tokens[d - 2])) || 0),
      costPrice: netPrice,
      costPriceValue: Number(netPrice),
      extended: extPrice,
      extendedValue: Number(extPrice),
      ...(originalInvoice ? { originalInvoice } : {}),
      addedToOutstanding: false,
      source: "epicor-credit-ocr",
    });
    if (items.length >= 100) break; // guard against a pathological OCR dump
  }
  return items;
}

// A credit memo's totals row carries NO label — it's a bare run of money
// columns (verified on 02KN9936: "-516.40 0.00 0.00 -516.40 -67.13 | -583.53
// -583.53" = subtotal, core, misc, taxable, tax, then the grand total printed
// twice). Take the last money token of the last all-numeric row with at least
// four money columns. Only used when no labelled total was found.
function matchCreditTotalsRow(text) {
  let total = "";
  for (const raw of String(text || "").split(/\r?\n/)) {
    const tokens = raw.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
    if (tokens.length < 4) continue;
    if (tokens.some((t) => /[A-Za-z]/.test(t))) continue; // an item row, not the totals
    const monies = tokens.filter((t) => CREDIT_MONEY_RE.test(t));
    if (monies.length < 4) continue;
    total = monies[monies.length - 1];
  }
  return total ? creditMoney(total) || "" : "";
}

// An invoice prints its amount under "BALANCE DUE"; a credit memo uses a
// credit-specific label instead, and often shows the figure negated — as
// "-123.45", "(123.45)" or "123.45CR". Each list is tried in order and the
// value is stored as a positive magnitude, exactly like an invoice total, so
// credits and invoices record their totals identically. The invoice label is
// kept last in the credit list (and a bare "TOTAL" last of all) so an
// unexpected credit layout still yields a number rather than a blank.
const INVOICE_TOTAL_PATTERNS = [/BALANCE\s*DUE\s*[:\-]?\s*\$?\s*([\d,]+\.\d{2})/i];
const CREDIT_TOTAL_PATTERNS = [
  /CREDIT\s*(?:MEMO\s*)?TOTAL\s*[:\-]?\s*\$?\s*\(?-?\s*([\d,]+\.\d{2})\)?/i,
  /TOTAL\s*CREDIT\s*[:\-]?\s*\$?\s*\(?-?\s*([\d,]+\.\d{2})\)?/i,
  /AMOUNT\s*CREDITED\s*[:\-]?\s*\$?\s*\(?-?\s*([\d,]+\.\d{2})\)?/i,
  /BALANCE\s*DUE\s*[:\-]?\s*\$?\s*\(?-?\s*([\d,]+\.\d{2})\)?/i,
  // Last resort, so it must not swallow "SUBTOTAL" — hence the boundary.
  /(?:^|[^A-Z])TOTAL\s*[:\-]?\s*\$?\s*\(?-?\s*([\d,]+\.\d{2})\)?/im,
];
function matchDocumentTotal(text, isCredit) {
  for (const re of isCredit ? CREDIT_TOTAL_PATTERNS : INVOICE_TOTAL_PATTERNS) {
    const m = String(text || "").match(re);
    if (m) return m[1].replace(/,/g, "");
  }
  // Real World credit memos label nothing — fall back to the totals row.
  return isCredit ? matchCreditTotalsRow(text) : "";
}

// Derive every field we care about from a scanned document's OCR text: the
// total, order reference (with LL9999 correction + match against a target), the
// EHC environmental fee, and the parsed line items. Shared by the live scrape
// and the "rescan this one" path that re-OCRs the already-saved image.
// opts.isCredit switches to the credit memo parsers — different total
// extraction AND a different line-item parser, since a credit's item rows are
// negative and laid out differently. Everything is returned in the same shape
// and stored the same way either way.
function parseInvoiceOcrFields(text, reference = "", { isCredit = false } = {}) {
  const balanceDue = matchDocumentTotal(text, isCredit);
  // Only page 1 is rasterized for OCR, so a longer document loses whatever is
  // on page 2+. Credits say so on the page; surface it rather than silently
  // returning a partial parts list.
  const continuesOnNextPage = /continued\s+on\s+next\s+page/i.test(String(text || ""));

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

  const lineItems = isCredit
    ? extractCreditLineItemsFromOcrText(text)
    : extractLineItemsFromInvoiceText(text);
  return {
    balanceDue,
    foundReference,
    matchesReference,
    hasEnvironmentalFee,
    environmentalFeeAmount,
    lineItems,
    continuesOnNextPage,
  };
}

// Re-OCR already-saved image file(s) and re-derive the fields. No browser, no
// Epicor navigation, no date needed — this is what "Rescan this one" uses.
// Takes either a single path or every page of a multi-page credit, so a rescan
// reads exactly what the original scan read (a credit's parts continue onto
// page 2; passing only page 1 here would silently drop them).
async function ocrInvoiceImageFile(imagePathOrPaths, reference = "", { isCredit = false } = {}) {
  const paths = (Array.isArray(imagePathOrPaths) ? imagePathOrPaths : [imagePathOrPaths]).filter(Boolean);
  if (!paths.length) throw new Error("No image to rescan.");
  const pageTexts = [];
  for (const p of paths) {
    const {
      data: { text: pageText },
    } = await Tesseract.recognize(p, "eng");
    pageTexts.push(pageText);
  }
  const text = pageTexts.join("\n");
  const fields = parseInvoiceOcrFields(text, reference, { isCredit });
  return {
    text,
    ...fields,
    continuesOnNextPage: fields.continuesOnNextPage && paths.length < 2,
    lineItemsVersion: lineItemParseVersion(isCredit),
  };
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
async function openAndOcrResultRow(context, page, rowIndex, reference, debugDir, invoiceNumber, isCredit = false) {
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

  // Credits carry their parts onto page 2+, so read the whole document; an
  // invoice's page 1 has everything we use, so it stays single-page.
  console.log(
    `[epicor] row ${rowIndex}: rasterizing ${isCredit ? "every page" : "page 1"} at 3x scale...`
  );
  const rendered = await pdfToPng(pdfBuffer, {
    viewportScale: 3,
    ...(isCredit ? {} : { pagesToProcess: [1] }),
  });
  const pngPages = (rendered || []).filter((p) => p && p.content).slice(0, MAX_CREDIT_OCR_PAGES);
  if (!pngPages.length) {
    throw new Error(`Failed to rasterize PDF for row ${rowIndex}`);
  }
  if ((rendered || []).length > pngPages.length) {
    console.log(
      `[epicor] row ${rowIndex}: document has ${rendered.length} pages; reading the first ${pngPages.length}`
    );
  }

  // Page 1 keeps the canonical file name so existing images/orders still
  // resolve; later pages sit beside it as _p2/_p3.
  const pageImageFileNames = pngPages.map((_, idx) =>
    getInvoiceImageFileName(invoiceNumber || rowIndex, isCredit, idx + 1)
  );
  const imageFileName = pageImageFileNames[0];
  if (debugDir) {
    pngPages.forEach((p, idx) => {
      try {
        const debugPath = path.join(debugDir, pageImageFileNames[idx]);
        fs.writeFileSync(debugPath, p.content);
        console.log(`[epicor] row ${rowIndex}: saved page ${idx + 1} image to ${debugPath}`);
      } catch (e) {
        console.log(`[epicor] row ${rowIndex}: failed to save page ${idx + 1} image: ${e.message}`);
      }
    });
  }

  // One OCR pass per page, concatenated — the parsers work line by line, so the
  // joined text reads exactly like one long document.
  console.log(`[epicor] row ${rowIndex}: running OCR over ${pngPages.length} page(s)...`);
  const pageTexts = [];
  for (let p = 0; p < pngPages.length; p++) {
    const {
      data: { text: pageText },
    } = await Tesseract.recognize(pngPages[p].content, "eng");
    console.log(
      `[epicor] row ${rowIndex}: page ${p + 1} OCR text (${pageText.trim().length} chars):\n${pageText}`
    );
    pageTexts.push(pageText);
  }
  const text = pageTexts.join("\n");

  // OCR only confirms which document belongs to this order (via the reference
  // line), reads the balance due / EHC fee, and parses the line items. The
  // invoice number itself comes from the grid (authoritative), not OCR.
  const {
    balanceDue,
    foundReference,
    matchesReference,
    hasEnvironmentalFee,
    environmentalFeeAmount,
    lineItems,
    continuesOnNextPage,
  } = parseInvoiceOcrFields(text, reference, { isCredit });
  console.log(
    `[epicor] row ${rowIndex}: parsed balanceDue="${balanceDue || "(none)"}" ref="${foundReference || "(none)"}" matches=${matchesReference} EHC=${hasEnvironmentalFee} parts=${lineItems.length} pages=${pngPages.length}`
  );

  return {
    text,
    balanceDue,
    foundReference,
    matchesReference,
    imageFileName,
    pageImageFileNames,
    hasEnvironmentalFee,
    environmentalFeeAmount,
    lineItems,
    // Only meaningful when we did NOT read every page (i.e. invoices, or a
    // credit past the page cap) — otherwise the continuation has been read.
    continuesOnNextPage: continuesOnNextPage && pngPages.length < 2,
  };
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

// A range scan holds its own in-memory `cache` object across many minutes of
// OCR work, so it can go stale relative to disk if a rescan/unmatchable-flag
// edit (vendorOrders.service.js) or another scan writes meanwhile.
// Re-reading disk right before writing and merging on top of it — rather than
// blindly overwriting with the possibly-stale in-memory snapshot — means a
// concurrent writer's entries survive; only a genuine same-key collision
// (astronomically rare) can still be lost.
function saveInvoiceCache(cachePath, cache) {
  try {
    const fresh = loadInvoiceCache(cachePath);
    const merged = { ...fresh, ...cache };
    writeJsonAtomic(cachePath, JSON.stringify(merged, null, 2));
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
// opts.isCredit: these results are credit memos, not invoices — they go through
// the identical OCR/cache/image pipeline, just under their own cache key and
// image prefix, and with the credit total labels.
async function findInvoiceByOcr(
  context,
  page,
  results,
  reference,
  debugDir,
  cachePath,
  { force = false, onlyInvoiceKeys = null, isCredit = false } = {}
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
    isCredit,
    creditNumber: row.creditNumber || "",
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
    const cacheKey = invoiceCacheKey(results[i].invoiceNumber, isCredit);
    const cached = cacheKey ? cache[cacheKey] : null;

    if (cached) {
      const imageFileName = cached.imageFileName || getInvoiceImageFileName(results[i].invoiceNumber, isCredit);
      const imageExists = Boolean(debugDir) && fs.existsSync(path.join(debugDir, imageFileName));
      const partsCurrent = cached.lineItemsVersion === lineItemParseVersion(isCredit);
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
            continuesOnNextPage: Boolean(cached.continuesOnNextPage),
            pageImageFileNames: Array.isArray(cached.pageImageFileNames)
              ? cached.pageImageFileNames
              : [imageFileName],
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
            ? `line-item parser is newer than the cached parts (v${cached.lineItemsVersion || "none"} -> v${lineItemParseVersion(isCredit)})`
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
      continuesOnNextPage,
      pageImageFileNames,
    } = await openAndOcrResultRow(context, page, i, reference, debugDir, results[i].invoiceNumber, isCredit);

    const discoveredReference = matchesReference ? reference : foundReference;
    allInvoices.push(
      invoiceEntry(results[i], {
        reference: discoveredReference || "",
        balanceDue,
        imageFileName,
        hasEnvironmentalFee,
        environmentalFeeAmount,
        lineItems: Array.isArray(lineItems) ? lineItems : [],
        continuesOnNextPage,
        pageImageFileNames,
      })
    );
    if (cacheKey) {
      cache[cacheKey] = {
        reference: discoveredReference,
        balanceDue,
        imageFileName,
        pageImageFileNames,
        isCredit,
        creditNumber: results[i].creditNumber || "",
        hasEnvironmentalFee,
        environmentalFeeAmount,
        lineItems: Array.isArray(lineItems) ? lineItems : [],
        continuesOnNextPage: Boolean(continuesOnNextPage),
        lineItemsVersion: lineItemParseVersion(isCredit),
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

// DOCTYPE checkboxes on the search panel. "Invoice" is ticked by default, so a
// credit search has to BOTH tick Credit and untick Invoice — leaving Invoice on
// would search both document types.
const DOCTYPE_INVOICE = "5016";
const DOCTYPE_CREDIT = "5017";
function docTypeCheckbox(page, doctypeId) {
  return page
    .locator(`input[name="DOCTYPE"][doctypeid="${doctypeId}"]`)
    .or(page.locator(`#poh_hi_ui_SearchPanel_SearchPanel_IndexesPane_0-DOCTYPE_${doctypeId}`))
    .first();
}

// Restrict the search to credit documents only.
async function selectCreditDocType(page) {
  const credit = docTypeCheckbox(page, DOCTYPE_CREDIT);
  const invoice = docTypeCheckbox(page, DOCTYPE_INVOICE);

  if ((await credit.count()) === 0) {
    throw new Error('Could not find the "Credit" document-type checkbox on the search panel.');
  }
  await credit.check();
  console.log("[epicor] ticked the Credit document-type checkbox");

  // Unticking Invoice is what makes this a credits-ONLY search. Tolerated as
  // missing (some search configs may not offer it) rather than fatal — the
  // Credit tick above is the part that must succeed.
  if ((await invoice.count()) > 0) {
    await invoice.uncheck();
    console.log("[epicor] unticked the Invoice document-type checkbox");
  } else {
    console.log('[epicor] no "Invoice" document-type checkbox found to untick');
  }

  console.log(
    `[epicor] doctype state -> credit=${await credit.isChecked()} invoice=${
      (await invoice.count()) > 0 ? await invoice.isChecked() : "n/a"
    }`
  );
}

// Type a credit memo number into the "Credit #" search field. Optional — with
// it the search returns the single matching credit, without it every credit in
// the date range.
async function fillCreditNumber(page, creditNumber) {
  const container = getIndexValueContainer(page, "Credit #");
  const input = container.locator("input.dijitInputInner").first();
  const count = await input.count();
  console.log(`[epicor] "Credit #" input count: ${count}`);
  if (count === 0) {
    throw new Error('Could not find the "Credit #" search field.');
  }
  // Same Dojo dijit/form/TextBox caveat as the date fields: .fill() sets the
  // DOM value without updating the widget's model, which can wipe it on blur.
  await input.click();
  await input.pressSequentially(String(creditNumber), { delay: 30 });
  await input.evaluate((el) => el.blur());
  const typed = await input.inputValue().catch((e) => `(error: ${e.message})`);
  console.log(`[epicor] typed credit number -> "${typed}"`);
}

// Fill the search panel and click Search. Two mutually exclusive ways to search:
//  - by DATE (the invoice scan): fill the "Date" from/to range.
//  - by CREDIT NUMBER (the credit lookup): swap the document type from Invoice
//    to Credit and type the credit memo number, leaving the date fields
//    untouched. Epicor has no date criterion for a credit lookup — the number
//    alone identifies it.
async function searchInvoicesForDate(
  page,
  fromSageDate,
  toSageDate,
  reference,
  { docTypeCredit = false, creditNumber = "" } = {}
) {
  const credit = String(creditNumber || "").trim();
  const useDates = Boolean(String(fromSageDate || "").trim() || String(toSageDate || "").trim());
  let epicorFromDate = "";
  let epicorToDate = "";

  console.log(`[epicor] current page URL: ${page.url()}`);
  try {
    const frames = page.frames();
    console.log(`[epicor] page has ${frames.length} frame(s): ${frames.map((f) => f.name() || f.url()).join(", ")}`);
  } catch (e) {
    console.log(`[epicor] could not list frames: ${e.message}`);
  }

  if (useDates) {
    epicorFromDate = convertSageDateToEpicorFormat(fromSageDate);
    epicorToDate = convertSageDateToEpicorFormat(toSageDate);
    console.log(
      `[epicor] searchInvoicesForDate: fromSageDate="${fromSageDate}" -> epicorFromDate="${epicorFromDate}", toSageDate="${toSageDate}" -> epicorToDate="${epicorToDate}"`
    );
    if (!epicorFromDate) {
      throw new Error(`Invalid sage date: ${fromSageDate}`);
    }
    if (!epicorToDate) {
      throw new Error(`Invalid sage date: ${toSageDate}`);
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
  } else {
    if (!credit) {
      throw new Error("Nothing to search by: give a date range, or a credit memo number.");
    }
    // No date fields to fill, so nothing has waited for the Dojo panel yet.
    await waitForSearchPanel(page);
    console.log("[epicor] credit-number lookup: skipping the date fields entirely");
  }

  if (docTypeCredit) {
    await selectCreditDocType(page);
  }
  if (credit) {
    await fillCreditNumber(page, credit);
  }

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
  extractLineItemsFromInvoiceText,
  extractCreditLineItemsFromOcrText,
  matchCreditTotalsRow,
  getInvoiceImageFileName,
  invoiceCacheKey,
  cacheKeyToNumber,
  CREDIT_CACHE_PREFIX,
  LINEITEM_PARSE_VERSION,
  CREDIT_LINEITEM_PARSE_VERSION,
  lineItemParseVersion,
};
