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

/**
 * The chain a stock row needs: a unit, a warehouse, a bin and an item.
 *
 * The ledger tables all reference the same four, so building them once here
 * keeps the four seeders below to the row each of them is actually about.
 */
async function seedStockChain(o: Owner, org: string, u: string) {
  const unit = randomUUID();
  const wh = randomUUID();
  const bin = randomUUID();
  const item = randomUUID();
  await o`insert into public.unit_of_measure
            (id, org_id, code, name_en, name_ar, dimension, factor_to_base)
          values (${unit}, ${org}, ${"U" + randomUUID().slice(0, 6)}, 'Bleed unit', 'وحدة', 'count', 1)`;
  await o`insert into public.warehouse (id, org_id, code, name_en, created_by)
          values (${wh}, ${org}, ${"W" + randomUUID().slice(0, 6)}, 'Bleed wh', ${u})`;
  await o`insert into public.stock_location (id, org_id, warehouse_id, code, name_en)
          values (${bin}, ${org}, ${wh}, ${"B" + randomUUID().slice(0, 6)}, 'Bleed bin')`;
  await o`insert into public.item (id, org_id, sku, name, category_key, unit, base_unit_id)
          values (${item}, ${org}, ${"BS-" + randomUUID().slice(0, 8)}, 'Bleed stock item',
                  'general', 'ea', ${unit})`;
  return { unit, wh, bin, item };
}

/** A recorded receipt line, which the tracking-capture tables hang off. */
async function seedReceiptLine(o: Owner, org: string, u: string): Promise<string> {
  const sup = randomUUID();
  const po = randomUUID();
  const pol = randomUUID();
  const grn = randomUUID();
  const grl = randomUUID();
  await o`insert into public.supplier (id, org_id, name) values (${sup}, ${org}, 'Bleed track Supplier')`;
  await o`insert into public.purchase_order (id, org_id, reference, supplier_id, status, created_by)
          values (${po}, ${org}, ${"BLTR-" + randomUUID().slice(0, 8)}, ${sup}, 'approved', ${u})`;
  await o`insert into public.purchase_order_line (id, org_id, po_id, item_name, qty, unit, unit_cost_minor)
          values (${pol}, ${org}, ${po}, 'Bleed', 5, 'ea', 1000)`;
  await o`insert into public.goods_receipt (id, org_id, reference, po_id, status, received_date, created_by)
          values (${grn}, ${org}, ${"BLTRR-" + randomUUID().slice(0, 8)}, ${po}, 'recorded', '2026-02-13', ${u})`;
  await o`insert into public.goods_receipt_line
            (id, org_id, grn_id, po_line_id, ordered_qty, received_qty, accepted_qty)
          values (${grl}, ${org}, ${grn}, ${pol}, 5, 5, 5)`;
  return grl;
}

/**
 * The chain an asset row needs: a category and a registered asset.
 *
 * Asset numbers are per-organization, so the bleed fixture has to mint distinct
 * ones for both orgs rather than colliding on a shared literal.
 */
async function seedAsset(o: Owner, org: string, u: string) {
  const category = randomUUID();
  const asset = randomUUID();
  await o`insert into public.asset_category (id, org_id, code, name_en, created_by)
          values (${category}, ${org}, ${"AC" + randomUUID().slice(0, 6)}, 'Bleed category', ${u})`;
  await o`insert into public.asset
            (id, org_id, asset_no, category_id, name_en, status, condition, created_by)
          values (${asset}, ${org}, ${"AST-" + randomUUID().slice(0, 8)}, ${category},
                  'Bleed asset', 'in_service', 'good', ${u})`;
  return { category, asset };
}

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
  org_branding: async (o, org) => {
    await o`insert into public.org_branding (org_id, display_name, accent_color)
            values (${org}, 'Bleed Brand', '#1a2b3c')
            on conflict (org_id) do nothing`;
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
    await o`insert into public.goods_receipt_line
              (org_id, grn_id, po_line_id, ordered_qty, received_qty, accepted_qty)
            values (${org}, ${grn}, ${pol}, 5, 2, 2)`;
  },
  stock_lot: async (o, org, u) => {
    const s = await seedStockChain(o, org, u);
    await o`insert into public.stock_lot (org_id, item_id, code, expiry_date, created_by)
            values (${org}, ${s.item}, ${"L" + randomUUID().slice(0, 8)}, '2027-01-01', ${u})`;
  },
  stock_serial: async (o, org, u) => {
    const s = await seedStockChain(o, org, u);
    await o`insert into public.stock_serial
              (org_id, item_id, serial_no, status, warehouse_id, location_id, created_by)
            values (${org}, ${s.item}, ${"SN" + randomUUID().slice(0, 8)}, 'in_stock',
                    ${s.wh}, ${s.bin}, ${u})`;
  },
  stock_movement_lot: async (o, org, u) => {
    const s = await seedStockChain(o, org, u);
    const lot = randomUUID();
    const mv = randomUUID();
    // The item has to BE lot-tracked, or the deferred trigger rejects the pair.
    await o`update public.item set tracking = 'lot' where id = ${s.item} and org_id = ${org}`;
    await o`insert into public.stock_lot (id, org_id, item_id, code, created_by)
            values (${lot}, ${org}, ${s.item}, ${"L" + randomUUID().slice(0, 8)}, ${u})`;
    /*
     * ONE transaction, because the tracking check is a deferred constraint: it
     * fires at commit and asks whether the movement's lots add up. Two
     * autocommitted statements commit the movement alone, with no lots yet, and
     * it refuses — correctly.
     */
    await o.begin(async (tx) => {
      await tx`insert into public.stock_movement
                 (id, org_id, item_id, warehouse_id, location_id, movement_type, qty_delta,
                  unit_id, idempotency_key, actor_user_id)
               values (${mv}, ${org}, ${s.item}, ${s.wh}, ${s.bin}, 'adjustment_increase', 3,
                       ${s.unit}, ${"bleed-" + randomUUID()}, ${u})`;
      await tx`insert into public.stock_movement_lot (org_id, movement_id, lot_id, qty)
               values (${org}, ${mv}, ${lot}, 3)`;
    });
  },
  stock_movement_serial: async (o, org, u) => {
    const s = await seedStockChain(o, org, u);
    const serial = randomUUID();
    const mv = randomUUID();
    await o`update public.item set tracking = 'serial' where id = ${s.item} and org_id = ${org}`;
    await o`insert into public.stock_serial
              (id, org_id, item_id, serial_no, status, warehouse_id, location_id, created_by)
            values (${serial}, ${org}, ${s.item}, ${"SN" + randomUUID().slice(0, 8)}, 'in_stock',
                    ${s.wh}, ${s.bin}, ${u})`;
    await o.begin(async (tx) => {
      await tx`insert into public.stock_movement
                 (id, org_id, item_id, warehouse_id, location_id, movement_type, qty_delta,
                  unit_id, idempotency_key, actor_user_id)
               values (${mv}, ${org}, ${s.item}, ${s.wh}, ${s.bin}, 'adjustment_increase', 1,
                       ${s.unit}, ${"bleed-" + randomUUID()}, ${u})`;
      await tx`insert into public.stock_movement_serial (org_id, movement_id, serial_id)
               values (${org}, ${mv}, ${serial})`;
    });
  },
  stock_lot_balance: async (o, org, u) => {
    const s = await seedStockChain(o, org, u);
    const lot = randomUUID();
    await o`insert into public.stock_lot (id, org_id, item_id, code, created_by)
            values (${lot}, ${org}, ${s.item}, ${"L" + randomUUID().slice(0, 8)}, ${u})`;
    await o`insert into public.stock_lot_balance
              (org_id, item_id, warehouse_id, location_id, lot_id, on_hand)
            values (${org}, ${s.item}, ${s.wh}, ${s.bin}, ${lot}, 4)`;
  },
  goods_receipt_line_lot: async (o, org, u) => {
    const grl = await seedReceiptLine(o, org, u);
    await o`insert into public.goods_receipt_line_lot (org_id, grl_id, lot_code, qty)
            values (${org}, ${grl}, ${"L" + randomUUID().slice(0, 8)}, 2)`;
  },
  goods_receipt_line_serial: async (o, org, u) => {
    const grl = await seedReceiptLine(o, org, u);
    await o`insert into public.goods_receipt_line_serial (org_id, grl_id, serial_no)
            values (${org}, ${grl}, ${"SN" + randomUUID().slice(0, 8)})`;
  },
  bom: async (o, org, u) => {
    const s = await seedStockChain(o, org, u);
    await o`insert into public.bom (org_id, item_id, version, unit_id, created_by)
            values (${org}, ${s.item}, 1, ${s.unit}, ${u})`;
  },
  bom_line: async (o, org, u) => {
    const s = await seedStockChain(o, org, u);
    const component = await seedStockChain(o, org, u);
    const bom = randomUUID();
    await o`insert into public.bom (id, org_id, item_id, version, unit_id, created_by)
            values (${bom}, ${org}, ${s.item}, 1, ${s.unit}, ${u})`;
    await o`insert into public.bom_line
              (org_id, bom_id, component_item_id, qty_per, unit_id)
            values (${org}, ${bom}, ${component.item}, 2, ${component.unit})`;
  },
  assembly_order: async (o, org, u) => {
    const s = await seedStockChain(o, org, u);
    await o`insert into public.assembly_order
              (org_id, reference, direction, item_id, qty, unit_id, warehouse_id, created_by)
            values (${org}, ${"ASM-" + randomUUID().slice(0, 8)}, 'assemble', ${s.item}, 1,
                    ${s.unit}, ${s.wh}, ${u})`;
  },
  asset_category: async (o, org, u) => {
    await o`insert into public.asset_category (org_id, code, name_en, created_by)
            values (${org}, ${"AC" + randomUUID().slice(0, 6)}, 'Bleed category', ${u})`;
  },
  asset: async (o, org, u) => {
    await seedAsset(o, org, u);
  },
  asset_assignment: async (o, org, u) => {
    const a = await seedAsset(o, org, u);
    await o`insert into public.asset_assignment
              (org_id, asset_id, event, to_user_id, reason, recorded_by)
            values (${org}, ${a.asset}, 'assigned', ${u}, 'bleed', ${u})`;
  },
  asset_inspection: async (o, org, u) => {
    const a = await seedAsset(o, org, u);
    await o`insert into public.asset_inspection
              (org_id, asset_id, inspected_on, inspected_by, passed, condition_found, recorded_by)
            values (${org}, ${a.asset}, '2026-03-01', ${u}, true, 'good', ${u})`;
  },
  asset_maintenance_plan: async (o, org, u) => {
    const a = await seedAsset(o, org, u);
    await o`insert into public.asset_maintenance_plan
              (org_id, asset_id, name_en, interval_days, created_by)
            values (${org}, ${a.asset}, 'Bleed plan', 90, ${u})`;
  },
  asset_maintenance_event: async (o, org, u) => {
    const a = await seedAsset(o, org, u);
    await o`insert into public.asset_maintenance_event
              (org_id, asset_id, performed_on, recorded_by)
            values (${org}, ${a.asset}, '2026-03-02', ${u})`;
  },
  asset_downtime: async (o, org, u) => {
    const a = await seedAsset(o, org, u);
    await o`insert into public.asset_downtime
              (org_id, asset_id, started_at, ended_at, reason, recorded_by)
            values (${org}, ${a.asset}, '2026-03-03T08:00:00Z', '2026-03-03T10:00:00Z',
                    'breakdown', ${u})`;
  },
  asset_disposal: async (o, org, u) => {
    const a = await seedAsset(o, org, u);
    await o`insert into public.asset_disposal
              (org_id, asset_id, reference, method, reason, requested_by)
            values (${org}, ${a.asset}, ${"ADP-" + randomUUID().slice(0, 8)}, 'scrap',
                    'bleed', ${u})`;
  },
  assembly_order_serial: async (o, org, u) => {
    const s = await seedStockChain(o, org, u);
    const order = randomUUID();
    await o`insert into public.assembly_order
              (id, org_id, reference, direction, item_id, qty, unit_id, warehouse_id, created_by)
            values (${order}, ${org}, ${"ASM-" + randomUUID().slice(0, 8)}, 'assemble', ${s.item},
                    1, ${s.unit}, ${s.wh}, ${u})`;
    await o`insert into public.assembly_order_serial (org_id, order_id, serial_no)
            values (${org}, ${order}, ${"SN" + randomUUID().slice(0, 8)})`;
  },
  assembly_order_line: async (o, org, u) => {
    const s = await seedStockChain(o, org, u);
    const component = await seedStockChain(o, org, u);
    const order = randomUUID();
    await o`insert into public.assembly_order
              (id, org_id, reference, direction, item_id, qty, unit_id, warehouse_id, created_by)
            values (${order}, ${org}, ${"ASM-" + randomUUID().slice(0, 8)}, 'assemble', ${s.item},
                    1, ${s.unit}, ${s.wh}, ${u})`;
    await o`insert into public.assembly_order_line
              (org_id, order_id, component_item_id, qty, unit_id)
            values (${org}, ${order}, ${component.item}, 2, ${component.unit})`;
  },
  supplier_return: async (o, org, u) => {
    const sup = randomUUID();
    await o`insert into public.supplier (id, org_id, name) values (${sup}, ${org}, 'Bleed SR Supplier')`;
    await o`insert into public.supplier_return (org_id, reference, supplier_id, reason, created_by)
            values (${org}, ${"BLSR-" + randomUUID().slice(0, 8)}, ${sup}, 'bleed', ${u})`;
  },
  supplier_return_line: async (o, org, u) => {
    const s = await seedStockChain(o, org, u);
    const sup = randomUUID();
    const po = randomUUID();
    const pol = randomUUID();
    const grn = randomUUID();
    const grl = randomUUID();
    const ret = randomUUID();
    await o`insert into public.supplier (id, org_id, name) values (${sup}, ${org}, 'Bleed SRL Supplier')`;
    await o`insert into public.purchase_order (id, org_id, reference, supplier_id, status, created_by)
            values (${po}, ${org}, ${"BLSL-" + randomUUID().slice(0, 8)}, ${sup}, 'approved', ${u})`;
    await o`insert into public.purchase_order_line (id, org_id, po_id, item_name, qty, unit, unit_cost_minor)
            values (${pol}, ${org}, ${po}, 'Bleed', 5, 'ea', 1000)`;
    await o`insert into public.goods_receipt (id, org_id, reference, po_id, status, received_date, created_by)
            values (${grn}, ${org}, ${"BLSLR-" + randomUUID().slice(0, 8)}, ${po}, 'recorded', '2026-02-12', ${u})`;
    await o`insert into public.goods_receipt_line
              (id, org_id, grn_id, po_line_id, ordered_qty, received_qty, accepted_qty)
            values (${grl}, ${org}, ${grn}, ${pol}, 5, 5, 5)`;
    await o`insert into public.supplier_return (id, org_id, reference, supplier_id, reason, created_by)
            values (${ret}, ${org}, ${"BLSRL-" + randomUUID().slice(0, 8)}, ${sup}, 'bleed', ${u})`;
    await o`insert into public.supplier_return_line
              (org_id, return_id, goods_receipt_line_id, item_id, unit_id, qty)
            values (${org}, ${ret}, ${grl}, ${s.item}, ${s.unit}, 1)`;
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

  // H19 normalized contacts (registry gap closed during H20).
  customer_contact: async (o, org) => {
    const c = randomUUID();
    await o`insert into public.customer (id, org_id, name, active)
            values (${c}, ${org}, 'Bleed contact customer', true)`;
    await o`insert into public.customer_contact (org_id, customer_id, name)
            values (${org}, ${c}, 'Bleed contact')`;
  },
  // H14 workspace blueprint (registry gap closed during H20).
  workspace_blueprint_revision: async (o, org, u) => {
    await o`insert into public.workspace_blueprint_revision
              (org_id, revision_no, status, schema_version, blueprint, blueprint_hash,
               proposed_source, created_by)
            values (${org}, ${500 + Math.floor(Math.random() * 400)}, 'draft', 1,
                    '{}'::jsonb, ${"ab".repeat(32)}, 'user_change', ${u})`;
  },

  // H22A inventory foundation. A location needs a warehouse; a unit stands alone.
  unit_of_measure: async (o, org) => {
    await o`insert into public.unit_of_measure (org_id, code, name_en, name_ar, dimension, factor_to_base, is_base)
            values (${org}, ${"BU" + randomUUID().slice(0, 6)}, 'Bleed unit', 'وحدة', 'count', 1, false)`;
  },
  warehouse: async (o, org, u) => {
    await o`insert into public.warehouse (org_id, code, name_en, created_by)
            values (${org}, ${"BW" + randomUUID().slice(0, 6)}, 'Bleed warehouse', ${u})`;
  },
  stock_location: async (o, org, u) => {
    const wh = randomUUID();
    await o`insert into public.warehouse (id, org_id, code, name_en, created_by)
            values (${wh}, ${org}, ${"BL" + randomUUID().slice(0, 6)}, 'Bleed loc warehouse', ${u})`;
    await o`insert into public.stock_location (org_id, warehouse_id, code, name_en)
            values (${org}, ${wh}, ${"BIN" + randomUUID().slice(0, 5)}, 'Bleed bin')`;
  },

  /*
   * H22B stock ledger. Each of these needs a full chain — unit, warehouse,
   * location, item — so one helper builds it and the four seeders share it.
   */
  stock_movement: async (o, org, u) => {
    const s = await seedStockChain(o, org, u);
    await o`insert into public.stock_movement
              (org_id, item_id, warehouse_id, location_id, movement_type, qty_delta,
               unit_id, idempotency_key, actor_user_id)
            values (${org}, ${s.item}, ${s.wh}, ${s.bin}, 'adjustment_increase', 1,
                    ${s.unit}, ${"bleed-" + randomUUID()}, ${u})`;
  },
  stock_balance: async (o, org, u) => {
    const s = await seedStockChain(o, org, u);
    await o`insert into public.stock_balance (org_id, item_id, warehouse_id, location_id, on_hand)
            values (${org}, ${s.item}, ${s.wh}, ${s.bin}, 7)`;
  },
  stock_cost_layer: async (o, org, u) => {
    const s = await seedStockChain(o, org, u);
    const mv = randomUUID();
    await o`insert into public.stock_movement
              (id, org_id, item_id, warehouse_id, location_id, movement_type, qty_delta,
               unit_id, idempotency_key, actor_user_id)
            values (${mv}, ${org}, ${s.item}, ${s.wh}, ${s.bin}, 'goods_receipt', 5,
                    ${s.unit}, ${"bleed-" + randomUUID()}, ${u})`;
    await o`insert into public.stock_cost_layer
              (org_id, item_id, warehouse_id, source_movement_id, qty_received, qty_remaining,
               unit_cost_minor, currency, received_at)
            values (${org}, ${s.item}, ${s.wh}, ${mv}, 5, 5, 100, 'AED', now())`;
  },
  stock_layer_consumption: async (o, org, u) => {
    const s = await seedStockChain(o, org, u);
    const inMv = randomUUID();
    const outMv = randomUUID();
    const layer = randomUUID();
    await o`insert into public.stock_movement
              (id, org_id, item_id, warehouse_id, location_id, movement_type, qty_delta,
               unit_id, idempotency_key, actor_user_id)
            values (${inMv}, ${org}, ${s.item}, ${s.wh}, ${s.bin}, 'goods_receipt', 5,
                    ${s.unit}, ${"bleed-" + randomUUID()}, ${u}),
                   (${outMv}, ${org}, ${s.item}, ${s.wh}, ${s.bin}, 'material_issue', -2,
                    ${s.unit}, ${"bleed-" + randomUUID()}, ${u})`;
    await o`insert into public.stock_cost_layer
              (id, org_id, item_id, warehouse_id, source_movement_id, qty_received,
               qty_remaining, unit_cost_minor, currency, received_at)
            values (${layer}, ${org}, ${s.item}, ${s.wh}, ${inMv}, 5, 3, 100, 'AED', now())`;
    await o`insert into public.stock_layer_consumption
              (org_id, movement_id, layer_id, qty, unit_cost_minor)
            values (${org}, ${outMv}, ${layer}, 2, 100)`;
  },

  // H22C stock operations. Each needs the same chain plus its own header.
  stock_transfer: async (o, org, u) => {
    const s = await seedStockChain(o, org, u);
    const bin2 = randomUUID();
    await o`insert into public.stock_location (id, org_id, warehouse_id, code, name_en)
            values (${bin2}, ${org}, ${s.wh}, ${"B2" + randomUUID().slice(0, 5)}, 'Bleed bin 2')`;
    await o`insert into public.stock_transfer
              (org_id, reference, from_warehouse_id, from_location_id,
               to_warehouse_id, to_location_id, created_by)
            values (${org}, ${"BT-" + randomUUID().slice(0, 8)}, ${s.wh}, ${s.bin},
                    ${s.wh}, ${bin2}, ${u})`;
  },
  stock_transfer_line: async (o, org, u) => {
    const s = await seedStockChain(o, org, u);
    const bin2 = randomUUID();
    const tr = randomUUID();
    await o`insert into public.stock_location (id, org_id, warehouse_id, code, name_en)
            values (${bin2}, ${org}, ${s.wh}, ${"B3" + randomUUID().slice(0, 5)}, 'Bleed bin 3')`;
    await o`insert into public.stock_transfer
              (id, org_id, reference, from_warehouse_id, from_location_id,
               to_warehouse_id, to_location_id, created_by)
            values (${tr}, ${org}, ${"BTL-" + randomUUID().slice(0, 8)}, ${s.wh}, ${s.bin},
                    ${s.wh}, ${bin2}, ${u})`;
    await o`insert into public.stock_transfer_line (org_id, transfer_id, item_id, unit_id, qty)
            values (${org}, ${tr}, ${s.item}, ${s.unit}, 1)`;
  },
  stock_count: async (o, org, u) => {
    const s = await seedStockChain(o, org, u);
    await o`insert into public.stock_count (org_id, reference, warehouse_id, created_by)
            values (${org}, ${"BC-" + randomUUID().slice(0, 8)}, ${s.wh}, ${u})`;
  },
  stock_count_line: async (o, org, u) => {
    const s = await seedStockChain(o, org, u);
    const c = randomUUID();
    await o`insert into public.stock_count (id, org_id, reference, warehouse_id, created_by)
            values (${c}, ${org}, ${"BCL-" + randomUUID().slice(0, 8)}, ${s.wh}, ${u})`;
    await o`insert into public.stock_count_line
              (org_id, count_id, item_id, location_id, unit_id, counted_qty)
            values (${org}, ${c}, ${s.item}, ${s.bin}, ${s.unit}, 3)`;
  },
  stock_reservation: async (o, org, u) => {
    const s = await seedStockChain(o, org, u);
    await o`insert into public.stock_reservation
              (org_id, item_id, warehouse_id, location_id, unit_id, qty, created_by)
            values (${org}, ${s.item}, ${s.wh}, ${s.bin}, ${s.unit}, 2, ${u})`;
  },

  // H22.0 documents. A plan's link table needs a plan and a job; a share needs
  // a subject, and only a customer-addressed kind may be shared.
  week_plan: async (o, org, u) => {
    await o`insert into public.week_plan (org_id, reference, week_start, week_end, title, created_by)
            values (${org}, ${"BLWP-" + randomUUID().slice(0, 8)}, '2026-01-05', '2026-01-11',
                    'Bleed plan', ${u})`;
  },
  week_plan_job: async (o, org, u) => {
    const plan = randomUUID();
    const job = randomUUID();
    await o`insert into public.week_plan (id, org_id, reference, week_start, week_end, created_by)
            values (${plan}, ${org}, ${"BLWJ-" + randomUUID().slice(0, 8)}, '2026-01-12',
                    '2026-01-18', ${u})`;
    await o`insert into public.job (id, org_id, reference, name, status_key, status_category, created_by)
            values (${job}, ${org}, ${"BLW-" + randomUUID().slice(0, 8)}, 'Bleed planned work',
                    'draft', 'draft', ${u})`;
    await o`insert into public.week_plan_job (org_id, week_plan_id, job_id, sort)
            values (${org}, ${plan}, ${job}, 0)`;
  },
  document_share: async (o, org, u) => {
    const q = randomUUID();
    await o`insert into public.quote (id, org_id, reference, customer_name, status, created_by)
            values (${q}, ${org}, ${"BLDS-" + randomUUID().slice(0, 8)}, 'Bleed customer',
                    'draft', ${u})`;
    await o`insert into public.document_share
              (org_id, subject_type, subject_id, token_hash, expires_at, created_by)
            values (${org}, 'quote', ${q},
                    ${randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "")},
                    now() + interval '7 days', ${u})`;
  },

  // H21 work management. A dependency needs two tasks, which need a job.
  task_dependency: async (o, org, u) => {
    const job = randomUUID();
    const preset = randomUUID();
    await o`insert into public.job_preset (id, org_id, code, names, billing_points)
            values (${preset}, ${org}, ${("BL" + randomUUID().slice(0, 6)).toUpperCase()},
                    '{"en":"Bleed preset","ar":"قالب"}'::jsonb, '[]'::jsonb)`;
    await o`insert into public.job (id, org_id, reference, name, preset_id, status_key,
                                    status_category, created_by)
            values (${job}, ${org}, ${"BLJ-" + randomUUID().slice(0, 8)}, 'Bleed work',
                    ${preset}, 'draft', 'draft', ${u})`;
    const a = randomUUID();
    const b = randomUUID();
    await o`insert into public.task (id, org_id, job_id, title, created_by)
            values (${a}, ${org}, ${job}, 'Bleed task A', ${u}),
                   (${b}, ${org}, ${job}, 'Bleed task B', ${u})`;
    await o`insert into public.task_dependency (org_id, task_id, depends_on_task_id, created_by)
            values (${org}, ${b}, ${a}, ${u})`;
  },

  // H20 sales CRM.
  pipeline_stage: async (o, org) => {
    await o`insert into public.pipeline_stage (org_id, key, label, sort, category)
            values (${org}, ${"bleed_" + randomUUID().slice(0, 8)},
                    '{"en":"Bleed stage","ar":"مرحلة"}'::jsonb, 90, 'open')`;
  },
  lead: async (o, org, u) => {
    await o`insert into public.lead (org_id, name, status, created_by)
            values (${org}, 'Bleed lead', 'new', ${u})`;
  },
  opportunity: async (o, org, u) => {
    const stage = "bleedopp_" + randomUUID().slice(0, 8);
    await o`insert into public.pipeline_stage (org_id, key, label, sort, category)
            values (${org}, ${stage}, '{"en":"Bleed opp stage","ar":"مرحلة"}'::jsonb, 91, 'open')`;
    await o`insert into public.opportunity (org_id, name, stage_key, status, created_by)
            values (${org}, 'Bleed opportunity', ${stage}, 'open', ${u})`;
  },
  sales_activity: async (o, org, u) => {
    const lead = randomUUID();
    await o`insert into public.lead (id, org_id, name, status, created_by)
            values (${lead}, ${org}, 'Bleed activity lead', 'new', ${u})`;
    await o`insert into public.sales_activity (org_id, lead_id, kind, body, actor_user_id)
            values (${org}, ${lead}, 'note', 'Bleed note', ${u})`;
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
