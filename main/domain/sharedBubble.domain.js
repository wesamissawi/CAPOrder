function normalizeSharedBubblePayload(payload) {
  const bubbleId = payload?.bubbleId || payload?.id || payload?.name;
  const name = typeof payload?.name === 'string' ? payload.name : '';
  const notes = typeof payload?.notes === 'string' ? payload.notes : '';
  const extraLines = Array.isArray(payload?.extraLines) ? payload.extraLines : [];
  const data = { id: bubbleId, name, notes, extraLines };
  // Which payments this bubble is settled by. The renderer has always sent
  // these and always read them back (applySharedBubbleData -> paymentIds), but
  // they were being dropped here, so assignments only ever lived in local UI
  // state and never crossed machines. Same present-only rule as below.
  if (Array.isArray(payload?.paymentIds)) data.paymentIds = payload.paymentIds.filter(Boolean);
  // Sales Order view fields — passed through only when present so a caller
  // that doesn't know about them (e.g. an older build) never clobbers what's
  // already stored.
  // When this order was first opened. Drives the Urgent/Regular/Stale banding
  // in the Sales Order view, so it has to survive across machines like any
  // other per-bubble field.
  if (typeof payload?.createdAt === 'string') data.createdAt = payload.createdAt;
  if (typeof payload?.delivered === 'boolean') data.delivered = payload.delivered;
  // Sitting on the counter waiting to be picked up — the state between "being
  // worked" and "delivered", and its own section in the Sales Order view.
  if (typeof payload?.counter === 'boolean') data.counter = payload.counter;
  if (typeof payload?.paid === 'boolean') data.paid = payload.paid;
  if (typeof payload?.printedSignature === 'string') data.printedSignature = payload.printedSignature;
  if (typeof payload?.printedAt === 'string') data.printedAt = payload.printedAt;
  // The Sales Order number printed on this bubble's paperwork. Shared so a
  // reprint from any machine repeats the number the customer already has
  // instead of drawing a second one off the counter.
  if (typeof payload?.salesOrderNumber === 'string') data.salesOrderNumber = payload.salesOrderNumber;
  // Sage sales run — the invoice number shown on the sale card, when it was
  // sent, and the run-log row an edit here has to write through to.
  if (typeof payload?.sageInvoiceNumber === 'string') data.sageInvoiceNumber = payload.sageInvoiceNumber;
  if (typeof payload?.sageSentAt === 'string') data.sageSentAt = payload.sageSentAt;
  if (typeof payload?.sageRunId === 'string') data.sageRunId = payload.sageRunId;
  return { bubbleId, data };
}

module.exports = { normalizeSharedBubblePayload };
