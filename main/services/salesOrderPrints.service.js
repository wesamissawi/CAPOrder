// Frozen copies of Sales Orders as they were actually printed.
//
// The bubble itself keeps changing after a print — parts get repriced, added,
// or moved out, and archiving stores whatever was left at archive time. None of
// that answers "what did the customer's copy say?", which is the question a
// pricing dispute actually turns on. `printedSignature` on the bubble only
// detects that something changed; it can't reconstruct the page.
//
// So every print appends one immutable row here. A reprint after edits appends
// a NEW row rather than overwriting, so both what the customer originally got
// and what it became stay on the record.
//
// JSONL for the same reason item_history.jsonl is: appends are cheap and a torn
// concurrent write over the shared drive costs one line, not the whole file.
// Deliberately NOT trimmed — this is the record you'd want years later, and at
// roughly a kilobyte per print it costs about a megabyte a year. It also isn't
// one of the watched queue files, so appending never triggers an items:updated
// push.
const createSalesOrderPrintsService = (deps) => {
  const { getQueueFile, fs, path, randomUUID } = deps;

  function getPrintsFile() {
    return path.join(path.dirname(getQueueFile('OUTSTANDING')), 'sales_order_prints.jsonl');
  }

  function readPrintSnapshots() {
    try {
      const file = getPrintsFile();
      if (!fs.existsSync(file)) return [];
      const raw = fs.readFileSync(file, 'utf-8');
      const out = [];
      for (const line of raw.split(/\r?\n/)) {
        const s = line.trim();
        if (!s) continue;
        try { out.push(JSON.parse(s)); } catch { /* skip a torn/garbled line */ }
      }
      return out;
    } catch (e) {
      console.warn('[sales-order-prints] read failed', e?.message || e);
      return [];
    }
  }

  const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
  const num = (v) => {
    const n = Number(String(v ?? '').replace(/[^0-9.\-]/g, ''));
    return Number.isFinite(n) ? n : 0;
  };

  // Only the fields the printed page actually showed, flattened away from the
  // live item shape. `price` is allocated_for — the pre-discount sell price the
  // invoice prints — kept under its own name so a later edit to the item can
  // never be mistaken for what was on the paper.
  function normalizeItem(it) {
    return {
      uid: str(it?.uid),
      itemcode: str(it?.itemcode),
      description: str(it?.notes1 || it?.description),
      notes2: str(it?.notes2),
      quantity: num(it?.quantity),
      price: num(it?.allocated_for),
      // Carried for margin lookups only — never printed on the customer copy.
      cost: str(it?.cost),
      discounted_price: str(it?.discounted_price),
      reference_num: str(it?.reference_num),
      warehouse: str(it?.warehouse),
    };
  }

  function normalizeExtraLine(line, index) {
    return {
      id: str(line?.id) || `extra-${index}`,
      partLineCode: str(line?.partLineCode),
      description: str(line?.description),
      quantity: num(line?.quantity),
      unitPrice: num(line?.unitPrice),
      taxable: line?.taxable !== false,
    };
  }

  // Recomputed here rather than trusted from the renderer so the stored totals
  // are guaranteed to follow from the stored lines — a snapshot whose total
  // disagreed with its own rows would be worse than no snapshot.
  function computeTotals(items, extraLines, taxRate) {
    let subtotal = 0;
    let taxableBase = 0;
    items.forEach((it) => {
      const ext = it.quantity * it.price;
      subtotal += ext;
      taxableBase += ext; // parts are always taxable
    });
    extraLines.forEach((l) => {
      const ext = l.quantity * l.unitPrice;
      subtotal += ext;
      if (l.taxable) taxableBase += ext;
    });
    const round = (n) => Math.round(n * 100) / 100;
    const tax = round(taxableBase * (Number(taxRate) || 0));
    return {
      subtotal: round(subtotal),
      taxableBase: round(taxableBase),
      tax,
      total: round(round(subtotal) + tax),
    };
  }

  // Non-fatal by design: a snapshot failure must never stop the print or lose
  // the Sales Order number that was already drawn. The paper going out matters
  // more than the record of it.
  function appendPrintSnapshot(payload) {
    try {
      // Quotes are the same record with nothing ordered yet: no number drawn,
      // no parts marked sold. They're kept here anyway because "what did I
      // quote them?" is the same kind of question as "what did the invoice
      // say?", and it gets asked weeks before the sales order exists.
      const kind = str(payload?.kind) === 'QUOTE' ? 'QUOTE' : 'SALES_ORDER';
      const salesOrderNumber = str(payload?.salesOrderNumber);
      if (kind === 'SALES_ORDER' && !salesOrderNumber) {
        return { ok: false, error: 'Missing sales order number' };
      }

      const items = (Array.isArray(payload?.items) ? payload.items : []).map(normalizeItem);
      const extraLines = (Array.isArray(payload?.extraLines) ? payload.extraLines : [])
        .map(normalizeExtraLine);

      // The header and tax rate are frozen INTO the row. They're props with
      // defaults at render time, so a future address change or HST change would
      // otherwise silently rewrite every old snapshot when replayed.
      const document = {
        title:
          str(payload?.document?.title) || (kind === 'QUOTE' ? 'Quotation' : 'Sales Order'),
        companyName: str(payload?.document?.companyName),
        companyAddress: str(payload?.document?.companyAddress),
        companyContact: str(payload?.document?.companyContact),
        taxLabel: str(payload?.document?.taxLabel) || 'HST',
        taxRate: Number(payload?.document?.taxRate) || 0,
      };

      // Reprints share the Sales Order number, so version is what tells two
      // rows apart. Counting costs a full read, but prints are rare. Quotes
      // have no number to group by, so they version per order instead — a
      // second quote for the same customer is v2 of that conversation.
      const prior = readPrintSnapshots().filter((s) => {
        const sKind = str(s?.kind) === 'QUOTE' ? 'QUOTE' : 'SALES_ORDER';
        if (sKind !== kind) return false;
        return kind === 'QUOTE'
          ? str(s?.bubbleId) === str(payload?.bubbleId)
          : str(s?.salesOrderNumber) === salesOrderNumber;
      }).length;

      const record = {
        id: randomUUID(),
        kind,
        salesOrderNumber,
        version: prior + 1,
        printedAt: str(payload?.printedAt) || new Date().toISOString(),
        bubbleId: str(payload?.bubbleId),
        bubbleName: str(payload?.bubbleName),
        notes: str(payload?.notes),
        printedSignature: str(payload?.printedSignature),
        document,
        items,
        extraLines,
        totals: computeTotals(items, extraLines, document.taxRate),
        // Tax-in dollars taken off to close the sale. Stored on quotes only —
        // the sales order carries the same concession inside its line prices,
        // so it has no separate discount to record.
        discount: kind === 'QUOTE' ? num(payload?.discount) : 0,
      };

      const file = getPrintsFile();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, JSON.stringify(record) + '\n', 'utf-8');
      return { ok: true, snapshot: record, path: file };
    } catch (e) {
      console.warn('[sales-order-prints] append failed', e?.message || e);
      return { ok: false, error: e?.message || 'Failed to record the printed sales order.' };
    }
  }

  // Lookup by any of the three things you'd actually have in hand: the number
  // off the customer's paper, the order it came from, or a part number. All
  // filters are ANDed; no filter returns everything, newest first.
  function findPrintSnapshots(query = {}) {
    const salesOrderNumber = str(query?.salesOrderNumber).trim().toLowerCase();
    const bubbleId = str(query?.bubbleId).trim();
    const bubbleName = str(query?.bubbleName).trim().toLowerCase();
    const itemcode = str(query?.itemcode).trim().toLowerCase();
    // Rows written before quotes existed carry no `kind` — they're all sales
    // orders, so the default has to be SALES_ORDER, not "unknown".
    const kind = str(query?.kind).trim().toUpperCase();

    const rows = readPrintSnapshots().filter((s) => {
      if (kind && (str(s?.kind) || 'SALES_ORDER') !== kind) return false;
      if (salesOrderNumber && str(s?.salesOrderNumber).toLowerCase() !== salesOrderNumber) return false;
      if (bubbleId && str(s?.bubbleId) !== bubbleId) return false;
      if (bubbleName && str(s?.bubbleName).toLowerCase() !== bubbleName) return false;
      if (itemcode) {
        const hit = (s?.items || []).some((it) =>
          str(it?.itemcode).toLowerCase().includes(itemcode)
        );
        if (!hit) return false;
      }
      return true;
    });

    rows.sort((a, b) => str(b?.printedAt).localeCompare(str(a?.printedAt)));
    return rows;
  }

  return {
    getPrintsFile,
    readPrintSnapshots,
    appendPrintSnapshot,
    findPrintSnapshots,
  };
};

module.exports = { createSalesOrderPrintsService };
