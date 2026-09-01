/**
 * H23H — attention feed, payslip notifications, HR data exports.
 *
 * What a screen cannot prove: the computed-on-read feed reports exactly the
 * date-truths in the tables (probation, documents, contracts, waiting runs)
 * and respects both walls; finalize notifies the LINKED employee without any
 * amount in the notification; the CSV exports page past the 1,000-row cap and
 * redact money for the cost-unprivileged.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAppDb, type Ctx } from "@/platform/tenancy";
import { createOrgForUser } from "@/platform/auth/identity";
import { createEmployee } from "@/modules/masters/service";
import { decideApproval, listInbox } from "@/modules/approvals/service";
import { recordCompensationChange } from "@/modules/hr/people";
import { hrAttentionFeed } from "@/modules/hr/attention";
import {
  createPayGroup,
  createPayRun,
  calculatePayRun,
  submitPayRunForApproval,
  finalizePayRun,
} from "@/modules/payroll/service";
import { exportEntityCsv } from "@/platform/export/service";
import { markFixtureOrg, ownerSql, wipeOrgs } from "./helpers";

const owner = ownerSql();
const run = randomUUID().slice(0, 8);
const userA = randomUUID();
const userE = randomUUID();
let orgA = "";
let empE = "";

const ctxOf = (userId: string, cost = true): Ctx => ({
  orgId: orgA,
  userId,
  costPrivileged: cost,
  pricePrivileged: cost,
  requestId: "h23h",
});
const A = () => ctxOf(userA);

beforeAll(async () => {
  for (const [id, l] of [
    [userA, "a"],
    [userE, "e"],
  ] as const) {
    await owner`
      insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
      values (${id}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
              ${`h23h-${l}-${run}@example.invalid`}, '{"full_name":"H23H"}'::jsonb, now(), now())`;
  }
  orgA = await createOrgForUser(userA, { name: "H23H", country: "AE", baseCurrency: "AED" });
  await markFixtureOrg(owner, orgA, "h23h", run);
  await owner`
    insert into public.membership (user_id, org_id, role_key)
    values (${userE}, ${orgA}, 'foreman')`;
  const e = await createEmployee(A(), "owner", { name: `Feed ${run}` });
  empE = e.id;
  await owner`
    update public.employee
    set user_id = ${userE}, probation_end_date = current_date + 7
    where id = ${empE}`;
  await owner`
    insert into public.employee_document (org_id, employee_id, doc_type, title, expiry_date, created_by)
    values (${orgA}, ${empE}, 'visa', 'Residence visa', current_date - 1, ${userA}),
           (${orgA}, ${empE}, 'certificate', 'First aid', current_date + 10, ${userA})`;
  await recordCompensationChange(A(), "owner", empE, {
    effectiveDate: "2026-01-01",
    salaryMinor: 500_000,
    reason: "hire",
  });
}, 600_000);

afterAll(async () => {
  await wipeOrgs(owner, [orgA]);
  await owner.end();
  await closeAppDb();
}, 240_000);

describe("the HR attention feed", () => {
  it(
    "reports date-truths, walls payroll concerns, and notifies on finalize",
    { timeout: 600_000 },
    async () => {
      const g = await createPayGroup(A(), "owner", { nameEn: "Feed Monthly" });
      const r = await createPayRun(A(), "owner", {
        payGroupId: g.id,
        periodStart: "2026-06-01",
        periodEnd: "2026-06-30",
      });
      await calculatePayRun(A(), "owner", r.id); // → review

      const feed = await hrAttentionFeed(A(), "owner");
      const kinds = feed.items.map((i) => i.kind);
      expect(kinds).toContain("probation_ending");
      expect(kinds).toContain("document_expired"); // urgent, and sorted first
      expect(kinds).toContain("document_expiring");
      expect(kinds).toContain("payroll_pending");
      expect(feed.items[0]!.severity).toBe("urgent");

      // The cost wall: an owner WITHOUT cost privilege sees no payroll rows.
      const noCost = await hrAttentionFeed(ctxOf(userA, false), "owner");
      expect(noCost.items.map((i) => i.kind)).not.toContain("payroll_pending");

      // Finalize: the waiting-run concern clears itself (computed on read) and
      // the linked employee is told — with NO amount anywhere near the message.
      await submitPayRunForApproval(A(), "owner", r.id);
      const inbox = await listInbox(A(), "owner");
      const item = inbox.find((i) => i.subjectId === r.id);
      await decideApproval(A(), "owner", { approvalId: item!.id, decision: "approved" });
      await finalizePayRun(A(), "owner", r.id);

      const after = await hrAttentionFeed(A(), "owner");
      expect(after.items.map((i) => i.kind)).not.toContain("payroll_pending");

      const notes = await owner`
        select title, coalesce(body, '') as body, kind from public.notification
        where org_id = ${orgA} and user_id = ${userE} and kind = 'payslip_issued'`;
      expect(notes).toHaveLength(1);
      expect(notes[0]!.title).toContain("PSL-");
      // 5000.00 AED in any spelling must NOT appear.
      expect(`${notes[0]!.title} ${notes[0]!.body}`).not.toMatch(/5[,.]?000|500000/);
    },
  );
});

describe("HR exports", () => {
  it("pages past 1,000 rows and counts exactly", { timeout: 600_000 }, async () => {
    // 1,200 leave-type-less rows would violate FKs; leave requests need a type.
    const lt = await owner`
      insert into public.leave_type (org_id, key, label)
      values (${orgA}, 'bulk', '{"en":"Bulk","ar":"سائب"}'::jsonb)
      returning id::text as id`;
    const values: string[] = [];
    for (let i = 0; i < 1200; i++) values.push(`d${i}`);
    await owner.unsafe(
      `insert into public.leave_request
         (org_id, employee_id, leave_type_id, start_date, end_date, days, status, created_by)
       select '${orgA}', '${empE}', '${lt[0]!.id}',
              date '2030-01-01' + (n * 7), date '2030-01-01' + (n * 7), 1, 'rejected', '${userA}'
       from generate_series(0, 1199) n`,
    );
    void values;
    const csv = await exportEntityCsv(A(), "owner", "leave_requests");
    const lines = csv.trim().split("\n");
    expect(lines.length).toBe(1 + 1200); // header + every row — no silent 1,000 cap
  });

  it("redacts payslip money for the cost-unprivileged", { timeout: 120_000 }, async () => {
    const priv = await exportEntityCsv(A(), "owner", "payslips");
    expect(priv.split("\n")[1]).toMatch(/500000|4[0-9]{5}/); // gross or net present
    const redacted = await exportEntityCsv(ctxOf(userA, false), "owner", "payslips");
    // The payslip ROW policy is the cost wall: an unprivileged exporter gets
    // no rows at all (headers only) — stronger than column redaction, which
    // stays declared in COST_COLS as defence in depth.
    expect(redacted.trim().split("\n")).toHaveLength(1);
    expect(redacted).not.toMatch(/500000/);
  });

  it("employees export carries no salary columns at all", { timeout: 120_000 }, async () => {
    const csv = await exportEntityCsv(A(), "owner", "employees");
    expect(csv.split("\n")[0]).not.toMatch(/salary|terms|cost/);
    expect(csv).toContain(`Feed ${run}`);
  });
});
