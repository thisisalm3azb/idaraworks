/**
 * H23D + H23E — payroll runs, payslips, loans, expense claims.
 *
 * The invariants a screen cannot prove: the calculation is deterministic and
 * integer-only; a below-floor OT rate surfaces as an exception instead of a
 * silent fix; two approvers racing to finalize the same run produce exactly
 * one finalization and one set of payslips; a finalized run and its payslips
 * are immutable at the DATABASE; a reimbursement can be paid once and only
 * once no matter how many runs snapshotted it; loans deduct no more than the
 * balance; expense-book settlement posts real canonical expenses per line and
 * latches; employees read only their own slips.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAppDb, withCtx, sql, type Ctx } from "@/platform/tenancy";
import { createOrgForUser } from "@/platform/auth/identity";
import { installTemplate, TEMPLATE_BOATBUILDING } from "@/platform/config";
import { createEmployee } from "@/modules/masters/service";
import { decideApproval, listInbox } from "@/modules/approvals/service";
import { recordCompensationChange } from "@/modules/hr/people";
import {
  createClaim,
  submitClaim,
  setMileageRate,
  settleClaimToExpenseBook,
  recordCashAdvance,
  settleCashAdvance,
} from "@/modules/hr/claims";
import {
  reopenPayRun,
  createPayGroup,
  createPayRun,
  calculatePayRun,
  submitPayRunForApproval,
  finalizePayRun,
  createReversalRun,
  listPayslips,
} from "@/modules/payroll/service";
import { calculateLine, calculateGratuity } from "@/modules/payroll/engine";
import { AE_PACK } from "@/modules/payroll/packs/ae";
import { markFixtureOrg, ownerSql, wipeOrgs } from "./helpers";

const owner = ownerSql();
const run = randomUUID().slice(0, 8);
const userA = randomUUID(); // owner — approves + finalizes
const userB = randomUUID(); // admin — the concurrent finalizer
const userM = randomUUID(); // accounts — prepares payroll (cannot approve)
const userE = randomUUID(); // employee self-service
let orgA = "";
let empE = ""; // linked to userE
let empF = ""; // no login
let groupId = "";
let categoryKey = "";

const ctxOf = (userId: string, cost = true): Ctx => ({
  orgId: orgA,
  userId,
  costPrivileged: cost,
  pricePrivileged: cost,
  requestId: "h23de",
});
const A = () => ctxOf(userA);
const B = () => ctxOf(userB);
const M = () => ctxOf(userM);
const E = () => ctxOf(userE, false);

async function seedUser(id: string, label: string) {
  await owner`
    insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    values (${id}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            ${`h23de-${label}-${run}@example.invalid`}, '{"full_name":"H23DE"}'::jsonb, now(), now())`;
}

/** Drive one run to approved (accounts prepares, owner decides). */
async function approvedRun(
  periodStart: string,
  periodEnd: string,
  runKind: "regular" | "off_cycle" = "regular",
): Promise<string> {
  const r = await createPayRun(M(), "accounts", { payGroupId: groupId, periodStart, periodEnd, runKind });
  await calculatePayRun(M(), "accounts", r.id);
  await submitPayRunForApproval(M(), "accounts", r.id);
  const inbox = await listInbox(A(), "owner");
  const item = inbox.find((i) => i.subjectId === r.id);
  expect(item, "the pay run reached the owner inbox").toBeDefined();
  await decideApproval(A(), "owner", { approvalId: item!.id, decision: "approved" });
  return r.id;
}

beforeAll(async () => {
  for (const [id, l] of [
    [userA, "a"],
    [userB, "b"],
    [userM, "m"],
    [userE, "e"],
  ] as const) {
    await seedUser(id, l);
  }
  orgA = await createOrgForUser(userA, { name: "H23DE", country: "AE", baseCurrency: "AED" });
  await markFixtureOrg(owner, orgA, "h23de", run);
  await owner`
    insert into public.membership (user_id, org_id, role_key)
    values (${userB}, ${orgA}, 'admin'), (${userM}, ${orgA}, 'accounts'), (${userE}, ${orgA}, 'foreman')`;
  await installTemplate(A(), TEMPLATE_BOATBUILDING.key);
  const cats = (await owner`
    select value from public.app_settings where org_id = ${orgA} and key = 'config.categories.expense'
  `) as unknown as Array<{ value: { categories: Array<{ key: string }> } }>;
  categoryKey = cats[0]!.value.categories[0]!.key;

  const e = await createEmployee(A(), "owner", { name: `Self ${run}` });
  empE = e.id;
  await owner`update public.employee set user_id = ${userE} where id = ${empE}`;
  const f = await createEmployee(A(), "owner", { name: `Floor ${run}` });
  empF = f.id;

  // AED 5,000.00 and AED 8,000.00 monthly basic (minor units).
  await recordCompensationChange(A(), "owner", empE, {
    effectiveDate: "2026-01-01",
    salaryMinor: 500_000,
    reason: "hire",
  });
  await recordCompensationChange(A(), "owner", empF, {
    effectiveDate: "2026-01-01",
    salaryMinor: 800_000,
    reason: "hire",
  });

  const g = await createPayGroup(M(), "accounts", { nameEn: "Monthly", roundingMinor: 25 });
  groupId = g.id;
}, 600_000);

afterAll(async () => {
  await wipeOrgs(owner, [orgA]);
  await owner.end();
  await closeAppDb();
}, 240_000);

// ── the pure engine (deterministic, integer-only, exceptions not fixes) ──────

describe("gross-to-net engine", () => {
  const baseInputs = {
    employeeId: "e",
    employeeName: "E",
    nationality: null,
    periodStart: "2026-08-01",
    periodEnd: "2026-08-31",
    basicMonthlyMinor: 500_000,
    otRate: 1.25,
    hourlyDivisor: 208,
    recurring: [],
    overtimeMinutes: 0,
    unpaidLeaveDays: 0,
    periodCalendarDays: 31,
    adjustments: [],
    reimbursements: [],
    loanInstallments: [],
  };

  it("is deterministic and prorates unpaid leave on the stated calendar basis", () => {
    const a = calculateLine({ ...baseInputs, unpaidLeaveDays: 3 }, AE_PACK, 1);
    const b = calculateLine({ ...baseInputs, unpaidLeaveDays: 3 }, AE_PACK, 1);
    expect(a).toEqual(b);
    // 500000 × 3/31 = 48387.09… → 48387 (half up).
    const unpaid = a.components.find((c) => c.key === "unpaid_leave")!;
    expect(unpaid.amountMinor).toBe(48_387);
    expect(a.netMinor).toBe(500_000 - 48_387);
    expect(Number.isInteger(a.netMinor)).toBe(true);
  });

  it("records a below-floor overtime rate as an EXCEPTION, never silently raised", () => {
    const r = calculateLine({ ...baseInputs, overtimeMinutes: 120, otRate: 1.0 }, AE_PACK, 1);
    expect(r.exceptions.some((e) => e.includes("below the AE statutory floor"))).toBe(true);
    // The amount still uses the EXPLICIT rate 1.0 — 500000/208 per hour × 2h.
    const ot = r.components.find((c) => c.key === "overtime")!;
    expect(ot.amountMinor).toBe(Math.floor((500_000 / 208) * 2 + 0.5));
  });

  it("applies net rounding as its own visible component", () => {
    // Net 500000 rounds to itself at 25; force an odd net with an adjustment.
    const r = calculateLine(
      { ...baseInputs, adjustments: [{ label: "x", kind: "deduction", amountMinor: 13 }] },
      AE_PACK,
      25,
    );
    expect(r.netMinor).toBe(499_987);
    expect(r.netRoundedMinor % 25).toBe(0);
    const rounding = r.components.find((c) => c.key === "rounding");
    expect(rounding).toBeDefined();
    expect(r.netRoundedMinor - r.netMinor).toBeLessThanOrEqual(12);
  });

  it("computes gratuity by band with the cap and shows its working", () => {
    // 7 years of service at basic 10,000.00/mo: 5y × 21d + 2y × 30d = 165 days.
    const g = calculateGratuity(AE_PACK, 7 * 365.25, 1_000_000)!;
    const dailyBasic = 1_000_000 / 30;
    expect(g.amountMinor).toBe(Math.floor(165 * dailyBasic + 0.5));
    expect(g.working.capped).toBe(false);
    // 40 years hits the 24-month cap.
    const capped = calculateGratuity(AE_PACK, 40 * 365.25, 1_000_000)!;
    expect(capped.amountMinor).toBe(24 * 1_000_000);
    expect(capped.working.capped).toBe(true);
    // Below minimum service → zero.
    expect(calculateGratuity(AE_PACK, 300, 1_000_000)!.amountMinor).toBe(0);
  });
});

// ── the run lifecycle ────────────────────────────────────────────────────────

describe("pay run lifecycle", () => {
  let runId = "";

  it("calculates one line per paid employee, deterministically", { timeout: 300_000 }, async () => {
    const r = await createPayRun(M(), "accounts", {
      payGroupId: groupId,
      periodStart: "2026-08-01",
      periodEnd: "2026-08-31",
    });
    runId = r.id;
    const first = await calculatePayRun(M(), "accounts", runId);
    expect(first.lines).toBe(2);
    const t1 = await owner`
      select gross_total_minor, net_total_minor from public.pay_run where id = ${runId}`;
    // Recalculate: identical totals (wipe + recompute, no drift).
    await calculatePayRun(M(), "accounts", runId);
    const t2 = await owner`
      select gross_total_minor, net_total_minor from public.pay_run where id = ${runId}`;
    expect(t2[0]).toEqual(t1[0]);
    expect(Number(t1[0]!.gross_total_minor)).toBe(1_300_000);
  });

  it("refuses a second REGULAR run for the same period (database partial unique)", { timeout: 120_000 }, async () => {
    await expect(
      createPayRun(M(), "accounts", {
        payGroupId: groupId,
        periodStart: "2026-08-01",
        periodEnd: "2026-08-31",
      }),
    ).rejects.toThrow();
  });

  it(
    "two approvers racing to finalize produce EXACTLY one finalization",
    { timeout: 300_000 },
    async () => {
      await submitPayRunForApproval(M(), "accounts", runId);
      const inbox = await listInbox(A(), "owner");
      const item = inbox.find((i) => i.subjectId === runId);
      await decideApproval(A(), "owner", { approvalId: item!.id, decision: "approved" });

      const results = await Promise.allSettled([
        finalizePayRun(A(), "owner", runId),
        finalizePayRun(B(), "admin", runId),
      ]);
      const wins = results.filter((r) => r.status === "fulfilled");
      const losses = results.filter((r) => r.status === "rejected");
      expect(wins).toHaveLength(1);
      expect(losses).toHaveLength(1);
      expect(String((losses[0] as PromiseRejectedResult).reason)).toContain(
        "only an approved run can be finalized",
      );
      // Exactly one set of payslips.
      const slips = await owner`
        select count(*)::int as n from public.payslip where pay_run_id = ${runId}`;
      expect(slips[0]!.n).toBe(2);
    },
  );

  it("a finalized run and its payslips are immutable AT THE DATABASE", { timeout: 120_000 }, async () => {
    await expect(owner`update public.pay_run set status = 'draft' where id = ${runId}`).rejects.toThrow();
    await expect(
      owner`update public.pay_run_line set net_minor = 1 where pay_run_id = ${runId}`,
    ).rejects.toThrow();
    await expect(
      owner`update public.payslip set net_minor = 1 where pay_run_id = ${runId}`,
    ).rejects.toThrow();
    await expect(owner`delete from public.pay_run where id = ${runId}`).rejects.toThrow();
  });

  it("payslips carry the frozen issuer identity", { timeout: 120_000 }, async () => {
    const slips = await owner`
      select issuer_snapshot from public.payslip where pay_run_id = ${runId} limit 1`;
    const issuer = slips[0]!.issuer_snapshot as Record<string, unknown>;
    expect(issuer.capturedAt).toBeTruthy();
    expect(issuer.legalName).toBeTruthy();
  });

  it("an employee reads only their OWN payslip (database row policy)", { timeout: 120_000 }, async () => {
    const mine = await listPayslips(E());
    expect(mine).toHaveLength(1);
    const lines = (await withCtx(E(), (tx) =>
      tx.execute(sql`select employee_id::text as e from public.pay_run_line`),
    )) as unknown as Array<{ e: string }>;
    expect(lines.every((l) => l.e === empE)).toBe(true);
    expect(lines.length).toBeGreaterThan(0);
  });

  it("a reversal run negates the original line for line", { timeout: 300_000 }, async () => {
    const rev = await createReversalRun(A(), "owner", runId, "wrong period data");
    const totals = await owner`
      select (select net_total_minor from public.pay_run where id = ${runId}) as orig,
             (select net_total_minor from public.pay_run where id = ${rev.id}) as rev`;
    expect(Number(totals[0]!.rev)).toBe(-Number(totals[0]!.orig));
  });
});

// ── loans ────────────────────────────────────────────────────────────────────

describe("loans deduct capped at balance and settle themselves", () => {
  it("caps the last installment and flips the loan settled", { timeout: 600_000 }, async () => {
    await owner`
      insert into public.employee_loan
        (org_id, employee_id, kind, reference, principal_minor, installment_minor, starts_on, created_by)
      values (${orgA}, ${empF}, 'loan', ${`LN-T-${run}`}, 100000, 60000, '2026-09-01', ${userA})`;

    const run1 = await approvedRun("2026-09-01", "2026-09-30");
    await finalizePayRun(A(), "owner", run1);
    const l1 = await owner`
      select snapshot from public.pay_run_line
      where pay_run_id = ${run1} and employee_id = ${empF}`;
    const s1 = l1[0]!.snapshot as {
      inputs: { loanInstallments: Array<{ amountMinor: number }> };
    };
    expect(s1.inputs.loanInstallments[0]!.amountMinor).toBe(60_000);

    const run2 = await approvedRun("2026-10-01", "2026-10-31");
    await finalizePayRun(A(), "owner", run2);
    const l2 = await owner`
      select snapshot from public.pay_run_line
      where pay_run_id = ${run2} and employee_id = ${empF}`;
    const s2 = l2[0]!.snapshot as {
      inputs: { loanInstallments: Array<{ amountMinor: number }> };
    };
    // Balance was 40,000 — the 60,000 installment caps to it.
    expect(s2.inputs.loanInstallments[0]!.amountMinor).toBe(40_000);

    const loan = await owner`
      select status, (select sum(amount_minor) from public.loan_repayment
                      where loan_id = employee_loan.id)::bigint as repaid
      from public.employee_loan where reference = ${`LN-T-${run}`}`;
    expect(loan[0]!.status).toBe("settled");
    expect(Number(loan[0]!.repaid)).toBe(100_000);
  });
});

// ── claims ───────────────────────────────────────────────────────────────────

describe("expense claims", () => {
  it("mileage lines price from the configured rate; duplicates are WARNED, not blocked", { timeout: 300_000 }, async () => {
    await setMileageRate(A(), "owner", { rateMinorPerKm: 100, effectiveFrom: "2026-01-01" });
    const c1 = await createClaim(E(), "foreman", {
      employeeId: empE,
      title: "Site visit",
      settlementRoute: "payroll",
      lines: [
        { expenseDate: "2026-11-03", categoryKey, description: "Parking", amountMinor: 2_000 },
        { expenseDate: "2026-11-03", categoryKey, description: "Drive out", mileageKm: 12.5 },
      ],
    });
    expect(c1.totalMinor).toBe(2_000 + 1_250);

    const c2 = await createClaim(E(), "foreman", {
      employeeId: empE,
      title: "Same parking again",
      settlementRoute: "payroll",
      lines: [
        { expenseDate: "2026-11-03", categoryKey, description: "Parking", amountMinor: 2_000 },
      ],
    });
    const sub = await submitClaim(E(), "foreman", { claimId: c2.id });
    expect(sub.warnings.length).toBeGreaterThan(0);
    expect(sub.warnings[0]!.claimReference).toBe(c1.reference);
    // Warned — and still submitted for a human to judge.
    const st = await owner`select status from public.expense_claim where id = ${c2.id}`;
    expect(st[0]!.status).toBe("submitted");
  });

  it(
    "a payroll-routed claim pays through the run ONCE — the racing run must recalculate",
    { timeout: 600_000 },
    async () => {
      const c = await createClaim(E(), "foreman", {
        employeeId: empE,
        title: "Reimburse me",
        settlementRoute: "payroll",
        lines: [{ expenseDate: "2026-11-10", categoryKey, description: "Materials", amountMinor: 7_500 }],
      });
      await submitClaim(E(), "foreman", { claimId: c.id });
      const inbox = await listInbox(A(), "owner");
      const item = inbox.find((i) => i.subjectId === c.id);
      await decideApproval(A(), "owner", { approvalId: item!.id, decision: "approved" });

      // TWO runs calculated while the claim is approved: both snapshot it.
      const r1 = await approvedRun("2026-11-01", "2026-11-30");
      const r2 = await approvedRun("2026-11-01", "2026-11-15", "off_cycle");

      await finalizePayRun(A(), "owner", r1);
      const claim = await owner`
        select status, settled_pay_run_id::text as sp from public.expense_claim where id = ${c.id}`;
      expect(claim[0]!.status).toBe("paid");
      expect(claim[0]!.sp).toBe(r1);

      // The second run still carries the reimbursement in its lines — finalizing
      // it would pay the claim twice. It must refuse and demand recalculation.
      await expect(finalizePayRun(A(), "owner", r2)).rejects.toThrow(/settled elsewhere/);
      await reopenPayRun(M(), "accounts", r2);
      await calculatePayRun(M(), "accounts", r2);
      const line = await owner`
        select snapshot from public.pay_run_line
        where pay_run_id = ${r2} and employee_id = ${empE}`;
      const snap = line[0]!.snapshot as { inputs: { reimbursements: unknown[] } };
      expect(snap.inputs.reimbursements).toHaveLength(0);

      // And the paid claim cannot ALSO settle into the expense book.
      await expect(
        settleClaimToExpenseBook(A(), "owner", { claimId: c.id }),
      ).rejects.toThrow(/only an approved claim/);
    },
  );

  it("an expense_book claim posts one canonical expense per line and latches", { timeout: 300_000 }, async () => {
    const c = await createClaim(M(), "accounts", {
      employeeId: empF,
      title: "Floor purchases",
      settlementRoute: "expense_book",
      lines: [
        { expenseDate: "2026-11-20", categoryKey, description: "Screws", amountMinor: 3_000 },
        { expenseDate: "2026-11-21", categoryKey, description: "Tape", amountMinor: 1_500 },
      ],
    });
    await submitClaim(M(), "accounts", { claimId: c.id });
    const inbox = await listInbox(A(), "owner");
    const item = inbox.find((i) => i.subjectId === c.id);
    await decideApproval(A(), "owner", { approvalId: item!.id, decision: "approved" });

    const settled = await settleClaimToExpenseBook(A(), "owner", { claimId: c.id });
    expect(settled.expenseReferences).toHaveLength(2);
    const expenses = await owner`
      select e.total_minor::bigint as total from public.expense e
      join public.expense_claim_line l on l.settled_expense_id = e.id
      where l.claim_id = ${c.id} order by e.total_minor`;
    expect(expenses.map((r) => Number(r.total))).toEqual([1_500, 3_000]);
    const claim = await owner`select status from public.expense_claim where id = ${c.id}`;
    expect(claim[0]!.status).toBe("paid");

    // Latched: a second settlement and any line edit are refused.
    await expect(settleClaimToExpenseBook(A(), "owner", { claimId: c.id })).rejects.toThrow();
    await expect(
      owner`update public.expense_claim_line set amount_minor = 9 where claim_id = ${c.id}`,
    ).rejects.toThrow();
  });

  it("a cash advance settles by converting into a payroll loan — never vanishing", { timeout: 300_000 }, async () => {
    const adv = await recordCashAdvance(A(), "owner", {
      employeeId: empF,
      amountMinor: 50_000,
      purpose: "Travel float",
    });
    await settleCashAdvance(A(), "owner", {
      advanceId: adv.id,
      via: { kind: "loan", installmentMinor: 25_000, startsOn: "2027-01-01" },
    });
    const rows = await owner`
      select a.status, l.kind, l.principal_minor::bigint as principal
      from public.cash_advance a
      left join public.employee_loan l
        on l.org_id = a.org_id and l.employee_id = a.employee_id and l.kind = 'salary_advance'
      where a.id = ${adv.id}`;
    expect(rows[0]!.status).toBe("converted_to_loan");
    expect(Number(rows[0]!.principal)).toBe(50_000);
    // Settled once — a second settlement is refused.
    await expect(
      settleCashAdvance(A(), "owner", {
        advanceId: adv.id,
        via: { kind: "loan", installmentMinor: 25_000, startsOn: "2027-01-01" },
      }),
    ).rejects.toThrow(/already settled/);
  });
});
