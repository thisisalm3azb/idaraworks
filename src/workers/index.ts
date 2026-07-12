/**
 * Worker registry — /api/inngest serves exactly this list. New functions are
 * added here (and only here) so the serve route never drifts from the fleet.
 */
export { imageDerivatives, deriveImageVariants } from "./functions/image-derivatives";
export { storageReconcile, reconcileOrg, reconcileAllOrgs } from "./functions/storage-reconcile";
export { outboxRelay, outboxRetention } from "./functions/outbox-relay";
export { demoHeartbeat } from "./functions/demo-heartbeat";
export { verifyOrgPayload, defineOrgFunction, OrgVerificationError } from "./harness";

import { imageDerivatives } from "./functions/image-derivatives";
import { storageReconcile } from "./functions/storage-reconcile";
import { outboxRelay, outboxRetention } from "./functions/outbox-relay";
import { demoHeartbeat } from "./functions/demo-heartbeat";

export const workerFunctions = [
  imageDerivatives,
  storageReconcile,
  outboxRelay,
  outboxRetention,
  demoHeartbeat,
];
