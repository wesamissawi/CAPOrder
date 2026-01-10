function normalizeSharedBubblePayload(payload) {
  const bubbleId = payload?.bubbleId || payload?.id || payload?.name;
  const name = typeof payload?.name === 'string' ? payload.name : '';
  const notes = typeof payload?.notes === 'string' ? payload.notes : '';
  const extraLines = Array.isArray(payload?.extraLines) ? payload.extraLines : [];
  return { bubbleId, data: { id: bubbleId, name, notes, extraLines } };
}

module.exports = { normalizeSharedBubblePayload };
