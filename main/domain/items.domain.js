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

  function makeOutstandingFromLine(order, line) {
    const nowIso = new Date().toISOString();
    const itemcode = `${line?.partLineCode || ''} ${line?.partNumber || ''}`.trim() || (line?.partNumber || line?.partLineCode || 'ITEM');
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
      notes1: line?.partDescription || '',
      notes2: '',
      source_inv: inv || order?.source || 'world',
      warehouse: order?.warehouse || order?.seller || '',
      last_moved_at: nowIso,
      rev: 1,
      quantity: qty,
      reference_num: order?.reference || '',
      sold_date: '',
      sold_status: '',
    };
  }

  function splitItemsByQueue(items) {
    const buckets = {
      OUTSTANDING: [],
      SAGE_AR: [],
      CASH_SALE: [],
    };
    (items || []).forEach((it) => {
      const queue = it?.accountingPath || 'OUTSTANDING';
      if (queue === 'SAGE_AR') buckets.SAGE_AR.push(it);
      else if (queue === 'CASH_SALE') buckets.CASH_SALE.push(it);
      else buckets.OUTSTANDING.push(it);
    });
    return buckets;
  }

  function cleanExpiredLocks(items) {
    const now = Date.now();
    let changed = false;
    const cleaned = items.map((it) => {
      if (it.lock_expires_at && it.lock_expires_at < now) {
        const { lock_expires_at, ...rest } = it;
        changed = true;
        return rest;
      }
      return it;
    });
    return { items: cleaned, changed };
  }

  return {
    toMoneyString,
    computeAllocatedFor,
    toDDMMYYYY,
    makeOutstandingFromLine,
    splitItemsByQueue,
    cleanExpiredLocks,
  };
};

module.exports = { createItemsDomain };
