/**
 * The permission matrix (doc 06) transcribed INDEPENDENTLY of the enforcement
 * encoding (matrix.ts / MATRIX), keyed by ARCHETYPE → the actions it may perform.
 * The matrix-runner cross-checks can()/MATRIX against this table: two independent
 * transcriptions of the same spec must agree, so a typo in either is caught (doc
 * 10 #15). File UPLOAD/READ authorization is class-based (canAccessFileClass,
 * tested by storage-harness) and intentionally not in this archetype grid.
 */
import type { RoleArchetype } from "@/platform/registries";
import type { Action } from "./matrix";

type Grantable = Exclude<RoleArchetype, "worker_reserved_p3">;

export const EXPECTED_MATRIX: Record<Grantable, readonly Action[]> = {
  // Full member management + all file lifecycle actions.
  owner: ["members.view", "members.invite", "members.deactivate", "files.void", "files.legal_hold"],
  admin: ["members.view", "members.invite", "members.deactivate", "files.void", "files.legal_hold"],
  // Manager: sees members, can void (delete) photos, but not invite/deactivate or legal-hold.
  manager: ["members.view", "files.void"],
  // Field role: no member-management or file-lifecycle actions (uploads job_media
  // via the class map, which is not part of this grid).
  foreman: [],
  procurement: ["members.view"],
  accounts: ["members.view"],
  viewer: ["members.view"],
};
