/**
 * The assets module's only public door (BUILD_BIBLE §3.3).
 *
 * Nothing outside this module imports register.ts or lifecycle.ts directly.
 */
export {
  createAssetCategory,
  registerAsset,
  setAssetStatus,
  assignAsset,
  returnAsset,
  transferAsset,
  correctAssignment,
  listAssets,
  getAsset,
  AssetError,
  AssetStateError,
  CreateAssetCategoryInput,
  RegisterAssetInput,
  AssignAssetInput,
  ReturnAssetInput,
  TransferAssetInput,
  type AssetRow,
  type RegisteredAsset,
} from "./register";

export {
  recordInspection,
  createMaintenancePlan,
  recordMaintenance,
  startDowntime,
  endDowntime,
  requestDisposal,
  completeDisposal,
  resubmitDisposal,
  cancelDisposal,
  listMaintenanceDue,
  assetDowntime,
  RecordInspectionInput,
  CreateMaintenancePlanInput,
  RecordMaintenanceInput,
  StartDowntimeInput,
  RequestDisposalInput,
  CompleteDisposalInput,
} from "./lifecycle";

export {
  assetDetail,
  type AssetFullDetail,
  type AssetDetail,
  type CustodyEvent,
  type InspectionRow,
  type MaintenancePlanRow,
  type MaintenanceEventRow,
  type DowntimeRow,
  type DisposalRow,
} from "./read";
