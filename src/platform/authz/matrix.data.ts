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
    "approvals.decide",
    "mr.create",
    "mr.convert",
    "po.manage",
    "po.view",
    "grn.create",
    "grn.cancel",
    // S5 Measure: full expenses (incl. void), costing page, Today, exceptions.
    "expenses.create",
    "expenses.void",
    "expenses.view",
    "costing.view",
    "today.view",
    "exceptions.view",
    "exceptions.dismiss",
    // S6 Bill: quotes + invoices + payments + AR.
    "quotes.view",
    "quotes.manage",
    "invoices.view",
    "invoices.manage",
    "payments.view",
    "payments.manage",
    "ar.view",
    // S7 Improve: owner sees the digest card + owns customer updates.
    "digest.view",
    "customer_updates.draft",
    "customer_updates.send",
    "customer_updates.share",
    "customer_updates.revoke",
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
    "approvals.decide",
    "mr.create",
    "mr.convert",
    "po.manage",
    "po.view",
    "grn.create",
    "grn.cancel",
    // S5 Measure: same as owner (Owner ≡ Admin footnote).
    "expenses.create",
    "expenses.void",
    "expenses.view",
    "costing.view",
    "today.view",
    "exceptions.view",
    "exceptions.dismiss",
    // S6 Bill: same as owner (Owner ≡ Admin footnote).
    "quotes.view",
    "quotes.manage",
    "invoices.view",
    "invoices.manage",
    "payments.view",
    "payments.manage",
    "ar.view",
    // S7 Improve.
    "digest.view",
    "customer_updates.draft",
    "customer_updates.send",
    "customer_updates.share",
    "customer_updates.revoke",
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
    // S4: decide rule-routed approvals; MR + PO manage + GRN create (no convert,
    // no PO approve beyond decide, no grn.cancel — those are procurement/admin).
    "approvals.decide",
    "mr.create",
    "po.manage",
    "po.view",
    "grn.create",
    // S5 Measure: create expenses (not void); costing page (labour+margin redacted
    // — viewCosts OFF by default); manager Today; view + dismiss audience exceptions.
    "expenses.create",
    "expenses.view",
    "costing.view",
    "today.view",
    "exceptions.view",
    "exceptions.dismiss",
    // S6 Bill: draft/edit quotes (approve-send is via approvals.decide, rule → O/A).
    // Manager has NO invoice/payment/AR access (row 57 −).
    "quotes.view",
    "quotes.manage",
    // S7 Improve: manager sees the digest + drafts/sends customer updates.
    "digest.view",
    "customer_updates.draft",
    "customer_updates.send",
    "customer_updates.share",
    "customer_updates.revoke",
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
    // S4: MR + GRN create on ASSIGNED jobs (server-enforced F-6); never decides
    // approvals, never manages POs, never sees cost/price.
    "mr.create",
    "grn.create",
    // S5 Measure: the field Today screen; view OWN-relevant exceptions only (service
    // audience+scope). NO money anywhere (no expenses/costing) — F-23; cannot dismiss.
    "today.view",
    "exceptions.view",
    // S7 Improve: the field digest card (deterministic; no money — F-23 at collection).
    "digest.view",
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
    // S4: procurement owns the supply chain — raise MRs, CONVERT them to POs,
    // manage POs, receive goods. Does NOT decide approvals.
    "mr.create",
    "mr.convert",
    "po.manage",
    "po.view",
    "grn.create",
    // S5 Measure: procurement creates + views expenses (petty-cash purchases); may
    // view exceptions only when a rule names their role (service audience filter);
    // cannot dismiss. No costing page, no Today screen (S6).
    "expenses.create",
    "expenses.view",
    "exceptions.view",
    // S6 Bill: the Procurement Today screen (approved MRs to convert, open POs, …).
    "today.view",
    // S7 Improve: procurement digest card.
    "digest.view",
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
    // S4: accounts decide rule-routed approvals (e.g. expense/payment in later
    // slices) and VIEW POs. Cost-privileged, so amounts are visible to them.
    "approvals.decide",
    "po.view",
    // S5 Measure: accounts is the back-office finance seat — full expenses (incl.
    // void), the costing page (cost-privileged, sees labour + margin), and view
    // audience exceptions (cannot dismiss; owner ruling). Accounts Today is S6.
    "expenses.create",
    "expenses.void",
    "expenses.view",
    "costing.view",
    "exceptions.view",
    // S6 Bill: the back-office finance seat — quotes view, invoices + payments +
    // AR manage/view, and the Accounts Today screen. (Manage but not draft quotes.)
    "quotes.view",
    "invoices.view",
    "invoices.manage",
    "payments.view",
    "payments.manage",
    "ar.view",
    "today.view",
    // S7 Improve: accounts digest card.
    "digest.view",
  ],
  // Viewer (doc 06): jobs v (redacted) + week view + attendance V — other rows −.
  viewer: ["members.view", "jobs.view", "week.view", "attendance.view"],
};
