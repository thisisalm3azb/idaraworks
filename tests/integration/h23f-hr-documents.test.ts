/**
 * H23F — HR documents through the ONE document pipeline.
 *
 * What a screen cannot prove: a payslip renders from its frozen snapshot in
 * both languages; self-narrowing holds (an employee reads their own payslip
 * and letters, nobody else's, and cost-walled documents refuse the
 * unprivileged); statuses watermark honestly; the salary certificate certifies
 * from the latest ISSUED payslip rather than live terms.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAppDb, type Ctx } from "@/platform/tenancy";
import { createOrgForUser } from "@/platform/auth/identity";
import { createEmployee } from "@/modules/masters/service";
import { decideApproval, listInbox } from "@/modules/approvals/service";
import { recordCompensationChange } from "@/modules/hr/people";
import {
  createPayGroup,
  createPayRun,
  calculatePayRun,
  submitPayRunForApproval,
  finalizePayRun,
} from "@/modules/payroll/service";
import { documentModel, documentHtml } from "@/modules/documents/service";
import { markFixtureOrg, ownerSql, wipeOrgs } from "./helpers";

const owner = ownerSql();
const run = randomUUID().slice(0, 8);
const userA = randomUUID(); // owner
const userE = randomUUID(); // employee (foreman archetype, self-service)
let orgA = "";
let empE = "";
let empF = "";
let slipE = ""; // empE's payslip id
let runId = "";

const ctxOf = (userId: string, cost = true): Ctx => ({
  orgId: orgA,
  userId,
  costPrivileged: cost,
  pricePrivileged: cost,
  requestId: "h23f",
});
const A = () => ctxOf(userA);
const E = () => ctxOf(userE, false);

beforeAll(async () => {
  for (const [id, l] of [
    [userA, "a"],
    [userE, "e"],
  ] as const) {
    await owner`
      insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
      values (${id}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
              ${`h23f-${l}-${run}@example.invalid`}, '{"full_name":"H23F"}'::jsonb, now(), now())`;
  }
  orgA = await createOrgForUser(userA, { name: "H23F", country: "AE", baseCurrency: "AED" });
  await markFixtureOrg(owner, orgA, "h23f", run);
  await owner`
    insert into public.membership (user_id, org_id, role_key)
    values (${userE}, ${orgA}, 'foreman')`;

  const e = await createEmployee(A(), "owner", { name: `Docs Self ${run}` });
  empE = e.id;
  await owner`
    update public.employee set user_id = ${userE}, employee_no = ${`EMP-${run}`},
           name_ar = ${"موظف الاختبار"}, hire_date = '2025-03-01'
    where id = ${empE}`;
  const f = await createEmployee(A(), "owner", { name: `Docs Other ${run}` });
  empF = f.id;

  await recordCompensationChange(A(), "owner", empE, {
    effectiveDate: "2026-01-01",
    salaryMinor: 650_000,
    reason: "hire",
  });
  await recordCompensationChange(A(), "owner", empF, {
    effectiveDate: "2026-01-01",
    salaryMinor: 400_000,
    reason: "hire",
  });

  // One finalized run so payslips exist.
  const g = await createPayGroup(A(), "owner", { nameEn: "Docs Monthly" });
  const r = await createPayRun(A(), "owner", {
    payGroupId: g.id,
    periodStart: "2026-07-01",
    periodEnd: "2026-07-31",
  });
  runId = r.id;
  await calculatePayRun(A(), "owner", runId);
  await submitPayRunForApproval(A(), "owner", runId);
  const inbox = await listInbox(A(), "owner");
  const item = inbox.find((i) => i.subjectId === runId);
  await decideApproval(A(), "owner", { approvalId: item!.id, decision: "approved" });
  await finalizePayRun(A(), "owner", runId);
  const slips = await owner`
    select id::text as id from public.payslip
    where pay_run_id = ${runId} and employee_id = ${empE}`;
  slipE = slips[0]!.id;
}, 600_000);

afterAll(async () => {
  await wipeOrgs(owner, [orgA]);
  await owner.end();
  await closeAppDb();
}, 240_000);

describe("payslip", () => {
  it("renders EN and AR from the frozen snapshot", { timeout: 120_000 }, async () => {
    const en = await documentModel(A(), "owner", { kind: "payslip", id: slipE, language: "en" });
    expect(en.titleEn).toBe("Payslip");
    expect(en.totals!.find((x) => x.strong)!.value).toContain("6,500");
    const html = await documentHtml(E(), "foreman", { kind: "payslip", id: slipE, language: "ar" });
    expect(html).toContain("قسيمة الراتب");
    expect(html).toContain("الراتب الأساسي"); // component labels come from the snapshot
  });

  it("self-narrows: an employee cannot open a colleague's slip", { timeout: 120_000 }, async () => {
    const other = await owner`
      select id::text as id from public.payslip
      where pay_run_id = ${runId} and employee_id = ${empF}`;
    await expect(
      documentModel(E(), "foreman", { kind: "payslip", id: other[0]!.id, language: "en" }),
    ).rejects.toThrow();
  });
});

describe("letters", () => {
  it(
    "salary certificate certifies from the LATEST ISSUED payslip — self-service",
    { timeout: 120_000 },
    async () => {
      const m = await documentModel(E(), "foreman", {
        kind: "salary_certificate",
        id: empE,
        language: "en",
      });
      expect(m.notes).toContain("most recent issued payslip");
      expect(m.sections[0]!.lines[0]!.amount).toContain("6,500");
      // No payslip → no certificate, said plainly (a fresh employee).
      const fresh = await createEmployee(A(), "owner", { name: `NoSlip ${run}` });
      await expect(
        documentModel(A(), "owner", { kind: "salary_certificate", id: fresh.id, language: "en" }),
      ).rejects.toThrow(/none issued/);
    },
  );

  it(
    "experience letter renders bilingually; self cannot letter a colleague",
    { timeout: 120_000 },
    async () => {
      const html = await documentHtml(E(), "foreman", {
        kind: "experience_letter",
        id: empE,
        language: "ar",
      });
      expect(html).toContain("شهادة خبرة");
      await expect(
        documentModel(E(), "foreman", { kind: "experience_letter", id: empF, language: "en" }),
      ).rejects.toThrow();
    },
  );

  it("warning letter is HR-walled and renders the record", { timeout: 120_000 }, async () => {
    const d = await owner`
      insert into public.disciplinary_record
        (org_id, employee_id, kind, occurred_on, summary, created_by)
      values (${orgA}, ${empF}, 'written_warning', '2026-08-15', 'Late three times', ${userA})
      returning id::text as id`;
    const m = await documentModel(A(), "owner", {
      kind: "warning_letter",
      id: d[0]!.id,
      language: "en",
    });
    expect(m.titleEn).toBe("Written warning");
    expect(m.notes).toContain("Late three times");
    // A foreman lacks employees.hr.manage — refused at the coarse gate.
    await expect(
      documentModel(E(), "foreman", { kind: "warning_letter", id: d[0]!.id, language: "en" }),
    ).rejects.toThrow();
  });

  it("leave confirmation exists only for APPROVED leave", { timeout: 120_000 }, async () => {
    const lt = await owner`
      insert into public.leave_type (org_id, key, label)
      values (${orgA}, 'docs_annual', '{"en":"Annual leave","ar":"إجازة سنوية"}'::jsonb)
      returning id::text as id`;
    const lr = await owner`
      insert into public.leave_request
        (org_id, employee_id, leave_type_id, start_date, end_date, days, status, created_by)
      values (${orgA}, ${empE}, ${lt[0]!.id}, '2026-12-20', '2026-12-22', 3, 'pending', ${userE})
      returning id::text as id`;
    await expect(
      documentModel(E(), "foreman", { kind: "leave_confirmation", id: lr[0]!.id, language: "en" }),
    ).rejects.toThrow();
    await owner`update public.leave_request set status = 'approved' where id = ${lr[0]!.id}`;
    const m = await documentModel(E(), "foreman", {
      kind: "leave_confirmation",
      id: lr[0]!.id,
      language: "ar",
    });
    expect(m.titleAr).toBe("تأكيد إجازة");
    expect(m.fields!.some((f) => f.value === "إجازة سنوية")).toBe(true);
  });
});

describe("registers", () => {
  it(
    "payroll register needs cost privilege and drops its watermark when finalized",
    { timeout: 120_000 },
    async () => {
      await expect(
        documentModel(ctxOf(userA, false), "owner", {
          kind: "payroll_register",
          id: runId,
          language: "en",
        }),
      ).rejects.toThrow();
      const m = await documentModel(A(), "owner", {
        kind: "payroll_register",
        id: runId,
        language: "en",
      });
      expect(m.watermark).toBeNull();
      expect(m.sections[0]!.lines).toHaveLength(2);
      expect(m.totals!.find((x) => x.strong)!.value).toContain("10,500");
    },
  );

  it(
    "final settlement preview is ALWAYS watermarked as a working paper",
    { timeout: 120_000 },
    async () => {
      const m = await documentModel(A(), "owner", {
        kind: "final_settlement",
        id: empE,
        language: "en",
      });
      expect(m.watermark).toBe("draft");
      expect(m.noticeText).toContain("Preview only");
    },
  );
});
