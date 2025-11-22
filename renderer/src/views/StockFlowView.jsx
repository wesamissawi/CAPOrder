import React from "react";
import Card from "../components/Card";
import BubbleColumn from "../components/BubbleColumn";

export default function StockFlowView({
  newBubbleName,
  setNewBubbleName,
  handleFieldFocus,
  handleFieldBlur,
  addBubble,
  bubbles,
  bubblePositions,
  bubbleSizes,
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
}) {
  return (
    <>
      <section>
        <Card>
          <div className="flex flex-col lg:flex-row gap-3 lg:items-center">
            <div className="flex-1">
              <div className="text-slate-700">Create a new bubble</div>
              <div className="mt-2 flex items-center gap-2">
                <input
                  className="flex-1 border rounded-xl p-2"
                  placeholder="e.g., Waiting on Customer"
                  value={newBubbleName}
                  onChange={(e) => setNewBubbleName(e.target.value)}
                  onFocus={handleFieldFocus}
                  onBlur={handleFieldBlur}
                />
                <button
                  onClick={addBubble}
                  className="px-4 py-2 rounded-xl bg-emerald-600 text-white shadow hover:bg-emerald-700"
                >
                  Add Bubble
                </button>
              </div>
              <p className="mt-2 text-xs text-slate-500">
                If a bubble name already exists, a numeric suffix (e.g., “2”) will be added automatically.
              </p>
            </div>
            <div className="text-sm text-slate-600">
              <div>Tip: Drag an item card into a bubble to reassign it.</div>
            </div>
          </div>
        </Card>
      </section>

      <section>
        <div
          ref={workspaceRef}
          className={`relative min-h-[600px] transition-opacity ${printBubble ? "pointer-events-none opacity-30" : ""}`}
        >
          {bubbles.map((b, index) => {
            const bubbleKey = b.name || b.id;
            const pos = bubblePositions[bubbleKey] || { x: 0, y: index * 340 };
            const width = bubbleSizes[bubbleKey] || 360;
            const isActive = activeBubbleKey === bubbleKey;
            return (
              <div
                key={b.id}
                className="absolute"
                style={{
                  left: `${pos.x}px`,
                  top: `${pos.y}px`,
                  width: `${width}px`,
                  zIndex: isActive ? 1000 : 100 + index,
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
                />
              </div>
            );
          })}
        </div>
      </section>
    </>
  );
}
