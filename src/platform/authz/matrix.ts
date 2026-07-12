/**
 * The permission matrix as DATA (phase2/06; BUILD_BIBLE §6.2).
 * Phase C ships the identity-relevant actions; later slices extend this table —
 * the matrix-runner test iterates it and asserts deny-by-default for anything
 * not listed. Conditions (assigned_job, own_record) arrive with their entities.
 */
import type { RoleArchetype } from "@/platform/registries";

// Only actions with a live server-side enforcement point ship in the matrix
// (doc 10 #15: "each action enforced in exactly one server check"). Org-settings
// and role-management actions land with their surfaces in later slices.
//
// Phase E — file LIFECYCLE actions (void / legal-hold) are archetype-gated and
// enforced here. File UPLOAD/READ authorization is class-based and lives in
// src/platform/files/access.ts (canAccessFileClass), mirrored by the SQL
// app.can_access_file_class — kept out of this archetype matrix because
// financial_doc read is gated by the finance.viewPrices FLAG, not an archetype
// list (doc 06 D-6.2). customer_share has no member path (S5 share surface).
export type Action =
  "members.view" | "members.invite" | "members.deactivate" | "files.void" | "files.legal_hold";

type Grantable = Exclude<RoleArchetype, "worker_reserved_p3">;

export const MATRIX: Record<Action, readonly Grantable[]> = {
  "members.view": ["owner", "admin", "manager", "procurement", "accounts", "viewer"],
  "members.invite": ["owner", "admin"],
  "members.deactivate": ["owner", "admin"],
  // Photos: delete = M for O/A/M — D-1.7: delete is VOID, never a row delete
  "files.void": ["owner", "admin", "manager"],
  "files.legal_hold": ["owner", "admin"],
};
