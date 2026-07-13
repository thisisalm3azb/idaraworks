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
  // Full member management, file lifecycle, ALL config + masters + skeleton (doc 06 row-by-row).
  owner: [
    "members.view",
    "members.invite",
    "members.deactivate",
    "files.void",
    "files.legal_hold",
    "config.view",
    "config.manage",
    "employees.view",
    "employees.manage",
    "employees.terms.manage",
    "employees.hr.manage",
    "customers.view",
    "customers.manage",
    "catalog.view",
    "catalog.manage",
    "jobs.view",
    "jobs.create",
    "jobs.edit",
    "jobs.price.manage",
    "jobs.price.adjust",
    "jobs.progress.override",
    "stages.update",
    "stages.request_complete",
    "stages.reopen",
    "tasks.manage",
    "tasks.update_status",
    "crew.manage",
    "week.view",
    "comments.create",
    "reports.create",
    "reports.review",
    "reports.backfill",
    "issues.raise",
    "issues.resolve",
    "attendance.manage",
    "attendance.view",
  ],
  admin: [
    "members.view",
    "members.invite",
    "members.deactivate",
    "files.void",
    "files.legal_hold",
    "config.view",
    "config.manage",
    "employees.view",
    "employees.manage",
    "employees.terms.manage",
    "employees.hr.manage",
    "customers.view",
    "customers.manage",
    "catalog.view",
    "catalog.manage",
    "jobs.view",
    "jobs.create",
    "jobs.edit",
    "jobs.price.manage",
    "jobs.progress.override",
    "stages.update",
    "stages.request_complete",
    "stages.reopen",
    "tasks.manage",
    "tasks.update_status",
    "crew.manage",
    "week.view",
    "comments.create",
    "reports.create",
    "reports.review",
    "reports.backfill",
    "issues.raise",
    "issues.resolve",
    "attendance.manage",
    "attendance.view",
  ],
  // Manager (doc 08: the Workshop Manager variant): masters M, jobs/reports, NO
  // config, NO salary/HR side-tables, no invite/deactivate/legal-hold.
  manager: [
    "members.view",
    "files.void",
    "employees.view",
    "employees.manage",
    "customers.view",
    "customers.manage",
    "catalog.view",
    "catalog.manage",
    "jobs.view",
    "jobs.create",
    "jobs.edit",
    "jobs.progress.override",
    "stages.update",
    "stages.request_complete",
    "stages.reopen",
    "tasks.manage",
    "tasks.update_status",
    "crew.manage",
    "week.view",
    "comments.create",
    "reports.create",
    "reports.review",
    "issues.raise",
    "issues.resolve",
    "attendance.manage",
    "attendance.view",
  ],
  // Field seat (doc 06 literal row): assigned jobs (v) + own reports. NO
  // employee/catalog/member/customer/config surfaces — S3's report form gets
  // its scoped lookups with its slice.
  foreman: [
    "jobs.view",
    "stages.request_complete",
    "tasks.update_status",
    "week.view",
    "comments.create",
    "reports.create",
    // "Issues: raise" C (assigned) — the field's fast path to flag a blocker.
    "issues.raise",
  ],
  procurement: [
    "members.view",
    "catalog.view",
    "catalog.manage",
    "jobs.view",
    "week.view",
    "comments.create",
    // "Issues: raise" C for procurement (materials problems → tickets).
    "issues.raise",
  ],
  accounts: [
    "members.view",
    "employees.view",
    "customers.view",
    "catalog.view",
    "jobs.view",
    "week.view",
    "comments.create",
    // "Issues: raise" C + "Attendance: view" V (payroll input, D-6.2 cost-priv
    // holder — but attendance itself is not a cost wall).
    "issues.raise",
    "attendance.view",
  ],
  // Viewer (doc 06): jobs v (redacted) + week view + attendance V — other rows −.
  viewer: ["members.view", "jobs.view", "week.view", "attendance.view"],
};
