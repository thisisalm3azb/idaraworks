/**
 * H23A — the people foundation.
 *
 * What is worth testing here is what a form cannot see: that the database
 * refuses illegal lifecycle jumps, that employment history cannot be edited or
 * deleted by anybody, that a compensation change updates BOTH the history and
 * the projection costing reads, and that the two walls (cost, owner/admin)
 * actually hold at the database for the new tables.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAppDb, type Ctx } from "@/platform/tenancy";
import { createOrgForUser } from "@/platform/auth/identity";
import { createEmployee } from "@/modules/masters/service";
import {
  createDepartment,
  createPosition,
  createWorkLocation,
  updateEmployeeProfile,
  transitionEmployee,
  confirmEmployee,
  recordCompensationChange,
  listCompensationHistory,
  createContract,
  issueContract,
  recordContractAcceptance,
  getEmployeeProfile,
  linkEmployeeToMember,
  HrError,
} from "@/modules/hr/people";
import { markFixtureOrg, ownerSql, wipeOrgs } from "./helpers";

const owner = ownerSql();
const run = randomUUID().slice(0, 8);
const userA = randomUUID();
const outsider = randomUUID();
let orgA = "";
let orgB = "";

const ctxOf = (orgId: string, userId: string, cost = true): Ctx => ({
  orgId,
  userId,
  costPrivileged: cost,
  pricePrivileged: cost,
  requestId: "h23a",
});
const A = () => ctxOf(orgA, userA);
const walled = () => ctxOf(orgA, userA, false);
const B = () => ctxOf(orgB, outsider);

async function seedUser(id: string, label: string) {
  await owner`
    insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    values (${id}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            ${`h23a-${label}-${run}@example.invalid`}, '{"full_name":"H23A"}'::jsonb, now(), now())`;
}

async function anEmployee(name: string): Promise<string> {
  const r = await createEmployee(A(), "owner", { name });
  return r.id;
}

beforeAll(async () => {
  await seedUser(userA, "a");
  await seedUser(outsider, "b");
  orgA = await createOrgForUser(userA, { name: "H23A A", country: "AE", baseCurrency: "AED" });
  orgB = await createOrgForUser(outsider, { name: "H23A B", country: "AE", baseCurrency: "AED" });
  await markFixtureOrg(owner, orgA, "h23a", run);
  await markFixtureOrg(owner, orgB, "h23a-b", run);
}, 600_000);

afterAll(async () => {
  await wipeOrgs(owner, [orgA, orgB], [userA, outsider]);
  await owner.end({ timeout: 5 });
  await closeAppDb();
}, 300_000);

describe("structure and profile", () => {
  it(
    "builds departments, positions and locations, and files them on the employee",
    { timeout: 240_000 },
    async () => {
      const dept = await createDepartment(A(), "owner", {
        nameEn: "Operations",
        nameAr: "العمليات",
      });
      const pos = await createPosition(A(), "owner", {
        nameEn: "Technician",
        departmentId: dept.id,
      });
      const loc = await createWorkLocation(A(), "owner", { nameEn: "Main site", country: "AE" });

      const emp = await anEmployee(`Amal ${run}`);
      await updateEmployeeProfile(A(), "owner", emp, {
        legalName: "Amal Hassan Al Ali",
        nameAr: "أمل حسن",
        nationality: "AE",
        departmentId: dept.id,
        positionId: pos.id,
        workLocationId: loc.id,
        employmentType: "full_time",
        hireDate: "2026-01-15",
        emergencyContactName: "Hassan",
        emergencyContactPhone: "+971500000009",
      });

      const profile = await getEmployeeProfile(A(), "owner", emp);
      expect(profile!.employeeNo, "a stable number was allocated").toMatch(/^EMP-\d{3}$/);
      expect(profile!.departmentName).toBe("Operations");
      expect(profile!.positionName).toBe("Technician");
      expect(profile!.locationName).toBe("Main site");
      expect(profile!.nameAr).toBe("أمل حسن");
      expect(profile!.lifecycle).toBe("active");
    },
  );

  it("keeps the number once allocated and never reuses it", { timeout: 240_000 }, async () => {
    const e1 = await anEmployee(`N1 ${run}`);
    const e2 = await anEmployee(`N2 ${run}`);
    await updateEmployeeProfile(A(), "owner", e1, { hireDate: "2026-02-01" });
    const n1 = (await getEmployeeProfile(A(), "owner", e1))!.employeeNo;
    await updateEmployeeProfile(A(), "owner", e1, { email: "n1@example.invalid" });
    expect((await getEmployeeProfile(A(), "owner", e1))!.employeeNo, "stable across edits").toBe(
      n1,
    );
    await updateEmployeeProfile(A(), "owner", e2, { hireDate: "2026-02-02" });
    const n2 = (await getEmployeeProfile(A(), "owner", e2))!.employeeNo;
    expect(n2).not.toBe(n1);
  });

  it("is invisible across the tenancy boundary", { timeout: 240_000 }, async () => {
    const emp = await anEmployee(`Xorg ${run}`);
    expect(await getEmployeeProfile(B(), "owner", emp)).toBeNull();
  });
});

describe("lifecycle", () => {
  it("walks the legal path and records every step as history", { timeout: 240_000 }, async () => {
    const emp = await anEmployee(`Life ${run}`);
    await confirmEmployee(A(), "owner", emp, "2026-06-01");
    await transitionEmployee(A(), "owner", emp, { to: "notice", reason: "resignation" });
    await transitionEmployee(A(), "owner", emp, {
      to: "terminated",
      endDate: "2026-09-30",
      finalWorkingDate: "2026-09-28",
    });
    await transitionEmployee(A(), "owner", emp, { to: "archived" });

    const p = await getEmployeeProfile(A(), "owner", emp);
    expect(p!.lifecycle).toBe("archived");
    expect(p!.endDate).toBe("2026-09-30");
    const events = p!.events.map((e) => e.event);
    expect(events).toEqual(
      expect.arrayContaining(["confirmed", "notice_given", "terminated", "archived"]),
    );
  });

  it("refuses an illegal jump AT THE DATABASE", { timeout: 240_000 }, async () => {
    const emp = await anEmployee(`Illegal ${run}`);
    // active → archived skips termination; the trigger must throw.
    await expect(transitionEmployee(A(), "owner", emp, { to: "archived" })).rejects.toThrow();
    // And terminating without an end date is refused even by raw SQL.
    let refused = false;
    try {
      await owner`update public.employee set lifecycle = 'terminated', end_date = null
                  where id = ${emp} and org_id = ${orgA}`;
    } catch {
      refused = true;
    }
    expect(refused, "the DB, not the service, is the law").toBe(true);
  });

  it("derives the active flag so the pair can never disagree", { timeout: 240_000 }, async () => {
    const emp = await anEmployee(`Flag ${run}`);
    await transitionEmployee(A(), "owner", emp, { to: "terminated", endDate: "2026-08-31" });
    const rows = await owner`
      select active, lifecycle from public.employee where id = ${emp}`;
    expect(rows[0]!.lifecycle).toBe("terminated");
    expect(rows[0]!.active, "terminated is not active").toBe(false);
  });

  it("withdrawing notice reads honestly in history", { timeout: 240_000 }, async () => {
    const emp = await anEmployee(`Notice ${run}`);
    await transitionEmployee(A(), "owner", emp, { to: "notice" });
    await transitionEmployee(A(), "owner", emp, { to: "active" });
    const p = await getEmployeeProfile(A(), "owner", emp);
    expect(p!.events.map((e) => e.event)).toContain("notice_withdrawn");
  });

  it(
    "employment history cannot be edited or deleted, even by the owner role",
    { timeout: 240_000 },
    async () => {
      const emp = await anEmployee(`Hist ${run}`);
      await transitionEmployee(A(), "owner", emp, { to: "suspended" });
      const [ev] = await owner`
      select id from public.employee_event
      where org_id = ${orgA} and employee_id = ${emp} limit 1`;
      let updateRefused = false;
      let deleteRefused = false;
      try {
        await owner`update public.employee_event set event = 'note' where id = ${ev!.id}`;
      } catch {
        updateRefused = true;
      }
      try {
        await owner`delete from public.employee_event where id = ${ev!.id}`;
      } catch {
        deleteRefused = true;
      }
      expect(updateRefused && deleteRefused, "append-only is a trigger, not a grant").toBe(true);
    },
  );
});

describe("compensation (cost wall)", () => {
  it(
    "writes history AND the projection costing reads, in one transaction",
    { timeout: 240_000 },
    async () => {
      const emp = await anEmployee(`Comp ${run}`);
      await recordCompensationChange(A(), "owner", emp, {
        effectiveDate: "2026-01-01",
        salaryMinor: 800_000,
        reason: "hire",
      });
      await recordCompensationChange(A(), "owner", emp, {
        effectiveDate: "2026-08-01",
        salaryMinor: 900_000,
        reason: "annual_review",
      });

      const history = await listCompensationHistory(A(), "owner", emp);
      expect(history.filter((h) => !h.supersededAt)).toHaveLength(2);

      // The projection = the latest effective row, exactly what costing reads.
      const [terms] = await owner`
      select salary_minor::text as s, hourly_cost_minor::text as h
      from public.employee_terms where employee_id = ${emp}`;
      expect(Number(terms!.s)).toBe(900_000);
      expect(Number(terms!.h), "hourly defaulted as salary/208").toBe(Math.round(900_000 / 208));
    },
  );

  it(
    "a FUTURE-dated change does not touch the current projection",
    { timeout: 240_000 },
    async () => {
      const emp = await anEmployee(`Future ${run}`);
      await recordCompensationChange(A(), "owner", emp, {
        effectiveDate: "2026-01-01",
        salaryMinor: 500_000,
        reason: "hire",
      });
      await recordCompensationChange(A(), "owner", emp, {
        effectiveDate: "2030-01-01",
        salaryMinor: 999_999,
        reason: "promotion",
      });
      const [terms] = await owner`
      select salary_minor::text as s from public.employee_terms where employee_id = ${emp}`;
      expect(Number(terms!.s), "the raise is recorded but not yet paid").toBe(500_000);
    },
  );

  it("a correction supersedes rather than edits", { timeout: 240_000 }, async () => {
    const emp = await anEmployee(`Corr ${run}`);
    await recordCompensationChange(A(), "owner", emp, {
      effectiveDate: "2026-05-01",
      salaryMinor: 700_000,
      reason: "hire",
    });
    await recordCompensationChange(A(), "owner", emp, {
      effectiveDate: "2026-05-01",
      salaryMinor: 750_000,
      reason: "correction",
    });
    const history = await listCompensationHistory(A(), "owner", emp);
    const may = history.filter((h) => h.effectiveDate === "2026-05-01");
    expect(may).toHaveLength(2);
    expect(may.filter((h) => !h.supersededAt)).toHaveLength(1);
    expect(may.find((h) => !h.supersededAt)!.salaryMinor).toBe(750_000);
  });

  it(
    "the cost wall holds at the database: an unprivileged ctx reads nothing",
    { timeout: 240_000 },
    async () => {
      const emp = await anEmployee(`Wall ${run}`);
      await recordCompensationChange(A(), "owner", emp, {
        effectiveDate: "2026-01-01",
        salaryMinor: 650_000,
        reason: "hire",
      });
      const hidden = await listCompensationHistory(walled(), "owner", emp);
      expect(hidden, "RLS returns zero rows, not an error").toHaveLength(0);
      // And an unprivileged WRITE is refused by the same wall.
      await expect(
        recordCompensationChange(walled(), "owner", emp, {
          effectiveDate: "2026-02-01",
          salaryMinor: 1,
          reason: "adjustment",
        }),
      ).rejects.toThrow();
    },
  );
});

describe("contracts", () => {
  it("issues, freezes terms, and records acceptance", { timeout: 240_000 }, async () => {
    const emp = await anEmployee(`Ctr ${run}`);
    const c = await createContract(A(), "owner", emp, {
      startDate: "2026-01-15",
      endDate: "2028-01-14",
      probationMonths: 6,
    });
    expect(c.contractNo).toMatch(/^CTR-\d{3}$/);
    await issueContract(A(), "owner", c.id);

    // Issued terms are frozen by the trigger — even raw SQL cannot move the start date.
    let refused = false;
    try {
      await owner`update public.employee_contract set start_date = '2026-02-01' where id = ${c.id}`;
    } catch {
      refused = true;
    }
    expect(refused).toBe(true);

    await recordContractAcceptance(A(), "owner", c.id, "in_app");
    const p = await getEmployeeProfile(A(), "owner", emp);
    expect(p!.contracts[0]!.status).toBe("accepted");
    expect(p!.events.map((e) => e.event)).toEqual(
      expect.arrayContaining(["contract_issued", "contract_accepted"]),
    );
  });

  it("refuses acceptance of a draft (never issued) contract", { timeout: 240_000 }, async () => {
    const emp = await anEmployee(`Draft ${run}`);
    const c = await createContract(A(), "owner", emp, { startDate: "2026-03-01" });
    await expect(recordContractAcceptance(A(), "owner", c.id, "in_app")).rejects.toThrow(HrError);
  });
});

describe("self-service scoping", () => {
  it(
    "a linked member reads their own profile; an unlinked one reads nothing org-wide",
    { timeout: 240_000 },
    async () => {
      const emp = await anEmployee(`Self ${run}`);
      const memberUser = randomUUID();
      await seedUser(memberUser, "self");
      await owner`
      insert into public.membership (user_id, org_id, role_key)
      values (${memberUser}, ${orgA}, 'foreman')`;
      await linkEmployeeToMember(A(), "owner", emp, memberUser);

      // A foreman (no employees.view breadth) still reads their OWN profile...
      const own = await getEmployeeProfile(ctxOf(orgA, memberUser, false), "foreman", emp);
      expect(own).not.toBeNull();
      expect(own!.name).toContain("Self");

      // ...and nobody else's.
      const other = await anEmployee(`Other ${run}`);
      expect(await getEmployeeProfile(ctxOf(orgA, memberUser, false), "foreman", other)).toBeNull();

      await owner`delete from public.sign_in_log where user_id = ${memberUser}`;
      await owner`delete from public.membership where user_id = ${memberUser}`;
      await owner`update public.employee set user_id = null where id = ${emp}`;
      await owner`delete from public.user_profile where id = ${memberUser}`;
      await owner`delete from auth.users where id = ${memberUser}`;
    },
  );

  it("linking refuses a stranger to the organization", { timeout: 240_000 }, async () => {
    const emp = await anEmployee(`Link ${run}`);
    await expect(linkEmployeeToMember(A(), "owner", emp, outsider)).rejects.toThrow(HrError);
  });
});
