/**
 * The inventory module's only public door (BUILD_BIBLE §3.3).
 *
 * Nothing outside this module imports ledger.ts or reconcile.ts directly.
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
