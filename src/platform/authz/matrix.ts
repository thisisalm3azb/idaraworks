/**
 * The permission matrix as DATA (phase2/06; BUILD_BIBLE §6.2).
 * Phase C ships the identity-relevant actions; later slices extend this table —
 * the matrix-runner test iterates it and asserts deny-by-default for anything
 * not listed. Conditions (assigned_job, own_record) arrive with their entities.
 */
import type { RoleArchetype } from "@/platform/registries";

export type Action =
  | "org.settings.view"
  | "org.settings.update"
  | "members.view"
  | "members.invite"
  | "members.deactivate"
  | "roles.view";

type Grantable = Exclude<RoleArchetype, "worker_reserved_p3">;

export const MATRIX: Record<Action, readonly Grantable[]> = {
  "org.settings.view": ["owner", "admin", "manager", "procurement", "accounts", "viewer"],
  "org.settings.update": ["owner", "admin"],
  "members.view": ["owner", "admin", "manager", "procurement", "accounts", "viewer"],
  "members.invite": ["owner", "admin"],
  "members.deactivate": ["owner", "admin"],
  "roles.view": ["owner", "admin", "manager", "procurement", "accounts", "viewer"],
};
