/**
 * Demo company importer — the orchestrator for ONE fictional showcase company.
 *
 *   npx tsx tooling/demo-company/run.ts status   --env=test|production
 *   npx tsx tooling/demo-company/run.ts dry-run  --env=test|production
 *   npx tsx tooling/demo-company/run.ts seed --confirm --env=... --owner-email=<address> [--family=<key>]
 *   npx tsx tooling/demo-company/run.ts verify   --env=test|production
 *
 * Production additionally needs `--production-phrase=seed-demo-showcase-into-<ref>`
 * (guard.ts). The test project goes through the Pilot Lab's own guard, which
 * refuses production by construction, so a `--env=test` run can never reach
 * the live database whatever `.env.local` says.
 *
 * What it reuses, unchanged: the fifteen generator families, the schema
 * linter, the batched writer and the row counters from tooling/pilot-lab.
 * What is its own: the brand it writes under (set ONCE, first thing), the
 * company, provisioning, checkpoints, manifest, ceiling and cleanup. The
 * Pilot Lab's orchestrator, cleanup, launcher and guard are not imported
 * and not touched.
 *
 * Families run in dependency order; each is one bounded, checkpointed batch.
 * A checkpoint means "this family completed for this organisation at this seed
 * version" — a crash resumes from the next family, and a second complete run
 * writes nothing. Every id is deterministic, so a retried family collides
 * with its own rows and inserts nothing new.
 */
import { setActiveBrand, personaEmailFor } from "../pilot-lab/brand";
import { DEMO_BRAND, DB_CEILING_BYTES } from "./brand";
import { RIMAL } from "./company";
import { loadLabEnv, type LabEnv } from "../pilot-lab/guard";
import { loadProductionEnv } from "./guard";
import {
  openOwner,
  dbSizeBytes,
  liveRowCounts,
  insertBatch,
  insertGroup,
  type Sql,
} from "../pilot-lab/db";
import { provisionCompany, adminClient, findDemoOrg } from "./provision";
import { getCheckpoint, setCheckpoint, listCheckpoints } from "./checkpoint";
import {
  readManifest,
  writeManifest,
  recordPlan,
  recordReport,
  finalize,
  cleanupPhrase,
  emailPatternOf,
  type DemoManifest,
} from "./manifest";
import { ensureLogo } from "./logo";
import { FAMILIES } from "../pilot-lab/families";
import { loadSchema, violationsIn, type Schema, type Violation } from "../pilot-lab/constraints";
import { Rng, uuidv5 } from "../simulation/rng";
import { SimClock } from "../simulation/dates";
import type {
  Company,
  Family,
  FamilyPlan,
  FamilyReport,
  LabContext,
  PersonaKey,
} from "../pilot-lab/types";
import type { Ctx } from "@/platform/tenancy";
import { closeAppDb } from "@/platform/tenancy";

// The brand, before anything else: every family reads it at the sites that
// used to hold an H33 literal.
setActiveBrand(DEMO_BRAND);
const BRAND = DEMO_BRAND;
const COMPANY: Company = RIMAL;

const argv = process.argv.slice(2);
const MODE = argv[0] ?? "status";
const arg = (k: string) => argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const ENV = (arg("env") ?? "test") as "test" | "production";
const CONFIRM = argv.includes("--confirm");
const OWNER_EMAIL = arg("owner-email");
const ONLY_FAMILY = arg("family");

if (ENV !== "test" && ENV !== "production") throw new Error(`--env must be test or production`);

function loadEnv(): LabEnv {
  return ENV === "production" ? loadProductionEnv(arg("production-phrase")) : loadLabEnv();
}

/** Topological order over the registered families; a missing dep is a build error. */
function orderedFamilies(all: Family[]): Family[] {
  const byKey = new Map(all.map((f) => [f.key, f]));
  for (const f of all)
    for (const d of f.deps)
      if (!byKey.has(d)) throw new Error(`family ${f.key} depends on unknown family ${d}`);
  const out: Family[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (f: Family) => {
    const s = state.get(f.key);
    if (s === "done") return;
    if (s === "visiting") throw new Error(`family dependency cycle at ${f.key}`);
    state.set(f.key, "visiting");
    for (const d of f.deps) visit(byKey.get(d)!);
    state.set(f.key, "done");
    out.push(f);
  };
  for (const f of all) visit(f);
  return out;
}

function makeCtx(input: {
  sql: Sql;
  admin: ReturnType<typeof adminClient>;
  orgId: string;
  users: Record<PersonaKey, string>;
  handoffs: Record<string, Record<string, unknown>>;
  dryRun: boolean;
  log: (m: string) => void;
  enums?: Schema;
  onViolations?: (v: Violation[]) => void;
}): LabContext {
  const company = COMPANY;
  const employees: LabContext["employees"] = {};
  return {
    brand: BRAND,
    sql: input.sql,
    admin: input.admin,
    company,
    orgId: input.orgId,
    users: input.users,
    employees,
    ctxFor: (persona): Ctx => {
      const p = company.personas.find((x) => x.key === persona)!;
      const privileged = p.roleKey === "owner" || p.roleKey === "admin" || p.roleKey === "accounts";
      return {
        orgId: input.orgId,
        userId: input.users[persona],
        costPrivileged: privileged,
        pricePrivileged: privileged,
        requestId: `${BRAND.idPrefix}-${company.key}-${persona}`,
      };
    },
    archetypeOf: (persona) => company.personas.find((x) => x.key === persona)!.archetype,
    rng: new Rng(`${BRAND.idPrefix}:${BRAND.seedVersion}:${company.key}`),
    clock: new SimClock(company.history.asOf),
    id: (family, ...ordinal) =>
      uuidv5(
        `${BRAND.idPrefix}:${BRAND.seedVersion}:${company.key}:${family}:${ordinal.join(":")}`,
        BRAND.idNamespace,
      ),
    insert: (table, rows, conflict) => {
      if (!input.dryRun) return insertBatch(input.sql, table, rows, { conflict });
      if (input.enums && input.onViolations) {
        const bad = violationsIn(table, rows, input.enums);
        if (bad.length) input.onViolations(bad);
      }
      return Promise.resolve({ attempted: rows.length, inserted: 0 });
    },
    insertGroup: async (entries) => {
      if (!input.dryRun) return insertGroup(input.sql, entries);
      const out: Record<string, { attempted: number; inserted: number }> = {};
      for (const e of entries) {
        if (input.enums && input.onViolations) {
          const bad = violationsIn(e.table, e.rows, input.enums);
          if (bad.length) input.onViolations(bad);
        }
        out[e.table] = { attempted: e.rows.length, inserted: 0 };
      }
      return out;
    },
    handoff: <T>(family: string) => {
      const h = input.handoffs[family];
      if (!h && !input.dryRun)
        throw new Error(`no handoff from family ${family} (is it a declared dependency?)`);
      return (h ?? {}) as T;
    },
    log: input.log,
    dryRun: input.dryRun,
  };
}

/** The capacity law: refuse to continue past this env's ceiling. */
async function assertUnderCeiling(sql: Sql, label: string): Promise<number> {
  const bytes = await dbSizeBytes(sql);
  const ceiling = DB_CEILING_BYTES[ENV];
  if (bytes > ceiling) {
    throw new Error(
      `capacity stop after ${label}: database is ${(bytes / 1048576).toFixed(0)} MB, ceiling ${ceiling / 1048576} MB`,
    );
  }
  return bytes;
}

async function main() {
  const env = loadEnv();
  console.log(`${BRAND.title} — ${MODE} — ${ENV} project ${env.ref} — ${COMPANY.nameEn}`);
  if (ENV === "production" && MODE === "seed" && !OWNER_EMAIL)
    throw new Error("a production seed needs --owner-email=<address the site owner controls>");
  const sql = openOwner(env);
  const admin = adminClient(env);
  const now = new Date().toISOString();
  const families = orderedFamilies(FAMILIES);
  const log = (m: string) => console.log(`  [${COMPANY.key}] ${m}`);

  try {
    const before = await dbSizeBytes(sql);
    console.log(
      `database: ${(before / 1048576).toFixed(1)} MB before; ceiling ${DB_CEILING_BYTES[ENV] / 1048576} MB; ${families.length} families registered`,
    );

    if (MODE === "status") {
      const orgId = await findDemoOrg(sql, BRAND, COMPANY.key);
      if (!orgId) {
        console.log(`  ${COMPANY.key}: not provisioned`);
        return;
      }
      const cps = await listCheckpoints(sql, BRAND, orgId);
      const applicable = families.filter((f) => f.appliesTo(COMPANY));
      const done = applicable.filter((f) => cps[f.key]).length;
      console.log(`  ${COMPANY.key}  ${orgId}  families ${done}/${applicable.length} done`);
      for (const f of applicable)
        console.log(`    ${f.key.padEnd(12)} ${cps[f.key] ? "done " + cps[f.key]!.at : "—"}`);
      return;
    }

    if (MODE === "seed" && !CONFIRM)
      throw new Error(`seed writes to the ${ENV} project; pass --confirm (or use dry-run)`);
    const dryRun = MODE === "dry-run";
    const verifyOnly = MODE === "verify";
    if (!["dry-run", "seed", "verify"].includes(MODE)) throw new Error(`unknown mode ${MODE}`);

    const enums = dryRun ? await loadSchema(sql) : undefined;
    const violations: Violation[] = [];

    // ── the organisation and its logins ────────────────────────────────────
    let orgId: string;
    let users: Record<PersonaKey, string>;
    const ZERO = "00000000-0000-0000-0000-000000000000";
    if (dryRun) {
      orgId = (await findDemoOrg(sql, BRAND, COMPANY.key)) ?? ZERO;
      users = Object.fromEntries(COMPANY.personas.map((p) => [p.key, ZERO])) as Record<
        PersonaKey,
        string
      >;
    } else if (verifyOnly) {
      const found = await findDemoOrg(sql, BRAND, COMPANY.key);
      if (!found)
        throw new Error(`${COMPANY.key} is not provisioned in ${ENV} — nothing to verify`);
      orgId = found;
      const emailOf = (p: PersonaKey) =>
        p === "owner" && OWNER_EMAIL ? OWNER_EMAIL : personaEmailFor(BRAND, COMPANY.key, p);
      const wanted = COMPANY.personas.map((p) => emailOf(p.key).toLowerCase());
      const rows = (await sql`
        select lower(u.email) as email, u.id::text as id from auth.users u
        where lower(u.email) = any(${wanted}::text[])
      `) as unknown as Array<{ email: string; id: string }>;
      users = Object.fromEntries(
        COMPANY.personas.map((p) => [
          p.key,
          rows.find((r) => r.email === emailOf(p.key).toLowerCase())?.id ?? "",
        ]),
      ) as Record<PersonaKey, string>;
      const missing = COMPANY.personas.filter((p) => !users[p.key]).map((p) => p.key);
      if (missing.length) throw new Error(`logins not found for personas: ${missing.join(", ")}`);
    } else {
      const p = await provisionCompany(env, sql, BRAND, COMPANY, now, log, {
        ownerEmail: OWNER_EMAIL,
      });
      orgId = p.orgId;
      users = p.users;
      if (p.createdUsers.length) log(`logins created: ${p.createdUsers.join(", ")}`);
      // The visual identity, through the product's own upload path.
      await ensureLogo(sql, makeCtx({ sql, admin, orgId, users, handoffs: {}, dryRun, log }), log);
    }

    // ── the manifest ────────────────────────────────────────────────────────
    const manifest: DemoManifest = readManifest() ?? {
      brand_key: BRAND.key,
      marker_key: BRAND.markerKey,
      seed_version: BRAND.seedVersion,
      generated_at: now,
      env: ENV,
      project_ref: env.ref,
      company_key: COMPANY.key,
      name_en: COMPANY.nameEn,
      name_ar: COMPANY.nameAr,
      org_id: orgId,
      data_range: { from: COMPANY.history.from, as_of: COMPANY.history.asOf },
      personas: COMPANY.personas.map((p) => ({
        key: p.key,
        role: p.roleKey,
        email: personaEmailFor(BRAND, COMPANY.key, p.key),
      })),
      expected: {},
      actual: {},
      families_done: [],
      live_rows_by_table: {},
      totals: { rows: 0, db_bytes_before: before, db_bytes_after: before },
      completeness_checksum: "",
      cleanup: {
        phrase: cleanupPhrase(env.ref),
        email_pattern: emailPatternOf(BRAND, COMPANY.key),
      },
    };
    if (manifest.seed_version !== BRAND.seedVersion)
      throw new Error(
        `manifest is for seed ${manifest.seed_version}; this build is ${BRAND.seedVersion}`,
      );
    if (manifest.env !== ENV || manifest.project_ref !== env.ref)
      throw new Error(
        `the local manifest belongs to ${manifest.env}/${manifest.project_ref}; move or remove ${"./" + manifest.env} state before targeting ${ENV}/${env.ref}`,
      );
    manifest.org_id = orgId;

    // ── the families, one bounded batch each ────────────────────────────────
    const handoffs: Record<string, Record<string, unknown>> = {};
    const cps = dryRun ? {} : await listCheckpoints(sql, BRAND, orgId);
    for (const [fam, cp] of Object.entries(cps))
      if (cp.report.handoff) handoffs[fam] = cp.report.handoff;

    let projectedRows = 0;
    const checks: Array<{ family: string; name: string; ok: boolean; detail?: string }> = [];

    for (const family of families) {
      if (!family.appliesTo(COMPANY)) continue;
      if (ONLY_FAMILY && family.key !== ONLY_FAMILY) continue;
      const ctx = makeCtx({
        sql,
        admin,
        orgId,
        users,
        handoffs,
        dryRun,
        log,
        enums,
        onViolations: (v) => violations.push(...v),
      });

      if (verifyOnly) {
        if (!family.verify) continue;
        if (!cps[family.key]) {
          checks.push({ family: family.key, name: "seeded", ok: false, detail: "no checkpoint" });
          continue;
        }
        const result = await family.verify(ctx);
        for (const c of result) checks.push({ family: family.key, ...c });
        const bad = result.filter((c) => !c.ok).length;
        log(
          `${family.key.padEnd(12)} ${result.length - bad}/${result.length} checks ok${
            bad
              ? "  ← " +
                result
                  .filter((c) => !c.ok)
                  .map((c) => c.name)
                  .join(", ")
              : ""
          }`,
        );
        continue;
      }

      let plan: FamilyPlan;
      try {
        plan = family.plan(ctx);
      } catch (e) {
        if (!dryRun) throw e;
        log(`${family.key.padEnd(12)} could not be estimated: ${(e as Error).message}`);
        continue;
      }
      recordPlan(manifest, plan);
      const planned = Object.values(plan.expected).reduce((a, b) => a + b, 0);
      projectedRows += planned;

      if (dryRun) {
        log(
          `${family.key.padEnd(12)} would write ~${planned.toLocaleString()} rows  ${Object.entries(
            plan.expected,
          )
            .map(([t, n]) => `${t}=${n}`)
            .join(" ")}`,
        );
        try {
          const report = await family.seed(ctx);
          if (report.handoff) handoffs[family.key] = report.handoff;
        } catch (e) {
          log(`${family.key.padEnd(12)} could not build for the estimate: ${(e as Error).message}`);
        }
        continue;
      }

      const existing = cps[family.key] ?? (await getCheckpoint(sql, BRAND, orgId, family.key));
      if (existing) {
        log(`${family.key.padEnd(12)} checkpointed — skipped`);
        if (existing.report.handoff) handoffs[family.key] = existing.report.handoff;
        recordReport(manifest, existing.report);
        continue;
      }

      const t0 = Date.now();
      const report: FamilyReport = await family.seed(ctx);
      const written = Object.values(report.counts).reduce((a, b) => a + b, 0);
      if (report.handoff) handoffs[family.key] = report.handoff;
      await setCheckpoint(sql, BRAND, orgId, family.key, report, new Date().toISOString());
      recordReport(manifest, report);
      const bytes = await assertUnderCeiling(sql, `${COMPANY.key}/${family.key}`);
      log(
        `${family.key.padEnd(12)} ${written.toLocaleString().padStart(8)} rows in ${((Date.now() - t0) / 1000).toFixed(1)}s   db ${(bytes / 1048576).toFixed(0)} MB${report.notes?.length ? "  " + report.notes.join("; ") : ""}`,
      );
      writeManifest(finalize(manifest, before, await dbSizeBytes(sql)));
    }

    if (dryRun) {
      const perRow = 1200;
      console.log(
        `\nDRY RUN: ~${projectedRows.toLocaleString()} rows projected ≈ ${((projectedRows * perRow) / 1048576).toFixed(0)} MB at ~${perRow} B/row incl. indexes; database now ${(before / 1048576).toFixed(0)} MB; ceiling ${DB_CEILING_BYTES[ENV] / 1048576} MB.`,
      );
      if (violations.length) {
        const seen = new Set<string>();
        console.log(`\n${violations.length} value(s) the database would refuse:`);
        for (const v of violations) {
          const key = `${v.table}.${v.column}=${v.value}`;
          if (seen.has(key)) continue;
          seen.add(key);
          console.log(
            `  ${v.table}.${v.column} = "${v.value}" (${v.rows} rows) — allowed: ${v.allowed.join(", ")}`,
          );
        }
        process.exitCode = 1;
      } else {
        console.log(
          "every generated row satisfies the schema: real columns, enumerations, NOT NULL and sign floors.",
        );
      }
      return;
    }

    if (verifyOnly) {
      const bad = checks.filter((c) => !c.ok);
      console.log(`\nVERIFY: ${checks.length - bad.length}/${checks.length} checks ok`);
      for (const b of bad)
        console.log(`  FAIL ${b.family}: ${b.name}${b.detail ? " — " + b.detail : ""}`);
      if (bad.length) process.exitCode = 1;
      return;
    }

    manifest.live_rows_by_table = await liveRowCounts(sql, [orgId]);
    const after = await dbSizeBytes(sql);
    const final = finalize(manifest, before, after);
    writeManifest(final);

    // The seed's own residue self-check: nothing H33-shaped may have landed.
    const [h33] = (await sql`
      select count(*)::int as n from public.app_settings
      where org_id = ${orgId} and key like 'h33.%'
    `) as unknown as Array<{ n: number }>;
    if (h33!.n) throw new Error(`${h33!.n} h33.* keys written under the demo organisation — stop`);

    console.log(
      `\nSEED complete: ${final.totals.rows.toLocaleString()} live rows; database ${(after / 1048576).toFixed(0)} MB; checksum ${final.completeness_checksum.slice(0, 12)}…; no H33 keys.`,
    );
  } finally {
    await sql.end();
    await closeAppDb().catch(() => {});
  }
}

void main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
