/**
 * The inventory module's only public door (BUILD_BIBLE §3.3).
 *
 * Nothing outside this module imports ledger.ts, operations.ts, historical.ts or
 * reconcile.ts directly.
 */
export {
  postMovement,
  reverseMovement,
  postMovementIn,
  inventoryPolicy,
  COST_METHODS,
  InsufficientStockError,
  StockMovementConflictError,
  LocationCannotHoldStockError,
  type CostMethod,
  type PostMovementInput,
  type PostedMovement,
} from "./ledger";

export {
  reconcileStockBalances,
  itemStock,
  type BalanceDrift,
  type ReconcileResult,
} from "./reconcile";

export {
  postGoodsReceiptToStock,
  postConsumptionToStock,
  reserveStock,
  releaseReservation,
  dispatchTransfer,
  postStockCount,
  sendSupplierReturn,
  NotStockableError,
  type ReceiptPostResult,
} from "./operations";

export {
  planAllocation,
  allocateAndIssueIn,
  type AllocationLeg,
  type AllocateInput,
} from "./allocate";

export {
  previewHistoricalStock,
  type HistoricalPreview,
  type HistoricalPosition,
  type UnreconcilableRecord,
} from "./historical";
