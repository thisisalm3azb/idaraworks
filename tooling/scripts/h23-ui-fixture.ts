/**
 * Seed one organization with enough HR, leave, claims and payroll data to LOOK
 * at (H23 counterpart of h22-ui-fixture.ts). TEST project only; leaves the
 * fixture in place to be browsed; `--wipe` removes it.
 *
 *   npx tsx tooling/scripts/h23-ui-fixture.ts          seed, print the sign-ins
 *   npx tsx tooling/scripts/h23-ui-fixture.ts --wipe   remove it
 */
import "./load-env-integration";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import type { Ctx } from "@/platform/tenancy";
import { closeAppDb } from "@/platform/tenancy";
import { createOrgForUser } from "@/platform/auth/identity";
import { installTemplate, TEMPLATE_BOATBUILDING } from "@/platform/config";
import { createEmployee } from "@/modules/masters/service";
import { decideApproval, listInbox } from "@/modules/approvals/service";
import {
  recordCompensationChange,
  createLeaveType,
  setLeavePolicy,
  postLeaveLedger,
  submitLeaveRequest,
  applyLeaveApproval,
  createClaim,
  submitClaim,
  setMileageRate,
} from "@/modules/hr/service";
import {
  createPayGroup,
  createPayRun,
  calculatePayRun,
  submitPayRunForApproval,
  finalizePayRun,
} from "@/modules/payroll/service";

const MARKER = "fixture.h23_ui";
const owner = postgres(process.env.DIRECT_URL!, { max: 1, onnotice: () => {} });

async function wipe(): Promise<void> {
  const marked = (await owner`
    select org_id::text as id from public.app_settings where key = ${MARKER}`) as unknown as Array<{
    id: string;
  }>;
  const ids = marked.map((m) => m.id);
  if (ids.length === 0) {
    console.log("nothing to remove");
    return;
  }
  const users = (await owner`
    select user_id::text as id from public.membership where org_id = any(${ids}::uuid[])`) as unknown as Array<{
    id: string;
  }>;
  const tables = (await owner`
    select table_name from information_schema.columns
    where table_schema = 'public' and column_name = 'org_id'`) as unknown as Array<{
    table_name: string;
  }>;
  await owner.begin(async (tx) => {
    await tx.unsafe("set local session_replication_role = replica");
    for (const t of tables) {
      await tx.unsafe(`delete from public.${t.table_name} where org_id = any($1::uuid[])`, [ids]);
    }
    await tx.unsafe(`delete from public.org where id = any($1::uuid[])`, [ids]);
    for (const u of users) {
      await tx.unsafe(`delete from public.sign_in_log where user_id = $1`, [u.id]);
      await tx.unsafe(`delete from public.user_profile where id = $1`, [u.id]);
      await tx.unsafe(`delete from auth.users where id = $1`, [u.id]);
    }
  });
  console.log(`removed ${ids.length} fixture org(s), ${users.length} user(s)`);
}

async function seed(): Promise<void> {
  const run = randomUUID().slice(0, 6);
  const password = "Fixture-H23-ui!";
  const { createClient } = await import("@supabase/supabase-js");
  const admin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );

  async function makeUser(email: string, name: string, locale: string): Promise<string> {
    const created = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: name },
    });
    if (created.error || !created.data.user) {
      throw new Error(`createUser: ${created.error?.message ?? "no user returned"}`);
    }
    const id = created.data.user.id;
    await owner`
      insert into public.user_profile (id, full_name, locale)
      values (${id}, ${name}, ${locale})
      on conflict (id) do update set full_name = excluded.full_name, locale = excluded.locale`;
    return id;
  }

  const ownerEmail = `h23ui-owner-${run}@example.invalid`;
  const workerEmail = `h23ui-worker-${run}@example.invalid`;
  const ownerId = await makeUser(ownerEmail, "H23 Owner", "en");
  const workerId = await makeUser(workerEmail, "سالم الحرفي", "ar");

  const orgId = await createOrgForUser(ownerId, {
    name: `H23 UI ${run}`,
    country: "AE",
    baseCurrency: "AED",
  });
  await owner`
    insert into public.app_settings (org_id, key, value)
    values (${orgId}, ${MARKER}, ${JSON.stringify({ run })}::jsonb)
    on conflict do nothing`;
  await owner`
    insert into public.membership (user_id, org_id, role_key)
    values (${workerId}, ${orgId}, 'foreman')`;

  const A: Ctx = {
    orgId,
    userId: ownerId,
    costPrivileged: true,
    pricePrivileged: true,
    requestId: "h23-fixture",
  };
  const W: Ctx = { ...A, userId: workerId, costPrivileged: false, pricePrivileged: false };
  await installTemplate(A, TEMPLATE_BOATBUILDING.key);

  // People: the linked worker + two more, with dates the attention feed reads.
  const w = await createEmployee(A, "owner", { name: "Salem Al Harfi" });
  await owner`
    update public.employee
    set user_id = ${workerId}, name_ar = ${"سالم الحرفي"}, employee_no = ${`EMP-${run}-1`},
        hire_date = '2024-05-01', probation_end_date = current_date + 10
    where id = ${w.id}`;
  const m = await createEmployee(A, "owner", { name: "Mariam Foreperson" });
  await owner`
    update public.employee set name_ar = ${"مريم"}, employee_no = ${`EMP-${run}-2`},
        hire_date = '2023-02-15'
    where id = ${m.id}`;
  await owner`
    insert into public.employee_document (org_id, employee_id, doc_type, title, expiry_date, created_by)
    values (${orgId}, ${w.id}, 'visa', 'Residence visa', current_date + 20, ${ownerId}),
           (${orgId}, ${m.id}, 'certificate', 'Welding certificate', current_date - 3, ${ownerId})`;

  await recordCompensationChange(A, "owner", w.id, {
    effectiveDate: "2026-01-01",
    salaryMinor: 720_000,
    reason: "hire",
  });
  await recordCompensationChange(A, "owner", m.id, {
    effectiveDate: "2026-01-01",
    salaryMinor: 1_150_000,
    reason: "hire",
  });

  // Leave: a type, a policy, opening balances, one APPROVED request.
  const lt = await createLeaveType(A, "owner", {
    key: "annual",
    labelEn: "Annual leave",
    labelAr: "إجازة سنوية",
    paid: true,
  });
  await setLeavePolicy(A, "owner", {
    leaveTypeId: lt.id,
    accrualBasis: "annual_fixed",
    annualDays: 30,
  });
  for (const emp of [w.id, m.id]) {
    await postLeaveLedger(A, "owner", {
      employeeId: emp,
      leaveTypeId: lt.id,
      kind: "opening",
      days: 30,
      note: "opening balance",
    });
  }
  const lr = await submitLeaveRequest(W, "foreman", {
    employeeId: w.id,
    leaveTypeId: lt.id,
    startDate: "2026-10-05",
    endDate: "2026-10-08",
    reason: "Family visit",
  });
  {
    const inbox = await listInbox(A, "owner");
    const item = inbox.find((i) => i.subjectId === lr.id);
    if (item) {
      await decideApproval(A, "owner", { approvalId: item.id, decision: "approved" });
      await applyLeaveApproval(A, "owner", lr.id);
    }
  }

  // Claims: mileage rate, one approved payroll-routed claim, one draft.
  await setMileageRate(A, "owner", { rateMinorPerKm: 150, effectiveFrom: "2026-01-01" });
  const cats = (await owner`
    select value from public.app_settings
    where org_id = ${orgId} and key = 'config.categories.expense'`) as unknown as Array<{
    value: { categories: Array<{ key: string }> };
  }>;
  const categoryKey = cats[0]!.value.categories[0]!.key;
  const c1 = await createClaim(W, "foreman", {
    employeeId: w.id,
    title: "Site visit expenses",
    settlementRoute: "payroll",
    lines: [
      { expenseDate: "2026-08-18", categoryKey, description: "Parking", amountMinor: 2_500 },
      { expenseDate: "2026-08-18", categoryKey, description: "Drive to yard", mileageKm: 22.5 },
    ],
  });
  await submitClaim(W, "foreman", { claimId: c1.id });
  {
    const inbox = await listInbox(A, "owner");
    const item = inbox.find((i) => i.subjectId === c1.id);
    if (item) await decideApproval(A, "owner", { approvalId: item.id, decision: "approved" });
  }
  await createClaim(W, "foreman", {
    employeeId: w.id,
    title: "Toolbox restock (draft)",
    settlementRoute: "expense_book",
    lines: [
      { expenseDate: "2026-08-25", categoryKey, description: "Drill bits", amountMinor: 9_900 },
    ],
  });

  // Payroll: one FINALIZED July run (payslips + notification) and one August
  // run left in review so the pending-attention row has something to say.
  const g = await createPayGroup(A, "owner", { nameEn: "Monthly staff", roundingMinor: 25 });
  const july = await createPayRun(A, "owner", {
    payGroupId: g.id,
    periodStart: "2026-07-01",
    periodEnd: "2026-07-31",
  });
  await calculatePayRun(A, "owner", july.id);
  await submitPayRunForApproval(A, "owner", july.id);
  {
    const inbox = await listInbox(A, "owner");
    const item = inbox.find((i) => i.subjectId === july.id);
    if (item) await decideApproval(A, "owner", { approvalId: item.id, decision: "approved" });
  }
  await finalizePayRun(A, "owner", july.id);
  const august = await createPayRun(A, "owner", {
    payGroupId: g.id,
    periodStart: "2026-08-01",
    periodEnd: "2026-08-31",
  });
  await calculatePayRun(A, "owner", august.id);

  console.log("");
  console.log("H23 UI fixture ready — dev server: npx tsx (launch config hr-preview)");
  console.log(`  org         H23 UI ${run}`);
  console.log(`  owner       ${ownerEmail}`);
  console.log(`  worker (ar) ${workerEmail}`);
  console.log(`  password    ${password}`);
}

async function main() {
  if (/anhgeeutrwftsvuzfinf/.test(process.env.DIRECT_URL ?? "")) {
    console.error("REFUSING: that is the production project.");
    process.exit(1);
  }
  if (process.argv.includes("--wipe")) await wipe();
  else await seed();
  await owner.end();
  await closeAppDb();
}

void main();
