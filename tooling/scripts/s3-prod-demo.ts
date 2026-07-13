/**
 * S3 production DoD demo (Arabic, phone-first heartbeat) — runs the REAL service
 * layer against the production Supabase (DIRECT_URL / DATABASE_URL from .env.local),
 * then deletes every synthetic row (0 leftovers). Narrated evidence for the S3
 * completion report; mirrors the S2 demo. NOT a test file — a one-shot walkthrough.
 *
 * It proves, against production: a foreman files a full daily report (work +
 * material + labour) in Arabic; labour COST is frozen behind the D-6.2 wall (owner
 * sees it, the foreman's own session reads ZERO cost rows); attendance derives from
 * hours; a manager reviews it; a manual attendance mark wins; a blocker issue is
 * raised; and the outbox carries submitted/reviewed/issue.raised events.
 */
import "./load-env";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import type { Ctx } from "@/platform/tenancy";
import { closeAppDb, sql, withCtx } from "@/platform/tenancy";
import { createOrgForUser } from "@/platform/auth/identity";
import { installTemplate, TEMPLATE_BOATBUILDING } from "@/platform/config";
import { createJobFromPreset, addCrewMember } from "@/modules/jobs/service";
import { createEmployee, setEmployeeTerms } from "@/modules/masters/service";
import { submitDailyReport, reviewReport, getReportDetail } from "@/modules/reports/service";
import { markAttendance, listAttendanceForDate } from "@/modules/attendance/service";
import { createIssue } from "@/modules/issues/service";

const owner = postgres(process.env.DIRECT_URL!, { max: 1, onnotice: () => {} });
const log = (m: string) => console.log(m);
const today = new Date().toISOString().slice(0, 10);

const ownerUser = randomUUID();
const foremanUser = randomUUID();
const managerUser = randomUUID();
let orgId = "";

const ctx = (u: string, priv: boolean): Ctx => ({
  orgId,
  userId: u,
  costPrivileged: priv,
  pricePrivileged: priv,
  requestId: "s3-prod-demo",
});

async function seedUser(id: string, label: string) {
  await owner`
    insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    values (${id}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            ${`s3demo-${label}-${id.slice(0, 8)}@example.com`}, '{"full_name":"S3 Demo"}'::jsonb, now(), now())`;
}

async function run() {
  log("── S3 production demo (Arabic heartbeat) ─────────────────────────");
  await seedUser(ownerUser, "owner");
  await seedUser(foremanUser, "foreman");
  await seedUser(managerUser, "manager");
  orgId = await createOrgForUser(ownerUser, {
    name: "قوارب التجربة",
    country: "AE",
    baseCurrency: "AED",
  });
  await owner`insert into public.membership (user_id, org_id, role_key) values (${foremanUser}, ${orgId}, 'foreman')`;
  await owner`insert into public.membership (user_id, org_id, role_key) values (${managerUser}, ${orgId}, 'manager')`;
  const { presetIds } = await installTemplate(ctx(ownerUser, true), TEMPLATE_BOATBUILDING.key);
  log(`✓ org "قوارب التجربة" + template installed (org ${orgId.slice(0, 8)}…)`);

  const ali = (
    await createEmployee(ctx(ownerUser, true), "owner", { name: "علي", userId: foremanUser })
  ).id;
  const sami = (await createEmployee(ctx(ownerUser, true), "owner", { name: "سامي" })).id;
  await setEmployeeTerms(ctx(ownerUser, true), "owner", ali, { salaryMinor: 20800, otRate: 1.25 }); // 100/hr
  await setEmployeeTerms(ctx(ownerUser, true), "owner", sami, { salaryMinor: 41600, otRate: 1.5 }); // 200/hr
  const itemId = randomUUID();
  await owner`insert into public.item (id, org_id, sku, name, category_key, unit, unit_cost_minor, active)
              values (${itemId}, ${orgId}, ${`راتنج-${randomUUID().slice(0, 4)}`}, 'راتنج إيبوكسي', 'raw_material', 'لتر', 5000, true)`;
  const { id: jobId, reference } = await createJobFromPreset(ctx(ownerUser, true), "owner", {
    presetId: presetIds["13S"]!,
    name: "سكيف التجربة",
  });
  await addCrewMember(ctx(ownerUser, true), "owner", jobId, ali);
  log(`✓ employees علي/سامي (+terms), item راتنج إيبوكسي, job ${reference} سكيف التجربة, crew علي`);

  // 1) Foreman files a full daily report (NON cost-privileged session).
  const { id: reportId, deduped } = await submitDailyReport(ctx(foremanUser, false), "foreman", {
    jobId,
    reportDate: today,
    summary: "تم تصفيح بدن القارب بطبقتين من الجل كوت.",
    blockers: "بانتظار توريد الراتنج",
    idempotencyKey: `dr:${jobId}:${today}`,
    workLines: [{ stageKey: "lamination", description: "طبقتا جل كوت", progressNote: "~40%" }],
    materialLines: [
      { itemId, itemName: "متجاهَل — يؤخذ من الكتالوج", qty: 3, unit: "متجاهَل" },
      { itemName: "ورق صنفرة 80", qty: 5, unit: "ورقة" },
    ],
    labourLines: [
      { employeeId: ali, normalHours: 8, otHours: 2 },
      { employeeId: sami, normalHours: 8, otHours: 0 },
    ],
  });
  log(`✓ foreman submitted daily report (${reportId.slice(0, 8)}…, deduped=${deduped})`);

  // 2) The cost wall: owner sees frozen cost; the foreman's own session reads none.
  const asOwner = await getReportDetail(ctx(ownerUser, true), "owner", reportId);
  const aliCost = asOwner!.labourLines.find((l) => l.employeeId === ali)!.labourCostMinor;
  const samiCost = asOwner!.labourLines.find((l) => l.employeeId === sami)!.labourCostMinor;
  const asForeman = await getReportDetail(ctx(foremanUser, false), "foreman", reportId);
  const foremanSeesCost = asForeman!.labourLines.some((l) => l.labourCostMinor !== null);
  const rawForemanCostRows = (await withCtx(ctx(foremanUser, false), (tx) =>
    tx.execute(
      sql`select count(*)::int as n from public.report_labour_cost where report_id = ${reportId}`,
    ),
  )) as unknown as Array<{ n: number }>;
  log(
    `✓ frozen labour cost — owner: علي=${aliCost} (8×100+2×100×1.25=1050), سامي=${samiCost} (8×200=1600); ` +
      `foreman DTO cost=${foremanSeesCost ? "LEAK!" : "redacted"}; foreman DB cost rows=${rawForemanCostRows[0]!.n} (RLS wall)`,
  );

  // 3) Attendance derived from labour hours.
  const grid1 = await listAttendanceForDate(ctx(ownerUser, true), "owner", today);
  const aliAtt = grid1.find((r) => r.employeeId === ali)!;
  log(`✓ attendance derived — علي=${aliAtt.status} (source=${aliAtt.source})`);

  // 4) Manager reviews the report (submitted → reviewed, immutable).
  await reviewReport(ctx(managerUser, false), "manager", reportId);
  const reviewed = await getReportDetail(ctx(ownerUser, true), "owner", reportId);
  log(`✓ manager reviewed — status=${reviewed!.status}`);

  // 5) Manual attendance mark wins over derivation.
  await markAttendance(ctx(managerUser, false), "manager", {
    employeeId: sami,
    attendanceDate: today,
    status: "sick",
    note: "إجازة مرضية",
  });
  const grid2 = await listAttendanceForDate(ctx(ownerUser, true), "owner", today);
  const samiAtt = grid2.find((r) => r.employeeId === sami)!;
  log(`✓ manual attendance wins — سامي=${samiAtt.status} (source=${samiAtt.source})`);

  // 6) Foreman raises a blocker issue on the assigned job.
  const { id: issueId } = await createIssue(ctx(foremanUser, false), "foreman", {
    jobId,
    title: "شرخ في القالب",
    severity: "high",
    isBlocker: true,
  });
  log(`✓ foreman raised blocker issue (${issueId.slice(0, 8)}…)`);

  // 7) Outbox events emitted for the heartbeat.
  const events = (await owner`
    select name, count(*)::int as n from public.domain_event
    where org_id = ${orgId} and name in ('daily_report/submitted','daily_report/reviewed','issue/raised')
    group by name order by name`) as unknown as Array<{ name: string; n: number }>;
  log(`✓ outbox events: ${events.map((e) => `${e.name}×${e.n}`).join(", ")}`);

  // ── cleanup: delete ALL synthetic rows (0 leftovers) ──────────────────────
  await owner`update public.job set current_stage_id = null where org_id = ${orgId}`;
  for (const t of [
    "report_labour_cost",
    "report_labour_line",
    "report_material_line",
    "report_work_line",
    "daily_report",
    "attendance",
    "issue",
    "domain_event",
    "task",
    "job_crew",
    "job_stage",
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
    "comment",
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
  await owner`delete from public.user_profile where id = any(${[ownerUser, foremanUser, managerUser]}::uuid[])`;
  await owner`delete from auth.users where id = any(${[ownerUser, foremanUser, managerUser]}::uuid[])`;
  const leftover = (await owner`
    select count(*)::int as n from public.org where id = ${orgId}`) as unknown as Array<{
    n: number;
  }>;
  log(`✓ cleanup complete — org rows left: ${leftover[0]!.n} (expect 0)`);
  log("── demo complete ────────────────────────────────────────────────");
}

run()
  .then(async () => {
    await owner.end({ timeout: 5 });
    await closeAppDb();
    process.exit(0);
  })
  .catch(async (e) => {
    console.error("DEMO FAILED:", e);
    // best-effort cleanup on failure
    try {
      if (orgId) {
        await owner`update public.job set current_stage_id = null where org_id = ${orgId}`;
        for (const t of [
          "report_labour_cost",
          "report_labour_line",
          "report_material_line",
          "report_work_line",
          "daily_report",
          "attendance",
          "issue",
          "domain_event",
          "task",
          "job_crew",
          "job_stage",
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
          "comment",
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
        await owner`delete from public.user_profile where id = any(${[ownerUser, foremanUser, managerUser]}::uuid[])`;
        await owner`delete from auth.users where id = any(${[ownerUser, foremanUser, managerUser]}::uuid[])`;
      }
    } catch (ce) {
      console.error("cleanup after failure also errored:", ce);
    }
    await owner.end({ timeout: 5 });
    process.exit(1);
  });
