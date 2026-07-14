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
  | "jobs.edit"
  | "jobs.price.manage"
  | "jobs.price.adjust"
  | "jobs.progress.override"
  | "stages.update"
  | "stages.request_complete"
  | "stages.reopen"
  | "tasks.manage"
  | "tasks.update_status"
  | "crew.manage"
  | "week.view"
  | "comments.create"
  | "reports.create"
  // S3 (doc 06 rows 45-47, 61): review loop, backfill, issues, attendance.
  | "reports.review"
  | "reports.backfill"
  | "issues.raise"
  | "issues.resolve"
  | "attendance.manage"
  | "attendance.view"
  // S4 (doc 06 rows 50-53): Supply & Approve.
  | "approvals.decide"
  | "mr.create"
  | "mr.convert"
  | "po.manage"
  | "po.view"
  | "grn.create"
  | "grn.cancel"
  // S5 (doc 06 rows 58-59 + the Today/exception surfaces): Measure.
  | "expenses.create"
  | "expenses.void"
  | "expenses.view"
  | "costing.view"
  | "today.view"
  | "exceptions.view"
  | "exceptions.dismiss"
  // S6 (doc 06 rows 55-57): Bill — quotes/invoices/payments/AR.
  | "quotes.view"
  | "quotes.manage"
  | "invoices.view"
  | "invoices.manage"
  | "payments.view"
  | "payments.manage"
  | "ar.view"
  // ── S7 "Improve" ──
  | "digest.view"
  | "customer_updates.draft"
  | "customer_updates.send"
  | "customer_updates.share"
  | "customer_updates.revoke"
  | "onboarding.run"
  | "imports.manage"
  | "billing.view"
  | "billing.manage";

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
  // S2 (doc 06): "Jobs: create/edit core" M = O/A/M.
  "jobs.edit": ["owner", "admin", "manager"],
  // Pricing surfaces are price-privileged O/A (manager is the Workshop variant
  // with viewPrices OFF; server-side redaction is the wall — F-23).
  "jobs.price.manage": ["owner", "admin"],
  // Price adjustments are the MVP scope-change mechanism — OWNER-only (F-10).
  "jobs.price.adjust": ["owner"],
  // progress_override is a management-judgment override (D-1.4) — O/A/M.
  "jobs.progress.override": ["owner", "admin", "manager"],
  // "Stages: update status" M M M; foreman = C (assigned; request-complete).
  "stages.update": ["owner", "admin", "manager"],
  "stages.request_complete": ["owner", "admin", "manager", "foreman"],
  // Reopen is a manager action with required reason (doc 01 F-5).
  "stages.reopen": ["owner", "admin", "manager"],
  // "Tasks: manage / update own status" M M M; foreman C (assigned).
  "tasks.manage": ["owner", "admin", "manager"],
  "tasks.update_status": ["owner", "admin", "manager", "foreman"],
  // job_crew membership management rides the job-planning surface (O/A/M).
  "crew.manage": ["owner", "admin", "manager"],
  // "Week plan: view published" = V for every archetype (the plan ENTITY was
  // cut, F-15 — the derived week VIEW keeps the row's audience).
  "week.view": ["owner", "admin", "manager", "foreman", "procurement", "accounts", "viewer"],
  // Comments are operational CONTRIBUTION (like issues, doc 06): every
  // contributor archetype, NOT the read-only viewer; foreman is assigned-scoped
  // (enforced server-side by the F-6 resolver in the action).
  "comments.create": ["owner", "admin", "manager", "foreman", "procurement", "accounts"],
  // ── S3 "Report: the heartbeat" (doc 06 rows) ──────────────────────────────
  // "Daily reports: review; edit materials post-submit" A/M A/M A/M − ...
  "reports.review": ["owner", "admin", "manager"],
  // "Reports: backfill history" row shows Owner=− Admin=M, but the governing
  // footnote "Owner ≡ Admin in MVP permissions; Owner additionally holds..."
  // makes Owner a strict superset in every other row — a lone Owner<Admin cell
  // is the doc typo, the footnote is normative → owner+admin. (Reconciliation
  // documented in the S3 completion report.)
  "reports.backfill": ["owner", "admin"],
  // "Issues: raise / resolve" C/M C/M C/M C(assigned) C C C(own) − — raise (C)
  // is every contributor incl. foreman(assigned)/procurement/accounts; resolve
  // (M) is O/A/M. Worker(own) is the P3 archetype, excluded from the build.
  "issues.raise": ["owner", "admin", "manager", "foreman", "procurement", "accounts"],
  "issues.resolve": ["owner", "admin", "manager"],
  // "Attendance: mark / view" M M M − − V − V — mark (M) is O/A/M; view adds
  // Accounts + Viewer (V). Foreman does NOT read the grid (labour lines are the
  // write, audit C-3 — the derivation is a DEFINER path, not a foreman grant).
  "attendance.manage": ["owner", "admin", "manager"],
  "attendance.view": ["owner", "admin", "manager", "accounts", "viewer"],
  // ── S4 "Supply & Approve" (doc 06 rows 50-53) ─────────────────────────────
  // "Approvals: decide" A A A(rule-scoped) − − A(rule-scoped) − − — owner/admin
  // decide anything routed to them; manager/accounts decide ONLY approvals whose
  // rule assigned_role ∈ their roles (the rule-scope is the SERVICE gate).
  "approvals.decide": ["owner", "admin", "manager", "accounts"],
  // "Material requests: create / convert" C C C C(assigned) C+convert − − −.
  "mr.create": ["owner", "admin", "manager", "foreman", "procurement"],
  // convert is procurement's "+convert" (+ owner/admin superset); manager = C only.
  "mr.convert": ["owner", "admin", "procurement"],
  // "POs: manage / view" A/M A/M M − M V − − — manage = O/A/M/Procurement.
  "po.manage": ["owner", "admin", "manager", "procurement"],
  "po.view": ["owner", "admin", "manager", "procurement", "accounts"],
  // "Goods receipts: create / cancel" C C/M C C(assigned) C − − − — create =
  // O/A/M/Foreman(assigned)/Procurement; cancel (the M) = admin (+ owner superset).
  "grn.create": ["owner", "admin", "manager", "foreman", "procurement"],
  "grn.cancel": ["owner", "admin"],
  // ── S5 "Measure" (doc 06 rows 58-59 + Today/exception surfaces) ────────────
  // "Expenses: create / approve" C C C − C M/A(rule) − − — create = O/A/M/Proc/Acc
  // (foreman −, F-23: field seat sees no costs).
  "expenses.create": ["owner", "admin", "manager", "procurement", "accounts"],
  // Void = Owner/Admin/Accounts (owner ruling); a mandatory reason is the service
  // + the DB CHECK. Managers/Procurement/Foremen/Viewers cannot void.
  "expenses.void": ["owner", "admin", "accounts"],
  // Viewing expenses (cost data) = the finance/supply roles; foreman NEVER (F-23).
  "expenses.view": ["owner", "admin", "manager", "procurement", "accounts"],
  // "Job costing / margins" V V 🔒 − − V − − — page access O/A/M/Accounts; the
  // labour + total + margin FIELDS are gated by the costPrivileged/pricePrivileged
  // flags at the serializer (manager viewCosts OFF by default → cost EXCLUDING
  // labour; no margin without viewPrices). Foreman/Procurement have no access.
  "costing.view": ["owner", "admin", "manager", "accounts"],
  // Today screens: S5 shipped foreman+manager; S6 adds the Accounts + Procurement
  // compositions (owner/admin see the owner/management view). doc 03 §5 roles.
  "today.view": ["owner", "admin", "manager", "foreman", "accounts", "procurement"],
  // Exceptions: view is audience-scoped — the grant is broad, the SERVICE narrows
  // to (archetype ∈ audience_roles) ∧ job-scope (foreman sees only own-relevant).
  // Viewer excluded.
  "exceptions.view": ["owner", "admin", "manager", "foreman", "procurement", "accounts"],
  // Dismiss / manual-resolve = Owner/Admin/Manager (manager audience+job-scope
  // limited at the service; owner ruling). Auto-resolution stays engine-controlled.
  "exceptions.dismiss": ["owner", "admin", "manager"],
  // ── S6 "Bill" (doc 06 rows 55-57) ─────────────────────────────────────────
  // "Quotes: draft / approve-send" M/A M/A M − − V − − — draft (M) = O/A/M; the
  // approve-send (A) is the quote_send approval decided via approvals.decide (rule
  // → O/A). Accounts view-only.
  "quotes.view": ["owner", "admin", "manager", "accounts"],
  "quotes.manage": ["owner", "admin", "manager"],
  // "Invoices & payments: manage" M − M − − M − − — only O/A/Accounts. Manager −.
  // invoice_issue is a direct action, NOT an approval subject (audit C-1).
  "invoices.view": ["owner", "admin", "accounts"],
  "invoices.manage": ["owner", "admin", "accounts"],
  "payments.view": ["owner", "admin", "accounts"],
  "payments.manage": ["owner", "admin", "accounts"],
  // AR (accounts receivable) view — composed from invoices+payments; O/A/Accounts.
  "ar.view": ["owner", "admin", "accounts"],

  // ── S7 "Improve" (doc 06 rows 62, 65) ─────────────────────────────────────
  // Row 65 digest column = V for everyone except Worker (cut) and Viewer.
  "digest.view": ["owner", "admin", "manager", "foreman", "procurement", "accounts"],
  // Row 62 "Customer updates: draft/send" = M/A M/A M − − − − − → O/A/M only.
  // share/revoke ride the same holders (org-revocable per F-22); send is always human.
  "customer_updates.draft": ["owner", "admin", "manager"],
  "customer_updates.send": ["owner", "admin", "manager"],
  "customer_updates.share": ["owner", "admin", "manager"],
  "customer_updates.revoke": ["owner", "admin", "manager"],
  // S8 — guided onboarding (config setup) is an owner/admin task (config.manage holders).
  "onboarding.run": ["owner", "admin"],
  // Commercial/billing (doc 10 #21): manage is OWNER-ONLY; view extends to admin + accounts.
  "billing.view": ["owner", "admin", "accounts"],
  "billing.manage": ["owner"],
  // S8 — guided CSV imports of masters (customers/employees/items).
  "imports.manage": ["owner", "admin", "manager"],
};
