# World B2B site: scraper swap + TEMPORARY gap fix

Written 2026-11-21. Read this before changing anything World-related. It lists
every change made, why, and exactly how to undo each one.

There are **two separate changes**. They can be reverted independently.

| | Change | Permanent? |
|---|---|---|
| A | World order scraper moved to the new site (`b2b.groupe-monaco.ca`) | Yes — this is the new normal |
| B | **TEMP-WORLD-SITE-GAP**: build orders from invoice emails the new site never listed | **No — delete once World fixes the site** |

---

## Why

World moved to `https://b2b.groupe-monaco.ca/store/home` (same storefront
platform as Transbec's `orderstransbec.com`). The old iautoparts portal is no
longer reachable by the user.

The new site's **order history omits some orders**. PO2057 and PO2074 were
delivered and invoiced by email but never appeared in the history (the list
still ended at PO1699, and opening `/store/receipt/PO2057` gives "Unable to
retrieve Order details"). Before change B, an invoice for such an order went
nowhere:

- the regular World invoice check (`worldInvoice.js`) only fills in orders that
  already exist;
- the World PO check (`worldStandaloneInvoice.js`) deliberately ignores any
  invoice that prints a conf number.

---

## A. New World order scraper (permanent)

**Added**
- `src/scrapers/worldB2b.actions.js` — login, order list, receipt parser.
- `src/scrapers/worldB2bScraper.js` — `getWorldB2bOrders`.

**Modified**
- `main.js` (~line 45) — the import now reads
  `const { getWorldB2bOrders: getWorldOrders } = require('./src/scrapers/worldB2bScraper');`
  **It used to be:** `const { getWorldOrders } = require('./src/scrapers/worldScraper');`
- `main/services/vendorOrders.service.js` `fetchWorldOrders` — passes
  `maxPages` (from `WORLD_MAX_PAGES`), its own `world_b2b_storage_state.json`
  and `world_b2b_products.json` under `VENDOR_PATHS.world.dataDir`.
  Previously it passed `VENDOR_PATHS.world.storageState` and no `maxPages`.
- `main/services/credentialSync.service.js` — `'WORLD_MAX_PAGES'` added to
  `SHARED_CONFIG_KEYS`.
- `renderer/src/views/SettingsView.jsx` — "World Max Pages" field
  (`worldMaxPages` state, load, save).

**NOT removed (kept on purpose, now unwired):**
`src/scrapers/worldScraper.js` and `src/scrapers/world.actions.js` (the old
iautoparts frameset scraper). The user said not to delete them yet. Nothing
imports them any more.

**To go back to the old scraper:** restore the original `main.js` import line
above and (optionally) the two `vendorOrders.service.js` path arguments. The
old scraper uses `VENDOR_PATHS.world.storageState` and `world_orders.json`.

**Known behaviour / open items**
- Reference = the site's order number (`PO1699`, `PL5867`): same
  letters-plus-digits shape as the conf number on invoice emails. PO1699's
  email was confirmed to exist.
- `warehouse`/`seller` are `"World Automotive Warehouse"` (same string as
  every historical World order, and `WORLD_WAREHOUSE` in `App.jsx`).
- **EHC** (per-unit fee, included in the line Total) is split out at scrape
  time: `lineItems` keep the part's own money, `sage_lineItems` are
  fee-inclusive. The invoice pass skips a fee already applied.
- **Core column has never been seen filled.** It is kept raw as `coreRaw` on
  the line and flagged in the status log; it is **not** yet split into
  `CORE <line>` lines. Revisit with a real core order.
- The list total can differ from the sum of lines by $0.01 (site rounding).

---

## B. TEMP-WORLD-SITE-GAP (delete when the site is fixed)

**What it does.** Every ghost cycle (~30 min) it searches Gmail for World
invoices that carry a **conf number**, parses the PDF with the existing World
parser, and — only if no order with that conf number already exists — creates
one from the invoice.

- Order `reference` = the **conf number** (e.g. `PO2057`), not the invoice
  number. If the site later lists that order, the scraper sees the reference is
  taken and skips it → **no duplicate**.
- `source_invoice`/`sage_reference` = the invoice number, so the regular invoice
  check (which skips orders that already have `source_invoice`) leaves it alone.
- Skipped when: an order with that reference exists; the invoice number is
  already on an active order, the archive, or a month manifest
  (`collectKnownInvoiceNumbers`); the invoice's own arithmetic self-audit fails
  (those must be entered by hand); it is a credit.
- Created orders carry `worldPoCreated: true` (gives the card a **Delete Order**
  button — use it if the purchase was already entered into Sage by hand) and
  `worldGapCreated: true` + `worldGapCreatedAt`. Search for `worldGapCreated` to
  count how often the site has dropped an order.
- Created orders then flow through the normal ghost Sage queue, like the existing
  World PO flow. **A purchase already entered by hand would be doubled** — delete
  that order before ghost queues it, or use Delete Order.
- No new settings: sender/subject reuse the World PO invoice settings
  (`WORLD_PO_INVOICE_SENDER` → `WORLD_INVOICE_SENDER` → `reports@groupe-monaco.ca`;
  subject `Invoice for 20605`).
- Own cache file in the shared gmail folder: `world_conf_gap_invoice_cache.json`.
- Manual button: **World Gap Inv.** in the Order Fetcher row.

**Nothing existing was removed or rewritten for this.** It is purely additive;
every touch point in a shared file is tagged `TEMP-WORLD-SITE-GAP`.

### Where every piece lives

Find all of it with: `grep -rn "TEMP-WORLD-SITE-GAP" --include=*.js --include=*.jsx .`
(exclude `node_modules`). Then:

| File | What to remove |
|---|---|
| `src/scrapers/worldConfGapInvoice.js` | **Delete the whole file** |
| `main.js` | the `require('./src/scrapers/worldConfGapInvoice')` line + its comment; `getWorldConfGapInvoiceCachePath()` function; `fetchWorldConfGapInvoicesScraper:` and `getWorldConfGapInvoiceCachePath,` in the service deps; `fetchWorldConfGapInvoices: fetchWorldConfGapInvoicesService` in the destructure (~1927) and in the IPC deps (~2576) |
| `main/services/vendorOrders.service.js` | `fetchWorldConfGapInvoicesScraper`, `getWorldConfGapInvoiceCachePath` in the deps list; the `BEGIN … END` `fetchWorldConfGapInvoices` function; its entry in the returned object |
| `main/ipc/vendor.ipc.js` | the dep name and the `vendor:fetch-world-conf-gap-invoices` handler |
| `main/ipc/ipc.registry.js` | the `fetchWorldConfGapInvoices: deps.…` line |
| `preload.js` | the `fetchWorldConfGapInvoices` line |
| `renderer/src/App.jsx` | `worldGapFetching/Status/Error` state; `case "world-gap"` in `clearOrderFetchMessage`; the `BEGIN … END` `handleFetchWorldConfGapInvoices`; in the `fetch-invoices` job: the `worldGapSummary` line and its entry in the summary array; `worldGap: true` in the ghost cycle payload; the four `worldGap…` props passed to `OrderManagementView` |
| `renderer/src/views/OrderManagementView.jsx` | the four `worldGap…`/`onFetchWorldGapInvoices` props and the `world-gap` button entry |

Optional cleanup afterwards: delete `world_conf_gap_invoice_cache.json` from the
shared `gmail` folder. Orders already created keep `worldGapCreated`; that flag
is inert and harmless.

### How to tell the site is fixed

For a few days, the manual **World Gap Inv.** status (and ghost's "world gap:"
note) should say "every one already has an order". If it keeps creating orders,
the site is still dropping them. Once the scraper picks up every ordered
invoice by itself, remove B. The site may also backfill PO2057/PO2074 — that is
safe, the existing reference is skipped.

---

## Nothing was deleted

The user asked for the old World scraper to be kept, and B removes nothing.
Retained, unwired: `worldScraper.js`, `world.actions.js`. Still in use and
unchanged: `worldInvoice*.js`, `worldCreditInvoice*.js`,
`worldStandaloneInvoice.js` (B imports two helpers from it).
