function searchArchiveEntries(entries, query) {
  const normalize = (val) => (val ?? '').toString().trim().toLowerCase();
  const term = normalize(query?.term || query?.q);
  const bubbleTerm = normalize(query?.bubbleName || query?.customerName);
  if (!term && !bubbleTerm) return { results: [], empty: true };

  const results = [];

  for (const entry of entries || []) {
    const bubbleName = entry?.bubble?.name || entry?.bubbleName || '';
    const customer = entry?.meta?.customer || entry?.meta?.customerName || '';
    const archivedAt = entry?.archivedAt || entry?.meta?.archivedAt || '';
    const bubbleMatches = bubbleTerm
      ? [bubbleName, customer].some((val) => normalize(val).includes(bubbleTerm))
      : true;
    if (!bubbleMatches && !term) continue;

    // Printed copies of this order, newest first. `allocated_for` on the item
    // below is the price at ARCHIVE time — if the line was repriced after the
    // customer's copy went out, the two disagree, and the printed one is the
    // one that settles an argument. Indexed by uid so each matched line can
    // carry the price its own printed row showed.
    const prints = Array.isArray(entry?.prints) ? entry.prints : [];
    const printedByUid = new Map();
    for (const snap of prints) {
      for (const line of snap?.items || []) {
        if (!line?.uid || printedByUid.has(line.uid)) continue;
        printedByUid.set(line.uid, {
          printed_price: line.price,
          printed_quantity: line.quantity,
          printed_at: snap?.printedAt || '',
          printed_sales_order: snap?.salesOrderNumber || '',
        });
      }
    }

    const items = Array.isArray(entry?.items) ? entry.items : [];
    const matchedItems = items
      .filter((it) => {
        if (!term) return true;
        const code = normalize(it?.itemcode || it?.partNumber || it?.partLineCode);
        const desc = normalize(it?.notes1 || '') + ' ' + normalize(it?.notes2 || '') + ' ' + normalize(it?.description || '');
        return code.includes(term) || desc.includes(term);
      })
      .map((it) => ({
        itemcode: it?.itemcode || it?.partNumber || '',
        description: it?.notes1 || it?.description || '',
        notes2: it?.notes2 || '',
        quantity: it?.quantity,
        allocated_for: it?.allocated_for,
        cost: it?.cost,
        reference_num: it?.reference_num,
        ...(printedByUid.get(it?.uid) || {}),
      }));

    if (!matchedItems.length) continue;
    results.push({
      bubbleId: entry?.id || entry?.bubble?.id || '',
      bubbleName: bubbleName || 'Archived Bubble',
      archivedAt,
      salesOrderNumber: entry?.meta?.salesOrderNumber || prints[0]?.salesOrderNumber || '',
      items: matchedItems,
      prints,
    });
  }

  results.sort((a, b) => String(b.archivedAt || '').localeCompare(String(a.archivedAt || '')));
  return { results };
}

module.exports = { searchArchiveEntries };
