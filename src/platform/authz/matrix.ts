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
// S1 (doc 06 rows): masters CRUD, config pipeline, walking-skeleton job/report.
export type Action =
  | "members.view"
  | "members.invite"
  | "members.deactivate"
  | "files.void"
  | "files.legal_hold"
  | "config.view"
  | "config.manage"
  | "employees.view"
  | "employees.manage"
  | "employees.terms.manage"
  | "employees.hr.manage"
  | "customers.view"
  | "customers.manage"
  | "catalog.view"
  | "catalog.manage"
  | "jobs.view"
  | "jobs.create"
  | "reports.create";

type Grantable = Exclude<RoleArchetype, "worker_reserved_p3">;

export const MATRIX: Record<Action, readonly Grantable[]> = {
  "members.view": ["owner", "admin", "manager", "procurement", "accounts", "viewer"],
  "members.invite": ["owner", "admin"],
  "members.deactivate": ["owner", "admin"],
  // Photos: delete = M for O/A/M — D-1.7: delete is VOID, never a row delete
  "files.void": ["owner", "admin", "manager"],
  "files.legal_hold": ["owner", "admin"],
  // "Settings, roles, entitlements, config revisions" — Owner/Admin ONLY (doc 06).
  "config.view": ["owner", "admin"],
  "config.manage": ["owner", "admin"],
  // "Employees: manage / HR docs✱" (doc 06 literal): O/A/M manage, Accounts V,
  // everyone else −. Salary/HR walls are the SIDE tables on top of this.
  "employees.view": ["owner", "admin", "manager", "accounts"],
  "employees.manage": ["owner", "admin", "manager"],
  // Terms (salary) writes ride the cost wall: O/A (+Accounts holds the flag but
  // people admin stays O/A per the doc-06 ✱ column); DB backstop = cost GUC.
  "employees.terms.manage": ["owner", "admin"],
  "employees.hr.manage": ["owner", "admin"],
  // "Customers: manage" (doc 06 literal): O/A/M manage, Accounts V, others −.
  "customers.view": ["owner", "admin", "manager", "accounts"],
  "customers.manage": ["owner", "admin", "manager"],
  // "Suppliers, item catalog" (doc 06 literal): O/A/M/Procurement manage, Accounts V.
  "catalog.view": ["owner", "admin", "manager", "procurement", "accounts"],
  "catalog.manage": ["owner", "admin", "manager", "procurement"],
  // "Jobs: create/edit core" = O/A/M; view = every archetype (redacted/assigned
  // narrowing is serializer/S2 scope — doc 06).
  "jobs.view": ["owner", "admin", "manager", "foreman", "procurement", "accounts", "viewer"],
  "jobs.create": ["owner", "admin", "manager"],
  // "Daily reports: create/edit own draft" = C for O/A/M + Foreman(assigned, own).
  "reports.create": ["owner", "admin", "manager", "foreman"],
};
