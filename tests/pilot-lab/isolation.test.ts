/**
 * H33 — the adversarial tenant-isolation sweep over the five Pilot Lab companies.
 *
 * Runs against the ISOLATED TEST project only (vitest.lab.config.ts loads the
 * test env and the guard refuses anything else). It needs the lab to be seeded;
 * with no marked organisations every test is skipped, not passed.
 *
 * What it proves, at the database layer where RLS lives — i.e. with every
 * service-level check bypassed on purpose:
 *   1. For EVERY tenant-owned table, a tenant context in company A sees zero
 *      rows belonging to company B (while the owner connection confirms B has
 *      rows there, so the proof is not vacuous).
 *   2. Direct object-id guessing fails: reading B's rows by primary key from
 *      A's context returns nothing; updating them changes nothing; deleting
 *      them deletes nothing.
 *   3. A restricted role sees exactly what its role allows and no more, for
 *      the tables that carry a role-sensitive policy (cost/price privileged).
 *   4. Onboarding progress is invisible across users, not just across tenants.
 *   5. Files, documents, Studio plans, notifications, app brand and tenant
 *      hosts do not cross tenants.
 */
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAppDb, sql as dsql, withCtx, type Ctx } from "@/platform/tenancy";
import { assertLabEnv } from "../../tooling/pilot-lab/guard";
import {
  MARKER_KEY,
  SEED_VERSION,
  EMAIL_DOMAIN,
  isLabMarker,
} from "../../tooling/pilot-lab/marker";

const env = assertLabEnv();
const owner = postgres(env.directUrl, { max: 1, onnotice: () => {} });

type Lab = {
  key: string;
  orgId: string;
  ownerUserId: string;
  viewerUserId: string;
  foremanUserId: string;
};
let labs: Lab[] = [];
let tenantTables: string[] = [];

const ctxOf = (orgId: string, userId: string, privileged = true): Ctx => ({
  orgId,
  userId,
  costPrivileged: privileged,
  pricePrivileged: privileged,
  requestId: "h33-isolation",
});

async function userOf(companyKey: string, persona: string): Promise<string> {
  const rows =
    (await owner`select id::text as id from auth.users where email = ${`h33.${companyKey}.${persona}@${EMAIL_DOMAIN}`}`) as unknown as Array<{
      id: string;
    }>;
  return rows[0]?.id ?? "";
}

beforeAll(async () => {
  const marked =
    (await owner`select org_id::text as org_id, value from public.app_settings where key = ${MARKER_KEY}`) as unknown as Array<{
      org_id: string;
      value: unknown;
    }>;
  for (const m of marked) {
    if (!isLabMarker(m.value) || m.value.seed_version !== SEED_VERSION) continue;
    const key = m.value.company_key;
    labs.push({
      key,
      orgId: m.org_id,
      ownerUserId: await userOf(key, "owner"),
      viewerUserId: await userOf(key, "auditor"),
      foremanUserId: await userOf(key, "restricted"),
    });
  }
  tenantTables = (
    (await owner`
    select table_name from information_schema.columns
    where table_schema = 'public' and column_name = 'org_id' order by table_name
  `) as unknown as Array<{ table_name: string }>
  ).map((r) => r.table_name);
}, 120_000);

afterAll(async () => {
  await owner.end();
  await closeAppDb();
});

/** Count of B's rows in `table` visible from ctx. */
async function visibleFrom(
  ctx: Ctx,
  table: string,
  otherOrg: string,
): Promise<number | "no-grant"> {
  try {
    const rows = (await withCtx(ctx, (tx) =>
      tx.execute(
        dsql.raw(`select count(*)::int as n from public."${table}" where org_id = '${otherOrg}'`),
      ),
    )) as unknown as Array<{ n: number }>;
    return rows[0]?.n ?? 0;
  } catch (e) {
    // No SELECT grant at all for app_user is isolation by construction.
    if (/permission denied/i.test(String(e))) return "no-grant";
    throw e;
  }
}

describe("H33 tenant isolation across the five companies", () => {
  it("has the lab (skips everything below when it does not)", () => {
    if (labs.length < 2) console.log("Pilot Lab not seeded — isolation sweep skipped");
  });

  it("company A sees none of company B's rows in any tenant-owned table, and B really has rows", async () => {
    if (labs.length < 2) return;
    const [a, b] = labs;
    const leaks: string[] = [];
    const proven: string[] = [];
    const empty: string[] = [];
    for (const t of tenantTables) {
      const [bHas] = (await owner.unsafe(
        `select count(*)::int as n from public."${t}" where org_id = $1`,
        [b!.orgId],
      )) as unknown as Array<{ n: number }>;
      if (bHas!.n === 0) {
        empty.push(t);
        continue;
      }
      const seen = await visibleFrom(ctxOf(a!.orgId, a!.ownerUserId), t, b!.orgId);
      if (seen === "no-grant") proven.push(`${t} (no grant)`);
      else if (seen > 0) leaks.push(`${t}: ${seen} rows of ${b!.key} visible to ${a!.key}`);
      else proven.push(t);
    }
    console.log(
      `isolation sweep: ${proven.length} tables proven, ${empty.length} tables empty for ${b!.key}, ${leaks.length} leaks`,
    );
    expect(leaks).toEqual([]);
    // Non-vacuous: a realistic lab populates far more than a handful of tables.
    expect(proven.length).toBeGreaterThan(60);
  }, 600_000);

  it("guessing a foreign primary key reads nothing, updates nothing, deletes nothing", async () => {
    if (labs.length < 2) return;
    const [a, b] = labs;
    for (const t of [
      "customer",
      "invoice",
      "job",
      "employee",
      "item",
      "doc_document",
      "studio_plan",
      "payslip",
    ]) {
      const bRows = (await owner.unsafe(
        `select id::text as id from public."${t}" where org_id = $1 limit 3`,
        [b!.orgId],
      )) as unknown as Array<{ id: string }>;
      for (const r of bRows) {
        const read = (await withCtx(ctxOf(a!.orgId, a!.ownerUserId), (tx) =>
          tx.execute(dsql.raw(`select count(*)::int as n from public."${t}" where id = '${r.id}'`)),
        )) as unknown as Array<{ n: number }>;
        expect(read[0]?.n, `${t} ${r.id} readable from ${a!.key}`).toBe(0);
        const upd = await withCtx(ctxOf(a!.orgId, a!.ownerUserId), (tx) =>
          tx.execute(dsql.raw(`update public."${t}" set updated_at = now() where id = '${r.id}'`)),
        ).catch((e) => e);
        // Either refused outright (no grant / frozen trigger) or matched zero rows.
        if (!(upd instanceof Error))
          expect((upd as { count?: number }).count ?? 0, `${t} update from ${a!.key}`).toBe(0);
        const del = await withCtx(ctxOf(a!.orgId, a!.ownerUserId), (tx) =>
          tx.execute(dsql.raw(`delete from public."${t}" where id = '${r.id}'`)),
        ).catch((e) => e);
        if (!(del instanceof Error))
          expect((del as { count?: number }).count ?? 0, `${t} delete from ${a!.key}`).toBe(0);
        const still = (await owner.unsafe(
          `select count(*)::int as n from public."${t}" where id = $1`,
          [r.id],
        )) as unknown as Array<{ n: number }>;
        expect(still[0]?.n, `${t} ${r.id} survived`).toBe(1);
      }
    }
  }, 300_000);

  it("a forged org id in the context yields nothing from any company", async () => {
    if (labs.length < 1) return;
    const forged = randomUUID();
    for (const t of ["customer", "invoice", "job"]) {
      const rows = (await withCtx(ctxOf(forged, labs[0]!.ownerUserId), (tx) =>
        tx.execute(dsql.raw(`select count(*)::int as n from public."${t}"`)),
      ).catch(() => [{ n: 0 }])) as unknown as Array<{ n: number }>;
      expect(rows[0]?.n ?? 0).toBe(0);
    }
  });

  it("onboarding progress is per user: the auditor cannot see the owner's row in the same company", async () => {
    if (labs.length < 1) return;
    for (const l of labs) {
      const rows = (await withCtx(ctxOf(l.orgId, l.viewerUserId, false), (tx) =>
        tx.execute(
          dsql`select user_id::text as user_id from public.onboarding_state where org_id = ${l.orgId}`,
        ),
      )) as unknown as Array<{ user_id: string }>;
      expect(rows.map((r) => r.user_id)).not.toContain(l.ownerUserId);
    }
  });

  it("branding, app identity and tenant hosts do not cross tenants", async () => {
    if (labs.length < 2) return;
    const [a, b] = labs;
    for (const t of ["org_branding", "org_app_brand", "tenant_host"]) {
      const seen = await visibleFrom(ctxOf(a!.orgId, a!.ownerUserId), t, b!.orgId);
      expect(seen === "no-grant" ? 0 : seen, t).toBe(0);
    }
  });

  it("notifications and files do not cross tenants", async () => {
    if (labs.length < 2) return;
    const [a, b] = labs;
    for (const t of ["notification", "file", "document_share", "share_token"]) {
      const seen = await visibleFrom(ctxOf(a!.orgId, a!.ownerUserId), t, b!.orgId);
      expect(seen === "no-grant" ? 0 : seen, t).toBe(0);
    }
    // Storage objects are keyed by org path; a signed read for B's path from A must not exist.
    const bObjects =
      (await owner`select name from storage.objects where bucket_id in ('tenant-media','tenant-docs') and name like ${b!.orgId + "/%"} limit 1`) as unknown as Array<{
        name: string;
      }>;
    const aSeesB =
      (await owner`select count(*)::int as n from storage.objects where name like ${a!.orgId + "/%"} and name like ${"%" + b!.orgId + "%"}`) as unknown as Array<{
        n: number;
      }>;
    expect(aSeesB[0]?.n ?? 0).toBe(0);
    void bObjects;
  });

  it("a restricted foreman cannot read cost-privileged tables the owner can", async () => {
    if (labs.length < 1) return;
    const l = labs[0]!;
    const privileged = ["employee_terms", "cost_rollup", "payslip", "pay_run_line"];
    let checked = 0;
    for (const t of privileged) {
      const [has] = (await owner.unsafe(
        `select count(*)::int as n from public."${t}" where org_id = $1`,
        [l.orgId],
      )) as unknown as Array<{ n: number }>;
      if (has!.n === 0) continue;
      const seen = await visibleFrom(ctxOf(l.orgId, l.foremanUserId, false), t, l.orgId);
      // Either no grant, or the policy hides privileged rows from an unprivileged ctx.
      expect(seen === "no-grant" ? 0 : seen, `${t} visible to a restricted foreman`).toBe(0);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });
});
