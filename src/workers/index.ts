/**
 * Worker registry — /api/inngest serves exactly this list. New functions are
 * added here (and only here) so the serve route never drifts from the fleet.
 */
export { imageDerivatives, deriveImageVariants } from "./functions/image-derivatives";
export { storageReconcile, reconcileOrg, reconcileAllOrgs } from "./functions/storage-reconcile";
export { verifyOrgPayload, OrgVerificationError } from "./harness";

import { imageDerivatives } from "./functions/image-derivatives";
import { storageReconcile } from "./functions/storage-reconcile";

export const workerFunctions = [imageDerivatives, storageReconcile];
