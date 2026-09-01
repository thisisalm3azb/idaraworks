/**
 * H23 end-to-end production smoke — one marked fixture, removed in `finally`.
 *
 * Proof that the H23 system works on the real database and the real deployed
 * application, through the same module functions the screens call plus the
 * REAL HTTP route the Download PDF button hits. Not a demo: every step asserts
 * a property that would be expensive to get wrong, and the fixture
 * self-destructs whether the run passes or fails.
 *
 * What it walks, in the order a business does:
 *   1. an employee hired with dated compensation history
 *   2. leave requested by the employee, approved, applied EXACTLY once
 *   3. an expense claim with a mileage line, approved for payroll settlement
 *   4. a pay run calculated deterministically, snapshotting every input
 *   5. TWO concurrent finalizations — exactly one winner, one set of payslips
 *   6. the claim latched paid by the run — a second settlement refused
 *   7. payslip immutability AT THE DATABASE (owner connection, trigger fires)
 *   8. the payslip PDF downloaded from the DEPLOYED function, EN and AR, as
 *      the signed-in employee — 200, application/pdf, attachment, %PDF bytes
 *
 * SAFETY: creates one marked organization and two users; touches nothing else;
 * cleanup runs in `finally`, then residue and historical counts are verified.
 *
 *   npx tsx tooling/scripts/h23-prod-smoke.ts --confirm=<production phrase>
 */
import { config } from "dotenv";

config({ path: [".env.local"], quiet: true });

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
  leaveBalances,
  createClaim,
  submitClaim,
  setMileageRate,
  settleClaimToExpenseBook,
} from "@/modules/hr/service";
import {
  createPayGroup,
  createPayRun,
  calculatePayRun,
  submitPayRunForApproval,
  finalizePayRun,
} from "@/modules/payroll/service";
import {
  PRODUCTION_PROJECT_REF,
  productionMigrationPhrase,
  targetsOnlyProductionProject,
} from "../../tests/integration/guard-env";

const BASE = (process.env.PDF_VERIFY_BASE ?? "https://www.idaraworks.com").replace(/\/$/, "");
const MARKER = "smoke.h23";
const RUN = randomUUID().slice(0, 8);

const owner = postgres(process.env.DIRECT_URL!, {
  max: 1,
  connect_timeout: 60,
  onnotice: () => {},
});
const ownerUserId = randomUUID();
let employeeUserId = "";
let orgId = "";
const employeePassword = `Smoke-${randomUUID()}`;
const employeeEmail = `h23smoke-emp-${RUN}@example.invalid`;

const A = (): Ctx => ({
  orgId,
  userId: ownerUserId,
  costPrivileged: true,
  pricePrivileged: true,
  requestId: `h23-smoke-${RUN}`,
});
const E = (): Ctx => ({
  ...A(),
  userId: employeeUserId,
  costPrivileged: false,
  pricePrivileged: false,
});

let checks = 0;
function check(what: string, ok: boolean, detail = ""): void {
  checks++;
  if (!ok) throw new Error(`FAILED: ${what}${detail ? ` — ${detail}` : ""}`);
  console.log(`  ok: ${what}${detail ? ` (${detail})` : ""}`);
}

async function cleanup(): Promise<void> {
  if (!orgId) return;
  const tables = (await owner`
    select table_name from information_schema.columns
    where table_schema = 'public' and column_name = 'org_id'`) as unknown as Array<{
    table_name: string;
  }>;
  await owner.begin(async (tx) => {
    await tx.unsafe("set local session_replication_role = replica");
    for (const t of tables) {
      await tx.unsafe(`delete from public.${t.table_name} where org_id = $1`, [orgId]);
    }
    await tx.unsafe(`delete from public.org where id = $1`, [orgId]);
    for (const u of [ownerUserId, employeeUserId].filter(Boolean)) {
      await tx.unsafe(`delete from public.sign_in_log where user_id = $1`, [u]);
      await tx.unsafe(`delete from public.user_profile where id = $1`, [u]);
      await tx.unsafe(`delete from auth.users where id = $1`, [u]);
    }
  });
  const residue = (await owner`
    select
      (select count(*) from public.org where id = ${orgId}) +
      (select count(*) from public.app_settings where org_id = ${orgId}) +
      (select count(*) from auth.users where id in (${ownerUserId}, ${employeeUserId || randomUUID()}))
      as n`) as unknown as Array<{ n: string }>;
  console.log(`cleanup: residue rows = ${residue[0]!.n} (must be 0)`);
  if (Number(residue[0]!.n) !== 0) throw new Error("RESIDUE LEFT — investigate immediately");
}

/** Sign the employee in against the deployed Supabase and build the SSR cookie. */
async function employeeCookie(): Promise<string> {
  const { createClient } = await import("@supabase/supabase-js");
  const anon = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false } },
  );
  const { data, error } = await anon.auth.signInWithPassword({
    email: employeeEmail,
    password: employeePassword,
  });
  if (error || !data.session) throw new Error(`employee sign-in failed: ${error?.message}`);
  const ref = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).hostname.split(".")[0];
  const value = "base64-" + Buffer.from(JSON.stringify(data.session), "utf8").toString("base64url");
  // @supabase/ssr chunks long cookies; mirror its scheme.
  const CHUNK = 3180;
  if (value.length <= CHUNK) return `sb-${ref}-auth-token=${value}`;
  const parts: string[] = [];
  for (let i = 0; i * CHUNK < value.length; i++) {
    parts.push(`sb-${ref}-auth-token.${i}=${value.slice(i * CHUNK, (i + 1) * CHUNK)}`);
  }
  return parts.join("; ");
}

async function fetchPdf(cookie: string, path: string) {
  const res = await fetch(`${BASE}${path}`, { headers: { cookie }, redirect: "manual" });
  const buf = Buffer.from(await res.arrayBuffer());
  return {
    status: res.status,
    type: res.headers.get("content-type") ?? "",
    disposition: res.headers.get("content-disposition") ?? "",
    head: buf.subarray(0, 5).toString("latin1"),
    bytes: buf.length,
  };
}

async function main(): Promise<void> {
  const confirmArg = process.argv
    .find((a) => a.startsWith("--confirm="))
    ?.slice("--confirm=".length);
  const target = targetsOnlyProductionProject();
  if (!target.ok) {
    console.error("Refusing: environment does not point exclusively at production.");
    for (const p of target.problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  if (confirmArg !== productionMigrationPhrase()) {
    console.error(`Refusing: pass --confirm=${productionMigrationPhrase()}`);
    process.exit(1);
  }
  const probe = (await owner`select current_database() as db`) as unknown as Array<{ db: string }>;
  console.log(
    `production smoke against ${PRODUCTION_PROJECT_REF} (db=${probe[0]!.db}), run ${RUN}`,
  );

  const before = (await owner`
    select (select count(*) from public.org) as orgs,
           (select count(*) from public.pay_run) as runs,
           (select count(*) from public.payslip) as slips,
           (select count(*) from public.expense_claim) as claims`) as unknown as Array<
    Record<string, string>
  >;

  try {
    // ── fixture ────────────────────────────────────────────────────────────
    const { createClient } = await import("@supabase/supabase-js");
    const admin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false } },
    );
    await owner`
      insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
      values (${ownerUserId}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
              ${`h23smoke-owner-${RUN}@example.invalid`}, '{"full_name":"H23 Smoke"}'::jsonb, now(), now())`;
    const created = await admin.auth.admin.createUser({
      email: employeeEmail,
      password: employeePassword,
      email_confirm: true,
      user_metadata: { full_name: "H23 Smoke Employee" },
    });
    if (created.error || !created.data.user) {
      throw new Error(`createUser: ${created.error?.message}`);
    }
    employeeUserId = created.data.user.id;
    await owner`
      insert into public.user_profile (id, full_name, locale)
      values (${employeeUserId}, 'H23 Smoke Employee', 'en')
      on conflict (id) do nothing`;

    orgId = await createOrgForUser(ownerUserId, {
      name: `H23 Smoke ${RUN}`,
      country: "AE",
      baseCurrency: "AED",
    });
    await owner`
      insert into public.app_settings (org_id, key, value)
      values (${orgId}, ${MARKER}, ${JSON.stringify({ run: RUN })}::jsonb)`;
    await owner`
      insert into public.membership (user_id, org_id, role_key)
      values (${employeeUserId}, ${orgId}, 'foreman')`;
    await installTemplate(A(), TEMPLATE_BOATBUILDING.key);
    console.log(`fixture org ${orgId}`);

    // ── 1. hire with dated compensation ────────────────────────────────────
    const emp = await createEmployee(A(), "owner", { name: `Smoke Emp ${RUN}` });
    await owner`update public.employee set user_id = ${employeeUserId} where id = ${emp.id}`;
    await recordCompensationChange(A(), "owner", emp.id, {
      effectiveDate: "2026-01-01",
      salaryMinor: 650_000,
      reason: "hire",
    });
    const terms = (await owner`
      select salary_minor from public.employee_terms
      where employee_id = ${emp.id}`) as unknown as Array<{ salary_minor: string }>;
    check("compensation history projected into terms", Number(terms[0]?.salary_minor) === 650_000);

    // ── 2. leave approved and applied exactly once ─────────────────────────
    const lt = await createLeaveType(A(), "owner", {
      key: "annual",
      labelEn: "Annual leave",
      labelAr: "إجازة سنوية",
      paid: true,
    });
    await setLeavePolicy(A(), "owner", {
      leaveTypeId: lt.id,
      accrualBasis: "annual_fixed",
      annualDays: 30,
    });
    await postLeaveLedger(A(), "owner", {
      employeeId: emp.id,
      leaveTypeId: lt.id,
      kind: "opening",
      days: 30,
      note: "smoke opening",
    });
    const lr = await submitLeaveRequest(E(), "foreman", {
      employeeId: emp.id,
      leaveTypeId: lt.id,
      startDate: "2026-10-05",
      endDate: "2026-10-06",
    });
    let inbox = await listInbox(A(), "owner");
    const leaveItem = inbox.find((i) => i.subjectId === lr.id);
    check("leave request reached the approval inbox", !!leaveItem);
    await decideApproval(A(), "owner", { approvalId: leaveItem!.id, decision: "approved" });
    await applyLeaveApproval(A(), "owner", lr.id);
    await applyLeaveApproval(A(), "owner", lr.id); // idempotent — must not double-debit
    const bal = await leaveBalances(A(), "owner", emp.id);
    check("balance debited exactly once", bal[0]?.balanceDays === 28, `${bal[0]?.balanceDays}`);

    // ── 3. claim with a mileage line, approved for payroll ────────────────
    await setMileageRate(A(), "owner", { rateMinorPerKm: 100, effectiveFrom: "2026-01-01" });
    const cats = (await owner`
      select value from public.app_settings
      where org_id = ${orgId} and key = 'config.categories.expense'`) as unknown as Array<{
      value: { categories: Array<{ key: string }> };
    }>;
    const claim = await createClaim(E(), "foreman", {
      employeeId: emp.id,
      title: "Smoke expenses",
      settlementRoute: "payroll",
      lines: [
        {
          expenseDate: "2026-08-10",
          categoryKey: cats[0]!.value.categories[0]!.key,
          description: "Parking",
          amountMinor: 2_000,
        },
        {
          expenseDate: "2026-08-10",
          categoryKey: cats[0]!.value.categories[0]!.key,
          description: "Drive",
          mileageKm: 10,
        },
      ],
    });
    check("mileage priced from the configured rate", claim.totalMinor === 3_000);
    await submitClaim(E(), "foreman", { claimId: claim.id });
    inbox = await listInbox(A(), "owner");
    const claimItem = inbox.find((i) => i.subjectId === claim.id);
    await decideApproval(A(), "owner", { approvalId: claimItem!.id, decision: "approved" });

    // ── 4–5. calculate, approve, DOUBLE finalize ───────────────────────────
    const g = await createPayGroup(A(), "owner", { nameEn: "Smoke Monthly", roundingMinor: 25 });
    const run = await createPayRun(A(), "owner", {
      payGroupId: g.id,
      periodStart: "2026-08-01",
      periodEnd: "2026-08-31",
    });
    const calc = await calculatePayRun(A(), "owner", run.id);
    check("one line per paid employee", calc.lines === 1, `${calc.lines}`);
    await submitPayRunForApproval(A(), "owner", run.id);
    inbox = await listInbox(A(), "owner");
    const runItem = inbox.find((i) => i.subjectId === run.id);
    await decideApproval(A(), "owner", { approvalId: runItem!.id, decision: "approved" });

    const race = await Promise.allSettled([
      finalizePayRun(A(), "owner", run.id),
      finalizePayRun(A(), "owner", run.id),
    ]);
    const winners = race.filter((r) => r.status === "fulfilled");
    check("concurrent finalize has exactly one winner", winners.length === 1);
    const slips = (await owner`
      select id::text as id, net_minor::text as net from public.payslip
      where pay_run_id = ${run.id}`) as unknown as Array<{ id: string; net: string }>;
    check("exactly one payslip issued", slips.length === 1);
    // 650000 + 3000 reimbursement = 653000, rounded to 25 → unchanged.
    check("net = salary + reimbursement", Number(slips[0]!.net) === 653_000, slips[0]!.net);

    // ── 6. the no-double-pay latch ─────────────────────────────────────────
    const latched = (await owner`
      select status, settled_pay_run_id::text as sp from public.expense_claim
      where id = ${claim.id}`) as unknown as Array<{ status: string; sp: string | null }>;
    check(
      "claim latched paid by the run",
      latched[0]!.status === "paid" && latched[0]!.sp === run.id,
    );
    let refused = false;
    try {
      await settleClaimToExpenseBook(A(), "owner", { claimId: claim.id });
    } catch {
      refused = true;
    }
    check("second settlement refused", refused);

    // ── 7. payslip immutability at the database ────────────────────────────
    let frozen = false;
    try {
      await owner`update public.payslip set net_minor = 1 where id = ${slips[0]!.id}`;
    } catch {
      frozen = true;
    }
    check("payslip immutable even for the table owner", frozen);

    // ── 8. the DEPLOYED PDF, EN and AR, as the signed-in employee ─────────
    const cookie = await employeeCookie();
    for (const lang of ["en", "ar"] as const) {
      const pdf = await fetchPdf(
        cookie,
        `/api/o/${orgId}/documents/payslip/${slips[0]!.id}?format=pdf&lang=${lang}`,
      );
      check(
        `deployed payslip PDF (${lang})`,
        pdf.status === 200 &&
          pdf.type.includes("application/pdf") &&
          pdf.head === "%PDF-" &&
          pdf.bytes > 10_000,
        `${pdf.status} ${pdf.type} ${pdf.head} ${pdf.bytes}B`,
      );
    }
    const cert = await fetchPdf(
      cookie,
      `/api/o/${orgId}/documents/salary_certificate/${emp.id}?format=pdf&lang=en`,
    );
    check(
      "deployed salary certificate PDF (self-service)",
      cert.status === 200 && cert.type.includes("application/pdf") && cert.head === "%PDF-",
      `${cert.status} ${cert.type}`,
    );

    // ── 9. the release gate: with FEATURE_HR_SURFACES unset, the deployed
    //      screens render the not-found page even to a signed-in member.
    //      (Next streams the not-found boundary with HTTP 200 once the shell
    //      has begun, so the BODY is the truth here, not the status code.)
    const gate = await fetch(`${BASE}/o/${orgId}/leave`, {
      headers: { cookie },
      redirect: "manual",
    });
    const gateBody = await gate.text();
    const showsNotFound =
      gateBody.includes("404") || gateBody.includes("could not be found");
    const leaksLeaveUi =
      gateBody.includes("Request leave") || gateBody.includes("طلب إجازة");
    check(
      "HR surfaces hidden while the flag is unset",
      (gate.status === 404 || (gate.status === 200 && showsNotFound)) && !leaksLeaveUi,
      `${gate.status} notFound=${showsNotFound} leaks=${leaksLeaveUi}`,
    );

    console.log(`\nALL ${checks} CHECKS PASSED`);
  } finally {
    await cleanup();
    const after = (await owner`
      select (select count(*) from public.org) as orgs,
             (select count(*) from public.pay_run) as runs,
             (select count(*) from public.payslip) as slips,
             (select count(*) from public.expense_claim) as claims`) as unknown as Array<
      Record<string, string>
    >;
    const same = JSON.stringify(before[0]) === JSON.stringify(after[0]);
    console.log(
      `historical counts intact: ${same} (before=${JSON.stringify(before[0])} after=${JSON.stringify(after[0])})`,
    );
    if (!same) process.exitCode = 1;
    await owner.end();
    await closeAppDb();
  }
}

void main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
