/**
 * Two-org seeder registry (S0 checklist §9; doc 10 #11 — the package's single
 * most important test's fixtures). ONE seeder per org-scoped table; the bleed
 * harness enumerates the org-scoped tables from the catalog and FAILS if any
 * lacks an entry here — so a new tenant table cannot ship without a bleed check.
 *
 * Seeders write via the OWNER connection (bypassing RLS) so both orgs get real
 * rows; the harness then proves, in each org's ctx, that the OTHER org's rows
 * are invisible.
 */
import { randomUUID } from "node:crypto";
import type postgres from "postgres";

type Owner = ReturnType<typeof postgres>;
/**
 * `userId` fills actor/author/creator columns (org-scoped for RLS). `recipientId`
 * fills the USER-keyed columns (notification/sign_in_log/preference user_id). The
 * bleed harness passes the SAME recipient into both orgs so user-scoping alone
 * cannot hide a cross-org row — only the org_id predicate can (review CM1).
 */
export type Seeder = (
  owner: Owner,
  orgId: string,
  userId: string,
  recipientId: string,
) => Promise<void>;

/**
 * Tables whose isolation is org AND user (both must match) — seeding a SHARED
 * recipient across both orgs means only the org predicate can hide a cross-org
 * row, so a regression dropping org_id is caught (review CM1). NOTE: sign_in_log
 * is deliberately NOT here — its policy is user OR org (a user legitimately sees
 * their OWN auth events across orgs, like an account "your sessions" view), so it
 * is seeded under its own org's user and its cross-USER isolation is what the
 * sweep checks.
 */
export const ORG_AND_USER_TABLES = ["notification", "notification_preference"] as const;

/** Tables that app.create_org_with_owner already populates — seeded by org creation. */
export const CREATE_ORG_SEEDED = [
  "company",
  "membership",
  "org_plan_state",
  "role_definition",
] as const;

const noop: Seeder = async () => {};

function filePath(orgId: string): string {
  const attach = randomUUID();
  const fileId = randomUUID();
  return `${orgId}/job_media/job/${attach}/${fileId}.orig.jpg`;
}

/**
 * Registry keyed by table name. CREATE_ORG_SEEDED tables get a no-op (already
 * populated by createOrgForUser); every other org-scoped table gets a real insert.
 */
export const SEEDERS: Record<string, Seeder> = {
  // ── seeded by org creation ──
  company: noop,
  membership: noop,
  org_plan_state: noop,
  role_definition: noop,

  // ── seeded here ──
  activity: async (o, org, u) => {
    await o`insert into public.activity (org_id, actor_user_id, entity_type, entity_id, verb, summary)
            values (${org}, ${u}, 'job', ${randomUUID()}, 'created', 'bleed')`;
  },
  app_settings: async (o, org) => {
    await o`insert into public.app_settings (org_id, key, value) values (${org}, 'bleed.test', '"x"'::jsonb)`;
  },
  audit_log: async (o, org, u) => {
    await o`insert into public.audit_log (org_id, actor_user_id, action, entity_type, summary)
            values (${org}, ${u}, 'bleed.test', 'org', 'x')`;
  },
  comment: async (o, org, u) => {
    await o`insert into public.comment (org_id, entity_type, entity_id, author_user_id, body)
            values (${org}, 'job', ${randomUUID()}, ${u}, 'bleed')`;
  },
  config_revision: async (o, org, u) => {
    await o`insert into public.config_revision (org_id, artifact_key, actor_user_id, summary)
            values (${org}, 'bleed', ${u}, 'x')`;
  },
  currency_rate_default: async (o, org) => {
    await o`insert into public.currency_rate_default (org_id, currency, rate_to_base)
            values (${org}, 'USD', 3.6725)`;
  },
  domain_event: async (o, org, u) => {
    await o`insert into public.domain_event (org_id, name, payload, actor_user_id)
            values (${org}, 'demo/heartbeat', '{}'::jsonb, ${u})`;
  },
  // ── S9 commercial (org-scoped) ──
  dunning_attempt: async (o, org) => {
    await o`insert into public.dunning_attempt (org_id, cycle_key, attempt_no)
            values (${org}, 'bleed-cycle', 1)`;
  },
  impersonation_session: async (o, org, u) => {
    // break_glass=true satisfies the consent-or-break-glass CHECK; staff_user_id is a real user.
    await o`insert into public.impersonation_session (org_id, staff_user_id, reason, break_glass)
            values (${org}, ${u}, 'bleed test session', true)`;
  },
  reconciliation: async (o, org) => {
    await o`insert into public.reconciliation (org_id, kind, detail) values (${org}, 'other', '{}'::jsonb)`;
  },
  subscription_event: async (o, org) => {
    await o`insert into public.subscription_event (org_id, provider, provider_event_id, event_type)
            values (${org}, 'fake', ${"bleed-" + randomUUID()}, 'bleed')`;
  },
  usage_event: async (o, org) => {
    await o`insert into public.usage_event (org_id, meter_key, period_key, dedup_key, delta)
            values (${org}, 'bleed.meter', '2026-07', ${randomUUID()}, 1)`;
  },
  file: async (o, org, u) => {
    await o`insert into public.file (org_id, access_class, attached_to_type, attached_to_id,
                                     bucket, object_path, original_name, mime, created_by)
            values (${org}, 'job_media', 'job', ${randomUUID()}, 'tenant-media',
                    ${filePath(org)}, 'x.jpg', 'image/jpeg', ${u})`;
  },
  membership_invite: async (o, org, u) => {
    await o`insert into public.membership_invite (org_id, email, role_key, token_hash, invited_by, expires_at)
            values (${org}, ${`bleed-${randomUUID().slice(0, 8)}@x.com`}, 'manager', ${randomUUID()},
                    ${u}, now() + interval '7 days')`;
  },
  notification: async (o, org, _u, recipient) => {
    await o`insert into public.notification (org_id, user_id, kind, title) values (${org}, ${recipient}, 'system', 'bleed')`;
  },
  notification_preference: async (o, org, _u, recipient) => {
    await o`insert into public.notification_preference (org_id, user_id, channels)
            values (${org}, ${recipient}, '{}'::jsonb) on conflict (org_id, user_id) do nothing`;
  },
  org_addon: async (o, org) => {
    await o`insert into public.org_addon (org_id, addon_key, quantity, status)
            values (${org}, 'addon.quotes_invoices', 1, 'active')
            on conflict (org_id, addon_key) do nothing`;
  },
  org_entitlement_override: async (o, org) => {
    await o`insert into public.org_entitlement_override (org_id, entitlement_key, reason)
            values (${org}, 'limit.full_users', 'bleed') on conflict (org_id, entitlement_key) do nothing`;
  },
  org_holiday_calendar: async (o, org) => {
    await o`insert into public.org_holiday_calendar (org_id, starts_on, label, kind)
            values (${org}, '2026-12-02', '{"en":"National Day"}'::jsonb, 'public_holiday')`;
  },
  org_storage_usage: async (o, org) => {
    await o`insert into public.org_storage_usage (org_id, bytes_used) values (${org}, 123)
            on conflict (org_id) do nothing`;
  },
  // ── S1 masters + config + walking skeleton ──
  team: async (o, org) => {
    await o`insert into public.team (org_id, name, kind) values (${org}, 'Bleed Team', 'trade')`;
  },
  employee: async (o, org) => {
    await o`insert into public.employee (org_id, name) values (${org}, 'Bleed Worker')`;
  },
  employee_terms: async (o, org) => {
    const emp = randomUUID();
    await o`insert into public.employee (id, org_id, name) values (${emp}, ${org}, 'Bleed Paid Worker')`;
    await o`insert into public.employee_terms (employee_id, org_id, salary_minor, hourly_cost_minor)
            values (${emp}, ${org}, 500000, 2404)`;
  },
  employee_hr: async (o, org) => {
    const emp = randomUUID();
    await o`insert into public.employee (id, org_id, name) values (${emp}, ${org}, 'Bleed HR Worker')`;
    await o`insert into public.employee_hr (employee_id, org_id, visa_expiry) values (${emp}, ${org}, '2027-01-01')`;
  },
  customer: async (o, org) => {
    await o`insert into public.customer (org_id, name) values (${org}, 'Bleed Customer')`;
  },
  supplier: async (o, org) => {
    await o`insert into public.supplier (org_id, name) values (${org}, 'Bleed Supplier')`;
  },
  item: async (o, org) => {
    await o`insert into public.item (org_id, sku, name, category_key, unit)
            values (${org}, ${"BLD-" + randomUUID().slice(0, 8)}, 'Bleed Item', 'fiberglass', 'pcs')`;
  },
  job_preset: async (o, org) => {
    await o`insert into public.job_preset (org_id, code, names, billing_points)
            values (${org}, 'BLD', '{"en":"Bleed","ar":"Bleed"}'::jsonb,
                    '[{"trigger":"on_acceptance","pct":100}]'::jsonb)`;
  },
  reference_sequence: async (o, org) => {
    await o`insert into public.reference_sequence (org_id, scope_key, next_value)
            values (${org}, 'job.BLD', 1) on conflict (org_id, scope_key) do nothing`;
  },
  job: async (o, org, u) => {
    await o`insert into public.job (org_id, reference, name, status_key, status_category, created_by)
            values (${org}, ${"BLD-" + randomUUID().slice(0, 8)}, 'Bleed Job', 'draft', 'draft', ${u})`;
  },
  daily_report: async (o, org, u) => {
    const job = randomUUID();
    await o`insert into public.job (id, org_id, reference, name, status_key, status_category, created_by)
            values (${job}, ${org}, ${"BLR-" + randomUUID().slice(0, 8)}, 'Bleed Report Job', 'draft', 'draft', ${u})`;
    await o`insert into public.daily_report (org_id, job_id, report_date, summary, submitted_by)
            values (${org}, ${job}, '2026-01-15', 'bleed', ${u})`;
  },

  // ── S2 plan & assign ──
  job_stage: async (o, org, u) => {
    const job = randomUUID();
    await o`insert into public.job (id, org_id, reference, name, status_key, status_category, created_by)
            values (${job}, ${org}, ${"BLS-" + randomUUID().slice(0, 8)}, 'Bleed Stage Job', 'draft', 'draft', ${u})`;
    await o`insert into public.job_stage (org_id, job_id, stage_key, name, weight, sort)
            values (${org}, ${job}, 'lamination', '{"en":"Lamination","ar":"تصفيح"}'::jsonb, 50, 0)`;
  },
  task: async (o, org, u) => {
    const job = randomUUID();
    await o`insert into public.job (id, org_id, reference, name, status_key, status_category, created_by)
            values (${job}, ${org}, ${"BLT-" + randomUUID().slice(0, 8)}, 'Bleed Task Job', 'draft', 'draft', ${u})`;
    await o`insert into public.task (org_id, job_id, title, created_by)
            values (${org}, ${job}, 'bleed task', ${u})`;
  },
  job_crew: async (o, org, u) => {
    const job = randomUUID();
    const emp = randomUUID();
    await o`insert into public.job (id, org_id, reference, name, status_key, status_category, created_by)
            values (${job}, ${org}, ${"BLC-" + randomUUID().slice(0, 8)}, 'Bleed Crew Job', 'draft', 'draft', ${u})`;
    await o`insert into public.employee (id, org_id, name) values (${emp}, ${org}, 'Bleed Crew Member')`;
    await o`insert into public.job_crew (org_id, job_id, employee_id, added_by)
            values (${org}, ${job}, ${emp}, ${u})`;
  },

  // ── S3 report heartbeat ──
  report_work_line: async (o, org, u) => {
    const job = randomUUID();
    const rep = randomUUID();
    await o`insert into public.job (id, org_id, reference, name, status_key, status_category, created_by)
            values (${job}, ${org}, ${"BLW-" + randomUUID().slice(0, 8)}, 'Bleed Work Job', 'draft', 'draft', ${u})`;
    await o`insert into public.daily_report (id, org_id, job_id, report_date, summary, submitted_by)
            values (${rep}, ${org}, ${job}, '2026-02-01', 'bleed', ${u})`;
    await o`insert into public.report_work_line (org_id, report_id, description)
            values (${org}, ${rep}, 'bleed work line')`;
  },
  report_material_line: async (o, org, u) => {
    const job = randomUUID();
    const rep = randomUUID();
    await o`insert into public.job (id, org_id, reference, name, status_key, status_category, created_by)
            values (${job}, ${org}, ${"BLM-" + randomUUID().slice(0, 8)}, 'Bleed Mat Job', 'draft', 'draft', ${u})`;
    await o`insert into public.daily_report (id, org_id, job_id, report_date, summary, submitted_by)
            values (${rep}, ${org}, ${job}, '2026-02-02', 'bleed', ${u})`;
    await o`insert into public.report_material_line (org_id, report_id, item_name, qty, unit)
            values (${org}, ${rep}, 'Bleed Resin', 2, 'L')`;
  },
  report_labour_line: async (o, org, u) => {
    const job = randomUUID();
    const rep = randomUUID();
    const emp = randomUUID();
    await o`insert into public.job (id, org_id, reference, name, status_key, status_category, created_by)
            values (${job}, ${org}, ${"BLL-" + randomUUID().slice(0, 8)}, 'Bleed Lab Job', 'draft', 'draft', ${u})`;
    await o`insert into public.daily_report (id, org_id, job_id, report_date, summary, submitted_by)
            values (${rep}, ${org}, ${job}, '2026-02-03', 'bleed', ${u})`;
    await o`insert into public.employee (id, org_id, name) values (${emp}, ${org}, 'Bleed Labour')`;
    await o`insert into public.report_labour_line (org_id, report_id, employee_id, normal_hours, ot_hours)
            values (${org}, ${rep}, ${emp}, 8, 1)`;
  },
  report_labour_cost: async (o, org, u) => {
    const job = randomUUID();
    const rep = randomUUID();
    const emp = randomUUID();
    await o`insert into public.job (id, org_id, reference, name, status_key, status_category, created_by)
            values (${job}, ${org}, ${"BLK-" + randomUUID().slice(0, 8)}, 'Bleed Cost Job', 'draft', 'draft', ${u})`;
    await o`insert into public.daily_report (id, org_id, job_id, report_date, summary, submitted_by)
            values (${rep}, ${org}, ${job}, '2026-02-04', 'bleed', ${u})`;
    await o`insert into public.employee (id, org_id, name) values (${emp}, ${org}, 'Bleed Cost Emp')`;
    await o`insert into public.report_labour_cost
              (org_id, report_id, employee_id, hourly_cost_minor, ot_rate, labour_cost_minor)
            values (${org}, ${rep}, ${emp}, 100, 1.25, 1050)`;
  },
  attendance: async (o, org, u) => {
    const emp = randomUUID();
    await o`insert into public.employee (id, org_id, name) values (${emp}, ${org}, 'Bleed Att Emp')`;
    await o`insert into public.attendance (org_id, employee_id, attendance_date, status, source, marked_by)
            values (${org}, ${emp}, '2026-02-05', 'present', 'manual', ${u})`;
  },
  issue: async (o, org, u) => {
    await o`insert into public.issue (org_id, title, severity, is_blocker, status, raised_by)
            values (${org}, 'Bleed issue', 'medium', false, 'open', ${u})`;
  },

  // ── S4 supply & approve ──
  approval_rule: async (o, org) => {
    await o`insert into public.approval_rule (org_id, subject_type, condition_kind, assigned_role)
            values (${org}, 'material_request', 'always', 'manager')`;
  },
  approval: async (o, org, u) => {
    await o`insert into public.approval
              (org_id, subject_type, subject_id, subject_summary, requested_by, assigned_role, state)
            values (${org}, 'material_request', ${randomUUID()},
                    '{"title":"Bleed approval"}'::jsonb, ${u}, 'manager', 'pending')`;
  },
  material_request: async (o, org, u) => {
    await o`insert into public.material_request (org_id, reference, status, created_by)
            values (${org}, ${"BLM-" + randomUUID().slice(0, 8)}, 'draft', ${u})`;
  },
  material_request_line: async (o, org, u) => {
    const mr = randomUUID();
    await o`insert into public.material_request (id, org_id, reference, status, created_by)
            values (${mr}, ${org}, ${"BLML-" + randomUUID().slice(0, 8)}, 'draft', ${u})`;
    await o`insert into public.material_request_line (org_id, mr_id, item_name, qty, unit)
            values (${org}, ${mr}, 'Bleed line', 2, 'ea')`;
  },
  purchase_order: async (o, org, u) => {
    const sup = randomUUID();
    await o`insert into public.supplier (id, org_id, name) values (${sup}, ${org}, 'Bleed PO Supplier')`;
    await o`insert into public.purchase_order (org_id, reference, supplier_id, status, created_by)
            values (${org}, ${"BLP-" + randomUUID().slice(0, 8)}, ${sup}, 'draft', ${u})`;
  },
  purchase_order_line: async (o, org, u) => {
    const sup = randomUUID();
    const po = randomUUID();
    await o`insert into public.supplier (id, org_id, name) values (${sup}, ${org}, 'Bleed POL Supplier')`;
    await o`insert into public.purchase_order (id, org_id, reference, supplier_id, status, created_by)
            values (${po}, ${org}, ${"BLPL-" + randomUUID().slice(0, 8)}, ${sup}, 'draft', ${u})`;
    await o`insert into public.purchase_order_line (org_id, po_id, item_name, qty, unit, unit_cost_minor)
            values (${org}, ${po}, 'Bleed POL', 3, 'ea', 1000)`;
  },
  goods_receipt: async (o, org, u) => {
    const sup = randomUUID();
    const po = randomUUID();
    await o`insert into public.supplier (id, org_id, name) values (${sup}, ${org}, 'Bleed GRN Supplier')`;
    await o`insert into public.purchase_order (id, org_id, reference, supplier_id, status, created_by)
            values (${po}, ${org}, ${"BLG-" + randomUUID().slice(0, 8)}, ${sup}, 'approved', ${u})`;
    await o`insert into public.goods_receipt (org_id, reference, po_id, status, received_date, created_by)
            values (${org}, ${"BLGR-" + randomUUID().slice(0, 8)}, ${po}, 'recorded', '2026-02-10', ${u})`;
  },
  goods_receipt_line: async (o, org, u) => {
    const sup = randomUUID();
    const po = randomUUID();
    const pol = randomUUID();
    const grn = randomUUID();
    await o`insert into public.supplier (id, org_id, name) values (${sup}, ${org}, 'Bleed GRNL Supplier')`;
    await o`insert into public.purchase_order (id, org_id, reference, supplier_id, status, created_by)
            values (${po}, ${org}, ${"BLGL-" + randomUUID().slice(0, 8)}, ${sup}, 'approved', ${u})`;
    await o`insert into public.purchase_order_line (id, org_id, po_id, item_name, qty, unit, unit_cost_minor)
            values (${pol}, ${org}, ${po}, 'Bleed', 5, 'ea', 1000)`;
    await o`insert into public.goods_receipt (id, org_id, reference, po_id, status, received_date, created_by)
            values (${grn}, ${org}, ${"BLGLR-" + randomUUID().slice(0, 8)}, ${po}, 'recorded', '2026-02-11', ${u})`;
    await o`insert into public.goods_receipt_line (org_id, grn_id, po_line_id, ordered_qty, received_qty)
            values (${org}, ${grn}, ${pol}, 5, 2)`;
  },

  // ── S5 "Measure" tables ──
  expense: async (o, org, u) => {
    await o`insert into public.expense
              (org_id, reference, category_key, costing_mapping, description, expense_date,
               amount_minor, vat_amount_minor, total_minor, created_by)
            values (${org}, ${"BLEXP-" + randomUUID().slice(0, 8)}, 'misc', 'overhead', 'bleed',
                    '2026-02-12', 1000, 50, 1050, ${u})`;
  },
  exception: async (o, org) => {
    await o`insert into public.exception (org_id, rule_key, severity, audience_roles, dedup_key)
            values (${org}, 'missing_report', 'warning', array['manager']::text[],
                    ${"missing_report:" + randomUUID()})`;
  },
  cost_rollup: async (o, org, u) => {
    const job = randomUUID();
    await o`insert into public.job (id, org_id, reference, name, status_key, status_category, created_by)
            values (${job}, ${org}, ${"BLCR-" + randomUUID().slice(0, 8)}, 'bleed', 'active', 'active', ${u})`;
    await o`insert into public.cost_rollup (org_id, job_id, cost_basis, total_ex_labour_minor)
            values (${org}, ${job}, 'ex_vat', 1000)`;
  },
  cost_rollup_labour: async (o, org, u) => {
    const job = randomUUID();
    await o`insert into public.job (id, org_id, reference, name, status_key, status_category, created_by)
            values (${job}, ${org}, ${"BLCRL-" + randomUUID().slice(0, 8)}, 'bleed', 'active', 'active', ${u})`;
    await o`insert into public.cost_rollup_labour (org_id, job_id, labour_cost_minor, total_cost_minor)
            values (${org}, ${job}, 500, 1500)`;
  },

  // ── S6 "Bill" tables ──
  quote: async (o, org, u) => {
    await o`insert into public.quote (org_id, reference, customer_name, status, created_by)
            values (${org}, ${"BLQ-" + randomUUID().slice(0, 8)}, 'Bleed customer', 'draft', ${u})`;
  },
  quote_line: async (o, org, u) => {
    const q = randomUUID();
    await o`insert into public.quote (id, org_id, reference, customer_name, status, created_by)
            values (${q}, ${org}, ${"BLQL-" + randomUUID().slice(0, 8)}, 'Bleed customer', 'draft', ${u})`;
    await o`insert into public.quote_line (org_id, quote_id, description, qty, unit)
            values (${org}, ${q}, 'Bleed line', 1, 'ea')`;
  },
  invoice: async (o, org, u) => {
    await o`insert into public.invoice (org_id, reference, customer_name, status, created_by)
            values (${org}, ${"BLI-" + randomUUID().slice(0, 8)}, 'Bleed customer', 'draft', ${u})`;
  },
  invoice_line: async (o, org, u) => {
    const inv = randomUUID();
    await o`insert into public.invoice (id, org_id, reference, customer_name, status, created_by)
            values (${inv}, ${org}, ${"BLIL-" + randomUUID().slice(0, 8)}, 'Bleed customer', 'draft', ${u})`;
    await o`insert into public.invoice_line (org_id, invoice_id, description, qty, unit)
            values (${org}, ${inv}, 'Bleed line', 1, 'ea')`;
  },
  einvoice_submission: async (o, org, u) => {
    const inv = randomUUID();
    await o`insert into public.invoice (id, org_id, reference, customer_name, status, issued_at, created_by)
            values (${inv}, ${org}, ${"BLES-" + randomUUID().slice(0, 8)}, 'Bleed customer', 'issued', now(), ${u})`;
    await o`insert into public.einvoice_submission (org_id, invoice_id, provider, status)
            values (${org}, ${inv}, 'fake', 'pending')`;
  },
  payment: async (o, org, u) => {
    await o`insert into public.payment
              (org_id, reference, status, method, payment_date, amount_minor, created_by)
            values (${org}, ${"BLPMT-" + randomUUID().slice(0, 8)}, 'recorded', 'cash', '2026-02-13', 1000, ${u})`;
  },
  payment_receipt: async (o, org, u) => {
    const pmt = randomUUID();
    await o`insert into public.payment
              (id, org_id, reference, status, method, payment_date, amount_minor, created_by)
            values (${pmt}, ${org}, ${"BLPR-" + randomUUID().slice(0, 8)}, 'recorded', 'cash', '2026-02-13', 1000, ${u})`;
    await o`insert into public.payment_receipt (org_id, payment_id, reference)
            values (${org}, ${pmt}, ${"RCP-BL-" + randomUUID().slice(0, 8)})`;
  },

  // ── S7 "Improve" tables ──
  digest: async (o, org) => {
    await o`insert into public.digest (org_id, audience, digest_date, payload)
            values (${org}, 'owner', '2026-02-14', '{"audience":"owner","sections":[],"numbers":[]}'::jsonb)`;
  },
  ai_interaction: async (o, org, u) => {
    await o`insert into public.ai_interaction (org_id, feature, provider, validator_verdict, status, created_by)
            values (${org}, 'digest_narration', 'fake', 'na', 'ok', ${u})`;
  },
  customer_update: async (o, org, u) => {
    await o`insert into public.customer_update (org_id, title, language, body, created_by)
            values (${org}, 'Bleed update', 'ar', 'Bleed body', ${u})`;
  },
  share_token: async (o, org, u) => {
    const cu = randomUUID();
    await o`insert into public.customer_update (id, org_id, title, language, body, status, content, sent_at, created_by)
            values (${cu}, ${org}, 'Bleed sent', 'ar', 'Bleed', 'sent', '{}'::jsonb, now(), ${u})`;
    await o`insert into public.share_token (org_id, customer_update_id, token_hash, expires_at, created_by)
            values (${org}, ${cu}, ${"blhash-" + randomUUID()}, now() + interval '30 days', ${u})`;
  },
  onboarding_session: async (o, org, u) => {
    await o`insert into public.onboarding_session (org_id, status, template_key, intake, created_by)
            values (${org}, 'draft', 'boatbuilding_marine_v1', '{}'::jsonb, ${u})`;
  },
  import_batch: async (o, org, u) => {
    await o`insert into public.import_batch (org_id, kind, status, row_count, created_by)
            values (${org}, 'customers', 'staged', 0, ${u})`;
  },
  import_row: async (o, org, u) => {
    const b = randomUUID();
    await o`insert into public.import_batch (id, org_id, kind, status, row_count, created_by)
            values (${b}, ${org}, 'customers', 'validated', 1, ${u})`;
    await o`insert into public.import_row (org_id, batch_id, row_number, raw, status)
            values (${org}, ${b}, 1, '{"name":"Bleed"}'::jsonb, 'valid')`;
  },

  // Seeded under the org's OWN user (not the shared recipient): sign_in_log's
  // policy is user-OR-org, so a shared user would be visible cross-org by design
  // (the user's own events). Using a disjoint user tests the cross-USER isolation.
  sign_in_log: async (o, org, u) => {
    await o`insert into public.sign_in_log (org_id, user_id, event) values (${org}, ${u}, 'login_success')`;
  },
};

/**
 * Seed every org-scoped entity for one org. `userId` = the org's own actor;
 * `recipientId` = the user for USER-keyed rows (the harness passes the SAME
 * recipient into both orgs — see USER_KEYED_TABLES / review CM1).
 */
export async function seedOrg(
  owner: Owner,
  orgId: string,
  userId: string,
  recipientId: string = userId,
): Promise<void> {
  for (const seed of Object.values(SEEDERS)) {
    await seed(owner, orgId, userId, recipientId);
  }
}
