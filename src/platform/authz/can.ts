/**
 * The single authorization check (BUILD_BIBLE §6.2): `can(archetype, action)`.
 * Deny-by-default; UI gating mirrors, server enforces, RLS backstops.
 */
import type { RoleArchetype } from "@/platform/registries";
import { MATRIX, type Action } from "./matrix";

export class ForbiddenError extends Error {
  constructor(action: Action) {
    super(`Forbidden: ${action}`);
    this.name = "ForbiddenError";
  }
}

export function can(archetype: RoleArchetype, action: Action): boolean {
  const allowed = MATRIX[action];
  if (!allowed) return false;
  return (allowed as readonly string[]).includes(archetype);
}

/** Throwing variant for service-layer guards. */
export function assertCan(archetype: RoleArchetype, action: Action): void {
  if (!can(archetype, action)) {
    throw new ForbiddenError(action);
  }
}
