/**
 * Shared template building blocks (post-MVP template catalogue). Templates are
 * composed from these blocks instead of copy-pasting structure — one place owns
 * the GCC holiday calendars, the 7-role preset spine, the semantic job-status
 * anchors and the expense costing spine (audit F-2), so eight manifests cannot
 * drift apart. Blocks return NEW objects on every call (manifests stay
 * independently mutable) and everything remains plain data validated by
 * TemplateManifestSchema at build time — no block has install-time behaviour.
 */
import type { CategorySet, HolidayCalendar, RolePresetSet, StatusSet } from "../schemas/artifacts";

/** Bilingual label helper — every template label carries en + ar. */
export const L = (en: string, ar: string) => ({ en, ar });

export type Labels = { en: string; ar: string };

// ── GCC holiday calendars (2026 dates; F-41 — org-editable after install) ────
/** Shared AE + SA calendars. Install picks the org's country; falls back to AE. */
export function gccHolidayCalendars2026(): Record<string, HolidayCalendar> {
  return {
    AE: {
      entries: [
        { starts_on: "2026-01-01", label: L("New Year", "رأس السنة"), kind: "public_holiday" },
        {
          starts_on: "2026-03-19",
          ends_on: "2026-03-22",
          label: L("Eid al-Fitr", "عيد الفطر"),
          kind: "eid",
        },
        {
          starts_on: "2026-05-26",
          ends_on: "2026-05-28",
          label: L("Eid al-Adha", "عيد الأضحى"),
          kind: "eid",
        },
        {
          starts_on: "2026-06-16",
          label: L("Islamic New Year", "رأس السنة الهجرية"),
          kind: "public_holiday",
        },
        {
          starts_on: "2026-08-25",
          label: L("Prophet's Birthday", "المولد النبوي"),
          kind: "public_holiday",
        },
        {
          starts_on: "2026-12-01",
          ends_on: "2026-12-03",
          label: L("National Day", "اليوم الوطني"),
          kind: "public_holiday",
        },
      ],
      ramadan: { starts_on: "2026-02-17", ends_on: "2026-03-18", daily_hours: 6 },
    },
    SA: {
      entries: [
        {
          starts_on: "2026-02-22",
          label: L("Founding Day", "يوم التأسيس"),
          kind: "public_holiday",
        },
        {
          starts_on: "2026-03-19",
          ends_on: "2026-03-22",
          label: L("Eid al-Fitr", "عيد الفطر"),
          kind: "eid",
        },
        {
          starts_on: "2026-05-26",
          ends_on: "2026-05-28",
          label: L("Eid al-Adha", "عيد الأضحى"),
          kind: "eid",
        },
        {
          starts_on: "2026-09-23",
          label: L("National Day", "اليوم الوطني"),
          kind: "public_holiday",
        },
      ],
      ramadan: { starts_on: "2026-02-17", ends_on: "2026-03-18", daily_hours: 6 },
    },
  };
}

// ── Role preset spine ─────────────────────────────────────────────────────────
/** The 7 bootstrap role KEYS are fixed platform-wide (they must match the
 * role_definition rows created at org bootstrap) — templates vary only the
 * LABELS and the manager's money-visibility. owner/admin/accounts stay
 * cost+price privileged; foreman/procurement/viewer never see money. */
export type RoleLabelOverrides = Partial<
  Record<"owner" | "admin" | "manager" | "foreman" | "procurement" | "accounts" | "viewer", Labels>
>;

export function standardRoles(
  labels: RoleLabelOverrides = {},
  opts: { managerSeesCosts?: boolean; managerSeesPrices?: boolean } = {},
): RolePresetSet {
  return {
    roles: [
      {
        key: "owner",
        archetype: "owner",
        labels: labels.owner ?? L("Owner", "المالك"),
        cost_privileged: true,
        price_privileged: true,
      },
      {
        key: "admin",
        archetype: "admin",
        labels: labels.admin ?? L("Admin", "مشرف النظام"),
        cost_privileged: true,
        price_privileged: true,
      },
      {
        key: "manager",
        archetype: "manager",
        labels: labels.manager ?? L("Manager", "مدير"),
        cost_privileged: opts.managerSeesCosts ?? false,
        price_privileged: opts.managerSeesPrices ?? false,
      },
      {
        key: "foreman",
        archetype: "foreman",
        labels: labels.foreman ?? L("Supervisor", "مشرف ميداني"),
        cost_privileged: false,
        price_privileged: false,
      },
      {
        key: "procurement",
        archetype: "procurement",
        labels: labels.procurement ?? L("Procurement", "مشتريات"),
        cost_privileged: false,
        price_privileged: false,
      },
      {
        key: "accounts",
        archetype: "accounts",
        labels: labels.accounts ?? L("Accounts", "حسابات"),
        cost_privileged: true,
        price_privileged: true,
      },
      {
        key: "viewer",
        archetype: "viewer",
        labels: labels.viewer ?? L("Viewer", "مشاهد"),
        cost_privileged: false,
        price_privileged: false,
      },
    ],
  };
}

// ── Job status spine ──────────────────────────────────────────────────────────
/** Standard status set covering every required semantic anchor
 * (draft/active/done/cancelled + on_hold). Templates rename the ACTIVE and DONE
 * statuses to their domain language and may append extra active statuses. */
export function standardJobStatuses(
  overrides: {
    active?: Labels;
    done?: Labels;
    extraActive?: Array<{ status_key: string; labels: Labels }>;
  } = {},
): StatusSet {
  const extra = overrides.extraActive ?? [];
  return {
    entity: "job",
    statuses: [
      { status_key: "draft", labels: L("Draft", "مسودة"), semantic_category: "draft", sort: 0 },
      {
        status_key: "in_progress",
        labels: overrides.active ?? L("In Progress", "قيد التنفيذ"),
        semantic_category: "active",
        sort: 1,
      },
      {
        status_key: "on_hold",
        labels: L("On Hold — awaiting decision", "متوقف بانتظار قرار"),
        semantic_category: "on_hold",
        sort: 2,
      },
      ...extra.map((e, i) => ({
        status_key: e.status_key,
        labels: e.labels,
        semantic_category: "active" as const,
        sort: 3 + i,
      })),
      {
        status_key: "completed",
        labels: overrides.done ?? L("Completed", "مكتمل"),
        semantic_category: "done" as const,
        sort: 3 + extra.length,
      },
      {
        status_key: "closed",
        labels: L("Closed", "مغلق"),
        semantic_category: "done" as const,
        sort: 4 + extra.length,
      },
      {
        status_key: "cancelled",
        labels: L("Cancelled", "ملغى"),
        semantic_category: "cancelled" as const,
        sort: 5 + extra.length,
      },
    ],
  };
}

// ── Expense costing spine (audit F-2: every expense category maps to costing) ─
type ExpenseCategory = CategorySet["categories"][number];

/** The shared expense spine every template starts from: direct job costs map to
 * job_materials/job_other; shop running costs map to overhead. Templates insert
 * domain categories via `extras` (placed after the spine, before "other"). */
export function commonExpenseCategories(extras: ExpenseCategory[] = []): CategorySet {
  return {
    kind: "expense",
    categories: [
      {
        key: "materials",
        labels: L("Materials", "مواد"),
        costing_mapping: "job_materials",
        retired: false,
      },
      {
        key: "labour",
        labels: L("Labour", "عمالة"),
        costing_mapping: "job_other",
        retired: false,
      },
      {
        key: "outsourced_work",
        labels: L("Outsourced work", "أعمال خارجية"),
        costing_mapping: "job_other",
        retired: false,
      },
      {
        key: "transport",
        labels: L("Transport", "نقل"),
        costing_mapping: "job_other",
        retired: false,
      },
      ...extras,
      { key: "fuel", labels: L("Fuel", "وقود"), costing_mapping: "overhead", retired: false },
      {
        key: "tools_equipment",
        labels: L("Tools & equipment", "عدد ومعدات"),
        costing_mapping: "overhead",
        retired: false,
      },
      {
        key: "rent_facility",
        labels: L("Rent/facility", "إيجار ومرافق"),
        costing_mapping: "overhead",
        retired: false,
      },
      { key: "other", labels: L("Other", "أخرى"), costing_mapping: "overhead", retired: false },
    ],
  };
}
