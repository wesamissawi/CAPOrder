// src/scrapers/cloverScraper.js
//
// Clover payment scrape — deliberately credential-free.
//
// Every other scraper here logs itself in from stored credentials. This one
// never sees a Clover username or password: the app opens a plain browser
// window, the user signs in and navigates to the transaction list they want,
// and only then does the scrape read the rendered DOM. Because of that, the
// browser has to stay open *between* two separate IPC calls, so the session
// handle lives at module scope rather than inside one function.
//
// Nothing about the Clover session is persisted: the context is created with
// no storageState and is never saved, so closing the window leaves no cookies
// on disk and the next scrape starts at the login screen again.
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');
const {
  harvestTransactionRows,
  harvestDetailText,
  harvestReceiptInfo,
  findReceiptHref,
  parseHarvest,
  resolveDetailUrl,
  parseMerchantId,
  buildReceiptUrl,
  detectCardBrand,
  detectLast4,
} = require('./clover.actions');

const DEFAULT_CLOVER_URL = 'https://www.clover.com/dashboard';

// The live browser, or null. Holds { browser, context, openedAt }.
let session = null;

function isLive() {
  return Boolean(session && session.browser && session.browser.isConnected());
}

// The tab to read. The user may open Clover in a second tab (or Clover itself
// may pop one), so the most recently opened live page wins.
function activePage() {
  if (!isLive()) return null;
  const pages = session.context.pages().filter((p) => !p.isClosed());
  return pages.length ? pages[pages.length - 1] : null;
}

async function getCloverStatus() {
  if (!isLive()) return { ok: true, open: false };
  const page = activePage();
  let url = '';
  let title = '';
  if (page) {
    url = page.url();
    try {
      title = await page.title();
    } catch {
      /* page navigating; title isn't important enough to fail on */
    }
  }
  return { ok: true, open: true, url, title, openedAt: session.openedAt };
}

// Opens the browser and leaves it open. Returns immediately after the initial
// navigation — the user does the logging in, on their own time.
async function openCloverSession(options = {}) {
  if (isLive()) {
    const page = activePage();
    if (page) await page.bringToFront().catch(() => {});
    return { ...(await getCloverStatus()), alreadyOpen: true };
  }

  const startUrl = String(options.url || process.env.CLOVER_URL || DEFAULT_CLOVER_URL);
  // Visible by default and in every real use — the entire point is that the
  // user logs in and navigates themselves. Only a test harness passes true.
  const headless = options.headless === true;
  const browser = await chromium.launch({ headless, args: ['--start-maximized'] });
  // viewport: null → the page fills the real window instead of Playwright's
  // 1280x720 default, so Clover lays out as it would in a normal browser.
  const context = await browser.newContext({ viewport: null });
  const page = await context.newPage();

  browser.on('disconnected', () => {
    if (session && session.browser === browser) session = null;
  });

  session = { browser, context, openedAt: new Date().toISOString() };

  try {
    await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  } catch (e) {
    // A slow or blocked first load isn't fatal — the window is up and the user
    // can navigate from there.
    return { ok: true, open: true, url: page.url(), warning: e?.message || String(e) };
  }

  return { ok: true, open: true, url: page.url() };
}

async function closeCloverSession() {
  if (!session) return { ok: true, open: false };
  const { browser } = session;
  session = null;
  try {
    await browser.close();
  } catch {
    /* already gone */
  }
  return { ok: true, open: false };
}

// Dump what we saw when a scrape finds nothing, so the row selectors can be
// tuned against the real markup. Written only on the empty-result path — a
// successful scrape has no reason to leave a copy of the page on disk.
// Every frame's HTML, not just the top document. Clover renders the whole
// transaction list — header row included — inside the ember-outlet iframe, so
// page.content() alone captures the shell and none of the markup that actually
// matters when a scrape comes back empty.
async function saveDebugSnapshot(page, debugDir) {
  if (!debugDir) return '';
  try {
    fs.mkdirSync(debugDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const htmlPath = path.join(debugDir, `clover_page_${stamp}.html`);
    fs.writeFileSync(htmlPath, await page.content(), 'utf8');

    let n = 0;
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      let html = '';
      try {
        html = await frame.content();
      } catch {
        continue; // cross-origin third-party frame; nothing we can read
      }
      if (!html || html.length < 200) continue;
      n += 1;
      fs.writeFileSync(
        path.join(debugDir, `clover_frame${n}_${stamp}.html`),
        `<!-- frame url: ${frame.url()} -->\n${html}`,
        'utf8'
      );
    }
    await page
      .screenshot({ path: path.join(debugDir, `clover_page_${stamp}.png`), fullPage: true })
      .catch(() => {});
    return htmlPath;
  } catch {
    return '';
  }
}

// Read the card brand off a printable receipt (/tx/p/<id>?merchantUuid=<mid>).
// This is a plain server-rendered page, not an iframe app, so one read is
// normally enough; the retry is only for a slow load.
async function readReceipt(tab, url, timeoutMs = 20000) {
  try {
    await tab.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  } catch (e) {
    return { brand: '', error: e?.message || 'receipt-load-failed' };
  }
  const deadline = Date.now() + 8000;
  let last = null;
  while (Date.now() < deadline) {
    let info;
    try {
      info = await tab.evaluate(harvestReceiptInfo);
    } catch {
      info = null;
    }
    if (info) {
      last = info;
      const brand = detectCardBrand(info.brandText) || detectCardBrand(info.text);
      if (brand) {
        return { brand, last4: info.last4 || '', paymentId: info.paymentId || '', text: info.text };
      }
    }
    await tab.waitForTimeout(400);
  }
  return { brand: '', last4: last?.last4 || '', paymentId: last?.paymentId || '', text: last?.text || '' };
}

// Ask the payment's detail page where its receipt is, for the case where the
// receipt URL assembled from the row's own ids didn't work out.
async function findReceiptLink(tab) {
  for (const frame of tab.frames()) {
    let href = '';
    try {
      href = await frame.evaluate(findReceiptHref);
    } catch {
      continue;
    }
    if (href) return href;
  }
  return '';
}

// Read a payment's card brand off its detail page. The content renders in an
// iframe a beat after navigation, so poll — and check the child frames before
// the top document, since the top one is just Clover's nav chrome.
async function readBrandFromPage(tab, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastText = '';
  while (Date.now() < deadline) {
    const frames = tab.frames();
    const ordered = frames.filter((f) => f !== tab.mainFrame()).concat(tab.mainFrame());
    for (const frame of ordered) {
      let res;
      try {
        res = await frame.evaluate(harvestDetailText);
      } catch {
        continue; // cross-origin (Clover embeds third-party reporters) or detached
      }
      if (!res || !res.text) continue;
      const brand = detectCardBrand(res.text);
      if (brand) return { brand, last4: detectLast4(res.text), text: res.text };
      lastText = res.text;
    }
    await tab.waitForTimeout(500);
  }
  return { brand: '', last4: '', text: lastText };
}

// Visit each non-Interac payment's detail page to find out whether it's a Visa
// or a Mastercard — the list itself doesn't say. This runs in ONE extra tab
// that gets reused for every lookup and closed at the end: the user's own tab
// is never navigated, because getting back to the list is painful.
async function resolveCardBrands(context, rows, statusLog, options = {}) {
  const pending = rows.filter((r) => r.needsDetail && (r.receiptUrl || r.detailUrl));
  if (!pending.length) return;

  statusLog.push(`Looking up the card type for ${pending.length} payment(s)…`);
  const tab = await context.newPage();
  let resolved = 0;
  let viaFallback = 0;
  let unreadDumps = 0;
  try {
    for (const row of pending) {
      // Fast path: the receipt URL is just the payment id + merchant uuid, both
      // of which the list row already gave us, so the detail page can be
      // skipped entirely.
      let found = row.receiptUrl
        ? await readReceipt(tab, row.receiptUrl, options.detailTimeoutMs ?? 20000)
        : { brand: '' };

      // Slow path: ask the detail page for the real receipt link. Covers the
      // case where the id in the list isn't the one the receipt URL wants.
      if (!found.brand && row.detailUrl) {
        try {
          await tab.goto(row.detailUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
          const receiptHref = await findReceiptLink(tab);
          if (receiptHref) {
            found = await readReceipt(tab, receiptHref, options.detailTimeoutMs ?? 20000);
            if (found.brand) viaFallback += 1;
          } else {
            // Nothing links to a receipt — fall back to scanning the detail
            // page itself, which is where this used to look.
            found = await readBrandFromPage(tab, 8000);
            if (found.brand) viaFallback += 1;
          }
        } catch (e) {
          row.detailError = e?.message || 'detail-load-failed';
        }
      }

      if (found.brand) {
        row.type = found.brand;
        row.detailResolved = true;
        if (found.last4) row.last4 = found.last4;
        resolved += 1;
      } else {
        row.detailError = row.detailError || 'card-type-not-found';
        // Keep the text of the first few pages we couldn't read a brand off:
        // without it, tuning the match is pure guesswork.
        if (options.debugDir && unreadDumps < 5) {
          try {
            fs.mkdirSync(options.debugDir, { recursive: true });
            fs.writeFileSync(
              path.join(options.debugDir, `clover_detail_unread_${row.externalId || unreadDumps}.txt`),
              `receiptUrl: ${row.receiptUrl || '(none)'}\ndetailUrl: ${row.detailUrl || '(none)'}\n` +
                `error: ${row.detailError}\n\n${found.text || '(no text read)'}`,
              'utf8'
            );
            unreadDumps += 1;
          } catch {
            /* diagnostics are best-effort */
          }
        }
      }
      if (options.stepWaitMs) await tab.waitForTimeout(options.stepWaitMs);
    }
  } finally {
    await tab.close().catch(() => {});
  }
  statusLog.push(
    `Card type resolved for ${resolved} of ${pending.length} payment(s)` +
      (viaFallback ? ` (${viaFallback} needed the detail page to find its receipt).` : ' straight from the receipt.')
  );
  if (unreadDumps) {
    statusLog.push(`Saved the text of ${unreadDumps} unreadable page(s) to the clover folder.`);
  }
}

// Reads the transaction rows off whatever page the user has open. Scans every
// frame, because Clover renders the transaction list inside an iframe
// (#ember-outlet > .iframe-container > iframe), never in the top document.
//
// knownIds are payment ids already in the scrape ledger; they're dropped before
// any detail lookup happens, so a re-scrape of the same list is cheap and can
// never re-import something the user has since edited or deleted.
async function scrapeCloverPayments(options = {}) {
  if (!isLive()) {
    return {
      ok: false,
      open: false,
      error: 'The Clover browser is not open. Click "Open Clover", sign in, then scrape.',
    };
  }
  const page = activePage();
  if (!page) {
    return { ok: false, open: true, error: 'No Clover tab is open in the browser window.' };
  }

  const knownIds = new Set(
    (Array.isArray(options.knownIds) ? options.knownIds : []).map((id) => String(id).trim()).filter(Boolean)
  );
  const statusLog = [];

  try {
    const frames = page.frames().filter((f) => !f.isDetached());
    let best = null;
    const diagnostics = [];
    for (const frame of frames) {
      let harvest;
      try {
        harvest = await frame.evaluate(harvestTransactionRows);
      } catch (e) {
        diagnostics.push(`frame ${frame.url()}: unreadable (${e?.message || 'evaluate failed'})`);
        continue; // cross-origin or mid-navigation frame
      }
      const parsed = parseHarvest(harvest, new Date());
      const d = harvest.diag || {};
      const rowsSeen = (harvest.groups || []).reduce((n, g) => n + (g.rows || []).length, 0);
      diagnostics.push(
        `frame ${frame.url() || '(no url)'}: ${d.detailLinks || 0} details link(s), ` +
          `${d.trs || 0} <tr>, ${d.moneyCells || 0} $ value(s), ${rowsSeen} row(s) harvested, ` +
          `${parsed.transactions.length} parsed` +
          (parsed.headers && parsed.headers.length ? ` | headers: ${parsed.headers.join(' | ')}` : ' | no headers found')
      );
      // A details-link group beats a bigger generic one: only those rows carry
      // the payment id the ledger needs.
      const better =
        !best ||
        (parsed.kind === 'details-link' && best.parsed.kind !== 'details-link') ||
        (parsed.kind === best.parsed.kind && parsed.transactions.length > best.parsed.transactions.length);
      if (better) best = { harvest, parsed };
    }

    const pageUrl = page.url();
    let pageTitle = '';
    try {
      pageTitle = await page.title();
    } catch {
      /* not important */
    }

    if (!best || !best.parsed.transactions.length) {
      const snapshot = await saveDebugSnapshot(page, options.debugDir);
      statusLog.push('No payment rows were found on this page.');
      diagnostics.forEach((line) => statusLog.push(line));
      if (snapshot) statusLog.push(`Saved every frame's HTML for troubleshooting: ${snapshot}`);
      return {
        ok: false,
        open: true,
        url: pageUrl,
        title: pageTitle,
        transactions: [],
        snapshot,
        statusLog,
        error:
          'No payment rows found on this page. Open Transactions → Payments, scroll until every row you want is loaded, then scrape again.',
      };
    }

    const all = best.parsed.transactions;
    // The row's own frame may not be able to act as a URL base, so fall back to
    // resolving the Details href against the outer page. The receipt URL —
    // where the card brand actually lives — is assembled from the payment id
    // and the merchant uuid, both of which that same href carries.
    for (const tx of all) {
      tx.detailUrl = resolveDetailUrl(tx.detailUrl, tx.href, pageUrl);
      const merchantId = parseMerchantId(tx.href) || parseMerchantId(tx.detailUrl) || parseMerchantId(pageUrl);
      tx.receiptUrl = buildReceiptUrl(tx.externalId, merchantId, pageUrl);
    }
    statusLog.push(`Found ${all.length} payment row(s) on the page.`);

    // A row with no payment id can't be ledgered, so importing it would mean
    // re-importing it on every future scrape. Skipping is the lesser evil.
    const unidentified = all.filter((t) => !t.externalId);
    if (unidentified.length) {
      statusLog.push(`${unidentified.length} row(s) had no payment id and were skipped.`);
    }

    const identified = all.filter((t) => t.externalId);
    const alreadyScraped = identified.filter((t) => knownIds.has(String(t.externalId)));
    const fresh = identified.filter((t) => !knownIds.has(String(t.externalId)));
    if (alreadyScraped.length) {
      statusLog.push(`${alreadyScraped.length} already scraped previously — skipped.`);
    }

    if (!fresh.length) {
      return {
        ok: true,
        open: true,
        url: pageUrl,
        title: pageTitle,
        kind: best.parsed.kind,
        transactions: [],
        skippedKnown: alreadyScraped.length,
        skippedUnidentified: unidentified.length,
        statusLog,
        scrapedAt: new Date().toISOString(),
      };
    }

    await resolveCardBrands(session.context, fresh, statusLog, {
      stepWaitMs: options.stepWaitMs ?? 250,
      detailTimeoutMs: options.detailTimeoutMs,
      debugDir: options.debugDir,
    });
    // Put the user back where they were — the detail tab is gone, but focus
    // shouldn't be left on whatever Chromium picks next.
    await page.bringToFront().catch(() => {});

    return {
      ok: true,
      open: true,
      url: pageUrl,
      title: pageTitle,
      kind: best.parsed.kind,
      transactions: fresh,
      skippedKnown: alreadyScraped.length,
      skippedUnidentified: unidentified.length,
      statusLog,
      scrapedAt: new Date().toISOString(),
    };
  } catch (e) {
    return {
      ok: false,
      open: true,
      error: e?.message || String(e),
      transactions: [],
      statusLog,
    };
  }
}

module.exports = {
  openCloverSession,
  scrapeCloverPayments,
  closeCloverSession,
  getCloverStatus,
  DEFAULT_CLOVER_URL,
};
