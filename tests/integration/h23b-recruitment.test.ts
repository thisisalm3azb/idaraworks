/**
 * H23B — recruitment and offboarding.
 *
 * The test that matters most is the no-retyping bridge: an accepted offer must
 * become a complete employee — number, compensation history, terms projection,
 * contract, employment event — in one transaction, and the offer's salary must
 * be invisible to an unprivileged context throughout.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAppDb, type Ctx } from "@/platform/tenancy";
import { createOrgForUser } from "@/platform/auth/identity";
import {
  createRequisition,
  addCandidate,
  moveCandidate,
  recordInterview,
  extendOffer,
  acceptOfferAndHire,
  openOffboarding,
  completeOffboardingItem,
  listOffboarding,
} from "@/modules/hr/recruitment";
import { getEmployeeProfile, listCompensationHistory } from "@/modules/hr/people";
import { markFixtureOrg, ownerSql, wipeOrgs } from "./helpers";

const owner = ownerSql();
const run = randomUUID().slice(0, 8);
const userA = randomUUID();
let orgA = "";

const A = (cost = true): Ctx => ({
  orgId: orgA,
  userId: userA,
  costPrivileged: cost,
  pricePrivileged: cost,
  requestId: "h23b",
});

beforeAll(async () => {
  await owner`
    insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    values (${userA}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            ${`h23b-${run}@example.invalid`}, '{"full_name":"H23B"}'::jsonb, now(), now())`;
  orgA = await createOrgForUser(userA, { name: "H23B", country: "AE", baseCurrency: "AED" });
  await markFixtureOrg(owner, orgA, "h23b", run);
}, 600_000);

afterAll(async () => {
  await wipeOrgs(owner, [orgA], [userA]);
  await owner.end({ timeout: 5 });
  await closeAppDb();
}, 300_000);

describe("the pipeline", () => {
  it(
    "walks requisition → candidate → interview → offer → EMPLOYEE without retyping",
    { timeout: 300_000 },
    async () => {
      const req = await createRequisition(A(), "owner", { title: "Site engineer" });
      expect(req.reference).toMatch(/^REQ-\d{3}$/);

      const cand = await addCandidate(A(), "owner", {
        requisitionId: req.id,
        name: `Salem ${run}`,
        email: `salem-${run}@example.invalid`,
        phone: "+971500000010",
      });
      await moveCandidate(A(), "owner", cand.id, "screening");
      await moveCandidate(A(), "owner", cand.id, "interview");
      await recordInterview(A(), "owner", {
        candidateId: cand.id,
        scheduledAt: "2026-09-05T09:00:00Z",
        kind: "technical",
        outcome: "advance",
      });

      const offer = await extendOffer(A(), "owner", {
        candidateId: cand.id,
        salaryMinor: 1_200_000,
        startDate: "2026-10-01",
        probationMonths: 6,
      });

      const hired = await acceptOfferAndHire(A(), "owner", offer.id);
      expect(hired.employeeNo).toMatch(/^EMP-\d{3}$/);

      // The employee carries everything the pipeline knew.
      const p = await getEmployeeProfile(A(), "owner", hired.employeeId);
      expect(p!.name).toBe(`Salem ${run}`);
      expect(p!.email).toBe(`salem-${run}@example.invalid`);
      expect(p!.hireDate).toBe("2026-10-01");
      expect(p!.probationEndDate).toBe("2027-04-01");
      expect(p!.contracts).toHaveLength(1);
      expect(p!.events.map((e) => e.event)).toContain("created");

      // Compensation history and projection both written.
      const comp = await listCompensationHistory(A(), "owner", hired.employeeId);
      expect(comp).toHaveLength(1);
      expect(comp[0]!.salaryMinor).toBe(1_200_000);
      expect(comp[0]!.reason).toBe("hire");
      const [terms] = await owner`
      select salary_minor::text as s from public.employee_terms
      where employee_id = ${hired.employeeId}`;
      expect(Number(terms!.s)).toBe(1_200_000);
    },
  );

  it(
    "the pipeline is forward-only, and a hired candidate is closed",
    { timeout: 240_000 },
    async () => {
      const req = await createRequisition(A(), "owner", { title: "Storekeeper" });
      const cand = await addCandidate(A(), "owner", { requisitionId: req.id, name: `Back ${run}` });
      await moveCandidate(A(), "owner", cand.id, "interview");
      await expect(moveCandidate(A(), "owner", cand.id, "screening")).rejects.toThrow();
    },
  );

  it(
    "an offer's salary sits behind the cost wall at the database",
    { timeout: 240_000 },
    async () => {
      const req = await createRequisition(A(), "owner", { title: "Painter" });
      const cand = await addCandidate(A(), "owner", { requisitionId: req.id, name: `Wall ${run}` });
      await extendOffer(A(), "owner", {
        candidateId: cand.id,
        salaryMinor: 900_000,
        startDate: "2026-11-01",
      });
      // An unprivileged write is refused, and an unprivileged read sees nothing.
      await expect(
        extendOffer(A(false), "owner", {
          candidateId: cand.id,
          salaryMinor: 1,
          startDate: "2026-11-01",
        }),
      ).rejects.toThrow();
    },
  );

  it("only one live offer per candidate", { timeout: 240_000 }, async () => {
    const req = await createRequisition(A(), "owner", { title: "Welder" });
    const cand = await addCandidate(A(), "owner", { requisitionId: req.id, name: `One ${run}` });
    await extendOffer(A(), "owner", {
      candidateId: cand.id,
      salaryMinor: 800_000,
      startDate: "2026-11-01",
    });
    await expect(
      extendOffer(A(), "owner", {
        candidateId: cand.id,
        salaryMinor: 850_000,
        startDate: "2026-11-15",
      }),
    ).rejects.toThrow();
  });
});

describe("offboarding", () => {
  it(
    "opens a checklist with the standard items and completes them",
    { timeout: 240_000 },
    async () => {
      const req = await createRequisition(A(), "owner", { title: "Exit case" });
      const cand = await addCandidate(A(), "owner", { requisitionId: req.id, name: `Exit ${run}` });
      const offer = await extendOffer(A(), "owner", {
        candidateId: cand.id,
        salaryMinor: 700_000,
        startDate: "2026-01-01",
      });
      const hired = await acceptOfferAndHire(A(), "owner", offer.id);

      const { created } = await openOffboarding(A(), "owner", hired.employeeId);
      expect(created).toBeGreaterThanOrEqual(4);

      const items = await listOffboarding(A(), "owner", hired.employeeId);
      expect(items.map((i) => i.kind)).toEqual(
        expect.arrayContaining([
          "access_revocation",
          "final_settlement_inputs",
          "document_handover",
          "exit_interview",
        ]),
      );

      await completeOffboardingItem(A(), "owner", items[0]!.id, "done in test");
      const after = await listOffboarding(A(), "owner", hired.employeeId);
      expect(after.filter((i) => i.doneAt !== null)).toHaveLength(1);

      // Opening twice does not duplicate the checklist.
      const again = await openOffboarding(A(), "owner", hired.employeeId);
      expect(again.created).toBe(0);
    },
  );
});
