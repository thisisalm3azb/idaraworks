/**
 * S1 integration (doc 11 DoD/AC): template #1 install populates a fresh org;
 * a config edit produces a diffable, UNDOABLE revision with data intact;
 * D-9.2 guards reject stranding changes; masters CRUD flows through the
 * command/audit path; the salary/HR privileged side-tables are DB-level walls;
 * the walking skeleton runs end-to-end (preset → 24C-001 → daily report) with
 * outbox events, uniqueness, and the entitlement gate.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAppDb, sql, withCtx, type Ctx } from "@/platform/tenancy";
import { createOrgForUser } from "@/platform/auth/identity";
import {
  applyConfigChange,
  installTemplate,
  undoRevision,
  ConfigGuardError,
  TEMPLATE_BOATBUILDING,
} from "@/platform/config";
import { loadOrgTerminology, term } from "@/platform/terminology";
import {
  createCustomer,
  createEmployee,
  createItem,
  createSupplier,
  createTeam,
  getEmployeeHr,
  getEmployeeTerms,
  listItems,
  setEmployeeHr,
  setEmployeeTerms,
} from "@/modules/masters/service";
import { invalidateEntitlements } from "@/platform/entitlements";
import { createJobFromPreset, JobLimitError, listJobs } from "@/modules/jobs/service";
import { DuplicateReportError, submitDailyReport } from "@/modules/reports/service";
import { ForbiddenError } from "@/platform/authz";
import { ownerSql } from "./helpers";

const owner = ownerSql();
const run = randomUUID().slice(0, 8);
const ownerUser = randomUUID();
const managerUser = randomUUID();
let orgId = "";

const ctxOf = (userId: string, priv: boolean): Ctx => ({
  orgId,
  userId,
  costPrivileged: priv,
  pricePrivileged: priv,
  requestId: "s1-test",
});

async function seedAuthUser(id: string, label: string) {
  await owner`
    insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    values (${id}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            ${`s1-${label}-${run}@example.com`}, '{"full_name":"S1 Test"}'::jsonb, now(), now())`;
}

beforeAll(async () => {
  await seedAuthUser(ownerUser, "owner");
  await seedAuthUser(managerUser, "manager");
  orgId = await createOrgForUser(ownerUser, { name: "S1 Org", country: "AE", baseCurrency: "AED" });
  // Second member with the manager role (fixture insert — invite flow is
  // Phase C-tested; here we need the archetype for the HR wall test).
  await owner`insert into public.membership (user_id, org_id, role_key) values (${managerUser}, ${orgId}, 'manager')`;
}, 120_000);

afterAll(async () => {
  for (const t of [
    "daily_report",
    "domain_event",
    "job",
    "employee_terms",
    "employee_hr",
    "employee",
    "team",
    "item",
    "customer",
    "supplier",
    "job_preset",
    "reference_sequence",
    "org_holiday_calendar",
    "config_revision",
    "org_entitlement_override",
    "audit_log",
    "activity",
    "app_settings",
    "sign_in_log",
    "org_plan_state",
    "membership",
    "role_definition",
    "company",
  ]) {
    await owner.unsafe(`delete from public.${t} where org_id = $1`, [orgId]);
  }
  await owner`delete from public.org where id = ${orgId}`;
  await owner`delete from public.user_profile where id = any(${[ownerUser, managerUser]}::uuid[])`;
  await owner`delete from auth.users where id = any(${[ownerUser, managerUser]}::uuid[])`;
  await owner.end({ timeout: 5 });
  await closeAppDb();
});

describe("template install (DoD: fresh org installs template #1)", () => {
  it("populates stages, statuses, categories, patterns, roles, holidays, presets, terms", async () => {
    const ctx = ctxOf(ownerUser, true);
    const result = await installTemplate(ctx, TEMPLATE_BOATBUILDING.key);
    expect(result.revisionIds.length).toBeGreaterThanOrEqual(10 + 9); // artifacts + 9 presets
    expect(Object.keys(result.presetIds)).toHaveLength(9);

    const settings = await withCtx(ctx, async (tx) => {
      const rows = (await tx.execute(sql`
        select key, value from public.app_settings where org_id = ${orgId}
      `)) as unknown as Array<{ key: string; value: unknown }>;
      return new Map(rows.map((r) => [r.key, r.value]));
    });
    expect((settings.get("config.stage_template") as { stages: unknown[] }).stages).toHaveLength(
      11,
    );
    expect(settings.get("terminology.template")).toBe(TEMPLATE_BOATBUILDING.key);
    expect((settings.get("config.template") as { key: string }).key).toBe(
      TEMPLATE_BOATBUILDING.key,
    );

    // Role presets applied: template #1's manager is the Workshop Manager variant.
    const roles = (await owner`
      select key, label from public.role_definition where org_id = ${orgId} and key = 'manager'
    `) as unknown as Array<{ key: string; label: { en: string } }>;
    expect(roles[0]!.label.en).toBe("Workshop Manager");

    // AE holiday calendar materialized (F-41).
    const holidays = (await owner`
      select count(*)::int as n from public.org_holiday_calendar where org_id = ${orgId}
    `) as unknown as Array<{ n: number }>;
    expect(holidays[0]!.n).toBeGreaterThanOrEqual(5);

    // Terminology resolves through the installed template: job → Boat / قارب.
    const termsEn = await loadOrgTerminology(ctx, "en");
    expect(term("job", termsEn, "singular")).toBe("Boat");
    const termsAr = await loadOrgTerminology(ctx, "ar");
    expect(term("job", termsAr, "plural")).toBe("قوارب");
  }, 180_000);

  it("is idempotence-guarded: a second install is rejected", async () => {
    await expect(
      installTemplate(ctxOf(ownerUser, true), TEMPLATE_BOATBUILDING.key),
    ).rejects.toThrow(ConfigGuardError);
  });
});

describe("config edit → diffable, undoable revision (DoD)", () => {
  it("terminology edit produces a revision; undo restores with data intact", async () => {
    const ctx = ctxOf(ownerUser, true);
    // Live data BEFORE the edit — must survive the undo.
    const { id: employeeId } = await createEmployee(ctx, "owner", { name: "Undo Survivor" });

    const { revisionId } = await applyConfigChange(
      ctx,
      "terminology.overrides",
      {
        job: {
          en: { singular: "Vessel", plural: "Vessels" },
          ar: { singular: "سفينة", plural: "سفن", gender: "f" },
        },
      },
      { summary: "Rename job to Vessel" },
    );
    expect(term("job", await loadOrgTerminology(ctx, "en"), "singular")).toBe("Vessel");

    // The revision carries the full before/after (diffable).
    const revs = (await owner`
      select before_data, after_data from public.config_revision
      where org_id = ${orgId} and id = ${revisionId}
    `) as unknown as Array<{ before_data: unknown; after_data: { job: unknown } }>;
    expect(revs[0]!.after_data.job).toBeTruthy();

    // Undo → template term returns; the employee row is intact.
    await undoRevision(ctx, revisionId);
    expect(term("job", await loadOrgTerminology(ctx, "en"), "singular")).toBe("Boat");
    const emp = (await owner`
      select name from public.employee where org_id = ${orgId} and id = ${employeeId}
    `) as unknown as Array<{ name: string }>;
    expect(emp[0]!.name).toBe("Undo Survivor");
  });

  it("guard atomicity: a rejected change writes NOTHING (no revision, no artifact)", async () => {
    const ctx = ctxOf(ownerUser, true);
    await createItem(ctx, "owner", {
      sku: `GUARD-${run}`,
      name: "Guard Item",
      categoryKey: "fiberglass",
      unit: "pcs",
    });
    const before = (await owner`
      select count(*)::int as n from public.config_revision where org_id = ${orgId}
    `) as unknown as Array<{ n: number }>;

    // Removing the in-use "fiberglass" category must be rejected (D-9.2).
    const gutted = {
      kind: "item",
      categories: [{ key: "resin", labels: { en: "Resin", ar: "ريزن" }, retired: false }],
    };
    await expect(applyConfigChange(ctx, "config.categories.item", gutted)).rejects.toThrow(
      ConfigGuardError,
    );

    const after = (await owner`
      select count(*)::int as n from public.config_revision where org_id = ${orgId}
    `) as unknown as Array<{ n: number }>;
    expect(after[0]!.n).toBe(before[0]!.n); // atomic: nothing written
    // The artifact itself is unchanged (still 17 categories).
    const cats = (await owner`
      select value from public.app_settings where org_id = ${orgId} and key = 'config.categories.item'
    `) as unknown as Array<{ value: { categories: unknown[] } }>;
    expect(cats[0]!.value.categories).toHaveLength(17);
  });

  it("status keys held by jobs cannot be removed (D-9.2)", async () => {
    const ctx = ctxOf(ownerUser, true);
    const presets = (await owner`
      select id::text as id from public.job_preset where org_id = ${orgId} and code = '24C'
    `) as unknown as Array<{ id: string }>;
    await createJobFromPreset(ctx, "owner", { presetId: presets[0]!.id, name: "Guard Boat" });

    // Schema-VALID set (every category still mapped) that renames the in-use
    // key draft → draft2 — the D-9.2 guard, not the schema, must reject it.
    const renamed = {
      entity: "job",
      statuses: TEMPLATE_BOATBUILDING.status_sets.job.statuses.map((s) =>
        s.status_key === "draft" ? { ...s, status_key: "draft2" } : s,
      ),
    };
    await expect(applyConfigChange(ctx, "config.status_set.job", renamed)).rejects.toThrow(
      ConfigGuardError,
    );
  });
});

describe("masters through the command path + privileged walls", () => {
  it("CRUD writes audit rows atomically", async () => {
    const ctx = ctxOf(ownerUser, true);
    await createTeam(ctx, "owner", { name: "24ft Team", kind: "line" });
    await createCustomer(ctx, "owner", { name: "Al Marfa Marine", country: "AE" });
    await createSupplier(ctx, "owner", { name: "Gulf Composites" });
    const audits = (await owner`
      select action from public.audit_log where org_id = ${orgId}
      and action in ('team.create', 'customer.create', 'supplier.create', 'employee.create', 'item.create')
    `) as unknown as Array<{ action: string }>;
    const actions = new Set(audits.map((a) => a.action));
    for (const expected of [
      "team.create",
      "customer.create",
      "supplier.create",
      "employee.create",
      "item.create",
    ]) {
      expect(actions.has(expected), expected).toBe(true);
    }
  });

  it("employee_terms is a DB cost wall: non-cost-privileged ctx reads ZERO rows", async () => {
    const ctx = ctxOf(ownerUser, true);
    const { id: employeeId } = await createEmployee(ctx, "owner", { name: "Paid Worker" });
    await setEmployeeTerms(ctx, "owner", employeeId, { salaryMinor: 416000 });

    // Privileged read sees the derived hourly (416000/208 = 2000).
    const seen = await getEmployeeTerms(ctx, employeeId);
    expect(seen?.hourlyCostMinor).toBe(2000);

    // The SAME user without the cost flag: RLS filters at the DATABASE.
    const unprivileged = await getEmployeeTerms(ctxOf(ownerUser, false), employeeId);
    expect(unprivileged).toBeNull();
  });

  it("employee_hr is an owner/admin wall: a manager-archetype session reads ZERO rows", async () => {
    const ctx = ctxOf(ownerUser, true);
    const { id: employeeId } = await createEmployee(ctx, "owner", { name: "HR Worker" });
    await setEmployeeHr(ctx, "owner", employeeId, { visaExpiry: "2027-06-30" });
    expect((await getEmployeeHr(ctx, employeeId))?.visaExpiry).toBe("2027-06-30");

    // managerUser holds the 'manager' role — app.current_archetype() ≠ owner/admin.
    const managerRead = await getEmployeeHr(ctxOf(managerUser, false), employeeId);
    expect(managerRead).toBeNull();
  });

  it("item costs/prices are serializer-redacted by ctx flags (F-23)", async () => {
    const ctx = ctxOf(ownerUser, true);
    await createItem(ctx, "owner", {
      sku: `RES-${run}`,
      name: "Vinylester Resin",
      categoryKey: "resin",
      unit: "kg",
      unitCostMinor: 4500,
      sellingPriceMinor: 6000,
    });
    const privileged = (await listItems(ctx, "owner")).find((i) => i.sku === `RES-${run}`)!;
    expect(privileged.unitCostMinor).toBe(4500);
    const redacted = (await listItems(ctxOf(ownerUser, false), "owner")).find(
      (i) => i.sku === `RES-${run}`,
    )!;
    expect(redacted.unitCostMinor).toBeNull();
    expect(redacted.sellingPriceMinor).toBeNull();
  });

  it("unknown/retired item category is rejected", async () => {
    await expect(
      createItem(ctxOf(ownerUser, true), "owner", {
        sku: `BAD-${run}`,
        name: "Bad",
        categoryKey: "no_such_category",
        unit: "pcs",
      }),
    ).rejects.toThrow(/unknown or retired/);
  });
});

describe("review fixes (0023 + pipeline hardening)", () => {
  it("an IN-USE status key's semantic category is frozen (anchor rule)", async () => {
    const ctx = ctxOf(ownerUser, true);
    // Jobs exist holding 'draft' — remapping draft's category must be rejected.
    const remapped = {
      entity: "job",
      statuses: TEMPLATE_BOATBUILDING.status_sets.job.statuses.map((s) =>
        s.status_key === "draft" ? { ...s, semantic_category: "cancelled" as const } : s,
      ),
    };
    await expect(applyConfigChange(ctx, "config.status_set.job", remapped)).rejects.toThrow(
      /semantic category/,
    );
  });

  it("a manager session CANNOT flip role privilege flags at the DB (CM fix)", async () => {
    // Direct UPDATE as the manager-archetype session: the 0023 policy pins
    // role_definition writes to owner/admin AT THE DATABASE.
    await withCtx(ctxOf(managerUser, false), (tx) =>
      tx.execute(sql`
        update public.role_definition set cost_privileged = true
        where org_id = ${orgId} and key = 'manager'
      `),
    );
    const flags = (await owner`
      select cost_privileged from public.role_definition
      where org_id = ${orgId} and key = 'manager'
    `) as unknown as Array<{ cost_privileged: boolean }>;
    expect(flags[0]!.cost_privileged).toBe(false); // untouched — 0 rows matched
  });

  it("a non-author CANNOT rewrite a colleague's daily report (0023)", async () => {
    const jobs = (await owner`
      select id::text as id from public.job where org_id = ${orgId} limit 1
    `) as unknown as Array<{ id: string }>;
    const reportId = randomUUID();
    await owner`
      insert into public.daily_report (id, org_id, job_id, report_date, summary, submitted_by)
      values (${reportId}, ${orgId}, ${jobs[0]!.id}, '2026-07-01', 'owner wrote this', ${ownerUser})
    `;
    await withCtx(ctxOf(managerUser, false), (tx) =>
      tx.execute(sql`
        update public.daily_report set summary = 'tampered' where id = ${reportId}
      `),
    );
    const after = (await owner`
      select summary from public.daily_report where id = ${reportId}
    `) as unknown as Array<{ summary: string }>;
    expect(after[0]!.summary).toBe("owner wrote this");
  });

  it("re-install after undoing the marker CONVERGES (preset ids reused, no code collision)", async () => {
    const ctx = ctxOf(ownerUser, true);
    const before = (await owner`
      select count(*)::int as n from public.job_preset where org_id = ${orgId}
    `) as unknown as Array<{ n: number }>;
    // Undo the install marker (jsonb-null) — the state the UI's Undo produces.
    await applyConfigChange(ctx, "config.template", null, { summary: "test: unset marker" });
    const again = await installTemplate(ctx, TEMPLATE_BOATBUILDING.key);
    expect(Object.keys(again.presetIds)).toHaveLength(9);
    const after = (await owner`
      select count(*)::int as n from public.job_preset where org_id = ${orgId}
    `) as unknown as Array<{ n: number }>;
    expect(after[0]!.n).toBe(before[0]!.n); // reused rows, no duplicates
  }, 180_000);
});

describe("walking skeleton (DoD: job from preset + daily report, end-to-end)", () => {
  it("creates 24C hull numbers sequentially and emits job.created to the outbox", async () => {
    const ctx = ctxOf(ownerUser, true);
    const presets = (await owner`
      select id::text as id from public.job_preset where org_id = ${orgId} and code = '13S'
    `) as unknown as Array<{ id: string }>;
    const presetId = presets[0]!.id;

    const first = await createJobFromPreset(ctx, "owner", { presetId, name: "First Skiff" });
    const second = await createJobFromPreset(ctx, "owner", { presetId, name: "Second Skiff" });
    expect(first.reference).toBe("13S-001");
    expect(second.reference).toBe("13S-002");

    const events = (await owner`
      select payload from public.domain_event
      where org_id = ${orgId} and name = 'job/created' and payload->>'jobId' = ${first.id}
    `) as unknown as Array<{ payload: { reference: string } }>;
    expect(events).toHaveLength(1);
    expect(events[0]!.payload.reference).toBe("13S-001");

    const jobs = await listJobs(ctx, "owner");
    expect(jobs.find((j) => j.id === first.id)?.statusCategory).toBe("draft");
  });

  it("submits ONE daily report per job per day and emits the event", async () => {
    const ctx = ctxOf(ownerUser, true);
    const job = (await listJobs(ctx, "owner"))[0]!;
    const { id } = await submitDailyReport(ctx, "owner", {
      jobId: job.id,
      reportDate: "2026-07-13",
      summary: "Lamination completed on the port hull.",
      blockers: "Waiting on resin delivery",
    });
    const events = (await owner`
      select 1 as ok from public.domain_event
      where org_id = ${orgId} and name = 'daily_report/submitted' and payload->>'reportId' = ${id}
    `) as unknown as Array<{ ok: number }>;
    expect(events).toHaveLength(1);

    await expect(
      submitDailyReport(ctx, "owner", {
        jobId: job.id,
        reportDate: "2026-07-13",
        summary: "duplicate",
      }),
    ).rejects.toThrow(DuplicateReportError);
  });

  it("foreman may only report on an assigned job (doc 06 condition)", async () => {
    const ctx = ctxOf(ownerUser, true);
    const job = (await listJobs(ctx, "owner")).find((j) => j.name === "Second Skiff")!;
    const foremanCtx = ctxOf(managerUser, false); // fixture user; archetype arg drives the check
    await expect(
      submitDailyReport(foremanCtx, "foreman", {
        jobId: job.id,
        reportDate: "2026-07-14",
        summary: "not my job",
      }),
    ).rejects.toThrow(ForbiddenError);

    await owner`update public.job set foreman_user_id = ${managerUser} where id = ${job.id}`;
    const { id } = await submitDailyReport(foremanCtx, "foreman", {
      jobId: job.id,
      reportDate: "2026-07-14",
      summary: "my assigned job",
    });
    expect(id).toBeTruthy();
  });

  it("enforces limit.active_jobs via an entitlement override", async () => {
    const ctx = ctxOf(ownerUser, true);
    const current = (await listJobs(ctx, "owner")).length;
    await owner`
      insert into public.org_entitlement_override (org_id, entitlement_key, limit_value, reason)
      values (${orgId}, 'limit.active_jobs', ${current}, 's1 test cap')
      on conflict (org_id, entitlement_key) do update set limit_value = ${current}
    `;
    invalidateEntitlements(orgId); // same-process cache bust (Phase D seam)
    const presets = (await owner`
      select id::text as id from public.job_preset where org_id = ${orgId} and code = '24C'
    `) as unknown as Array<{ id: string }>;
    await expect(
      createJobFromPreset(ctx, "owner", { presetId: presets[0]!.id, name: "One Too Many" }),
    ).rejects.toThrow(JobLimitError);
  }, 90_000);
});
