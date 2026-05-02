import React, { useMemo, useRef } from "react";
import Card from "../components/Card";
import BubbleColumn from "../components/BubbleColumn";

export default function StockFlowView({
  newBubbleName,
  setNewBubbleName,
  handleFieldFocus,
  handleFieldBlur,
  addBubble,
  showCreateBubble = true,
  bubbles,
  bubblePositions,
  bubbleSizes,
  bubbleZOrder,
  extraLinesByBubble,
  activeBubbleKey,
  workspaceRef,
  printBubble,
  itemsByBubble,
  expanded,
  toggleExpand,
  onDragStartItem,
  onDropOnBubble,
  onUpdateItem,
  onUpdateBubbleNotes,
  onBubbleNotesBlur,
  onRequestPrint,
  onEditItem,
  onSplitItem,
  onConsolidateItems,
  onDeleteBubble,
  deleteTargets,
  defaultBubbleNames,
  onStartBubbleMove,
  onStartBubbleResize,
  onActivateBubble,
  onMoveBubbleToSage,
  onMoveBubbleToCashSales,
  archivableBubbleIds,
  onArchiveBubble,
  showCashSalesMetrics = false,
  payments = [],
  paymentsLoading = false,
  paymentsError = "",
  bubblePaymentAssignments = {},
  onUpdateBubblePayments,
}) {
  const createBubbleRef = useRef(null);
  const workspaceSize = useMemo(() => {
    let maxX = 0;
    let maxY = 0;
    bubbles.forEach((b, index) => {
      const key = b.name || b.id;
      const pos = bubblePositions[key] || { x: 0, y: index * 340 };
      const width = bubbleSizes[key] || 360;
      maxX = Math.max(maxX, pos.x + width);
      maxY = Math.max(maxY, pos.y + 720);
    });
    const viewportWidth = typeof window !== "undefined" ? window.innerWidth : 0;
    const viewportHeight = typeof window !== "undefined" ? window.innerHeight : 0;
    return {
      minWidth: Math.max(viewportWidth, maxX + 240),
      minHeight: Math.max(viewportHeight, maxY + 240),
    };
  }, [bubbles, bubblePositions, bubbleSizes]);

  return (
    <>
      {showCreateBubble && (
        <section className="inline-block" ref={createBubbleRef}>
          <Card className="inline-block">
            <div className="flex flex-col gap-2 md:flex-row md:items-center md:gap-3">
              <div className="flex flex-col gap-2">
                <div className="text-slate-700">Create a new bubble</div>
                <div className="flex items-center gap-2 flex-wrap">
                  <input
                    className="w-52 max-w-full border rounded-xl px-3 py-2 text-sm"
                    placeholder="e.g., Waiting on Customer"
                    value={newBubbleName}
                    onChange={(e) => setNewBubbleName(e.target.value)}
                    onFocus={handleFieldFocus}
                    onBlur={handleFieldBlur}
                  />
                  <button
                    onClick={() => {
                      if (createBubbleRef.current && workspaceRef?.current) {
                        const cardRect = createBubbleRef.current.getBoundingClientRect();
                        const workspaceRect = workspaceRef.current.getBoundingClientRect();
                        const x = Math.max(0, cardRect.right - workspaceRect.left + 8);
                        const y = Math.max(0, cardRect.bottom - workspaceRect.top + 8);
                        addBubble({ x, y });
                      } else {
                        addBubble();
                      }
                    }}
                    className="px-4 py-2 rounded-xl bg-emerald-600 text-white shadow hover:bg-emerald-700 whitespace-nowrap"
                  >
                    Add Bubble
                  </button>
                </div>
              </div>
            </div>
          </Card>
        </section>
      )}

      <section>
        <div
          ref={workspaceRef}
          className={`relative transition-opacity ${printBubble ? "pointer-events-none opacity-30" : ""}`}
          style={{
            minWidth: workspaceSize.minWidth,
            minHeight: workspaceSize.minHeight,
            paddingBottom: "6rem",
          }}
        >
          {bubbles.map((b, index) => {
            const bubbleKey = b.name || b.id;
            const pos = bubblePositions[bubbleKey] || { x: 0, y: index * 340 };
            const width = bubbleSizes[bubbleKey] || 360;
            const isActive = activeBubbleKey === bubbleKey;
            const zIndexBase = 200;
            const orderIndex = bubbleZOrder?.indexOf(bubbleKey);
            const zIndex =
              orderIndex !== undefined && orderIndex >= 0
                ? zIndexBase + orderIndex
                : zIndexBase + index;
            const canArchive = !!archivableBubbleIds?.has(b.id);
            return (
              <div
                key={b.id}
                className="absolute"
                style={{
                  left: `${pos.x}px`,
                  top: `${pos.y}px`,
                  width: `${width}px`,
                  zIndex,
                }}
              >
                <BubbleColumn
                  bubble={b}
                  items={itemsByBubble.get(b.name) || []}
                  bubbles={bubbles}
                  expanded={expanded}
                  onToggleExpand={toggleExpand}
                  onDragStartItem={onDragStartItem}
                  onDropOnBubble={onDropOnBubble}
                  onUpdateItem={onUpdateItem}
                  onUpdateBubbleNotes={onUpdateBubbleNotes}
                  onBubbleNotesBlur={onBubbleNotesBlur}
                  extraLines={extraLinesByBubble?.[b.id] || []}
                  onFieldFocus={handleFieldFocus}
                  onFieldBlur={handleFieldBlur}
                  showPrintAction={!defaultBubbleNames.has(b.name)}
                  onRequestPrint={onRequestPrint}
                  onEditItem={onEditItem}
                  onSplitItem={onSplitItem}
                  onConsolidateItems={onConsolidateItems}
                  onDeleteBubble={onDeleteBubble}
                  deleteTargets={deleteTargets}
                  isDefaultBubble={defaultBubbleNames.has(b.name)}
                  onStartBubbleMove={onStartBubbleMove}
                  onStartBubbleResize={onStartBubbleResize}
                  onActivateBubble={() => onActivateBubble(bubbleKey)}
                  widthPixels={width}
                  onMoveToSage={onMoveBubbleToSage}
                  onMoveToCashSales={onMoveBubbleToCashSales}
                  canArchive={canArchive}
                  onArchiveBubble={onArchiveBubble}
                  showCashSalesMetrics={showCashSalesMetrics}
                  payments={payments}
                  paymentsLoading={paymentsLoading}
                  paymentsError={paymentsError}
                  assignedPaymentIds={bubblePaymentAssignments[b.id] || []}
                  onUpdateAssignedPayments={onUpdateBubblePayments}
                />
              </div>
            );
          })}
        </div>
      </section>
    </>
  );
}
