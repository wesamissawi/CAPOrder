import React, { useMemo, useRef, useState } from "react";
import Card from "../components/Card";
import BubbleColumn from "../components/BubbleColumn";

// Stable empty references so bubbles with no items/payments don't get a fresh
// array identity on every render (which would defeat MemoBubble's memoization).
const EMPTY_ARRAY = [];

// The "create a new bubble" box owns its own input state so typing the name
// re-renders only this small card — not StockFlowView and its bubble workspace.
function CreateBubbleCard({ addBubble, handleFieldFocus, handleFieldBlur, workspaceRef }) {
  const createBubbleRef = useRef(null);
  const [newBubbleName, setNewBubbleName] = useState("");

  const submit = () => {
    let position;
    if (createBubbleRef.current && workspaceRef?.current) {
      const cardRect = createBubbleRef.current.getBoundingClientRect();
      const workspaceRect = workspaceRef.current.getBoundingClientRect();
      position = {
        x: Math.max(0, cardRect.right - workspaceRect.left + 8),
        y: Math.max(0, cardRect.bottom - workspaceRect.top + 8),
      };
    }
    addBubble(position, newBubbleName);
    setNewBubbleName("");
  };

  return (
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
                onClick={submit}
                className="px-4 py-2 rounded-xl bg-emerald-600 text-white shadow hover:bg-emerald-700 whitespace-nowrap"
              >
                Add Bubble
              </button>
            </div>
          </div>
        </div>
      </Card>
    </section>
  );
}

const STALE_MS = 10000;

// One bubble's positioned column, memoized. As long as its props keep a stable
// identity (see the stable-handler bundle below + primitive layout props), an
// unrelated App re-render — heartbeat, payment poll, typing in the "create
// bubble" box — skips re-rendering every other bubble.
const MemoBubble = React.memo(function MemoBubble({
  bubble,
  bubbleKey,
  x,
  y,
  width,
  zIndex,
  items,
  bubbles,
  expanded,
  extraLines,
  canArchive,
  canDeleteBubbleItems,
  isDefaultBubble,
  showPrintAction,
  // lock primitives
  bubbleLock,
  isEditingBubble,
  isPendingRequest,
  // config
  deleteTargets,
  showCashSalesMetrics,
  showSageSalesAction,
  defaultSageCustomerCode,
  payments,
  paymentsLoading,
  paymentsError,
  assignedPaymentIds,
  // stable handlers
  h,
}) {
  const now = Date.now();
  const lockIsStale = bubbleLock && now - (bubbleLock.lastActive || 0) > STALE_MS;
  const lockOwnerDisplay =
    bubbleLock && !lockIsStale && !isEditingBubble ? bubbleLock.owner : null;
  const incomingReq =
    isEditingBubble && bubbleLock?.request?.status === "pending"
      ? bubbleLock.request
      : null;
  const outgoingReq = isPendingRequest ? { startedAt: now } : null;

  return (
    <div
      className="absolute"
      style={{ left: `${x}px`, top: `${y}px`, width: `${width}px`, zIndex }}
    >
      <BubbleColumn
        bubble={bubble}
        items={items}
        bubbles={bubbles}
        expanded={expanded}
        onToggleExpand={h.toggleExpand}
        onDragStartItem={h.onDragStartItem}
        onDropOnBubble={h.onDropOnBubble}
        onUpdateItem={h.onUpdateItem}
        onUpdateBubbleNotes={h.onUpdateBubbleNotes}
        onBubbleNotesBlur={h.onBubbleNotesBlur}
        extraLines={extraLines}
        onFieldFocus={h.onFieldFocus}
        onFieldBlur={h.onFieldBlur}
        showPrintAction={showPrintAction}
        onRequestPrint={h.onRequestPrint}
        onEditItem={h.onEditItem}
        onSplitItem={h.onSplitItem}
        onConsolidateItems={h.onConsolidateItems}
        onDeleteBubble={h.onDeleteBubble}
        deleteTargets={deleteTargets}
        isDefaultBubble={isDefaultBubble}
        onStartBubbleMove={h.onStartBubbleMove}
        onStartBubbleResize={h.onStartBubbleResize}
        onActivateBubble={() => h.onActivateBubble(bubbleKey)}
        widthPixels={width}
        onMoveToSage={h.onMoveToSage}
        onMoveToCashSales={h.onMoveToCashSales}
        canArchive={canArchive}
        onArchiveBubble={h.onArchiveBubble}
        onDeleteBubbleItems={
          canDeleteBubbleItems ? () => h.onDeleteBubbleItems(bubble.id) : undefined
        }
        onRenameBubble={h.onRenameBubble}
        isEditing={isEditingBubble}
        lockOwner={lockOwnerDisplay}
        incomingRequest={incomingReq}
        outgoingRequest={outgoingReq}
        onRequestEdit={
          h.onRequestBubbleEdit
            ? () => h.onRequestBubbleEdit(bubble.id, bubble.name)
            : undefined
        }
        onDoneEditing={
          h.onDoneBubbleEdit ? () => h.onDoneBubbleEdit(bubble.id) : undefined
        }
        onRespondToRequest={
          h.onRespondToBubbleRequest
            ? (allow) => h.onRespondToBubbleRequest(bubble.id, allow)
            : undefined
        }
        showCashSalesMetrics={showCashSalesMetrics}
        payments={payments}
        paymentsLoading={paymentsLoading}
        paymentsError={paymentsError}
        assignedPaymentIds={assignedPaymentIds}
        onUpdateAssignedPayments={h.onUpdateBubblePayments}
        onDeletePayment={
          h.onDeletePayment
            ? (paymentId) => h.onDeletePayment(paymentId, bubble.id)
            : undefined
        }
        showSageSalesAction={showSageSalesAction}
        defaultSageCustomerCode={defaultSageCustomerCode}
        onSageSalesInvoice={h.onSageSalesInvoice}
      />
    </div>
  );
});

export default function StockFlowView({
  handleFieldFocus,
  handleFieldBlur,
  addBubble,
  showCreateBubble = true,
  bubbles,
  bubblePositions,
  bubbleSizes,
  bubbleZOrder,
  extraLinesByBubble,
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
  onDeleteBubbleItems,
  onRenameBubble,
  // bubble edit lock props
  bubbleLocks = {},
  myEditingBubbleIds,
  pendingRequestBubbles,
  onRequestBubbleEdit,
  onDoneBubbleEdit,
  onRespondToBubbleRequest,
  showCashSalesMetrics = false,
  payments = [],
  paymentsLoading = false,
  paymentsError = "",
  bubblePaymentAssignments = {},
  onUpdateBubblePayments,
  onDeletePayment,
  showSageSalesAction = false,
  defaultSageCustomerCode = "",
  onSageSalesInvoice,
}) {
  // Stable-identity handler bundle. Every call routes through a ref that always
  // holds the latest implementation, so the exposed functions never change
  // identity across renders — the key to MemoBubble actually skipping work.
  // (onDeleteBubbleItems is view-dependent/undefined, so it's threaded as the
  //  boolean `canDeleteBubbleItems` and rebuilt inside MemoBubble.)
  const impls = {
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
    onStartBubbleMove,
    onStartBubbleResize,
    onActivateBubble,
    onMoveToSage: onMoveBubbleToSage,
    onMoveToCashSales: onMoveBubbleToCashSales,
    onArchiveBubble,
    onDeleteBubbleItems,
    onRenameBubble,
    onRequestBubbleEdit,
    onDoneBubbleEdit,
    onRespondToBubbleRequest,
    onUpdateBubblePayments,
    onDeletePayment,
    onSageSalesInvoice,
    onFieldFocus: handleFieldFocus,
    onFieldBlur: handleFieldBlur,
  };
  const implsRef = useRef(impls);
  implsRef.current = impls;
  const h = useMemo(() => {
    const out = {};
    Object.keys(implsRef.current).forEach((key) => {
      out[key] = (...args) => implsRef.current[key]?.(...args);
    });
    return out;
  }, []);
  // Whether the per-bubble delete-items action should exist at all (mirrors the
  // undefined-ness of the incoming handler, which MemoBubble can't infer from a
  // stable wrapper).
  const canDeleteBubbleItems = !!onDeleteBubbleItems;

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
        <CreateBubbleCard
          addBubble={addBubble}
          handleFieldFocus={handleFieldFocus}
          handleFieldBlur={handleFieldBlur}
          workspaceRef={workspaceRef}
        />
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
            const orderIndex = bubbleZOrder?.indexOf(bubbleKey);
            const zIndexBase = 200;
            const zIndex =
              orderIndex !== undefined && orderIndex >= 0
                ? zIndexBase + orderIndex
                : zIndexBase + index;
            return (
              <MemoBubble
                key={b.id}
                bubble={b}
                bubbleKey={bubbleKey}
                x={pos.x}
                y={pos.y}
                width={width}
                zIndex={zIndex}
                items={itemsByBubble.get(b.name) || EMPTY_ARRAY}
                bubbles={bubbles}
                expanded={expanded}
                extraLines={extraLinesByBubble?.[b.id] || EMPTY_ARRAY}
                canArchive={!!archivableBubbleIds?.has(b.id)}
                canDeleteBubbleItems={canDeleteBubbleItems}
                isDefaultBubble={defaultBubbleNames.has(b.name)}
                showPrintAction={!defaultBubbleNames.has(b.name)}
                bubbleLock={bubbleLocks?.[b.id]}
                isEditingBubble={myEditingBubbleIds?.has(b.id) ?? false}
                isPendingRequest={pendingRequestBubbles?.has(b.id) ?? false}
                deleteTargets={deleteTargets}
                showCashSalesMetrics={showCashSalesMetrics}
                showSageSalesAction={showSageSalesAction}
                defaultSageCustomerCode={defaultSageCustomerCode}
                payments={payments}
                paymentsLoading={paymentsLoading}
                paymentsError={paymentsError}
                assignedPaymentIds={bubblePaymentAssignments[b.id] || EMPTY_ARRAY}
                h={h}
              />
            );
          })}
        </div>
      </section>
    </>
  );
}
