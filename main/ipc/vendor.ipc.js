const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { BrowserWindow } = require('electron');

// Which engine prints invoice PDFs. Both print the *actual* PDF (vector, full
// quality, Type3-safe) rather than rasterizing it — a screenshot approach was
// tried and abandoned because it silently cropped whatever the on-screen PDF
// viewer left below the fold (line items, totals). Flip to 'sumatra' if the
// Chromium path misbehaves on a given printer; that path is proven and needs
// no rendering from us, at the cost of a bundled binary.
//   'chromium' — Electron's built-in viewer + webContents.print(). No deps.
//   'sumatra'  — pdf-to-printer (bundled SumatraPDF/MuPDF). Rock-solid.
const PDF_PRINT_METHOD = 'chromium';

// Resolve a stored invoice-asset file name against its vendor's data dir,
// refusing anything that tries to escape the folder (traversal / absolute path).
function resolveVendorImagePath(dataDir, fileName) {
  if (typeof fileName !== 'string' || !fileName || fileName.includes('..') || path.isAbsolute(fileName)) {
    return null;
  }
  return path.join(dataDir, fileName);
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// True once the captured frame looks like an actual rendered page: mostly
// light (paper) with a real minority of dark pixels (ink). This distinguishes
// "done" from the two transient states we must not print — a not-yet-rendered
// blank white frame, and the uninitialized solid-black compositor frame — both
// of which produce a wrong printout if webContents.print() fires on them.
function looksRendered(image) {
  const { width, height } = image.getSize();
  if (!width || !height) return false;
  const bitmap = image.toBitmap(); // BGRA
  let light = 0;
  let dark = 0;
  let total = 0;
  const step = 8;
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const i = (y * width + x) * 4;
      const b = bitmap[i];
      const g = bitmap[i + 1];
      const r = bitmap[i + 2];
      total++;
      if (b > 200 && g > 200 && r > 200) light++;
      else if (b < 100 && g < 100 && r < 100) dark++;
    }
  }
  if (!total) return false;
  const lightFrac = light / total;
  const darkFrac = dark / total;
  // A real invoice page: predominantly paper, with a small but non-trivial
  // amount of ink. Blank frame → darkFrac ~0; black frame → lightFrac ~0.
  return lightFrac > 0.4 && darkFrac > 0.004;
}

const registerVendorIpc = (ipcMain, deps) => {
  const {
    openEpicor,
    scanEpicorRange,
    rescanEpicorInvoice,
    getEpicorScannedInvoices,
    shell,
    getEpicorAssetsDir,
    fetchTransbecInvoices,
    fetchBestbuyInvoices,
    fetchBestbuyCreditInvoices,
    fetchCbkInvoices,
    fetchTransbecCreditInvoices,
    getTransbecCreditInvoices,
    resetTransbecCreditScans,
    connectGmail,
    getGmailStatus,
    getGmailAssetsDir,
    getWin,
    loadConfig,
  } = deps;

  ipcMain.handle('vendor:open-epicor', async (_evt, payload) => {
    return openEpicor(payload);
  });

  ipcMain.handle('vendor:scan-epicor-range', async (_evt, payload) => {
    return scanEpicorRange(payload);
  });

  ipcMain.handle('vendor:get-epicor-scanned', async () => {
    return getEpicorScannedInvoices();
  });

  ipcMain.handle('vendor:rescan-epicor-invoice', async (_evt, payload) => {
    return rescanEpicorInvoice(payload);
  });

  ipcMain.handle('vendor:open-epicor-invoice-image', async (_evt, fileName) => {
    return openVendorImage(getEpicorAssetsDir(), fileName);
  });

  ipcMain.handle('vendor:read-epicor-invoice-image', async (_evt, fileName) => {
    return readVendorImage(getEpicorAssetsDir(), fileName);
  });

  // --- Transbec invoices from Gmail ---
  ipcMain.handle('vendor:fetch-transbec-invoices', async (_evt, payload) => {
    return fetchTransbecInvoices(payload);
  });

  ipcMain.handle('vendor:connect-gmail', async () => {
    return connectGmail();
  });

  ipcMain.handle('vendor:gmail-status', async () => {
    return getGmailStatus();
  });

  ipcMain.handle('vendor:open-transbec-invoice-image', async (_evt, fileName) => {
    return openVendorImage(getGmailAssetsDir(), fileName);
  });

  ipcMain.handle('vendor:read-transbec-invoice-image', async (_evt, fileName) => {
    return readVendorImage(getGmailAssetsDir(), fileName);
  });

  // --- BestBuy invoices from Gmail (assets share the gmail data dir) ---
  ipcMain.handle('vendor:fetch-bestbuy-invoices', async (_evt, payload) => {
    return fetchBestbuyInvoices(payload);
  });

  ipcMain.handle('vendor:open-bestbuy-invoice-image', async (_evt, fileName) => {
    return openVendorImage(getGmailAssetsDir(), fileName);
  });

  ipcMain.handle('vendor:read-bestbuy-invoice-image', async (_evt, fileName) => {
    return readVendorImage(getGmailAssetsDir(), fileName);
  });

  // --- BestBuy CREDIT invoices from Gmail (separate search from the batch
  // invoice pipeline above; PDFs land in the same gmail data dir, so viewing
  // and printing reuse the handlers above by file name) ---
  ipcMain.handle('vendor:fetch-bestbuy-credit-invoices', async (_evt, payload) => {
    return fetchBestbuyCreditInvoices(payload);
  });

  // --- Transbec CREDIT MEMOS from Gmail (separate search from the regular
  // invoice pipeline above; a credit has no pre-existing order, so this is
  // just a discovery list — PDFs land in the same gmail data dir, so viewing
  // reuses the Transbec invoice image handlers above by file name) ---
  ipcMain.handle('vendor:fetch-transbec-credit-invoices', async (_evt, payload) => {
    return fetchTransbecCreditInvoices(payload);
  });

  ipcMain.handle('vendor:get-transbec-credits', async () => {
    return getTransbecCreditInvoices();
  });

  // DEV-ONLY: wipe the Transbec credit scan cache + downloaded PDFs so a
  // scan can be re-run from scratch while building this feature.
  ipcMain.handle('vendor:reset-transbec-credits', async () => {
    return resetTransbecCreditScans();
  });

  // --- CBK invoices from Gmail (assets share the gmail data dir) ---
  ipcMain.handle('vendor:fetch-cbk-invoices', async (_evt, payload) => {
    return fetchCbkInvoices(payload);
  });

  ipcMain.handle('vendor:open-cbk-invoice-image', async (_evt, fileName) => {
    return openVendorImage(getGmailAssetsDir(), fileName);
  });

  ipcMain.handle('vendor:read-cbk-invoice-image', async (_evt, fileName) => {
    return readVendorImage(getGmailAssetsDir(), fileName);
  });

  // Lists OS-registered printers so Settings can offer a dropdown; requires an
  // existing webContents (getPrintersAsync is a webContents method, not global),
  // so it's read off the main window rather than a throwaway one.
  ipcMain.handle('printers:list', async () => {
    try {
      const win = getWin && getWin();
      if (!win || win.isDestroyed()) {
        return { ok: false, error: 'App window not available.' };
      }
      const printers = await win.webContents.getPrintersAsync();
      return {
        ok: true,
        printers: printers.map((p) => ({
          name: p.name,
          displayName: p.displayName || p.name,
          isDefault: Boolean(p.isDefault),
        })),
      };
    } catch (e) {
      return { ok: false, error: e?.message || 'Failed to list printers.' };
    }
  });

  // Prints a Transbec/BestBuy invoice straight to the configured (or OS
  // default) printer with no dialog, same as Sage's print button. Page 1 only
  // by default; pass allPages:true (Transbec credit memos — the return stub
  // with the actual balance due is on page 2) to print the whole document.
  ipcMain.handle('vendor:print-invoice-silent', async (_evt, fileName, allPages) => {
    const printerName = (loadConfig && loadConfig().INVOICE_PRINTER) || '';
    return printInvoiceSilently(getGmailAssetsDir(), fileName, printerName, Boolean(allPages));
  });

  async function openVendorImage(dataDir, fileName) {
    try {
      const filePath = resolveVendorImagePath(dataDir, fileName);
      if (!filePath) {
        return { ok: false, error: 'Invalid image file name.' };
      }
      if (!fs.existsSync(filePath)) {
        return { ok: false, error: `Invoice image not found: ${fileName}` };
      }
      const err = await shell.openPath(filePath);
      if (err) {
        return { ok: false, error: err };
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e?.message || 'Failed to open invoice image.' };
    }
  }

  // Method A: print the real PDF through Chromium's built-in viewer (PDFium —
  // the engine that also renders the on-screen "Verify Invoice" preview, and
  // which handles the Type3 line-item font that pdf.js drops). The page is
  // never rasterized by us, so quality is native and nothing can be cropped
  // off: page-range restricts the job to page 1 on multi-page invoices unless
  // allPages is set (Transbec credit memos, printed in full).
  async function printPdfViaChromium(filePath, printerName, allPages) {
    const win = new BrowserWindow({
      show: false,
      webPreferences: { sandbox: true, plugins: true, backgroundThrottling: false },
    });
    try {
      await win.loadURL(pathToFileURL(filePath).href);
      // loadURL() resolving only means the outer frame loaded; the PDF renders
      // inside an embedded plugin subframe a beat later. Printing before it has
      // painted yields a blank or solid-black page, so gate on a frame that
      // actually looks like a rendered document (capturePage here is only a
      // readiness probe — it is NOT the thing being printed).
      let ready = false;
      for (let i = 0; i < 40 && !win.isDestroyed(); i++) {
        await delay(200);
        try {
          if (looksRendered(await win.webContents.capturePage())) {
            ready = true;
            break;
          }
        } catch {
          /* window still coming up; keep polling */
        }
      }
      if (!ready) {
        return { ok: false, error: 'Timed out waiting for the invoice to render for printing.' };
      }
      const result = await new Promise((resolve) => {
        win.webContents.print(
          {
            silent: true,
            printBackground: true,
            deviceName: printerName || undefined,
            margins: { marginType: 'none' },
            // Invoice PDFs can run multiple pages (line items, return stub);
            // the printout is normally just page 1 (0-based pageRanges).
            // Omitting pageRanges entirely prints every page.
            ...(allPages ? {} : { pageRanges: [{ from: 0, to: 0 }] }),
          },
          (success, errorType) => resolve({ success, errorType })
        );
      });
      if (!result.success) {
        return { ok: false, error: result.errorType || 'Print failed.' };
      }
      return { ok: true };
    } finally {
      if (!win.isDestroyed()) win.destroy();
    }
  }

  // Method B (fallback): hand the PDF file to the bundled SumatraPDF via
  // pdf-to-printer. It renders with MuPDF (Type3-safe) and prints silently to
  // the named printer with no Chromium involvement. Selected by flipping
  // PDF_PRINT_METHOD; requires the SumatraPDF binary to be asar-unpacked in
  // packaged builds (see build.asarUnpack in package.json).
  async function printPdfViaSumatra(filePath, printerName, allPages) {
    const ptp = require('pdf-to-printer');
    const options = {};
    if (!allPages) options.pages = '1';
    if (printerName) options.printer = printerName; // omitted → OS default printer
    await ptp.print(filePath, options);
    return { ok: true };
  }

  async function printInvoiceSilently(dataDir, fileName, printerName, allPages) {
    const filePath = resolveVendorImagePath(dataDir, fileName);
    if (!filePath) {
      return { ok: false, error: 'Invalid image file name.' };
    }
    if (!fs.existsSync(filePath)) {
      return { ok: false, error: `Invoice file not found: ${fileName}` };
    }

    try {
      if (/\.pdf$/i.test(filePath)) {
        return PDF_PRINT_METHOD === 'sumatra'
          ? await printPdfViaSumatra(filePath, printerName, allPages)
          : await printPdfViaChromium(filePath, printerName, allPages);
      }
      // Non-PDF invoices (e.g. BestBuy/CBK PNGs) are already raster with no
      // Type3 concern, so print them as a plain full-bleed image in a hidden,
      // throwaway window — there is no direct "print this file" API.
      const printWin = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
      try {
        const buffer = fs.readFileSync(filePath);
        const dataUrl = `data:image/png;base64,${buffer.toString('base64')}`;
        const html =
          '<!doctype html><html><head><style>' +
          '@page { margin: 0; } html, body { margin: 0; padding: 0; } img { width: 100%; display: block; }' +
          `</style></head><body><img src="${dataUrl}" /></body></html>`;
        await printWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
        const result = await new Promise((resolve) => {
          printWin.webContents.print(
            {
              silent: true,
              printBackground: true,
              deviceName: printerName || undefined,
              margins: { marginType: 'none' },
            },
            (success, errorType) => resolve({ success, errorType })
          );
        });
        if (!result.success) {
          return { ok: false, error: result.errorType || 'Print failed.' };
        }
        return { ok: true };
      } finally {
        if (!printWin.isDestroyed()) printWin.destroy();
      }
    } catch (e) {
      return { ok: false, error: e?.message || 'Failed to print invoice.' };
    }
  }

  function readVendorImage(dataDir, fileName) {
    try {
      const filePath = resolveVendorImagePath(dataDir, fileName);
      if (!filePath) {
        return { ok: false, error: 'Invalid image file name.' };
      }
      if (!fs.existsSync(filePath)) {
        return { ok: false, error: `Invoice file not found: ${fileName}` };
      }
      const buffer = fs.readFileSync(filePath);
      const mime = /\.pdf$/i.test(filePath) ? 'application/pdf' : 'image/png';
      return { ok: true, dataUrl: `data:${mime};base64,${buffer.toString('base64')}` };
    } catch (e) {
      return { ok: false, error: e?.message || 'Failed to read invoice file.' };
    }
  }
};

module.exports = { registerVendorIpc };
