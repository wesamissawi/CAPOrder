const { resolveCapCode } = require('../../src/scrapers/capRules');

const createItemsDomain = (deps) => {
  const { randomUUID } = deps;

  function toMoneyString(val) {
    if (val === null || val === undefined || val === '') return '';
    const normalized = String(val).replace(/[^\d.-]/g, '').trim();
    if (!normalized) return '';
    const num = Number(normalized);
    if (Number.isFinite(num)) return num.toFixed(2);
    return normalized;
  }

  function computeAllocatedFor(val) {
    const normalized = String(val ?? '').replace(/[^\d.-]/g, '').trim();
    const num = Number(normalized);
    if (!Number.isFinite(num)) return '';
    let out = num;
    if (num > 300) out = num + 100;
    else if (num > 200) out = num + 70;
    else if (num > 100) out = num + 50;
    else if (num > 70) out = num + 40;
    else if (num > 50) out = num + 30;
    else if (num > 30) out = num + 20;
    else if (num > 10) out = num * 1.3;
    else if (num > 5) out = num + 5;
    else out = num * 2;
    return out.toFixed(2);
  }

  function toDDMMYYYY(order) {
    // Prefer ISO orderDate
    if (order?.orderDate) {
      const d = new Date(order.orderDate);
      if (!Number.isNaN(d.getTime())) {
        const dd = String(d.getDate()).padStart(2, '0');
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const yyyy = d.getFullYear();
        return `${dd}${mm}${yyyy}`;
      }
    }
    // Fallback: sageDate (DDMMYY)
    const s = String(order?.sageDate || '').trim();
    if (s.length === 6) {
      return `${s.slice(0, 2)}${s.slice(2, 4)}20${s.slice(4, 6)}`;
    }
    return '';
  }

  // lineIdx is the item's position in order.lineItems. It's stamped onto the
  // item (with order_key) so the Order Assignment view can link a stock row back
  // to the exact line it came from. Order lines have no id of their own, so
  // without this the only linkage is a reference_num + itemcode guess — see
  // main/domain/orderAssignment.domain.js. Callers that genuinely have no index
  // may omit it; those items just fall back to the guess.
  function makeOutstandingFromLine(order, line, lineIdx) {
    const nowIso = new Date().toISOString();
    // Resolve the CAP/Sage code ONCE, here, when the scraped line becomes a
    // stock item — so the bubble stores the exact code Sage will hold after the
    // purchase (which applies the same ourRules). Falls back to the raw
    // "<line> <part>" if the rules produce nothing. See src/scrapers/capRules.js.
    const rawItemcode = `${line?.partLineCode || ''} ${line?.partNumber || ''}`.trim() || (line?.partNumber || line?.partLineCode || 'ITEM');
    const warehouseForRules = order?.warehouse || order?.seller || order?.source || '';
    const resolved = resolveCapCode(warehouseForRules, line?.partLineCode, line?.partNumber, line?.partDescription);
    const itemcode = (resolved.code || '').trim() || rawItemcode;
    const resolvedDescription = resolved.description || line?.partDescription || '';
    const costVal = line?.costPriceValue ?? line?.costPrice ?? line?.extendedValue ?? line?.extended;
    const qty = Number(line?.quantity ?? 1) || 1;
    const inv = (order?.source_invoice || order?.invoiceNum || '').trim();
    return {
      uid: randomUUID(),
      accountingPath: 'OUTSTANDING',
      allocated_for: computeAllocatedFor(costVal),
      allocated_to: 'New Stock',
      cost: toMoneyString(costVal),
      date: toDDMMYYYY(order),
      invoice_num: '',
      'invoiced date': '',
      'invoiced status': '',
      itemcode,
      notes1: resolvedDescription,
      notes2: '',
      source_inv: inv || order?.source || 'world',
      warehouse: order?.warehouse || order?.seller || '',
      last_moved_at: nowIso,
      quantity: qty,
      reference_num: order?.reference || '',
      sold_date: '',
      sold_status: '',
      // Exact back-link to the originating order line (Order Assignment).
      order_key: String(order?.sage_reference || order?.reference || order?.__row || '').trim().toUpperCase(),
      order_line_idx: Number.isInteger(lineIdx) ? lineIdx : null,
    };
  }

  // splitItemsByQueue used to live here, fanning a merged list back out into the
  // three queue files. accountingPath is a plain field on the record now and the
  // split is a projection concern — see main/crdt/projections.js.

  // cleanExpiredLocks used to live here — the sweep that freed an item whose
  // 20s edit lock had lapsed. The lock is gone; see main/ipc/items.ipc.js.

  return {
    toMoneyString,
    computeAllocatedFor,
    toDDMMYYYY,
    makeOutstandingFromLine,
  };
};

module.exports = { createItemsDomain };
